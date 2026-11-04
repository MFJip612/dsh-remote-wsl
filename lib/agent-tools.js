/**
 * Per-agent WSL tool set.
 *
 * For an agent whose session cwd resolves to a WSL workspace we register, inside that agent's
 * scope only:
 *  - a Linux `bash` tool (the Windows shell tool is hidden),
 *  - Linux-side `read` / `write` / `edit` / `glob` / `grep` shadows of the shipped tool names,
 *  - a short session note explaining that paths are Linux paths.
 *
 * Scoped registrations shadow globals for that agent only; every other session keeps the
 * shipped tools untouched. The individual tool implementations live in `tool-defs.js` /
 * `tool-wsl.js`.
 */
import { randomUUID } from 'node:crypto'
import { createWslToolDefinitions } from './tool-defs.js'
import { createFileIntegration } from './file-integration.js'

const pathsNote = (distro, linuxPath) =>
  `本会话的目录在 WSL 发行版 ${distro} 内：${linuxPath}。shell 是 Linux bash，路径请使用 Linux 形式；` +
  `Windows 盘在 /mnt/<盘符>。请用 bash 工具执行命令，不要使用 PowerShell。`

function installPathsNote(agent, origin) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: pathsNote(origin.distro, origin.linuxPath) }],
    source: { kind: 'plugin:dsh-remote-wsl' },
  }
  let installed = false
  // 0.1.0 把裸字符串持久化进 inbox，导致客户端投影和首轮请求无法读取消息字段。
  // 通过官方 splice 追加修复事件，保留历史及其它待处理输入，不改写会话文件。
  if (agent.inbox !== undefined) {
    for (const [target, entries] of [['next-step', agent.inbox.nextStep], ['next-turn', agent.inbox.nextTurn]]) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]
        if (typeof entry === 'string' && entry.startsWith('本会话的目录在 WSL 发行版 ')
          && entry.endsWith('请用 bash 工具执行命令，不要使用 PowerShell。')) {
          agent.inbox.splice(target, index, 1, installed ? [] : [message])
          installed = true
        } else if (entry?.source?.kind === 'plugin:dsh-remote-wsl') {
          installed = true
        }
      }
    }
  }
  if (!installed) agent.inject(message)
}

function scopeToolLookup(scope, agent) {
  return (name) => {
    try {
      // 预设中的文件工具属于父作用域，省略 agent 只会查询全局工具，无法遮蔽它们。
      return scope.tools?.get?.(name, agent) !== undefined
    } catch {
      return false
    }
  }
}

/** A value is usable as the agent scope when it can own effects and registrations. */
function looksLikeScope(candidate) {
  return (
    candidate !== undefined &&
    candidate !== null &&
    typeof candidate === 'object' &&
    typeof candidate.effect === 'function' &&
    candidate.tools !== undefined &&
    candidate.tools !== null
  )
}

export function registerAgentTools(ctx, { service, mappings, config }) {
  const sessions = ctx.sessions
  const workingDirectory = ctx.workingDirectory
  const sandboxPolicy = ctx.get?.('sandboxPolicy')
  const seenAgents = new WeakSet()

  const off = ctx.on('agent/created', async function onAgentCreated({ agent }) {
    try {
      if (seenAgents.has(agent)) return
      seenAgents.add(agent)
      const session = sessions.get(agent.id)
      if (session === undefined) return
      const cwd = workingDirectory.get(session)
      const origin = await mappings.resolveCwd(cwd)
      if (origin === undefined) return
      // Prefer the agent's own scoped context (documented as `agent.ctx`); the listener
      // receiver is a second accepted source. Never fall back to the plugin context, because a
      // global registration would leak the WSL tools to every session.
      const scope = looksLikeScope(agent?.ctx) ? agent.ctx : looksLikeScope(this) ? this : undefined
      if (scope === undefined) {
        console.warn('[dsh-remote-wsl] 无法取得 agent 作用域，跳过 WSL 工具注册')
        return
      }
      const hasTool = scopeToolLookup(scope, agent)
      const getTool = name => scope.tools.get(name, agent)
      const identity = await service.resolveIdentity(origin.distro).catch(() => null)
      const definitions = createWslToolDefinitions({
        service,
        mappings,
        config,
        origin,
        home: identity?.home ?? '/',
        session,
        sandboxPolicy,
        hasTool,
        getTool,
        fileIntegration: ctx.get?.('fs') === undefined ? undefined : createFileIntegration(scope, ctx.get('fs')),
      })
      if (definitions.deny.length > 0 && typeof scope.tools?.restrict === 'function') {
        scope.effect(
          () => scope.tools.restrict({ deny: definitions.deny }),
          'dsh-remote-wsl: hide Windows shell',
        )
      }
      for (const definition of definitions.tools) {
        scope.effect(
          () => scope.tools.register(definition),
          `dsh-remote-wsl: tool ${definition.name}`,
        )
      }
      if (typeof agent.inject === 'function') {
        installPathsNote(agent, origin)
      }
    } catch (error) {
      console.warn(`[dsh-remote-wsl] 为会话注册 WSL 工具失败：${error?.message ?? error}`)
    }
  })
  return off
}
