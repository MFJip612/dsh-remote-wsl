/**
 * Host-side WSL service for dsh-remote-wsl.
 *
 * Owns everything that touches the Windows side of WSL:
 *  - distribution discovery (ported from ZCode `packages/server/src/remote/wsl-detect.ts`),
 *  - the sentinel identity probe (same file, `wsl-backend.ts:53-63,540-597`),
 *  - Linux directory listing over the `\\wsl.localhost` share with a `find` fallback,
 *  - Linux <-> host path mapping (`/mnt/<drive>` maps to a real Windows drive path because the
 *    WSL 9P share refuses those directories),
 *  - a managed runner around `ctx.subprocess.spawn` (argv only, never a shell).
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import {
  createWslDiscovery,
  decodeWslOutput,
  normalizeWslOutput,
} from './wsl-detect.js'
import {
  DEFAULT_MOUNT_ROOT,
  defaultUserFromWslConf,
  expandTilde,
  homeFromPasswd,
  isValidDistroName,
  joinLinux,
  linuxCrumbs,
  linuxToHostPath,
  mountRootFromWslConf,
  normalizeLinuxPath,
  parentLinuxPath,
  parseWslHostPath,
} from './wsl-path.js'

const IDENTITY_SENTINEL = '__DSH_REMOTE_WSL_IDENTITY__'
const IDENTITY_TTL_MS = 60_000
const MOUNT_ROOT_TTL_MS = 300_000

/** Error carrying a stable code the HTTP layer maps to a status. */
export function codedError(code, message, extra) {
  return Object.assign(new Error(message), { code, ...(extra ?? {}) })
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** The Windows directory every wsl.exe invocation uses as its own cwd. */
export function windowsSystemDirectory() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return path.win32.join(root, 'System32')
}

async function collectStream(stream, maxBytes) {
  if (stream === undefined || stream === null) return Buffer.alloc(0)
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (size >= maxBytes) continue
    const slice = buffer.subarray(0, maxBytes - size)
    if (slice.length > 0) {
      chunks.push(slice)
      size += slice.length
    }
  }
  return Buffer.concat(chunks, size)
}

/**
 * Create the service. `ctx` needs `subprocess`; `config` is the resolved plugin config.
 */
export function createWslService(ctx, config) {
  const execTimeoutMs = Number(config.execTimeoutMs) || 15_000
  const maxEntries = Number(config.maxEntries) || 2000

  let wslExecutablePromise
  async function resolveWslExecutable() {
    if (wslExecutablePromise === undefined) {
      wslExecutablePromise = (async () => {
        try {
          return await ctx.subprocess.resolveExecutable('wsl.exe')
        } catch {
          return path.win32.join(windowsSystemDirectory(), 'wsl.exe')
        }
      })().catch((error) => {
        wslExecutablePromise = undefined
        throw error
      })
    }
    return wslExecutablePromise
  }

  /**
   * Run `wsl.exe` with an argv array and collect raw buffers.
   * Returns `{ stdout, stderr, exitCode, timedOut }`; it does NOT throw on a non-zero exit
   * (callers decide) but does throw when the process could not be started.
   */
  async function runRaw(args, options = {}) {
    const executable = await resolveWslExecutable()
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || execTimeoutMs)
    const stdoutMax = Number(options.stdoutMaxBytes) || 8 * 1024 * 1024
    const stderrMax = Number(options.stderrMaxBytes) || 1024 * 1024
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const onParentAbort = () => controller.abort()
    if (options.signal !== undefined) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', onParentAbort, { once: true })
    }
    try {
      let handle
      try {
        handle = ctx.subprocess.spawn({
          argv: [executable, ...args],
          cwd: windowsSystemDirectory(),
          graceMs: 3000,
          signal: controller.signal,
          stdio: {
            stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        })
      } catch (error) {
        throw codedError('wsl-unavailable', `无法启动 wsl.exe：${messageOf(error)}`)
      }
      let outcome
      const outputsPromise = Promise.all([
        collectStream(handle.stdout, stdoutMax),
        collectStream(handle.stderr, stderrMax),
      ])
      try {
        outcome = await handle.done
      } catch (error) {
        await outputsPromise.catch(() => undefined)
        throw codedError('wsl-unavailable', `wsl.exe 执行失败：${messageOf(error)}`)
      }
      const [stdout, stderr] = await outputsPromise
      return {
        stdout,
        stderr,
        exitCode: outcome?.exitCode ?? null,
        signal: outcome?.signal ?? null,
        timedOut,
      }
    } finally {
      clearTimeout(timer)
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onParentAbort)
    }
  }

  /** Run wsl.exe and return decoded UTF-8 stdout; throws with the best available detail. */
  async function runText(args, options = {}) {
    const result = await runRaw(args, options)
    const stdout = result.stdout.toString('utf8')
    const stderr = result.stderr.toString('utf8')
    if (result.timedOut) {
      throw codedError('wsl-timeout', `WSL 命令超时（${messageOf(options.timeoutMs || execTimeoutMs)}ms）`)
    }
    if (result.exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || `退出码 ${result.exitCode ?? 'unknown'}`
      throw codedError('wsl-command-failed', detail, {
        exitCode: result.exitCode,
        stdout,
        stderr,
      })
    }
    return stdout
  }

  const discovery = createWslDiscovery({
    exec: async (args) => {
      const result = await runRaw(args, { stdoutMaxBytes: 2 * 1024 * 1024 })
      if (result.timedOut) throw codedError('wsl-timeout', 'WSL 探测超时')
      if (result.exitCode !== 0) {
        const detail =
          normalizeWslOutput(decodeWslOutput(result.stderr)).trim() ||
          normalizeWslOutput(decodeWslOutput(result.stdout)).trim() ||
          `退出码 ${result.exitCode}`
        throw Object.assign(new Error(detail), { exitCode: result.exitCode })
      }
      return result.stdout
    },
  })

  const identityCache = new Map()
  const mountRootCache = new Map()

  async function rawDistroList() {
    return discovery.listDistros()
  }

  async function listDistros(options = {}) {
    if (process.platform !== 'win32') {
      return {
        available: false,
        platform: process.platform,
        distros: [],
        defaultDistro: null,
        error: 'WSL 仅支持在 Windows 上使用',
      }
    }
    if (options.refresh === true) discovery.invalidate()
    try {
      const raw = await rawDistroList()
      const distros = raw.map((distro) => {
        const state = String(distro.state ?? '')
        const running = /^running/i.test(state)
        const stopped = /^stopped/i.test(state)
        return {
          name: distro.name,
          isDefault: distro.isDefault === true,
          state,
          running,
          status: running ? 'running' : stopped ? 'stopped' : 'other',
          version: distro.version ?? null,
          wsl1: distro.version === 1,
        }
      })
      const preferred = distros.find((distro) => distro.isDefault) ?? distros[0]
      return {
        available: true,
        platform: process.platform,
        distros,
        defaultDistro: preferred?.name ?? null,
        error: undefined,
      }
    } catch (error) {
      const available = await discovery.isAvailable().catch(() => false)
      return {
        available,
        platform: process.platform,
        distros: [],
        defaultDistro: null,
        error: messageOf(error),
      }
    }
  }

  /** Validate a distro name against the installed list and return its canonical spelling. */
  async function requireDistro(requested) {
    const wanted = String(requested ?? '').trim()
    if (wanted.length === 0) throw codedError('invalid-request', '缺少 WSL 发行版名称')
    if (!isValidDistroName(wanted)) throw codedError('invalid-request', 'WSL 发行版名称无效')
    const listed = await listDistros()
    if (!listed.available) {
      throw codedError('wsl-unavailable', listed.error || '当前系统未检测到可用的 WSL 环境')
    }
    const match = listed.distros.find(
      (distro) => distro.name.localeCompare(wanted, undefined, { sensitivity: 'base' }) === 0,
    )
    if (match === undefined) {
      throw codedError('distro-not-found', `未找到名为 ${wanted} 的 WSL 发行版`)
    }
    return match
  }

  function cacheGet(cache, key, ttlMs) {
    const entry = cache.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key)
      return undefined
    }
    return entry
  }

  function cacheRemember(cache, key, value, ttlMs) {
    const entry = { value, expiresAt: Date.now() + ttlMs }
    cache.set(key, entry)
    return entry
  }

  /** Resolve the distribution's default user and HOME (sentinel probe, then /etc fallback). */
  async function resolveIdentity(requestedDistro) {
    const distro = (await requireDistro(requestedDistro)).name
    const key = distro.toLowerCase()
    const cached = cacheGet(identityCache, key, IDENTITY_TTL_MS)
    if (cached !== undefined) return cached.value
    const script = `printf '%s\\n' '${IDENTITY_SENTINEL}' "$WSL_DISTRO_NAME" "$(id -un)" "$HOME"`
    const run = (async () => {
      let probeError
      try {
        const output = await runText(
          ['-d', distro, '--exec', 'bash', '--noprofile', '--norc', '-c', script],
          { timeoutMs: Math.max(execTimeoutMs, 20_000) },
        )
        const lines = normalizeWslOutput(output).split('\n')
        const index = lines.map((line) => line.trim()).lastIndexOf(IDENTITY_SENTINEL)
        if (index >= 0) {
          const reportedDistro = (lines[index + 1] ?? '').trim()
          const user = (lines[index + 2] ?? '').trim()
          const home = lines
            .slice(index + 3)
            .join('\n')
            .trim()
          if (home.length > 0) {
            return { distro, user: user || 'root', home, source: 'probe', reportedDistro }
          }
        }
        probeError = codedError('identity-failed', '无法解析 WSL 身份：探测输出缺少身份信息')
      } catch (error) {
        probeError = error
      }
      // Fallback: read the distribution's config files through the share.
      const fallback = await readIdentityFromEtc(distro).catch(() => null)
      if (fallback !== null) return fallback
      throw probeError ?? codedError('identity-failed', '无法解析 WSL 身份')
    })()
    try {
      const value = await run
      cacheRemember(identityCache, key, value, IDENTITY_TTL_MS)
      return value
    } catch (error) {
      identityCache.delete(key)
      throw error
    }
  }

  async function readEtcFile(distro, name) {
    const unc = `\\\\wsl.localhost\\${distro}\\etc\\${name}`
    return await fsp.readFile(unc, 'utf8')
  }

  async function readIdentityFromEtc(distro) {
    const [wslConf, passwd] = await Promise.all([
      readEtcFile(distro, 'wsl.conf').catch(() => ''),
      readEtcFile(distro, 'passwd').catch(() => ''),
    ])
    const user = defaultUserFromWslConf(wslConf)
    const home = user !== null ? homeFromPasswd(passwd, user) : homeFromPasswd(passwd, 'root')
    if (home === null) throw codedError('identity-failed', '无法从 /etc/passwd 解析 HOME')
    return { distro, user: user || 'root', home, source: 'etc', reportedDistro: distro }
  }

  async function getMountRoot(distro) {
    const key = distro.toLowerCase()
    const cached = cacheGet(mountRootCache, key, MOUNT_ROOT_TTL_MS)
    if (cached !== undefined) return cached.value
    if (typeof config.mountRoot === 'string' && config.mountRoot.trim().length > 0) {
      const value = normalizeLinuxPath(config.mountRoot.trim())
      cacheRemember(mountRootCache, key, value, MOUNT_ROOT_TTL_MS)
      return value
    }
    let value = DEFAULT_MOUNT_ROOT
    try {
      const text = await readEtcFile(distro, 'wsl.conf')
      value = mountRootFromWslConf(text)
    } catch {
      value = DEFAULT_MOUNT_ROOT
    }
    cacheRemember(mountRootCache, key, value, MOUNT_ROOT_TTL_MS)
    return value
  }

  async function toHostPath(distro, linuxPath) {
    const mountRoot = await getMountRoot(distro)
    return linuxToHostPath(linuxPath, distro, { mountRoot })
  }

  async function resolveLinuxPath(distro, requestedPath) {
    const identity = await resolveIdentity(distro).catch(() => null)
    const home = identity?.home ?? '/root'
    const raw = String(requestedPath ?? '').trim()
    if (raw.length === 0) return normalizeLinuxPath(home)
    if (raw === '~' || raw.startsWith('~/')) return normalizeLinuxPath(expandTilde(raw, home))
    if (raw.startsWith('/')) return normalizeLinuxPath(raw)
    return normalizeLinuxPath(joinLinux(home, raw))
  }

  async function readdirViaShare(hostPath) {
    const dirents = await fsp.readdir(hostPath, { withFileTypes: true })
    const entries = []
    for (const dirent of dirents) {
      const name = dirent.name
      if (name === '.' || name === '..') continue
      const isSymlink = dirent.isSymbolicLink()
      let isDirectory = dirent.isDirectory()
      if (!isDirectory && isSymlink) {
        try {
          const stat = await fsp.stat(path.win32.join(hostPath, name))
          isDirectory = stat.isDirectory()
        } catch {
          isDirectory = false
        }
      }
      if (!isDirectory) continue
      entries.push({ name, symlink: isSymlink })
    }
    return entries
  }

  async function readdirViaWsl(distro, linuxPath) {
    const output = await runText(
      ['-d', distro, '--exec', 'find', linuxPath, '-maxdepth', '1', '-mindepth', '1', '-type', 'd', '-printf', '%f\\n'],
      { timeoutMs: Math.max(execTimeoutMs, 20_000) },
    )
    return normalizeWslOutput(output)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((name) => ({ name, symlink: false }))
  }

  /**
   * List one Linux directory (directories only). `path` defaults to the user's HOME.
   * Returns the listing shape consumed by the client plus path-mapping facts.
   */
  async function listPath(requestedDistro, requestedPath, options = {}) {
    const distroEntry = await requireDistro(requestedDistro)
    const distro = distroEntry.name
    const identity = await resolveIdentity(distro).catch(() => null)
    const home = identity?.home ?? '/'
    const linuxPath = await resolveLinuxPath(distro, requestedPath)
    const mountRoot = await getMountRoot(distro)
    const mapped = linuxToHostPath(linuxPath, distro, { mountRoot })
    let entries
    let source = 'share'
    try {
      entries = await readdirViaShare(mapped.hostPath)
    } catch (shareError) {
      try {
        entries = await readdirViaWsl(distro, linuxPath)
        source = 'wsl'
      } catch (wslError) {
        throw codedError('directory-unreadable', describeListingError(shareError, linuxPath), {
          cause: shareError,
          wslError: messageOf(wslError),
        })
      }
    }
    const showHidden = options.hidden === true
    const visible = entries
      .filter((entry) => showHidden || !entry.name.startsWith('.'))
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }),
      )
    const truncated = visible.length > maxEntries
    return {
      distro,
      path: linuxPath,
      home,
      parent: parentLinuxPath(linuxPath),
      crumbs: linuxCrumbs(linuxPath, distro),
      entries: visible.slice(0, maxEntries).map((entry) => ({
        name: entry.name,
        path: joinLinux(linuxPath, entry.name),
        symlink: entry.symlink === true,
      })),
      truncated,
      hidden: showHidden,
      source,
      mountRoot,
      wsl1: distroEntry.wsl1 === true,
    }
  }

  function describeListingError(error, linuxPath) {
    const code = error?.code
    if (code === 'ENOENT') return `此文件夹不存在：${linuxPath}`
    if (code === 'EACCES' || code === 'EPERM') return `没有访问权限：${linuxPath}`
    if (code === 'ENOTDIR') return `不是文件夹：${linuxPath}`
    return `无法读取文件夹 ${linuxPath}：${messageOf(error)}`
  }

  async function directoryExists(distro, linuxPath) {
    const mapped = await toHostPath(distro, linuxPath)
    try {
      const stat = await fsp.stat(mapped.hostPath)
      return stat.isDirectory()
    } catch {
      return false
    }
  }

  /** Wake a stopped distribution in the background (the first share access would do it too). */
  function warm(requestedDistro) {
    const task = (async () => {
      const entry = await requireDistro(requestedDistro)
      await runText(['-d', entry.name, '--exec', 'true'], {
        timeoutMs: Math.max(execTimeoutMs, 30_000),
      }).catch(() => undefined)
    })()
    void task.catch(() => undefined)
    return task
  }

  return {
    listDistros,
    requireDistro,
    resolveIdentity,
    resolveLinuxPath,
    listPath,
    directoryExists,
    toHostPath,
    getMountRoot,
    warm,
    runText,
    runRaw,
    resolveWslExecutable,
    // exposed for tests / other host modules
    _internals: { discovery, identityCache, mountRootCache, readIdentityFromEtc },
  }
}

/** Re-exported for callers that only need the mapping helpers. */
export { parseWslHostPath }
