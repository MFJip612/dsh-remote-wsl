import type { Context } from '@deepseek-ai/cordis'
import { hostPort } from './contracts.js'
import { resolveConfig } from './config.js'
export { Config } from './config.js'
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

export function apply(context: Context, rawConfig: unknown) {
  const ctx = hostPort(context)
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
