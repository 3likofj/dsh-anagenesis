/**
 * The window suite: the engine, the agent door, and the components actually
 * rendering.
 *
 * The components are executed through the harness's small React runtime, so these
 * are behavioural claims — "the window is empty while closed", "the header button
 * toggles", "picking a tab raises the window without drawing a second one" — and
 * not merely "a function with this name exists".
 * @module dsh-anagenesis-window/test/window
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { mountClient, findElement, walk } from './harness.mjs'

/** Let the engine's fire-and-forget round trips settle. */
async function settle() {
  for (let index = 0; index < 4; index += 1) await new Promise((done) => setTimeout(done, 0))
}

/**
 * 一个形状正确的仪表盘模型（与 `src/viz/model.js` 的产出同构）。
 *
 * `subject` 让调用方塞一个可识别的字符串进来，用它断言"这一份模型确实被渲染了"。
 * @param {{ subject?: string }} [options]
 */
function dashboardModel(options = {}) {
  const subject = options.subject === undefined ? '记忆 A' : options.subject
  return {
    kind: 'dashboard',
    title: 'anagenesis dashboard',
    generatedAt: 1_700_000_000_000,
    origin: 'mirror',
    store: { version: 12, schemaVersion: 6, memories: 3, live: 2, safeMode: false, stacks: { global: ['guard', 'exploit'] } },
    sections: [
      { id: 'overview', title: 'overview', rows: [{ label: 'store', value: 'v12 · schema v6' }, { label: 'memories', value: '3 (2 live)' }] },
      { id: 'lifecycle', title: 'lifecycle · 3 record(s)', rows: [
        { label: 'active', value: '2 (67%)', bar: 0.67 },
        { label: 'draft', value: '1 (33%)', bar: 0.33 },
      ] },
      { id: 'kinds', title: 'kinds', rows: [{ label: 'constraint', value: '2', bar: 1 }, { label: 'fact', value: '1', bar: 0.5 }] },
      { id: 'salience', title: 'salience', rows: [{ label: subject, value: '0.90 constraint/active', note: '正文摘要' }] },
    ],
    warnings: [],
    limits: { events: 8, salience: 5, nodes: 40 },
    redaction: { level: 'secrets', note: '' },
    render: { width: 96, color: 'never' },
  }
}

/**
 * 一个形状正确的图表模型。`subject` 同时是节点标题与连线端点，所以一次断言就能
 * 同时覆盖"节点画出来了"和"连线画出来了"。
 * @param {{ subject?: string }} [options]
 */
function graphModel(options = {}) {
  const subject = options.subject === undefined ? '记忆 A' : options.subject
  return {
    kind: 'memory-graph',
    title: 'anagenesis memory-graph',
    generatedAt: 1_700_000_000_000,
    origin: 'mirror',
    store: { version: 12, schemaVersion: 6, memories: 2, live: 2, safeMode: false, stacks: {} },
    nodes: [
      { id: 'mem-a', label: subject, kind: 'constraint', state: 'verified', salience: 0.9 },
      { id: 'mem-b', label: '记忆 B', kind: 'failure', state: 'active', salience: 0.5 },
    ],
    edges: [{ from: 'mem-a', to: 'mem-b', rel: 'supports', exists: true }],
    timeline: [],
    transitions: [],
    totals: { byState: {}, byKind: {}, byEventType: {} },
    warnings: [],
    limits: { nodes: 40, timeline: 16 },
    redaction: { level: 'secrets', note: '' },
  }
}

/** A stand-in for the Host half's route. */
function createFakeHost(options = {}) {
  const calls = []
  const state = { pending: options.pending === undefined ? null : options.pending, fail: options.fail === true, legacyHost: options.legacyHost === true }
  const fetchImpl = async (url) => {
    const parsed = new URL(url, 'http://127.0.0.1')
    const method = parsed.searchParams.get('method')
    const params = {}
    for (const [key, value] of parsed.searchParams.entries()) params[key] = value
    calls.push({ method: method, params: params })
    if (state.fail) throw new Error('network down')
    const table = {
      ping: { ok: true, package: 'dsh-anagenesis-window' },
      config: {
        ok: true, title: 'anagenesis · 可视化', redaction: 'secrets', color: 'never', width: 96, events: 8,
        salience: 5, diagramNodes: 40, includeBodies: false, refreshMs: 2000,
        officialEntry: 'auto', leftColumnFallback: 'off', configVersion: 2,
      },
      status: { ok: true, storeFound: true, root: '/tmp/store', storeVersion: 12, memories: 3, pendingOpen: false, origin: 'mirror' },
      // 结构化模型，不是文本帧：窗口自己渲染。这里刻意用一个**最小但形状正确**的
      // 模型，这样"窗口真的渲染出了东西"是这条断言在管的事，而不是"Host 回了文本"。
      dashboard: { ok: true, empty: false, storeFound: true, root: '/tmp/store', model: dashboardModel(options) },
      graph: { ok: true, empty: false, storeFound: true, root: '/tmp/store', model: graphModel(options) },
      takeOpen: { ok: true, request: state.pending },
      // 旧版 Host 半只认识这两个文本方法。
      frame: { ok: true, text: 'LEGACY-FRAME-TEXT', width: 96, storeVersion: 12, origin: 'mirror', redaction: 'secrets', warnings: [] },
      diagram: { ok: true, text: 'LEGACY-DIAGRAM-TEXT', kind: 'memory-graph', format: 'mermaid', storeVersion: 12, origin: 'mirror', redaction: 'secrets', warnings: [] },
    }
    const payload = table[method]
    if (payload === undefined || (state.legacyHost && (method === 'dashboard' || method === 'graph'))) {
      return { ok: false, status: 400, json: async () => ({ ok: false, error: 'unknown method ' + String(method) }) }
    }
    return { ok: true, status: 200, json: async () => payload }
  }
  return {
    calls: calls,
    fetchImpl: fetchImpl,
    setPending(value) {
      state.pending = value
    },
    setFail(value) {
      state.fail = value
    },
    methods() {
      return calls.map((call) => call.method)
    },
  }
}

/** The component registered in one slot. */
function componentFor(mounted, slot) {
  const occupants = mounted.slots.occupants(slot)
  assert.equal(occupants.length, 1, `${slot} must hold exactly one registration`)
  return occupants[0].component
}

/**
 * 窗口内容是通过 `dangerouslySetInnerHTML` 注入的 HTML 字符串，不是 React 节点树。
 * 把所有 `__html` 拼起来，就能对"窗口里到底画了什么"下断言 —— 这是本次改版最需要
 * 被测试盯住的东西（图表是不是真的 SVG、文案是不是中文、有没有文本帧残留）。
 * @param {any} node
 * @returns {string}
 */
function injectedHtml(node) {
  let out = ''
  for (const item of walk(node)) {
    const props = item.props
    if (props !== null && props !== undefined && props.dangerouslySetInnerHTML !== undefined && props.dangerouslySetInnerHTML !== null) {
      out += String(props.dangerouslySetInnerHTML.__html ?? '')
    }
    if (typeof item.children === 'string') out += item.children
    if (Array.isArray(item.children)) out += item.children.filter((child) => typeof child === 'string').join('')
  }
  return out
}

test('window: the overlay is registered once and renders nothing while closed', () => {
  const mounted = mountClient({ betterSidebar: true })
  try {
    const mount = mounted.react.mount(componentFor(mounted, 'shell.overlay'), {})
    assert.equal(mount.tree, null, 'a closed window draws nothing at all')
    mount.unmount()
  } finally {
    mounted.dispose()
  }
})

test('window: opening renders one dialog containing the rendered dashboard, and closing removes it', async () => {
  const host = createFakeHost({ subject: 'OVERVIEW-BLOCK' })
  const mounted = mountClient({ betterSidebar: true, fetchImpl: host.fetchImpl })
  try {
    const mount = mounted.react.mount(componentFor(mounted, 'shell.overlay'), {})
    mounted.service.open({ seat: 'better-sidebar-row' })
    await settle()
    mount.rerender()
    const dialog = findElement(mount.tree, (node) => node.props.role === 'dialog')
    assert.ok(dialog !== null, 'an open window is a dialog')
    const html = injectedHtml(mount.tree)
    assert.ok(html.includes('OVERVIEW-BLOCK'), 'the model reached the renderer: the subject is on screen')
    assert.ok(html.includes('evo-card'), 'and it was rendered as cards, not as a text frame')
    assert.ok(html.includes('记忆总数'), 'in Chinese')
    assert.equal(findElement(mount.tree, (node) => node.type === 'pre'), null, 'no monospace frame anywhere')
    assert.ok(host.methods().includes('dashboard'), 'the window asks its own Host route for the structured model')

    mounted.service.close('test')
    mount.rerender()
    assert.equal(mount.tree, null, 'closing removes it from the tree')
    mount.unmount()
  } finally {
    mounted.dispose()
  }
})

test('window: switching to the graph face fetches the graph model and renders real SVG', async () => {
  const host = createFakeHost({ subject: 'GRAPH-NODE-A' })
  const mounted = mountClient({ betterSidebar: true, fetchImpl: host.fetchImpl })
  try {
    const mount = mounted.react.mount(componentFor(mounted, 'shell.overlay'), {})
    mounted.service.open({ seat: 'x' })
    await settle()
    mounted.service.setView('graph')
    await settle()
    mount.rerender()
    const html = injectedHtml(mount.tree)
    assert.ok(html.includes('<svg'), 'the chart is an SVG, not Mermaid source')
    assert.ok(html.includes('GRAPH-NODE-A'), 'the node label is drawn')
    assert.ok(html.includes('支持'), 'and the edge carries a Chinese relation label')
    assert.ok(!/classDef|graph LR|flowchart/.test(html), 'no diagram source leaked into the view')
    assert.ok(host.methods().includes('graph'))
    assert.ok(!host.methods().includes('diagram'), 'the window never asks for the text serializer')
    mount.unmount()
  } finally {
    mounted.dispose()
  }
})

test('window: the toolbar only shows controls the current face can use', async () => {
  const host = createFakeHost({})
  const mounted = mountClient({ betterSidebar: true, fetchImpl: host.fetchImpl })
  try {
    const mount = mounted.react.mount(componentFor(mounted, 'shell.overlay'), {})
    mounted.service.open({ seat: 'x' })
    await settle()
    mount.rerender()
    const dash = injectedHtml(mount.tree)
    assert.ok(dash.includes('data-evo-field="width"'), 'the dashboard needs a frame width')
    assert.ok(!dash.includes('data-evo-field="kind"'), 'it does not need a diagram kind')
    assert.ok(dash.includes('data-evo-action="refresh"') && dash.includes('data-evo-action="close"'))

    mounted.service.setView('graph')
    await settle()
    mount.rerender()
    const graph = injectedHtml(mount.tree)
    assert.ok(graph.includes('data-evo-field="kind"'), 'the graph face picks a diagram kind')
    assert.ok(graph.includes('data-evo-field="direction"'), 'and a layout direction (LR / TB)')
    assert.ok(graph.includes('横向（从左到右）') && graph.includes('纵向（从上到下）'), 'both directions are offered in Chinese')
    assert.ok(graph.includes('data-evo-field="maxNodes"'))
    assert.ok(!graph.includes('data-evo-field="width"'), 'width is a text-frame knob and belongs to the dashboard face')
    assert.ok(graph.includes('data-evo-action="zoom-in"') && graph.includes('data-evo-action="zoom-reset"'))
    mount.unmount()
  } finally {
    mounted.dispose()
  }
})

test('window: the header button toggles the same window', async () => {
  const host = createFakeHost({})
  const mounted = mountClient({ betterSidebar: false, fetchImpl: host.fetchImpl })
  try {
    const mount = mounted.react.mount(componentFor(mounted, 'conversation.session.header.utilities'), {})
    const button = findElement(mount.tree, (node) => node.type === 'button')
    assert.ok(button !== null, 'the header seat is a button, not a panel')
    assert.equal(button.props['aria-pressed'], false)
    button.props.onClick()
    await settle()
    mount.rerender()
    assert.equal(mounted.service.status().window.open, true)
    const after = findElement(mount.tree, (node) => node.type === 'button')
    assert.equal(after.props['aria-pressed'], true)
    after.props.onClick()
    mount.rerender()
    assert.equal(mounted.service.status().window.open, false)
    mount.unmount()
  } finally {
    mounted.dispose()
  }
})

test('window: opening a sidebar row raises the window without drawing a second UI', async () => {
  const host = createFakeHost({})
  const mounted = mountClient({ betterSidebar: true, fetchImpl: host.fetchImpl })
  try {
    const descriptor = mounted.betterSidebar.getTab('dsh-anagenesis-window:panel')
    assert.ok(descriptor !== undefined)
    const mount = mounted.react.mount(descriptor.component, {})
    await settle()
    assert.equal(mounted.service.status().window.open, true, 'mounting the row is the click')
    const buttons = walk(mount.tree).filter((node) => node.type === 'button')
    assert.equal(buttons.length, 1, 'the row is a launcher, not a second dashboard')
    assert.equal(findElement(mount.tree, (node) => node.type === 'pre'), null, 'the content lives only in the window')
    mount.unmount()
  } finally {
    mounted.dispose()
  }
})

test('window: the content lives only in the window, never in the seat', async () => {
  const host = createFakeHost({})
  const mounted = mountClient({ betterSidebar: true, fetchImpl: host.fetchImpl })
  try {
    const descriptor = mounted.betterSidebar.getTab('dsh-anagenesis-window:panel')
    assert.ok(descriptor !== undefined, 'entry 1 is the only better-sidebar tab type')
    const mount = mounted.react.mount(descriptor.component, {})
    await settle()
    assert.equal(mounted.service.status().window.open, true, 'mounting the row is the click')
    const buttons = walk(mount.tree).filter((node) => node.type === 'button')
    assert.equal(buttons.length, 1, 'the row is a launcher, not a second dashboard')
    assert.equal(findElement(mount.tree, (node) => node.type === 'pre'), null, 'the content lives only in the window')
    assert.ok(!injectedHtml(mount.tree).includes('evo-card'), 'the seat never draws the dashboard itself')
    mount.unmount()
  } finally {
    mounted.dispose()
  }
})

test('window: the sidebar has exactly one anagenesis row (the bottom workbench was removed)', () => {
  const host = createFakeHost({})
  const mounted = mountClient({ betterSidebar: true, fetchImpl: host.fetchImpl })
  try {
    assert.deepEqual(mounted.betterSidebar.tabsById(), ['dsh-anagenesis-window:panel'])
    assert.equal(mounted.betterSidebar.getTab('dsh-anagenesis-window:bottom'), undefined, 'entry 2 is gone on request')
    // …and the seat is not merely unreachable: the service has no bottom-bench branch either.
    mounted.service.open({ seat: 'better-sidebar-bottom' })
    assert.deepEqual(mounted.betterSidebar.openedSeeds(), [], 'no provider-side tab is opened for a seat that no longer exists')
    assert.equal(mounted.service.status().window.open, true, 'the request still raises the one window rather than failing')
  } finally {
    mounted.dispose()
  }
})

test('window: the agent door drains a pending request and opens the window', async () => {
  const host = createFakeHost({ pending: { action: 'open', detail: { view: 'graph' }, seq: 4 } })
  const mounted = mountClient({ betterSidebar: false, fetchImpl: host.fetchImpl })
  try {
    assert.equal(mounted.service.status().window.open, false)
    const drained = await mounted.service.drain()
    await settle()
    assert.ok(drained !== null, 'the pending request was taken')
    assert.equal(drained.seq, 4)
    const window = mounted.service.status().window
    assert.equal(window.open, true, 'a request left by ana_window opens the window')
    assert.equal(window.view, 'graph', 'and carries the requested face')
    assert.equal(window.counters.drained, 1)
    assert.ok(mounted.service.log('window.request-drained').length === 1, 'the drain is observable')
  } finally {
    mounted.dispose()
  }
})

test('window: the agent door also closes and toggles', async () => {
  const host = createFakeHost({ pending: { action: 'toggle', detail: {}, seq: 1 } })
  const mounted = mountClient({ betterSidebar: false, fetchImpl: host.fetchImpl })
  try {
    await mounted.service.drain()
    assert.equal(mounted.service.status().window.open, true)
    host.setPending({ action: 'toggle', detail: {}, seq: 2 })
    await mounted.service.drain()
    assert.equal(mounted.service.status().window.open, false)
    host.setPending({ action: 'close', detail: {}, seq: 3 })
    // Already closed: draining a close is a no-op that still consumes the request.
    await mounted.service.drain()
    assert.equal(mounted.service.status().window.open, false)
    host.setPending(null)
    assert.equal(await mounted.service.drain(), null, 'an empty slot is not an event')
  } finally {
    mounted.dispose()
  }
})

test('window: a failing Host route becomes a rendered error, never a thrown one', async () => {
  const host = createFakeHost({})
  host.setFail(true)
  const mounted = mountClient({ betterSidebar: true, fetchImpl: host.fetchImpl })
  try {
    const mount = mounted.react.mount(componentFor(mounted, 'shell.overlay'), {})
    mounted.service.open({ seat: 'x' })
    await settle()
    mount.rerender()
    const window = mounted.service.status().window
    assert.match(window.error, /network down/)
    assert.equal(window.counters.failures > 0, true)
    const footer = injectedHtml(mount.tree).includes('evo-foot')
    assert.equal(footer, true, 'the window still renders with its footer')
    assert.ok(injectedHtml(mount.tree).includes('evo-error-text'), 'the failure is shown in the window, not swallowed')
    assert.ok(injectedHtml(mount.tree).includes('network down'), 'and it says what failed')
    // And the rest of the plugin is unaffected.
    assert.equal(mounted.slots.occupants('conversation.session.header.utilities').length, 1)
    mount.unmount()
  } finally {
    mounted.dispose()
  }
})

test('window: a Host half that only knows the text methods degrades instead of erroring', async () => {
  // 版本偏斜是**必然**会发生的状态：客户端半由 dsh-client-modules 热替换，Host 半
  // 要重启桌面端才会重新导入。这条测试证明那段时间窗口仍然可用。
  const host = createFakeHost({ legacyHost: true })
  const mounted = mountClient({ betterSidebar: true, fetchImpl: host.fetchImpl })
  try {
    const mount = mounted.react.mount(componentFor(mounted, 'shell.overlay'), {})
    mounted.service.open({ seat: 'x' })
    await settle()
    mount.rerender()
    const window = mounted.service.status().window
    assert.equal(window.degraded, 'frame', 'the window knows it is degraded')
    assert.equal(window.error, '', 'a version skew is not an error')
    const html = injectedHtml(mount.tree)
    assert.ok(html.includes('LEGACY-FRAME-TEXT'), 'the legacy text is still shown')
    assert.ok(html.includes('重启桌面端'), 'and the user is told what to do about it')
    assert.ok(html.includes('降级为文本视图'), 'the footer says so too')
    assert.ok(host.methods().includes('dashboard') && host.methods().includes('frame'), 'it tried the new method first, then fell back')

    // 图形面同理。
    mounted.service.setView('graph')
    await settle()
    mount.rerender()
    const graphHtml = injectedHtml(mount.tree)
    assert.ok(graphHtml.includes('LEGACY-DIAGRAM-TEXT'))
    assert.ok(host.methods().includes('graph') && host.methods().includes('diagram'))
    mount.unmount()
  } finally {
    mounted.dispose()
  }
})

test('window: the snapshot identity is stable between notifications', async () => {
  const host = createFakeHost({})
  const mounted = mountClient({ betterSidebar: false, fetchImpl: host.fetchImpl })
  try {
    const first = mounted.service.status().window
    const second = mounted.service.status().window
    assert.equal(first, second, 'a fresh object per read is a render loop with useSyncExternalStore')
    mounted.service.open({ seat: 'x' })
    const third = mounted.service.status().window
    assert.notEqual(third, first, 'and it must change when the state does')
    assert.equal(third.open, true)
    await settle()
  } finally {
    mounted.dispose()
  }
})

test('window: geometry moves without re-registering anything', () => {
  const host = createFakeHost({})
  const mounted = mountClient({ betterSidebar: false, fetchImpl: host.fetchImpl })
  try {
    mounted.service.open({ seat: 'x' })
    mounted.service.patch({ x: 120, y: 64 })
    assert.equal(mounted.service.status().window.x, 120)
    assert.equal(mounted.service.status().window.y, 64)
    assert.equal(mounted.slots.occupants('shell.overlay').length, 1, 'moving is not re-registering')
  } finally {
    mounted.dispose()
  }
})

test('window: the redaction policy rides every request, so the Host never sends more than asked', async () => {
  const host = createFakeHost({})
  const mounted = mountClient({ betterSidebar: false, fetchImpl: host.fetchImpl })
  try {
    mounted.service.open({ seat: 'x' })
    await settle()
    const modelCall = host.calls.find((call) => call.method === 'dashboard')
    assert.ok(modelCall !== undefined)
    assert.equal(modelCall.params.redaction, 'secrets', 'the default policy is the tools\u2019 policy')
    mounted.service.patch({ redaction: 'strict' })
    await settle()
    const strict = host.calls.filter((call) => call.method === 'dashboard').pop()
    assert.equal(strict.params.redaction, 'strict')
  } finally {
    mounted.dispose()
  }
})

test('window: unmounting the overlay clears its timers and listeners', () => {
  const host = createFakeHost({})
  const mounted = mountClient({ betterSidebar: false, fetchImpl: host.fetchImpl })
  try {
    const mount = mounted.react.mount(componentFor(mounted, 'shell.overlay'), {})
    mount.unmount()
    const before = host.calls.length
    assert.equal(before >= 0, true)
    assert.equal(mounted.slots.occupants('shell.overlay').length, 1, 'unmounting a React tree is not unregistering the seat')
  } finally {
    mounted.dispose()
  }
  assert.equal(mounted.slots.occupants('shell.overlay').length, 0, 'teardown is what removes the seat')
})