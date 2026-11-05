#!/usr/bin/env node
/**
 * dsh-remote-wsl test runner.
 *
 * Run after building with Node.js 24 or newer:
 *   node test/run.ts
 *
 * Sections: pure modules, then the host service against the real WSL distribution.
 * Exit code 1 on failure.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ProcessOutcome, SubprocessPort } from '../dist/contracts.js'
import { resolveConfig } from '../dist/config.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
interface Modules {
  'dist/lib/wsl-detect.js': typeof import('../dist/lib/wsl-detect.js')
  'dist/lib/wsl-path.js': typeof import('../dist/lib/wsl-path.js')
  'dist/lib/wsl-service.js': typeof import('../dist/lib/wsl-service.js')
}
// The generic key ties the dynamic file URL to its emitted declaration module.
const load = <K extends keyof Modules>(relative: K): Promise<Modules[K]> => import(pathToFileURL(path.join(root, relative)).href)

let passed = 0
const failures: { name: string; error: unknown }[] = []
async function test(name: string, fn: () => unknown) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL ${name}\n     ${error instanceof Error ? error.stack : String(error)}`)
  }
}

/**
 * Minimal subprocess bridge so this test can run without a DSH Host: spawns wsl.exe through
 * node:child_process and mimics the `{ spawn, resolveExecutable }` surface the service uses.
 */
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

async function main() {
  const [detect, wslPath] = await Promise.all([load('dist/lib/wsl-detect.js'), load('dist/lib/wsl-path.js')])

  await test('decodeWslOutput: UTF-16LE with NULs', () => {
    const text = '  NAME  STATE  VERSION\n* Ubuntu  Running  2\n'
    const buffer = Buffer.from(text, 'utf16le')
    assert.ok(buffer.includes(0))
    assert.equal(detect.decodeWslOutput(buffer), text)
  })

  await test('decodeWslOutput: plain UTF-8 and empty', () => {
    assert.equal(detect.decodeWslOutput(Buffer.from('hello', 'utf8')), 'hello')
    assert.equal(detect.decodeWslOutput(Buffer.alloc(0)), '')
  })

  await test('parseWSLDistroList', () => {
    const sample =
      '  NAME            STATE           VERSION\n' +
      '* Ubuntu          Running         2\n' +
      '  Debian          Stopped         2\n' +
      '  Alma Linux      Installing      2\n'
    const parsed = detect.parseWSLDistroList(sample)
    assert.deepEqual(
      parsed.map((entry) => [entry.name, entry.state, entry.version, entry.isDefault]),
      [
        ['Ubuntu', 'Running', 2, true],
        ['Debian', 'Stopped', 2, false],
        ['Alma Linux', 'Installing', 2, false],
      ],
    )
    assert.deepEqual(detect.parseWSLDistroList(''), [])
    assert.deepEqual(detect.parseWSLDistroList('garbage'), [])
  })

  await test('createWslDiscovery caches and invalidates', async () => {
    let calls = 0
    const discovery = detect.createWslDiscovery({
      exec: async () => {
        calls += 1
        return Buffer.from('  NAME  STATE  VERSION\n* Ubuntu  Running  2\n', 'utf8')
      },
    })
    const first = await discovery.listDistros()
    const second = await discovery.listDistros()
    assert.equal(calls, 1)
    assert.deepEqual(first, second)
    discovery.invalidate()
    await discovery.listDistros()
    assert.equal(calls, 2)
  })

  await test('createWslDiscovery retries a rejected exec immediately', async () => {
    let calls = 0
    const discovery = detect.createWslDiscovery({
      exec: async () => {
        calls += 1
        if (calls === 1) throw new Error('boom')
        return Buffer.from('  NAME  STATE  VERSION\n  Ubuntu  Running  2\n', 'utf8')
      },
    })
    await assert.rejects(discovery.listDistros(), /boom/)
    const list = await discovery.listDistros()
    assert.equal(list.length, 1)
    assert.equal(calls, 2)
  })

  await test('normalizeLinuxPath', () => {
    assert.equal(wslPath.normalizeLinuxPath('/'), '/')
    assert.equal(wslPath.normalizeLinuxPath('/a/../b/'), '/b')
    assert.equal(wslPath.normalizeLinuxPath('a//b'), '/a/b')
    assert.equal(wslPath.normalizeLinuxPath('\\home\\me'), '/home/me')
    assert.throws(() => wslPath.normalizeLinuxPath(''))
    assert.throws(() => wslPath.normalizeLinuxPath('/a/\u0001b'))
  })

  await test('linux <-> host mapping', () => {
    const unc = wslPath.linuxToHostPath('/home/me/proj', 'Ubuntu')
    assert.equal(unc.hostPath, '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj')
    assert.equal(unc.mapped, 'unc')
    assert.equal(wslPath.linuxToHostPath('/', 'Ubuntu').hostPath, '\\\\wsl.localhost\\Ubuntu')
    const drive = wslPath.linuxToHostPath('/mnt/e/source/proj', 'Ubuntu')
    assert.equal(drive.hostPath, 'E:\\source\\proj')
    assert.equal(drive.mapped, 'windows')
    assert.equal(wslPath.linuxToHostPath('/mnt/e', 'Ubuntu').hostPath, 'E:\\')
    assert.deepEqual(wslPath.uncCandidates('/home/me', 'Ubuntu'), [
      '\\\\wsl.localhost\\Ubuntu\\home\\me',
      '\\\\wsl$\\Ubuntu\\home\\me',
    ])
  })

  await test('host path parsing and inversion', () => {
    assert.deepEqual(wslPath.parseWslHostPath('\\\\wsl.localhost\\Ubuntu\\home\\me'), {
      distro: 'Ubuntu',
      linuxPath: '/home/me',
    })
    assert.deepEqual(wslPath.parseWslHostPath('\\\\wsl$\\Ubuntu'), { distro: 'Ubuntu', linuxPath: '/' })
    assert.equal(wslPath.parseWslHostPath('C:\\work'), undefined)
    assert.deepEqual(wslPath.drivePathToLinux('E:\\source\\proj'), { linuxPath: '/mnt/e/source/proj' })
    assert.equal(wslPath.drivePathToLinux('E:\\', {})?.linuxPath, '/mnt/e')
  })

  await test('crumb / parent / hidden / key helpers', () => {
    assert.equal(wslPath.parentLinuxPath('/home/me'), '/home')
    assert.equal(wslPath.parentLinuxPath('/'), '/')
    assert.deepEqual(
      wslPath.linuxCrumbs('/home/me', 'Ubuntu').map((crumb) => [crumb.name, crumb.path]),
      [
        ['Ubuntu', '/'],
        ['home', '/home'],
        ['me', '/home/me'],
      ],
    )
    assert.equal(wslPath.hiddenByRule('.git'), true)
    assert.equal(wslPath.hiddenByRule('src'), false)
    assert.equal(wslPath.hostPathKey('E:\\Source\\Proj\\'), 'e:\\source\\proj')
    assert.equal(wslPath.isPathInsideHost('E:\\source', 'e:\\source\\proj\\a.ts'), true)
    assert.equal(wslPath.isPathInsideHost('E:\\source', 'E:\\source2\\a.ts'), false)
    assert.equal(wslPath.isPathInsideHost('E:\\source', 'E:\\source'), true)
  })

  await test('wsl.conf / passwd parsing', () => {
    const conf = '[boot]\nsystemd=true\n\n[automount]\nroot = /mnt2\n\n[user]\ndefault=me\n'
    assert.equal(wslPath.mountRootFromWslConf(conf), '/mnt2')
    assert.equal(wslPath.mountRootFromWslConf(''), '/mnt')
    assert.equal(wslPath.defaultUserFromWslConf(conf), 'me')
    assert.equal(wslPath.defaultUserFromWslConf('[boot]\nsystemd=true\n'), null)
    assert.equal(
      wslPath.homeFromPasswd('root:x:0:0::/root:/bin/bash\nme:x:1000:1000::/home/me:/bin/bash\n', 'me'),
      '/home/me',
    )
    assert.equal(wslPath.homeFromPasswd('root:x:0:0::/root:/bin/bash\n', 'me'), null)
  })

  await test('distro/user validation', () => {
    assert.equal(wslPath.isValidDistroName('Ubuntu'), true)
    assert.equal(wslPath.isValidDistroName('Alma Linux'), true)
    assert.equal(wslPath.isValidDistroName(''), false)
    assert.equal(wslPath.isValidDistroName('../evil'), false)
    assert.equal(wslPath.isValidDistroName('a\\b'), false)
    assert.equal(wslPath.isValidWslUser('me'), true)
    assert.equal(wslPath.isValidWslUser('a/b'), false)
    assert.equal(wslPath.isValidWslUser('x'.repeat(65)), false)
  })

  // ---- real WSL integration (skipped when WSL is unavailable) -------------------------------
  const { createWslService } = await load('dist/lib/wsl-service.js')
  const service = createWslService({ subprocess: createSubprocessBridge() }, resolveConfig({
    execTimeoutMs: 20000,
    maxEntries: 2000,
    mountRoot: '',
  }))
  const listed = await service.listDistros({ refresh: true })
  const firstDistro = listed.distros[0]
  if (!listed.available || listed.distros.length === 0) {
    console.log('skip real-WSL integration (WSL unavailable)')
  } else {
    assert.ok(firstDistro)
    const distro = listed.defaultDistro ?? firstDistro.name
    await test(`real: identity of ${distro}`, async () => {
      const identity = await service.resolveIdentity(distro)
      assert.equal(identity.distro, distro)
      assert.match(identity.home, /^\//)
    })
    await test('real: list HOME', async () => {
      const identity = await service.resolveIdentity(distro)
      const listing = await service.listPath(distro, identity.home)
      assert.equal(listing.path, identity.home)
      assert.equal(listing.crumbs[0].name, distro)
      assert.ok(Array.isArray(listing.entries))
    })
    await test('real: bash echo', async () => {
      const output = await service.runText(['-d', distro, '--exec', 'bash', '-lc', 'echo hello-drw'])
      assert.match(output, /hello-drw/)
    })
    await test('real: non-zero exit carries output', async () => {
      await assert.rejects(
        service.runText(['-d', distro, '--exec', 'bash', '-lc', 'echo failing; exit 3']),
        /failing/,
      )
    })
    await test('real: unknown distro is a coded error', async () => {
      await assert.rejects(service.requireDistro('__dsh_no_such_distro__'), (error) => {
        assert.ok(error instanceof Error && 'code' in error)
        assert.equal(error.code, 'distro-not-found')
        return true
      })
    })
  }

  console.log(`\nPASS ${passed} FAIL ${failures.length}`)
  if (failures.length > 0) process.exitCode = 1
}

await main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
