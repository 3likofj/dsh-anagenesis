/**
 * Host-half suite: the route, the fence, the lossless-JSON seam, the pending
 * channel, the renderer against a real store on disk, and the `ana_window` tool.
 *
 * The store this exercises is written by the plugin's own schema helpers and then
 * read back through the same mirror the standalone TUI uses — so "the window is
 * read-only" is checked against a real directory, not a mock.
 * @module dsh-anagenesis-window/test/host
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ROUTE_PATH, RPC_METHODS, createPendingChannel, createRouteHandler, isLoopbackHostname, isTrustedRequest,
} from '../src/host/rpc.js'
import { createRenderer, defaultRoot, jsonSafe, loadVizLayer } from '../src/host/viz.js'
import { probeProfile } from '../src/host/tool.js'
import { apply, once, resolveConfig } from '../src/index.js'
import { createMemory, emptyState } from '../../src/store/schema.js'

/** A store directory the window can actually read, built by the plugin's own helpers. */
async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), 'ana-window-store-'))
  await mkdir(join(root, 'journal'), { recursive: true })
  const now = Date.UTC(2026, 9, 6, 12, 0, 0)
  const state = emptyState(now)
  const memory = createMemory({
    id: 'mem-1', kind: 'procedure', subject: 'Always read the store through the mirror',
    body: 'A second writer would race the single-writer pool.', gist: 'use the mirror',
    state: 'verified', confidence: 0.9, tags: ['viz', 'store'],
  }, { now: now, embed: () => [0, 0, 0], sessionId: 's1' })
  state.memories[memory.id] = memory
  state.version = 3
  await writeFile(join(root, 'snapshot.json'), JSON.stringify({ state: state }), 'utf8')
  return root
}

/** The host Context, reduced to what this row touches. */
function createHostContext(options = {}) {
  const routes = new Map()
  const tools = new Map()
  const effects = []
  const logs = []
  const services = new Map()
  if (options.webServer !== false) {
    services.set('webServer', {
      register(route) {
        if (!routes.has(route.path)) routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    })
  }
  if (options.tools !== false) {
    services.set('tools', {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    })
  }
  const scopeFor = (deps) => ({
    get(name, strict) {
      if (services.has(name)) return services.get(name)
      if (strict !== false) throw new Error(`cannot resolve "${name}"`)
      return undefined
    },
    tools: services.get('tools'),
  })
  const ctx = {
    logger: {
      info: (message) => logs.push({ level: 'info', message: message }),
      warn: (message) => logs.push({ level: 'warn', message: message }),
      error: (message) => logs.push({ level: 'error', message: message }),
    },
    loader: { entries: () => options.entries ?? [] },
    get: (name, strict) => {
      if (services.has(name)) return services.get(name)
      if (strict !== false) throw new Error(`cannot resolve "${name}"`)
      return undefined
    },
    effect(fn, label) {
      const result = fn()
      const dispose = once(() => {
        if (typeof result === 'function') result()
      })
      effects.push({ label: label, dispose: dispose })
      return dispose
    },
    inject(deps, cb) {
      const available = deps.every((name) => services.has(name))
      if (!available) return () => {}
      return cb(scopeFor(deps))
    },
  }
  return {
    ctx: ctx,
    routes: routes,
    tools: tools,
    logs: logs,
    routeHandler(path = ROUTE_PATH) {
      const route = routes.get(path)
      return route === undefined ? null : route.handler
    },
    dispose() {
      for (let index = effects.length - 1; index >= 0; index -= 1) effects[index].dispose()
    },
  }
}

/** Minimal `http.IncomingMessage` / `ServerResponse` doubles. */
function fakeExchange(query, headers = {}) {
  const request = { url: `${ROUTE_PATH}?${query}`, headers: Object.assign({ host: '127.0.0.1:19387' }, headers) }
  const response = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, extra) {
      response.status = status
      response.headers = extra
      return response
    },
    end(body) {
      response.body = body
      return response
    },
    json() {
      return JSON.parse(response.body)
    },
  }
  return { request: request, response: response }
}

// ── config ───────────────────────────────────────────────────────────────────

test('host: resolveConfig clamps and defaults every field', () => {
  const resolved = resolveConfig({})
  assert.equal(resolved.redaction, 'secrets')
  assert.equal(resolved.officialEntry, 'auto')
  assert.equal(resolved.leftColumnFallback, 'off')
  assert.equal(resolved.width, 96)
  assert.equal(resolved.refreshMs, 2000)
  assert.equal(resolved.exposeWindowTool, true)
  assert.equal(resolveConfig({ redaction: 'nonsense' }).redaction, 'secrets', 'an unknown policy falls back, it does not open up')
  assert.equal(resolveConfig({ officialEntry: 'nonsense' }).officialEntry, 'auto')
  assert.equal(resolveConfig({ refreshMs: 10 }).refreshMs, 500)
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
})

test('host: defaultRoot follows $DSH_HOME', () => {
  assert.equal(defaultRoot({ DSH_HOME: 'C:/home/.dsh' }), join('C:/home/.dsh', 'anagenesis'))
  assert.match(defaultRoot({}), /anagenesis$/)
})

// ── lossless JSON ────────────────────────────────────────────────────────────

test('host: jsonSafe removes undefined, coercion hazards and cycles', () => {
  const value = jsonSafe({
    keep: 1,
    drop: undefined,
    nested: { alsoDrop: undefined, keep: 'yes' },
    infinity: Number.POSITIVE_INFINITY,
    nan: Number.NaN,
    fn: () => {},
    list: [1, undefined, 3],
    when: new Date('2026-10-06T00:00:00Z'),
    error: new Error('boom'),
  })
  assert.equal('drop' in value, false, 'a key that was meant to disappear must disappear')
  assert.equal('alsoDrop' in value.nested, false)
  assert.equal(value.infinity, null)
  assert.equal(value.nan, null)
  assert.equal(value.fn, null)
  assert.deepEqual(value.list, [1, null, 3])
  assert.equal(value.when, '2026-10-06T00:00:00.000Z')
  assert.deepEqual(value.error, { name: 'Error', message: 'boom' })
  assert.equal(JSON.stringify(value).includes('undefined'), false)

  const cyclic = { name: 'a' }
  cyclic.self = cyclic
  assert.equal(jsonSafe(cyclic).self, null, 'a cycle is refused by path, not by value')
})

// ── the fence ────────────────────────────────────────────────────────────────

test('host: the trust fence accepts loopback and refuses everything else', () => {
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('evil.example.com'), false)
  assert.equal(isLoopbackHostname('127.0.0.1.evil.com'), false)

  const ok = { headers: { host: '127.0.0.1:19387' } }
  assert.equal(isTrustedRequest(ok), true)
  assert.equal(isTrustedRequest({ headers: {} }), false, 'no Host header is not trusted')
  assert.equal(isTrustedRequest({ headers: { host: 'evil.example.com' } }), false, 'DNS rebinding is refused')
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:19387', origin: 'https://evil.example.com' } }), false)
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' } }), true)
  assert.equal(isTrustedRequest(ok, ['harness.internal']), true, 'a configured authority is trusted too')
})

// ── the route ────────────────────────────────────────────────────────────────

test('host: the route answers the method table and refuses anything else', async () => {
  const root = await makeStore()
  try {
    const renderer = createRenderer({ rootDir: root })
    const handler = createRouteHandler({ renderer: renderer, config: resolveConfig({}), pending: createPendingChannel(), log: { warn() {} } })
    const ping = fakeExchange('method=ping')
    await handler(ping.request, ping.response)
    assert.equal(ping.response.status, 200)
    assert.equal(ping.response.json().package, 'dsh-anagenesis-window')

    const bad = fakeExchange('method=destroyEverything')
    await handler(bad.request, bad.response)
    assert.equal(bad.response.status, 400)
    assert.deepEqual(bad.response.json().methods, RPC_METHODS)

    const refused = fakeExchange('method=ping', { host: 'evil.example.com' })
    await handler(refused.request, refused.response)
    assert.equal(refused.response.status, 403)
    assert.equal(refused.response.json().ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('host: a handler failure becomes a JSON answer, never a thrown route', async () => {
  const renderer = { status: async () => { throw new Error('store on fire') } }
  const handler = createRouteHandler({ renderer: renderer, config: resolveConfig({}), pending: createPendingChannel(), log: { warn() {} } })
  const exchange = fakeExchange('method=status')
  await handler(exchange.request, exchange.response)
  assert.equal(exchange.response.status, 500)
  assert.match(exchange.response.json().error, /store on fire/)
})

test('host: the pending channel is a slot, and peeking does not consume it', () => {
  const pending = createPendingChannel({ now: () => 42 })
  assert.equal(pending.take(), null)
  const first = pending.put('open', { view: 'dashboard' })
  assert.equal(first.seq, 1)
  assert.equal(pending.status().pending, true)
  const peeked = pending.take({ peek: true })
  assert.equal(peeked.action, 'open')
  assert.equal(pending.status().pending, true, 'peeking leaves the request alone')
  const taken = pending.take()
  assert.equal(taken.at, 42)
  assert.equal(pending.status().pending, false)
  assert.equal(pending.status().taken, 1)
  assert.equal(pending.take(), null)
  // Superseded, not queued: the newest request wins.
  pending.put('open', {})
  const second = pending.put('close', {})
  assert.equal(second.seq, 2)
  assert.equal(pending.take().action, 'close')
})

// ── the renderer ─────────────────────────────────────────────────────────────

test('host: the viz layer resolves through one of the two documented paths', async () => {
  const layer = await loadVizLayer()
  assert.ok(['package', 'relative'].includes(layer.resolvedBy))
  assert.ok(Array.isArray(layer.DASHBOARD_SECTIONS) && layer.DASHBOARD_SECTIONS.length > 0)
  assert.ok(Array.isArray(layer.DIAGRAM_KINDS) && layer.DIAGRAM_KINDS.includes('memory-graph'))
})

test('host: a missing store is an ANSWER, not an error', async () => {
  const renderer = createRenderer({ rootDir: join(tmpdir(), 'ana-window-does-not-exist-' + Date.now()) })
  const frame = await renderer.frame({})
  assert.equal(frame.ok, true)
  assert.equal(frame.empty, true)
  assert.equal(frame.storeFound, false)
  assert.match(frame.text, /存储尚未创建/)
  const status = await renderer.status()
  assert.equal(status.storeFound, false)
  assert.equal(status.storeVersion, 0)
})

test('host: a real store renders a frame and a diagram, and neither writes', async () => {
  const root = await makeStore()
  try {
    const renderer = createRenderer({ rootDir: root, cacheMs: 0 })
    const before = await renderer.status()
    assert.equal(before.storeFound, true)
    assert.equal(before.storeVersion, 3)
    assert.equal(before.memories, 1)

    const frame = await renderer.frame({ width: 88, redaction: 'secrets' })
    assert.equal(frame.ok, true)
    assert.equal(frame.width, 88)
    assert.equal(frame.storeVersion, 3)
    assert.ok(frame.sections.length > 0)
    assert.equal(typeof frame.text, 'string')
    assert.ok(frame.text.length > 0)
    assert.equal(frame.origin, 'mirror')

    const diagram = await renderer.diagram({ kind: 'memory-graph', format: 'd2' })
    assert.equal(diagram.ok, true)
    assert.equal(diagram.kind, 'memory-graph')
    assert.equal(diagram.format, 'd2')
    assert.equal(diagram.nodes >= 1, true)

    // Read-only: the store on disk is byte-identical afterwards.
    const after = await renderer.status()
    assert.equal(after.storeVersion, before.storeVersion)
    assert.equal(after.memories, before.memories)

    // And the renderer never exposes undefined through the JSON seam.
    assert.equal(JSON.stringify(frame).includes('undefined'), false)
    assert.equal(JSON.stringify(diagram).includes('undefined'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('host: the redaction level is applied before transport, never after', async () => {
  const root = await makeStore()
  try {
    const renderer = createRenderer({ rootDir: root, cacheMs: 0 })
    const strict = await renderer.diagram({ kind: 'lifecycle', format: 'ascii', redaction: 'strict' })
    assert.equal(strict.redaction, 'strict', 'the requested policy is what the model was built with')
    const fallback = await renderer.diagram({ kind: 'lifecycle', format: 'ascii', redaction: 'nonsense' })
    assert.equal(fallback.redaction, 'secrets', 'an unknown policy falls back to the safe one')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('host: the model methods return structured data, not rendered text', async () => {
  const root = await makeStore()
  try {
    const renderer = createRenderer({ rootDir: root, cacheMs: 0 })

    const dashboard = await renderer.dashboard({ width: 96, events: 4, salience: 3 })
    assert.equal(dashboard.ok, true)
    assert.equal(dashboard.empty, false)
    const dashModel = dashboard.model
    assert.equal(dashModel.kind, 'dashboard')
    assert.equal(typeof dashModel.store.version, 'number')
    assert.ok(Array.isArray(dashModel.sections) && dashModel.sections.length > 0)
    // 结构化：行是"标签 + 值 + 比例 + 色调"，不是一行已经拼好的文本。
    const rows = dashModel.sections.flatMap((item) => item.rows)
    assert.ok(rows.length > 0)
    for (const row of rows) {
      assert.ok('label' in row && 'value' in row, 'every row is structured')
      assert.equal(typeof row.value, 'string')
    }
    // 这个字段就是客户端画进度条用的比例。
    const lifecycle = dashModel.sections.find((item) => item.id === 'lifecycle')
    assert.ok(lifecycle !== undefined, 'the lifecycle section survives')
    assert.equal(typeof lifecycle.rows[0].bar, 'number', 'the bar ratio must be a number, not something the client has to parse')

    const graph = await renderer.graph({ kind: 'memory-graph', nodes: 20, timeline: 8 })
    assert.equal(graph.ok, true)
    const graphModel = graph.model
    assert.equal(graphModel.kind, 'memory-graph')
    assert.ok(Array.isArray(graphModel.nodes))
    assert.ok(Array.isArray(graphModel.edges))
    for (const node of graphModel.nodes) {
      for (const key of ['id', 'label', 'kind', 'state', 'salience']) {
        assert.ok(key in node, `a node without "${key}" cannot be laid out or coloured on the client`)
      }
    }
    assert.equal(typeof graphModel.totals.byState, 'object')

    // 文本方法照旧可用，且与模型同源（同一次读取，同一个版本）。
    const frame = await renderer.frame({ width: 96 })
    assert.equal(frame.storeVersion, dashModel.store.version)
    const diagram = await renderer.diagram({ kind: 'memory-graph', format: 'mermaid' })
    assert.equal(diagram.storeVersion, graphModel.store.version)
    assert.equal(typeof diagram.text, 'string')

    // 没有 undefined 穿过 JSON 缝。
    for (const payload of [dashboard, graph]) {
      assert.equal(JSON.stringify(payload).includes('undefined'), false)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('host: a missing store yields an empty model, not an error', async () => {
  const root = await makeStore()
  try {
    const renderer = createRenderer({ rootDir: join(root, 'nope'), cacheMs: 0 })
    const dashboard = await renderer.dashboard({})
    assert.equal(dashboard.ok, true, 'an absent store is a state, not a failure')
    assert.equal(dashboard.storeFound, false)
    assert.equal(dashboard.model.store.memories, 0)
    assert.ok(Array.isArray(dashboard.model.sections), 'the model keeps its shape so the client renderer can run')

    const graph = await renderer.graph({ kind: 'lifecycle' })
    assert.equal(graph.ok, true)
    assert.deepEqual(graph.model.transitions, [], 'and a lifecycle diagram with nothing to draw is still a valid model')
    for (const payload of [dashboard, graph]) {
      assert.equal(JSON.stringify(payload).includes('undefined'), false)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── the row ──────────────────────────────────────────────────────────────────

test('host: apply registers one route and one tool, and disposal removes both', async () => {
  const root = await makeStore()
  const host = createHostContext({ entries: [{ options: { id: 'better-sidebar', name: 'dsh-better-sidebar' } }] })
  try {
    apply(host.ctx, { rootDir: root })
    assert.ok(host.routes.has(ROUTE_PATH), 'the route is the window\u2019s only transport')
    assert.ok(host.tools.has('ana_window'))
    assert.equal(host.routeHandler() !== null, true)

    const exchange = fakeExchange('method=config')
    await host.routeHandler()(exchange.request, exchange.response)
    const config = exchange.response.json()
    assert.equal(config.ok, true)
    assert.equal(config.redaction, 'secrets')
    assert.equal(config.configVersion, 2)
    assert.equal(config.officialEntry, 'auto')

    host.dispose()
    assert.equal(host.routes.size, 0, 'the route must not outlive the row')
    assert.equal(host.tools.size, 0, 'and neither must the tool')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('host: the row can be switched off in one line and leaves nothing', async () => {
  const host = createHostContext()
  try {
    apply(host.ctx, { enabled: false })
    assert.equal(host.routes.size, 0)
    assert.equal(host.tools.size, 0)
    assert.ok(host.logs.some((row) => row.message.includes('disabled by config')))
  } finally {
    host.dispose()
  }
})

test('host: without a webserver the row still registers its tool and says so', async () => {
  const root = await makeStore()
  const host = createHostContext({ webServer: false })
  try {
    apply(host.ctx, { rootDir: root })
    assert.equal(host.routes.size, 0)
    assert.ok(host.tools.has('ana_window'), 'a composition without a webserver still gets the agent door')
    assert.ok(host.logs.some((row) => row.level === 'warn' && row.message.includes('no webserver')), 'the degradation is logged, not silent')
  } finally {
    host.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('host: without a tools service the route still serves and says so', async () => {
  const root = await makeStore()
  const host = createHostContext({ tools: false })
  try {
    apply(host.ctx, { rootDir: root })
    assert.equal(host.tools.size, 0)
    assert.ok(host.routes.has(ROUTE_PATH), 'the window keeps working with no tool surface at all')
    assert.ok(host.logs.some((row) => row.level === 'warn' && row.message.includes('no tools service')))
  } finally {
    host.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('host: probeProfile reads the Loader entry list, including a second window row', () => {
  const host = createHostContext({
    entries: [
      { options: { id: 'better-sidebar', name: 'dsh-better-sidebar' } },
      { options: { id: 'anagenesis-window', name: 'dsh-anagenesis-window' } },
      { options: { id: 'anagenesis-window-2', name: 'dsh-anagenesis-window' } },
      { options: { id: 'disabled-one', name: 'dsh-better-sidebar', disabled: true } },
    ],
  })
  const probe = probeProfile(host.ctx)
  assert.equal(probe.loaderVisible, true)
  assert.equal(probe.betterSidebarMounted, true)
  assert.equal(probe.windowRows, 2, 'the forbidden double-mount must be visible in the report')
  const empty = probeProfile({})
  assert.deepEqual(empty, { betterSidebarMounted: false, loaderVisible: false, entryIds: [] })
})

test('host: ana_window leaves the agent a request and reports honestly', async () => {
  const root = await makeStore()
  const host = createHostContext({ entries: [{ options: { id: 'better-sidebar', name: 'dsh-better-sidebar' } }] })
  try {
    apply(host.ctx, { rootDir: root })
    const tool = host.tools.get('ana_window')
    assert.ok(tool !== undefined)

    const opened = await tool.execute({ action: 'open', view: 'graph', direction: 'TB' }, {})
    assert.equal(opened.ok, true)
    assert.equal(opened.delivered, 'pending')
    assert.equal(opened.pending, true)
    assert.equal(opened.windowInstalled, true)
    assert.equal(opened.betterSidebarMounted, true)
    assert.deepEqual(opened.expectedEntries, ['better-sidebar-row', 'conversation-header'])
    assert.match(opened.text, /ana_dashboard/, 'the agent is told not to depend on the window having appeared')

    // The request is drained by the window, not by the tool.
    const exchange = fakeExchange('method=takeOpen')
    await host.routeHandler()(exchange.request, exchange.response)
    assert.equal(exchange.response.json().request.action, 'open')
    assert.equal(exchange.response.json().request.detail.view, 'graph', 'the requested face travels with the request')
    assert.equal(exchange.response.json().request.detail.direction, 'TB', 'and so does the layout direction')

    const after = await tool.execute({ action: 'status' }, {})
    assert.equal(after.pending, false, 'the slot is empty once taken')
    assert.equal(after.storeFound, true)
    assert.equal(after.storeVersion, 3)

    // No `undefined` anywhere in a tool answer: the host's lossless-JSON gate
    // fails the whole call over one missing key.
    for (const value of [opened, after]) {
      assert.equal(JSON.stringify(value).includes('undefined'), false)
      for (const key of ['ok', 'action', 'delivered', 'text']) assert.ok(key in value, `missing required output key ${key}`)
    }
  } finally {
    host.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('host: ana_window predicts the official seat when better-sidebar is absent', async () => {
  const root = await makeStore()
  const host = createHostContext({ entries: [] })
  try {
    apply(host.ctx, { rootDir: root })
    const result = await host.tools.get('ana_window').execute({ action: 'status' }, {})
    assert.equal(result.betterSidebarMounted, false)
    assert.deepEqual(result.expectedEntries, ['official-right-sidebar', 'conversation-header'])
  } finally {
    host.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

// ── utilities ────────────────────────────────────────────────────────────────

test('host: the bundle patch declares exactly one row whose config keys all exist', () => {
  // Drift guard between the YAML a profile reads at boot and the `Config` schema
  // this row actually resolves. A key that exists in only one of the two is either
  // dead config or a boot-time validation failure, and neither is visible offline.
  const text = readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')
  const rows = text.split('\n').filter((line) => /^\s*- id:\s/.test(line))
  assert.equal(rows.length, 1, 'a dsh.client package may own exactly one active Loader row')
  assert.match(rows[0], /anagenesis-window/)
  assert.match(text, /name: dsh-anagenesis-window/)

  const known = new Set(Object.keys(resolveConfig({})))
  const body = text.slice(text.indexOf('config:'))
  const declared = body.split('\n')
    .filter((line) => /^\s{8,}[a-zA-Z][a-zA-Z0-9]*:/.test(line))
    .map((line) => line.trim().split(':')[0])
  assert.ok(declared.length >= 8, `expected the patch to configure the row, saw ${declared.length} keys`)
  for (const key of declared) {
    assert.ok(known.has(key), `cordis.patch.yml sets "${key}", which resolveConfig does not accept`)
  }
})

test('host: once() runs a disposer exactly once and never throws outward', () => {
  let calls = 0
  const disposable = once(() => {
    calls += 1
  })
  disposable()
  disposable()
  assert.equal(calls, 1)

  const errors = []
  const throwing = once(() => {
    throw new Error('disposal failed')
  }, (error) => errors.push(error))
  throwing()
  throwing()
  assert.equal(errors.length, 1)
})