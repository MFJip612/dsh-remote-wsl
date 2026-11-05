import { errorCode } from '../contracts.js'
import type { ToolRuntimeInput, RunOptions, Execution } from '../contracts.js'
export interface ToolArgs { file_path?: unknown; content?: unknown; offset?: unknown; limit?: unknown; old_string?: unknown; new_string?: unknown; replace_all?: unknown; path?: unknown; pattern?: unknown; include?: unknown; command?: unknown; workdir?: unknown; timeoutMs?: unknown }
function stringContent(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('content must be a string')
  return value
}
/**
 * Execution primitives for the WSL-side agent tools.
 *
 * All Linux-side file operations go through one distribution:
 *  - reads use the `\\wsl.localhost` share (served by the distribution itself) through Node's fs,
 *  - writes/edits publish through `wsl.exe` with a temporary file + `mv -f`, because the WSL 9P
 *    share cannot publish new files the way DSH's local filesystem does (hard links fail ENOTSUP).
 *
 * Mutations are gated by the session's resolved sandbox policy: `read-only` refuses everything,
 * `workspace-write` allows only targets inside the session workspace (or the platform temp dir).
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isPathInsideHost, linuxToHostPath } from './wsl-path.js'

const MAX_BASH_OUTPUT_BYTES = 256 * 1024
const MAX_GREP_MATCHES = 250
const MAX_GLOB_RESULTS = 100

function toolError(code: string, message: string) {
  return Object.assign(new Error(message), { code })
}

function textOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Strip a single trailing newline so rendered tool output stays tidy. */
function trimTrailingNewline(text: string) {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

/**
 * Build the runtime bound to one WSL session.
 *
 * @param {object} input
 * @param {object} input.service WSL host service.
 * @param {object} input.mappings workspace mapping store.
 * @param {object} input.config resolved plugin config.
 * @param {object} input.origin `{ distro, linuxPath, rootHostPath }` of the session workspace.
 * @param {string} input.home Linux HOME of the distribution user.
 * @param {object} input.session the live DSH Session (for sandbox policy resolution).
 * @param {object|undefined} input.sandboxPolicy `ctx.get('sandboxPolicy')`.
 */
export function createWslToolRuntime({ service, mappings, config, origin, home, session, sandboxPolicy, fileIntegration }: ToolRuntimeInput) {
  const distro = origin.distro
  const maxReadBytes = Number(config.maxReadBytes) || 2_000_000

  let mountRootPromise: Promise<string> | undefined
  function mountRoot() {
    if (mountRootPromise === undefined) {
      mountRootPromise = service.getMountRoot(distro).catch(() => config.mountRoot || '/mnt')
    }
    return mountRootPromise
  }

  async function resolve(inputPath: unknown) {
    const root = await mountRoot()
    return await mappings.resolveModelPath(origin, inputPath, { home, mountRoot: root })
  }

  function policy() {
    try {
      if (sandboxPolicy === undefined) return { mode: 'danger-full-access', workspaceRoot: origin.rootHostPath }
      const resolved = sandboxPolicy.resolve({ session })
      return {
        mode: resolved?.mode ?? 'danger-full-access',
        workspaceRoot: resolved?.workspaceRoot ?? origin.rootHostPath,
      }
    } catch {
      return { mode: 'danger-full-access', workspaceRoot: origin.rootHostPath }
    }
  }

  function assertReadable() {
    // Reads are allowed in every mode.
  }

  function assertWritable(hostPath: string) {
    const current = policy()
    if (current.mode === 'danger-full-access') return
    if (current.mode === 'read-only') {
      throw toolError(
        'sandbox-denied',
        '当前会话的文件策略是只读（read-only），不能修改文件。需要写入时请把会话权限切到「工作区写入」或「完全权限」。',
      )
    }
    const insideWorkspace = isPathInsideHost(current.workspaceRoot, hostPath)
    const insideTemp = isPathInsideHost(path.join(os.tmpdir(), ''), hostPath)
    if (!insideWorkspace && !insideTemp) {
      throw toolError(
        'sandbox-denied',
        `目标不在当前工作区内（workspace-write 只允许工作区和临时目录）：${hostPath}`,
      )
    }
  }

  function assertShellAllowed() {
    const current = policy()
    if (current.mode === 'read-only') {
      throw toolError(
        'sandbox-denied',
        '当前会话的文件策略是只读（read-only），bash 命令可能修改文件，已拒绝执行。需要执行命令时请切换会话权限。',
      )
    }
  }

  async function runWslText(args: string[], options: RunOptions = {}) {
    const raw = await service.runRaw(args, options)
    if (raw.timedOut) throw toolError('wsl-timeout', 'WSL 命令超时')
    return {
      stdout: raw.stdout.toString('utf8'),
      stderr: raw.stderr.toString('utf8'),
      exitCode: raw.exitCode,
    }
  }

  async function readFileText(hostPath: string, linuxPath: string) {
    let buffer
    try {
      const stat = await fsp.stat(hostPath)
      if (!stat.isFile()) throw toolError('not-a-file', `不是普通文件：${linuxPath}`)
      if (stat.size === 0) return ''
      const handle = await fsp.open(hostPath, 'r')
      try {
        const length = Math.min(stat.size, maxReadBytes)
        const chunk = Buffer.allocUnsafe(length)
        const { bytesRead } = await handle.read(chunk, 0, length, 0)
        buffer = chunk.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw toolError('not-found', `文件不存在：${linuxPath}`)
      if (errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM') {
        throw toolError('permission-denied', `没有读取权限：${linuxPath}`)
      }
      throw error
    }
    const probe = buffer.subarray(0, Math.min(buffer.length, 8192))
    if (probe.includes(0)) throw toolError('binary-file', `这是二进制文件，无法作为文本读取：${linuxPath}`)
    const text = buffer.toString('utf8')
    return text.length > maxReadBytes ? text.slice(0, maxReadBytes) : text
  }

  /** Publish UTF-8 text at `linuxPath` atomically through the distribution. */
  async function publishText(hostPath: string, linuxPath: string, content: string, check?: () => Promise<void>, exec?: Execution) {
    assertWritable(hostPath)
    const temporary = `${linuxPath}.dsh-tmp-${process.pid}-${Date.now()}`
    const script = [
      'mkdir -p -- "$(dirname -- "$1")"',
      'cat > "$2"',
      'mv -f -- "$2" "$1"',
    ].join(' && ')
    const args = ['-d', distro, '--exec', 'bash', '-c', script, 'bash', linuxPath, temporary]
    await check?.()
    const result = await runWslText(args, {
      stdin: content,
      timeoutMs: Math.max(Number(config.execTimeoutMs) || 15000, 30_000),
      signal: exec?.signal,
    })
    if (result.exitCode !== 0) {
      throw toolError(
        'write-failed',
        `写入失败：${(result.stderr.trim() || result.stdout.trim() || `退出码 ${result.exitCode}`)}`,
      )
    }
    return temporary
  }

  async function read(args: ToolArgs, exec?: Execution) {
    assertReadable()
    const target = await resolve(args.file_path)
    const text = await readFileText(target.hostPath, target.linuxPath)
    await fileIntegration?.observed(target, exec)
    const lines = text.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const offset = Math.max(1, Math.floor(Number(args.offset) || 1))
    const limit = Math.max(1, Math.floor(Number(args.limit) || 2000))
    const selected = lines.slice(offset - 1, offset - 1 + limit)
    const total = lines.length
    const body = selected
      .map((line, index) => `${String(offset + index).padStart(6, ' ')}→${line}`)
      .join('\n')
    const header = `${target.linuxPath}（${total} 行，显示第 ${offset}-${Math.min(total, offset - 1 + limit)} 行）`
    return { path: target.linuxPath, totalLines: total, text: `${header}\n${body}` }
  }

  async function write(args: ToolArgs, exec?: Execution) {
    const content = stringContent(args.content)
    const target = await resolve(args.file_path)
    assertWritable(target.hostPath)
    const check = await fileIntegration?.prepare('write', target, exec)
    let before
    try { before = await readFileText(target.hostPath, target.linuxPath) }
    catch (error) { if (errorCode(error) !== 'not-found') throw error; before = null }
    await publishText(target.hostPath, target.linuxPath, content, check, exec)
    await fileIntegration?.observed(target, exec)
    return { path: target.linuxPath, hostPath: target.hostPath, operation: before === null ? 'create' : 'update', before, after: content,
      bytes: Buffer.byteLength(content, 'utf8'), text: `已写入 ${target.linuxPath}` }
  }

  async function edit(args: ToolArgs, exec?: Execution) {
    const oldString = String(args.old_string ?? '')
    const newString = String(args.new_string ?? '')
    if (oldString.length === 0) throw toolError('invalid-edit', 'old_string 不能为空')
    if (oldString === newString) throw toolError('invalid-edit', 'old_string 与 new_string 相同，无需修改')
    const target = await resolve(args.file_path)
    assertWritable(target.hostPath)
    const check = await fileIntegration?.prepare('edit', target, exec)
    const original = await readFileText(target.hostPath, target.linuxPath)
    const occurrences = original.split(oldString).length - 1
    if (occurrences === 0) throw toolError('edit-no-match', `在 ${target.linuxPath} 里找不到要替换的文本`)
    if (occurrences > 1 && args.replace_all !== true) {
      throw toolError(
        'edit-multiple-match',
        `要替换的文本出现了 ${occurrences} 次；请提供更精确的 old_string，或设置 replace_all 为 true`,
      )
    }
    const next =
      args.replace_all === true ? original.split(oldString).join(newString) : original.replace(oldString, newString)
    await publishText(target.hostPath, target.linuxPath, next, check, exec)
    await fileIntegration?.observed(target, exec)
    return {
      path: target.linuxPath,
      hostPath: target.hostPath,
      before: original,
      after: next,
      replaced: args.replace_all === true ? occurrences : 1,
      text: `已修改 ${target.linuxPath}（${args.replace_all === true ? occurrences : 1} 处）`,
    }
  }

  async function glob(args: ToolArgs, _exec?: Execution) {
    const base = await resolve(args.path ?? origin.linuxPath)
    const pattern = String(args.pattern ?? '')
    if (pattern.length === 0) throw toolError('invalid-glob', 'pattern 不能为空')
    const script = [
      'set -u',
      'base="$1"',
      'pattern="$2"',
      'limit="$3"',
      'shopt -s globstar dotglob nullglob',
      'pat="$pattern"',
      'case "$pat" in */*) ;; *) pat="**/$pat" ;; esac',
      'out=()',
      'for p in "$base"/$pat; do [ -f "$p" ] && out+=("$p"); done',
      'if [ "${#out[@]}" -eq 0 ]; then exit 0; fi',
      'for p in "${out[@]}"; do printf "%s\\t%s\\n" "$(stat -c %Y -- "$p")" "$p"; done | sort -rn | head -n "$limit" | cut -f2-',
    ].join('\n')
    const result = await runWslText(
      ['-d', distro, '--exec', 'bash', '-c', script, 'bash', base.linuxPath, pattern, String(MAX_GLOB_RESULTS)],
      { timeoutMs: Math.max(Number(config.execTimeoutMs) || 15000, 60_000) },
    )
    if (result.exitCode !== 0) {
      throw toolError('glob-failed', result.stderr.trim() || result.stdout.trim() || 'glob 失败')
    }
    const paths = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const truncated = paths.length >= MAX_GLOB_RESULTS
    return {
      paths,
      truncated,
      text: paths.length === 0 ? '没有匹配的文件' : paths.join('\n') + (truncated ? `\n（只显示前 ${MAX_GLOB_RESULTS} 个）` : ''),
    }
  }

  async function grep(args: ToolArgs, _exec?: Execution) {
    const base = await resolve(args.path ?? origin.linuxPath)
    const pattern = String(args.pattern ?? '')
    if (pattern.length === 0) throw toolError('invalid-grep', 'pattern 不能为空')
    const include = typeof args.include === 'string' ? args.include.trim() : ''
    const script = [
      'set -u',
      'base="$1"',
      'pattern="$2"',
      'include="$3"',
      'limit="$4"',
      'args=(-rn --color=never -I -e "$pattern" -- "$base")',
      'if [ -n "$include" ]; then args=(--include="$include" "${args[@]}"); fi',
      'grep "${args[@]}" 2>/dev/null | head -n "$limit"',
    ].join('\n')
    const result = await runWslText(
      ['-d', distro, '--exec', 'bash', '-c', script, 'bash', base.linuxPath, pattern, include, String(MAX_GREP_MATCHES)],
      { timeoutMs: Math.max(Number(config.execTimeoutMs) || 15000, 60_000) },
    )
    const lines = trimTrailingNewline(result.stdout)
      .split('\n')
      .filter((line) => line.length > 0)
    const truncated = lines.length >= MAX_GREP_MATCHES
    return {
      matches: lines,
      truncated,
      text: lines.length === 0 ? '没有匹配' : lines.join('\n') + (truncated ? `\n（只显示前 ${MAX_GREP_MATCHES} 行）` : ''),
    }
  }

  async function bash(args: ToolArgs, _exec?: Execution) {
    assertShellAllowed()
    const command = String(args.command ?? '')
    if (command.trim().length === 0) throw toolError('invalid-command', 'command 不能为空')
    const cwd = args.workdir === undefined || String(args.workdir).trim().length === 0
      ? { linuxPath: origin.linuxPath }
      : await resolve(String(args.workdir))
    const requested = Number(args.timeoutMs)
    const timeoutMs = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.max(requested, 1000), 600_000)
      : Math.max(Number(config.execTimeoutMs) || 15000, 60_000)
    const result = await runWslText(
      ['-d', distro, '--cd', cwd.linuxPath, '--exec', 'bash', '-lc', command],
      { timeoutMs },
    )
    let output = result.stdout
    if (result.stderr.length > 0) output += `${output.length > 0 && !output.endsWith('\n') ? '\n' : ''}[stderr]\n${result.stderr}`
    if (output.length > MAX_BASH_OUTPUT_BYTES) output = output.slice(-MAX_BASH_OUTPUT_BYTES)
    const body = trimTrailingNewline(output)
    return {
      exitCode: result.exitCode,
      cwd: cwd.linuxPath,
      text: body.length > 0 ? `${body}\n[exit code: ${result.exitCode}]` : `[exit code: ${result.exitCode}]`,
    }
  }

  return { read, write, edit, glob, grep, bash, resolve, policy }
}
