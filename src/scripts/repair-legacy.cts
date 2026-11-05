/** Explicit recovery CLI. Source of dist/scripts/repair-legacy.cjs; default is dry-run.
 * Run through the installed Desktop's ELECTRON_RUN_AS_NODE mode for ASAR access.
 */
import fs = require('node:fs/promises')
import os = require('node:os')
import path = require('node:path')
import url = require('node:url')

interface WriteLease { release(): void | Promise<void> }
interface ReadHandle { read(): Promise<unknown>; close(): void | Promise<void> }
interface PersistencePort {
  acquireWriteLease(header: unknown): Promise<WriteLease>
  open(id: string, mode: 'read'): Promise<ReadHandle>
}
interface RecoveryContext {
  plugin(plugin: unknown, config: { root: string; compression: 'zstd' }): unknown
  get(name: string): unknown
  fiber: { dispose(): void | Promise<void> }
}
interface RecoveryResult { id: string; repaired: number; applied: boolean; backupPath?: string }
interface RecoveryModule {
  repairLegacyInboxFile(file: string, persistence: PersistencePort, options: { apply: boolean }): Promise<RecoveryResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function isContext(value: unknown): value is RecoveryContext {
  return isRecord(value) && typeof value.plugin === 'function' && typeof value.get === 'function'
    && isRecord(value.fiber) && typeof value.fiber.dispose === 'function'
}
function isPersistence(value: unknown): value is PersistencePort {
  return isRecord(value) && typeof value.acquireWriteLease === 'function' && typeof value.open === 'function'
}
function isRecoveryModule(value: unknown): value is RecoveryModule {
  return isRecord(value) && typeof value.repairLegacyInboxFile === 'function'
}

async function main(): Promise<void> {
  const rootArg = process.argv.find(arg => arg.startsWith('--root='))?.slice('--root='.length)
  const root = rootArg === undefined
    ? path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
    : path.resolve(rootArg)
  const packages = path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai')
  const cordis: unknown = await import(url.pathToFileURL(path.join(packages, 'cordis/lib/index.js')).href)
  if (!isRecord(cordis) || typeof cordis.Context !== 'function') throw new Error('Installed Desktop Cordis is unavailable')
  const candidate: unknown = Reflect.construct(cordis.Context, [])
  if (!isContext(candidate)) throw new Error('Installed Desktop Context has an unsupported API')
  const ctx = candidate
  const persistencePlugin: unknown = await import(url.pathToFileURL(path.join(packages, 'dsh-session-persistence-jsonl/lib/index.js')).href)
  // Kept dynamic so the standalone CJS compiler does not emit the Host sources again.
  const recoveryPath = '../lib/legacy-inbox.js'
  const recovery: unknown = await import(recoveryPath)
  if (!isRecoveryModule(recovery)) throw new Error('WSL recovery module is unavailable')
  let repaired = 0
  try {
    await ctx.plugin(persistencePlugin, { root, compression: 'zstd' })
    const persistence = ctx.get('sessionPersistence')
    if (!isPersistence(persistence)) throw new Error('Installed Desktop persistence API does not support safe recovery')
    console.log(`Session root: ${root}`)
    const explicit = process.argv.find(arg => arg.startsWith('--project='))?.slice('--project='.length)
    for (const project of await fs.readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      if (explicit === undefined ? !/^--wsl(?:\.localhost|\$)-/iu.test(project.name) : project.name !== explicit) continue
      const directory = path.join(root, project.name)
      for (const session of await fs.readdir(directory, { withFileTypes: true })) {
        if (!session.isDirectory()) continue
        const file = path.join(directory, session.name, 'session.v4.jsonl.zstd')
        try {
          await fs.access(file)
        } catch (error) {
          if (isRecord(error) && error.code === 'ENOENT') continue
          throw error
        }
        const result = await recovery.repairLegacyInboxFile(file, persistence, { apply: process.argv.includes('--apply') })
        if (result.repaired > 0) {
          repaired += 1
          console.log(JSON.stringify(result))
        }
      }
    }
    console.log(`Affected sessions: ${repaired}; mode: ${process.argv.includes('--apply') ? 'apply' : 'dry-run'}`)
  } finally {
    await ctx.fiber.dispose()
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
