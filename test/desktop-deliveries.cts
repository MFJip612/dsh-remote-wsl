/** Real installed DSH file tools, capture/diff, present events and real WSL; no API calls. */
const assert: typeof import('node:assert/strict') = require('node:assert/strict')
const path: typeof import('node:path') = require('node:path')
const fs: typeof import('node:fs/promises') = require('node:fs/promises')
const { pathToFileURL }: typeof import('node:url') = require('node:url')
import type { DesktopAgent, DesktopContext, DesktopSession } from './desktop-contracts.js'

async function main() {
  const { contextModule, llmModule, scopeModule, defaultPlugin } = await import('./desktop-contracts.ts')
  const { resolveConfig } = await import('../dist/config.js')
  const packages = path.join(path.dirname(process.execPath), 'resources/app.asar/dsh/node_modules/@deepseek-ai')
  const load = (name: string): Promise<unknown> => import(pathToFileURL(path.join(packages, name, 'lib/index.js')).href)
  const { Context } = contextModule(await load('cordis'))
  const llm = llmModule(await load('dsh-llm'))
  const { registerAgentTools } = await import('../dist/lib/agent-tools.js')
  const { createWslService } = await import('../dist/lib/wsl-service.js')
  const { createWorkspaceMappingStore } = await import('../dist/lib/wsl-workspaces.js')
  const ctx = new Context()
  let service, linuxRoot, distro
  try {
    for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-subprocess-local', 'dsh-fs-local']) {
      const module = await load(name)
      await ctx.plugin(defaultPlugin(module), name === 'dsh-agent-loop' ? { agents: [] } : name === 'dsh-tools' ? { mode: 'native' } : {})
    }
    ctx.provide('workingDirectory', { get: (session: DesktopSession) => session.header.cwd, ensure: async (agent: DesktopAgent) => agent.session.header.cwd })
    await ctx.plugin(await load('dsh-tool-fs'), { readImage: false })
    await ctx.plugin(await load('dsh-tool-present'))
    await ctx.plugin(await load('dsh-fs-observation-policy'))
    await ctx.plugin(await load('dsh-workspace-changes'))
    service = createWslService(ctx, resolveConfig({ execTimeoutMs: 20000 }))
    const listed = await service.listDistros()
    assert.ok(listed.available && listed.distros.length, listed.error ?? 'WSL required')
    distro = listed.defaultDistro ?? Array.from<{ name: string }>(listed.distros)[0].name
    const identity = await service.resolveIdentity(distro)
    linuxRoot = `${identity.home}/.dsh-wsl-deliveries-${process.pid}`
    assert.ok(linuxRoot.startsWith(identity.home + '/.dsh-wsl-deliveries-'))
    await service.runText(['-d', distro, '--exec', 'bash', '-c', 'mkdir -p -- "$1"; printf "old\\n" > "$1/original.txt"', 'bash', linuxRoot])
    const mapped = await service.toHostPath(distro, linuxRoot)
    const script: [string, Record<string, unknown>][] = [
      ['read', { file_path: 'original.txt' }],
      ['edit', { file_path: 'original.txt', old_string: 'old', new_string: 'updated' }],
      ['write', { file_path: 'report.md', content: '# Report\ncreated in WSL\n' }],
      ['present', { files: [{ path: `${linuxRoot}/report.md`, description: 'WSL report' }, { path: 'original.txt', description: 'Edited source' }] }],
    ]
    class Adapter extends llm.LlmAdapter {
      async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
      async *stream() {
        const call = script.shift()
        const block = call === undefined ? { type: 'text', text: 'Deliveries complete' }
          : { type: 'tool-call', id: `call-${script.length}`, name: call[0], arguments: JSON.stringify(call[1]) }
        yield { type: 'block-start', index: 0, blockType: block.type }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: call === undefined ? 'stop' : 'tool-calls' } }
      }
    }
    ctx.llm.registerAdapter(['deliveries-test'], new Adapter())
    registerAgentTools(ctx, { service, mappings: createWorkspaceMappingStore({ mountRoot: '' }), config: resolveConfig({ maxReadBytes: 2_000_000 }) })
    const agent = await ctx.agentLoop.create('wsl-deliveries-test', { provider: 'deliveries-test', model: 'scripted' }, { cwd: mapped.hostPath })
    agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Verify WSL deliveries.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 4)
    for (const result of results) assert.equal(result.data.message.isError, false, JSON.stringify(result.data.message.content))
    const editMeta = results[1].data.meta
    assert.ok(editMeta.path.startsWith('\\\\wsl'))
    assert.ok(editMeta.diffs.length > 0, 'Native edit diff metadata must survive')
    const change = events.find(event => event.type === 'workspace/changes')
    assert.ok(change, 'Official recorder must announce the changed files')
    const summary = ctx.workspaceChanges.summary(agent.id, change.seq)
    assert.equal(summary.total, 2)
    assert.deepEqual(summary.files.map(file => file.path).sort(), ['original.txt', 'report.md'])
    const index = summary.files.findIndex(file => file.path === 'original.txt')
    const comparison = await ctx.workspaceChanges.diff(agent.id, change.seq, index, new AbortController().signal)
    assert.equal(comparison.kind, 'text')
    assert.match(JSON.stringify(comparison.hunks), /-old/u)
    assert.match(JSON.stringify(comparison.hunks), /\+updated/u)
    const delivered = events.find(event => event.type === 'deliverables/presented')
    assert.ok(delivered, 'Official present must publish its durable event')
    assert.equal(delivered.data.files.length, 2)
    assert.ok(delivered.data.files.every(file => file.path.startsWith('\\\\wsl')))
    assert.equal(delivered.data.files[0].description, 'WSL report')
    assert.ok(events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed'))
    await fs.mkdir(path.join(__dirname, 'results'), { recursive: true })
    await fs.writeFile(path.join(__dirname, 'results/desktop-deliveries.json'), JSON.stringify({ summary, comparison, delivered: delivered.data, editMeta }, null, 2) + '\n')
    console.log('PASS real WSL write/edit -> official change summary (2 files) and old/updated diff')
    console.log('PASS native mutation metadata/presenters -> mapped present -> durable file cards -> completed turn')
  } finally {
    await ctx.fiber.dispose()
    if (service !== undefined && linuxRoot !== undefined && distro !== undefined) {
      assert.match(linuxRoot, /^\/home\/[^/]+\/\.dsh-wsl-deliveries-\d+$/u)
      // The stopped fixture owns only these two known files; no recursive shell deletion.
      const subprocess: typeof import('node:child_process') = require('node:child_process')
      const removed = subprocess.spawnSync('wsl.exe', ['-d', distro, '--exec', 'bash', '-c', 'rm -f -- "$1/original.txt" "$1/report.md"; rmdir -- "$1"', 'bash', linuxRoot], { windowsHide: true })
      if (removed.status !== 0) console.error('Fixture cleanup failed:', removed.stderr.toString())
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
