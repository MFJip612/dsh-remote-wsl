# dsh-remote-wsl

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

English | [简体中文](README.zh.md)

Open **a project inside a WSL distribution** directly in DeepSeek Harness (DSH): "Add workspace" gains a **Connect WSL** entry, where you pick a distribution, browse Linux folders, and make the selected directory a DSH workspace. In that workspace the **sidebar terminal runs inside the distribution**, and the agent's `bash` / `read` / `write` / `edit` / `glob` / `grep` likewise execute on the Linux side.

> Target environment: Windows 10/11 + WSL2. The plugin uses only official DSH services; it neither depends on nor calls any third-party WSL plugin.

## What it does

**1. Entry point.** The "+" in the sidebar workspace header and "Add workspace" on the new-session page share one add flow. The dialog now first asks where the folder is:

- **Local folder**: the original Windows directory picker, unchanged.
- **Connect WSL**: the row below "Local folder"; open it to choose a distribution.

**2. Choose a distribution.** The "Connect WSL" dialog lists every distribution on the machine (stopped ones included) with its running state, and can refresh from the top-right corner. Distributions are enumerated with `wsl.exe -l -v --all`; UTF-16LE output is detected automatically, `*` marks the default distribution, and the list is cached for 5 seconds.

**3. Choose a project.** After a distribution is selected, browsing starts at that distribution's default user `$HOME`:

- Breadcrumbs (`Ubuntu / home / me`) are clickable;
- The search box filters the current level, and you can also type a Linux path to jump there;
- Hidden folders can be shown or hidden;
- Select the current folder and click "Confirm".

**4. Register as a workspace.**

- Projects on the Linux filesystem are registered as `\\wsl.localhost\<distro>\<path>` (the `\\wsl$` fallback form is probed automatically).
- Projects under `/mnt/<drive>/...` are registered as the real Windows path (for example `D:\work\proj`) — WSL's 9P share denies access to `/mnt`, so only the real drive path is readable and writable; the plugin remembers which distribution it came from.
- Afterwards, in a new session, the workspace is an ordinary DSH workspace; only the execution plane differs.

**5. Terminal inside the distribution.** Opening the sidebar terminal in this workspace actually runs
`wsl.exe -d <distro> --cd <linux path>`, that is the distribution's login shell, starting in the project directory.

**6. Agent tools inside the distribution.** In sessions of this workspace:

| Tool | Behavior |
|---|---|
| `bash` | Runs `bash -lc` inside the distribution, with the workspace as the default directory; every call is a fresh shell |
| `read` / `write` / `edit` | Use Linux paths; writes and edits publish atomically via a temporary file plus `rename` (WSL's 9P share does not support DSH's native hard-link publish) |
| `glob` / `grep` | Search inside the distribution with globstar / GNU grep |

Windows PowerShell tools are hidden in WSL workspaces; ordinary Windows workspaces are unaffected.

## Installation

Install the local directory from DSH's Plugins page, or:

```powershell
dsh plugin --profile web add github:MFJip612/dsh-remote-wsl
```

The repository contains TypeScript sources only. Run `npm ci` (which builds automatically) or `npm run build` before installing a local directory. GitHub installs build through `prepare`; if pnpm blocks build scripts, allow the exact package key reported by the installer in that profile's `pnpm-workspace.yaml`, then retry. Alternatively, run `npm pack` and install the tarball containing compiled artifacts.

You can also ask the agent in a session to install that directory with the plugin manager. `link:` only guarantees that files in this directory are read; it does not guarantee a running Host reloads code. **Under the default configuration, Host-side code changes require a full quit and restart of DSH**; browser-side code changes only need a page refresh. DSH's default HMR configuration is `root: []`, which watches only configuration files. If the quit prompt reports a running task, wait for it to finish before restarting.

## File changes and delivery cards

Before publishing, WSL `write` / `edit` enter the official `fs/write-intent` / `fs/edit-intent` so DSH captures the pre-edit content; on success they record `fs/observed`. Tool results reuse the native write/edit output format, metadata, and diff presentation, and the official workspace-changes produces the modified-file list and comparison at turn end. Read-only, out-of-bounds, unobserved, and stale-version writes are still rejected.

`present` keeps using the official executor and the `deliverables/presented` event; the plugin converts Linux absolute paths, relative paths, `~/`, and mounted-drive paths into paths Windows can access, preserving descriptions, file limits, regular-file validation, and click-to-preview/open behavior. UNC paths pointing at another distribution are rejected.

The modified-file list automatically aggregates successful modifications from file tools; a standalone file card is still published by the model calling `present`, and the plugin does not publish a card for every source change automatically. When files are modified only through bash, non-Git directories lack the file tools' pre-capture; ask the model to call `present` explicitly when you need a standalone card.

## Configuration fields

Override the plugin row's `config` in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-remote-wsl
  name: 'dsh-remote-wsl'
  config:
    terminal: true
    tools: true
```

| Field | Default | Description |
|---|---|---|
| `terminal` | `true` | Whether the sidebar terminal of WSL workspaces opens inside the distribution |
| `tools` | `true` | Whether to enable Linux-side tools for sessions of WSL workspaces |
| `execTimeoutMs` | `15000` | Timeout for a single `wsl.exe` call (milliseconds) |
| `distroCacheMs` | `5000` | Cache duration for the distribution list |
| `maxEntries` | `2000` | Maximum entries returned for one directory level by the picker |
| `maxReadBytes` | `2000000` | Maximum bytes returned by a single `read` |
| `defaultDistro` | `''` | Reserved: default-distribution override (empty = use the WSL default) |
| `mountRoot` | `''` | automount root (empty = read the distribution's `/etc/wsl.conf`, falling back to `/mnt`) |
| `remote` | `false` | Whether non-loopback clients may call the plugin's routes |

## How it works

- **Entry point**: occupies the two single slots declared by the official workspace component, `sidebar.workspaces.directoryFlow` and `conversation.hero.workspace.directoryFlow`, and renders its own "Local folder / Connect WSL" picker with a lower `priority` than the official occupant; the dialog is drawn in `shell.overlay`. Choosing "Local folder" calls the official `ctx.uiWorkspace.pickDirectory()` (or the desktop-injected `__DSH_DIRECTORY_PICKER__`), so native picker behavior is unchanged.
- **Host routes**: `GET /dsh-remote-wsl/{status,distros,warm,list}` and `POST /dsh-remote-wsl/connect`. All same-origin JSON, cross-site requests rejected, loopback-only by default; `connect` registers the workspace through the official `workspaceRegistry.create()`.
- **Identity probing**: `wsl.exe -d <distro> --exec bash --noprofile --norc -c "printf '%s\n' '<sentinel>' \"$WSL_DISTRO_NAME\" \"$(id -un)\" \"$HOME\""` (so rc-file output cannot pollute the identity), falling back to reading `/etc/wsl.conf` and `/etc/passwd` on failure.
- **Directory browsing**: goes directly through the `\\wsl.localhost` share; when the share denies access it falls back to `find` inside the distribution.
- **Terminal**: wraps the official `subprocess.spawnTerminal` and replaces argv only when the cwd falls inside a WSL workspace; other terminals pass through unchanged. If an official upgrade changes this internal method, terminals fall back to the Windows shell and the connect flow is unaffected.
- **Tools**: resolves the session cwd on `agent/created`; if it falls inside a WSL workspace, registers Linux tools within that agent's scope (scope tools shadow same-named global tools and do not affect other sessions) and hides the Windows shell via `tools.restrict`. Write operations honor `ctx.sandboxPolicy.resolve()`: `read-only` rejects writes and bash, `workspace-write` allows only targets inside the workspace (or a temporary directory), and `danger-full-access` permits everything.

The tools' directory gate checks only the target path of `write` / `edit`; it is not Linux process isolation: under `workspace-write`, bash still runs with the distribution user's privileges and must not be treated as an operating-system sandbox.

## Known limitations

- **The agent process still runs on Windows.** DSH has no protocol for running the Host/Agent inside WSL; this plugin proxies the session's shell and file tools to `wsl.exe`, while other tools (web, subagent, todo, etc.) remain native DSH implementations.
- **Every `bash` call is a fresh shell**, so `cd` / `export` do not persist across calls; chain them in one command, or use `workdir`.
- **Background bash is unsupported** (no `run_in_background`).
- **The `working_directory` tool does not recognize Linux paths** (v1 limitation); `cd` inside the bash command when you need to change directory.
- **Writes do not trigger DSH's privilege-escalation prompt for out-of-workspace writes**: writes outside the workspace are rejected outright; switch the session permission to full access when needed.
- **WSL 1 is unsupported**: share paths outside `/mnt` are unreliable, and the picker suggests upgrading to WSL 2.
- The file tree, code preview, and change history are still read by DSH on the Windows side through the 9P share, so very large directories are slower than on native Linux.
- A distribution starts automatically the first time it is accessed (this may take several seconds).

## TypeScript development

Maintained sources live in `src/`: Host ESM modules, `src/client.ts` for the browser, and `src/scripts/repair-legacy.cts` for the explicit recovery CLI. The compiled browser script keeps the DSH module-loader registration and uses the host's React instance.

```powershell
npm ci
npm run check # Build the plugin, then strictly typecheck tests and the build script
npm run build # Generate loadable JavaScript and Host declarations
npm test      # Build, check public entries/config, and run behavior regressions
npm pack      # Build automatically before packaging
```

Requires Node.js >= 24.9.0. Product sources, build scripts, and tests are all TypeScript. Previous JavaScript files at the root and under `lib/` have been removed. All JavaScript and Host declarations are generated only into Git-ignored `dist/`; generated artifacts are not committed. Public package entries point to `dist/`, and packaging automatically builds the runtime files and static resources. The build works independently of the DSH source checkout.

The recovery CLI source is `src/scripts/repair-legacy.cts`; execute its compiled `dist/scripts/repair-legacy.cjs` entry. It still defaults to report-only and modifies logs only with explicit `--apply`.

The exported Standard Schema `Config` is compatible with Cordis and preserves existing fields, defaults, and input normalization. Development types use Cordis 4.0.5, matching the Desktop used for validation; runtime services and React remain supplied by DSH.

For linked installs, build source changes before restarting the Host or refreshing the browser. Host changes still require fully exiting and restarting DSH. Real-WSL sections of `npm test` skip when WSL is unavailable; the two Desktop integration tests below require real WSL and fail when it is missing.

## Tests

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
$exe = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"
& $exe test\pure.test.ts         # pure functions (distribution parsing, path mapping, wsl.conf/passwd)
& $exe test\run.ts               # Host services + real WSL (identity, directories, bash)
& $exe test\tools.test.ts        # tool runtime + real WSL (write/read/edit/glob/grep/bash/sandbox gate)
& $exe test\registration.test.ts # registration layer (agent-scoped tool set, terminal routing wrapper)
& $exe test\desktop-runtime.cts | Out-String # the installed DSH's real Agent/tool execution chain + real WSL; no model cost
& $exe test\desktop-deliveries.cts | Out-String # real file-change summary, diff, and present delivery events; isolated WSL test directory
```

When no `node.exe` is on PATH, run with the Electron bundled with DSH Desktop in Node mode (as above). Sections that need a real WSL show `skipped` when it is unavailable.

`test/desktop-runtime.cts` must run through the installed DSH Desktop executable and requires access to WSL; it fails rather than skips when the environment is missing. The test replaces model network responses while keeping DSH's real Cordis, Agent loop, inbox, tool registration, tool execution, and subprocess services, covering a new session completing a conversation, in-memory inbox recovery, and multi-frame Zstd on-disk corruption rejection, write-lock exclusion, backup, and post-repair official reads. Conversations are created in memory and run read-only commands in the Linux HOME; disk tests use only temporary directories and do not change desktop sessions or user projects.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
