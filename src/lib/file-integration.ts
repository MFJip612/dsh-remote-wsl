import type { FileEventPort, FileSystemPort, FileIntegration, HostPath, Execution } from '../contracts.js'
/** DSH owns change capture and observations; WSL owns atomic publication. */
export function createFileIntegration(ctx: FileEventPort, fs: FileSystemPort): FileIntegration {
  return {
    async prepare(kind: 'write' | 'edit', paths: HostPath, exec?: Execution) {
      exec?.signal?.throwIfAborted()
      const target = await fs.resolve(paths.hostPath, { signal: exec?.signal })
      const intent = await ctx.waterfall(`fs/${kind}-intent`, target, exec, () => undefined)
      return async () => {
        exec?.signal?.throwIfAborted()
        if (intent === undefined) return
        const current = await fs.stat(target, exec?.signal)
        if (intent.kind === 'createIfAbsent') {
          if (current !== undefined) throw Object.assign(new Error('File exists; read it before overwriting.'), { code: 'FS_NOT_OBSERVED' })
        } else if (intent.version !== undefined) {
          if (current?.version !== intent.version) throw Object.assign(new Error('File changed since it was observed; read it again.'), { code: 'FS_STALE_VERSION' })
        } else {
          throw new Error('Unsupported DSH filesystem mutation intent')
        }
      }
    },
    async observed(paths: HostPath, exec?: Execution) {
      const target = await fs.resolve(paths.hostPath, { signal: exec?.signal })
      const info = await fs.stat(target, exec?.signal)
      ctx.emit('fs/observed', target, info === undefined ? { kind: 'absent' } : { kind: 'present', version: info.version }, exec)
    },
  }
}
