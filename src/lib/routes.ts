import type { IncomingMessage, ServerResponse } from 'node:http'
import { errorCode, errorMessage } from '../contracts.js'
import type { HostPort, PluginRuntime } from '../contracts.js'
/**
 * HTTP routes consumed by the browser half.
 *
 * Every route is same-origin JSON, gated by `ctx.connection.requestRejection` (Host/Origin and
 * cookie trust enforced by the Harness carrier) and, unless `config.remote` is true, by a
 * loopback check so a LAN-exposed Web server cannot browse or register WSL directories.
 */
import { promises as fsp } from 'node:fs'

import { codedError } from './wsl-service.js'

const PREFIX = '/dsh-remote-wsl'
const MAX_BODY_BYTES = 64 * 1024

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sendError(res: ServerResponse, error: unknown) {
  const code = typeof errorCode(error) === 'string' ? String(errorCode(error)) : 'internal-error'
  const status =
    code === 'invalid-request'
      ? 400
      : code === 'distro-not-found'
        ? 404
        : code === 'directory-unreadable'
          ? 404
          : code === 'workspace-create-failed'
            ? 409
            : code === 'wsl-unavailable' || code === 'wsl-timeout'
              ? 503
              : 500
  sendJson(res, status, { error: { code, message: error instanceof Error ? error.message : String(error) } })
}

function isLoopbackAddress(address: unknown) {
  const value = String(address ?? '')
  return (
    value === '127.0.0.1' ||
    value === '::1' ||
    value === '::ffff:127.0.0.1' ||
    value.startsWith('127.')
  )
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      req.resume()
      throw codedError('invalid-request', `请求体超过 ${MAX_BODY_BYTES} 字节`)
    }
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks, size).toString('utf8')
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('body is not an object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw codedError('invalid-request', '请求体不是合法 JSON 对象')
  }
}

function urlOf(req: IncomingMessage) {
  return new URL(String(req.url ?? PREFIX), 'http://localhost')
}

function requireString(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw codedError('invalid-request', `缺少字段 ${field}`)
  }
  return value
}

/**
 * Register the `/dsh-remote-wsl` prefix route. Returns the disposer via `ctx.effect`.
 */
export function registerRoutes(ctx: Pick<HostPort, 'connection' | 'webServer' | 'get'>, { service, mappings, config }: PluginRuntime) {
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (config.remote !== true && !isLoopbackAddress(req.socket?.remoteAddress)) {
        sendJson(res, 403, { error: { code: 'remote-not-allowed', message: '远程访问未启用（config.remote=false）' } })
        return
      }
      const url = urlOf(req)
      const route = url.pathname
      if (req.method === 'GET' && route === `${PREFIX}/status`) {
        const listed = await service.listDistros()
        sendJson(res, 200, {
          available: listed.available === true,
          platform: listed.platform ?? process.platform,
          defaultDistro: listed.defaultDistro ?? undefined,
          error: listed.error,
        })
        return
      }
      if (req.method === 'GET' && route === `${PREFIX}/distros`) {
        const listed = await service.listDistros({ refresh: url.searchParams.get('refresh') === '1' })
        sendJson(res, 200, listed)
        return
      }
      if (req.method === 'GET' && route === `${PREFIX}/warm`) {
        const distro = requireString(url.searchParams.get('distro'), 'distro')
        service.warm(distro).catch(() => undefined)
        sendJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && route === `${PREFIX}/list`) {
        const distro = requireString(url.searchParams.get('distro'), 'distro')
        const requestedPath = url.searchParams.get('path') ?? undefined
        const hidden = url.searchParams.get('hidden') === '1'
        const listing = await service.listPath(distro, requestedPath, { hidden })
        sendJson(res, 200, listing)
        return
      }
      if (req.method === 'POST' && route === `${PREFIX}/connect`) {
        const body = await readJsonBody(req)
        const distro = requireString(body.distro, 'distro')
        const linuxPathInput = requireString(body.linuxPath, 'linuxPath')
        const entry = await service.requireDistro(distro)
        if (entry.wsl1 === true) {
          throw codedError('wsl1-unsupported', '该发行版是 WSL 1，无法通过共享路径访问；请升级到 WSL 2')
        }
        const linuxPath = await service.resolveLinuxPath(entry.name, linuxPathInput)
        if (!(await service.directoryExists(entry.name, linuxPath))) {
          throw codedError('directory-unreadable', `文件夹不存在：${linuxPath}`)
        }
        const mapped = await service.toHostPath(entry.name, linuxPath)
        // Canonicalize now so the mapping key matches what the workspace registry stores.
        // (workspaceRegistry.create performs the same realpath; here it gives a better error.)
        let canonicalHostPath = mapped.hostPath
        try {
          canonicalHostPath = await fsp.realpath(mapped.hostPath)
        } catch (error) {
          throw codedError('directory-unreadable', `无法访问该文件夹：${errorMessage(error)}`)
        }
        const registry = ctx.get('workspaceRegistry')
        if (registry === undefined) {
          throw codedError('workspace-create-failed', '工作区服务不可用')
        }
        let workspace
        try {
          workspace = await registry.create(canonicalHostPath)
        } catch (error) {
          throw codedError('workspace-create-failed', `注册工作区失败：${errorMessage(error)}`)
        }
        await mappings.remember({
          distro: entry.name,
          linuxPath,
          hostPath: workspace.path,
          mapped: mapped.mapped,
        })
        sendJson(res, 200, {
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          title: workspace.title,
          linuxPath,
          mapped: mapped.mapped,
        })
        return
      }
      sendJson(res, 404, { error: { code: 'not-found', message: `未知路由：${req.method} ${route}` } })
    } catch (error) {
      sendError(res, error)
    }
  }
  return ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler })
}
