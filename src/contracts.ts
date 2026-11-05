/** Narrow ports for the Host capabilities this plugin consumes. External JSON stays unknown. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WslConfig } from './config.js'
import type { createWslService } from './lib/wsl-service.js'
import type { createWorkspaceMappingStore } from './lib/wsl-workspaces.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function errorCode(error: unknown): unknown { return isRecord(error) ? error.code : undefined }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
export function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {} }

export type Disposer = () => void
export interface Distro { name: string; isDefault: boolean; state: string; version: 1 | 2 | null }
export interface HostPath { linuxPath: string; hostPath: string; mapped: 'windows' | 'unc' }
export interface Mapping extends HostPath { distro: string; updatedAt?: number }
export type WslOrigin = Mapping & { rootHostPath: string } & (
  { source: 'unc'; mapped: 'unc' } | { source: 'mapping' | 'mapping-child' }
)
export interface Identity { distro: string; user: string; home: string; source: 'probe' | 'etc'; reportedDistro: string }
export interface RunOptions { timeoutMs?: number; stdoutMaxBytes?: number; stderrMaxBytes?: number; stdin?: string | Uint8Array; signal?: AbortSignal }
export interface ProcessOutcome { exitCode: number | null; signal?: string | null }
export interface ProcessHandle { stdout?: AsyncIterable<Uint8Array | string> | null; stderr?: AsyncIterable<Uint8Array | string> | null; done: Promise<ProcessOutcome> }
export interface SpawnSpec { argv: string[]; cwd: string; graceMs: number; signal: AbortSignal; stdio: { stdin: 'ignore' | { data: string | Uint8Array }; stdout: 'pipe'; stderr: 'pipe' } }
export interface TerminalSpec { cwd?: string; argv?: string[]; [key: string]: unknown }
export interface SubprocessPort {
  resolveExecutable(name: string): Promise<string>
  spawn(spec: SpawnSpec): ProcessHandle
  spawnTerminal?: (this: SubprocessPort, spec: TerminalSpec, ...rest: unknown[]) => Promise<unknown>
}
export type WslService = ReturnType<typeof createWslService>
export type MappingStore = ReturnType<typeof createWorkspaceMappingStore>
export interface PluginRuntime { service: WslService; mappings: MappingStore; config: WslConfig }

/** Execution identity is passed through intact to official filesystem hooks and native tools. */
export interface Execution { readonly signal?: AbortSignal; readonly [key: string]: unknown }
export interface Session { readonly id?: string; readonly [key: string]: unknown }
export interface SandboxPolicyPort { resolve(input: { session: Session }): { mode?: string; workspaceRoot?: string } | undefined }
export interface FileTarget { readonly [key: string]: unknown }
export interface FileStat { version: unknown }
export interface FileIntent { kind: string; version?: unknown }
export interface FileSystemPort {
  resolve(path: string, options: { signal?: AbortSignal }): Promise<FileTarget>
  stat(target: FileTarget, signal?: AbortSignal): Promise<FileStat | undefined>
}
export interface FileIntegration {
  prepare(kind: 'write' | 'edit', paths: HostPath, exec?: Execution): Promise<() => Promise<void>>
  observed(paths: HostPath, exec?: Execution): Promise<void>
}
export interface ToolOutput { schema: unknown; render(args: unknown, value: unknown): unknown; [key: string]: unknown }
export interface ToolDefinition {
  name: string; description: string; parameters: unknown; output: ToolOutput
  execute(args: unknown, exec?: Execution): Promise<unknown>
  presentCall?: (args: unknown) => unknown
  presentResult?: (...args: unknown[]) => unknown
}
export interface ToolsPort {
  get(name: string, agent: Agent): ToolDefinition | undefined
  register(definition: ToolDefinition): Disposer
  restrict?(spec: { deny: string[] }): Disposer
}
export interface Message { id: string; role: 'user'; content: { type: 'text'; text: string }[]; source: { kind: string } }
export interface Agent {
  id: string; ctx?: unknown
  inbox?: { nextStep: unknown[]; nextTurn: unknown[]; splice(target: 'next-step' | 'next-turn', index: number, count: number, inserted: Message[]): void }
  inject?(message: Message): void
}
export interface EffectPort { effect(callback: () => void | Disposer, label?: string): unknown }
export interface AgentScope extends EffectPort {
  tools: ToolsPort
}
export interface FileEventPort {
  waterfall(event: string, target: FileTarget, exec: Execution | undefined, fallback: () => undefined): Promise<FileIntent | undefined>
  emit(event: string, target: FileTarget, observation: { kind: 'absent' } | { kind: 'present'; version: unknown }, exec?: Execution): unknown
}
export function fileEventPort(value: unknown): FileEventPort {
  return requirePort(value, isFileEventPort, 'filesystem events')
}
function isFileEventPort(value: unknown): value is FileEventPort {
  return isRecord(value) && typeof value.waterfall === 'function' && typeof value.emit === 'function'
}
export interface HostServices {
  subprocess: SubprocessPort
  connection: { requestRejection(req: IncomingMessage): number | undefined }
  webServer: { register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): Disposer }
  sessions: { get(id: string): Session | undefined }
  workingDirectory: { get(session: Session): string }
}
interface OptionalServices {
  sandboxPolicy: SandboxPolicyPort
  fs: FileSystemPort
  workspaceRegistry: { create(path: string): Promise<{ id: string; path: string; title: string }> }
}
export interface HostPort extends HostServices, EffectPort {
  inject(dependencies: string[], callback: (inner: HostPort) => void): unknown
  get(name: 'sandboxPolicy'): SandboxPolicyPort | undefined
  get(name: 'fs'): FileSystemPort | undefined
  get(name: 'workspaceRegistry'): OptionalServices['workspaceRegistry'] | undefined
  on(event: 'agent/created', listener: (this: unknown, event: { agent: Agent }) => Promise<void>): Disposer
}
export interface ToolRuntimeInput extends PluginRuntime {
  origin: WslOrigin; home: string; session: Session; sandboxPolicy?: SandboxPolicyPort; fileIntegration?: FileIntegration
}
export interface ToolDefinitionsInput extends ToolRuntimeInput {
  hasTool(name: string): boolean
  getTool?(name: string): ToolDefinition | undefined
}

function requirePort<T>(value: unknown, accepts: (value: unknown) => value is T, name: string): T {
  if (!accepts(value)) throw new TypeError(`Invalid Host capability: ${name}`)
  return value
}
function subprocessPort(value: unknown): value is SubprocessPort {
  return isRecord(value) && typeof value.resolveExecutable === 'function' && typeof value.spawn === 'function'
    && (value.spawnTerminal === undefined || typeof value.spawnTerminal === 'function')
}
function connectionPort(value: unknown): value is HostServices['connection'] {
  return isRecord(value) && typeof value.requestRejection === 'function'
}
function webServerPort(value: unknown): value is HostServices['webServer'] {
  return isRecord(value) && typeof value.register === 'function'
}
function sessionsPort(value: unknown): value is HostServices['sessions'] {
  return isRecord(value) && typeof value.get === 'function'
}
function directoryPort(value: unknown): value is HostServices['workingDirectory'] {
  return isRecord(value) && typeof value.get === 'function'
}
function sandboxPort(value: unknown): value is SandboxPolicyPort {
  return isRecord(value) && typeof value.resolve === 'function'
}
function fsPort(value: unknown): value is FileSystemPort {
  return isRecord(value) && typeof value.resolve === 'function' && typeof value.stat === 'function'
}
function registryPort(value: unknown): value is OptionalServices['workspaceRegistry'] {
  return isRecord(value) && typeof value.create === 'function'
}
function isAgent(value: unknown): value is Agent {
  return isRecord(value) && typeof value.id === 'string'
    && (value.inject === undefined || typeof value.inject === 'function')
    && (value.inbox === undefined || (isRecord(value.inbox) && Array.isArray(value.inbox.nextStep)
      && Array.isArray(value.inbox.nextTurn) && typeof value.inbox.splice === 'function'))
}

/** Cordis owns every service instance. Each capability is checked where its scope consumes it. */
export function hostPort(context: Context): HostPort {
  function get(name: 'sandboxPolicy'): SandboxPolicyPort | undefined
  function get(name: 'fs'): FileSystemPort | undefined
  function get(name: 'workspaceRegistry'): OptionalServices['workspaceRegistry'] | undefined
  function get(name: keyof OptionalServices): OptionalServices[keyof OptionalServices] | undefined {
    const value: unknown = context.get(name)
    if (value === undefined) return undefined
    if (name === 'fs') return requirePort(value, fsPort, name)
    if (name === 'sandboxPolicy') return requirePort(value, sandboxPort, name)
    return requirePort(value, registryPort, name)
  }
  return {
    get subprocess() { return requirePort(context.get('subprocess'), subprocessPort, 'subprocess') },
    get connection() { return requirePort(context.get('connection'), connectionPort, 'connection') },
    get webServer() { return requirePort(context.get('webServer'), webServerPort, 'webServer') },
    get sessions() { return requirePort(context.get('sessions'), sessionsPort, 'sessions') },
    get workingDirectory() { return requirePort(context.get('workingDirectory'), directoryPort, 'workingDirectory') },
    effect(callback, label) { return context.effect(() => callback() ?? (() => {}), label) },
    inject(dependencies, callback) { return context.inject(dependencies, inner => callback(hostPort(inner))) },
    get,
    on(event, listener) {
      return context.events.on(event, function (this: unknown, payload: unknown) {
        if (!isRecord(payload) || !isAgent(payload.agent)) throw new TypeError('Invalid agent/created event')
        return listener.call(this, { agent: payload.agent })
      })
    },
  }
}
