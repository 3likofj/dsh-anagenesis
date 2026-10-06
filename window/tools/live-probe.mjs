#!/usr/bin/env node
/**
 * live-probe — start the Host half for real, serve its route over real HTTP, and
 * exercise every method the window's client half calls.
 *
 * Why this exists next to the unit tests: the tests fake the transport so they can
 * assert on it. This does the opposite — it mounts `apply()` on a real Cordis-shaped
 * context, hands it a real `node:http` server, and drives `/anagenesis-window/api`
 * with real `fetch` calls. That is the closest thing to the desktop window's data
 * path that can be run without restarting the GUI host, and it is what proves the
 * route, the fence, the lossless-JSON seam and the renderer compose.
 *
 * It NEVER writes to the store it reads: by default it builds a throwaway store in
 * the system temp directory; `--root <dir>` points it at a real one, read-only.
 *
 *   node tools/live-probe.mjs                 sandbox store, full report
 *   node tools/live-probe.mjs --root "$DSH_HOME/anagenesis"   the real store, read-only
 *   node tools/live-probe.mjs --json          machine-readable
 * @module dsh-anagenesis-window/tools/live-probe
 */

import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { apply, resolveConfig } from '../src/index.js'
import { ROUTE_PATH } from '../src/host/rpc.js'

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { json: false, root: '' }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--json') out.json = true
    else if (argv[index] === '--root') {
      index += 1
      out.root = String(argv[index] ?? '')
    } else if (argv[index] === '--help' || argv[index] === '-h') out.help = true
    else {
      console.error(`live-probe: unknown argument "${argv[index]}"`)
      process.exit(2)
    }
  }
  return out
}

/** A store the probe may write to: it is its own sandbox, built by hand. */
async function makeSandboxStore() {
  const root = await mkdtemp(join(tmpdir(), 'ana-window-probe-'))
  await mkdir(join(root, 'journal'), { recursive: true })
  const now = Date.now()
  const state = {
    schemaVersion: 6,
    version: 2,
    createdAt: now,
    updatedAt: now,
    memories: {
      'mem-probe-1': {
        id: 'mem-probe-1', kind: 'procedure', subject: 'Always read the store through the mirror',
        body: 'A second writer would race the single-writer pool.', gist: 'use the mirror',
        tags: ['probe'], links: [{ rel: 'supports', to: 'mem-probe-2' }],
        state: 'verified', confidence: 0.9, salience: 0.8,
        scope: { global: true, session: null, workspace: null, preset: null },
        provenance: { source: 'probe', author: null, taskId: null, evidence: ['live-probe'], derivedFrom: [] },
        ttlMs: null, createdAt: now, updatedAt: now, lastUsedAt: now, uses: 1,
        supersedes: [], supersededBy: null, parentId: null,
        embedding: { id: 'hash', dim: 3, vector: [0, 0, 0] },
      },
      'mem-probe-2': {
        id: 'mem-probe-2', kind: 'constraint', subject: 'The window never takes a writer handle',
        body: 'It is a viewer.', gist: 'read-only',
        tags: ['probe'], links: [],
        state: 'locked', confidence: 0.95, salience: 0.9,
        scope: { global: true, session: null, workspace: null, preset: null },
        provenance: { source: 'probe', author: null, taskId: null, evidence: [], derivedFrom: [] },
        ttlMs: null, createdAt: now, updatedAt: now, lastUsedAt: null, uses: 0,
        supersedes: [], supersededBy: null, parentId: null,
        embedding: { id: 'hash', dim: 3, vector: [0, 0, 0] },
      },
    },
    strategies: {},
    stacks: { global: ['guard', 'exploit'] },
    params: { global: {} },
    audit: [],
    stats: { commits: 2, recalls: 1, writes: 2, reverts: 0, hookFailures: 0 },
    embed: { id: 'hash', dim: 3 },
    tuning: { recall: { orient: { tokenBudget: 1600 } } },
  }
  await writeFile(join(root, 'snapshot.json'), JSON.stringify({ state }, null, 2), 'utf8')
  return root
}

/** The pieces of a host Context this row touches, backed by a real HTTP server. */
function createHostContext() {
  const routes = new Map()
  const tools = new Map()
  const effects = []
  const logs = []
  const services = new Map()
  services.set('webServer', {
    register(route) {
      if (routes.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  })
  services.set('tools', {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  })
  const ctx = {
    logger: {
      info: (message) => logs.push({ level: 'info', message: message }),
      warn: (message) => logs.push({ level: 'warn', message: message }),
      error: (message) => logs.push({ level: 'error', message: message }),
    },
    loader: { entries: () => [{ options: { id: 'anagenesis-window', name: 'dsh-anagenesis-window' } }] },
    get: (name, strict) => {
      if (services.has(name)) return services.get(name)
      if (strict !== false) throw new Error(`cannot resolve "${name}"`)
      return undefined
    },
    effect(fn, label) {
      const result = fn()
      const dispose = () => {
        if (typeof result === 'function') result()
      }
      effects.push({ label: label, dispose: dispose })
      return dispose
    },
    inject(deps, cb) {
      if (!deps.every((name) => services.has(name))) return () => {}
      return cb({
        get: (name, strict) => {
          if (services.has(name)) return services.get(name)
          if (strict !== false) throw new Error(`cannot resolve "${name}"`)
          return undefined
        },
      })
    },
  }
  return {
    ctx: ctx,
    routes: routes,
    tools: tools,
    logs: logs,
    read(path, req) {
      const route = routes.get(path)
      if (route === undefined) return null
      return route.handler(req)
    },
    dispose() {
      for (let index = effects.length - 1; index >= 0; index -= 1) effects[index].dispose()
    },
  }
}

const options = parseArgs(process.argv.slice(2))
if (options.help === true) {
  console.log('live-probe [--root <dir>] [--json]')
  process.exit(0)
}

const sandbox = options.root === '' ? await makeSandboxStore() : ''
const root = options.root === '' ? sandbox : resolve(options.root)
const report = { root: root, sandbox: options.root === '', steps: [], ok: false }
const fail = async (step, error) => {
  report.steps.push({ step: step, ok: false, error: error instanceof Error ? error.message : String(error) })
  console.error(`live-probe: ${step} FAILED — ${report.steps[report.steps.length - 1].error}`)
  await cleanup()
  process.exitCode = 1
}
const cleanup = async () => {
  if (sandbox !== '') await rm(sandbox, { recursive: true, force: true }).catch(() => {})
}

const host = createHostContext()
apply(host.ctx, resolveConfig({ rootDir: root }))

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = host.routes.get(ROUTE_PATH)
  if (route === undefined || !url.pathname.startsWith(ROUTE_PATH)) {
    res.writeHead(404).end('not found')
    return
  }
  route.handler(req, res)
})

const port = await new Promise((done) => {
  server.listen(0, '127.0.0.1', () => done(server.address().port))
})
const base = `http://127.0.0.1:${port}${ROUTE_PATH}`

/** @param {string} query */
async function call(query, headers = {}) {
  const response = await fetch(`${base}?${query}`, { headers: headers })
  return { status: response.status, body: await response.json() }
}

/**
 * `fetch` refuses to let a caller forge the Host header — which is exactly the
 * header the fence reads, so the negative case needs a raw request.
 * @param {string} query
 * @param {Record<string, string>} headers
 */
function rawCall(query, headers) {
  return new Promise((done, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: port, path: `${ROUTE_PATH}?${query}`, method: 'GET', headers: headers }, (response) => {
      let body = ''
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => done({ status: response.statusCode, body: JSON.parse(body) }))
    })
    request.on('error', reject)
    request.end()
  })
}

try {
  if (host.routes.size !== 1) throw new Error(`expected exactly one route, got ${host.routes.size}`)
  if (!host.tools.has('ana_window')) throw new Error('ana_window was not registered')
  report.steps.push({ step: 'apply registered one route + one tool', ok: true })

  const ping = await call('method=ping')
  if (ping.status !== 200 || ping.body.package !== 'dsh-anagenesis-window') throw new Error('ping did not answer')
  report.steps.push({ step: 'GET ping', ok: true, methods: ping.body.methods })

  const config = await call('method=config')
  report.config = config.body
  report.steps.push({ step: 'GET config', ok: true, officialEntry: config.body.officialEntry, redaction: config.body.redaction })

  const status = await call('method=status')
  report.status = { storeFound: status.body.storeFound, storeVersion: status.body.storeVersion, memories: status.body.memories }
  if (status.body.storeFound !== true) throw new Error('the store was not found')
  report.steps.push({ step: 'GET status', ok: true, ...report.status })

  const frame = await call('method=frame&width=88')
  if (frame.body.ok !== true || typeof frame.body.text !== 'string' || frame.body.text.length === 0) throw new Error('frame was empty')
  report.frame = { width: frame.body.width, sections: frame.body.sections, bytes: frame.body.text.length }
  report.steps.push({ step: 'GET frame', ok: true, ...report.frame })

  const diagram = await call('method=diagram&kind=memory-graph&format=mermaid')
  if (diagram.body.ok !== true || typeof diagram.body.text !== 'string' || diagram.body.text.length === 0) throw new Error('diagram was empty')
  report.diagram = { kind: diagram.body.kind, format: diagram.body.format, nodes: diagram.body.nodes, edges: diagram.body.edges }
  report.steps.push({ step: 'GET diagram', ok: true, ...report.diagram })

  // ── 窗口实际使用的那两个方法：结构化模型，不是文本 ────────────────────────
  const dashboard = await call('method=dashboard&width=96&events=8&salience=5')
  if (dashboard.body.ok !== true) throw new Error('the dashboard model was refused')
  if (typeof dashboard.body.model?.store?.version !== 'number') throw new Error('the dashboard model has no store facts')
  if (!Array.isArray(dashboard.body.model?.sections) || dashboard.body.model.sections.length === 0) throw new Error('the dashboard model has no sections')
  const sectionIds = dashboard.body.model.sections.map((section) => section.id)
  if (sectionIds.includes('overview') !== true) throw new Error('the dashboard model lost its overview section')
  if (typeof dashboard.body.model.sections[0].rows?.[0]?.label !== 'string') throw new Error('the dashboard rows are not structured')
  report.dashboard = { sections: sectionIds.length, ids: sectionIds, memories: dashboard.body.model.store.memories }
  report.steps.push({ step: 'GET dashboard → structured model (not a text frame)', ok: true, ...report.dashboard })

  const graph = await call('method=graph&kind=memory-graph&nodes=40&timeline=16')
  if (graph.body.ok !== true) throw new Error('the graph model was refused')
  const model = graph.body.model
  if (model?.kind !== 'memory-graph') throw new Error('the graph model reported the wrong kind')
  if (!Array.isArray(model.nodes) || !Array.isArray(model.edges)) throw new Error('the graph model has no nodes/edges')
  for (const key of ['id', 'label', 'kind', 'state', 'salience']) {
    if (model.nodes.length > 0 && typeof model.nodes[0][key] === 'undefined') throw new Error(`a graph node is missing "${key}" — client-side layout would have to guess`)
  }
  if (typeof model.totals?.byState !== 'object') throw new Error('the graph model has no state totals')
  // 渲染层在客户端；这里证明"它拿到的原料足够画出中文图"，而不是"服务端回了文本"。
  if (typeof graph.body.model.nodes[0]?.label !== 'string' || graph.body.model.nodes[0].label.length === 0) {
    throw new Error('a graph node has no label to draw')
  }
  report.graph = { kind: model.kind, nodes: model.nodes.length, edges: model.edges.length, states: Object.keys(model.totals.byState).length }
  report.steps.push({ step: 'GET graph → structured model with drawable node labels', ok: true, ...report.graph })

  const lifecycle = await call('method=graph&kind=lifecycle')
  if (lifecycle.body.ok !== true || lifecycle.body.model.kind !== 'lifecycle') throw new Error('the lifecycle model was refused')
  if (!Array.isArray(lifecycle.body.model.transitions)) throw new Error('the lifecycle model has no transitions')
  report.steps.push({ step: 'GET graph&kind=lifecycle → transitions', ok: true, transitions: lifecycle.body.model.transitions.length })

  const timeline = await call('method=graph&kind=strategy-timeline')
  if (timeline.body.ok !== true || !Array.isArray(timeline.body.model.timeline)) throw new Error('the timeline model was refused')
  report.steps.push({ step: 'GET graph&kind=strategy-timeline → events', ok: true, events: timeline.body.model.timeline.length })

  // 文本方法与结构化模型必须来自同一份 mirror：否则窗口与工具会各说各话。
  if (dashboard.body.model.store.version !== frame.body.storeVersion) {
    throw new Error(`the dashboard model (v${dashboard.body.model.store.version}) and the text frame (v${frame.body.storeVersion}) disagree`)
  }
  report.steps.push({ step: 'model store version === text frame store version', ok: true })

  const bad = await call('method=dropDatabase')
  if (bad.status !== 400) throw new Error(`an unknown method answered ${bad.status}, expected 400`)
  report.steps.push({ step: 'GET unknown method → 400', ok: true })

  const untrusted = await rawCall('method=ping', { host: 'evil.example.com' })
  if (untrusted.status !== 403) throw new Error(`an untrusted Host answered ${untrusted.status}, expected 403`)
  report.steps.push({ step: 'raw GET with a foreign Host header → 403 (the fence is in the path)', ok: true })

  const crossSite = await rawCall('method=ping', { host: '127.0.0.1:' + String(port), 'sec-fetch-site': 'cross-site' })
  if (crossSite.status !== 403) throw new Error(`a cross-site marker answered ${crossSite.status}, expected 403`)
  report.steps.push({ step: 'raw GET with sec-fetch-site: cross-site → 403', ok: true })

  const toolOpen = await host.tools.get('ana_window').execute({ action: 'open', view: 'graph' }, {})
  if (toolOpen.delivered !== 'pending') throw new Error('ana_window did not leave a pending request')
  const drained = await call('method=takeOpen')
  if (drained.body.request === null || drained.body.request.action !== 'open') throw new Error('the window could not drain the request')
  const empty = await call('method=takeOpen')
  if (empty.body.request !== null) throw new Error('the pending slot was not consumed')
  report.steps.push({ step: 'ana_window → pending slot → takeOpen drained it once', ok: true })
  report.toolText = toolOpen.text.split('\n')[0]

  const noUndefined = [config, status, frame, diagram, dashboard, graph, lifecycle, timeline, drained, empty]
    .every((entry) => !JSON.stringify(entry.body).includes('undefined'))
  if (!noUndefined) throw new Error('a payload carried undefined through the lossless-JSON seam')
  report.steps.push({ step: 'every payload is lossless JSON', ok: true })

  // The window's frame must be byte-identical to what the tools' own renderer
// produces from the same mirror: one model, two surfaces. This compares the bytes
// that crossed HTTP against a direct offline render.
  //
  // 这里有**两处时钟依赖**，都不是模型分叉：
  //   1. 相对时间记号（`0s` → `1s`），离散；
  //   2. 重要度经过时间衰减，是**连续**的（`0.95` 可能变 `0.94`）。
  // 所以做法是：先按字节比（最强信号），不等时归一化离散记号再比，仍然不等就
  // **重新取一次帧并重渲染**，最多几次 —— 只要有任何一对在同一个时间片内相等，
  // 就证明"同一份 mirror、同一份渲染"。全都不等才失败，并且**打印首个差异行**，
  // 这样真出问题时能直接看出是哪里分了叉，而不是只看到一句"帧不一致"。
  const { buildDashboardModel } = await import('../../src/viz/model.js')
  const { renderFrame } = await import('../../src/viz/tui.js')
  const { readStoreMirror } = await import('../../src/viz/mirror.js')
  const stripAges = (text) => String(text).replace(/\b\d+(\.\d+)?[smhd]\b/g, '<age>').replace(/\b0\.\d{2}\b/g, '<sal>')

  let identical = false
  let byteEqual = false
  let normalized = false
  let direct = ''
  let attempts = 0
  let firstDiff = ''
  for (attempts = 1; attempts <= 4 && !identical; attempts += 1) {
    const fresh = attempts === 1 ? frame : await call('method=frame&width=88')
    const mirror = await readStoreMirror(root)
    direct = renderFrame(buildDashboardModel(mirror, {
      width: 88,
      color: 'never',
      limit: { events: 8, salience: 5 },
      redaction: 'secrets',
      // 与窗口路由保持一致：窗口的 `/frame` 走 zh，所以这里的"直接渲染"也必须走 zh。
      lang: 'zh',
    }), { width: 88, color: 'never', isTty: false })
    const remote = String(fresh.body.text ?? '')
    byteEqual = direct === remote
    identical = byteEqual || stripAges(direct) === stripAges(remote)
    normalized = identical && !byteEqual
    if (!identical) {
      const a = direct.split('\n')
      const b = remote.split('\n')
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if (a[i] !== b[i]) {
          firstDiff = `L${i + 1}: 本地 ${JSON.stringify(String(a[i] ?? '').slice(0, 60))} ≠ HTTP ${JSON.stringify(String(b[i] ?? '').slice(0, 60))}`
          break
        }
      }
    }
  }
  report.oneModelTwoSurfaces = {
    identical: identical, byteEqual: byteEqual, normalized: normalized,
    bytes: direct.length, attempts: attempts - 1, firstDiff: firstDiff,
  }
  if (!identical) throw new Error(`the window frame differs from the tool-side render of the same mirror (${attempts - 1} attempts) — ${firstDiff}`)
  report.steps.push({
    step: normalized
      ? 'the HTTP frame == the tool-side render of the same mirror (identical after normalising relative ages)'
      : 'the HTTP frame == the tool-side render of the same mirror',
    ok: true,
    bytes: direct.length,
  })

  report.ok = true
} catch (error) {
  await fail('probe', error)
}

server.close()
host.dispose()
if (host.routes.size !== 0 || host.tools.size !== 0) {
  report.steps.push({ step: 'teardown removed the route and the tool', ok: false, routes: host.routes.size, tools: host.tools.size })
  report.ok = false
} else {
  report.steps.push({ step: 'teardown removed the route and the tool', ok: true })
}

const storeTouched = !report.sandbox
await cleanup()

if (options.json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`anagenesis-window live probe — root=${report.root}${storeTouched ? ' (read-only, NOT created by this probe)' : ' (sandbox)'}`)
  for (const step of report.steps) {
    console.log(`${step.ok ? 'ok  ' : 'FAIL'} ${step.step}${step.error === undefined ? '' : ` — ${step.error}`}`)
  }
  console.log(report.ok ? '\nALL PROBE CHECKS PASSED' : '\nPROBE FAILED')
}
process.exit(report.ok ? 0 : 1)