/** Narrow contracts for the installed Desktop modules used by the integration fixtures. */
import type { Agent, HostPort, Message, ToolDefinition } from '../dist/contracts.js'
import { isRecord } from '../dist/contracts.js'
import type { LegacyPersistence } from '../dist/lib/legacy-inbox.js'

interface Disposable { dispose(): Promise<void> }
export interface DesktopSession {
  header: { id: string; cwd: string; [key: string]: unknown }
  snapshotEvents(): DesktopEvent[]
}
export type DesktopEvent =
  | { type: 'tool/result'; seq: number; data: { message: { isError: boolean; content: unknown }; meta: { path: string; diffs: unknown[] } } }
  | { type: 'turn/end'; seq: number; data: { reason: { kind: string } } }
  | { type: 'agent/inbox/spliced'; seq: number; data: { removedCount: number; inserted: Message[] } }
  | { type: 'workspace/changes'; seq: number; data: unknown }
  | { type: 'deliverables/presented'; seq: number; data: { files: { path: string; description: string }[] } }
export interface DesktopAgent extends Agent {
  inbox: { nextStep: Message[]; nextTurn: Message[]; splice(target: 'next-step' | 'next-turn', index: number, count: number, inserted: Message[]): void }
  session: DesktopSession
  followup(message: unknown): void
  whenIdle(): Promise<void>
}
export interface DesktopPersistence extends LegacyPersistence {
  create(header: DesktopSession['header']): Promise<{ flush(): Promise<void>; close(): Promise<void> }>
  stat(id: string): Promise<{ location?: { path?: string } }>
  open(id: string, mode: 'read'): Promise<{ read(): Promise<{ events: DesktopEvent[] }>; close(): Promise<void> }>
}
export interface DesktopContext extends HostPort {
  plugin(plugin: unknown, config?: unknown): Promise<Disposable>
  provide(name: string, service: unknown): void
  fiber: Disposable
  tools: { get(name: string, agent?: Agent): ToolDefinition | undefined; register(definition: ToolDefinition): () => void }
  llm: { registerAdapter(names: string[], adapter: unknown): void }
  agents: { create(options: { sessionId: string; agentOptions: { provider: string; model: string }; meta: { cwd: string }; setup(scope: DesktopContext, agent: DesktopAgent): void; seed?: unknown[] }): Promise<{ agent: DesktopAgent; dispose(): Promise<void> }> }
  agentLoop: { create(id: string, options: { provider: string; model: string }, meta: { cwd: string }): Promise<DesktopAgent> }
  workspaceChanges: {
    summary(id: string, seq: number): { total: number; files: { path: string }[] }
    diff(id: string, seq: number, index: number, signal: AbortSignal): Promise<{ kind: string; hunks: unknown }>
  }
  sessionPersistence: DesktopPersistence
}
export interface ContextModule { Context: new () => DesktopContext }
export interface LlmModule {
  default: unknown
  LlmAdapter: new () => object
  createUserMessage(message: { content: { type: 'text'; text: string }[]; source: { kind: string } }): unknown
}
export interface ScopeModule {
  createScope(ctx: DesktopContext, key: object): { ctx: DesktopContext }
  bindScopeParent(agent: DesktopAgent, key: object): void
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('Expected Desktop module')
  return value
}
function isContextModule(value: unknown): value is ContextModule {
  return isRecord(value) && typeof value.Context === 'function'
}
export function contextModule(value: unknown): ContextModule {
  if (!isContextModule(value)) throw new TypeError('Desktop Context constructor missing')
  return value
}
function isLlmModule(value: unknown): value is LlmModule {
  return isRecord(value) && typeof value.LlmAdapter === 'function'
    && typeof value.createUserMessage === 'function' && value.default !== undefined
}
export function llmModule(value: unknown): LlmModule {
  if (!isLlmModule(value)) throw new TypeError('Desktop LLM exports missing')
  return value
}
function isScopeModule(value: unknown): value is ScopeModule {
  return isRecord(value) && typeof value.createScope === 'function' && typeof value.bindScopeParent === 'function'
}
export function scopeModule(value: unknown): ScopeModule {
  if (!isScopeModule(value)) throw new TypeError('Desktop scope exports missing')
  return value
}
export function defaultPlugin(value: unknown): unknown { return record(value).default ?? value }
