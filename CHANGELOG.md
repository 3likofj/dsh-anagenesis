# 更新日志

本文件记录每次发布的变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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