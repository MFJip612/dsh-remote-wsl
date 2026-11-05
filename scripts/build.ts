import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const compiler = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const check = process.argv.includes('--check')
for (const target of ['host', 'client', 'cjs']) {
  const result = spawnSync(process.execPath, [compiler, '-p', `tsconfig.${target}.json`], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (check) {
  const result = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.test.json'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
