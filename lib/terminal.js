/**
 * Sidebar/agent terminal routing for WSL workspaces.
 *
 * The sidebar terminal is created by the terminal controller through
 * `subprocess.spawnTerminal({ argv, cwd })`. When `cwd` resolves to a WSL workspace we replace
 * the allocation with `wsl.exe -d <distro> --cd <linuxPath>` (the distribution's login shell),
 * keeping every other field untouched. Non-WSL cwds pass through byte-for-byte.
 *
 * The wrapper is installed on the live service instance and restored by its disposer; if the
 * method disappears on a future DSH version the plugin logs once and keeps the native terminal.
 */
import { windowsSystemDirectory } from './wsl-service.js'

export function registerTerminalRouting(ctx, { service, mappings, config }) {
  const subprocess = ctx.subprocess
  if (subprocess === undefined || typeof subprocess.spawnTerminal !== 'function') {
    console.warn('[dsh-remote-wsl] subprocess.spawnTerminal 不可用，终端保持原生行为')
    return () => {}
  }
  const original = subprocess.spawnTerminal
  let warned = false

  const wrapped = async function spawnTerminalWithWsl(spec, ...rest) {
    try {
      const cwd = typeof spec?.cwd === 'string' ? spec.cwd : ''
      const origin = cwd.length > 0 ? await mappings.resolveCwd(cwd) : undefined
      if (origin !== undefined) {
        const executable = await service.resolveWslExecutable()
        const argv = [executable, '-d', origin.distro, '--cd', origin.linuxPath]
        const nextSpec = {
          ...spec,
          argv,
          cwd: windowsSystemDirectory(),
        }
        return await original.call(this, nextSpec, ...rest)
      }
    } catch (error) {
      if (!warned) {
        warned = true
        console.warn(`[dsh-remote-wsl] 终端路由失败，本次回退原生终端：${error?.message ?? error}`)
      }
    }
    return await original.call(this, spec, ...rest)
  }

  subprocess.spawnTerminal = wrapped
  return () => {
    if (subprocess.spawnTerminal === wrapped) subprocess.spawnTerminal = original
  }
}
