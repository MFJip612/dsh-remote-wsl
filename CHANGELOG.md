# Changelog

English | [简体中文](CHANGELOG.zh.md)

Version history for dsh-remote-wsl. Feature documentation lives in [README.md](README.md).

## 0.1.3

- Rewrote Host modules, the browser plugin, and the explicit recovery CLI in strict TypeScript, with separate platform compiler targets and generated JavaScript entry points.
- Added the Cordis Standard Schema configuration export, Host declarations, portable build/typecheck scripts, and packaging/loader regression checks.
- Preserved existing WSL agent isolation, inbox recovery, terminal routing, filesystem observations, change summaries, diffs, and native delivery cards.
- Removed previous JavaScript sources, migrated tests/build scripts to TypeScript, and moved generated runtime files/declarations into ignored `dist/`. Git installs build through `prepare`; packaging builds the distributable artifacts.
- Verified loading in the installed DSH Desktop real environment: the desktop integration tests (renamed from `.cjs` to `.cts`, `test/desktop-runtime.cts` / `test/desktop-deliveries.cts`) run the plugin through the real Cordis loader, agent loop, tool registration, subprocess services, and real WSL execution.

## 0.1.2

- WSL `write` / `edit` now enter the official `fs/write-intent` / `fs/edit-intent` before publishing and record `fs/observed` afterwards, so DSH captures pre-edit content and produces the modified-file list and comparison at turn end.
- Tool results reuse the native write/edit output format, metadata, and diff presentation.
- `present` keeps the official executor and the `deliverables/presented` event; Linux paths (`/...`, relative, `~/`, mounted drives) are converted to paths Windows can access. UNC paths pointing at another distribution are rejected.
- Added `test/desktop-deliveries.cjs`.

## 0.1.1

- **Fixed:** 0.1.0 passed the WSL environment note as a bare string to `agent.inject()`. The malformed value was written to the persisted inbox, so the client and request assembly could not read it as a normal message. The plugin now sends a complete message with a dedicated `id`, `role: 'user'`, text `content`, and `source: { kind: 'plugin:dsh-remote-wsl' }`.
- Tool discovery also queries the current agent, including tools in preset parent scopes. Linux file tools now replace preset-provided `read` / `write` / `edit` / `glob` / `grep`, not only global tools.

### Repairing sessions written by 0.1.0

The in-memory inbox is repaired automatically through the official `agent.inbox.splice()`, which replaces the malformed entry and appends a record. **Corrupted logs already written to disk are rejected by the DSH reader before the recovery hook, so a plain restart cannot repair them**; run the migration utility once first:

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
$exe = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"
& $exe scripts\repair-legacy.cjs "--root=$env:USERPROFILE\.dsh\sessions" | Out-String # report only
& $exe scripts\repair-legacy.cjs "--root=$env:USERPROFILE\.dsh\sessions" --apply | Out-String # back up, then repair
```

The utility converts only the WSL environment note string written by the old plugin and preserves every event sequence number, timestamp, and other message; by default it scans only WSL UNC projects, and `--project=<project directory name under sessions>` selects a drive-mapped project. It modifies files only after acquiring DSH's cross-process write lock and refuses to operate on live sessions; the original bytes are kept as a neighboring `.pre-wsl-repair-<UUID>.bak` file. It verifies the result with the installed DSH's official reader and restores on failure. Reopen the workspace afterwards; refresh the page if the UI still shows cached errors.

## 0.1.0

- First release: a **Connect WSL** entry in the add-workspace flow, distribution selection, a Linux folder browser, and workspace registration as `\\wsl.localhost\<distro>\<path>` (drive paths under `/mnt` use the real Windows path).
- The sidebar terminal of a WSL workspace runs `wsl.exe -d <distro> --cd <linux path>`.
- Linux-side `bash` / `read` / `write` / `edit` / `glob` / `grep` for the workspace session; Windows PowerShell tools are hidden there.
