/**
 * dsh-remote-wsl — Host half.
 *
 * Adds a "连接 WSL" entry to the add-workspace flow (Browser half), registers the picked
 * Linux folder as a DSH workspace, and routes the sidebar terminal plus the agent file tools
 * of that workspace through `wsl.exe` inside the distribution.
 *
 * Everything is effect-owned: unloading the plugin removes the routes, the subprocess wrapper
 * and every per-agent registration.
 */
import { registerAgentTools } from './lib/agent-tools.js'
import { registerRoutes } from './lib/routes.js'
import { registerTerminalRouting } from './lib/terminal.js'
import { createWslService } from './lib/wsl-service.js'
import { createWorkspaceMappingStore } from './lib/wsl-workspaces.js'

export const name = 'dsh-remote-wsl'

/** Required Host services; optional collaborators are resolved with ctx.inject/ctx.get below. */
export const inject = ['webServer', 'connection', 'subprocess']

const DEFAULTS = Object.freeze({
  /** Route the sidebar terminal of a WSL workspace into the distribution. */
  terminal: true,
  /** Give sessions of a WSL workspace Linux-side bash/read/write/edit/glob/grep tools. */
  tools: true,
  /** Distribution discovery cache lifetime (ms). */
  distroCacheMs: 5000,
  /** Per-wsl.exe-call deadline (ms). */
  execTimeoutMs: 15000,
  /** Maximum directory entries returned to the picker. */
  maxEntries: 2000,
  /** Maximum bytes a single read tool call returns. */
  maxReadBytes: 2000000,
  /** Preferred distribution when the caller does not pick one ('' = WSL default). */
  defaultDistro: '',
  /** Automount root inside the distribution ('' = read /etc/wsl.conf, fallback /mnt). */
  mountRoot: '',
  /** Allow non-loopback clients to call the plugin routes (default: loopback only). */
  remote: false,
})

function resolveConfig(raw) {
  const config = { ...DEFAULTS }
  if (typeof raw !== 'object' || raw === null) return config
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof DEFAULTS[key] === 'boolean') {
      config[key] = value === true
    } else if (typeof DEFAULTS[key] === 'number') {
      const numeric = Number(value)
      if (Number.isFinite(numeric) && numeric > 0) config[key] = numeric
    } else if (typeof value === 'string') {
      config[key] = value
    }
  }
  return config
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const service = createWslService(ctx, config)
  const mappings = createWorkspaceMappingStore(config)

  ctx.effect(() => registerRoutes(ctx, { service, mappings, config }), 'dsh-remote-wsl: web routes')

  // Terminal routing owns only the terminal allocation call; a profile without it still keeps
  // the connection flow working.
  ctx.inject(['subprocess'], (inner) => {
    if (config.terminal !== true) return
    inner.effect(
      () => registerTerminalRouting(inner, { service, mappings, config }),
      'dsh-remote-wsl: terminal routing',
    )
  })

  // Agent tools are registered per agent scope, only for sessions whose cwd is a WSL workspace.
  ctx.inject(['tools', 'sessions', 'workingDirectory'], (inner) => {
    if (config.tools !== true) return
    inner.effect(
      () => registerAgentTools(inner, { service, mappings, config }),
      'dsh-remote-wsl: agent tools',
    )
  })
}
