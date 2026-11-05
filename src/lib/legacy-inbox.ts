import { isRecord, errorCode } from '../contracts.js'
export interface LegacyPersistence {
  acquireWriteLease(header: Record<string, unknown>): Promise<{ release(): void | Promise<void> }>
  open(id: string, mode: 'read'): Promise<{ read(): Promise<unknown>; close(): void | Promise<void> }>
}
/** Explicit, backed-up recovery of invalid session.v4 logs emitted by plugin 0.1.0. */
import { randomUUID } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import { basename } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** Convert only owned legacy strings; preserve header, sequence numbers and all other events. */
export function repairLegacyInboxLog(text: string) {
  const lines = text.trimEnd().split('\n')
  let repaired = 0
  for (let index = 0; index < lines.length; index += 1) {
    const row: unknown = JSON.parse(lines[index])
    if (!isRecord(row) || !isRecord(row.data) || row.type !== 'agent/inbox/spliced' || !Array.isArray(row.data?.inserted)) continue
    let changed = false
    const inserted = row.data.inserted.map((entry: unknown) => {
      if (typeof entry !== 'string' || !entry.startsWith('本会话的目录在 WSL 发行版 ')
        || !entry.endsWith('请用 bash 工具执行命令，不要使用 PowerShell。')) return entry
      repaired += 1
      changed = true
      return { id: randomUUID(), role: 'user', content: [{ type: 'text', text: entry }], source: { kind: 'plugin:dsh-remote-wsl' } }
    })
    if (changed) lines[index] = JSON.stringify({ ...row, data: { ...row.data, inserted } })
  }
  return { repaired, lines }
}

/**
 * Explicit repair only: dry-run by default. Publication requires the DSH backend's kernel
 * write lease, an exclusive byte-for-byte backup, and successful official read validation.
 * A live writer rejects the repair; validation failure restores the original bytes.
 */
export async function repairLegacyInboxFile(filePath: string, persistence: LegacyPersistence | undefined, { apply = false }: { apply?: boolean } = {}) {
  const filename = basename(filePath)
  if (!['session.v4.jsonl.zstd', 'session.v4.jsonl'].includes(filename)) throw new Error('Recovery supports only v4 JSONL artifacts')
  const compressed = filename.endsWith('.zstd')
  const original = await fs.readFile(filePath)
  const frames: Buffer[] = []
  if (compressed) {
    // Desktop Node 24.21 stops after one Zstd frame; each session append may add a frame.
    let offset = 0
    while (offset < original.length) {
      // Node's declarations describe only the Buffer result, although info:true returns
      // { buffer, engine }. Check that runtime boundary before using consumed-frame bytes.
      const decoded: unknown = zstdDecompressSync(original.subarray(offset), { info: true })
      if (!isRecord(decoded) || !Buffer.isBuffer(decoded.buffer) || !isRecord(decoded.engine)) {
        throw new Error('Zstd decoder does not expose frame information')
      }
      const consumed = decoded.engine.bytesWritten
      if (typeof consumed !== 'number' || !Number.isSafeInteger(consumed) || consumed <= 0
        || consumed > original.length - offset) throw new Error('Zstd decoder made no progress')
      frames.push(decoded.buffer)
      offset += consumed
    }
  }
  const text = compressed ? Buffer.concat(frames).toString('utf8') : original.toString('utf8')
  const result = repairLegacyInboxLog(text)
  const header: unknown = JSON.parse(result.lines[0])
  if (!isRecord(header) || header.type !== 'session' || header.version !== 4 || typeof header.id !== 'string') throw new Error('Invalid v4 session header')
  if (result.repaired === 0 || !apply) return { id: header.id, repaired: result.repaired, applied: false }
  if (typeof persistence?.acquireWriteLease !== 'function') throw new Error('DSH backend cannot acquire a session write lease')
  const lease = await persistence.acquireWriteLease(header)
  const temporary = `${filePath}.wsl-repair-${randomUUID()}.tmp`
  const backupPath = `${filePath}.pre-wsl-repair-${randomUUID()}.bak`
  let published = false
  try {
    if (!(await fs.readFile(filePath)).equals(original)) throw new Error('Session changed before the write lease was acquired')
    await fs.copyFile(filePath, backupPath, fsConstants.COPYFILE_EXCL)
    const candidate = compressed
      ? Buffer.concat(result.lines.map(line => zstdCompressSync(Buffer.from(`${line}\n`), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })))
      : Buffer.from(result.lines.join('\n') + '\n')
    await fs.writeFile(temporary, candidate, { flag: 'wx' })
    await fs.rename(temporary, filePath)
    published = true
    const handle = await persistence.open(header.id, 'read')
    try { await handle.read() } finally { await handle.close() }
    return { id: header.id, repaired: result.repaired, applied: true, backupPath }
  } catch (error) {
    if (published) {
      await fs.writeFile(temporary, original, { flag: 'wx' })
      await fs.rename(temporary, filePath)
    }
    throw error
  } finally {
    try {
      await fs.unlink(temporary).catch(error => { if (errorCode(error) !== 'ENOENT') throw error })
    } finally { await lease.release() }
  }
}
