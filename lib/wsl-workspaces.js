/**
 * Durable mapping between a registered DSH workspace and its WSL origin.
 *
 * A workspace at `\\wsl.localhost\<distro>\home\me\proj` is self-describing, but a project
 * chosen under `/mnt/<drive>/...` is registered as the real Windows drive path (`D:\proj`)
 * because the WSL 9P share refuses those directories. The distro is then only remembered here:
 * `<DSH_HOME>/dsh-remote-wsl.json`:
 *
 *   { "version": 1,
 *     "workspaces": { "<lowercased host path key>": {
 *         "distro": "Ubuntu", "linuxPath": "/mnt/d/proj",
 *         "hostPath": "D:\\proj", "mapped": "windows", "updatedAt": 1234567890 } } }
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  drivePathToLinux,
  hostPathKey,
  isPathInsideHost,
  isWindowsDrivePath,
  joinLinux,
  linuxToHostPath,
  normalizeLinuxPath,
  parseWslHostPath,
} from './wsl-path.js'

const FILE_NAME = 'dsh-remote-wsl.json'
const FILE_VERSION = 1

export function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return path.join(os.homedir(), '.dsh')
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Create the mapping store. `config` is the resolved plugin config; `service` is the WSL service.
 */
export function createWorkspaceMappingStore(config) {
  const filePath = path.join(resolveDshHome(), FILE_NAME)
  let loaded = false
  let state = { version: FILE_VERSION, workspaces: {} }
  let writeQueue = Promise.resolve()

  async function load() {
    if (loaded) return state
    loaded = true
    try {
      const text = await fsp.readFile(filePath, 'utf8')
      const parsed = JSON.parse(text)
      if (isPlainObject(parsed) && isPlainObject(parsed.workspaces)) {
        state = { version: FILE_VERSION, workspaces: { ...parsed.workspaces } }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Corrupt file: keep the in-memory empty state, rewrite on the next mutation.
        console.warn(`[dsh-remote-wsl] 无法读取 ${filePath}：${error?.message ?? error}`)
      }
      state = { version: FILE_VERSION, workspaces: {} }
    }
    return state
  }

  function persist() {
    const snapshot = { version: FILE_VERSION, workspaces: { ...state.workspaces } }
    const write = async () => {
      const directory = path.dirname(filePath)
      await fsp.mkdir(directory, { recursive: true })
      const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
      await fsp.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      await fsp.rename(temporary, filePath)
    }
    writeQueue = writeQueue.then(write, write)
    return writeQueue
  }

  async function remember(entry) {
    await load()
    const hostPath = String(entry.hostPath ?? '')
    const distro = String(entry.distro ?? '').trim()
    const linuxPath = normalizeLinuxPath(String(entry.linuxPath ?? '/'))
    if (hostPath.length === 0 || distro.length === 0) return
    state.workspaces[hostPathKey(hostPath)] = {
      distro,
      linuxPath,
      hostPath,
      mapped: entry.mapped === 'windows' ? 'windows' : 'unc',
      updatedAt: Date.now(),
    }
    await persist()
  }

  async function forget(hostPath) {
    await load()
    const key = hostPathKey(hostPath)
    if (state.workspaces[key] === undefined) return
    delete state.workspaces[key]
    await persist()
  }

  async function list() {
    await load()
    return Object.values(state.workspaces)
  }

  /**
   * Resolve a session cwd / model path to its WSL origin.
   * Accepts UNC spellings directly; drive paths only when a mapping was recorded.
   */
  async function resolveCwd(cwd) {
    const value = String(cwd ?? '').trim()
    if (value.length === 0) return undefined
    const parsed = parseWslHostPath(value)
    if (parsed !== undefined) {
      return {
        distro: parsed.distro,
        linuxPath: parsed.linuxPath,
        hostPath: value,
        rootHostPath: value,
        mapped: 'unc',
        source: 'unc',
      }
    }
    await load()
    const key = hostPathKey(value)
    const direct = state.workspaces[key]
    if (direct !== undefined) return { ...direct, rootHostPath: direct.hostPath, source: 'mapping' }
    // A subdirectory of a recorded workspace (e.g. the session cd'd deeper on the Windows side).
    for (const entry of Object.values(state.workspaces)) {
      if (entry.mapped === 'windows' && isPathInsideHost(entry.hostPath, value)) {
        const relative = value.slice(entry.hostPath.length).replace(/^[\\/]+/u, '')
        const linuxPath = normalizeLinuxPath(
          joinLinux(drivePathToLinux(entry.hostPath, { mountRoot: config.mountRoot || '/mnt' })?.linuxPath ?? entry.linuxPath, relative.replaceAll('\\', '/')),
        )
        return { ...entry, linuxPath, rootHostPath: entry.hostPath, source: 'mapping-child' }
      }
    }
    return undefined
  }

  /**
   * Translate one path as the model wrote it (Linux absolute, `~`, Windows absolute, or relative)
   * into Linux and host spellings for a resolved WSL origin.
   */
  async function resolveModelPath(origin, inputPath, options = {}) {
    const raw = String(inputPath ?? '').trim()
    const home = typeof options.home === 'string' && options.home.length > 0 ? options.home : '/'
    let linuxPath
    if (raw.length === 0 || raw === '.') {
      linuxPath = origin.linuxPath
    } else if (raw === '~' || raw.startsWith('~/')) {
      linuxPath = normalizeLinuxPath(joinLinux(home, raw.slice(1).replace(/^\//u, '')))
    } else if (/^[\\/]{2}/u.test(raw)) {
      const parsed = parseWslHostPath(raw)
      if (parsed === undefined) throw Object.assign(new Error(`不支持的 UNC 路径：${raw}`), { code: 'invalid-path' })
      if (parsed.distro.toLowerCase() !== origin.distro.toLowerCase()) {
        throw Object.assign(new Error(`路径属于其它 WSL 发行版：${parsed.distro}`), { code: 'invalid-path' })
      }
      linuxPath = parsed.linuxPath
    } else if (raw.startsWith('/')) {
      linuxPath = normalizeLinuxPath(raw)
    } else if (isWindowsDrivePath(raw)) {
      const mapped = drivePathToLinux(raw, { mountRoot: options.mountRoot || '/mnt' })
      if (mapped === undefined) throw Object.assign(new Error(`不支持的 Windows 路径：${raw}`), { code: 'invalid-path' })
      linuxPath = mapped.linuxPath
    } else {
      linuxPath = normalizeLinuxPath(joinLinux(origin.linuxPath, raw.replaceAll('\\', '/')))
    }
    const options2 = options.mountRoot !== undefined ? { mountRoot: options.mountRoot } : {}
    const mapped = linuxToHostPath(linuxPath, origin.distro, options2)
    return { linuxPath, hostPath: mapped.hostPath, mapped: mapped.mapped }
  }

  return { filePath, load, remember, forget, list, resolveCwd, resolveModelPath }
}
