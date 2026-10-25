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
  ok: 'var(--ana-ok)',
  okBright: 'var(--ana-ok-bright)',
  warn: 'var(--ana-warn)',
  bad: 'var(--ana-bad)',
  info: 'var(--ana-info)',
  violet: 'var(--ana-violet)',
  indigo: 'var(--ana-indigo)',
  teal: 'var(--ana-teal)',
  accent: 'var(--ana-accent)',
  dim: 'var(--ana-dim)',
  plain: 'var(--ana-fg)',
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
[data-dsh-anagenesis-window]{--ana-ok:var(--dsw-alias-state-success-primary,#3fb950);
--ana-ok-bright:#2fd07a;--ana-warn:var(--dsw-alias-state-warn-primary,#d9a03a);
--ana-bad:var(--dsw-alias-state-error-primary,#e0554e);
--ana-info:#5aa9e6;--ana-violet:#a97bff;--ana-indigo:#6b7cff;--ana-teal:#3fbfae;
--ana-accent:var(--dsw-alias-brand-primary,#4d6bfe);
--ana-dim:var(--dsw-alias-state-idle-primary,#8b8b93);
--ana-fg:var(--dsw-alias-label-primary,#e9e9ec);
--ana-fg2:var(--dsw-alias-label-secondary,#b6b6bd);
--ana-line:var(--dsw-alias-border-l1,rgba(127,127,127,.24));
--ana-line2:var(--dsw-alias-border-l2,rgba(127,127,127,.38));
--ana-bg:var(--dsw-alias-bg-overlay,#1c1c20);
--ana-bg2:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));
--ana-bg1:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.16));
--ana-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Microsoft YaHei",monospace;
--ana-sans:system-ui,-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;
box-sizing:border-box;color:var(--ana-fg);font-family:var(--ana-sans);font-size:13px;line-height:1.6}
[data-dsh-anagenesis-window] *{box-sizing:border-box}
/* React 注入 HTML 必须有一个宿主节点（dangerouslySetInnerHTML），而那个节点不该
   参与布局：display:contents 让里面的标题栏/工具栏/页脚直接成为窗口的 flex 子项。 */
.ana-chrome{display:contents}

/* ── 窗口外壳 ───────────────────────────────────────────────────────────── */
[data-dsh-anagenesis-window="window"]{position:fixed;z-index:60;display:flex;flex-direction:column;
pointer-events:auto;width:min(880px,94vw);height:min(640px,82vh);min-width:460px;min-height:280px;
overflow:hidden;resize:both;border:1px solid var(--ana-line2);border-radius:12px;background:var(--ana-bg);
box-shadow:0 20px 64px rgba(0,0,0,.44)}
/* 工具栏在两行里放得下就绝不裁切：overflow-x:auto 会把「关闭」推到看不见的地方，
   而一个看不见的关闭按钮比一个两行高的工具栏糟得多。控件本身不换行（见 .ana-field）。 */
.ana-bar{display:flex;align-items:center;gap:8px;flex:0 0 auto;flex-wrap:wrap;row-gap:6px;
padding:8px 10px;border-bottom:1px solid var(--ana-line);background:var(--ana-bg2)}
[data-dsh-anagenesis-window="window"] .ana-bar.ana-drag{cursor:grab;user-select:none}
[data-dsh-anagenesis-window="window"] .ana-bar.ana-drag:active{cursor:grabbing}
.ana-title{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:650;font-size:13px}
.ana-bar .ana-spacer{flex:1 1 auto}
.ana-btn{appearance:none;display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;
flex:0 0 auto;
border:1px solid var(--ana-line);border-radius:7px;background:transparent;color:var(--ana-fg2);
font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.ana-btn:hover{background:var(--ana-bg1);color:var(--ana-fg)}
.ana-btn[aria-pressed="true"]{border-color:var(--ana-accent);color:var(--ana-accent);background:color-mix(in srgb,var(--ana-accent) 12%,transparent)}
.ana-btn.ana-icon{padding:0 7px;font-size:13px}
/* 控件标签绝不换行：第一版截图里「节点上限」被挤成两行，是这个 flex 容器收缩导致的。 */
.ana-field{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;white-space:nowrap;
font-size:12px;color:var(--ana-fg2)}
.ana-input{height:26px;border:1px solid var(--ana-line);border-radius:7px;background:transparent;
color:var(--ana-fg);font:inherit;font-size:12px;padding:0 6px}
.ana-input--w{width:60px}
.ana-sep{width:1px;height:18px;background:var(--ana-line);margin:0 2px}
.ana-foot{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:6px 10px;
border-top:1px solid var(--ana-line);font-size:11.5px;color:var(--ana-fg2)}
.ana-warn-text{color:var(--ana-warn)}
.ana-error-text{color:var(--ana-bad)}
.ana-ok-text{color:var(--ana-ok)}

/* ── 内容容器（窗口与预览共用） ─────────────────────────────────────────── */
.ana-pane{flex:1 1 auto;min-height:0;overflow:auto;padding:12px}
.ana-pane--flush{padding:0}

/* ── 关键指标卡 ─────────────────────────────────────────────────────────── */
.ana-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px;margin-bottom:12px}
.ana-card{position:relative;padding:10px 12px;border:1px solid var(--ana-line);border-radius:10px;
background:var(--ana-bg2);overflow:hidden}
.ana-card::before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--ana-dim);opacity:.9}
.ana-card--ok::before{background:var(--ana-ok)}
.ana-card--warn::before{background:var(--ana-warn)}
.ana-card--bad::before{background:var(--ana-bad)}
.ana-card--accent::before{background:var(--ana-accent)}
.ana-card--plain::before{background:var(--ana-dim)}
.ana-card-label{font-size:11.5px;color:var(--ana-fg2);letter-spacing:.02em}
.ana-card-value{font-size:23px;font-weight:700;line-height:1.25;font-variant-numeric:tabular-nums}
.ana-card-value small{font-size:12px;font-weight:500;color:var(--ana-fg2);margin-left:5px}
.ana-card--bad .ana-card-value{color:var(--ana-bad)}
.ana-card--warn .ana-card-value{color:var(--ana-warn)}
.ana-card--ok .ana-card-value{color:var(--ana-ok)}
.ana-card-sub{font-size:11.5px;color:var(--ana-fg2)}
.ana-card--hot{border-color:var(--ana-bad);background:color-mix(in srgb,var(--ana-bad) 10%,transparent)}

/* ── 分区卡片 ───────────────────────────────────────────────────────────── */
.ana-groups{display:flex;flex-direction:column;gap:18px}
.ana-group-head{display:flex;align-items:baseline;gap:9px;padding:0 2px 7px;
border-bottom:1px solid var(--ana-line);margin-bottom:11px}
.ana-group-title{position:relative;font-size:13px;font-weight:700;letter-spacing:.05em;padding-left:11px}
.ana-group-title::before{content:"";position:absolute;left:0;top:50%;width:3px;height:12px;margin-top:-6px;
border-radius:2px;background:var(--ana-accent)}
.ana-group-sub{font-size:10.5px;letter-spacing:.16em;color:var(--ana-dim)}
.ana-group-grid{columns:2;column-gap:12px}
.ana-group-grid .ana-sect{break-inside:avoid;margin-bottom:12px}
.ana-sect--wide{column-span:all}
@media (max-width:1080px){.ana-group-grid{columns:1}}
.ana-sect{margin-bottom:12px;border:1px solid var(--ana-line);border-radius:10px;background:var(--ana-bg2);overflow:hidden}
.ana-sect-head{display:flex;align-items:baseline;gap:8px;padding:8px 12px;border-bottom:1px solid var(--ana-line)}
.ana-sect-title{font-weight:650;font-size:13px}
.ana-sect-hint{font-size:11.5px;color:var(--ana-fg2)}
.ana-sect-body{padding:6px 12px 10px}

/* ── 行 ─────────────────────────────────────────────────────────────────── */
.ana-row{display:grid;grid-template-columns:minmax(96px,34%) 1fr auto;align-items:center;gap:10px;
padding:5px 0;border-bottom:1px dashed color-mix(in srgb,var(--ana-line) 70%,transparent)}
.ana-row:last-child{border-bottom:0}
.ana-row-label{color:var(--ana-fg2);overflow-wrap:anywhere}
.ana-row-value{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.ana-row-note{grid-column:1 / -1;font-size:11.5px;color:var(--ana-fg2);font-family:var(--ana-mono)}
.ana-tone-accent .ana-row-value{color:var(--ana-accent);font-weight:600}
.ana-tone-ok .ana-row-value{color:var(--ana-ok);font-weight:600}
.ana-tone-warn .ana-row-value{color:var(--ana-warn);font-weight:600}
.ana-tone-bad .ana-row-value{color:var(--ana-bad);font-weight:700}
.ana-tone-plain .ana-row-value{color:var(--ana-fg)}
.ana-tone-dim{opacity:.62}
.ana-em{color:var(--ana-fg);font-weight:650}

/* ── 进度条（渐变 + 鲜明色块） ────────────────────────────────────────────
   类名是 .ana-pbar* 而不是 .ana-bar*：.ana-bar 已经是窗口与预览的**工具栏**，
   两者撞名时后一条规则的 height:18px/overflow:hidden 会把工具栏压成一条线 ——
   这个 bug 在截图里表现为"工具栏被裁掉"，实际是选择器互相覆盖。 */
.ana-pbar{position:relative;height:18px;border-radius:5px;background:color-mix(in srgb,var(--ana-dim) 18%,transparent);
overflow:hidden;min-width:80px}
.ana-pbar-fill{height:100%;border-radius:5px;background:linear-gradient(90deg,color-mix(in srgb,var(--ana-c) 55%,transparent),var(--ana-c))}
.ana-pbar--ok{--ana-c:var(--ana-ok)}
.ana-pbar--warn{--ana-c:var(--ana-warn)}
.ana-pbar--bad{--ana-c:var(--ana-bad)}
.ana-pbar--accent{--ana-c:var(--ana-accent)}
.ana-pbar--info{--ana-c:var(--ana-info)}
.ana-pbar--violet{--ana-c:var(--ana-violet)}
.ana-pbar--indigo{--ana-c:var(--ana-indigo)}
.ana-pbar--teal{--ana-c:var(--ana-teal)}
.ana-pbar--dim{--ana-c:var(--ana-dim)}
.ana-pbar--plain{--ana-c:var(--ana-fg2)}
.ana-pbar-cell{display:grid;grid-template-columns:minmax(96px,34%) 1fr 62px;align-items:center;gap:10px;padding:5px 0}
.ana-num{text-align:right;font-variant-numeric:tabular-nums;color:var(--ana-fg2)}
.ana-pbar-pct{opacity:.75}

/* ── 徽标 / 色块 ────────────────────────────────────────────────────────── */
.ana-chip{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;
border:1px solid currentColor;font-size:11.5px;line-height:1;white-space:nowrap}
.ana-chip::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.ana-c-ok{color:var(--ana-ok)}.ana-c-okBright{color:var(--ana-ok-bright)}
.ana-c-warn{color:var(--ana-warn)}.ana-c-bad{color:var(--ana-bad)}
.ana-c-info{color:var(--ana-info)}.ana-c-violet{color:var(--ana-violet)}
.ana-c-indigo{color:var(--ana-indigo)}.ana-c-teal{color:var(--ana-teal)}
.ana-c-accent{color:var(--ana-accent)}.ana-c-dim{color:var(--ana-dim)}.ana-c-plain{color:var(--ana-fg)}
.ana-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ana-arrow{color:var(--ana-fg2);padding:0 2px}

/* ── 排行 ───────────────────────────────────────────────────────────────── */
.ana-rank{display:grid;grid-template-columns:22px 1fr auto;gap:9px;align-items:start;padding:7px 0;
border-bottom:1px dashed color-mix(in srgb,var(--ana-line) 70%,transparent)}
.ana-rank:last-child{border-bottom:0}
.ana-rank-no{color:var(--ana-fg2);font-variant-numeric:tabular-nums;text-align:right;font-size:12px}
.ana-rank-main{min-width:0}
.ana-rank-subject{overflow-wrap:anywhere}
.ana-rank-body{font-size:11.5px;color:var(--ana-fg2);overflow-wrap:anywhere}
.ana-rank-right{display:flex;flex-direction:column;align-items:flex-end;gap:5px}
.ana-meter{width:74px;height:6px;border-radius:3px;background:color-mix(in srgb,var(--ana-dim) 20%,transparent)}
.ana-meter-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,color-mix(in srgb,var(--ana-accent) 45%,transparent),var(--ana-accent))}

/* ── 图表 ───────────────────────────────────────────────────────────────── */
.ana-graph{position:relative;width:100%;min-height:240px;overflow:auto;
background:radial-gradient(circle at 1px 1px,color-mix(in srgb,var(--ana-dim) 26%,transparent) 1px,transparent 0)
0 0/18px 18px}
.ana-graph-inner{transform-origin:0 0}
.ana-svg{display:block}
.ana-svg .ana-edge{fill:none;stroke-width:1.6}
.ana-svg .ana-edge--dangling{stroke-dasharray:5 4;opacity:.75}
.ana-svg .ana-elabel{font-size:10.5px;font-family:var(--ana-sans)}
.ana-svg .ana-elabel-bg{fill:var(--ana-bg);fill-opacity:.88;stroke:none}
.ana-svg .ana-node-box{stroke-width:1.6;rx:9}
.ana-svg .ana-node-label{font-size:12px;font-family:var(--ana-sans);fill:var(--ana-fg)}
.ana-svg .ana-node-sub{font-size:10px;font-family:var(--ana-sans);fill:var(--ana-fg2)}
.ana-svg .ana-node{cursor:default}
.ana-svg .ana-node:hover .ana-node-box{filter:brightness(1.22)}
.ana-svg .ana-dot{stroke:none}
.ana-zoom{display:inline-flex;gap:4px;align-items:center}

/* ── 图例 ───────────────────────────────────────────────────────────────── */
.ana-legend{display:flex;flex-wrap:wrap;gap:6px 14px;padding:8px 12px;border-top:1px solid var(--ana-line);
font-size:11.5px;color:var(--ana-fg2);align-items:center}
.ana-legend-item{display:inline-flex;align-items:center;gap:5px}
.ana-legend-swatch{width:10px;height:10px;border-radius:3px;background:currentColor;flex:0 0 auto}
.ana-legend-title{font-weight:600;color:var(--ana-fg)}

/* ── 时间线 ─────────────────────────────────────────────────────────────── */
.ana-tl{position:relative;padding:4px 0 4px 4px}
.ana-tl::before{content:"";position:absolute;left:15px;top:8px;bottom:8px;width:2px;
background:linear-gradient(180deg,var(--ana-accent),var(--ana-line))}
.ana-tl-item{position:relative;display:grid;grid-template-columns:26px 1fr;gap:12px;padding:7px 0 7px 0}
.ana-tl-dot{position:relative;z-index:1;width:12px;height:12px;margin:5px auto 0;border-radius:50%;
background:var(--ana-c,var(--ana-dim));box-shadow:0 0 0 3px var(--ana-bg)}
.ana-tl-main{min-width:0}
.ana-tl-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ana-tl-type{font-weight:650;color:var(--ana-c,var(--ana-fg))}
.ana-tl-meta{font-size:11.5px;color:var(--ana-fg2);font-variant-numeric:tabular-nums}
.ana-tl-detail{font-size:12px;color:var(--ana-fg2);font-family:var(--ana-mono);overflow-wrap:anywhere}

/* ── 空态 / 提示 ────────────────────────────────────────────────────────── */
.ana-text{font-family:var(--ana-mono);font-size:12px;line-height:1.5;white-space:pre;overflow:auto;margin:0;
color:var(--ana-fg)}
.ana-empty{padding:26px 18px;text-align:center;color:var(--ana-fg2)}
.ana-empty-title{font-size:14px;font-weight:650;color:var(--ana-fg);margin-bottom:6px}
.ana-notice{display:flex;gap:8px;align-items:flex-start;padding:8px 12px;border-radius:8px;
background:color-mix(in srgb,var(--ana-warn) 12%,transparent);border:1px solid color-mix(in srgb,var(--ana-warn) 40%,transparent);
color:var(--ana-fg);font-size:12px;margin-bottom:10px}
.ana-notice--bad{background:color-mix(in srgb,var(--ana-bad) 12%,transparent);
border-color:color-mix(in srgb,var(--ana-bad) 42%,transparent)}
.ana-notice--info{background:color-mix(in srgb,var(--ana-info) 12%,transparent);
border-color:color-mix(in srgb,var(--ana-info) 40%,transparent)}

/* ── 入口按钮（顶部栏 / 侧栏） ──────────────────────────────────────────── */
.ana-header-button{appearance:none;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;
border:1px solid var(--ana-line);border-radius:7px;background:transparent;color:var(--ana-fg2);
font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;font-family:var(--ana-sans)}
.ana-header-button:hover{background:var(--ana-bg1);color:var(--ana-fg)}
.ana-header-button[aria-pressed="true"]{border-color:var(--ana-accent);color:var(--ana-accent)}
.ana-launcher{display:flex;flex-direction:column;gap:12px;align-items:flex-start;padding:20px;
font-family:var(--ana-sans);color:var(--ana-fg)}
.ana-launch-btn{appearance:none;display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 15px;
border:1px solid var(--ana-accent);border-radius:9px;background:color-mix(in srgb,var(--ana-accent) 12%,transparent);
color:var(--ana-accent);font:inherit;font-weight:650;cursor:pointer}
.ana-launch-btn:hover{background:color-mix(in srgb,var(--ana-accent) 22%,transparent)}
.ana-launch-hint{color:var(--ana-fg2);font-size:12px;max-width:48ch}

/* ── 设施视图（运维仪表盘）───────────────────────────────────────────────
   参考 Kombai GridSense 的排版与配色语言：冷调石板白画布 + 黑色金属 chrome +
   信号黄/红/蓝 + Bauhaus 平面几何（直角、粗黑描边、硬阴影），标题 Space Grotesk、
   数字一律等宽。**事实来源仍是模型**：面积 = 分区占比，条宽 = 显著度/能量比，
   告警条数 = 模型里的 anomalies。这里没有装饰性读数。
   尺寸随窗口宽度走（container query），因为窗口可以被拖动缩放。 */
.gx-shell{--gx-canvas:#EDF0F6;--gx-canvas-2:#E4E9F0;--gx-panel:#FFFFFF;
--gx-ink:#0F1014;--gx-chrome:#0F1014;--gx-chrome-2:#0A0C10;
--gx-line:#C6CCD8;--gx-line-2:#AEB6C4;--gx-muted:#5A6272;
--gx-red:#D83024;--gx-yellow:#F0C030;--gx-blue:#2448C0;--gx-green:#2C7A4B;
--gx-mono:ui-monospace,"JetBrains Mono","Cascadia Mono",Consolas,monospace;
--gx-sans:"Space Grotesk","Inter","Segoe UI",system-ui,"Microsoft YaHei",sans-serif;
container-type:inline-size;display:flex;flex-direction:column;height:100%;min-height:0;
background:var(--gx-canvas);color:var(--gx-ink);font-family:var(--gx-sans);font-size:12.5px;line-height:1.45}
.gx-shell *{box-sizing:border-box}

/* 顶条：黑色 chrome */
.gx-top{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px;
height:50px;padding:0 14px;background:var(--gx-chrome);color:#F2F4F8;border-bottom:2px solid var(--gx-chrome-2)}
.gx-brand{display:flex;align-items:center;gap:10px;min-width:0}
.gx-mark{display:inline-flex;align-items:flex-end;gap:3px;height:17px;flex:0 0 auto}
.gx-mark i{display:block;width:4px;background:var(--gx-yellow)}
.gx-mark i:nth-child(1){height:8px;background:var(--gx-red)}
.gx-mark i:nth-child(2){height:12px;background:var(--gx-yellow)}
.gx-mark i:nth-child(3){height:17px;background:var(--gx-blue)}
.gx-brand-name{font-size:13px;font-weight:700;letter-spacing:.16em;white-space:nowrap}
.gx-brand-sub{font-size:10.5px;letter-spacing:.14em;color:#8E97A8;white-space:nowrap;
overflow:hidden;text-overflow:ellipsis;min-width:0}
.gx-topmeta{display:flex;align-items:center;gap:9px;min-width:0;overflow:hidden}
.gx-kv{display:inline-flex;align-items:baseline;gap:6px;font-size:11px;white-space:nowrap;min-width:0}
.gx-kv i{font-style:normal;color:#8E97A8;letter-spacing:.08em}
.gx-kv b{font-family:var(--gx-mono);font-weight:600;font-variant-numeric:tabular-nums;
overflow:hidden;text-overflow:ellipsis;max-width:15ch}
.gx-pill{display:inline-flex;align-items:center;height:18px;padding:0 7px;flex:0 0 auto;
font-size:9.5px;font-weight:700;letter-spacing:.12em;border:1px solid currentColor}
.gx-pill--bad{color:#FF7062;background:rgba(216,48,36,.2)}
.gx-pill--warn{color:#F5CE63;background:rgba(240,192,48,.14)}
.gx-pill--ok{color:#7FD6A2;background:rgba(44,122,75,.18)}
/* 有新版本：信号黄底黑字 —— 顶条上唯一催人看一眼的东西。 */
.gx-pill--new{color:var(--gx-ink);background:var(--gx-yellow);border-color:var(--gx-yellow);font-weight:700}
.gx-clock{font-family:var(--gx-mono);font-size:11px;font-variant-numeric:tabular-nums;color:#C9D0DC;flex:0 0 auto}

/* 主体：左侧图标栏 / 中央平面图 / 右侧分区详情 */
.gx-body{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:52px minmax(0,1fr) 286px;
background:var(--gx-canvas)}
.gx-rail{display:flex;flex-direction:column;gap:2px;padding:8px 0;overflow:hidden;
background:var(--gx-chrome-2);color:#7E8798}
.gx-rail-btn{appearance:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
width:100%;height:46px;padding:0;border:0;background:transparent;color:inherit;cursor:pointer;
font:inherit;font-size:9.5px;letter-spacing:.04em}
.gx-rail-btn:hover{color:#E7EAF0;background:rgba(255,255,255,.07)}
.gx-rail-btn--on{color:var(--gx-ink);background:var(--gx-yellow);font-weight:700}
.gx-rail-label{display:block;line-height:1}
.gx-rail-group{display:block;text-align:center;font-size:8.5px;letter-spacing:.16em;color:#5E6675;
padding:7px 0 3px;font-weight:700}
.gx-rail-gap{flex:1 1 auto}

/* 平面图 */
.gx-canvas{min-width:0;overflow:auto;padding:13px 15px;
background:linear-gradient(90deg,rgba(15,16,20,.045) 1px,transparent 1px) 0 0/24px 24px,
linear-gradient(0deg,rgba(15,16,20,.045) 1px,transparent 1px) 0 0/24px 24px,
var(--gx-canvas)}
.gx-canvas-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;
margin-bottom:10px;padding-bottom:7px;border-bottom:1.5px solid var(--gx-ink)}
.gx-kicker{font-size:9.5px;font-weight:700;letter-spacing:.18em;color:var(--gx-muted)}
.gx-h2{margin:1px 0 0;font-size:17px;font-weight:700;letter-spacing:.01em}
.gx-h3{margin:1px 0 0;font-size:14px;font-weight:700}
.gx-legend{display:flex;flex-wrap:wrap;gap:3px 10px;font-size:10px;color:var(--gx-muted);
justify-content:flex-end;max-width:60%}
.gx-legend-item{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.gx-swatch{display:block;width:9px;height:9px;border:1px solid rgba(15,16,20,.28);flex:0 0 auto}
.gx-swatch--ok{background:var(--gx-green)}
.gx-swatch--warn{background:var(--gx-yellow)}
.gx-swatch--bad{background:var(--gx-red)}
.gx-swatch--ink{background:repeating-linear-gradient(90deg,var(--gx-ink) 0 2px,transparent 2px 4px)}

/* 楼层 = 命名空间。硬阴影 + 粗黑描边是整套语言的骨架。 */
.gx-floors{display:flex;flex-direction:column;gap:10px}
.gx-floor{border:1.5px solid var(--gx-ink);background:var(--gx-panel);box-shadow:3px 3px 0 rgba(15,16,20,.12);
overflow:hidden}
.gx-floor--on{border-color:var(--gx-blue);box-shadow:3px 3px 0 var(--gx-blue)}
.gx-floor-head{display:grid;grid-template-columns:24px minmax(0,1fr) auto auto auto 58px;align-items:center;gap:9px;
padding:5px 9px;border-bottom:1.5px solid currentColor;background:var(--gx-canvas-2)}
.gx-floor-no{display:inline-flex;align-items:center;justify-content:center;width:22px;height:18px;
background:var(--gx-ink);color:#F2F4F8;font-family:var(--gx-mono);font-size:10px;font-weight:700;
font-variant-numeric:tabular-nums;letter-spacing:.02em}
.gx-floor-health{font-size:9px;font-weight:700;letter-spacing:.08em;padding:2px 6px;border-radius:999px;
border:1px solid currentColor;white-space:nowrap;font-variant-numeric:tabular-nums}
.gx-floor-health--ok{color:var(--gx-green)}
.gx-floor-health--warn{color:#9A7400;background:color-mix(in srgb,var(--gx-yellow) 28%,transparent)}
.gx-floor-health--bad{color:#fff;background:var(--gx-red);border-color:var(--gx-red)}
.gx-floor-name{font-size:12.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gx-floor-tag{font-size:9px;font-weight:700;letter-spacing:.1em;color:var(--gx-muted);
border:1px solid var(--gx-line-2);padding:0 5px;white-space:nowrap}
.gx-floor-meta{font-family:var(--gx-mono);font-size:10px;color:var(--gx-muted);
font-variant-numeric:tabular-nums;white-space:nowrap}
.gx-floor-bar{position:relative;display:block;height:6px;background:#DDE2EA;border:1px solid var(--gx-line)}
.gx-floor-bar i{display:block;height:100%;background:var(--gx-ink)}

/* 分区 = 记忆类型。宽度 = 占比（最小 22%），所以"小但有事"的格子不会被挤没。 */
/* 分区在**一行里**按占比分宽，绝不换行、绝不横向滚动：一个楼层里的每一种记忆类型
   都必须看得见。（第一版用过 overflow-x:auto，6 个分区里有两个被推到视口外 ——
   截图里 "9/9 活跃" 的楼层只画出了 7 条记录的面积。这是这一屏最容易骗过自己的地方。）
   flex-grow 让一行正好铺满，因此同一层内各格宽度的**相对**比例就是占比；
   跨行比较没有意义，所以这里只有一行。外层负 margin + 楼层壳 overflow:hidden
   把贴边的那两条描边裁掉。 */
.gx-zones{display:flex;align-items:stretch;margin:0 -1.5px -1.5px 0}
.gx-zone{position:relative;appearance:none;display:flex;flex-direction:column;justify-content:space-between;
flex:1 1 var(--gx-zone-w,33%);min-width:0;min-height:76px;padding:7px 8px 6px 11px;border:0;
border-right:1.5px solid var(--gx-ink);border-bottom:1.5px solid var(--gx-ink);
background:var(--gx-panel);color:inherit;font:inherit;text-align:left;cursor:pointer;overflow:hidden}
.gx-zone:hover{background:var(--gx-canvas)}
.gx-zone--on{background:var(--gx-canvas-2);box-shadow:inset 0 0 0 2px var(--gx-blue)}
.gx-zone-strip{position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--gx-line-2)}
.gx-zone--ok .gx-zone-strip{background:var(--gx-green)}
.gx-zone--warn .gx-zone-strip{background:var(--gx-yellow)}
.gx-zone--bad .gx-zone-strip{background:var(--gx-red)}
.gx-zone-body{display:flex;flex-direction:column;gap:4px;min-width:0}
.gx-zone-name{font-size:11.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gx-zone-num{font-family:var(--gx-mono);font-size:13px;font-variant-numeric:tabular-nums;line-height:1.1}
.gx-zone-num small{font-size:10px;color:var(--gx-muted)}
.gx-zone-bar{display:block;height:4px;background:#E1E6EE;border:1px solid var(--gx-line)}
.gx-zone-bar i{display:block;height:100%;background:var(--gx-ink)}
.gx-zone-dots{display:flex;flex-wrap:wrap;gap:3px;min-height:7px}
.gx-zone-floor{position:absolute;right:6px;bottom:3px;max-width:62%;overflow:hidden;white-space:nowrap;
text-overflow:ellipsis;font-family:var(--gx-mono);font-size:8.5px;color:var(--gx-muted);letter-spacing:.04em}

/* 传感器 = 一条记忆。方块而不是圆点：整套视觉是直角几何。 */
.gx-dot{display:block;width:7px;height:7px;flex:0 0 auto;background:var(--gx-line-2)}
.gx-dot--ok{background:var(--gx-green)}
.gx-dot--okBright{background:#2FA05F}
.gx-dot--warn{background:var(--gx-yellow)}
.gx-dot--bad{background:var(--gx-red)}
.gx-dot--info{background:var(--gx-blue)}
.gx-dot--violet{background:#6D46C8}
.gx-dot--dim{background:var(--gx-line-2)}
.gx-dot--none{background:transparent;border:1px solid var(--gx-line)}

/* 右侧分区详情 */
.gx-detail{display:flex;flex-direction:column;gap:10px;min-width:0;overflow:auto;padding:12px;
border-left:1.5px solid var(--gx-ink);background:var(--gx-panel)}
.gx-detail-head{padding-bottom:6px;border-bottom:1.5px solid var(--gx-ink)}
.gx-detail-sub{display:block;margin-top:2px;font-size:10px;color:var(--gx-muted);
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gx-detail-empty{margin:0;font-size:11px;color:var(--gx-muted)}
.gx-readouts{display:flex;flex-direction:column;gap:8px}
.gx-readout{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:2px 8px}
.gx-readout-label{font-size:10.5px;color:var(--gx-muted);letter-spacing:.04em}
.gx-readout-value{font-family:var(--gx-mono);font-size:13px;font-variant-numeric:tabular-nums}
.gx-readout-value small{margin-left:3px;font-size:8.5px;letter-spacing:.1em;color:var(--gx-muted)}
.gx-readout-bar{grid-column:1 / -1;display:block;height:5px;background:#E1E6EE;border:1px solid var(--gx-line)}
.gx-readout-bar i{display:block;height:100%;background:var(--gx-blue)}
.gx-block{display:flex;flex-direction:column;gap:5px}
.gx-block-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.gx-block-note{font-size:9px;color:var(--gx-muted);text-align:right}
.gx-energy-row{display:grid;grid-template-columns:62px minmax(0,1fr) 32px;align-items:center;gap:6px;font-size:11px}
.gx-energy-name{color:var(--gx-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gx-energy-row--on .gx-energy-name{color:var(--gx-ink);font-weight:700}
.gx-energy-bar{position:relative;display:block;height:6px;background:#E1E6EE}
.gx-energy-bar i{display:block;height:100%;background:var(--gx-yellow)}
.gx-energy-base{position:absolute;top:-2px;bottom:-2px;left:50%;width:2px;background:var(--gx-ink)}
.gx-energy-num{font-family:var(--gx-mono);font-size:10px;text-align:right;font-variant-numeric:tabular-nums}
.gx-sensors,.gx-alerts{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}
.gx-sensor{display:grid;grid-template-columns:9px minmax(0,1fr);gap:6px;align-items:start}
.gx-sensor-main{display:flex;flex-direction:column;gap:1px;min-width:0}
.gx-sensor-main b{display:block;font-size:11px;font-weight:600;overflow-wrap:anywhere}
.gx-sensor-main small{display:block;font-family:var(--gx-mono);font-size:9px;color:var(--gx-muted);
font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.gx-sensor-exp{margin-left:4px;color:var(--gx-red)}
.gx-alert{display:grid;grid-template-columns:9px minmax(0,1fr);gap:6px;padding:5px 6px;
border-left:3px solid var(--gx-line-2);background:var(--gx-canvas-2)}
.gx-alert--alert{border-left-color:var(--gx-red)}
.gx-alert--warn{border-left-color:var(--gx-yellow)}
.gx-alert--info{border-left-color:var(--gx-blue)}
.gx-alert-dot{margin-top:4px;display:block;width:7px;height:7px;background:var(--gx-line-2)}
.gx-alert-main{display:flex;flex-direction:column;gap:1px;min-width:0}
.gx-alert-main b{font-size:11px;font-weight:600;overflow-wrap:anywhere}
.gx-alert-main small{font-size:9.5px;color:var(--gx-muted);overflow-wrap:anywhere}

/* 底条：实时电文（纯 CSS 滚动，两段同宽，-100% 恰好接缝） */
.gx-wire{flex:0 0 auto;display:flex;align-items:center;gap:10px;height:30px;padding:0 12px;
overflow:hidden;background:var(--gx-chrome);color:#D8DDE7;border-top:2px solid var(--gx-chrome-2);font-size:10.5px}
.gx-wire-live{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;font-size:9px;
font-weight:700;letter-spacing:.14em;color:#7FD6A2}
.gx-wire-live i{display:block;width:6px;height:6px;border-radius:50%;background:currentColor;
animation:gx-blink 1.7s steps(2,start) infinite}
.gx-wire-live--mirror{color:#F5CE63}
.gx-wire-track{display:flex;flex:1 1 auto;min-width:0;overflow:hidden}
.gx-wire-run{display:inline-flex;flex:0 0 auto;animation:gx-wire-scroll 52s linear infinite}
.gx-wire-item{display:inline-flex;align-items:baseline;gap:5px;margin-right:22px;white-space:nowrap}
.gx-wire-item b{font-family:var(--gx-mono);font-weight:600;color:#8E97A8}
.gx-wire-item i{font-style:normal;font-family:var(--gx-mono);font-size:9px;color:#8E97A8}
.gx-wire-count{flex:0 0 auto;font-family:var(--gx-mono);font-size:9px;color:#8E97A8;
font-variant-numeric:tabular-nums}
@keyframes gx-wire-scroll{from{transform:translateX(0)}to{transform:translateX(-100%)}}
@keyframes gx-blink{50%{opacity:.2}}
@media (prefers-reduced-motion:reduce){.gx-wire-run,.gx-wire-live i{animation:none}}

/* 空态 / 注脚 */
.gx-empty{display:flex;flex-direction:column;gap:6px;align-items:flex-start;padding:26px;
border:1.5px dashed var(--gx-line-2);color:var(--gx-muted);background:var(--gx-panel)}
.gx-empty b{font-size:14px;color:var(--gx-ink)}
.gx-canvas-note{margin-top:10px;font-size:10px;color:var(--gx-muted);font-family:var(--gx-mono)}

/* 窗口可以被拖动缩放，所以按**容器**宽度降级，而不是按视口。 */
@container (max-width:760px){
.gx-body{grid-template-columns:44px minmax(0,1fr) 222px}
.gx-rail-btn{height:38px}
.gx-rail-label{display:none}
.gx-floor-meta{display:none}
.gx-legend{max-width:46%}
.gx-brand-sub{display:none}}
@container (max-width:560px){
.gx-detail{display:none}
.gx-body{grid-template-columns:40px minmax(0,1fr)}
.gx-kv:nth-child(3){display:none}}

/* ── 离线预览页（不在窗口里使用） ──────────────────────────────────────── */
html[data-ana-preview]{background:#141418}
html[data-ana-preview] body{margin:0;padding:24px;background:#141418}
html[data-ana-preview] .ana-preview-frame{max-width:1000px;margin:0 auto 26px;
border:1px solid var(--ana-line2);border-radius:12px;background:var(--ana-bg);overflow:hidden}
html[data-ana-preview] .ana-preview-cap{padding:10px 14px;border-bottom:1px solid var(--ana-line);
font-weight:650;font-size:13px}
`