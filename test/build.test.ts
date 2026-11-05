import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import type { HostServices } from '../dist/contracts.js'

const require = createRequire(import.meta.url)

test('official Cordis loads config and owns route cleanup without optional agent services', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const plugin = await import('../dist/index.js')
  const ctx = new Context()
  let registrations = 0
  let disposals = 0
  const webServer: HostServices['webServer'] = { register(route) {
    assert.equal(route.path, '/dsh-remote-wsl')
    registrations += 1
    return () => { disposals += 1 }
  } }
  ctx.provide('webServer', webServer)
  ctx.provide('connection', { requestRejection: () => undefined })
  ctx.provide('subprocess', { resolveExecutable: async () => 'wsl.exe', spawn() { throw new Error('Discovery should be lazy') } })
  try {
    await ctx.plugin(plugin, { terminal: false, tools: false })
    assert.equal(registrations, 1)
  } finally {
    await ctx.fiber.dispose()
  }
  assert.equal(disposals, 1)
})

test('published plugin exposes a Standard Schema config and accepts existing configuration', async () => {
  const plugin = await import('../dist/index.js')
  assert.equal(plugin.Config?.['~standard']?.version, 1)
  const result = await plugin.Config['~standard'].validate({ terminal: false, execTimeoutMs: '2500' })
  assert.equal('issues' in result ? result.issues : undefined, undefined)
  assert.equal(result.value.terminal, false)
  assert.equal(result.value.execTimeoutMs, 2500)
  assert.equal(result.value.maxEntries, 2000)
})

test('public Host and browser entry points load without executing another React instance', async () => {
  const manifest: unknown = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(typeof manifest === 'object' && manifest !== null && 'exports' in manifest)
  const exports = manifest.exports
  assert.ok(typeof exports === 'object' && exports !== null && '.' in exports && './client' in exports)
  const hostExport = entryPoint(exports['.'])
  const clientExport = entryPoint(exports['./client'])
  await access(new URL(`../${typeof hostExport === 'string' ? hostExport : hostExport.default}`, import.meta.url))
  await access(new URL(`../${typeof clientExport === 'string' ? clientExport : clientExport.default}`, import.meta.url))
  const definitions: { id: string; factory(require: (name: string) => unknown): ClientPlugin }[] = []
  vm.runInNewContext(await readFile(new URL('../dist/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (definition: typeof definitions[number]) => definitions.push(definition) } },
  })
  assert.equal(definitions.length, 1)
  assert.equal(definitions[0].id, 'dsh-remote-wsl')
  const requested: string[] = []
  const client = definitions[0].factory(name => {
    requested.push(name)
    if (name === 'react') return { createElement() {}, Fragment: Symbol('Fragment') }
    if (name === 'react-dom') return {}
    throw new Error(`Unexpected browser dependency: ${name}`)
  })
  assert.equal(typeof client.apply, 'function')
  assert.equal(typeof client.__test.createStore, 'function')
  assert.deepEqual(requested.sort(), ['react', 'react-dom'])
  assert.equal(require.resolve('../dist/scripts/repair-legacy.cjs').endsWith('repair-legacy.cjs'), true)
})

function entryPoint(value: unknown): string | { default: string } {
  if (typeof value === 'string') return value
  assert.ok(typeof value === 'object' && value !== null && 'default' in value && typeof value.default === 'string')
  return { default: value.default }
}
