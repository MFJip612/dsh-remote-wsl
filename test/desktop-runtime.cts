/** Keyless integration against the installed Desktop's real Cordis/Agent/tool services.
 * Run with ELECTRON_RUN_AS_NODE=1 and the installed DeepSeek Harness executable.
 * The scripted adapter replaces only the network model; bash executes in real WSL.
 */
const assert: typeof import('node:assert/strict') = require('node:assert/strict')
const fs: typeof import('node:fs') = require('node:fs')
const path: typeof import('node:path') = require('node:path')
const { pathToFileURL }: typeof import('node:url') = require('node:url')
import type { DesktopAgent, DesktopContext, DesktopSession } from './desktop-contracts.js'

async function main() {
  const { contextModule, llmModule, scopeModule, defaultPlugin } = await import('./desktop-contracts.ts')
  const { resolveConfig } = await import('../dist/config.js')
  const packages = path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai')
  assert.ok(fs.existsSync(packages), 'Run this test with the installed DSH Desktop executable')
  const load = async (name: string): Promise<unknown> => import(pathToFileURL(path.join(packages, name, 'lib', 'index.js')).href)
  const { Context } = contextModule(await load('cordis'))
  const llm = llmModule(await load('dsh-llm'))
  const SessionStore = defaultPlugin(await load('dsh-session'))
  const Projections = defaultPlugin(await load('dsh-session-projection'))
  const SystemPrompt = defaultPlugin(await load('dsh-system-prompt'))
  const Tools = defaultPlugin(await load('dsh-tools'))
  const NativeExecutor = fs.existsSync(path.join(packages, 'dsh-tool-executor-native'))
    ? await load('dsh-tool-executor-native') : undefined
  const Agents = defaultPlugin(await load('dsh-agent'))
  const AgentLoop = defaultPlugin(await load('dsh-agent-loop'))
  const Subprocess = defaultPlugin(await load('dsh-subprocess-local'))
  const { createScope, bindScopeParent } = scopeModule(await load('dsh-scope'))
  const WslPlugin = await import('../dist/index.js')
  const { createWslService } = await import('../dist/lib/wsl-service.js')
  const requests: { messages: unknown }[] = []
  class ScriptedAdapter extends llm.LlmAdapter {
    async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
    async *stream(options: { messages: unknown }) {
      requests.push(options)
      if (requests.length === 1) {
        const call = { type: 'tool-call', id: 'wsl-smoke-call', name: 'bash', arguments: JSON.stringify({ command: 'uname -s; pwd; printf DSH_WSL_RUNTIME_OK' }) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: call }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else if (requests.length === 2) {
        const call = { type: 'tool-call', id: 'wsl-smoke-read', name: 'read', arguments: JSON.stringify({ file_path: '/etc/hostname' }) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: call }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'WSL conversation completed' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'WSL conversation completed' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  const ctx = new Context()
  try {
    await ctx.plugin(llm.default)
    await ctx.plugin(SessionStore)
    await ctx.plugin(Projections)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are a test agent.' })
    await ctx.plugin(Tools, NativeExecutor === undefined ? { mode: 'native' } : {})
    if (NativeExecutor !== undefined) await ctx.plugin(NativeExecutor)
    await ctx.plugin(Agents)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Subprocess)
    ctx.llm.registerAdapter(['wsl-smoke'], new ScriptedAdapter())
    // The plugin only reads workingDirectory.get; real Agent Session supplies its cwd.
    ctx.provide('workingDirectory', { get: (session: DesktopSession) => session.header.cwd })
    const config = resolveConfig({ execTimeoutMs: 15000, maxReadBytes: 2000000 })
    const service = createWslService(ctx, config)
    const listed = await service.listDistros()
    assert.ok(listed.distros.length > 0, `Real WSL is required: ${listed.error ?? 'no distributions'}`)
    const distro = listed.defaultDistro ?? Array.from<{ name: string }>(listed.distros)[0].name
    const identity = await service.resolveIdentity(distro)
    const origin = await service.toHostPath(distro, identity.home)
    const presetKey = {}
    const preset = createScope(ctx, presetKey)
    let presetCtx: DesktopContext | undefined
    await preset.ctx.plugin({ name: 'test-preset-tools', inject: ['tools', 'agents'], apply(scope: DesktopContext) {
      presetCtx = scope
      for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'pwsh']) {
        scope.tools.register({
          name, description: 'Native preset tool that must be shadowed in WSL', parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] },
          execute: async () => { throw new Error('WSL did not shadow the preset tool') },
        })
      }
    } })
    assert.equal(ctx.tools.get('read'), undefined)
    // Load the public plugin through real Desktop Cordis, including Config and the
    // typed Host adapter. Routes are registered but no HTTP listener is opened.
    ctx.provide('webServer', { register: () => () => {} })
    ctx.provide('connection', { requestRejection: () => undefined })
    const pluginFiber = await ctx.plugin(WslPlugin, { ...config, terminal: false })
    assert.ok(presetCtx)
    const owned = await presetCtx.agents.create({ sessionId: 'wsl-runtime-smoke', agentOptions: { provider: 'wsl-smoke', model: 'scripted' }, meta: { cwd: origin.hostPath }, setup: (_scope, agent) => { bindScopeParent(agent, presetKey) } })
    const agent = owned.agent
    assert.equal(agent.inbox.nextStep[0].role, 'user')
    assert.equal(agent.inbox.nextStep[0].source.kind, 'plugin:dsh-remote-wsl')
    assert.ok(ctx.tools.get('bash', agent))
    for (const name of ['read', 'write', 'edit', 'glob', 'grep']) assert.match(ctx.tools.get(name, agent)?.description ?? '', /WSL/u)
    assert.equal(ctx.tools.get('pwsh', agent), undefined)
    agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Run the WSL smoke command.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const result = events.find(event => event.type === 'tool/result')
    assert.ok(result, 'The real agent loop must execute bash')
    const output = JSON.stringify(result.data)
    assert.match(output, /Linux/u)
    assert.match(output, /DSH_WSL_RUNTIME_OK/u)
    assert.match(output, new RegExp(identity.home))
    assert.equal(result.data.message.isError, false, JSON.stringify(result.data.message.content))
    const fileResult = events.filter(event => event.type === 'tool/result')[1]
    assert.equal(fileResult.data.message.isError, false, JSON.stringify(fileResult.data.message.content))
    assert.match(JSON.stringify(fileResult.data), /\/etc\/hostname/u)
    assert.equal(requests.length, 3)
    assert.ok(events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed'))
    assert.match(JSON.stringify(requests[0].messages), /plugin:dsh-remote-wsl/u)
    console.log(`PASS real DSH preset -> agent-scoped bash/read -> ${distro} Linux -> tool results -> completed conversation`)

    const legacy = `本会话的目录在 WSL 发行版 ${distro} 内：${identity.home}。shell 是 Linux bash，路径请使用 Linux 形式；Windows 盘在 /mnt/<盘符>。请用 bash 工具执行命令，不要使用 PowerShell。`
    const recovered = await presetCtx.agents.create({
      sessionId: 'wsl-runtime-recovery',
      agentOptions: { provider: 'wsl-smoke', model: 'scripted' },
      meta: { cwd: origin.hostPath },
      setup: (_scope, agent) => { bindScopeParent(agent, presetKey) },
      seed: [{ type: 'agent/inbox/spliced', seq: 0, time: Date.now(), data: { target: 'next-step', start: 0, inserted: [legacy] } }],
    })
    assert.equal(recovered.agent.inbox.nextStep.length, 1)
    assert.equal(recovered.agent.inbox.nextStep[0].role, 'user')
    assert.ok(recovered.agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced' && event.data.removedCount === 1))
    requests.length = 0
    recovered.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Run after legacy recovery.' }], source: { kind: 'user' } }))
    await recovered.agent.whenIdle()
    assert.equal(requests.length, 3)
    assert.ok(recovered.agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed'))
    await recovered.dispose()
    console.log('PASS legacy persisted string -> official inbox repair event -> completed conversation')

    const fsp: typeof import('node:fs/promises') = require('node:fs/promises')
    const os: typeof import('node:os') = require('node:os')
    const zlib: typeof import('node:zlib') = require('node:zlib')
    const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-wsl-disk-'))
    const diskCtx = new Context()
    try {
      const Persistence = await load('dsh-session-persistence-jsonl')
      await diskCtx.plugin(Persistence, { root: fixtureRoot, compression: 'zstd' })
      const header = { ...agent.session.header, id: 'wsl-disk-legacy', createdAt: Date.now() }
      const handle = await diskCtx.sessionPersistence.create(header)
      await handle.flush()
      const snapshot = await diskCtx.sessionPersistence.stat(header.id)
      await handle.close()
      const fixtureProjects = await fsp.readdir(fixtureRoot)
      const file = snapshot.location?.path ?? path.join(fixtureRoot, fixtureProjects[0], header.id, 'session.v4.jsonl.zstd')
      const rows = [
        { type: 'session', ...header, delegationDepth: 0 },
        { type: 'agent/inbox/spliced', seq: 0, time: Date.now(), data: { target: 'next-step', start: 0, inserted: [legacy] } },
      ]
      const invalid = Buffer.concat(rows.map(row => zlib.zstdCompressSync(Buffer.from(JSON.stringify(row) + '\n'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })))
      await fsp.writeFile(file, invalid)
      await assert.rejects(async () => {
        const reader = await diskCtx.sessionPersistence.open(header.id, 'read')
        try { await reader.read() } finally { await reader.close() }
      }, /requires message objects/u)
      const { repairLegacyInboxFile } = await import('../dist/lib/legacy-inbox.js')
      const preview = await repairLegacyInboxFile(file, diskCtx.sessionPersistence)
      assert.equal(preview.repaired, 1)
      assert.deepEqual(await fsp.readFile(file), invalid)
      const lease = await diskCtx.sessionPersistence.acquireWriteLease(header)
      try { await assert.rejects(repairLegacyInboxFile(file, diskCtx.sessionPersistence, { apply: true }), /owned|writer|ownership/iu) }
      finally { await lease.release() }
      const repaired = await repairLegacyInboxFile(file, diskCtx.sessionPersistence, { apply: true })
      assert.equal(repaired.applied, true)
      assert.deepEqual(await fsp.readFile(repaired.backupPath ?? assert.fail('Missing backup path')), invalid)
      const reader = await diskCtx.sessionPersistence.open(header.id, 'read')
      try {
        const read = await reader.read()
        assert.equal(read.events[0].type, 'agent/inbox/spliced')
        const first = read.events[0]
        assert.ok(first.type === 'agent/inbox/spliced')
        assert.equal(first.data.inserted[0].source.kind, 'plugin:dsh-remote-wsl')
      } finally { await reader.close() }
      console.log('PASS real multi-frame Zstd disk refusal -> writer exclusion -> byte backup -> repair -> official disk reader')
      const cli = (require('node:child_process') as typeof import('node:child_process')).spawnSync(process.execPath, [
        path.resolve(__dirname, '../dist/scripts/repair-legacy.cjs'), `--root=${fixtureRoot}`,
      ], { encoding: 'utf8', windowsHide: true, env: process.env, timeout: 15000 })
      assert.equal(cli.status, 0, cli.stderr || String(cli.error ?? 'recovery CLI failed'))
      assert.match(cli.stdout, /Affected sessions: 0; mode: dry-run/u)
      assert.deepEqual(await fsp.readFile(repaired.backupPath ?? assert.fail('Missing backup path')), invalid)
      console.log('PASS compiled recovery CLI -> installed Desktop modules -> explicit fixture root -> dry-run')
    } finally {
      await diskCtx.fiber.dispose()
      assert.equal(path.dirname(fixtureRoot), os.tmpdir())
      await fsp.rm(fixtureRoot, { recursive: true, force: true })
    }
    await pluginFiber.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
