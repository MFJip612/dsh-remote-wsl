# 更新日志

[English](CHANGELOG.md) | 简体中文

dsh-remote-wsl 的版本变更。功能说明见 [README.zh.md](README.zh.md)。

## 0.1.2

- WSL 的 `write` / `edit` 在发布文件前进入官方 `fs/write-intent` / `fs/edit-intent`，成功后记录 `fs/observed`，让 DSH 捕获修改前内容，并在回合结束时生成修改列表与比较。
- 工具结果复用原生 write/edit 的输出格式、元数据和 diff 展示。
- `present` 继续使用官方执行器与 `deliverables/presented` 事件；Linux 路径（`/...`、相对路径、`~/`、挂载盘）会转换为 Windows 可访问的路径。指向其它发行版的 UNC 路径会拒绝。
- 新增 `test/desktop-deliveries.cjs`。

## 0.1.1

- **修复**：0.1.0 将 WSL 环境说明的裸字符串传给 `agent.inject()`，错误格式的值写入持久化 inbox，客户端及请求组装无法按正常消息读取。现在改为带独立 `id`、`role: 'user'`、文本 `content` 和 `source: { kind: 'plugin:dsh-remote-wsl' }` 的完整消息。
- 工具发现同时按当前 agent 查询，包含预设父作用域中的工具；Linux 文件工具现在能够替换预设提供的 `read` / `write` / `edit` / `glob` / `grep`，而不再仅替换全局工具。

### 修复 0.1.0 写入的会话

内存 inbox 由插件通过官方 `agent.inbox.splice()` 自动替换并追加记录。**已经落盘的损坏日志会被 DSH 读取器在恢复钩子之前拒绝，单纯重启无法修复**，需先执行一次迁移工具：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
$exe = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"
& $exe scripts\repair-legacy.cjs "--root=$env:USERPROFILE\.dsh\sessions" | Out-String # 只报告
& $exe scripts\repair-legacy.cjs "--root=$env:USERPROFILE\.dsh\sessions" --apply | Out-String # 备份后恢复
```

工具只转换旧插件写入的 WSL 环境说明字符串，保留所有事件序号、时间和其它消息；默认仅扫描 WSL UNC 项目，`--project=<sessions 下的项目目录名>` 可指定盘符映射项目。工具取得 DSH 的跨进程写锁后才修改，活跃会话会拒绝操作；原始字节保留为旁边的 `.pre-wsl-repair-<UUID>.bak` 文件。结果用已安装 DSH 的官方读取器验证，失败会还原。恢复后重新打开工作区；若界面仍显示缓存错误，刷新页面。

## 0.1.0

- 首个版本：添加工作区流程中的 **连接 WSL** 入口、发行版选择、Linux 目录浏览器，以及把项目登记为 `\\wsl.localhost\<发行版>\<路径>`（`/mnt` 下的盘符路径使用真实 Windows 路径）。
- WSL 工作区的侧栏终端执行 `wsl.exe -d <发行版> --cd <Linux 路径>`。
- 该工作区的会话使用 Linux 侧 `bash` / `read` / `write` / `edit` / `glob` / `grep`；Windows PowerShell 工具在此隐藏。
