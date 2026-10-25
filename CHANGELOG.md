# 更新日志

本文件记录每次发布的变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] — 2026-10-25

> **先量，再改。** 这一版不加工具、不加依赖，改的是检索与写入的质量：
> 相关性门槛、真正的 MMR、图检索、取代语义、调参闭环，以及一份可以复跑的离线检索基准。
>
> 存储 **v7 → v8**（只加 `confirmedAt`，自动迁移、幂等、旧 journal 可重放）。
> 行为有变化：**相关性不足的记忆不再为了填满预算而注入** —— 召回结果可能比以前"少"，
> 那是真的没有相关内容。`ana_recall` 的 `excluded` 会说明排除了谁、为什么。

### 新增

- **离线检索基准**（`bench/`，`npm run bench`）：211 条确定性合成记忆（两个项目 + 全局 + 会话、
  中英混合、近重复、取代链、跨项目冲突、180 条干扰项）× 41 条带 gold 的查询，
  指标 nDCG@10 / MRR / Recall@5 / Precision@5 / 污染率 / 作用域泄漏 / tokens-per-relevant。
  `bench/baseline.json` 是回归闸门：任何一项明显变差都会 exit 1。
- **相关性门槛**：绝对floor（`recall.minRelevance`，可调）+ 相对floor（必须达到最佳候选的 45%）。
  按 intent 缩放（`orient`/`verify` 更宽，`recall_fact`/`reuse_procedure` 更严），空查询（简报）不受限。
- **`confirmedAt`（schema v8）**：记录"上一次被确认"的时间；提升/锁定会刷新，`link`/`retag` 不会。
  时间衰减改读它 —— 以前连一条线就能让半年前的信念看起来"新鲜"。
- **图检索**：`buildIndex` 产出反向边；召回在门槛之后做 1 跳扩展（最多 12 个种子、最多救回 6 条、
  固定类型权重）。`supports`/`part_of`/`caused_by`/`derived_from`/`superseded_by` 可救回被相关性门槛挡掉的记录，
  `related` 只在本身有词法相关时救回，`supersedes` 权重为 0（不把旧信念拖回来）。
  输出带理由链（`graph ← caused_by mem_x`）与 `graph.revived` 计数；`request.graphExpansion=false` 可关闭。
- **`ana_remember` 近重复提示**：返回同命名空间 top-3 相似记录 + `suggestedAction`
  （supersede / merge / link）。只是提示，**从不自动改写**。
- **`ana_remember supersedes: [id...]`**：一次事务里写入新记录 + 旧记录的 `supersededBy` + 两侧 links；
  拒绝未知 id、跨命名空间、retired 源。
- **`ana_recall excluded`**：按原因计数 + 最强 3 条近失（`why` = below-relevance-floor / below-top-relevance），
  `includeSuperseded: true` 可显式查看被取代的历史。
- **`status().lifecycle`**：根据 `ana_feedback` 的 hits/misses 给出可提升/可降级建议。
- **日志完整性**：`status().journal.health` 报告被跳过的坏行（tornLines）与 seq 空洞（gaps）。

### 变更

- 词法分从原始 Okapi BM25 改为 **IDF 加权覆盖率**：词表内覆盖率用于排序，含未知词的覆盖率用于门槛。
  未知词不再被当成"没说过"，也不会让一条只匹配到"怎么/配置"的记录看起来完全相关。
- 向量项从 `(cos+1)/2` 改为 `max(0, cos)`：原先每条记录白拿 0.5 的语义底分（实测无关文本映射后 0.518）。
- MMR 改为短名单（120 条）内的真迭代重排；预算放不下的候选移出池，而不是原地卡住后面的候选。
- 跨项目降权只作用于**先验项**（时间/置信/显著度/作用域），不再把相关性一起压掉 ——
  `crossProject: true` 终于能在本项目无相关经验时真的看到外项目经验。
- 倒排索引缓存按 `state.memories` 对象身份键接线：审计写（每次 recall 都会写一条）不再让缓存失效。
- `ana_link rel=supersedes` 双写两侧，并拒绝自环、跨命名空间、互相取代；重复 link 幂等。
- 调参闭环：`observe` 把评估窗口内的样本记到最近一次变更的臂上（一次 pull 一个窗口均值）；
  `apply` 在上一次变更未被评估前拒绝再改（`force` 可越过）；`evaluate` 只比较变更之后的样本。
  删除从未被消费的 `recall.explorationRate`。
- `write.admissionThreshold` 接线：显式 confidence 低于门槛时写入落 `draft`（返回 `downgraded`）；
  省略 confidence 时保持策略决定。
- `promote.hitRateThreshold` / `demote.missRateThreshold` 接线：驱动 `status().lifecycle` 建议。
- 停止词只用于词法索引/查询；`tokenize()` 与已存储的 embedding 空间保持不变（无需 reembed）。

### 修复

- 每次召回都重建全库倒排索引（`indexCache` 声明了但从未被传入；HANDOFF 里"按 version 记忆化"的说法因此不成立）。
- 被取代的旧信念与替代者一起被注入；`supersedes` / `supersededBy` 字段此前从未被写入。
- 无关查询也会灌满 token 预算（旧实现没有任何相关性下限）。

### 基准（同一份语料，0.3.2 → 0.4.0）

| 指标 | 0.3.2 | 0.4.0 |
|---|---|---|
| nDCG@10 | 0.903 | **0.974** |
| MRR | 0.780 | **0.854** |
| Recall@5 | 0.963 | **1.000** |
| Precision@5 | 0.180 | **0.809** |
| 污染率（注入但无关） | 0.908 | **0.193** |
| 平均注入条数 / 查询 | 11.6 | **1.6** |
| tokens / 相关条 | 627 | **162** |
| 无关查询注入条数 | 8.3 | **0.0** |
| `crossProject: true` 命中 | 0 | **1.0** |

> 这是**合成、确定性**的离线语料，不是真实会话的替代品；它的用途是让每一次评分改动都能被复跑、
> 被对比、被回退。

### 破坏性说明

- 存储 v7 → v8：启动时自动迁移，旧 journal 重放后也会回填 `confirmedAt`。
- `recall.explorationRate` 从可调 envelope 中删除（它从未产生任何效果）。
- 召回结果会变少：相关性不足不再注入。需要"看看库里有什么"时用 `ana_list`。

## [0.3.2] — 2026-10-25

> 修 0.3.1 的一个**功能未生效**缺陷：版本检查跑起来了，但结果到不了界面。

### 修复

- **窗口里的版本更新块永远是"没检查过"**。`window/src/host/viz.js` 的 `readUpdate()`
  写在模块作用域，却引用了 `createRenderer` 闭包里的 `updateProvider` —— 引用不存在，
  它自己的 `try/catch` 把这个 `ReferenceError` 吞成 `null`，于是**无论服务报什么**，
  facility 与 dashboard 都显示 `check disabled / never`。核心层的检查本身是好的
  （`ana_audit view=status` 能读到），坏的是最后一公里。
  修法：`readUpdate(provider)` 显式收参数，四个调用点各自传入。
- 补上**接线**测试（`window/test/host.test.mjs`）：`createRenderer({ update })` → 模型里
  必须出现 `available/latest`，且文本帧**不**带这个分区。0.3.1 的单测全绿是因为它们
  测的是投影（模型 → 渲染），没测"provider → 模型"这一段 —— 测函数 ≠ 测接线。

## [0.3.1] — 2026-10-25

> 一块牌子：**有新版本了**。
>
> 非破坏性变更。存储格式仍是 v7，行 id、工具、路由都没动。

### 新增

- **新版本提示**：插件会检查自己是不是最新版，并把结果画在**仪表盘**上。
  - 设施视图（窗口默认面）顶条出现一块信号黄牌子 `v0.4.0 可更新`（悬停写着升级方式），
    告警台里同时有一条「有新版本 vX.Y.Z」；**只有真的查到新版本时才出现** ——
    检查关闭、没查过、查失败都不占顶条，只在仪表盘面的「版本更新」分区里如实写一行。
  - 仪表盘的「版本更新」分区：当前版本 / 最新版本 / 更新状态（有新版本 · 已是最新 · 检查已关闭 · 检查失败：原因）/ 上次检查。
  - `ana_audit view="status"` 与 `service.updateStatus()` 里同样能读到这块状态，Agent 不必靠猜。
  - 它只**提示**：不下载、不安装、不重启、不改任何文件。升级永远是一次人的动作。
- **新增配置**：`updateCheck`（`off` | `npm`，代码里默认 `off`，bundle 里设成 `npm`）、
  `updateCheckIntervalMs`（默认 6 小时，同时是缓存寿命）、`updateRegistry`（默认 npm 官方源）、
  `updateCheckTimeoutMs`（默认 5 秒）。

### 变更

- **网络声明**：这是本插件第一个、也是唯一的网络出口，因此 `package.json` 的 `disclosure.network`
  从空数组改为如实声明 `registry.npmjs.org`（只在 `updateCheck: npm` 时访问，只发 GET，
  不带实例 id / 项目指纹 / 记忆内容）。**想要完全离线**：把 `updateCheck` 设成 `off`，一行就够。
- 版本比较是**自己写的纯函数**（`src/update/check.js`），不引 semver —— 零运行时依赖是硬约束。
  已覆盖预发布版本的优先级：`0.3.1-rc.1 < 0.3.1`，`0.3.2-rc.1 > 0.3.1`。

### 修复

- `preflight` 的 peer 检查从"字符串相等"改成"宿主版本落在范围里"：`^0.2.1-rc.2` **本来就接受**
  `0.2.1-rc.3`（同一段版本号的预发布版本按优先级比大小），旧检查会在宿主小版本升级后误报。
- 新增两条发布闸门：**代码里有网络请求就必须写进 `disclosure.network`**、**`updateCheck` 的代码默认值必须是 `off`**。

## [0.3.0] — 2026-10-24

> 一个包，六个行，一块新的默认屏。
>
> **破坏性变更**（按 semver 因此是 minor）：`dsh-anagenesis-window` **停止更新**，窗口成为同一个
> `dsh-anagenesis` 的第六行与 `dsh.client` 半；窗口路由从 `/anagenesis-window/api` 改为
> `/anagenesis/api`；ModuleLoader id 从 `dsh-anagenesis-window` 改为 `dsh-anagenesis`；
> `peerDependencies` 抬到 `^0.2.1-rc.2`（预发布版本的比较器只在三段完全相同时才接受，
> 所以 `^0.2.0-rc.2` **不会**接受 0.2.1-rc.2）。存储格式**没有变**（仍是 v7），升级不需要迁移。

### 新增

- **设施仪表盘（窗口的默认面）**：把记忆库当成一栋**可运维的楼**来画 ——
  楼层 = 命名空间（当前项目 / 全局 / 每个会话），分区 = 记忆类型（8 种 kind），
  传感器 = 一条活跃记忆，读数 = 显著度 / 置信度 / 新鲜度，能耗对比 = 本分区单条记录的
  能量 vs **全楼实测均值**（不是拍出来的目标值），告警列表 = 矛盾链接 / 即将过期 / 高显著但陈旧 /
  悬空链接 / 锁定 / 安全模式 / 脱敏关闭 / 只读档位，底部电文条 = 日志尾部真实事件流。
  - 数据在 `src/viz/facility.js`（纯函数、只读镜像、lossless JSON，12 条测试），
    渲染在 `window/src/render/45-facility.js`，样式是同一份 `ANA_CSS` 里的 `gx-*` 规则
    （布局参考 Kombai GridSense 的排版与配色语言：冷调石板白画布 + 黑色 chrome +
    信号黄/红/蓝 + 直角几何 + 等宽数字）。
  - 新 RPC 方法 `method=facility`；`ana_window view="facility"` 打开的就是它。
    模型里没有的数字**不会出现在屏幕上** —— 这是这一屏的验收口径。
  - 点分区是**纯本地重绘**（模型不变就不发请求）；窗口宽度变化走容器查询降级，不是另做一套布局。

### 变更

- **两个包合并为一个（`dsh-anagenesis`）**：`dsh-anagenesis-window` 的 Host 半、client 半、
  共享渲染层与工具全部搬进同一个包，六个 Loader 行仍各自可单独 `disabled: true`。
  合法性来自 `@deepseek-ai/dsh-client-modules` 的**真实**约束：同一个**包名**只能有一个活跃
  client source，而子路径 specifier（`dsh-anagenesis/tools`）根本不算 source ——
  所以「裸包名只出现一次」才是硬约束，不是"只能有一行"。
  - 行：`anagenesis-core`（**唯一**用裸名）/ `tools` / `guard` / `preset` / `viz` / `window`。
  - `anagenesis` 预设组合里的 core 行改为 `dsh-anagenesis/core`（在自己的 baseUrl 下再挂裸名
    会成为第二个 source，整个包的 client 半会被拒）。
  - 安装现在只有**一条命令**；`window/package.json`、`window/cordis.patch.yml`、`window/LICENSE`
    已删除，`window/` 只是本包的一个目录。
- **适配宿主 0.2.1-rc.2**：开工前用真 Cordis + 真 `defineTool` + 真预设注册表复跑 98 项启动契约，
  0.2.0-rc.2 → 0.2.1-rc.2 **没有破坏**任何一行用到的 API 假设；`peerDependencies` 随之抬版。
- **打包/发布自检跟着合并改写**：`npm run preflight` 现在守住「孪生包身份不再出现」「裸名只出现一次」
  「README 不再让用户装第二个包」「CHANGELOG 有当前版本」；`npm run gate:pack` 真打包后断言
  安装态里 `window/client.js`、六个 exports 子路径、`facility` 方法与 ModuleLoader id 全都对得上。

### 修复

- `npm run check` 之前没有覆盖 `src/viz/facility.js`，新文件不进语法闸门 —— 已加入清单。
- 窗口的降级路径补上设施面：Host 半还是旧版本时，设施面降级成文本帧并说明「重启桌面端后
  这里会变成楼层平面图」，而不是把「未知方法」当成失败糊在用户脸上。

## [0.2.1] — 2026-10-10

> 修一个只在**升级路径**上出现的缺陷：`0.2.0` 在旧存储上会看不到日志。

### 修复

- **`ana_audit view=journal` / `view=status` 在升级后的存储上会被宿主拒绝**（`value is not lossless JSON`）。
  根因：`ns`（事件落在哪个命名空间段）是 v7 才有的字段，而升级前写下的每一条事件都没有它；工具把
  `event.ns` 直接透传成 `{ ns: undefined }` 时，`JSON.stringify` 会丢掉这个键，宿主因此看到与工具返回值
  不同的对象并拒绝整次调用。本机真实存储里 201 条事件有 189 条属于这种情况 —— 也就是说**任何从 0.1.x
  升级上来的用户都会踩到**。
  修法有两层：replay 时把内存读模型里的 `ns` 归一化为 `global`（`asReadModel`，一处修好所有消费者）、
  两个出口再兜一层 `?? null`（`ana_audit view=journal`、`status().lastEvents`）。
- 新增回归测试 **"a journal written before 0.2.0 (events with no ns) still answers losslessly"**（在
  `test/adapter.test.js`）：它构造的是**真存储** —— 先写一批事件，再把日志文件里每一行的 `ns` 删掉、
  连快照一起删掉，强制从旧形状的日志重放，然后断言两个审计视图的输出都能无损往返 JSON。该用例在修复前会红。
- 窗口包与父包同步到 0.2.1（窗口包本身无功能变更，只为让 `main` 与 npm 上发布的产物一致）。

## [0.2.0] — 2026-10-10

> 两个缺陷驱动了这一版：**不同项目的记忆会互相召回**（张冠李戴），以及**不启用预设时模型照样写记忆**
> （无意识污染）。前者是数据模型问题，后者是权限模型问题，因此这一版两件事一起做。
>
> **破坏性变更**（按 semver 因此是 minor）：存储结构 v6 → v7（自动迁移，不丢数据）、写入类工具改为
> **只在预设内注册**、`ana_remember` 的默认作用域从「全局」改为「当前项目」、新增 6 个 exports 子路径。
> 升级后**建议重启桌面端**，并让 Agent 用 `ana_scope action="adopt"` 把迁移遗留的旧记忆收回到当前项目。

### 新增

- **记忆作用域隔离（存储结构 v7）**：每条记忆都带 `scope.tier`（`global` / `project` / `session`）
  与 `project_id`；写入默认落到**当前项目**，不再是"默认全局"。
  - 项目指纹 `p1_<hash>` 由 git remote（优先）或规范化绝对路径算出，**纯函数、跨会话稳定**；
    同一份代码的多个检出/工作树收敛到同一个项目。
  - 检索默认只召回当前项目 + 全局 + 当前会话；跨项目检索必须显式传 `crossProject: true`，
    命中会被**降权**（`recall.crossProjectFactor`，默认 0.4）并逐条标注
    「⚠ 其他项目经验，请勿盲从」。
  - **物理分段**：日志按命名空间分文件（`journal-<ns>-*.jsonl` / `archive-<ns>-*.jsonl`），
    全局命名空间保留原来的无前缀命名（`journal-000001.jsonl`），隔离前的存储原样可读。
  - **冲突检测**：跨项目记忆与当前项目记忆语义相似但内容相反时，该条的**有效置信度减半**、
    分数下调，并在注入块与状态脉冲里提示「建议忽略历史经验，以当前环境为准」——
    只改投影，绝不回写存储。
  - 会话级记忆带默认 TTL（`sessionTtlMs`，默认 24h），并提供 `ana_scope action="drop-session"`
    一次性到期（普通事务、可回滚）。
  - 新工具 `ana_list`（按作用域列出记录）与 `ana_scope`（status/list/namespaces/retag/adopt/drop-session）。
    `retag` 把记忆重新归档且**可回滚**；把项目级记忆提升为全局需要 `authorizeGlobal: true`
    **与用户显式授权**，并且有一道不变量在事务层再拦一次。
  - 两个新不变量：`scope.tagged`（没有作用域标签的记录写不进去）、`scope.no-silent-widening`
    （未经授权不得把记忆扩大为全局）。
  - 新 CLI：`node tools/scope-report.mjs`（只读体检：命名空间分布、已知项目、物理文件、档位解释）。
- **预设 = 权限层**：写入类工具只在预设作用域里注册（新行 `dsh-anagenesis/tools-gated`）。
  没有预设时模型**看不到** `ana_remember` 等工具，而不是"被劝阻"。
  - 工具分级 `read` / `write` / `admin`，档位 `passive` / `assisted`（默认）/ `autonomous`。
    `passive` 不注册任何写入工具；`autonomous` 额外允许策略自动调度与技能自动结晶。
  - **执行期检查**：`ctx.tools.guard()` 上的 tier 护栏 + 每个 gated 工具自带的 `assertGrant`，
    即便工具定义被缓存或调用在飞行中，授权撤销后一样拒绝。绕不过去，不只是提示词约束。
  - 档位切换可逆且与工具注册同步：`ana_preset action="gear"`（降级自由、升级需宿主授权）、
    预设配置文件、或 `service.permissions.setGear()`；注销预设精确回滚到只读工具集。
  - 预设在每一步通过 `systemPrompt.context()` 注入 `<anagenesis-pulse>`：当前项目、档位、
    可用工具集；召回块尾部同样带它。冲突与跨项目授权也会出现在脉冲里。
  - 元调参新增两个旋钮 `recall.scopeWeight` 与 `recall.crossProjectFactor`。
- **可视化**：仪表盘新增 `scope` 分区（当前项目 / 各命名空间 / 默认写入层级 / 档位 / 迁移遗留），
  记忆图与显著度列表按作用域标注与着色；`ana_dashboard`/`ana_diagram` 新增 `allProjects`
  参数（默认关闭 = 显示模型真正召得回的那些）。

### 变更

- 结构版本 `SCHEMA_VERSION` 6 → 7。迁移是纯函数且幂等：v6 记录带 `workspace` 的按该路径
  归入正确项目；其余 `global: true` 的标记为 `origin: "migrated-global"`，继续可召回但被降权，
  可用 `ana_scope action="adopt"` 收回到当前项目。
- `tools/index.js` 拆分为 `tools/definitions.js`（工具定义与分级）+ `tools/index.js`（只读行）
  + `tools/gated.js`（预设内注册写入行）。同一次调用里 `ana_recall` 返回新增
  `memoryTokens`（记忆块本身的 token，`maxTokens` 管的是它）与 `scopes` / `crossProject` / `conflicts`。
- 预设组合新增 `anagenesis-tools-gated` 行；自动生成的目录形式若与本插件写入的内容不一致会被
  **刷新**（手改过的文件仍然一字节不动）。

## [0.1.1] — 2026-10-08

> 本版本不改变任何运行时行为，只把许可证声明与发布元数据对齐到 Apache-2.0。

### 变更

- **许可证：MIT → Apache License 2.0**。仓库的 `LICENSE` 已换成 Apache-2.0 正文；本版本补齐
  它没有覆盖到的元数据：父包与窗口包的 `package.json` 均声明 `"license": "Apache-2.0"`，
  窗口包自带一份 `LICENSE`（npm 只打包本包目录里的许可证正文），两个 README 的许可证徽章
  与章节同步更新。
  **注意**：已经发布的 `0.1.0` 仍是 MIT —— 已发出的版本不可追溯改约，Apache-2.0 适用于
  本仓库当前内容与此后发布的版本。

- 发布前自检不再把许可证写死成 MIT：期望的 SPDX id 只在 `tools/preflight-publish.mjs`
  里声明一次，并新增「LICENSE 正文真的是 Apache-2.0」「窗口包自带 LICENSE」两项断言。

## [0.1.0] — 2026-10-07

首个公开版本。

### 新增

- **闭环记忆存储**：自带 `journal/*.jsonl` 追加日志 + `snapshot.json` + 检查点，不依赖任何外部记忆插件。
- **17 个面向 Agent 的语义记忆工具**：`ana_recall` / `ana_remember` / `ana_promote` / `ana_demote` /
  `ana_lock` / `ana_expire` / `ana_split` / `ana_rethink` / `ana_forget` / `ana_link` / `ana_strategy` /
  `ana_tune` / `ana_feedback` / `ana_audit`，以及可视化三件套 `ana_dashboard` / `ana_diagram` / `ana_window`。
- **可切换的注入策略**：`explore` / `exploit` / `debug` / `distill` / `guard`，运行时可换栈。
- **元策略自调节**：带参数包络约束、UCB1 选臂、审计与回滚。
- **`anagenesis` Agent 预设**：安装后自动注册，中文系统提示词。
- **可视化**：终端 TUI 仪表盘、mermaid / d2 / ascii 文本图表、以及**可选**的桌面原生窗口
  （独立包 `dsh-anagenesis-window`，中文卡片 + 自研内联 SVG 关系图，三个入口位置）。
- **可逆性与护栏**：每次变更都带逆操作；8 条单调收紧的不变量；`safeMode` 冻结元层。
- **中英双语文档**：`README.md` / `README.en.md`，窗口包同样成对。

### 变更

- **包名与工具前缀**：`dsh-anagenesis` / `dsh-anagenesis-window`，工具前缀 `ana_*`，
  cordis 服务 `ctx.anagenesis`，Loader 行 id `anagenesis-*`，预设 id `anagenesis`。
- **存储目录**：默认 `$DSH_HOME/anagenesis`。检测到改名前的 `$DSH_HOME/evolution` **数据更完整**时会
  继续使用它并给出提示，**不自动搬迁**；搬迁请显式运行 `npm run migrate:store`（复制 + 逐文件校验）。
- **界面全面中文化**：Agent 预设系统提示词、全部工具描述与参数说明、窗口界面与图表、
  配置项说明。内部标识符与枚举值保持英文。
- 桌面窗口的图表改为**自研分层有向图 + 内联 SVG**，不再输出 Mermaid 源码；支持横向 / 纵向布局与缩放。

### 修复

- 窗口助手样式表与渲染层标记**双所有者**导致内容裸堆叠、图形丢色、内容区无法滚动。
- 注入的 HTML 控件收不到 React 合成 `onChange`，导致「图种 / 方向 / 宽度」点不动。
- 存储路径解析在「schema 默认值已预填」时**永远走不到兼容回退**，老用户会看到空存储。
- 桌面窗口与核心各自计算存储路径而分叉，出现「核心记得住、窗口显示 0 条记忆」。

### 已知限制

- 改名前的存储目录名 `evolution` 作为**读取兼容**保留在 `src/paths.js` 的 `LEGACY_ROOT_DIR_NAME`——
  那是磁盘上的真实目录名，不是遗留的插件名。
- 错误消息与 journal 审计词汇仍为英文（它们是持久化词汇，统一改动属 store 层工作）。
- 桌面窗口的 GUI 内点击验收需带鉴权的页面地址，尚未纳入自动化闸门。