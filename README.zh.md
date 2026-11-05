# dsh-remote-wsl

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.md) | 简体中文

在 DeepSeek Harness（DSH）里直接连接 **WSL 发行版里的项目**：点「添加工作区」时多一个 **连接 WSL** 入口，选发行版、浏览 Linux 文件夹，选中后该目录成为 DSH 工作区。这个工作区里的**侧栏终端开在发行版里**，agent 的 `bash` / `read` / `write` / `edit` / `glob` / `grep` 也都在 Linux 侧执行。

> 目标环境：Windows 10/11 + WSL2。插件只调用 DSH 官方服务，不依赖也不调用任何第三方 WSL 插件。

## 它做什么

**1. 入口。** 侧栏工作区标题栏的「+」、新会话页的「添加工作区」都走同一个添加流程。现在弹窗先问文件夹在哪里：

- **本地文件夹**：原来的 Windows 目录选择器，行为不变。
- **连接 WSL**：在「本地文件夹」下面的一行，点开后选择发行版。

**2. 选发行版。** 「连接 WSL」弹窗列出本机全部发行版（含已停止的），显示运行状态，右上角可以刷新。发行版通过 `wsl.exe -l -v --all` 枚举，UTF-16LE 输出自动识别，`*` 为默认发行版，列表缓存 5 秒。

**3. 选项目。** 选中发行版后从该发行版默认用户的 `$HOME` 开始浏览：

- 面包屑（`Ubuntu / home / me`）可点击跳转；
- 搜索框过滤当前层，也可以直接输入 Linux 路径跳转；
- 可切换显示隐藏文件夹；
- 选中当前文件夹点「确认」即可。

**4. 登记为工作区。**

- Linux 文件系统里的项目登记为 `\\wsl.localhost\<发行版>\<路径>`（自动探测 `\\wsl$` 备用形态）。
- `/mnt/<盘符>/...` 下的项目登记为真实的 Windows 路径（例如 `D:\work\proj`）——WSL 的 9P 共享拒绝访问 `/mnt`，只有真实盘符路径可读写；插件会记住它来自哪个发行版。
- 之后在新会话里，工作区就是普通的 DSH 工作区；区别只在执行面。

**5. 终端在发行版里。** 在这个工作区打开侧栏终端，实际执行的是
`wsl.exe -d <发行版> --cd <Linux 路径>`，也就是发行版的登录 shell，起始目录就是项目目录。

**6. agent 工具在发行版里。** 这个工作区的会话里：

| 工具 | 行为 |
|---|---|
| `bash` | 在发行版里执行 `bash -lc`，默认目录是工作区；每次调用是新 shell |
| `read` / `write` / `edit` | 使用 Linux 路径；写入/编辑用临时文件 + `rename` 原子发布（WSL 的 9P 共享不支持 DSH 原生的硬链接发布方式） |
| `glob` / `grep` | 在发行版里用 globstar / GNU grep 搜索 |

Windows 的 PowerShell 工具在 WSL 工作区里会被隐藏，普通 Windows 工作区完全不受影响。

## 安装

在 DSH 的「插件」页面安装本地目录，或者：

```powershell
dsh plugin --profile web add github:MFJip612/dsh-remote-wsl
```

仓库只保存 TypeScript 源码，安装本地目录前请运行 `npm ci`（自动构建）或 `npm run build`。GitHub 安装通过 `prepare` 构建；如果 pnpm 阻止构建脚本，按安装器提示在对应 profile 的 `pnpm-workspace.yaml` 中允许它报告的准确包键，然后重试。也可先运行 `npm pack`，安装已包含构建产物的 tarball。

也可以在会话里让 agent 用插件管理器安装该目录。`link:` 只保证读取本目录的文件，不保证已经运行的 Host 重载代码。**默认配置下，Host 侧代码更新后需要完全退出并重启 DSH**；浏览器侧代码更新后刷新页面即可。DSH 的默认 HMR 配置是 `root: []`，只监听配置文件。如果退出提示有任务正在运行，请先等任务完成再重启。

## 文件变更和交付卡片

WSL 的 `write` / `edit` 在发布文件前进入官方 `fs/write-intent` / `fs/edit-intent`，让 DSH 捕获修改前内容；成功后记录 `fs/observed`。工具结果复用原生 write/edit 的输出格式、元数据和 diff 展示，回合结束时由官方 workspace-changes 生成修改列表与比较。只读、越界、未观察和版本过期的写入仍会拒绝。

`present` 继续使用官方执行器与 `deliverables/presented` 事件；插件把 Linux 绝对路径、相对路径、`~/` 和挂载盘路径转换为 Windows 可访问的路径，保留说明、文件限额、普通文件校验和点击预览/打开行为。指向其它发行版的 UNC 路径会拒绝。

修改列表会自动汇总文件工具的成功修改；独立文件卡片仍由模型调用 `present` 发布交付文件，不会自动为每个源码改动发布卡片。仅通过 bash 修改文件时，非 Git 目录没有文件工具的前置捕获；需要独立卡片时仍可明确要求模型调用 `present`。

## 配置字段

在 profile 的 `cordis.patch.yml` 里覆盖插件行的 `config`：

```yaml
- id: dsh-remote-wsl
  name: 'dsh-remote-wsl'
  config:
    terminal: true
    tools: true
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `terminal` | `true` | WSL 工作区的侧栏终端是否开在发行版里 |
| `tools` | `true` | 是否为 WSL 工作区的会话启用 Linux 侧工具 |
| `execTimeoutMs` | `15000` | 单次 `wsl.exe` 调用超时（毫秒） |
| `distroCacheMs` | `5000` | 发行版列表缓存时间 |
| `maxEntries` | `2000` | 目录选择器单层最多返回的条目数 |
| `maxReadBytes` | `2000000` | `read` 工具单次最多返回的字节数 |
| `defaultDistro` | `''` | 预留：默认发行版覆盖（空 = 使用 WSL 默认） |
| `mountRoot` | `''` | automount 根（空 = 读发行版 `/etc/wsl.conf`，回退 `/mnt`） |
| `remote` | `false` | 是否允许非回环地址的客户端调用插件路由 |

## 工作原理

- **入口**：占用官方工作区组件声明的两个 single 插槽 `sidebar.workspaces.directoryFlow` 与 `conversation.hero.workspace.directoryFlow`，用比官方占用者更低的 `priority` 渲染自己的「本地文件夹 / 连接 WSL」选择框；弹窗画在 `shell.overlay` 里。选「本地文件夹」时调用官方 `ctx.uiWorkspace.pickDirectory()`（或桌面注入的 `__DSH_DIRECTORY_PICKER__`），所以原生选择器行为不变。
- **Host 路由**：`GET /dsh-remote-wsl/{status,distros,warm,list}` 与 `POST /dsh-remote-wsl/connect`。全部同源 JSON、拒绝跨站、默认只接受回环地址；`connect` 通过官方 `workspaceRegistry.create()` 登记工作区。
- **身份探测**：`wsl.exe -d <发行版> --exec bash --noprofile --norc -c "printf '%s\n' '<哨兵>' \"$WSL_DISTRO_NAME\" \"$(id -un)\" \"$HOME\""`，失败时回退读 `/etc/wsl.conf` 与 `/etc/passwd`。
- **目录浏览**：直接走 `\\wsl.localhost` 共享；共享拒绝时回退到发行版里的 `find`。
- **终端**：包装官方 `subprocess.spawnTerminal`，只替换 cwd 落在 WSL 工作区时的 argv；其它终端原样通过。官方升级若改了这个内部方法，终端退回 Windows shell，连接流程不受影响。
- **工具**：在 `agent/created` 时解析会话 cwd，命中 WSL 工作区就在该 agent 作用域内注册 Linux 工具（作用域工具遮蔽全局同名工具，不影响其它会话），并用 `tools.restrict` 隐藏 Windows shell。写操作按 `ctx.sandboxPolicy.resolve()` 的门禁执行：`read-only` 拒绝写入与 bash，`workspace-write` 只允许工作区（或临时目录）内的目标，`danger-full-access` 放行。

工具的目录门禁只检查 `write` / `edit` 的目标路径，不是 Linux 进程隔离：`workspace-write` 下的 bash 仍以发行版用户权限运行，不能当作操作系统沙箱使用。

## 已知限制

- **agent 进程仍在 Windows 上**。DSH 没有在 WSL 里运行 Host/Agent 的协议；本插件把该会话的 shell 与文件工具代理到 `wsl.exe`，其它工具（web、subagent、todo 等）仍是 DSH 原生实现。
- **`bash` 每次调用是新 shell**，`cd` / `export` 不跨调用保留；请在同一条命令里串联，或使用 `workdir`。
- **不支持后台 bash**（没有 `run_in_background`）。
- **`working_directory` 工具不识别 Linux 路径**（v1 限制）；需要换目录时在 bash 命令里 `cd`。
- **写入不触发 DSH 的越权写审批升级**：超出工作区的写入直接拒绝，需要时请把会话权限切到「完全权限」。
- **WSL 1 不支持**：`/mnt` 之外的共享路径不可靠，选择器会提示升级到 WSL 2。
- 文件树、代码预览、变更记录等仍由 DSH 在 Windows 侧通过 9P 共享读取，目录很大时会比原生 Linux 慢。
- 发行版第一次被访问时会自动启动（可能等待数秒）。

## TypeScript 开发

维护源码位于 `src/`。Host 入口、WSL 服务与工具为 TypeScript ESM；浏览器源码是 `src/client.ts`，编译后仍通过 DSH 的模块加载器使用宿主 React；恢复 CLI 为 `src/scripts/repair-legacy.cts`。

```powershell
npm ci
npm run check # 构建插件，再严格检查 TypeScript 测试与构建脚本
npm run build # 生成 DSH 可直接加载的 JavaScript 和 Host 类型声明
npm test      # 构建、入口/配置检查及现有行为回归
npm pack      # 打包前自动构建
```

要求 Node.js >= 24.9.0。业务源码、构建脚本和测试全部使用 TypeScript；先前根目录与 `lib/` 下的 JavaScript 文件已删除。所有 JavaScript 和 Host 声明只生成到 Git 忽略的 `dist/`，不提交生成产物。`package.json` 的公开入口指向 `dist/`，打包前自动构建，安装包只携带运行所需的编译产物和静态资源。构建不依赖旁边的 DSH 源码仓库。

恢复 CLI 的源码是 `src/scripts/repair-legacy.cts`，运行入口是构建后的 `dist/scripts/repair-legacy.cjs`；它仍默认只报告，只有显式 `--apply` 才修改日志。

插件导出 Cordis 支持的 Standard Schema `Config`，保留原有配置字段、默认值和输入归一化。开发类型依赖使用与验证用 Desktop 相同的 Cordis 4.0.5；Host 与浏览器运行时均使用 DSH 提供的服务实例。

本地链接安装后，源码修改需要先构建；Host 更新仍需完全退出并重启 DSH，浏览器更新后刷新页面。`npm test` 中真实 WSL 部分在 WSL 不可用时会跳过；下面两个 Desktop 集成测试要求真实 WSL，缺少环境时失败。

## 测试

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
$exe = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"
& $exe test\pure.test.ts         # 纯函数（发行版解析、路径映射、wsl.conf/passwd）
& $exe test\run.ts               # Host 服务 + 真实 WSL（身份、目录、bash）
& $exe test\tools.test.ts        # 工具运行时 + 真实 WSL（write/read/edit/glob/grep/bash/沙箱门禁）
& $exe test\registration.test.ts # 注册层（agent 作用域工具集、终端路由包装）
& $exe test\desktop-runtime.cts | Out-String # 已安装 DSH 的真实 Agent/工具执行链 + 真实 WSL；无模型费用
& $exe test\desktop-deliveries.cts | Out-String # 真实文件变更摘要、diff、present 交付事件；独立 WSL 测试目录
```

没有 `node.exe` 在 PATH 上时用 DSH Desktop 自带的 Electron 以 Node 模式运行（如上）。真实 WSL 不可用时相应小节显示 skipped。

`test/desktop-runtime.cts` 必须通过已安装的 DSH Desktop 可执行文件运行，要求可访问 WSL，缺少环境时失败而不跳过。测试替换模型网络响应，保留 DSH 的真实 Cordis、Agent 循环、inbox、工具注册、工具执行和 subprocess 服务，覆盖新会话完成对话、内存 inbox 恢复，以及多帧 Zstd 磁盘损坏拒绝、写锁互斥、备份、修复后官方读取。对话在内存中创建，在 Linux HOME 执行只读命令；磁盘测试只使用临时目录，不改变桌面端会话和用户项目。

## 更新日志

版本变更见 [CHANGELOG.zh.md](CHANGELOG.zh.md)。

## 许可证

MIT
