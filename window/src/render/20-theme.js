/**
 * 色彩语义系统 + 样式表 —— 渲染层第 2 部分。
 *
 * 信息设计只有一条规则：**颜色编码身份，徽标编码健康度**。
 * 一个记忆节点"是什么"（类型）用填充/边框色表达，"现在怎么样"（生命周期状态）
 * 用左上角的小圆点表达。两者分开，才不会出现"一个红节点到底是失败记忆还是
 * 过期记忆"这种无法回答的问题。
 *
 * 色板全部走 CSS 自定义属性，优先用宿主主题 token（`--dsw-alias-*`），拿不到时
 * 落到字面量。这样同一份标记在 DSH 桌面窗口里跟随明暗主题，在离线预览里也能渲染。
 */

/** 语义色名 → CSS 变量。`dim` 是"降低视觉权重"，不是"不可用"。 */
const ANA_VAR = Object.freeze({
  ok: 'var(--evo-ok)',
  okBright: 'var(--evo-ok-bright)',
  warn: 'var(--evo-warn)',
  bad: 'var(--evo-bad)',
  info: 'var(--evo-info)',
  violet: 'var(--evo-violet)',
  indigo: 'var(--evo-indigo)',
  teal: 'var(--evo-teal)',
  accent: 'var(--evo-accent)',
  dim: 'var(--evo-dim)',
  plain: 'var(--evo-fg)',
})

/** 模型里的 `tone`（`src/viz/model.js` 产出）→ 语义色。 */
const TONE_TO_COLOR = Object.freeze({
  ok: 'ok',
  warn: 'warn',
  bad: 'bad',
  accent: 'accent',
  dim: 'dim',
  plain: 'plain',
})

/** 生命周期状态 → 徽标色。危险=红、待定=橙、成功=绿、钉住=紫、次要=灰。 */
const STATE_TO_COLOR = Object.freeze({
  draft: 'warn',
  active: 'ok',
  verified: 'okBright',
  locked: 'violet',
  deprecated: 'dim',
  expired: 'bad',
  retired: 'dim',
})

/** 记忆类型 → 身份色（8 个可分辨色相）。 */
const KIND_TO_COLOR = Object.freeze({
  fact: 'teal',
  preference: 'violet',
  procedure: 'ok',
  heuristic: 'info',
  episode: 'dim',
  hypothesis: 'warn',
  constraint: 'indigo',
  failure: 'bad',
})

/** 关系类型 → 连线色。支持/矛盾/取代 是三种"读图时最该一眼分开"的关系。 */
const REL_TO_COLOR = Object.freeze({
  supports: 'ok',
  contradicts: 'bad',
  supersedes: 'violet',
  superseded_by: 'violet',
  caused_by: 'info',
  part_of: 'indigo',
  challenged_by: 'warn',
  counterfactual_of: 'accent',
  derived_from: 'teal',
  related: 'dim',
})

/** 事件类型前缀 → 时间线节点色。 */
const EVENT_TO_COLOR = Object.freeze([
  ['memory.forget', 'bad'],
  ['memory.expire', 'bad'],
  ['memory.sweep', 'bad'],
  ['engine.quarantine', 'bad'],
  ['guard.denied', 'bad'],
  ['memory.promote', 'ok'],
  ['memory.lock', 'violet'],
  ['memory.demote', 'warn'],
  ['meta.tune', 'accent'],
  ['strategy.setStack', 'accent'],
  ['revert', 'warn'],
  ['preset.bind', 'info'],
])

/** @param {unknown} tone @returns {string} */
function toneColor(tone) {
  const key = String(tone ?? 'plain')
  return Object.prototype.hasOwnProperty.call(TONE_TO_COLOR, key) ? TONE_TO_COLOR[key] : 'plain'
}

/** @param {unknown} state @returns {string} */
function stateColor(state) {
  const key = String(state ?? '')
  return Object.prototype.hasOwnProperty.call(STATE_TO_COLOR, key) ? STATE_TO_COLOR[key] : 'dim'
}

/** @param {unknown} kind @returns {string} */
function kindColor(kind) {
  const key = String(kind ?? '')
  return Object.prototype.hasOwnProperty.call(KIND_TO_COLOR, key) ? KIND_TO_COLOR[key] : 'dim'
}

/** @param {unknown} rel @returns {string} */
function relColor(rel) {
  const key = String(rel ?? '')
  return Object.prototype.hasOwnProperty.call(REL_TO_COLOR, key) ? REL_TO_COLOR[key] : 'dim'
}

/** @param {unknown} type @returns {string} */
function eventColor(type) {
  const key = String(type ?? '')
  for (const [prefix, color] of EVENT_TO_COLOR) {
    if (key === prefix || key.startsWith(prefix + '.') || key.startsWith(prefix + '/')) return color
  }
  return 'dim'
}

/** @param {string} name @returns {string} */
function evoColor(name) {
  return Object.prototype.hasOwnProperty.call(ANA_VAR, name) ? ANA_VAR[name] : ANA_VAR.plain
}

/**
 * 全量样式表。窗口与离线预览共用同一份 —— 预览里验证过的观感就是窗口里的观感。
 *
 * 作用域规则：所有规则都挂在 `[data-dsh-anagenesis-window]` 下面，所以整份样式在
 * 一个没有本窗口的页面里匹配零个元素；卸载时只删掉自己那一个 `<style>` 节点。
 */
const ANA_CSS = `
[data-dsh-anagenesis-window]{--evo-ok:var(--dsw-alias-state-success-primary,#3fb950);
--evo-ok-bright:#2fd07a;--evo-warn:var(--dsw-alias-state-warn-primary,#d9a03a);
--evo-bad:var(--dsw-alias-state-error-primary,#e0554e);
--evo-info:#5aa9e6;--evo-violet:#a97bff;--evo-indigo:#6b7cff;--evo-teal:#3fbfae;
--evo-accent:var(--dsw-alias-brand-primary,#4d6bfe);
--evo-dim:var(--dsw-alias-state-idle-primary,#8b8b93);
--evo-fg:var(--dsw-alias-label-primary,#e9e9ec);
--evo-fg2:var(--dsw-alias-label-secondary,#b6b6bd);
--evo-line:var(--dsw-alias-border-l1,rgba(127,127,127,.24));
--evo-line2:var(--dsw-alias-border-l2,rgba(127,127,127,.38));
--evo-bg:var(--dsw-alias-bg-overlay,#1c1c20);
--evo-bg2:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));
--evo-bg1:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.16));
--evo-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Microsoft YaHei",monospace;
--evo-sans:system-ui,-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;
box-sizing:border-box;color:var(--evo-fg);font-family:var(--evo-sans);font-size:13px;line-height:1.6}
[data-dsh-anagenesis-window] *{box-sizing:border-box}
/* React 注入 HTML 必须有一个宿主节点（dangerouslySetInnerHTML），而那个节点不该
   参与布局：display:contents 让里面的标题栏/工具栏/页脚直接成为窗口的 flex 子项。 */
.evo-chrome{display:contents}

/* ── 窗口外壳 ───────────────────────────────────────────────────────────── */
[data-dsh-anagenesis-window="window"]{position:fixed;z-index:60;display:flex;flex-direction:column;
pointer-events:auto;width:min(880px,94vw);height:min(640px,82vh);min-width:460px;min-height:280px;
overflow:hidden;resize:both;border:1px solid var(--evo-line2);border-radius:12px;background:var(--evo-bg);
box-shadow:0 20px 64px rgba(0,0,0,.44)}
/* 工具栏在两行里放得下就绝不裁切：overflow-x:auto 会把「关闭」推到看不见的地方，
   而一个看不见的关闭按钮比一个两行高的工具栏糟得多。控件本身不换行（见 .evo-field）。 */
.evo-bar{display:flex;align-items:center;gap:8px;flex:0 0 auto;flex-wrap:wrap;row-gap:6px;
padding:8px 10px;border-bottom:1px solid var(--evo-line);background:var(--evo-bg2)}
[data-dsh-anagenesis-window="window"] .evo-bar.evo-drag{cursor:grab;user-select:none}
[data-dsh-anagenesis-window="window"] .evo-bar.evo-drag:active{cursor:grabbing}
.evo-title{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:650;font-size:13px}
.evo-bar .evo-spacer{flex:1 1 auto}
.evo-btn{appearance:none;display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;
flex:0 0 auto;
border:1px solid var(--evo-line);border-radius:7px;background:transparent;color:var(--evo-fg2);
font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.evo-btn:hover{background:var(--evo-bg1);color:var(--evo-fg)}
.evo-btn[aria-pressed="true"]{border-color:var(--evo-accent);color:var(--evo-accent);background:color-mix(in srgb,var(--evo-accent) 12%,transparent)}
.evo-btn.evo-icon{padding:0 7px;font-size:13px}
/* 控件标签绝不换行：第一版截图里「节点上限」被挤成两行，是这个 flex 容器收缩导致的。 */
.evo-field{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;white-space:nowrap;
font-size:12px;color:var(--evo-fg2)}
.evo-input{height:26px;border:1px solid var(--evo-line);border-radius:7px;background:transparent;
color:var(--evo-fg);font:inherit;font-size:12px;padding:0 6px}
.evo-input--w{width:60px}
.evo-sep{width:1px;height:18px;background:var(--evo-line);margin:0 2px}
.evo-foot{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:6px 10px;
border-top:1px solid var(--evo-line);font-size:11.5px;color:var(--evo-fg2)}
.evo-warn-text{color:var(--evo-warn)}
.evo-error-text{color:var(--evo-bad)}
.evo-ok-text{color:var(--evo-ok)}

/* ── 内容容器（窗口与预览共用） ─────────────────────────────────────────── */
.evo-pane{flex:1 1 auto;min-height:0;overflow:auto;padding:12px}
.evo-pane--flush{padding:0}

/* ── 关键指标卡 ─────────────────────────────────────────────────────────── */
.evo-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px;margin-bottom:12px}
.evo-card{position:relative;padding:10px 12px;border:1px solid var(--evo-line);border-radius:10px;
background:var(--evo-bg2);overflow:hidden}
.evo-card::before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--evo-dim);opacity:.9}
.evo-card--ok::before{background:var(--evo-ok)}
.evo-card--warn::before{background:var(--evo-warn)}
.evo-card--bad::before{background:var(--evo-bad)}
.evo-card--accent::before{background:var(--evo-accent)}
.evo-card--plain::before{background:var(--evo-dim)}
.evo-card-label{font-size:11.5px;color:var(--evo-fg2);letter-spacing:.02em}
.evo-card-value{font-size:23px;font-weight:700;line-height:1.25;font-variant-numeric:tabular-nums}
.evo-card-value small{font-size:12px;font-weight:500;color:var(--evo-fg2);margin-left:5px}
.evo-card--bad .evo-card-value{color:var(--evo-bad)}
.evo-card--warn .evo-card-value{color:var(--evo-warn)}
.evo-card--ok .evo-card-value{color:var(--evo-ok)}
.evo-card-sub{font-size:11.5px;color:var(--evo-fg2)}
.evo-card--hot{border-color:var(--evo-bad);background:color-mix(in srgb,var(--evo-bad) 10%,transparent)}

/* ── 分区卡片 ───────────────────────────────────────────────────────────── */
.evo-sect{margin-bottom:12px;border:1px solid var(--evo-line);border-radius:10px;background:var(--evo-bg2);overflow:hidden}
.evo-sect-head{display:flex;align-items:baseline;gap:8px;padding:8px 12px;border-bottom:1px solid var(--evo-line)}
.evo-sect-title{font-weight:650;font-size:13px}
.evo-sect-hint{font-size:11.5px;color:var(--evo-fg2)}
.evo-sect-body{padding:6px 12px 10px}

/* ── 行 ─────────────────────────────────────────────────────────────────── */
.evo-row{display:grid;grid-template-columns:minmax(96px,34%) 1fr auto;align-items:center;gap:10px;
padding:5px 0;border-bottom:1px dashed color-mix(in srgb,var(--evo-line) 70%,transparent)}
.evo-row:last-child{border-bottom:0}
.evo-row-label{color:var(--evo-fg2);overflow-wrap:anywhere}
.evo-row-value{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.evo-row-note{grid-column:1 / -1;font-size:11.5px;color:var(--evo-fg2);font-family:var(--evo-mono)}
.evo-tone-accent .evo-row-value{color:var(--evo-accent);font-weight:600}
.evo-tone-ok .evo-row-value{color:var(--evo-ok);font-weight:600}
.evo-tone-warn .evo-row-value{color:var(--evo-warn);font-weight:600}
.evo-tone-bad .evo-row-value{color:var(--evo-bad);font-weight:700}
.evo-tone-plain .evo-row-value{color:var(--evo-fg)}
.evo-tone-dim{opacity:.62}
.evo-em{color:var(--evo-fg);font-weight:650}

/* ── 进度条（渐变 + 鲜明色块） ────────────────────────────────────────────
   类名是 .evo-pbar* 而不是 .evo-bar*：.evo-bar 已经是窗口与预览的**工具栏**，
   两者撞名时后一条规则的 height:18px/overflow:hidden 会把工具栏压成一条线 ——
   这个 bug 在截图里表现为"工具栏被裁掉"，实际是选择器互相覆盖。 */
.evo-pbar{position:relative;height:18px;border-radius:5px;background:color-mix(in srgb,var(--evo-dim) 18%,transparent);
overflow:hidden;min-width:80px}
.evo-pbar-fill{height:100%;border-radius:5px;background:linear-gradient(90deg,color-mix(in srgb,var(--evo-c) 55%,transparent),var(--evo-c))}
.evo-pbar--ok{--evo-c:var(--evo-ok)}
.evo-pbar--warn{--evo-c:var(--evo-warn)}
.evo-pbar--bad{--evo-c:var(--evo-bad)}
.evo-pbar--accent{--evo-c:var(--evo-accent)}
.evo-pbar--info{--evo-c:var(--evo-info)}
.evo-pbar--violet{--evo-c:var(--evo-violet)}
.evo-pbar--indigo{--evo-c:var(--evo-indigo)}
.evo-pbar--teal{--evo-c:var(--evo-teal)}
.evo-pbar--dim{--evo-c:var(--evo-dim)}
.evo-pbar--plain{--evo-c:var(--evo-fg2)}
.evo-pbar-cell{display:grid;grid-template-columns:minmax(96px,34%) 1fr 62px;align-items:center;gap:10px;padding:5px 0}
.evo-num{text-align:right;font-variant-numeric:tabular-nums;color:var(--evo-fg2)}
.evo-pbar-pct{opacity:.75}

/* ── 徽标 / 色块 ────────────────────────────────────────────────────────── */
.evo-chip{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;
border:1px solid currentColor;font-size:11.5px;line-height:1;white-space:nowrap}
.evo-chip::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.evo-c-ok{color:var(--evo-ok)}.evo-c-okBright{color:var(--evo-ok-bright)}
.evo-c-warn{color:var(--evo-warn)}.evo-c-bad{color:var(--evo-bad)}
.evo-c-info{color:var(--evo-info)}.evo-c-violet{color:var(--evo-violet)}
.evo-c-indigo{color:var(--evo-indigo)}.evo-c-teal{color:var(--evo-teal)}
.evo-c-accent{color:var(--evo-accent)}.evo-c-dim{color:var(--evo-dim)}.evo-c-plain{color:var(--evo-fg)}
.evo-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.evo-arrow{color:var(--evo-fg2);padding:0 2px}

/* ── 排行 ───────────────────────────────────────────────────────────────── */
.evo-rank{display:grid;grid-template-columns:22px 1fr auto;gap:9px;align-items:start;padding:7px 0;
border-bottom:1px dashed color-mix(in srgb,var(--evo-line) 70%,transparent)}
.evo-rank:last-child{border-bottom:0}
.evo-rank-no{color:var(--evo-fg2);font-variant-numeric:tabular-nums;text-align:right;font-size:12px}
.evo-rank-main{min-width:0}
.evo-rank-subject{overflow-wrap:anywhere}
.evo-rank-body{font-size:11.5px;color:var(--evo-fg2);overflow-wrap:anywhere}
.evo-rank-right{display:flex;flex-direction:column;align-items:flex-end;gap:5px}
.evo-meter{width:74px;height:6px;border-radius:3px;background:color-mix(in srgb,var(--evo-dim) 20%,transparent)}
.evo-meter-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,color-mix(in srgb,var(--evo-accent) 45%,transparent),var(--evo-accent))}

/* ── 图表 ───────────────────────────────────────────────────────────────── */
.evo-graph{position:relative;width:100%;min-height:240px;overflow:auto;
background:radial-gradient(circle at 1px 1px,color-mix(in srgb,var(--evo-dim) 26%,transparent) 1px,transparent 0)
0 0/18px 18px}
.evo-graph-inner{transform-origin:0 0}
.evo-svg{display:block}
.evo-svg .evo-edge{fill:none;stroke-width:1.6}
.evo-svg .evo-edge--dangling{stroke-dasharray:5 4;opacity:.75}
.evo-svg .evo-elabel{font-size:10.5px;font-family:var(--evo-sans)}
.evo-svg .evo-elabel-bg{fill:var(--evo-bg);fill-opacity:.88;stroke:none}
.evo-svg .evo-node-box{stroke-width:1.6;rx:9}
.evo-svg .evo-node-label{font-size:12px;font-family:var(--evo-sans);fill:var(--evo-fg)}
.evo-svg .evo-node-sub{font-size:10px;font-family:var(--evo-sans);fill:var(--evo-fg2)}
.evo-svg .evo-node{cursor:default}
.evo-svg .evo-node:hover .evo-node-box{filter:brightness(1.22)}
.evo-svg .evo-dot{stroke:none}
.evo-zoom{display:inline-flex;gap:4px;align-items:center}

/* ── 图例 ───────────────────────────────────────────────────────────────── */
.evo-legend{display:flex;flex-wrap:wrap;gap:6px 14px;padding:8px 12px;border-top:1px solid var(--evo-line);
font-size:11.5px;color:var(--evo-fg2);align-items:center}
.evo-legend-item{display:inline-flex;align-items:center;gap:5px}
.evo-legend-swatch{width:10px;height:10px;border-radius:3px;background:currentColor;flex:0 0 auto}
.evo-legend-title{font-weight:600;color:var(--evo-fg)}

/* ── 时间线 ─────────────────────────────────────────────────────────────── */
.evo-tl{position:relative;padding:4px 0 4px 4px}
.evo-tl::before{content:"";position:absolute;left:15px;top:8px;bottom:8px;width:2px;
background:linear-gradient(180deg,var(--evo-accent),var(--evo-line))}
.evo-tl-item{position:relative;display:grid;grid-template-columns:26px 1fr;gap:12px;padding:7px 0 7px 0}
.evo-tl-dot{position:relative;z-index:1;width:12px;height:12px;margin:5px auto 0;border-radius:50%;
background:var(--evo-c,var(--evo-dim));box-shadow:0 0 0 3px var(--evo-bg)}
.evo-tl-main{min-width:0}
.evo-tl-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.evo-tl-type{font-weight:650;color:var(--evo-c,var(--evo-fg))}
.evo-tl-meta{font-size:11.5px;color:var(--evo-fg2);font-variant-numeric:tabular-nums}
.evo-tl-detail{font-size:12px;color:var(--evo-fg2);font-family:var(--evo-mono);overflow-wrap:anywhere}

/* ── 空态 / 提示 ────────────────────────────────────────────────────────── */
.evo-text{font-family:var(--evo-mono);font-size:12px;line-height:1.5;white-space:pre;overflow:auto;margin:0;
color:var(--evo-fg)}
.evo-empty{padding:26px 18px;text-align:center;color:var(--evo-fg2)}
.evo-empty-title{font-size:14px;font-weight:650;color:var(--evo-fg);margin-bottom:6px}
.evo-notice{display:flex;gap:8px;align-items:flex-start;padding:8px 12px;border-radius:8px;
background:color-mix(in srgb,var(--evo-warn) 12%,transparent);border:1px solid color-mix(in srgb,var(--evo-warn) 40%,transparent);
color:var(--evo-fg);font-size:12px;margin-bottom:10px}
.evo-notice--bad{background:color-mix(in srgb,var(--evo-bad) 12%,transparent);
border-color:color-mix(in srgb,var(--evo-bad) 42%,transparent)}
.evo-notice--info{background:color-mix(in srgb,var(--evo-info) 12%,transparent);
border-color:color-mix(in srgb,var(--evo-info) 40%,transparent)}

/* ── 入口按钮（顶部栏 / 侧栏） ──────────────────────────────────────────── */
.evo-header-button{appearance:none;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;
border:1px solid var(--evo-line);border-radius:7px;background:transparent;color:var(--evo-fg2);
font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;font-family:var(--evo-sans)}
.evo-header-button:hover{background:var(--evo-bg1);color:var(--evo-fg)}
.evo-header-button[aria-pressed="true"]{border-color:var(--evo-accent);color:var(--evo-accent)}
.evo-launcher{display:flex;flex-direction:column;gap:12px;align-items:flex-start;padding:20px;
font-family:var(--evo-sans);color:var(--evo-fg)}
.evo-launch-btn{appearance:none;display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 15px;
border:1px solid var(--evo-accent);border-radius:9px;background:color-mix(in srgb,var(--evo-accent) 12%,transparent);
color:var(--evo-accent);font:inherit;font-weight:650;cursor:pointer}
.evo-launch-btn:hover{background:color-mix(in srgb,var(--evo-accent) 22%,transparent)}
.evo-launch-hint{color:var(--evo-fg2);font-size:12px;max-width:48ch}

/* ── 离线预览页（不在窗口里使用） ──────────────────────────────────────── */
html[data-evo-preview]{background:#141418}
html[data-evo-preview] body{margin:0;padding:24px;background:#141418}
html[data-evo-preview] .evo-preview-frame{max-width:1000px;margin:0 auto 26px;
border:1px solid var(--evo-line2);border-radius:12px;background:var(--evo-bg);overflow:hidden}
html[data-evo-preview] .evo-preview-cap{padding:10px 14px;border-bottom:1px solid var(--evo-line);
font-weight:650;font-size:13px}
`