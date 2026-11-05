/** Resolved settings retain the plugin's original forgiving normalization. */
export interface WslConfig {
  terminal: boolean; tools: boolean; distroCacheMs: number; execTimeoutMs: number
  maxEntries: number; maxReadBytes: number; defaultDistro: string; mountRoot: string; remote: boolean
}
export type Config = WslConfig
export const DEFAULTS: Readonly<WslConfig> = Object.freeze({
  terminal: true, tools: true, distroCacheMs: 5000, execTimeoutMs: 15000,
  maxEntries: 2000, maxReadBytes: 2000000, defaultDistro: '', mountRoot: '', remote: false,
})
export function resolveConfig(raw: unknown): WslConfig {
  const config = { ...DEFAULTS }
  if (typeof raw !== 'object' || raw === null) return config
  for (const key of ['terminal', 'tools', 'remote'] as const) {
    if (key in raw) { const value: unknown = Reflect.get(raw, key); if (value !== undefined) config[key] = value === true }
  }
  for (const key of ['distroCacheMs', 'execTimeoutMs', 'maxEntries', 'maxReadBytes'] as const) {
    if (key in raw) {
      const value: unknown = Reflect.get(raw, key)
      if (value !== undefined) { const numeric = Number(value); if (Number.isFinite(numeric) && numeric > 0) config[key] = numeric }
    }
  }
  for (const key of ['defaultDistro', 'mountRoot'] as const) {
    if (key in raw) { const value: unknown = Reflect.get(raw, key); if (typeof value === 'string') config[key] = value }
  }
  return config
}
/** Standard Schema v1, accepted by Cordis without adding a runtime schema dependency. */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-remote-wsl',
    validate(value: unknown): { value: WslConfig } { return { value: resolveConfig(value) } },
  },
}
