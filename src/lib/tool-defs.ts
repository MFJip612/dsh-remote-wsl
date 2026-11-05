import { record } from '../contracts.js'
import type { Execution, ToolDefinition, ToolDefinitionsInput, ToolOutput } from '../contracts.js'
import type { ToolArgs } from './tool-wsl.js'
/**
 * Tool definitions for one WSL session.
 *
 * Names and parameters mirror the shipped DSH tools (`read`, `write`, `edit`, `glob`, `grep`,
 * plus a `bash` shell) so the model's habits transfer; execution is backed by `tool-wsl.js`.
 * Definitions are registered in the agent's scope only (see `agent-tools.js`), so a normal
 * Windows session keeps the shipped tools untouched.
 *
 * Mutations reuse the shipped output presenters. `present` delegates to the shipped executor
 * after path mapping, keeping official cards and durable delivery events without Client imports.
 */
import { createWslToolRuntime } from './tool-wsl.js'

const TEXT_OUTPUT_SCHEMA = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }

function textOutput(key: string): ToolOutput {
  return {
    schema: TEXT_OUTPUT_SCHEMA,
    render(_args: unknown, value: unknown) {
      const text = typeof record(value)[key] === 'string' ? record(value)[key] : ''
      return [{ type: 'text', text }]
    },
  }
}

const LINUX_PATH_NOTE =
  '这是一个 WSL 工作区：路径请使用 Linux 形式（例如 /home/me/project 或相对当前目录的路径），~ 表示发行版用户的 HOME。'

type ToolName = 'bash' | 'read' | 'write' | 'edit' | 'glob' | 'grep'
interface ToolSpec { name: ToolName; description: string; parameters: unknown; outputKey: string; run(runtime: ReturnType<typeof createWslToolRuntime>, args: ToolArgs): Promise<unknown> }
const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'bash',
    description:
      'Execute a command in the WSL distribution with bash and return stdout/stderr. ' +
      'Each call runs a fresh `bash -lc` process, so shell state (cd/export) does not persist between calls; ' +
      'the default directory is the session workspace. ' + LINUX_PATH_NOTE,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute.' },
        workdir: {
          type: 'string',
          description: 'Working directory for this command, as a Linux path. Defaults to the session workspace.',
        },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (bounded to 10 minutes).' },
      },
      required: ['command'],
    },
    outputKey: 'text',
    run: (runtime, args) => runtime.bash(args),
  },
  {
    name: 'read',
    description: 'Read a UTF-8 text file from the WSL distribution and return line-numbered content. ' + LINUX_PATH_NOTE,
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Linux path of the file to read.' },
        offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
        limit: { type: 'number', description: 'Maximum number of lines to return. Defaults to 2000.' },
      },
      required: ['file_path'],
    },
    outputKey: 'text',
    run: (runtime, args) => runtime.read(args),
  },
  {
    name: 'write',
    description:
      'Create or fully replace a UTF-8 text file in the WSL distribution. The write is atomic (temporary file + rename). ' +
      LINUX_PATH_NOTE,
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Linux path of the file to write.' },
        content: { type: 'string', description: 'Full UTF-8 text content to write.' },
      },
      required: ['file_path', 'content'],
    },
    outputKey: 'text',
    run: (runtime, args) => runtime.write(args),
  },
  {
    name: 'edit',
    description:
      'Edit an existing UTF-8 text file in the WSL distribution by replacing literal text. ' +
      'By default old_string must appear exactly once. The write is atomic (temporary file + rename). ' +
      LINUX_PATH_NOTE,
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Linux path of the file to edit.' },
        old_string: { type: 'string', description: 'Literal text to replace.' },
        new_string: { type: 'string', description: 'Literal replacement text. Empty string deletes the match.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of exactly one.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    outputKey: 'text',
    run: (runtime, args) => runtime.edit(args),
  },
  {
    name: 'glob',
    description:
      'Find files (not directories) in a WSL distribution whose paths match a glob pattern. ' +
      'Returns up to 100 paths ordered by modification time (newest first). ' +
      'A pattern with no "/" matches the basename at any depth. ' + LINUX_PATH_NOTE,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts" or "*.md".' },
        path: { type: 'string', description: 'Directory to search, as a Linux path. Defaults to the session workspace.' },
      },
      required: ['pattern'],
    },
    outputKey: 'text',
    run: (runtime, args) => runtime.glob(args),
  },
  {
    name: 'grep',
    description:
      'Search file contents in a WSL distribution with a regular expression (GNU grep). ' +
      'Returns matching lines as path:line: text, up to 250 matches. ' + LINUX_PATH_NOTE,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'File or directory to search, as a Linux path. Defaults to the session workspace.' },
        include: { type: 'string', description: 'One glob filter for file names, e.g. "*.ts".' },
      },
      required: ['pattern'],
    },
    outputKey: 'text',
    run: (runtime, args) => runtime.grep(args),
  },
]

/**
 * @param {object} input
 * @param {object} input.runtime shared inputs for `createWslToolRuntime`
 * @param {(name: string) => boolean} input.hasTool whether a shipped tool with that name is visible
 * @returns {{ tools: object[], deny: string[] }}
 */
export function createWslToolDefinitions(input: ToolDefinitionsInput) {
  const runtime = createWslToolRuntime(input)
  const tools: ToolDefinition[] = []
  for (const spec of TOOL_SPECS) {
    // `bash` is new; the file/search tools shadow the shipped ones when present.
    if (spec.name !== 'bash' && input.hasTool(spec.name) !== true) continue
    tools.push({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: textOutput(spec.outputKey),
      execute: async (args, exec) => await runtime[spec.name](record(args), exec),
    })
    if (spec.name === 'write' || spec.name === 'edit') {
      const name = spec.name
      const native = input.getTool?.(spec.name)
      if (native?.output !== undefined) {
        const definition = tools[tools.length - 1]
        definition.output = native.output
        definition.presentCall = native.presentCall
        definition.presentResult = native.presentResult
        definition.execute = async (args, exec) => {
          const value = await runtime[name](record(args), exec)
          const result: { path: string; before: string | null; after: unknown; operation?: string } = { path: value.hostPath, before: value.before, after: value.after }
          if ('operation' in value) result.operation = value.operation
          return result
        }
      }
    }
  }
  const nativePresent = input.getTool?.('present')
  if (nativePresent !== undefined) {
    tools.push({
      ...nativePresent,
      description: nativePresent.description + ' WSL paths may be Linux absolute, relative, or ~/ paths.',
      async execute(args: unknown, exec?: Execution) {
        const presentArgs = record(args)
        if (!Array.isArray(presentArgs.files)) throw new TypeError('files must be an array')
        const files: Record<string, unknown>[] = []
        for (const value of presentArgs.files) {
          const file = record(value)
          const mapped = await runtime.resolve(file.path)
          files.push({ ...file, path: mapped.hostPath })
        }
        // 保留官方 executor 的限额、文件校验及 tools/result → deliverables/presented 链路。
        return nativePresent.execute({ ...presentArgs, files }, exec)
      },
    })
  }
  // Hide the Windows shell in this agent scope; our `bash` replaces it.
  const deny = []
  for (const name of ['pwsh', 'powershell']) {
    if (input.hasTool(name) === true) deny.push(name)
  }
  return { tools, deny }
}
