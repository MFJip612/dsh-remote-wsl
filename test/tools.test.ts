#!/usr/bin/env node
/**
 * Tool-runtime integration test: runs the WSL-side tools against the real distribution.
 *
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'C:\Users\Mingf\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' test\tools.test.ts
 *
 * Creates a scratch directory inside the distribution, exercises write/read/edit/glob/grep/bash,
 * and removes it again. Skips (exit 0) when WSL is unavailable.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createWslService } from '../dist/lib/wsl-service.js'
import { createWorkspaceMappingStore } from '../dist/lib/wsl-workspaces.js'
import { createWslToolRuntime } from '../dist/lib/tool-wsl.js'
import { resolveConfig } from '../dist/config.js'
import type { ProcessOutcome, SubprocessPort, WslOrigin } from '../dist/contracts.js'


let passed = 0
const failures: string[] = []
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`FAIL ${name}\n     ${error instanceof Error ? error.stack : error}`)
  }
}

function createSubprocessBridge(): SubprocessPort {
  return {
    async resolveExecutable(command) {
      return path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', command)
    },
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, windowsHide: true })
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      child.stdout.pipe(stdout)
      child.stderr.pipe(stderr)
      child.on('error', (error) => {
        stdout.destroy(error)
        stderr.destroy(error)
      })
      if (spec.stdio?.stdin !== undefined && typeof spec.stdio.stdin === 'object') {
        child.stdin?.end(spec.stdio.stdin.data)
      } else {
        child.stdin?.end()
      }
      const done = new Promise<ProcessOutcome>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      })
      return {
        stdout,
        stderr,
        done,
        terminate() {
          child.kill()
        },
      }
    },
  }
}

const scratch = path.join(os.tmpdir(), `dsh-remote-wsl-test-${process.pid}`)

async function main() {
  process.env.DSH_HOME = scratch

  const service = createWslService({ subprocess: createSubprocessBridge() }, resolveConfig({
    execTimeoutMs: 20000,
    maxReadBytes: 2_000_000,
    maxEntries: 2000,
    mountRoot: '',
  }))
  const listed = await service.listDistros({ refresh: true })
  if (!listed.available || listed.distros.length === 0) {
    console.log('skip tool integration (WSL unavailable)')
    console.log(`\nPASS ${passed} FAIL ${failures.length}`)
    return
  }
  const distro = listed.defaultDistro ?? Array.from<{ name: string }>(listed.distros)[0].name
  const identity = await service.resolveIdentity(distro)
  const home = identity.home
  const projectLinux = `${home}/.dsh-remote-wsl-test-${process.pid}`
  const mappings = createWorkspaceMappingStore({ mountRoot: '' })
  const sandboxPolicy = { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '' }) }

  const listedProject = service.toHostPath(distro, projectLinux)
  const origin: WslOrigin = {
    hostPath: (await listedProject).hostPath, mapped: (await listedProject).mapped, source: 'mapping',
    distro,
    linuxPath: projectLinux,
    rootHostPath: (await listedProject).hostPath,
  }
  await mappings.remember({
    distro,
    linuxPath: projectLinux,
    hostPath: origin.rootHostPath,
    mapped: (await listedProject).mapped,
  })
  const runtime = createWslToolRuntime({
    service,
    mappings,
    config: resolveConfig({ execTimeoutMs: 20000, maxReadBytes: 2_000_000, mountRoot: '' }),
    origin,
    home,
    session: { id: 'test' },
    sandboxPolicy,
  })

  try {
    await test('mutations notify before publication and expose complete before/after content', async () => {
      const file = `${projectLinux}/delivery.txt`
    const calls: string[] = []
      const exec = { callId: 'delivery-edit' }
      const integrated = createWslToolRuntime({ service, mappings, config: resolveConfig({ maxReadBytes: 2_000_000 }), origin, home, session: { id: 'test' }, sandboxPolicy,
        fileIntegration: {
          async prepare(kind, target, actor) {
            assert.equal(actor, exec)
            calls.push(`${kind}:${target.linuxPath}`)
            return async () => { calls.push('checked') }
          },
          async observed(target, actor) { assert.equal(actor, exec); calls.push(`observed:${target.linuxPath}`) },
        },
      })
      const write = await integrated.write({ file_path: file, content: 'before\n' }, exec)
      assert.equal(write.before, null)
      assert.equal(write.after, 'before\n')
      const edit = await integrated.edit({ file_path: file, old_string: 'before', new_string: 'after' }, exec)
      assert.equal(edit.before, 'before\n')
      assert.equal(edit.after, 'after\n')
      assert.ok(edit.hostPath.startsWith('\\\\wsl'))
      assert.deepEqual(calls, [`write:${file}`, 'checked', `observed:${file}`, `edit:${file}`, 'checked', `observed:${file}`])
    })

    await test('native mutation denial leaves the file unchanged', async () => {
      const file = `${projectLinux}/delivery.txt`
      const denied = createWslToolRuntime({ service, mappings, config: resolveConfig({}), origin, home, session: { id: 'test' }, sandboxPolicy,
        fileIntegration: { observed: async () => {}, prepare: async () => { throw new Error('denied by native policy') } },
      })
      await assert.rejects(denied.write({ file_path: file, content: 'wrong' }, {}), /denied by native policy/u)
      assert.match((await runtime.read({ file_path: file })).text, /after/u)
    })
    await runtime.bash({ command: `rm -rf ${JSON.stringify(projectLinux)} && mkdir -p ${JSON.stringify(projectLinux)}/src` })

    await test('write + read round trip', async () => {
      const file = `${projectLinux}/src/a.ts`
      await runtime.write({ file_path: file, content: 'const a = 1\nconst b = 2\n' })
      const read = await runtime.read({ file_path: file })
      assert.equal(read.totalLines, 2)
      assert.match(read.text, /const a = 1/)
      assert.match(read.text, /\s+1→const a = 1/)
    })

    await test('read window honours offset/limit', async () => {
      const file = `${projectLinux}/src/a.ts`
      const read = await runtime.read({ file_path: file, offset: 2, limit: 1 })
      assert.match(read.text, /const b = 2/)
      assert.doesNotMatch(read.text, /const a = 1/)
    })

    await test('relative paths resolve against the workspace root', async () => {
      await runtime.write({ file_path: 'src/rel.txt', content: 'relative\n' })
      const read = await runtime.read({ file_path: 'src/rel.txt' })
      assert.match(read.text, /relative/)
    })

    await test('edit applies a unique replacement', async () => {
      const file = `${projectLinux}/src/a.ts`
      await runtime.edit({ file_path: file, old_string: 'const b = 2', new_string: 'const b = 3' })
      const read = await runtime.read({ file_path: file })
      assert.match(read.text, /const b = 3/)
    })

    await test('edit rejects an ambiguous match', async () => {
      const file = `${projectLinux}/src/dup.txt`
      await runtime.write({ file_path: file, content: 'x\nx\n' })
      await assert.rejects(runtime.edit({ file_path: file, old_string: 'x', new_string: 'y' }), /2/)
    })

    await test('edit replace_all replaces every occurrence', async () => {
      const file = `${projectLinux}/src/dup.txt`
      const result = await runtime.edit({
        file_path: file,
        old_string: 'x',
        new_string: 'y',
        replace_all: true,
      })
      assert.equal(result.replaced, 2)
    })

    await test('glob finds files by pattern', async () => {
      const result = await runtime.glob({ pattern: '**/*.ts', path: projectLinux })
      assert.ok(result.paths.some((entry) => entry.endsWith('/src/a.ts')), result.text)
    })

    await test('grep finds matching lines', async () => {
      const result = await runtime.grep({ pattern: 'const b = 3', path: projectLinux })
      assert.match(result.text, /a\.ts:2:const b = 3/)
    })

    await test('bash runs in the workspace with an exit code footer', async () => {
      const result = await runtime.bash({ command: 'pwd && ls' })
      assert.equal(result.exitCode, 0)
      assert.match(result.text, /\[exit code: 0\]/)
      assert.match(result.text, /src/)
    })

    await test('read-only policy refuses writes and bash', async () => {
      const locked = createWslToolRuntime({
        service,
        mappings,
        config: resolveConfig({ execTimeoutMs: 20000, maxReadBytes: 2_000_000, mountRoot: '' }),
        origin,
        home,
        session: { id: 'test' },
        sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: origin.rootHostPath }) },
      })
      await assert.rejects(locked.write({ file_path: 'src/locked.txt', content: 'nope' }), /只读|read-only/)
      await assert.rejects(locked.bash({ command: 'echo hi' }), /只读|read-only/)
    })

    await test('workspace-write policy refuses an outside target', async () => {
      const scoped = createWslToolRuntime({
        service,
        mappings,
        config: resolveConfig({ execTimeoutMs: 20000, maxReadBytes: 2_000_000, mountRoot: '' }),
        origin,
        home,
        session: { id: 'test' },
        sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: origin.rootHostPath }) },
      })
      await assert.rejects(scoped.write({ file_path: '/tmp/drw-outside.txt', content: 'nope' }), /工作区/)
    })
  } finally {
    await service
      .runText(['-d', distro, '--exec', 'bash', '-lc', `rm -rf ${JSON.stringify(projectLinux)}`])
      .catch(() => undefined)
  }

  console.log(`\nPASS ${passed} FAIL ${failures.length}`)
  if (failures.length > 0) process.exitCode = 1
}

await main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
