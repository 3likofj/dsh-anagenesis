# dsh-anagenesis

[English](README.en.md)

面向 DeepSeek Harness 的**可编程记忆编排层（memory-orchestration layer）+ 自我进化引擎（self-evolution engine）**。

`anagenesis` 不是一个"自动记忆插件"。它自带闭环的记忆存储（memory store，既不调用、也不桥接、更不代理任何外部记忆插件），把记忆以**按意图塑形的工具**（intent-shaped tools）暴露给 agent，在**运行时**切换注入策略（injection strategy），并根据观测到的结果调整自己的策略参数 —— 每一次写入、切换与调整都会返回一个逆函数（inverse function）。

```bash
dsh plugin add dsh-anagenesis     # 然后重启 profile
```

安装会注册一个名为 **`anagenesis`** 的 agent 预设（agent preset）；在新会话里选中它即可。

从本仓库以链接方式安装（profile 名以 `desktop` 为例，按需替换）：

```bash
dsh plugin --profile desktop add link:D:/cj/anagenesis          # 主包
dsh plugin --profile desktop add link:D:/cj/anagenesis/window   # 可选：桌面窗口，见「可视化 · 桌面窗口」
```

## 快速开始

1. 安装并重启 profile（见上面的命令）。核心行会把存储建在 `$DSH_HOME/anagenesis/`。
2. 新建会话，在预设列表里选 **`anagenesis`**。这个预设自带记忆工具、护栏（guard）与只读可视化行，并默认激活 `['guard','exploit']` 策略栈（strategy stack）。
3. 正常干活就行：agent 会自己调用 `ana_recall`（按意图召回，recall）与 `ana_remember`（写入）。召回结果由当前作用域上的策略栈塑形，不需要你写查询语言。
4. 想看一眼记忆库：让 agent 调 `ana_dashboard`（一帧 TUI 仪表盘，直接出现在工具回答里）或 `ana_diagram`（可粘贴的 Mermaid / D2 / ASCII 图）；在真实终端里想要持续刷新的版本，就跑 `node tools/viz-watch.mjs --watch`（只读，独立进程）。
5. （可选）需要桌面窗口就装兄弟包 `dsh-anagenesis-window`。**不装也完全可用** —— 预设不会假设它存在。

## 三层结构

| 层 | 模块 | 负责什么 |
|---|---|---|
| 1 · 记忆原语（memory primitives） | `src/memory/ops.js`、`src/memory/recall.js`、`src/store/*` | 按意图召回、remember、promote/demote、lock、expire、split、反事实重思（counterfactual rethink）、forget、link、使用反馈 |
| 2 · 策略引擎（strategy engine） | `src/strategy/builtin.js`、`registry.js`、`engine.js` | 可在运行时注册的纯函数策略（`explore`、`exploit`、`debug`、`distill`，外加不变量 `guard`）、可逆切换、按作用域的策略栈、带谱系的派生 |
| 3 · 元策略（meta-policy） | `src/meta/tuner.js` | 反馈信号 → 有界参数调整（UCB1 + 参数包络）→ 审计（audit）→ 评估 → 回滚 |

护栏在 `src/guard/`；agent 预设在 `src/preset/`；定时反思在 `src/meta/reflect.js`；存储路径的解析单独住在 `src/paths.js`（**不导入任何宿主包**，所以 `tools/migrate-store.mjs` 这类 CLI 能直接复用它，不必先装一套宿主加载器）。

### 注入策略（injection strategy）

- 一次召回的注入结果由**当前作用域（scope）上的策略栈**决定：意图（intent）先展开成候选集合，策略栈再通过生命周期（lifecycle）钩子（`plan` / `score` / `filter` / `format` / `write` / `decay` / `onResult`）决定打分、过滤、格式化，以及注入的形状 —— 种类、阈值、权重、粒度、token 预算与多样性。
- 内置策略：`explore`（高召回、低阈值，写入落为 draft）、`exploit`（只注入已验证的、可执行的规则）、`debug`（失败与未决问题，不做时间衰减）、`distill`（压缩优先，省 token）。`guard` 是**不变量（invariant）**，永远在栈里、自己不注入内容，只做"锁定信念加权 / 草稿降权 / retired 永不注入"。
- 策略是**纯函数包**，以数据（`{ id, impl, params, lineage }`）持久化，永远不是闭包：agent 只能通过"点名一个内置实现 + 有界参数差分"来派生新策略。这是一条刻意的限制 —— 能持久化任意代码的 agent，也就是能把自己的 harness 弄砖的 agent。
- 切换、派生、停用都是可逆的日志（journal）事务，且**按作用域存栈**：一个 agent 切换策略不会改到另一个 agent 的召回。
- 预设通过 `anagenesis-preset-bind` 行激活默认栈 `['guard','exploit']`，并采用该作用域的召回 token 预算；卸载预设时会从日志恢复原来的栈。工具面是 `ana_strategy`。

## 工具一览（17 个）

| 分组 | 所在 bundle 行 | 工具 |
|---|---|---|
| 记忆原语（14） | `anagenesis-tools`（`dsh-anagenesis/tools`） | `ana_recall` · `ana_remember` · `ana_promote` · `ana_demote` · `ana_lock` · `ana_expire` · `ana_split` · `ana_rethink` · `ana_forget` · `ana_link` · `ana_strategy` · `ana_tune` · `ana_feedback` · `ana_audit` |
| 可视化（2，只读） | `anagenesis-viz`（`dsh-anagenesis/viz`） | `ana_dashboard` · `ana_diagram` |
| 桌面窗口（1，选装） | `dsh-anagenesis-window`（独立单行兄弟包） | `ana_window` |

十四个记忆工具全部通过 `ctx.tools.register(defineTool(...))` 注册，行被卸载时 Cordis 会把它们一起收回。其中 `ana_tune` 与 `ana_audit` 可以用该行的配置键 `exposeTuneTool` / `exposeAuditTool` 关掉（默认都开）。三个可视化/窗口工具**不在**这一行里：它们各自属于可视化行与窗口行，行没装，工具就不存在。

`ana_recall` 接收的是一个**意图**（`orient`、`recall_fact`、`recall_precedent`、`avoid_mistake`、`reuse_procedure`、`verify`、`contrast`），而不是查询语言：意图会展开成种类、状态、置信度下限、权重、粒度、token 预算与多样性。

## 每次变更都可逆

一次变更是**声明式的 JSON patch**（`src/store/patch.js`），永远不是闭包。存储把所有写者串行化到同一把异步互斥锁（mutex）上，先把事件追加到 append-only 日志，再换入一个冻结快照（frozen snapshot，读者因此无锁）。

`invertPatch(preState, patch)` 从**前置状态**推导出精确的逆操作，于是：

- `transact()` 返回 `revert(reason)`，它把逆操作作为一个*补偿事件*（compensating event）提交；
- 逆操作与正向 patch 一起写进日志，所以**重启之后回滚依然有效**；
- `ana_strategy action:"revert" seq:<n>` 与 `ana_tune action:"rollback" auditId:<id>` 只是这同一个原语上的薄封装。

`test/core.test.js` 对此有断言：*"revert() undoes a commit through a compensating journal event"*，其中包括"回滚一个回滚"。

## 自我引导：进化能自己引导自己吗？

**能 —— 进化可以自我引导，但外环是固定的。**

- **自我施加（tier 1）：** 记忆、策略栈与可调参数。agent 能召回自己过去的失败、从内置策略派生新策略、并用自己收集到的反馈调整自己的置信度下限、token 预算与半衰期。这是真正的自我修改：存储自身的行为会因此改变。
- **冻结（tier 2）：** 参数包络（envelope）、可调命名空间白名单、不变量 `guard` 策略的存在、工具 schema、销毁预算，以及插件代码本身。运行中的 agent 改不了其中任何一项；要改只能由人动手。

理由：一个能改写自己的适应度函数与自己的刹车的 agent，会漂向"得分高"而不是"真管用"的方向，而且没有可恢复的状态可以回滚。tier 1 的自我施加换来真正的适应能力；冻结的外环让这份适应保持可审计、有边界。这条边界是**可执行**的，不是口号 —— 见 `src/guard/invariants.js` 里的 `INVARIANTS` 与 `safeMode` 冻结。

## 并发模型

- 一把 `Mutex` 串行化每一次变更；读者从不上锁（它们读的是冻结快照）；
- 持久化优先：追加日志 → 换入快照 → 派发监听器；
- 快照是原子的（临时文件 + rename），而且它只是一个缓存 —— 启动时以日志为准；
- `MemoryStore.acquire()` 按根目录做引用计数，所以 profile 行与预设作用域的行**共用同一个写者**，而不是在同一个日志文件上互相抢。

## 数据与存储位置

默认自包含在 `$DSH_HOME/anagenesis/` 下（可配置）：

```
anagenesis/
  journal/journal-000001.jsonl     append-only 事件日志：{ seq, ts, type, patch, undo, touched }
  journal/archive-<seq>.jsonl      已折叠的事件：丢掉正向 patch，保留 `undo`
  journal/checkpoint-<seq>.json    那个边界上的冻结状态
  journal/pruned.json              仅当保留策略真的丢过东西时才出现
  snapshot.json                    原子启动缓存：{ savedAt, schemaVersion, state }
```

**目录改名与旧数据（重要）**：默认目录是 `$DSH_HOME/anagenesis`。如果**新目录不存在、而改名前的 `$DSH_HOME/evolution` 存在**，插件会**继续沿用旧目录**，一个字节都不搬 —— 数据一条没动，只是位置还是旧的。这条兼容路径是**可见的**：日志里会有一条 `logger.warn`，写着"沿用旧包名的存储目录 …（数据一条没动）"，并给出迁移办法 —— `node tools/migrate-store.mjs --apply`（**复制** + 逐文件 sha256 校验 + 写完成标记，源目录一个字节都不动；`--verify` 只比对，`--revert` 删目标且带守卫）。显式配置了 `rootDir` 时一切听配置的。插件刻意**不做**自动搬迁：移动用户数据是不可逆动作，必须由用户显式触发 —— 这跟"可逆效应"是同一件事，插件自己发起的副作用必须能被插件撤回，而"我已经把你的数据挪走了"撤回不了。

压缩（compaction）在活跃日志超过 `compactAfterEvents`（默认 2000）后运行。每一轮**追加一个归档段**（archive segment）来覆盖它折叠掉的活跃事件 —— 更老的段永远不重写，所以一次压缩的代价是 O(活跃量) 而不是 O(历史量) —— 然后写一份新的 checkpoint，并开一个新的活跃段。只保留最新的 checkpoint：更老的快照是死重，因为它冻结的那些事件仍在归档里。

有两条上界阻止这套布局无限增长，而且都不是无意加上的：

- `archiveMaxSegments`（默认 16）在段数过多时合并最老的几段。**合并不丢任何东西** —— 合并后的段仍然带着它覆盖的每一个事件（含 `undo`），所以 `revert(seq)` 依然能执行最老的那次回滚。
- `retainEvents`（**默认 0 = 全部保留**）是唯一有损的策略：在压缩时删除最近 N 个事件之外的整个归档段。那些 seq 从此不可回滚，这正是它默认关闭的原因 —— 也是为什么这份损失是**可见的**而不是静默的：`ana_audit view=status` 会在 `journal.pruned` 下报告标记，`revert` 会点名是这个策略丢的、而不是声称那个 seq 从没存在过，并且这次丢弃会记成一行 `journal.prune` 审计记录。

检索是 BM25 倒排索引加一个确定性的哈希向量化器（`src/memory/embed.js`，192 维、L2 归一化），再配 MMR-lite 多样性打包。没有原生依赖、不下载模型、不联网；`embed` 在核心行里是可注入的。

Schema 迁移是一条纯链（`migrateState`），所以旧构建产出的 v1 文档能向前加载；策略参数的宽松读取也容忍上一版残留的键。当前版本是 **v6**，它把 tuner 的学习态搬进了 `state.tuning`（样本、UCB1 臂、调参历史）—— 见下面的「state 里存了什么，以及这换来了什么」。

### state 里存了什么，以及这换来了什么

有两样东西原本是进程内的，现在变成了 state，因为正是这一点让它们可复现：

- **tuner 的学习态**（`state.tuning`，v6）：反馈样本窗口、臂的拉动次数、以及已应用的调参历史。`ana_feedback` 与 `ana_tune apply` 把它和解释它的那行审计记录放进**同一个事务**，所以重启是从日志里续上、而不是把元层清零，`revert(seq)` 也会把学习态连同其它东西一起回滚。tuner **不留私有副本** —— 它读的就是 `state.tuning`，所以一次回滚对它立刻可见，而不是等下次启动。
- **生命周期计数器**（`state.stats`）：每个计数器都由拥有它的那个操作、在它所计数的那个事务内部自增，所以计数器不可能和日志不一致。`commits` = 每一次事务，`reverts` = 每一次补偿事务，`recalls` = 每一次 `service.recall()` 调用（无论是否选中），`writes` = 每一次被接受的 `ops.remember()` 提交（promote/lock 这类生命周期跃迁由 `commits` 记录，不算进 `writes`）。后来新增的计数器从引入它的那个版本开始计数 —— 不会从历史里回填。

### 宿主边界（lossless JSON）

每一个工具回答都要被宿主做一次 JSON 往返，只要有东西丢失，整次调用就会被拒：`value is not lossless JSON`。两条推论被写进代码并在两层上都有测试（`test/lossless.mjs` + `verify:boot` 里对那十四个工具的逐个调用，可视化行的两个工具另有同样的检查）：

- 值等于 `undefined` 的键是**有损**的 —— 它存在于返回对象里，却在 JSON 里消失（`{...record, embedding: undefined}` 不是"删掉这个字段"，要改用解构）；
- `auditAppend` 按设计**没有逆操作**：审计行记录的是"某事发生过"，所以 `revert` 会拒绝一个唯一效果只是追加审计行的事件，而不是报告一次幽灵回滚。领域内的修改仍然保有精确的逆。

## 护栏（guardrails）

- `ctx.tools.guard()` —— 一个**单调**的 pre-execute 护栏（注册在可扩展 waterfall 之后；没有任何护栏能强行放行另一个护栏拒绝的调用）。它会拒绝：没有 `force` 的锁定记忆 forget、缺少理由的调用、超出预算的批量、以及在 `safeMode` 打开时的元层改动。
- 事务路径上的 pre-commit 不变量 —— 被拒绝的改动**不会**在日志里留下任何痕迹。
- 策略熔断：5 分钟内 3 次钩子失败就把该策略隔离（quarantine）；引擎降级到栈里其余策略，护栏则冻结元层改动直到它复活。
- `safeMode` 配置开关会整体冻结策略的注册、切换与调参。

## 配置项（bundle 行，`cordis.patch.yml`）

| 行 | 入口 | 用途 |
|---|---|---|
| `anagenesis-core` | `dsh-anagenesis` | 服务（**`ctx.anagenesis`**）：store、registry、engine、tuner、ops |
| `anagenesis-tools` | `dsh-anagenesis/tools` | 那十四个 `ana_*` 记忆工具 |
| `anagenesis-guard` | `dsh-anagenesis/guard` | 单调工具护栏 + 隔离刹车 |
| `anagenesis-preset` | `dsh-anagenesis/preset` | 注册 `anagenesis` agent 预设 |
| `anagenesis-viz` | `dsh-anagenesis/viz` | 只读可视化：`ana_dashboard` + `ana_diagram` |

核心配置键（`anagenesis-core`）：

| 键 | 默认 | 作用 |
|---|---|---|
| `rootDir` | `$DSH_HOME/anagenesis` | 存储根目录；设了就完全听它的（不再有旧目录回退） |
| `safeMode` | `false` | 冻结策略注册、切换与调参 |
| `persistDebounceMs` | `250` | 快照落盘的防抖窗口 |
| `recallDefaultTokenBudget` | `1600` | 召回注入的默认 token 预算 |
| `hookBudgetMs` | `8` | 单个策略钩子的时间预算 |
| `sweepIntervalMs` | `300000` | 过期清扫的间隔 |
| `autoSweepExpired` | `true` | 是否自动清扫已过期的记忆 |
| `compactAfterEvents` | `2000` | 活跃事件超过它就跑压缩；`0` 关闭压缩 |
| `compactIntervalMs` | `3600000` | 压缩检查的间隔 |
| `archiveMaxSegments` | `16` | 归档段数上界，超过就合并最老的段（不丢 seq）；`0` = 不设界 |
| `retainEvents` | `0` | 唯一有损策略：只保留最近 N 个事件的归档段；`0` = 全留 |
| `embedProvider` | `hash` | 启动时用哪个向量后端；真正的语义后端在运行时用 `service.useEmbedder(...)` 装 |
| `reflectionEnabled` | `true` | 是否启用定时反思 |
| `reflectIntervalMs` | `21600000`（6 小时） | 反思任务的间隔 |
| `reflectionStaleAfterMs` | `2592000000`（30 天） | 证据老过它就视为陈旧 |
| `maxReflectionsPerRun` | `2` | 每轮反思最多提交几条假设 |

`anagenesis-tools` 的配置键：`exposeAuditTool`、`exposeTuneTool`（默认都是 `true`）。
`anagenesis-preset` 的配置键：`presetIds`、`autoInstallDirectoryForm`（本部署里为 `false`，理由见下文）。
可视化配置键：`color`、`width`、`redaction`、`events`、`salience`、`diagramNodes`、`includeBodies`、`auditRenders` —— 全部可选，全部有安全默认值。

## 可视化

可视化是进化里唯一**允许缺席**的部分，而且它是按"缺席不付代价"来造的：

```
              ┌──────────────┐        ┌───────────────────┐        ┌──────────────────┐
  state ─────▶│ viz/model.js │───────▶│ viz/tui.js        │───────▶│ ana_dashboard    │
  journal      │  (projections)│       │  (ANSI frame)     │        │ one frame, chat  │
  ──────────▶  │              │       ├───────────────────┤        ├──────────────────┤
               │              │──────▶│ viz/diagram.js    │───────▶│ ana_diagram      │
               └──────────────┘        │ mermaid/d2/ascii  │        │ paste-ready      │
                                       └───────────────────┘        └──────────────────┘
                    ▲                                                     ▲
                    └──── viz/mirror.js (files, read-only) ──────────────┘
                              tools/viz-watch.mjs — live TUI, own process
```

两种形态，同一个模型：

- **TUI 仪表盘** —— `ana_dashboard` 把一帧（画框、按显示宽度精确对齐，含中日韩标签；只有被要求时才上 ANSI 颜色）渲染进工具回答；`node tools/viz-watch.mjs --watch` 是它在真实终端里持续重绘的活版本。分区：overview、lifecycle、kinds、strategy、偏离默认值的调参旋钮、日志尾部、重要度（salience）最高的信念，以及渲染器自身的健康状况。
- **把文本当图** —— `ana_diagram` 输出 Mermaid（默认）、D2 或 ASCII，三种图：`memory-graph`（信念及它们之间的 `supports` / `contradicts` / `supersedes` 关系）、`strategy-timeline`（栈 / 调参 / 回滚这些治理事件）、`lifecycle`（日志**真实记录**到的跃迁 —— `lock` / `expire` / `sweep` 只记录目的态，图会如实说明，而不是编造一条来源边）。

这些性质是被强制执行的，不是承诺：

- **只读**：一次渲染不是一次事务（`verify:boot` 断言存储版本不会因为一次渲染而移动）。唯一的写入是 `auditRenders: true`，默认关闭，打开后每次渲染追加一行 `viz.render` 并报告它的 seq。
- **可逆 / 可单独禁用**：第五个 Loader 行 —— 在 `anagenesis-viz` 上写 `disabled: true` 就移除这两个工具，别的什么都不动。这一行不提供任何服务（预设会把它再挂一次；`ctx.provide` 会撞车 —— HANDOFF §10.16），也不启动任何定时器。
- **不起子进程、不开 GUI**：插件自己从不 spawn 任何东西，实时 watcher 是操作者自己跑的独立只读进程。
- **脱敏（redaction）边界**：默认 `secrets` —— 抹掉凭据形状的子串、省略正文；`strict` 连标签一起遮；`none` 是显式的本地调试逃生门，帧本身会就此发出警告。
- **产物带版本**：每张图都带 `<!-- anagenesis-viz v1 kind=… format=… store=… at=… origin=… redaction=… -->`。`normalizeArtifact` 接受没有头的 v0 形状，也不会被更新版本噎住（它会显示原始正文，并说明这是更新版本）。
- **自身可观测**：仪表盘的 viz 分区会报告渲染次数 / 图次数 / 错误数 / 上次渲染时间，行注册时也会记一行日志。

### 桌面窗口（可选兄弟包 `dsh-anagenesis-window`）

TUI 与图表之上还有一个**桌面窗口**，它住在**独立的兄弟包** `dsh-anagenesis-window` 里（同一仓库的 `window/` 目录），**不在**上面那五个 bundle 行里，也不是必须装的：

- **为什么必须单独成包**：`@deepseek-ai/dsh-client-modules` 允许一个声明了 `dsh.client` 的包拥有**恰好一个**活跃 Loader 行，而 `dsh-anagenesis` 是五行（预设还会再挂一次）。所以窗口是**单行**兄弟包，`dsh-anagenesis` 永远不能加 `dsh.client`。
- **预设知道这个能力，但刻意不启用它**：`src/preset/definition.js` 里的 `WINDOW_CAPABILITY.mountedByPreset` 是 `false`，persona 里把它写成条件句。工具 `ana_window` **只在 profile 真的装了那一行时才存在** —— 没装时预设不会假设它存在，也不会因此报错。
- **它画的是同一个模型**：窗口内容是用 `src/viz/model.js` + `tui.js` / `diagram.js` 这同一批纯函数产出的 HTML / 内联 SVG（中文指标卡、彩色分布条、真正的分层有向记忆关系图，支持 LR / TB 与缩放、生命周期流转、策略时间线）。
- **数据路径是只读镜像（read-only mirror）**：窗口只读 `$DSH_HOME/anagenesis` 的存储，一个字节都不写；`rootDir` 留空即指核心行的默认目录。
- **入口席位**：better-sidebar 侧栏一行 / 官方右侧侧边栏 / 对话（轨迹）顶部栏 —— 三者各自独立武装，没有一个是必须的；侧栏入口的具体席位取决于是否装了 DSH-better-sidebar。窗口本身只有一个席位：`shell.overlay` 浮层。
- **安装**：`dsh plugin --profile desktop add link:D:/cj/anagenesis/window`，或在 `$DSH_PROFILE_DIR/package.json` 里加 `"dsh-anagenesis-window": "link:D:/cj/anagenesis/window"` 并把包名放进 `dsh.profile.bundles`。卸载这一行会释放它持有的全部效应（席位注册、tab 类型、`<style>` 节点、定时器、路由与服务）。
- **agent 的门**：agent 没有鼠标，所以 `ana_window` 把一个请求写进 Host 的内存槽，窗口下次轮询时取走（≤ `refreshMs`）。宿主没有为插件自己的客户端半提供 host→client 推送，所以这个间接层被当作限制写出来：没有 GUI 连着时请求就一直 pending，工具也会明确告诉 agent 不要假设窗口已经出现。

窗口侧的配置键：`enabled`、`rootDir`、`title`、`redaction`、`color`、`width`、`events`、`salience`、`diagramNodes`、`includeBodies`、`refreshMs`、`officialEntry`、`leftColumnFallback`、`exposeWindowTool`、`trustedHosts` —— 细节见 `window/README.md`。

## Agent 预设与工具的绑定

两种不同的机制，这是刻意的：

1. **哪些工具存在**是*组合式*的：预设的 `plugins` 列表挂载的正是这个预设拿到的那些工具行（`src/preset/definition.js`）。没有运行时遮罩。
2. **表现得像一个进化 agent** 是*运行时且可逆*的：`anagenesis-preset-bind` 行激活默认策略栈（`['guard','exploit']`），并为自己的作用域采用召回 token 预算。卸载预设时会从日志恢复上一个栈。
3. 在 agent 作用域的宿主上，`toolAllow` 通过 `ctx.tools.restrict()` 收窄遮罩；在普通预设作用域里这个调用会抛异常并被降级为一条警告，于是一份定义在两种宿主形态上都能用。

`anagenesis` 预设通过 `agentPresets` 服务注册（`register(def) → unregister`），所以 `ctx.effect(() => registry.register(def))` 让预设的生命周期与插件 fiber 完全一致。如果这个服务在**本行 apply 之后**才发布 —— 本宿主就是这样 —— 本行会用 `ctx.inject(['agentPresets'], …)` 反应式绑定，在它出现的瞬间完成注册。

目录形态（`$DSH_HOME/.agent-presets/<id>/{preset.yml,agent.cordis.yml}`）是给"老到会去扫描目录名册"的宿主用的回退。它在本部署的 `cordis.patch.yml` 里是**关闭**的，因为 `@deepseek-ai/dsh-agent-preset-registry` 0.2.0-rc.2 里根本没有任何对 `.agent-presets`、`preset.yml` 或 `readdir` 的引用 —— 它的预设来自 Loader 树加上 `register()`。只有面对更老的版本线时才把 `autoInstallDirectoryForm: true` 打开；写入器永远不会覆盖已有的本地组合。

## DSH API 假设（验证过，不是猜的）

这些是在写这份代码之前，从运行中的 harness `app.asar/dsh/node_modules/@deepseek-ai/*`（DSH `0.2.0-rc.2`，Cordis 4.x）里读出来的：

| API | 用到的契约 | 用在哪 |
|---|---|---|
| `ctx.effect(fn)` | 运行 `fn`、收集它返回的 disposer、在 fiber 卸载时按相反顺序 dispose | `src/index.js`、`src/guard/index.js`、`src/preset/bind.js` |
| `ctx.provide(name, value)` | 返回一个 disposer；fiber 卸载时 Cordis 注销该服务 | `src/index.js` |
| `ctx.inject(deps, apply)` | 依赖就绪后启动子插件 | 以 `export const inject` 声明 |
| `internal/service` 事件 | 依赖变化会刷新依赖方 | 引擎/注册表的缓存失效 |
| `ctx.tools.register(def)` | 返回精确的 disposer；同一层里的重名会抛异常 | `src/tools/index.js` |
| `defineTool({...})` | 编译参数规格，**只**校验实参（args） | `src/tools/index.js` |
| `ctx.tools.guard(fn)` | 单调；返回字符串即拒绝该调用 | `src/guard/index.js` |
| `ctx.tools.restrict({allow,deny})` | 仅限有作用域的上下文 | `src/preset/bind.js` |
| `agentPresets.register(def)` | `{id,name,description,order,plugins}` → 返回注销 disposer | `src/preset/index.js` |
| `ctx.plugin(cb)` / `apply` 的返回值 | **当作 effect 收集**：函数 = disposer，null/undefined = OK，promise = await 后再收集，**任何其它对象 = `TypeError: Invalid effect`** | 全部五个行 |

`inject` 在 `anagenesis-tools`（`['tools','anagenesis']`）与 `anagenesis-guard` 上是服务名数组；`anagenesis-preset` 刻意**不**对 `agentPresets` 声明硬依赖（在老版本线上它是可选的），改为探测 `typeof registry.register === 'function'`，而不是"这个服务存不存在"。

### 行的契约（踩过坑才学会的）

Cordis 会把 `apply` 返回的任何东西当作 **effect** 收集：

```js
const effect = runner.execute.call(this)                   // runs apply(ctx, config)
if (typeof effect === 'function') runner.collect(effect)   // a disposer      — OK
else if (isNullable(effect)) { /* OK */ }                  // undefined/null  — OK
else if (!isObject(effect)) throw new TypeError('Invalid effect')
else if ('then' in effect) return effect.then(safeCollect) // await, then collect the value
// safeCollect(value): non-function, non-null  →  throw new TypeError('Invalid effect')
```

所以一个返回状态对象（`{ mode }`、`{ dispose }`）的 `async apply` 会被拒绝，随之而来的 fiber 拆解会**回滚函数体已经创建的全部 effect**。第一次真机安装就是这么失败的：`provide('anagenesis')` 与全部十四个 `tools.register` 调用被撤销，依赖它的行于是永远等下去，一个 `ana_*` 工具都没出现。规则：

1. `apply` **什么都不返回**，或者返回一个 disposer 函数。永远不要返回普通对象。
2. 如果 `ctx.effect` 已经持有一个 disposer，就**不要**再把它返回一次 —— Cordis 会收集两次，而被 dispose 两次的回滚会撤销掉自己的撤销。
3. 当一个长 `await` 期间的卸载也必须被撤销时，把 effect 注册在 `await` **之前**。

`test/adapter.test.js` 对每一个行都断言规则 1，bind 测试则把规则 2 断言为"恰好一次回滚"。

## 开发与测试

```bash
npm test          # 68 个测试，五个套件（core / adapter / preset / reflect / viz），stub 宿主
npm run check     # 对每个适配行与反射模块跑 node --check
npm run verify:boot
npm run viz       # 渲染一帧后退出
npm run viz:watch # 在终端里持续刷新的只读 TUI

npm run test:window   # 桌面窗口包：72 个离线测试（两个环境）
npm run gate:window   # 窗口包的四道闸：build、check、test、probe
npm run scan:asar     # 扫描已安装的 app.asar
```

`npm test` 跑在 stub 宿主上，因为真正的宿主包住在 profile 里，不在本仓库：

- `test/core.test.js` —— patch 代数、迁移链（v1 → v6）、重启后的日志重放、**日志压缩**（归档 + checkpoint：每个 seq 仍可追溯、最老的事件仍可回滚、没有快照的重放也能重建状态、老段在下一次压缩后**逐字节相同**、段数守卫合并时不丢任何一个 seq、可选保留策略的修剪会留下标记并拒绝已丢失的回滚）、引用计数、回滚的回滚、**一次创建了作用域的栈事务**（现在可逆；对活跃栈的正向删除仍然被拒）、生命周期操作（remember/promote/demote/lock/expire/split/rethink/forget/usage/sweep）、意图规划、预算打包、策略切换/派生/隔离、tuner 环路（含学习态能挺过重启、且一次回滚能把它带走）、**按作用域的重要度**、**可插拔向量后端与重新嵌入**、不变量与工具护栏，以及两条可逆性边界（只有审计的事件被拒绝，而不是被伪造）。
- `test/adapter.test.js` —— 五个行对宿主 stub：每个行的 `apply` effect 契约、服务发布能挺过它自己的 apply、14 次工具注册、一次完整的 agent 往返（remember → recall → promote → split → 策略切换 → revert → rethink → feedback → audit → tune 闸门 → 护栏拒绝）、调用方预算被尊重、preset-bind 的收敛与单所有者拆解、预设的反应式注册、压缩策略的映射，以及**每个工具回答的无损 JSON 检查**（`test/lossless.mjs`）再加上计数器与去重写入契约。
- `test/preset.test.js` —— 定义是唯一事实来源、按平台取舍的 shell 行、目录形态渲染、persona 契约、幂等的目录安装。
- `test/viz.test.js` —— 可视化层：一次渲染是纯投影（state 对象与存储版本都不变）、帧在三种宽度下显示宽度精确并能扛住中日韩标签与 ANSI 颜色、凭据默认被抹掉而 `strict` 连标签一起遮、记忆图标出目标落在窗口之外的连线、生命周期计数来自日志（没有记录过的来源不会被编造）、产物能从 v0 迁移并在更新版本上降级，以及只读镜像与同一目录上的 `MemoryStore` 结论一致、同时让该目录逐字节不变。
- `test/reflect.test.js` —— 定时清扫：哪些信念算陈旧、一次运行是有界的、已经带着一个活跃质疑的信念不会被问第二次、每次反思都是一次普通的 `memory.rethink` 事务、以及回滚其中一次会把问题重新打开。

这些测试找到并修掉的 bug：一次 `null` 参数写入把旋钮钉在包络最小值上，而不是恢复默认值；一次待写的快照在拆解之后才触发；`toDirectoryForm` 返回了一个数组，而 `fs.writeFile` 要的是文本；一个返回对象的 `async apply`，被 Cordis 以 `TypeError: Invalid effect` 拒绝（见 DSH API 假设一节），并在函数体已经跑完之后拆掉了整行；`preset-bind` 发起栈切换却没等它；`preset-bind` 丢掉了它为 token 预算写下的补偿事务，于是每次预设卸载都泄漏这个参数；`createToolGuard` 读的是 `exec.args`，而宿主传的是 `exec.arguments`，导致所有依赖实参的护栏静默失效；**ASI 把 `row.access ??= {…}` 和紧随其后的 `(record)` 粘成了对对象字面量的调用**，这让任何真的带记录的文档都过不了 v2→v5 迁移；以及 v2→v3 迁移丢掉了 `meta.params`，因为 `normalizeState` 总是预填 `params`，那个 `??` 兜底永远不会触发。

`npm run verify:boot` 是同一份启动契约的打包版：它把宿主库（`@deepseek-ai/cordis`、`dsh-tools`、`schemastery` 及其依赖闭包）从已安装的 `app.asar` 解到**本包之外的临时目录**，在那里注册解析钩子，导入真实的 `src/**`，然后把五个行走一遍挂载 → 观察 → 卸载：覆盖 effect 契约、服务发布、由真实 `defineTool` 编译的全部记忆工具、preset-bind 收敛、预设的反应式注册、卸载可逆性，以及三条并发安全的证明 —— 用户真实的存储在整轮里从未被碰过。它**从不**写入本包的 `node_modules`：一份包内的宿主库副本会遮住宿主自己的实例，把 `Service` / `defineTool` 的身份劈成两半。

窗口包另有自己的开发命令（`npm run build:client`、`npm run check`、`npm test`、`npm run probe`、`npm run gate`、`node tools/preview.mjs`）；`client.js` 是**构建产物**且已提交，`npm run check` 在它落后于 `src/render/*` 或 `src/client/parts/*` 时会失败 —— 改部件，永远不要改那个 bundle。

## MVP 路线图

- **MVP-1（已完成、已安装、真机验证）：** store + patch 代数 + 日志、十四个工具、三个内置策略 + guard、带审计/回滚的 tuner、不变量、`anagenesis` 预设，以及打包好的启动契约。
- **MVP-2（已完成）：** 按 agent 划分的策略作用域在真机上端到端验证（做召回的那个作用域确实用它自己的栈，连渲染出来的分区都能看出来）；带 `archive-*.jsonl` + `checkpoint-*.json` 的日志压缩，对 `ana_audit view=journal` 与 `revert(seq)` 透明；`npm run verify:boot`。
- **MVP-3（已完成）：** 可插拔的向量后端（`registerEmbedProvider` / `resolveEmbedder` / `service.useEmbedder`），带戳记的 `state.embed` 与单事务的 `reembed()`；按作用域的重要度，让共享存储不会出现"一个 agent 重排了另一个 agent 的召回"；以及一个定时反思任务，对证据已经老掉的信念提交反事实。
- **MVP-4（已完成）：** 有界的日志布局 —— 每次压缩追加一个归档段（`archiveMaxSegments` 合并最老的段而不丢 seq），外加一个**可选**的保留窗口（`retainEvents`，默认 0），它会修剪整段并把损失记进 `pruned.json`、`status().journal.pruned`，以及一行 `journal.prune` 审计记录。
- **MVP-5（已完成）：** 没有 GUI 的可视化 —— 无依赖的投影层（`src/viz/`）、两个只读工具（`ana_dashboard`、`ana_diagram`）挂在它们自己的 kill-switch 行上、一个独立的实时 TUI（`tools/viz-watch.mjs`，它读存储而不成为写者）、默认脱敏，以及带版本的文本产物。
- **MVP-6（已完成）：** 桌面窗口的入口层 —— 独立单行兄弟包 `dsh-anagenesis-window`，真机在跑：`shell.overlay` 里唯一的窗口席位、better-sidebar / 官方右侧栏 / 对话顶部栏几类入口（侧栏底部工作台入口已按要求移除）、`ana_window` 这道 agent 门，以及把每个席位"为什么没接上"都报出来的可观测性。
- **MVP-7（已完成）：** 窗口的可视化重构 —— 窗口不再显示 ASCII 帧与 Mermaid 源码，改为**中文卡片 + 真正的内联 SVG 图**：节点按类型/状态上色、连线按关系上色、支持 LR / TB 与缩放；窗口与终端共用同一份 `viz/model.js`，所以"截图里看到的"就是"窗口里的"。
- **未交付 —— GUI 设置面板。** 它被写过又被撤掉了：一个声明了 `dsh.client` 的包只能拥有**恰好一个**活跃 Loader 行，因为 `@deepseek-ai/dsh-client-modules` 按行解析客户端源，多于一个就抛 `package X resolves from multiple active Loader sources … remove one entry`。本包刻意提供**五个**可独立禁用的行（而且 `anagenesis` 预设还会把它们再挂一次），所以客户端半不可能住在这里 —— 它只能像桌面窗口那样，作为自己的单行包发布。`npm run verify:boot` 现在会在 `dsh.client` 重新出现在多于一行旁边时让构建失败。
- **仍待处理：** 原生 `tsc` 类型检查（这个无依赖的包里既没有 `jsconfig` 也没有 `typescript`）。

## 许可证

MIT —— 见 `package.json` 的 `license` 字段。