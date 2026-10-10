# 更新日志

本文件记录每次发布的变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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