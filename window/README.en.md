# dsh-anagenesis-window

The **desktop window** of [dsh-anagenesis](../README.md) plus its **three entrance points**.
One Loader row, one `dsh.client` half, one window — three doors. (The better-sidebar
bottom-workbench row was removed: it mapped into the same right column as entry 1, so it
read as two rows pointing at one window.)

```
dsh-anagenesis           memory · strategy · tuner · guard · ana_dashboard / ana_diagram / TUI
dsh-anagenesis-window    the native window + its entrances        ← this package
```

The window is a **second surface for one model**, never a second renderer: every
pixel in it is produced by `src/viz/model.js` + `tui.js` / `diagram.js` — the same
pure functions behind `ana_dashboard`, `ana_diagram` and `tools/viz-watch.mjs`. A
frame in the window and the same frame in a tool answer are byte-identical.

## Why a separate package

`@deepseek-ai/dsh-client-modules` allows a package that declares `dsh.client`
**exactly one active Loader row**. `dsh-anagenesis` is five rows, and the `anagenesis`
preset mounts them a second time — adding `dsh.client` there could never boot. That
failure was hit and reverted once already. So the window is a
single-row sibling, and:

> **Never add `dsh-anagenesis-window` to the `anagenesis` preset composition and never
> mount it twice in one profile.** The preset is *aware* of the capability (see
> `OPERATING_NOTES` in `dsh-anagenesis`) but deliberately does not mount it.

## The entrances

| # | Entrance | Seat | Extension point | Present when |
|---|---|---|---|---|
| 1 | 侧栏一行 | `better-sidebar-row` | `ctx.betterSidebar.registerTab()` | DSH-better-sidebar installed |
| 1′ | （备用席位） | `official-left-footer` | slot `sidebar.footer.action` | opt-in, better-sidebar **absent** |
| 3 | 官方右侧侧边栏 | `official-right-sidebar` | `ctx.sidebarRightTabs.register()` + slots `sidebar.right.pane.tab` / `.title` | better-sidebar absent (or `officialEntry: always`) |
| 4 | 对话 / 轨迹顶部栏 | `conversation-header` | slot `conversation.session.header.utilities` | slots service present |

> **入口 2（better-sidebar 底部工作台）已按要求移除。** 它映射进的是和入口 1 同一个
> 右侧栏，表现为"一个窗口的两行入口"；移除后 better-sidebar 下只剩一行。见
> `src/client/parts/10-const.js` 的 `ENTRY_GROUPS`。

Entry 1 has two candidate seats and **at most one is ever armed**, which is what
keeps "no duplicate entries" true under both readings of "the left column".

Each entrance opens the *same* window: they all call `open()` / `close()` /
`toggle()` on one engine, and the window itself has exactly one seat — `shell.overlay`,
the frame-wide layer above every column. A sidebar tab renders a one-button
launcher, never a second dashboard.

## What the window draws

窗口内容**不是**终端文本帧，而是本包自己的渲染层画出来的 HTML/内联 SVG：

| 面 | 内容 |
|---|---|
| 仪表盘 | 关键指标卡（记忆总数 / 活跃比例 / 安全模式 / 存储版本 / 数据来源）+ 中文分区、彩色分布条、重要度排行、日志尾部、颜色图例 |
| 图表 · 记忆关系图 | 分层有向图，节点方框按**类型**上色、左上圆点按**生命周期状态**上色，连线按**关系**上色，`<title>` 悬停给全文；支持 LR / TB 与缩放 |
| 图表 · 生命周期流转 | 状态节点的迁移图，连线标签是**日志里真实观测到的次数**；只记目的态的操作画成虚线"操作"节点，不编造来源 |
| 图表 · 策略时间线 | 垂直时间轴，事件按类型上色 |

`src/render/*.js` 是一组**无 import/export 的纯函数部件**：`tools/build-client.mjs`
把它们原样拼进 `client.js`，`tools/render-lib.mjs` 用 `new Function` 把它们装进 Node
作用域供预览与截图使用。一份源码，两个宿主 —— 所以"截图里看到的"就是"窗口里的"。

```bash
cd window && node tools/preview.mjs          # 渲染 5 个视图 + 截图到 .preview/*.png
cd window && node tools/preview.mjs --root "$DSH_HOME/anagenesis"   # 用真实存储（只读）
```

## Compatibility matrix

| | 装 DSH-better-sidebar | 没装 DSH-better-sidebar |
|---|---|---|
| **1** 侧栏一行 | ✅ armed — a tab row in the better-sidebar `+` guide | ⚪ `degraded` — no seat, no error, no residue (set `leftColumnFallback: official-footer` to arm 1′ instead) |
| **3** 官方右侧栏 | 🚫 `suppressed` by policy (`officialEntry: auto`) — better-sidebar maps its own tab types into **this same column**, so arming both would put two rows for one window in one column. `officialEntry: always` overrides; `off` disables unconditionally. | ✅ armed — a native tab type + guide row + body/title seats |
| **4** 顶部栏 | ✅ armed | ✅ armed |
| **window** | ✅ `shell.overlay`, once | ✅ `shell.overlay`, once |

Every cell above is asserted in `test/entries.test.mjs`, in both environments, plus
the two transitions (better-sidebar appearing / disappearing) in between.

## Extension points used, and where that was read from

Nothing here is guessed. Each contract was read off the shipped implementation of
the plugin that owns it:

| Contract | Source read |
|---|---|
| `ctx.betterSidebar.registerTab / openTab / features` | `dsh-better-sidebar@0.24.1` `lib/types/client/service.d.ts` |
| better-sidebar maps its tab types into DSH's native right column, `target: 'bottom'` is its own workbench | `dsh-better-sidebar/src/client/native/index.ts`, `README.md` ("右侧栏 + 底部面板双工作台") |
| `ctx.sidebarRightTabs.register({ id, kind, title, guide })` + keyed `sidebar.right.pane.tab` / `.title` seats | `dsh-my-guardian@0.4.3` `lib/client.js:1203-1232` |
| `ctx.inject(deps, cb)` re-runs when a service appears/disappears | `dsh-better-sidebar/src/client/native/index.ts:228` (with the real-profile bug it fixed) |
| `ctx.on('internal/service', (name, value) => …)` | `@deepseek-ai/cordis/lib/index.js`, `src/events.ts` |
| `conversation.session.header.utilities` is an ordered list slot left of the shell's corner control | `dsh-better-sidebar/src/client/sidebar/bottom-toggle.tsx` |
| Desktop-shell stamps `dsh-desktop-mode` / `dsh-desktop-platform` / `__DSH_DESKTOP_FILE_PATH__` | `dsh-better-sidebar/src/client/desktop-env.ts` |
| `ctx.webServer.register({ kind, path, handler })`, duplicate path throws | `@deepseek-ai/dsh-host-webserver` README + `lib/index.js` |
| `dsh.client` classic-script bundle shape, `require` closed table | `@deepseek-ai/dsh-client-modules` README; `dsh-my-guardian/lib/client.src.js` |

Two contracts are **assumed** rather than read, and are listed here with
the reason: the exact slot keys `sidebar.footer.action` (from the live Slot ledger —
observed, not typed) and the shape of `guide` entries beyond `{ id, order, title }`.

## Install

```sh
# from this repository (the profile already links dsh-anagenesis the same way)
dsh plugin --profile desktop add link:<absolute path to this repo>/window
```

Or add to `$DSH_PROFILE_DIR/package.json`:
`"dsh-anagenesis-window": "link:<absolute path to this repo>/window"` and put
`dsh-anagenesis-window` into `dsh.profile.bundles`. A bundle patch
(`cordis.patch.yml`) inserts the single row — no `cordis.patch.yml` edits.

Removing the row (or the bundle) disposes every effect it owns: the slot
registrations, the tab types, the `<style>` node, the timers, the route and the
service. `test/entries.test.mjs` asserts the residue-free part twice.

## Config (host half; the client half reads it over its own route)

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | one-line kill switch; `disabled: true` on the row is the other |
| `rootDir` | `''` → `$DSH_HOME/anagenesis` (falls back to the pre-rename directory when it holds more data) | the store to mirror, read-only |
| `title` | `anagenesis · 可视化` | the window title and every entry's label |
| `redaction` | `secrets` | `none` \| `secrets` \| `strict` — same vocabulary as the tools, applied **before** transport |
| `width` `events` `salience` `diagramNodes` | `96` `8` `5` `40` | render caps |
| `refreshMs` | `2000` | poll period; also the upper bound on `ana_window` latency |
| `officialEntry` | `auto` | `auto` \| `always` \| `off` — entry 3's policy |
| `leftColumnFallback` | `off` | `off` \| `official-footer` — entry 1's alternate seat |
| `exposeWindowTool` | `true` | register `ana_window` (the agent door) |
| `trustedHosts` | `[]` | non-loopback authorities the route also answers |

Client-visible config is versioned (`configVersion: 2`) and migrated by name:
`officialSidebar: boolean` → `officialEntry`, `officialEntry: 'hidden'` → `'off'`,
`bottomEntry` dropped. Unknown keys are reported in `status().migration.unknown`
rather than merged in and forgotten.

### `pointer-events: auto` is load-bearing

The live `shell.overlay` catalog reads: *"The layer itself is **click-through** —
entries opt back into pointer events — so an occupant never blocks the app
underneath."* The window therefore **must** declare `pointer-events: auto`; without
it, it renders perfectly and is undraggable, unclickable and unscrollable. This was
a real defect found only on a real host — the offline suite has no hit testing — and
`test/detect.test.mjs` now guards it.

## Installing it (this is what makes anything visible)

The client half is only served when the row is mounted, so **nothing appears until
the package is installed**. One command, and it applies live — no restart:

```sh
plugin_manager action=install_bundle target=<absolute path to this repo>/window
# → dependencies += "dsh-anagenesis-window": "link:<absolute path to this repo>/window"
# → dsh.profile.bundles += "dsh-anagenesis-window"
# → {"stage":"enable","changed":true,"application":"applied"}
```

`dsh-client-modules` rescans incrementally on every `internal/plugin` emission, and
`dsh-client-hmr` syncs the **already-open page** onto the new graph, so the entrances
appear without a refresh.

## The agent door

An Agent has no mouse, so `ana_window` writes one request into an in-memory slot on
the Host and the window drains it on its next poll (`≤ refreshMs`). DSH publishes no
host→client push for a package's own client half, so that indirection is stated as a
limit, not hidden: with no GUI attached the request simply stays pending, and the
tool tells the Agent not to depend on the window having appeared.

```jsonc
// ana_window { "action": "status" }
{ "ok": true, "action": "status", "delivered": "none", "windowInstalled": true,
  "betterSidebarMounted": true,
  "expectedEntries": ["better-sidebar-row", "conversation-header"],
  "storeFound": true, "storeVersion": 42, "pending": false, "text": "…" }
```

## Develop

```sh
npm run build:client   # splice src/render/*.js + src/client/parts/*.js → client.js (committed)
npm run check          # node --check every file + assert client.js is not stale
npm test               # 72 offline tests, both environments
npm run probe          # real node:http server + real fetch against a sandbox store
npm run gate           # all four: build, check, test, probe
node tools/preview.mjs # render + screenshot the real output (.preview/*.png)
```

`client.js` is a **built artifact** and is committed: `npm run check` fails when it
is stale with respect to `src/render/*` or `src/client/parts/*`. Edit the parts,
never the bundle.

> **Host half vs client half reload.** The client half is hot-swapped by
> `dsh-client-modules` (a Loader graph rescan), but the Node half is imported once
> into the app process — toggling the bundle in the plugin manager does **not**
> re-execute it, because the ESM module is already in the module cache. So after
> changing `src/host/*` or adding an RPC method, the desktop app must be restarted.
> The window survives that skew: it falls back to the old `frame` / `diagram` text
> methods and says 「降级为文本视图」 instead of showing an error
> (`test/window.test.mjs`: *"a Host half that only knows the text methods degrades
> instead of erroring"*).

### What the offline tests can and cannot prove

They *do* execute the real bundle in a faithful fake client Context (services,
`inject`, `effect`, slots, both collaborators) with a small React runtime, so
"which seat arms where", "a seat arms once", "a dependency appearing/disappearing
flips the seat" and "teardown leaves nothing" are behavioural results over the real
code.

They *cannot* prove layout, pointer dragging or that a real host renders the window
where it looks right — there is no layout engine here. Those need one real-host pass
.

## License

[Apache License 2.0](https://github.com/3likofj/dsh-anagenesis/blob/main/LICENSE) — the
same license as the kernel package `dsh-anagenesis`; this package ships its own copy of
the license text.