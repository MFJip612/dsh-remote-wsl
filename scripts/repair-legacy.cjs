/** Explicit one-time recovery. Run through Desktop's ELECTRON_RUN_AS_NODE mode.
 * Default: report only. --apply: kernel write lease, immutable backup, atomic repair,
 * and validation through the installed DSH JSONL reader. Live sessions are refused.
 */
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  const rootArg = process.argv.find(arg => arg.startsWith('--root='))?.slice('--root='.length)
  const root = rootArg === undefined ? path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions') : path.resolve(rootArg)
  const packages = path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai')
  const { Context } = await import(pathToFileURL(path.join(packages, 'cordis/lib/index.js')).href)
  const Persistence = await import(pathToFileURL(path.join(packages, 'dsh-session-persistence-jsonl/lib/index.js')).href)
  const { repairLegacyInboxFile } = await import('../lib/legacy-inbox.js')
  const ctx = new Context()
  let repaired = 0
  try {
    await ctx.plugin(Persistence, { root, compression: 'zstd' })
    console.log(`Session root: ${root}`)
    for (const project of await fs.readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      // This plugin's affected Linux projects use these sanitized UNC directory names.
      // Mounted Windows-drive projects can be selected explicitly with --project=<name>.
      const explicit = process.argv.find(arg => arg.startsWith('--project='))?.slice('--project='.length)
      if (explicit === undefined ? !/^--wsl(?:\.localhost|\$)-/iu.test(project.name) : project.name !== explicit) continue
      const directory = path.join(root, project.name)
      for (const session of await fs.readdir(directory, { withFileTypes: true })) {
        if (!session.isDirectory()) continue
        const file = path.join(directory, session.name, 'session.v4.jsonl.zstd')
        try { await fs.access(file) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
        const result = await repairLegacyInboxFile(file, ctx.sessionPersistence, { apply: process.argv.includes('--apply') })
        if (result.repaired > 0) { repaired += 1; console.log(JSON.stringify(result)) }
      }
    }
    console.log(`Affected sessions: ${repaired}; mode: ${process.argv.includes('--apply') ? 'apply' : 'dry-run'}`)
  } finally { await ctx.fiber.dispose() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
