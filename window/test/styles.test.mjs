/**
 * 渲染层与样式表之间的一致性 —— 这一组测试的存在理由是一次真实的线上事故。
 *
 * 事故：渲染层产出新标记（`.evo-card` / `.evo-pbar` / `.evo-svg` / `.evo-pane`），
 * 但 `installStyles()` 装的是另一份手写旧表。72 个测试全绿 —— 因为它们只读 React
 * 节点树与注入的 HTML **字符串**，从来不看"这串 HTML 有没有对应的规则"。
 * 结果用户看到的是：仪表盘退化成标签堆叠、图形节点全灰、内容撑爆窗口。
 *
 * 所以这里守住两条不变量：
 *   1. 装进文档的样式表**就是** `ANA_CSS` 这一份（唯一所有者）；
 *   2. 渲染层会产出的每一个 class，`ANA_CSS` 里都有规则。
 *
 * 第 2 条是通用护栏：以后任何人加一个新 class 却忘了写样式，这里会红 ——
 * 而不是等用户截图回来。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadRenderLayer } from '../tools/render-lib.mjs'
import { mountClient } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const R = loadRenderLayer()

/** 一份形状正确的仪表盘模型（与 `src/viz/model.js` 同构）。 */
function dashboardModel() {
  return {
    kind: 'dashboard', title: 't', generatedAt: 1, origin: 'mirror',
    store: { version: 3, schemaVersion: 6, memories: 2, live: 1, safeMode: true, stacks: {} },
    sections: [
      { id: 'overview', title: 'overview', rows: [{ label: 'store', value: 'v3 · schema v6' }, { label: 'memories', value: '2 (1 live)' }] },
      { id: 'lifecycle', title: 'lifecycle', rows: [{ label: 'active', value: '1 (50%)', bar: 0.5 }] },
      { id: 'kinds', title: 'kinds', rows: [{ label: 'fact', value: '1', bar: 1 }] },
      { id: 'strategy', title: 'strategy', rows: [{ label: 'global', value: 'guard → exploit' }, { label: 'health', value: 'ok — no strategy quarantined' }] },
      { id: 'tuning', title: 'tuning', rows: [{ label: 'recall.diversity', value: '0.5 (default 0.3)', tone: 'accent' }] },
      { id: 'journal', title: 'journal', rows: [{ label: '#7', value: 'meta.tune · 3m ago' }] },
      { id: 'salience', title: 'salience', rows: [{ label: '主题', value: '0.80 fact/active', note: '摘要' }] },
      { id: 'viz', title: 'viz', rows: [{ label: 'mode', value: 'watch' }] },
    ],
    warnings: ['read-only mirror: engine health comes from files'],
    limits: { events: 8, salience: 5, nodes: 40 },
    redaction: { level: 'secrets', note: '' },
    render: { width: 96, color: 'never' },
  }
}

/** 一份形状正确的图表模型，三种 kind 都要走一遍。 */
function diagramModel(kind) {
  return {
    kind, title: 't', generatedAt: 1, origin: 'mirror',
    store: { version: 3, schemaVersion: 6, memories: 3, live: 2, safeMode: false, stacks: {} },
    nodes: [{ id: 'mem-a', label: '一条很长很长的记忆标题用来触发换行', kind: 'constraint', state: 'verified', salience: 0.9 }],
    edges: [{ from: 'mem-a', to: 'mem-missing', rel: 'supports', exists: false }],
    timeline: [{ seq: 7, type: 'meta.tune', at: 1, detail: 'recall.diversity 0.3 → 0.5' }],
    transitions: [{ from: 'draft', to: 'active', count: 2, op: null }, { from: null, to: 'locked', count: 1, op: 'memory.lock' }],
    totals: { byState: { active: 1, locked: 1 }, byKind: { constraint: 1 }, byEventType: { 'meta.tune': 1 } },
    warnings: [],
    limits: { nodes: 40, timeline: 16 },
    redaction: { level: 'secrets', note: '' },
  }
}

/** 渲染层会产出的所有 HTML（每一个面、每一种图）。 */
function everyRenderedHtml() {
  const out = [
    R.renderDashboardHtml(dashboardModel()),
    R.dashboardLegendHtml(),
    R.renderTitlebarHtml({ title: '标题' }),
    R.renderFooterHtml({ origin: 'mirror', storeVersion: 1, lastAt: Date.now(), busy: true, warnings: ['w'], error: 'boom', degraded: 'frame' }),
    R.renderToolbarHtml({ view: 'dashboard', redaction: 'secrets', width: 96 }),
    R.renderToolbarHtml({ view: 'graph', kind: 'memory-graph', direction: 'TB', zoom: 1.2, maxNodes: 40, redaction: 'strict' }),
    R.renderTextFallbackHtml('FRAME', '旧版本'),
  ]
  for (const kind of ['memory-graph', 'lifecycle', 'strategy-timeline']) {
    out.push(R.renderDiagramHtml(diagramModel(kind), { direction: 'LR', maxNodes: 40, zoom: 1 }))
  }
  return out
}

/** 抽出 `class="a b c"` 里的每个 class 名。 */
function classesIn(html) {
  const found = new Set()
  for (const match of String(html).matchAll(/class="([^"]+)"/g)) {
    for (const name of match[1].split(/\s+/)) if (name !== '') found.add(name)
  }
  return found
}

test('styles: the document gets the render layer sheet, not a second hand-written one', () => {
  const mounted = mountClient({ betterSidebar: true })
  try {
    assert.equal(mounted.styleNodes(), 1, 'exactly one <style> is inserted')
    assert.equal(mounted.styleText(), R.ANA_CSS, 'the installed sheet IS the render layer sheet — one owner, no drift')
    assert.ok(R.ANA_CSS.includes('pointer-events:auto'), 'the click-through overlay still opts back into pointer events')
    assert.ok(R.ANA_CSS.includes('.evo-pane{'), 'the content area that the markup actually uses')
    assert.ok(R.ANA_CSS.includes('.evo-chrome{display:contents}'), 'the innerHTML host must not disturb layout')
  } finally {
    mounted.dispose()
  }
})

test('styles: every class the render layer emits has a rule in the sheet', () => {
  const emitted = new Set()
  for (const html of everyRenderedHtml()) for (const name of classesIn(html)) emitted.add(name)
  assert.ok(emitted.size > 20, `the sample must be broad enough to be meaningful (got ${emitted.size})`)

  const missing = [...emitted].filter((name) => !R.ANA_CSS.includes('.' + name))
  assert.deepEqual(missing, [], `these classes are rendered but unstyled: ${missing.join(', ')}`)
})

test('styles: the React-side class names are in the sheet too', () => {
  // 漂移有两个方向。上面一条管渲染层产出的字符串；这一条管 React 组件自己写的
  // className（`evo-header-button` / `evo-launcher` / `evo-pane` …）—— 它们不在
  // 渲染层的 HTML 里，所以上一条看不见它们。
  //
  // 刻意**不**做"样式表里不能有没用到的规则"的反向检查：色板（`evo-pbar--warn`、
  // `evo-c-info` …）是给所有数据状态准备的，样本里没出现不等于没用。那种测试只会
  // 逼着后来的人删掉需要的规则。
  const source = readFileSync(resolve(here, '..', 'client.js'), 'utf8')
  const used = new Set()
  for (const match of source.matchAll(/className:\s*'([^']+)'/g)) {
    for (const name of match[1].split(/\s+/)) if (name.startsWith('evo-')) used.add(name)
  }
  for (const match of source.matchAll(/className:\s*'[^']*'\s*\+\s*[^,]*/g)) {
    for (const inner of match[0].matchAll(/'(evo-[a-z0-9-]+)/g)) used.add(inner[1])
  }
  assert.ok(used.size >= 5, `expected to find the React-side class names (got ${used.size})`)
  const missing = [...used].filter((name) => !R.ANA_CSS.includes('.' + name))
  assert.deepEqual(missing, [], `these React class names have no rules: ${missing.join(', ')}`)
})

test('styles: the toolbar labels cannot wrap (a real regression)', () => {
  // 第一版截图里「节点上限」被挤成两行 —— 那是一次真实的布局塌陷，不是理论风险。
  assert.ok(/\.evo-field\{[^}]*white-space:nowrap/.test(R.ANA_CSS), 'control labels must not wrap')
  assert.ok(/\.evo-bar\{[^}]*flex-wrap:wrap/.test(R.ANA_CSS), 'but the bar itself must wrap rather than clip the close button')
})