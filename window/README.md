# dsh-anagenesis-window

[English](README.en.md)

[dsh-anagenesis](../README.md) 的**桌面窗口**，以及把这块窗口挂到界面上的**三个入口**。
一个 Loader 行、一份 `dsh.client` 客户端半、一个窗口 —— 三道门。

```
dsh-anagenesis           memory · strategy · tuner · guard · ana_dashboard / ana_diagram / TUI
dsh-anagenesis-window    the native window + its entrances        ← this package
```

窗口是**同一个模型的第二个呈现面**，绝不是第二个渲染器：它显示的每一段标记都由
`window/src/render/*.js` 这一个共享渲染层产出，窗口里的一帧与 `node tools/preview.mjs`
截图里的一帧来自同一份源码、同一份样式表。

内容是怎么来的：Host 半把 `dsh-anagenesis` 的**结构化模型**（`buildDashboardModel()` /
`buildDiagramModel()` 的原始对象）经自己的路由送过来，客户端侧再把它画成 HTML 与
**内联 SVG**。文本方法 `frame` / `diagram` **没有删**，只是留给 `ana_dashboard` /
`ana_diagram` 与终端 TUI 用；窗口拿到的是模型，既不是终端 ASCII 帧，也不是 Mermaid 源码。

**只读**：窗口绝不写入存储。它唯一的数据路径是 `readStoreMirror()` —— 它不接
`MemoryStore` 句柄，因此不在单写者池里，只是重放 `snapshot.json`、日志分段与最新
checkpoint。渲染不是事务，也就没有需要回滚的逆操作。

## 为什么必须是独立包

`@deepseek-ai/dsh-client-modules` 允许一个声明了 `dsh.client` 的包**有且只有一个活跃
Loader 行**。`dsh-anagenesis` 是五行，而 `anagenesis` 预设会在自己的 scope 里把这五行
再挂一次 —— 在那里加 `dsh.client` 永远启动不起来。这个失败模式已经真实踩过一次并回滚
（DSH 的硬约束）。所以窗口是一个**单行兄弟包**，并且：

> **永远不要把 `dsh-anagenesis-window` 加进 `anagenesis` 预设的组合里，也永远不要在同一个
> profile 里挂两次。** 预设*知道*这个能力（见 `dsh-anagenesis` 的 `OPERATING_NOTES`），
> 但有意不挂载它。

由此得到的推论是硬的：`dsh-anagenesis` 本包**永远不能**加 `dsh.client`。窗口是可选项，
没装它的 profile 只是少了窗口，别的一点都不少。

## 入口

| # | 入口 | 席位 | 扩展点 | 何时存在 |
|---|---|---|---|---|
| 1 | 侧栏一行 | `better-sidebar-row` | `ctx.betterSidebar.registerTab()` | 装了 DSH-better-sidebar |
| 1′ | 入口 1 的**备用席位**（不是独立入口） | `official-left-footer` | 槽位 `sidebar.footer.action` | 需显式开启，且 better-sidebar **不在** |
| 3 | 官方右侧侧边栏 | `official-right-sidebar` | `ctx.sidebarRightTabs.register()` + 槽位 `sidebar.right.pane.tab` / `.title` | better-sidebar 不在（或 `officialEntry: always`） |
| 4 | 对话 / 轨迹顶部栏 | `conversation-header` | 槽位 `conversation.session.header.utilities` | slots 服务在位 |

一共 **3 个入口**。编号保留 **1 / 3 / 4**，不改号 —— 这样跟既有界面编号对照时
不会错位。

> **入口 2（better-sidebar 底部工作台）已按要求移除。** 移除的理由不是"多余"，而是它
> 映射进的是和入口 1 **同一个右侧栏** —— 在用户眼里就是"一个窗口的两行入口"。移除后
> better-sidebar 下只剩一行。见 `src/client/parts/10-const.js` 的 `ENTRY_GROUPS`。

入口 1 有两个候选席位，且**任何时刻最多只有一个武装**，这正是"不出现重复入口"在
"左列"的两种读法下都成立的原因。

每个入口打开的都是**同一个**窗口：它们调用同一个 engine 的 `open()` / `close()` /
`toggle()`，窗口本体也只有一个席位 —— `shell.overlay`，覆盖在所有列之上的整帧图层。
一个侧栏页签渲染的是单按钮启动器，永远不是第二个仪表盘。

## 窗口画的是什么

窗口内容**不是**终端文本帧，而是本包自己的渲染层画出来的 HTML / 内联 SVG：

| 面 | 内容 |
|---|---|
| 仪表盘 | 关键指标卡（记忆总数 / 活跃比例 / 安全模式 / 存储版本 / 数据来源）+ 中文分区、彩色分布条、重要度排行、日志尾部、颜色图例 |
| 图表 · 记忆关系图 | 分层有向图，节点方框按**类型**上色、左上圆点按**生命周期状态**上色，连线按**关系**上色，`<title>` 悬停给全文；支持 LR / TB 与缩放 |
| 图表 · 生命周期流转 | 状态节点的迁移图，连线标签是**日志里真实观测到的次数**；只记目的态的操作画成虚线"操作"节点，不编造来源 |
| 图表 · 策略时间线 | 垂直时间轴，事件按类型上色 |

**图表是自研的内联 SVG，不用 mermaid**，理由有两条且都是硬的：① `dsh.client` 的
`require` 是**封闭表**（平台种子 + 显式 external），拿不到 `dsh-better-sidebar` 那个
7MB 的 mermaid chunk；② 引 CDN 又违反本插件 `offlineMode: true` 的披露。而记忆图谱只需
**分层有向图**这一种布局，自研既能把中文换行、颜色语义、悬停提示、节点上限这些要求
全部握在自己手里，纯函数又让同一段 SVG 既能进窗口、也能被光栅化成截图来验收。

**颜色语义**（一套规则贯穿仪表盘与图表，图例就画在窗口里）：

- **方框的填充/描边 = 记忆类型** —— 这是什么（fact / preference / procedure / …）
- **左上角圆点 = 生命周期状态** —— 现在怎么样（draft / active / verified / locked / …）
- **连线的颜色 = 关系** —— supports / contradicts / supersedes / …；虚线 = 指向图外的悬空引用
- 悬停显示完整标题、类型、状态、重要度与原始 id（`<title>`，零 JS）

`src/render/*.js` 是一组**无 import/export 的纯函数部件**：`tools/build-client.mjs` 把它们
原样拼进 `client.js`，`tools/render-lib.mjs` 用 `new Function` 把它们装进 Node 作用域供预览
与截图使用。一份源码、两个宿主 —— 所以"截图里看到的"就是"窗口里的"。

```bash
cd window && node tools/preview.mjs          # 渲染 5 个视图 + 截图到 .preview/*.png
cd window && node tools/preview.mjs --root "$DSH_HOME/anagenesis"   # 用真实存储（只读）
```

预览不只是出图，它同时是渲染层的闸门：检查 `<svg>` 真的在、没有 Mermaid 源码、没有
`#111827` 这类十六进制颜色泄漏、没有 `ana_mem_…` 原始 id，以及可见文本里不出现英文术语
（`chineseOnly`，扫描前会剥掉 `<style>` 与标签，`<option value="lifecycle">` 这种机器值
不算）。

## 兼容矩阵

| | 装了 DSH-better-sidebar | 没装 DSH-better-sidebar |
|---|---|---|
| **1** 侧栏一行 | ✅ armed —— better-sidebar `+` 指南里的一行页签 | ⚪ `degraded` —— 无席位、无报错、无残留（把 `leftColumnFallback` 设为 `official-footer` 可改挂 1′） |
| **3** 官方右侧栏 | 🚫 按策略 `suppressed`（`officialEntry: auto`）—— better-sidebar 把自己的页签类型映射进**同一列**，两个都武装就会在同一列里出现同一个窗口的两行。`officialEntry: always` 可覆盖，`off` 无条件关闭。 | ✅ armed —— 一个原生页签类型 + 指南行 + body / title 两个席位 |
| **4** 顶部栏 | ✅ armed | ✅ armed |
| **window** | ✅ `shell.overlay`，只挂一次 | ✅ `shell.overlay`，只挂一次 |

上表每一格都由 `test/entries.test.mjs` 在**两种环境**下断言，两次切换（better-sidebar
出现 / 消失）也在断言范围内。

## 用到的扩展点，以及它们读自何处

这里没有一处是猜的。每条契约都读自拥有它的那个插件的已发布实现：

| 契约 | 读自 |
|---|---|
| `ctx.betterSidebar.registerTab / openTab / features` | `dsh-better-sidebar@0.24.1` `lib/types/client/service.d.ts` |
| better-sidebar 把自己的页签类型映射进 DSH 原生右列；`target: 'bottom'` 是它自己的底部工作台 | `dsh-better-sidebar/src/client/native/index.ts`、其 `README.md`（"右侧栏 + 底部面板双工作台"） |
| `ctx.sidebarRightTabs.register({ id, kind, title, guide })` + 带 key 的 `sidebar.right.pane.tab` / `.title` 席位 | `dsh-my-guardian@0.4.3` `lib/client.js:1203-1232` |
| `ctx.inject(deps, cb)` 在服务出现/消失时重新执行 | `dsh-better-sidebar/src/client/native/index.ts:228`（连同它在真实 profile 上修掉的那个 bug） |
| `ctx.on('internal/service', (name, value) => …)` | `@deepseek-ai/cordis/lib/index.js`、`src/events.ts` |
| `conversation.session.header.utilities` 是宿主 corner 控件左侧的一个有序列表槽位 | `dsh-better-sidebar/src/client/sidebar/bottom-toggle.tsx` |
| 桌面壳会打上 `dsh-desktop-mode` / `dsh-desktop-platform` / `__DSH_DESKTOP_FILE_PATH__` | `dsh-better-sidebar/src/client/desktop-env.ts` |
| `ctx.webServer.register({ kind, path, handler })`，重复 path 抛错 | `@deepseek-ai/dsh-host-webserver` 的 README + `lib/index.js` |
| `dsh.client` 的 classic-script bundle 形状、`require` 封闭表 | `@deepseek-ai/dsh-client-modules` 的 README；`dsh-my-guardian/lib/client.src.js` |

有两条契约是**假定**而非读到的，其理由一并写在这里：槽位键 `sidebar.footer.action`
的确切拼写（来自运行中 shell 的 Slot 台账 —— 是观测到的，不是类型里有的），以及 `guide`
条目除 `{ id, order, title }` 之外的形状。

## 安装

```sh
# 从本仓库安装（profile 里 dsh-anagenesis 本来就是这样链进去的）
dsh plugin --profile desktop add link:<仓库绝对路径>/window
```

或者写进 `$DSH_PROFILE_DIR/package.json`：
`"dsh-anagenesis-window": "link:<仓库绝对路径>/window"`，并把 `dsh-anagenesis-window`
放进 `dsh.profile.bundles`。本包自带 bundle patch（`cordis.patch.yml`）插入那唯一一行
—— profile 的 `cordis.patch.yml` 不需要手改。

移除这一行（或移除 bundle）会释放它拥有的每一个 effect：槽位注册、页签类型、`<style>`
节点、定时器、路由与服务。`test/entries.test.mjs` 对"无残留"这件事断言了两次。

## 配置（Host 半；客户端半经自己的路由读取）

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 一行否决开关；行上的 `disabled: true` 是另一个 |
| `rootDir` | `''` → `$DSH_HOME/anagenesis` | 要镜像的存储，只读 |
| `title` | `anagenesis · 可视化` | 窗口标题，也是每个入口的标签 |
| `redaction` | `secrets` | `none` \| `secrets` \| `strict` —— 与工具同一套词汇，在**传输之前**应用 |
| `color` | `never` | `auto` \| `always` \| `never` —— 终端帧的着色；窗口自己按语义上色 |
| `width` `events` `salience` `diagramNodes` | `96` `8` `5` `40` | 渲染上限 |
| `includeBodies` | `false` | 是否把记忆正文纳入渲染（默认只给 gist） |
| `refreshMs` | `2000` | 轮询周期；也是 `ana_window` 延迟的上界 |
| `officialEntry` | `auto` | `auto` \| `always` \| `off` —— 入口 3 的策略 |
| `leftColumnFallback` | `off` | `off` \| `official-footer` —— 入口 1 的备用席位 |
| `exposeWindowTool` | `true` | 是否注册 `ana_window`（给 Agent 的那道门） |
| `trustedHosts` | `[]` | 路由额外应答的非回环 authority |

客户端可见的配置是带版本的（`configVersion: 2`），按**名字**迁移：
`officialSidebar: boolean` → `officialEntry`，`officialEntry: 'hidden'` → `'off'`，
`bottomEntry` 直接丢弃。未知键会出现在 `status().migration.unknown` 里被上报，而不是
合并进来然后忘掉。

### `pointer-events: auto` 是承重的

运行中 shell 的 `shell.overlay` 目录原文是：*"The layer itself is **click-through** —
entries opt back into pointer events — so an occupant never blocks the app underneath."*
所以窗口**必须**显式声明 `pointer-events: auto`；不加的话它渲染得完美无缺，但拖不动、
点不了、滚不动。这是一个只在真机上才暴露的真实缺陷（离线套件没有命中测试），现在由
`test/detect.test.mjs` 守着。

## 把它装上（这一步才让任何东西可见）

客户端半只在行被挂载时才被服务，所以**没装这个包之前，界面上什么都不会出现**。一条命令，
且立即生效 —— 不需要重启：

```sh
plugin_manager action=install_bundle target=<仓库绝对路径>/window
# → dependencies += "dsh-anagenesis-window": "link:<仓库绝对路径>/window"
# → dsh.profile.bundles += "dsh-anagenesis-window"
# → {"stage":"enable","changed":true,"application":"applied"}
```

`dsh-client-modules` 会在每次 `internal/plugin` 事件上做增量重扫，`dsh-client-hmr` 则把
**已经打开的页面**同步到新的图上，所以入口无需刷新就会出现。

## Agent 的门

Agent 没有鼠标，所以 `ana_window` 把一条请求写进 Host 上的内存槽位，窗口在下一次轮询时
把它取走（≤ `refreshMs`）。DSH 没有为插件自己的客户端半提供 host→client 推送，所以这层
间接被当作**限制**写明，而不是藏起来：没有 GUI 挂着的时候，请求就只是留在 pending，
工具也会明确告诉 Agent 不要依赖"窗口已经出现"。

```jsonc
// ana_window { "action": "status" }
{ "ok": true, "action": "status", "delivered": "none", "windowInstalled": true,
  "betterSidebarMounted": true,
  "expectedEntries": ["better-sidebar-row", "conversation-header"],
  "storeFound": true, "storeVersion": 42, "pending": false, "text": "…" }
```

## 开发

```sh
npm run build:client   # 拼装 src/render/*.js + src/client/parts/*.js → client.js（入库）
npm run check          # 对每个文件 node --check + 断言 client.js 不是旧的
npm test               # 83 个离线测试，两种环境
npm run probe          # 真 node:http 服务器 + 真 fetch，打到沙箱存储上
npm run gate           # 上面四件一起跑：build、check、test、probe
node tools/preview.mjs # 渲染真实输出并截图（.preview/*.png）
npm run test:ui        # 真机点击探针：真 Chromium 打开运行中的 GUI 并真的点
```

`client.js` 是**构建产物**且入库：当它相对 `src/render/*` 或 `src/client/parts/*` 变旧时，
`npm run check` 会失败。改部件，永远不要改 bundle。

`npm run test:ui`（`tools/live-ui-probe.mjs`）补的正是离线套件够不到的那一段：它打开
`--url` 指定的真实页面，点顶部栏入口开窗，断言窗口 `pointer-events` 是 `auto`、内容区
真的能滚、卡片真的有样式，然后点「图表」确认 SVG 被画出来、改「方向」确认选择生效。
`puppeteer-core` 或 Chromium 缺失时它会打印 `skipped` 并以 0 退出，不会把闸门弄红。

> **Host 半与客户端半的重载不一样。** 客户端半由 `dsh-client-modules` 热替换（Loader 图
> 重扫），但 Node 半只被 import 进 app 进程一次 —— 在 plugin manager 里关开 bundle
> **不会**重新执行它，因为 ESM 模块已经在 module cache 里了。所以改过 `src/host/*` 或新增
> RPC 方法之后，必须重启桌面端。窗口能扛住这种版本偏斜：它降级到旧的 `frame` / `diagram`
> 文本方法，并显示「降级为文本视图」加一句中文原因，而不是把错误糊在用户脸上
> （`test/window.test.mjs`：*"a Host half that only knows the text methods degrades
> instead of erroring"*）。

### 离线测试能证明什么、不能证明什么

它们**确实**在一个忠实的假客户端 Context 里执行真 bundle（服务、`inject`、`effect`、槽位、
两个协作者），并配了一个小 React 运行时，所以"哪个席位在哪里武装"、"一个席位只武装一次"、
"依赖出现/消失会翻转席位"、"拆卸之后什么都不剩"都是对真实代码的行为结论。

它们**不能**证明布局、指针拖动，也不能证明真机把窗口渲染在看起来对的位置上 —— 这里没有
布局引擎。那些需要一次真机复核。