# AGENTS.md — DeepSeek Harness 插件开发规范

> 适用范围：在本仓库（`dsh-remote-wsl`，一个真实的树外 DSH 插件）以及本目录下新增/维护 DeepSeek Harness（DSH）插件时工作的 AI agent 与人类开发者。
> 基线环境（源码与类型的核对基准）：DSH Desktop `0.2.1-rc.5`、Cordis `4.0.5`、内置 Node `24.21.0`；本仓库自身要求 Node `>= 24.9.0`。
> 参考真源：DSH 上游源码仓库 https://github.com/deepseek-ai/deepseek-harness（只读）。上游处于 developer preview，**API 与文档都可能滞后于代码**。
> 规则强度标注：**【硬规则】** 违反会加载失败、行为错误或卸载不干净；**【约定】** 官方设计原则或强烈推荐；**【本仓库】** 只约束本仓库的实现。

## 0. 事实优先级与决策方式

处理任何 API/行为问题时，按以下顺序取证，**不要凭记忆或猜测写代码**：

1. 已安装 DSH 的实际类型与源码：`<安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-*`；上游源码仓库的 `packages/**`（`src/` + `README.zh.md`）。
2. 官方插件作者文档：上游仓库 `docs/user/develop/{basic,framework,practice}/**`（基础教程、服务/事件、能力分层）。
3. 仓库内规范与子系统参考：`docs/subsystems\**`、`docs\defensive-patterns\**`、`docs\cookbook\**`、`packages\client\AGENTS.md`，以及官方技能 `packages\preset\agent-preset\skills\cordis-plugin-development\**`。这些是**观察**级证据：机制真实，但对外部插件不构成承诺。
4. 本文件：工程约定与落地口径。与 1–3 冲突时以事实源为准，并在交付说明中指出文档偏差。

**关键前提**：上游是 developer preview，任何"未文档化但可用"的内部能力都要按"可能断裂"处理；新增依赖前先确认目标 DSH 版本上的真实形状，并保留降级路径。

## 1. 不可协商的硬规则

1. **入口导出形态唯一**：函数插件用命名导出 `name` / `inject` / `Config` / `apply`，**不得**再加 `export default`；对象形态或 `Service` 子类才用 default export。两种形态不得混用。（Loader 的 `unwrapExports` 取 `exports.default ?? exports`，多余的 default 会连同 `inject`/`name`/`Config` 一起被丢弃。）
2. **一切注册都是 effect**：路由、工具、事件、终端包装、样式、slot、locale、定时器、watcher 全部经 `ctx.effect` / `ctx.on` / 注册 API 的 disposer 管理；卸载后必须恢复干净，且 disposer 可重复调用。
3. **依赖显式**：必需服务写进 `inject` 并用 `ctx.<service>` 读；可选/未声明服务只用 `ctx.get(name)`，并对 `undefined` 显式分支。不得访问未声明的服务属性。
4. **不制造第二份运行时**：Cordis、React/ReactDOM、DSH 服务实例由宿主提供；浏览器侧只 `require('react')` / `require('react-dom')`，宿主侧只用 `import type`。禁止安装/打包第二份副本。
5. **包契约完整**：bundle 必须声明 `dsh.bundle.patch`，`files` 覆盖 patch、locale、icon 与全部运行时文件；以 npm/git 分发必须声明 `engines.dsh`；带浏览器半侧必须声明 `dsh.client` 并导出 `./client`。
6. **patch 语法正确**：`cordis.patch.yml` 是 mapping 数组，用 `insert` 追加行；带 `id` 的覆盖是**整块替换 `config`**（不深合并）；`!!js` 只在 `config` 与 `disabled` 中有效，其余元数据保持字面量。
7. **配置是 Standard Schema**：`Config` 必须是 Standard Schema 验证器（推荐 `@deepseek-ai/schemastery`），默认值写进 schema；非法配置应在加载期响亮失败。把部署相关的可调参数做成配置字段，禁止硬编码。
8. **工具遵守统一契约**：优先 `defineTool`；`parameters` 是 JSON Schema 规约，`execute` 返回 `output.schema` 声明的规范值，`output.render` 负责模型可见内容；必须观察 `exec.signal` 并支持取消；`presentCall`/`presentResult` 必须是纯函数。
9. **浏览器产物是惰性工厂**：`window.__ModuleLoader__.load({ id: '<包名>', factory(require) { … } })`，`id` 等于包名；模块级不得有副作用，CSS/监听/定时器都在 `apply` 内注册。
10. **文案走 locale 服务**：运行时 UI 文案必须经 `ctx.locale.register(ns, { zh, en, … })`（`zh`、`en` 必须完整）并提供给组件；`locale/*.json` 只承载插件展示元数据，二者不可混用。
11. **用户可见变更必须同步文档**：`README.md`/`README.zh.md` 与 `CHANGELOG.md`/`CHANGELOG.zh.md` 成对更新；配置字段变化必须同步配置表；公开行为（工具名、路由、配置字段、slot、插件 ID）变更必须升版本并在两份 changelog 说明。
12. **只报告实际执行过的验证**：跑什么写什么；跳过（skipped）不得记作通过；不把构建成功、安装成功或 slot 注册成功当作功能已验证。

## 2. 插件模型与入口契约 【通用】

- **三种形态**，选一种并保持：① 函数形态——命名导出 `apply(ctx, config)`，可选 `export const name` / `export const inject` / `export const Config`；② 对象形态——`export default { name, inject, apply }`；③ 服务形态——`export default class X extends Service`。
- 本仓库及新增插件**统一采用函数形态**（`src/index.ts` 已如此）；只有需要向其他插件提供服务时才用服务类。
- `name` 是诊断用显示名（可省略，但本仓库要求写，且等于包名/插件 ID）；`inject` 决定加载门槛；`Config` 决定配置校验。
- 依赖顺序只由 `inject` 表达：**不要**依赖 patch 文件中的行顺序——各配置项并发启动，位置不决定加载先后。
- 插件行（patch 中的 `name`）是模块说明符：已安装 bundle 用**包名**；本地 `--patch` 调试用**绝对路径**（相对路径的解析基准在不同文档中不一致，不要依赖）。
- `apply` 内完成同步注册；异步初始化放进 `ctx.effect` 并自行处理失败，不要留下"半初始化"状态。
- 模块顶层只放纯常量和纯函数；**禁止**模块级可变状态（它在热重载/多实例之间是伪单例），状态放进 `apply` 闭包或声明的 store。

## 3. 包与 manifest 契约 【通用】

最小可用 bundle：

```jsonc
{
  "name": "dsh-my-plugin",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./client": "./dist/client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["dist/", "cordis.patch.yml", "locale/*.json", "icon.svg", "README.md"],
  "engines": { "dsh": ">=0.2.0 <0.3.0", "node": ">=24.9.0" },
  "peerDependencies": { "@deepseek-ai/cordis": ">=4.0.5 <5" },
  "devDependencies": { "@deepseek-ai/cordis": "4.0.5" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-workspace"] }
  }
}
```

字段规则：

- `dsh.bundle.patch`：单个路径或**有序数组**（同一层的多个 patch，按序应用；每份 patch 内的相对行路径相对该文件解析）。
- `engines.dsh`：SemVer 范围；安装与 profile 启动会据此拒绝不兼容 bundle。没有它时改为检查 `@deepseek-ai/dsh*` peer 范围——**这是兜底，不是替代**。
- `dsh.client`：`platform` 必填（Web 用 `'web'`）；`inject` 是**信息性包名依赖边**，不是 Cordis 服务注入；`immediately` 把该 bundle 放进启动第一阶段预取（先于共享 application 批次物化），功能插件并非必需（官方装饰模板设为 true，本仓库亦为 true）——按"是否需要更早可用"选择，不要用它表达依赖顺序；`external` 精确声明超出客户端 baseline 的运行时模块请求（baseline 已含 `react`、`react-dom`、`@deepseek-ai/cordis` 等，**不要重复声明**，也不要用它做跨插件依赖）。
- 展示元数据：`locale/en.json` 是发现入口（`meta.title` / `meta.description`，可选 `meta.detail` 指向包内子目录的 Markdown）；`icon` 支持 SVG/PNG/JPEG/WebP，**≤256 KiB 且必须位于包内**；`../`、绝对路径、URL、逃出包的符号链接一律被拒。
- `files` 必须覆盖运行时真正 import 的每个文件与资源；发布/打包前核对实际 packed 列表。以 `link:`/本地目录安装时 `files` 不过滤 checkout，产物必须真实存在。
- 等价的 DSH 包（需要与宿主共享实例的）同时放进 `peerDependencies` 与 `devDependencies`（peer 由宿主解析，dev 供类型检查与独立测试）；需要独立版本的第三方依赖放 `dependencies`。
- 未文档化的 bundle 字段（`dsh.manifestVersion`、`dsh.bundle.platforms`、`dsh.bundle.listedByDefault`）存在于类型但不在用户文档中：**除非已验证目标版本行为，不要使用**。
- 若要进入官方插件市场索引：包不得设置 `"private": true`（生成器会跳过），并应声明 `dsh.bundle` 与真实版本号。本仓库当前为 `private: true`（只走本地/git 安装），这是**有意选择**，不要顺手改掉。

`cordis.patch.yml` 形状：

```yaml
- insert:
    - id: dsh-my-plugin
      name: dsh-my-plugin
      config:
        someFlag: true
```

- 行字段只有 `id` / `name` / `config` / `disabled` / `inject` / `intercept` / `isolate`，**没有顶层 `rows` 键**。
- 覆盖别人的行要带 `id` 并**重述整块 config**；不深合并是刻意设计。
- 层序：profile 的 `dsh.profile.bundles` 列表 → profile 自己的 `cordis.patch.yml` → home 级 `$DSH_HOME/cordis.patch.yml` → 每个 `--patch` overlay（按 argv 顺序）。后应用者按行胜出。
- 用户可以用更高层的 patch 覆盖你的行；因此默认值要给"用户大概率保留"的值，其余交给 schema。

## 4. 生命周期与副作用纪律 【通用】

- Fiber 状态：`PENDING → LOADING → ACTIVE`，`LOADING → FAILED`，`ACTIVE → UNLOADING → DISPOSED`。**插件"没反应"先查 fiber 是否为 PENDING**（缺 `inject` 服务时它静默等待，不报错）。
- `inject` 是硬依赖：服务在运行期消失时插件自动卸载，恢复后自动重载。可选能力不要放进 `inject`。
- 可选依赖两种写法：`ctx.get('name')` 在使用点探测；或 `ctx.inject([...], (inner) => { … })` 只在依赖可用期间注册一段逻辑（本仓库用后者包裹可选能力，见 `src/index.ts`）。
- 自定义资源必须包进 `ctx.effect(execute, label?)`；`execute` 返回 disposer，在卸载（含热重载）时运行。已经由 `ctx` 管理的注册**不要**手动 `removeListener`/`clearInterval`。
- **异步 disposer 之间是并发的**（只有"开始调用"按注册逆序）。有先后依赖的清理必须放进同一个 `ctx.effect` 的同一个 disposer 里串行 await。
- 包装宿主方法（monkey-patch）的铁律：保存原值 → 安装包装 → disposer 里**确认仍是自己的包装**再还原；宿主方法缺失时记一次警告并降级，**绝不**让插件因包装失败而不可用（范式见 `src/lib/terminal.ts`）。
- 插件要改自己的配置，用 `ctx.get('configEditor')` + `ctx.fiber.entry`；**绝不能**读取/改写 profile 的 `cordis.patch.yml`，也不要从包目录向上查找它（那是用户的文件）。
- 热重载会卸载旧实例再执行新 `apply`；因此**不要**把状态挂在模块作用域或全局对象上。

## 5. Host 侧能力

### 5.1 服务与事件 【通用】

- 消费服务：必需走 `inject`，可选走 `ctx.get`。提供服务的插件用 `Service` 子类并通过声明合并给 `ctx.<name>` 补类型。
- 事件命名遵循 `namespace/action`；四种模式按契约选择：`emit`（广播）、`bail`（首个非空短路）、`serial`（顺序 await）、`waterfall`（流水线）。**waterfall 监听器必须调用 `next()`**，不调用即短路（拦截是刻意用法）。
- `turn/*`、`step/*`、`tool/call`、`tool/result`、`compaction/*` 是**持久化会话事件**，不是 Cordis 事件；要观察它们就监听 `session/event` 并检查 `event.type`。
- 新事件/新服务键要用声明合并补类型，不要靠 `any` 桥接。

### 5.2 工具 【通用】

- 优先 `ctx.tools.register(defineTool({ … }))`；注册返回 disposer，随插件卸载注销。
- `parameters` 用工具 DSL（`required: true` 表必填）；schema 表达不了的约束（非空字符串、正数、跨字段）在 `execute` 里手写检查。
- `execute` 只返回**规范值**（不要返回内容块，也不要让调用方解析自然语言）；`output.render` 才产出模型可见内容，`presentationMeta` 承载卡片元数据。
- 必须观察 `exec.signal`：abort 时取消并停稳；长任务用 `ctx.jobs.start()`，取得 job id 后改用任务自有取消信号。
- 失败语义：基础设施故障抛异常；可预期的业务失败写进规范值由渲染器解释。工具名唯一，`run_code` 是保留名。
- `presentCall`/`presentResult` 是纯函数（流式与回放都会跑）：只依赖 `args`/`result`，不做 I/O、不读会话状态、不用时钟/随机数。
- **Web 内置客户端不消费 presenter**：要专用卡片，必须在 keyed slot `tool.call.toolview` 注册客户端组件；只写 Host 侧展示方法不会出现 UI。
- 要挂到 agent 作用域（见 5.5）时，可以手写 `ToolDefinition`，但必须满足与 `defineTool` 相同的契约，并且不得注册后再修改定义或替换回调。

### 5.3 HTTP 路由 【通用】

- 用 `ctx.webServer.register({ kind: 'prefix', path: '/<plugin-id>', handler })` 注册，直接返回其 disposer。
- 默认只允许回环来源；对外暴露必须是显式配置项（本仓库为 `remote`）并写进 README。
- 同源/Host/Origin/cookie 的可信判定交给宿主 `ctx.connection.requestRejection(req)`，不要自己写一套。
- 请求体设上限（本仓库 64 KiB），超限先 `req.resume()` 再拒绝；响应统一 `application/json; charset=utf-8` + `cache-control: no-store`。
- 错误返回稳定 `code`，由插件集中映射到 HTTP 状态码；**不要**把内部路径、命令输出或堆栈直接回给浏览器。
- 所有路由前缀、错误码、请求/响应字段属于公开契约：改动即破坏兼容。

### 5.4 文件与进程 【通用】

- 写文件走宿主文件事件链：`fs/write-intent` / `fs/edit-intent`（waterfall，拿 `ctx.fs.resolve` 的 target）→ 发布（临时文件 + 原子 rename）→ `fs/observed`。不要绕过读后写/版本检查：版本不匹配（`FS_STALE_VERSION`）、未观察到的已存在文件（`FS_NOT_OBSERVED`）必须照旧拒绝。
- 复用官方 presenter 时只包装 `execute`，保留原 `output`/`presentCall`/`presentResult` 引用；`present` 只做路径映射后交给官方 executor。
- 子进程一律用 **argv 数组**，绝不拼 shell 字符串；设置超时与 abort 传播、限制 stdout/stderr 体量、按需处理 UTF-16/编码；`wsl.exe` 等工具的输出解析要容错。
- **沙箱策略**：读 `ctx.sandboxPolicy.resolve({ session })`；`read-only` 拒绝写与命令，`workspace-write` 只允许工作区内（或明确的临时目录），`danger-full-access` 才全放行。插件**不得**放宽策略；策略不可用时按最严格处理（或显式报错），不得静默升级为全权限。
- 注意：安装插件 = 宿主进程内运行任意代码，**不受工作区沙箱约束**；沙箱只约束插件产生的文件效果。

### 5.5 会话级注册 【本仓库确认的范式】

本仓库在 `agent/created` 时按会话 cwd 决定是否注入 Linux 工具集，要点可作模板：

- 只在**命中目标的 agent 作用域**注册：作用域取 `agent.ctx` → 监听器 `this` → 放弃；**绝不回退到插件 ctx**（否则工具会泄漏到所有会话）。
- 判断工具可见性必须带 agent（`tools.get(name, agent)`），因为预设里的同名工具属于父作用域。
- 遮蔽宿主工具用 `tools.restrict({ deny })`，`deny` 只填实际存在的名字。
- 每个注册单独 `scope.effect(...)` 并带标签（`'<plugin-id>: tool <name>'`），便于拆卸与排障。
- 向会话注入说明必须用**结构化消息** `{ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin:<id>' } }`，不要塞裸字符串。
- 这类依赖 `agent/created`、`agent.ctx`、`agent.inbox.*`、`tools.restrict`、`subprocess.spawnTerminal`、`ctx.get('fs' | 'sandboxPolicy' | 'workspaceRegistry')` 的用法**不在官方插件作者文档的承诺面内**：必须窄端口 + 运行时形状校验 + 缺失降级 + README 的 Known limitations，并在 DSH 升级时优先复核。

## 6. Client 侧开发

- 产物形态（classic script，无 `import`/`export`）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-my-plugin',            // 必须等于包名
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    return {
      inject: ['slots', 'locale'],   // 客户端 Cordis 服务依赖
      apply(ctx) { /* 在 effect 里注册 slots / locale / 样式 */ },
    };
  },
});
```

- 工厂必须是**惰性**的：执行 bundle 只注册工厂，模块体副作用（含 CSS 注入）在 `apply`/工厂内部；组件用 `React.createElement` 或构建期 JSX 均可，但 React 实例必须来自宿主。
- 只有**以裸包名挂载的 Loader 行**才会获得浏览器半侧；子路径行永远不带半侧。发布前必须构建产物，Host 提供的是 `./client` 构建文件而非源码。
- 非 baseline 的运行时模块请求必须在 `dsh.client.external` 里精确声明；类型导入被擦除、不产生请求。**不要** require 其他功能插件的值，也不要为拿到它们而滥用 `external`——跨包行为走服务，UI 走 slots。
- **Slots**：
  - 注册进别人的位置必须 `ctx.slots.inject(key, () => ctx.slots.register({ name: key, … }, Component))`；直接注册未声明 slot、或重复声明别人拥有的 child 都会在激活期失败。
  - 基数与作用域是两维：`single` / `list`（必填 `id`，按 `order` 再按注册顺序）/ `keyed`（owner 传 `entryKey`）/ `chain`（`select(owner)` 选举）；scope 为 `root` / `session-maybe` / `session`。`priority` 对前三种是遮蔽优先级（数值越小越先），对 `chain` 是选举顺序。
  - `root` 是唯一由外壳渲染的内建 key；**不要**替换 app root 或向 `document.body` 追加第二个应用。
  - 组件**拿不到 `ctx`**：数据经 owner props、标准 scope props、注册项 `inject`、声明的 `store`、`locale` 的 `t`、chain 的 `matched` 传入；组件内不要自建订阅或 selector。
  - store 句柄在 `apply` 内创建并显式传给注册项；模块级 store 句柄（伪单例）禁止。
- **样式**：跟随宿主主题 token（`--dsw-*` 语义别名），避免字面颜色（artwork 除外）与全局覆盖；本仓库用插件自持 `<style data-plugin-css="<plugin-id>/client.css">` 并在 disposer 中移除；尊重 `prefers-reduced-motion`。
- **i18n**：运行时文案用 `ctx.locale.register(ns, { zh, en, … })` 注册命名空间（`zh`/`en` 必须完整），slot 注册项声明 `locale: ns` 后组件获得 `t`；不得硬编码用户可见文案。`locale/*.json` 只是插件市场的 `meta.title`/`meta.description`。
- **与 Host 通信**：`fetch` 用 `credentials: 'same-origin'`，路径用根相对前缀（文档 URL 可能嵌套），非 2xx 解析结构化错误；用 epoch/序号丢弃迟到的响应；不要让 UI 直接触碰 Host 内部对象。
- **可访问性**：dialog/overlay 要有焦点陷阱、Esc 关闭、合理的 aria 标签与键盘可达性（本仓库的 picker 是可直接参考的实现）。
- 测试缝隙：本仓库通过工厂返回值的 `__test` 暴露纯函数供无 DOM 测试；生产导出面保持最小。

## 7. 配置规范 【通用 + 本仓库口径】

- 导出同名 `Config` 类型与 Standard Schema 值；默认值写在 schema 中；`apply(ctx, config)` 收到的是校验后的完整配置。
- 新增字段的检查清单（缺一不可）：`WslConfig` 接口 → `DEFAULTS` → `resolveConfig` 归一化 → README/README.zh 配置表 → 一条 `Config['~standard'].validate`（或 schema）断言。
- **非法配置要响亮**：schema 能表达的约束就表达，让错误在加载期暴露。
  - 【本仓库现状】`resolveConfig` 采用**宽容归一化**（不合法即回落默认值，`'2500'` → `2500`），这是既有的兼容决定：新增字段若继续宽容，必须在注释与 README 中写明"拼错的键会静默失效"；任何"看起来合法但被误解析"的输入都要补测试。
- 字段变化触发插件卸载/重载；`volatile` 字段原地更新、用 `.get()` 读取，适用于"每次操作读取、变更不需重启"的值。`volatile` 只能声明在固定路径上，不能存函数/类实例/循环引用。
- 配置里**不放密钥**：用 credentials 服务记录。
- 用户层 patch 会整块替换 `config`：给出安全的默认值，让用户覆盖时不必重述所有键。
- 本仓库已知死配置（勿据此设计新功能）：`distroCacheMs` 无消费者——定义在 `src/config.ts`，实际 TTL 是 `src/lib/wsl-detect.ts` 里硬编码的 5000ms；`defaultDistro` 默认空串，只在 UI 里标记默认发行版行，不参与发现/连接决策；修它们需要单独的变更与文档更新。

## 8. 类型、依赖与构建

- TypeScript：全部工程 `strict` + `noEmitOnError`；`verbatimModuleSyntax`；ESM 相对导入带 `.js` 后缀；CJS 用 `.cts`；不新增 `@ts-nocheck`/`@ts-ignore`/`as any`（确有必要的逃逸口必须带注释说明并限定范围）。
- 边界策略：宿主类型只 `import type`；外部输入（HTTP body、配置文件、子进程输出、模型参数）一律 `unknown` + 运行时校验收窄；插件自有的端口类型集中在 `src/contracts.ts`（本仓库范式）。
- Host 与 Client 分属不同编译面（本仓库：`tsconfig.host.json` / `tsconfig.client.json` / `tsconfig.cjs.json` / `tsconfig.test.json`），不要互相 import 实现。
- 依赖声明：共享运行时（Cordis、React 等）peer + dev；独立第三方库放 `dependencies`；`engines.node` 与 `engines.dsh` 必须与真实支持范围一致；**禁止** `file:`、本机绝对路径或"要求旁边有 monorepo"的构建配置。
- 产物：只生成到被忽略的 `dist/`，不提交构建产物；公开入口全部指向 `dist/`；`prepare`（git 安装）与 `prepack`（打包）必须自包含、不依赖开发机环境。
- 打包自检：`npm pack` 后核对 tarball 是否包含 patch、`dist/`、`locale/`、`icon.svg`；用 tarball 安装验证一次真实加载。
- 代码风格：跟随同文件既有风格，不做全仓格式化；新增文件保持小模块、单一职责；不引入 formatter/linter 依赖。
- 最小权限依赖：新依赖必须说明理由并确认 host 侧不会引入第二份运行时；优先零依赖实现。

## 9. 测试与验证

分层要求（不是所有改动都要跑全部，但**必须匹配改动面**）：

1. **纯函数/单元**：解析、路径映射、归一化等无副作用逻辑。
2. **契约与 Loader 冒烟**（必做）：用真实 Cordis `Context` 加载**构建产物**，断言路由/工具注册发生、`dispose` 后全部清理；断言 `Config` 是 Standard Schema 且现有配置可被接受；断言 `package.json` 的 `exports` 文件真实存在。
3. **入口导出守卫**：至少一条测试断言入口模块**没有** default 导出（`'default' in mod === false`）并走一次 `Loader.unwrapExports` 往返；这条守卫必须"能咬人"——临时引入回归看到它变红，再撤销。（本仓库当前尚未覆盖，新增/修改入口时补上。）
4. **浏览器产物**：在 `vm` 中执行 `dist/client.js`，用假 `__ModuleLoader__` 捕获注册定义，断言 `id` 等于包名、工厂只 `require` 宿主提供的模块、返回对象含 `apply`；断言 slot/locale 注册与卸载顺序。
5. **真实环境集成**（有环境才跑）：通过已安装 DSH 的真实 Agent/工具链，或真实文件系统/子进程路径验证端到端行为；缺环境时**失败或明确 skipped**，绝不冒充通过。
6. **UI 变更**：在真实运行中的 `dsh web` 页面验收（不是裸 Vite、不是另一个端口）；安装成功、slot 注册成功都不等于用户看得见。

硬性要求：

- **必须走真实入口路径**：手工 `ctx.plugin({ inject, apply })` 的测试测不到 Loader 的导出归一化与真实服务解析；每类插件至少一条测试经过真实 Loader/组合装载路径（官方 postmortem 0001 的教训）。
- 回归测试先证明它能失败：修 bug 先写会红的用例。
- 只 mock 昂贵/不确定的边界（模型、网络、时钟）；宿主核心（工具注册表、文件事件、Cordis）保持真实。
- 测试隔离：临时目录、不触碰用户会话与项目文件；结束后释放资源（含失败路径）。
- 断言行为与用户可见输出，不断言实现细节；跳过要打印 `skip …`，报告里如实呈现。

本仓库命令（详见第 12 节）：

```powershell
npm run build     # tsc：host → client → cjs，产物进 dist/
npm run check     # build + 严格类型检查 test/ 与 scripts/
npm test          # check + 进程级测试（所有测试读 dist/，必须先构建）
```

## 10. 安全与隐私

- **最小暴露**：Web 路由默认仅回环、同源；跨机访问必须是显式配置并有文档警告。
- **输入不可信**：模型参数、HTTP body、配置文件、第三方文本、插件市场内容一律按不可信处理；路径要做包含性校验（拒绝 `..`、跨发行版/跨盘 UNC、逃出包/工作区的符号链接），命令只走 argv。
- **凭据**：不放配置、不进日志、不进错误消息；需要时用 credentials 服务。
- **权限**：不得绕过或放宽宿主沙箱策略；需要提权时必须由用户显式批准，不得静默降级。
- **数据最小化**：只读取完成任务所需的文件；不自动上传用户数据/会话内容；遥测必须显式且经同意。
- **安装即执行**：git 安装的 `prepare` 脚本以宿主用户权限在沙箱外运行；README 必须告知用户授权风险，并建议锁定 commit（`github:you/plugin#<sha>`）。
- **UI 安全**：不替换 app root、不注入远程脚本、SVG 图标自包含（无脚本/外部引用/`text`/`foreignObject`）。

## 11. 兼容、发布与文档

- API 处于 pre-stable：升级 DSH 后优先复核本插件依赖的**未文档化面**（第 5.5 节清单）；`inject` 键、事件名、服务方法形状变化都要有降级路径。
- 版本与兼容：遵循 SemVer；公开行为破坏性变更必须升 minor/major 并在两份 CHANGELOG 说明；`engines.dsh` 与 peer 范围随支持范围更新。
- 重启语义：Host 侧代码变更需要**完全退出并重启 DSH**（`link:` 只保证文件被读取）；浏览器侧变更刷新页面；替换已安装的包需要重启才能加载新的模块代；新装 bundle 可以经 HMR 生效。安装/启用后要区分 `application: applied` 与 `restart-required`，不要假设已生效。
- 文档：README 章节顺序固定（功能 → 安装 → 文件改动/交付 → 配置字段 → 实现说明 → 已知限制 → 开发/测试 → 变更日志 → 许可）；README 与 CHANGELOG 的中英版本必须同改并保持章节镜像；新增限制、已知偏差写进已知限制。
- 发布渠道：本地目录 / `npm pack` tarball / npm registry / `github:<owner>/<repo>#<sha>`；以预构建产物分发可免除用户端的构建授权。
- 验收记录只写实际执行的命令与计数；跳过、未验证项要显式列出。

## 12. 本仓库（`dsh-remote-wsl`）专属约定

**目录职责**

| 路径 | 责任 |
|---|---|
| `src/index.ts` | Host 入口：`name` / `inject` / `apply`，按依赖分三段注册 |
| `src/config.ts` | 配置接口、`DEFAULTS`、`resolveConfig`、Standard Schema `Config` |
| `src/contracts.ts` | 全部宿主端口类型 + 运行时形状校验 + `hostPort()` 适配 |
| `src/lib/routes.ts` | `/<plugin-id>` 前缀 HTTP 路由（同源、回环、64 KiB 上限） |
| `src/lib/agent-tools.ts` | `agent/created` 时按会话作用域注册 Linux 工具集 |
| `src/lib/tool-defs.ts` / `tool-wsl.ts` | 工具定义与执行原语（sandbox 门禁、原子写） |
| `src/lib/wsl-*.ts` | WSL 发现、身份、路径映射、持久映射存储 |
| `src/lib/file-integration.ts` | `fs/*-intent` → 版本检查 → `fs/observed` |
| `src/lib/legacy-inbox.ts` | 显式旧日志修复（默认 dry-run） |
| `src/client.ts` | 浏览器半侧：`__ModuleLoader__` 工厂、两个 hole + overlay、内联样式与词典 |
| `types/client.d.ts` | 浏览器侧自有边界声明（React 只 `import type`） |
| `src/scripts/repair-legacy.cts` | 恢复 CLI 源码（编译为 `dist/scripts/repair-legacy.cjs`） |
| `scripts/build.ts` | 构建编排：host → client → cjs，`--check` 追加测试类型检查 |
| `test/*` | 见下方测试矩阵；全部读 `dist/` |
| `locale/{en,zh}.json` | 插件市场展示元数据；`icon.svg` 为包图标 |

**必须保持的常量与公开契约**：插件 ID / 包名 / 模块 `id` / 路由前缀 / 消息 `source.kind` / 日志前缀统一为 `dsh-remote-wsl`；工具名固定 `bash` / `edit` / `glob` / `grep` / `read` / `write`；`deny` 固定 `['pwsh']`；slot 常量固定（两个 hole `sidebar.workspaces.directoryFlow`、`conversation.hero.workspace.directoryFlow`，overlay `shell.overlay`，`priority: -100`、`order: 5`、locale 命名空间 `dshRemoteWsl`）；配置字段名与 README 表格一一对应。改动这些即属破坏性变更。

**测试矩阵**：`node --test test/build.test.ts`（Cordis 加载 + 配置 schema + 入口/浏览器产物）、`test/client.test.ts`（vm 内浏览器注册与纯函数）、`test/pure.test.ts`（路径/解析纯函数）、`test/run.ts`（服务层 + 真实 WSL，可 skip）、`test/tools.test.ts`（工具运行时 + 真实 WSL）、`test/registration.test.ts`（注册层 fake）；另有两个必须用已安装 Desktop 以 `ELECTRON_RUN_AS_NODE=1` 运行的集成测试 `test/desktop-runtime.cts`、`test/desktop-deliveries.cts`（要求真实 WSL，缺环境**失败**而非跳过）。无 `node` 时用 Desktop 可执行文件跑同一批入口。

**本仓库已知偏差（改动相关代码时注意，不要盲目"修复"）**

1. `Config` 用手写 Standard Schema（合规）而非 Schemastery；归一化宽容、非法值静默回落（见第 7 节）。
2. 大量依赖未文档化内部面（`agent/created`、`agent.ctx`、`agent.inbox.*`、`tools.restrict`、包装 `subprocess.spawnTerminal`、`ctx.get('fs'|'sandboxPolicy'|'workspaceRegistry')`）：改动需保持降级路径。
3. `sandboxPolicy` 不可用时当前实现降级为 `danger-full-access`；新代码不得复制这一行为（见 5.4）。
4. 缺 `engines.dsh`（只有 `engines.node`）与 `main`；`private: true` 与官方市场索引条件冲突；市场元数据字段直接写在 `package.json`。
5. `distroCacheMs` 是死配置（TTL 实际硬编码）；`defaultDistro` 只用于 UI 标记默认发行版行。
6. 文档漂移：CHANGELOG 仍引用旧 `.cjs` 路径；旧 plan 未标注被后续 plan 取代；Token 级旧文档不要照抄。
7. 工作树是尚未提交的 TypeScript-only 重写 + 被忽略的 `dist/`：新克隆必须先构建才能测试/加载。

需要处理上述任一项时，走独立变更：先确认目标 DSH 版本行为，再改代码 + 测试 + 两语文档 + 版本/changelog。

## 13. 提交前检查清单

- [ ] `npm run check` 通过（构建 + 测试与脚本的严格类型检查）。
- [ ] 相关测试实际运行并记录结果；跳过项已标注；没有把 skipped 当通过。
- [ ] 每个新增注册都有 disposer；卸载路径已测（含包装恢复）。
- [ ] 入口仍是单一形态，无多余 default 导出；`name`/`inject`/`Config`/`apply` 与 manifest 一致。
- [ ] 配置字段变化已四处同步（接口/DEFAULTS/归一化/README 表格）+ 测试。
- [ ] `package.json` 的 `exports`/`files`/`engines`/`dsh.*` 与新增文件同步；`npm pack` 列表已核对。
- [ ] 无第二份 React/Cordis；客户端只 require 宿主模块。
- [ ] 新增路由/路径/命令经过安全自查（同源、回环、上限、argv、路径包含）。
- [ ] 用户可见变更已写入 `README`/`README.zh`、`CHANGELOG`/`CHANGELOG.zh`。
- [ ] `git status` 干净：没有 `dist/`、`test/results/`、临时文件或密钥进入提交。
- [ ] 依赖的未文档化 API 已在 README「Known limitations」或代码注释中标注，并有降级路径。

## 14. 参考资料

- DSH 上游源码仓库（只读）：https://github.com/deepseek-ai/deepseek-harness
  - 插件作者文档：`docs/user/develop/basic/{index,tool,config,publish}.zh.md`、`docs/user/develop/framework/{service,events}.zh.md`、`docs/user/develop/practice/**`
  - 权威类型：`packages\util\package-manifest\src\types.ts`（`dsh.*` manifest）
  - 清单契约与陷阱：`docs\defensive-patterns\package-surface.zh.md`、`docs\postmortem\0001-acp-default-export-drops-inject.zh.md`、`docs\testing.zh.md`
  - 客户端规则：`packages\client\AGENTS.md`、`packages\client\modules\README.zh.md`、`docs\subsystems\slots.zh.md`
  - 官方插件开发技能：`packages\preset\agent-preset\skills\cordis-plugin-development\**`
- 已安装运行时：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\**`
- 在线文档（版本可能领先或滞后于已安装版本）：`https://deepseek-harness.github.io/deepseek-harness/develop/basic/`、`.../develop/framework/service`、`.../develop/basic/publish`
