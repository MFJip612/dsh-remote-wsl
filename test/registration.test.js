#!/usr/bin/env node
/**
 * Registration-level tests for the two DSH integrations that cannot be exercised without a
 * running Host: the per-agent WSL tool set (`agent-tools.js`) and the terminal allocation
 * wrapper (`terminal.js`). Both use small fakes that mirror the inspected cordis contracts.
 *
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'C:\Users\Mingf\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' test\registration.test.js
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href)

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`FAIL ${name}\n     ${error?.stack ?? error}`)
  }
}

const WSL_CWD = '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj'

function createToolsFake() {
  const registered = []
  const restrictions = []
  const available = { pwsh: {}, read: {}, write: {}, edit: {}, glob: {}, grep: {} }
  const tools = {
    get: (name) => available[name],
    register: (definition) => {
      registered.push(definition)
      return () => {}
    },
    restrict: (filter) => {
      restrictions.push(filter)
      return () => {}
    },
  }
  const scope = {
    tools,
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  return { scope, registered, restrictions }
}

function createAgentToolsCtx(cwd, session = { id: 's1' }) {
  const listeners = []
  const ctx = {
    on: (event, listener) => {
      listeners.push({ event, listener })
      return () => {}
    },
    sessions: { get: () => session },
    workingDirectory: { get: () => cwd },
    get: (name) => (name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'danger-full-access' }) } : undefined),
  }
  return { ctx, listeners }
}

const service = {
  resolveIdentity: async (distro) => ({ distro, user: 'me', home: '/home/me' }),
}
const wslMappings = {
  resolveCwd: async (cwd) =>
    cwd === WSL_CWD
      ? { distro: 'Ubuntu', linuxPath: '/home/me/proj', rootHostPath: cwd, mapped: 'unc' }
      : undefined,
}

async function main() {
  const { registerAgentTools } = await load('lib/agent-tools.js')
  const { registerTerminalRouting } = await load('lib/terminal.js')

  await test('disk recovery converts only the plugin legacy inbox strings and preserves every event', async () => {
    const { repairLegacyInboxLog } = await load('lib/legacy-inbox.js')
    const legacy = '本会话的目录在 WSL 发行版 Ubuntu 内：/home/me/proj。shell 是 Linux bash，路径请使用 Linux 形式；Windows 盘在 /mnt/<盘符>。请用 bash 工具执行命令，不要使用 PowerShell。'
    const header = { type: 'session', version: 4, id: 's1', cwd: WSL_CWD }
    const user = { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'keep me' }], source: { kind: 'user' } }
    const rows = [header, { type: 'agent/inbox/spliced', seq: 0, time: 123, data: { target: 'next-step', start: 0, inserted: [legacy, user] } }]
    const result = repairLegacyInboxLog(rows.map(JSON.stringify).join('\n') + '\n')
    assert.equal(result.repaired, 1)
    const fixed = result.lines.map(JSON.parse)
    assert.deepEqual(fixed[0], header)
    assert.equal(fixed[1].seq, 0)
    assert.equal(fixed[1].time, 123)
    assert.deepEqual(fixed[1].data.inserted[1], user)
    assert.equal(fixed[1].data.inserted[0].content[0].text, legacy)
    assert.equal(fixed[1].data.inserted[0].source.kind, 'plugin:dsh-remote-wsl')
    assert.equal(repairLegacyInboxLog(result.lines.join('\n') + '\n').repaired, 0)
    assert.throws(() => repairLegacyInboxLog('{broken'), SyntaxError)
    const unrelated = rows.map(JSON.stringify).join('\n').replace(legacy, 'unrelated invalid input') + '\n'
    assert.equal(repairLegacyInboxLog(unrelated).repaired, 0)
  })

  await test('WSL session receives the scoped Linux tool set and hides the Windows shell', async () => {
    const { ctx, listeners } = createAgentToolsCtx(WSL_CWD)
    const { scope, registered, restrictions } = createToolsFake()
    const dispose = registerAgentTools(ctx, { service, mappings: wslMappings, config: {} })
    assert.equal(listeners.length, 1)
    assert.equal(listeners[0].event, 'agent/created')
    await listeners[0].listener.call(scope, { agent: { id: 's1' } })
    const names = registered.map((definition) => definition.name).sort()
    assert.deepEqual(names, ['bash', 'edit', 'glob', 'grep', 'read', 'write'])
    assert.deepEqual(restrictions, [{ deny: ['pwsh'] }])
    for (const definition of registered) {
      assert.equal(typeof definition.execute, 'function')
      assert.equal(typeof definition.output.render, 'function')
      assert.equal(definition.parameters.type, 'object')
    }
    dispose()
  })

  await test('Windows session receives no WSL tool registration', async () => {
    const { ctx, listeners } = createAgentToolsCtx('E:\\source\\project')
    const { scope, registered, restrictions } = createToolsFake()
    registerAgentTools(ctx, { service, mappings: wslMappings, config: {} })
    await listeners[0].listener.call(scope, { agent: { id: 's1' } })
    assert.deepEqual(registered, [])
    assert.deepEqual(restrictions, [])
  })

  await test('WSL context is a serializable identified message accepted by the agent inbox', async () => {
    const { ctx, listeners } = createAgentToolsCtx(WSL_CWD)
    const { scope } = createToolsFake()
    const pending = []
    const agent = { id: 's1', ctx: scope, inject: (message) => pending.push(message) }
    registerAgentTools(ctx, { service, mappings: wslMappings, config: {} })
    await listeners[0].listener.call({}, { agent })
    assert.equal(pending.length, 1)
    const message = JSON.parse(JSON.stringify(pending[0]))
    assert.equal(message.role, 'user')
    assert.match(message.id, /^[0-9a-f-]{36}$/u)
    assert.deepEqual(message.source, { kind: 'plugin:dsh-remote-wsl' })
    assert.equal(message.content[0].type, 'text')
    assert.match(message.content[0].text, /\/home\/me\/proj/u)
  })

  await test('WSL shadows file tools inherited from the agent preset rather than only global tools', async () => {
    const { ctx, listeners } = createAgentToolsCtx(WSL_CWD)
    const { scope, registered, restrictions } = createToolsFake()
    const agent = { id: 's1', ctx: scope }
    const available = new Set(['read', 'write', 'edit', 'glob', 'grep', 'pwsh'])
    scope.tools.get = (name, viewingAgent) => viewingAgent === agent && available.has(name) ? {} : undefined
    registerAgentTools(ctx, { service, mappings: wslMappings, config: {} })
    await listeners[0].listener.call({}, { agent })
    assert.deepEqual(registered.map(tool => tool.name).sort(), ['bash', 'edit', 'glob', 'grep', 'read', 'write'])
    assert.deepEqual(restrictions, [{ deny: ['pwsh'] }])
  })

  await test('WSL definitions keep native mutation presenters and map present before delegating', async () => {
    const { createWslToolDefinitions } = await load('lib/tool-defs.js')
    const calls = []
    const nativeOutput = { schema: { type: 'object' }, render: () => [], presentationMeta: (_args, value) => ({ path: value.path, diffs: [value] }) }
    const presentCall = () => ({ card: 'diff', diffs: [] })
    const originals = {
      write: { name: 'write', output: nativeOutput, presentCall },
      edit: { name: 'edit', output: nativeOutput, presentCall },
      present: { name: 'present', description: 'Official present', parameters: { type: 'object' }, output: nativeOutput,
        execute: async (args, exec) => { calls.push({ args, exec }); return { turn: 1, files: args.files } } },
    }
    const mappings = { resolveModelPath: async (_origin, input) => ({ linuxPath: input, hostPath: `\\\\wsl.localhost\\Ubuntu${input.replaceAll('/', '\\')}` }) }
    const definitions = createWslToolDefinitions({ service: { getMountRoot: async () => '/mnt' }, mappings, origin: { distro: 'Ubuntu', linuxPath: '/home/me/proj' }, home: '/home/me', config: {}, hasTool: name => name in originals, getTool: name => originals[name] })
    for (const name of ['write', 'edit']) {
      const tool = definitions.tools.find(tool => tool.name === name)
      assert.equal(tool.output, nativeOutput)
      assert.equal(tool.presentCall, presentCall)
    }
    const present = definitions.tools.find(tool => tool.name === 'present')
    assert.ok(present, 'WSL must retain official present')
    const exec = { callId: 'present-1' }
    const args = { files: [{ path: '/home/me/proj/report.md', description: 'Report' }] }
    const result = await present.execute(args, exec)
    assert.equal(calls[0].exec, exec)
    assert.equal(calls[0].args.files[0].path, '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\report.md')
    assert.equal(result.files[0].description, 'Report')
    assert.equal(args.files[0].path, '/home/me/proj/report.md')
    originals.present.execute = async () => { throw new Error('official file validation refused') }
    await assert.rejects(present.execute(args, exec), /official file validation refused/u)
  })

  await test('Linux file mapping refuses UNC paths belonging to another distribution', async () => {
    const { createWorkspaceMappingStore } = await load('lib/wsl-workspaces.js')
    const mappings = createWorkspaceMappingStore({})
    const origin = { distro: 'Ubuntu', linuxPath: '/home/me/proj' }
    await assert.rejects(mappings.resolveModelPath(origin, '\\\\wsl.localhost\\Debian\\home\\me\\report.md'), /发行版|distribution/u)
    const correct = await mappings.resolveModelPath(origin, '\\\\wsl.localhost\\ubuntu\\home\\me\\report.md')
    assert.equal(correct.linuxPath, '/home/me/report.md')
  })

  await test('resuming replaces only legacy WSL strings and preserves queued user messages', async () => {
    const { ctx, listeners } = createAgentToolsCtx(WSL_CWD)
    const { scope } = createToolsFake()
    const legacy = '本会话的目录在 WSL 发行版 Ubuntu 内：/home/me/proj。shell 是 Linux bash，路径请使用 Linux 形式；Windows 盘在 /mnt/<盘符>。请用 bash 工具执行命令，不要使用 PowerShell。'
    const user = { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }
    const pending = [user, legacy]
    const splices = []
    const agent = {
      id: 's1', ctx: scope,
      inbox: {
        nextStep: pending, nextTurn: [],
        splice(target, start, count, inserted) {
          assert.equal(target, 'next-step')
          splices.push({ start, count })
          return pending.splice(start, count, ...inserted)
        },
      },
      inject: (message) => pending.push(message),
    }
    registerAgentTools(ctx, { service, mappings: wslMappings, config: {} })
    await listeners[0].listener.call({}, { agent, source: 'resume' })
    assert.equal(pending.length, 2)
    assert.equal(pending[0], user)
    assert.equal(typeof pending[1], 'object')
    assert.equal(pending[1].role, 'user')
    assert.deepEqual(splices, [{ start: 1, count: 1 }])
  })

  await test('no agent scope means no registration instead of leaking globally', async () => {
    const { ctx, listeners } = createAgentToolsCtx(WSL_CWD)
    const { registered } = createToolsFake()
    registerAgentTools(ctx, { service, mappings: wslMappings, config: {} })
    // Called with an undefined `this` and an agent without a scoped context.
    await listeners[0].listener.call(undefined, { agent: { id: 's1' } })
    assert.deepEqual(registered, [])
  })

  await test('same agent is only initialized once', async () => {
    const { ctx, listeners } = createAgentToolsCtx(WSL_CWD)
    const { scope, registered } = createToolsFake()
    registerAgentTools(ctx, { service, mappings: wslMappings, config: {} })
    const agent = { id: 's1' }
    await listeners[0].listener.call(scope, { agent })
    const first = registered.length
    await listeners[0].listener.call(scope, { agent })
    assert.equal(registered.length, first)
  })

  await test('terminal allocation is rewritten to wsl.exe for a WSL workspace', async () => {
    const calls = []
    const original = async (spec) => {
      calls.push(spec)
      return { spec }
    }
    const subprocess = { spawnTerminal: original }
    const ctx = { subprocess }
    const wslService = { resolveWslExecutable: async () => 'C:\\Windows\\System32\\wsl.exe' }
    const dispose = registerTerminalRouting(ctx, { service: wslService, mappings: wslMappings, config: {} })
    assert.notEqual(subprocess.spawnTerminal, original)
    const spec = {
      argv: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoLogo'],
      cwd: WSL_CWD,
      rows: 30,
      cols: 100,
      terminalType: 'xterm-256color',
      graceMs: 3000,
    }
    await subprocess.spawnTerminal(spec)
    assert.equal(calls.length, 1)
    const rewritten = calls[0]
    assert.deepEqual(rewritten.argv, [
      'C:\\Windows\\System32\\wsl.exe',
      '-d',
      'Ubuntu',
      '--cd',
      '/home/me/proj',
    ])
    assert.match(rewritten.cwd, /System32$/)
    assert.equal(rewritten.rows, 30)
    assert.equal(rewritten.cols, 100)
    assert.equal(rewritten.terminalType, 'xterm-256color')
    dispose()
    assert.equal(subprocess.spawnTerminal, original)
  })

  await test('non-WSL terminal allocation passes through unchanged', async () => {
    const calls = []
    const original = async (spec) => {
      calls.push(spec)
      return { spec }
    }
    const subprocess = { spawnTerminal: original }
    const dispose = registerTerminalRouting(
      { subprocess },
      { service: { resolveWslExecutable: async () => 'wsl.exe' }, mappings: wslMappings, config: {} },
    )
    const spec = { argv: ['pwsh.exe'], cwd: 'E:\\source\\project', rows: 30, cols: 100, terminalType: 'xterm', graceMs: 3000 }
    await subprocess.spawnTerminal(spec)
    assert.equal(calls[0], spec)
    dispose()
  })

  await test('terminal routing degrades cleanly when spawnTerminal is missing', async () => {
    const dispose = registerTerminalRouting(
      { subprocess: {} },
      { service: { resolveWslExecutable: async () => 'wsl.exe' }, mappings: wslMappings, config: {} },
    )
    assert.equal(typeof dispose, 'function')
    dispose()
  })

  console.log(`\nPASS ${passed} FAIL ${failures.length}`)
  if (failures.length > 0) process.exitCode = 1
}

await main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
