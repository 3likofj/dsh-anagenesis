/**
 * Visualization models — pure projections of anagenesis's own state.
 *
 * This module is the seam that keeps the visualization layer honest and
 * replaceable: nothing here renders. A model is plain JSON (`{ label, value,
 * bar }` rows, node/edge lists, transition counts), so the TUI serializer, the
 * Mermaid/D2/ASCII serializers — and a future GUI, if the host ever grows one —
 * all consume the same object. Rendering is a separate, total function of the
 * model, which is why it can be tested without a terminal and cannot change the
 * store.
 *
 * Sources are read-only views of *this* plugin's store: `state`, the journal
 * window the store already holds in memory, and (when the caller has them) the
 * live engine/tuner reports. The standalone watcher passes the same shape built
 * from files, so one renderer serves both.
 * @module dsh-anagenesis/viz/model
 */

import { KINDS, STATES, LIVE_STATES, effectiveSalience } from '../store/schema.js'
import { PARAM_ENVELOPE } from '../meta/tuner.js'
import { inScope } from '../memory/recall.js'
import { DEFAULT_REDACTION, redactRecord, redactionNote } from './redact.js'

export const DASHBOARD_SECTIONS = Object.freeze([
  'overview', 'lifecycle', 'kinds', 'strategy', 'tuning', 'journal', 'salience', 'viz',
])

export const DIAGRAM_KINDS = Object.freeze(['memory-graph', 'strategy-timeline', 'lifecycle'])

/** Event types the strategy timeline is about: governance, not memory content. */
const TIMELINE_TYPES = Object.freeze([
  'strategy.setStack', 'strategy.activate', 'strategy.register', 'strategy.deactivate',
  'meta.tune', 'meta.feedback', 'preset.bind', 'revert', 'journal.prune', 'engine.quarantine',
])

/**
 * Operations that move a record into a state without recording where it came
 * from (`src/memory/ops.js` writes `ids` and a reason, not a `from`).
 */
const DESTINATION_ONLY = Object.freeze({
  'memory.lock': 'locked',
  'memory.expire': 'expired',
  'memory.sweep': 'expired',
})

const DEFAULT_LIMITS = Object.freeze({ events: 8, salience: 5, timeline: 12, nodes: 40 })

/**
 * @typedef {object} VizSource
 * @property {any} state the anagenesis state (frozen; never mutated here)
 * @property {any[]} [events] journal events, newest first
 * @property {any} [journal] `store.journalStats()`
 * @property {any} [engine] `{ active: string[], health: any[] }`
 * @property {any} [tuning] `service.tuner.report()`
 * @property {any} [selfStatus] `{ renders, diagrams, lastAt, errors, mode }`
 * @property {string} [origin] 'live' | 'mirror'
 */

/**
 * @param {VizSource} source
 * @param {any} [opts]
 * @returns {any} a JSON-safe dashboard model
 */
export function buildDashboardModel(source, opts = {}) {
  const state = source.state ?? {}
  const limits = mergeLimits(opts.limit)
  const redaction = opts.redaction ?? DEFAULT_REDACTION
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const warnings = collectWarnings(source, opts, limits)
  const wanted = Array.isArray(opts.sections) && opts.sections.length > 0 ? opts.sections : DASHBOARD_SECTIONS
  const context = { state, source, opts, limits, redaction, now, warnings, selfStatus: opts.selfStatus ?? source.selfStatus ?? {} }

  const builders = {
    overview: overviewSection,
    lifecycle: lifecycleSection,
    kinds: kindsSection,
    strategy: strategySection,
    tuning: tuningSection,
    journal: journalSection,
    salience: salienceSection,
    viz: vizSection,
  }
  const sections = []
  for (const id of wanted) {
    const build = builders[id]
    if (build === undefined) {
      warnings.push(`unknown section "${id}" ignored`)
      continue
    }
    sections.push(build(context))
  }

  return {
    kind: 'dashboard',
    title: 'anagenesis dashboard',
    generatedAt: now,
    origin: source.origin ?? 'live',
    store: storeFacts(state),
    sections,
    warnings,
    limits: { events: limits.events, salience: limits.salience, nodes: limits.nodes },
    redaction: { level: redaction, note: redactionNote(redaction, opts) },
    render: { width: Number(opts.width ?? 96), color: String(opts.color ?? 'never') },
  }
}

/**
 * @param {VizSource} source
 * @param {any} [opts]
 * @returns {any} a JSON-safe diagram model
 */
export function buildDiagramModel(source, opts = {}) {
  const state = source.state ?? {}
  const kind = DIAGRAM_KINDS.includes(opts.kind) ? opts.kind : 'memory-graph'
  const limits = mergeLimits(opts.limit)
  const redaction = opts.redaction ?? DEFAULT_REDACTION
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const warnings = collectWarnings(source, opts, limits)

  const base = {
    kind,
    title: `anagenesis ${kind}`,
    generatedAt: now,
    origin: source.origin ?? 'live',
    store: storeFacts(state),
    nodes: [],
    edges: [],
    timeline: [],
    transitions: [],
    totals: { byState: countBy(visibleRecords(state, opts), (record) => record.state), byKind: countBy(visibleRecords(state, opts), (record) => record.kind), byEventType: countEventTypes(source.events ?? []) },
    warnings,
    limits: { nodes: limits.nodes, timeline: limits.timeline },
    redaction: { level: redaction, note: redactionNote(redaction, opts) },
  }

  if (kind === 'memory-graph') {
    const graph = memoryGraph(state, opts, limits, redaction)
    base.nodes = graph.nodes
    base.edges = graph.edges
    base.warnings.push(...graph.warnings)
  } else if (kind === 'strategy-timeline') {
    base.timeline = strategyTimeline(source.events ?? [], limits)
  } else {
    base.transitions = lifecycleTransitions(source.events ?? [], limits)
  }
  return base
}

// ── shared helpers ────────────────────────────────────────────────────────────

/**
 * Merge caller limits over the defaults **ignoring explicit undefined**.
 *
 * `{ ...DEFAULT_LIMITS, ...{ nodes: undefined } }` silently deletes the default,
 * and `undefined` reaching `slice(0, undefined)` produces an empty graph rather
 * than an error — a silent wrong picture, which is the one failure mode a
 * visualization layer must not have. A caller that has no value to pass must be
 * able to pass nothing.
 * @param {any} limit
 * @returns {{ events: number, salience: number, timeline: number, nodes: number }}
 */
function mergeLimits(limit) {
  /** @type {any} */
  const out = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(limit ?? {})) {
    if (value === undefined || value === null) continue
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) out[key] = Math.floor(parsed)
  }
  return out
}

/**
 * @param {any} state
 * @param {string} [scopeKey]
 * @returns {number}
 */
export function totalLive(state, scopeKey = 'global') {
  const records = Object.values(state.memories ?? {})
  if (records.length === 0) return 0
  return records.filter((record) => LIVE_STATES.includes(/** @type {any} */ (record).state)).length
}

/**
 * Records visible to a caller. With no `scope` filter the whole store is shown —
 * it is the caller's own store; the filter exists so a scoped session can look
 * at just what it can recall.
 * @param {any} state
 * @param {any} opts
 * @returns {any[]}
 */
export function visibleRecords(state, opts = {}) {
  const records = Object.values(state.memories ?? {})
  const filter = opts.scope
  if (filter === undefined || filter === null) return records
  const plan = { scope: /** @type {any} */ (filter) }
  return records.filter((record) => inScope(/** @type {any} */ (record), plan))
}

/**
 * @param {any} records
 * @param {(record: any) => string} keyOf
 * @returns {Record<string, number>}
 */
export function countBy(records, keyOf) {
  /** @type {Record<string, number>} */
  const out = {}
  for (const record of records) {
    const key = String(keyOf(record))
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

/**
 * @param {any[]} events
 * @returns {Record<string, number>}
 */
export function countEventTypes(events) {
  /** @type {Record<string, number>} */
  const out = {}
  for (const event of events ?? []) {
    const type = String(event?.type ?? 'unknown')
    out[type] = (out[type] ?? 0) + 1
  }
  return out
}

/**
 * @param {any} state
 * @returns {{ version: number, schemaVersion: number, memories: number, live: number, safeMode: boolean, stacks: string[] }}
 */
function storeFacts(state) {
  return {
    version: Number(state.version ?? 0),
    schemaVersion: Number(state.schemaVersion ?? 0),
    memories: Object.keys(state.memories ?? {}).length,
    live: totalLive(state),
    safeMode: state.safeMode === true,
    stacks: Object.keys(state.stacks ?? {}).sort(scopeOrder),
  }
}

/** @param {string} a @param {string} b */
function scopeOrder(a, b) {
  if (a === 'global') return -1
  if (b === 'global') return 1
  return a.localeCompare(b)
}

/**
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
function shorten(text, width = 72) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`
}

/**
 * @param {number} at
 * @param {number} now
 * @returns {string}
 */
export function humanAge(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '—'
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * @param {VizSource} source
 * @param {any} opts
 * @param {any} limits
 * @returns {string[]}
 */
function collectWarnings(source, opts, limits) {
  const warnings = []
  if ((source.origin ?? 'live') === 'mirror') {
    warnings.push('read-only mirror: engine health, tuner metric and journal counters come from state/files, not a live service')
  }
  if ((opts.redaction ?? DEFAULT_REDACTION) === 'none') {
    warnings.push('redaction=none: this artifact may contain credentials — do not paste it outside your own terminal')
  }
  const eventCount = (source.events ?? []).length
  if (eventCount > limits.events && eventCount > 0) {
    warnings.push(`journal window shows ${limits.events} of ${eventCount} in-memory events`)
  }
  return warnings
}

// ── dashboard sections ────────────────────────────────────────────────────────

/** @param {any} ctx @returns {any} */
function overviewSection(ctx) {
  const { state, source } = ctx
  /** @type {any[]} */
  const rows = [
    { label: 'store', value: `v${state.version ?? 0} · schema v${state.schemaVersion ?? 0}` },
    { label: 'memories', value: `${Object.keys(state.memories ?? {}).length} (${totalLive(state)} live)`, tone: 'accent' },
    { label: 'safe mode', value: state.safeMode === true ? 'ON (meta frozen)' : 'off', tone: state.safeMode === true ? 'warn' : 'ok' },
    { label: 'origin', value: `${ctx.source.origin ?? 'live'}${(ctx.source.origin ?? 'live') === 'mirror' ? ' (read-only)' : ''}` },
  ]
  const journal = stateJournal(ctx)
  rows.splice(3, 0, { label: 'journal', value: `live ${journal.live} · archives ${journal.archives} · checkpoints ${journal.checkpoints}` })
  if (journal.prunedThroughSeq > 0) {
    rows.push({ label: 'pruned', value: `every seq ≤ #${journal.prunedThroughSeq} was dropped by the retention policy`, tone: 'warn' })
  }
  return { id: 'overview', title: 'overview', rows }
}

/** @param {any} ctx @returns {any} */
function lifecycleSection(ctx) {
  const records = visibleRecords(ctx.state, ctx.opts)
  const counts = countBy(records, (record) => record.state)
  const total = records.length
  const rows = STATES.map((state) => {
    const count = counts[state] ?? 0
    return {
      label: state,
      value: `${count}${total > 0 ? ` (${Math.round((count / total) * 100)}%)` : ''}`,
      bar: total > 0 ? count / total : 0,
      tone: count === 0 ? 'dim' : LIVE_STATES.includes(state) ? 'accent' : 'warn',
    }
  })
  return { id: 'lifecycle', title: `lifecycle · ${total} record(s)`, rows }
}

/** @param {any} ctx @returns {any} */
function kindsSection(ctx) {
  const records = visibleRecords(ctx.state, ctx.opts)
  const counts = countBy(records, (record) => record.kind)
  const max = Math.max(1, ...Object.values(counts))
  const rows = KINDS.map((kind) => {
    const count = counts[kind] ?? 0
    return { label: kind, value: String(count), bar: count / max, tone: count === 0 ? 'dim' : 'plain' }
  })
  return { id: 'kinds', title: 'kinds', rows }
}

/** @param {any} ctx @returns {any} */
function strategySection(ctx) {
  const { state, source } = ctx
  /** @type {any[]} */
  const rows = []
  for (const scope of Object.keys(state.stacks ?? {}).sort(scopeOrder)) {
    rows.push({
      label: scope === 'global' ? 'global' : shorten(scope, 28),
      value: (state.stacks[scope] ?? []).join(' → ') || '(empty)',
      tone: scope === 'global' ? 'accent' : 'plain',
    })
  }
  if (Array.isArray(source.engine?.active)) {
    rows.push({ label: 'active', value: source.engine.active.join(' → ') || '(none)', tone: 'ok' })
    const quarantined = (source.engine.health ?? []).filter((row) => row?.quarantined)
    rows.push({
      label: 'health',
      value: quarantined.length === 0 ? 'ok — no strategy quarantined' : `quarantined: ${quarantined.map((row) => row.strategy).join(', ')}`,
      tone: quarantined.length === 0 ? 'ok' : 'bad',
    })
  } else {
    rows.push({ label: 'health', value: 'not available in a read-only mirror', tone: 'dim' })
  }
  if (Object.keys(state.strategies ?? {}).length > 0) {
    rows.push({ label: 'registered', value: Object.keys(state.strategies).join(', ') })
  }
  return { id: 'strategy', title: 'strategy', rows }
}

/** @param {any} ctx @returns {any} */
function tuningSection(ctx) {
  const { state, source } = ctx
  const tuning = source.tuning ?? state.tuning ?? { metric: 0, samples: 0, applied: 0 }
  const samples = Array.isArray(tuning.samples) ? tuning.samples.length : Number(tuning.samples ?? 0)
  const applied = Array.isArray(tuning.history) ? tuning.history.length : Number(tuning.applied ?? 0)
  /** @type {any[]} */
  const rows = [
    { label: 'metric', value: Number(tuning.metric ?? 0).toFixed(3) },
    { label: 'samples', value: String(samples) },
    { label: 'applied', value: String(applied) },
  ]
  for (const [key, value] of Object.entries(state.params?.global ?? {})) {
    const spec = /** @type {any} */ (PARAM_ENVELOPE)[key]
    const isDefault = spec === undefined ? undefined : Number(spec.default) === Number(value)
    rows.push({
      label: shorten(key, 34),
      value: spec === undefined ? String(value) : `${value}${isDefault ? ' (default)' : ` (default ${spec.default})`}`,
      tone: isDefault === false ? 'accent' : 'dim',
    })
  }
  if (rows.length === 3) rows.push({ label: '(knobs)', value: 'all at their envelope defaults', tone: 'dim' })
  return { id: 'tuning', title: 'tuning', rows }
}

/** @param {any} ctx @returns {any} */
function journalSection(ctx) {
  const journal = stateJournal(ctx)
  /** @type {any[]} */
  const rows = [
    { label: 'segments', value: `live ${journal.live} · archives ${journal.archives} · checkpoints ${journal.checkpoints}` },
  ]
  if (journal.prunedThroughSeq > 0) rows.push({ label: 'pruned through', value: `#${journal.prunedThroughSeq}`, tone: 'warn' })
  const events = (ctx.source.events ?? []).slice(0, ctx.limits.events)
  for (const event of events) {
    rows.push({
      label: `#${event.seq ?? '?'}`,
      value: `${shorten(event.type ?? 'unknown', 30)} · ${humanAge(Number(event.ts), ctx.now)} ago`,
      tone: 'dim',
    })
  }
  return { id: 'journal', title: `journal · last ${events.length}`, rows }
}

/** @param {any} ctx @returns {any} */
function salienceSection(ctx) {
  const records = visibleRecords(ctx.state, ctx.opts)
  const scopeKey = typeof ctx.opts.salienceScope === 'string' ? ctx.opts.salienceScope : 'global'
  const ranked = records
    .map((record) => ({ record, salience: effectiveSalience(/** @type {any} */ (record), scopeKey) }))
    .sort((a, b) => b.salience - a.salience)
    .slice(0, ctx.limits.salience)
  const rows = ranked.map(({ record, salience }) => {
    const view = redactRecord(record, { level: ctx.redaction, includeBody: ctx.opts.includeBody === true, bodyChars: ctx.opts.bodyChars })
    return {
      label: shorten(view.label, 46),
      value: `${salience.toFixed(2)} ${record.kind}/${record.state}`,
      tone: record.state === 'locked' ? 'accent' : 'plain',
      // Empty string, never `undefined`: a model is JSON too, and the host
      // rejects an answer that does not survive a round trip (HANDOFF §10.18).
      note: view.bodyPreview === '' ? '' : shorten(view.bodyPreview, 60),
    }
  })
  if (rows.length === 0) rows.push({ label: '(no memories yet)', value: 'nothing to rank', tone: 'dim' })
  return { id: 'salience', title: `salience · top ${rows.length} (scope ${scopeKey})`, rows }
}

/** @param {any} ctx @returns {any} */
function vizSection(ctx) {
  const self = ctx.selfStatus ?? {}
  /** @type {any[]} */
  const rows = [
    { label: 'mode', value: String(self.mode ?? 'tool') },
    { label: 'renders', value: String(Number(self.renders ?? 0)) },
    { label: 'diagrams', value: String(Number(self.diagrams ?? 0)) },
    { label: 'last render', value: self.lastAt === null || self.lastAt === undefined ? 'never' : `${humanAge(Number(self.lastAt), ctx.now)} ago`, tone: 'dim' },
    { label: 'errors', value: String(Number(self.errors ?? 0)), tone: Number(self.errors ?? 0) > 0 ? 'bad' : 'ok' },
    { label: 'redaction', value: ctx.redaction, tone: ctx.redaction === 'none' ? 'warn' : 'ok' },
    { label: 'live TUI', value: String(self.mode ?? 'tool') === 'watch' ? 'Ctrl+C stops it · this process never writes to the store' : 'node tools/viz-watch.mjs --watch (separate read-only process)', tone: 'dim' },
  ]
  return { id: 'viz', title: 'viz', rows }
}

/** @param {any} ctx @returns {any} */
function stateJournal(ctx) {
  const journal = ctx.source.journal ?? {}
  return {
    live: Number(journal.live ?? 0),
    archives: Number(journal.archives ?? 0),
    checkpoints: Number(journal.checkpoints ?? 0),
    prunedThroughSeq: Number(journal.prunedThroughSeq ?? 0),
  }
}

// ── diagram builders ──────────────────────────────────────────────────────────

/**
 * A bounded, redacted view of the belief graph: the nodes are the top memories
 * by salience (or an explicit id list), the edges are `links`. Links that point
 * outside the window are kept and marked `exists: false` — a dangling reference
 * is exactly the kind of thing this picture is for.
 * @param {any} state
 * @param {any} opts
 * @param {any} limits
 * @param {string} redaction
 * @returns {{ nodes: any[], edges: any[], warnings: string[] }}
 */
function memoryGraph(state, opts, limits, redaction) {
  const warnings = []
  const records = visibleRecords(state, opts)
  const wanted = Array.isArray(opts.ids) && opts.ids.length > 0 ? new Set(opts.ids.map(String)) : null
  const ranked = records
    .map((record) => ({ record, salience: effectiveSalience(/** @type {any} */ (record), String(opts.salienceScope ?? 'global')) }))
    .sort((a, b) => b.salience - a.salience)
  const chosen = (wanted === null ? ranked : ranked.filter(({ record }) => wanted.has(String(record.id)))).slice(0, Math.max(1, limits.nodes))
  if (chosen.length < (wanted === null ? ranked.length : (opts.ids ?? []).length)) {
    warnings.push(`graph capped at ${limits.nodes} node(s)`)
  }
  const ids = new Set(chosen.map(({ record }) => String(record.id)))
  const nodes = chosen.map(({ record, salience }) => {
    const view = redactRecord(record, { level: redaction, includeBody: false })
    return { id: String(record.id), label: shorten(view.label, 60), kind: view.kind, state: view.state, salience: Number(salience.toFixed(3)) }
  })
  /** @type {any[]} */
  const edges = []
  for (const { record } of chosen) {
    for (const link of record.links ?? []) {
      const to = String(link?.to ?? '')
      if (to === '' || to === String(record.id)) continue
      edges.push({ from: String(record.id), to, rel: String(link?.rel ?? 'related'), exists: ids.has(to) ? true : state.memories?.[to] !== undefined })
    }
  }
  return { nodes, edges, warnings }
}

/**
 * Governance events, oldest first so the picture reads left-to-right.
 * @param {any[]} events
 * @param {any} limits
 * @returns {any[]}
 */
function strategyTimeline(events, limits) {
  return events
    .filter((event) => TIMELINE_TYPES.some((prefix) => String(event?.type ?? '') === prefix || String(event?.type ?? '').startsWith(prefix)))
    .slice(0, Math.max(1, limits.timeline))
    .map((event) => ({
      seq: Number(event.seq ?? 0),
      type: String(event.type ?? 'unknown'),
      at: Number(event.ts ?? 0),
      detail: shorten(timelineDetail(event), 48),
    }))
    .reverse()
}

/** @param {any} event @returns {string} */
function timelineDetail(event) {
  const payload = event?.payload ?? {}
  if (Array.isArray(payload.to)) return `→ ${payload.to.join(', ')}`
  if (typeof payload.to === 'string') return `→ ${payload.to} (${payload.reason ?? ''})`
  if (payload.param !== undefined) return `${payload.param} ${payload.from} → ${payload.to}`
  if (payload.objective !== undefined) return `${payload.objective} reward ${Number(payload.reward ?? 0).toFixed(3)}`
  if (payload.preset !== undefined) return `preset ${payload.preset} → ${(payload.stack ?? []).join(', ')}`
  if (payload.revertedType !== undefined) return `undo ${payload.revertedType} #${payload.revives}`
  if (payload.reason !== undefined) return String(payload.reason)
  return ''
}

/**
 * Observed lifecycle transitions, counted from the journal.
 *
 * Two sources, because the journal records two different amounts of truth:
 *   - `promote`/`demote` carry `payload.transitions = [{ id, from, to }]`, so
 *     those edges are exact;
 *   - `lock`, `expire` and the expiry sweep record only the destination (their
 *     payload has `ids`, not a `from`), so they are returned with `from: null`
 *     and an `op` label. The diagram draws them as entries into the state rather
 *     than inventing a source edge — guessing the `from` would turn a picture of
 *     the journal into a picture of someone's assumption.
 * @param {any[]} events
 * @param {any} limits
 * @returns {{ from: string|null, to: string, count: number, op?: string }[]}
 */
function lifecycleTransitions(events, limits) {
  /** @type {Map<string, { from: string|null, to: string, count: number, op?: string }>} */
  const counts = new Map()
  for (const event of events ?? []) {
    for (const row of event?.payload?.transitions ?? []) {
      const from = String(row?.from ?? 'unknown')
      const to = String(row?.to ?? 'unknown')
      const key = `${from}->${to}`
      const entry = counts.get(key) ?? { from, to, count: 0 }
      entry.count += 1
      counts.set(key, entry)
    }
    const reached = DESTINATION_ONLY[String(event?.type ?? '')]
    if (reached !== undefined) {
      const key = `->${reached}`
      const entry = counts.get(key) ?? { from: null, to: reached, count: 0, op: String(event.type) }
      entry.count += 1
      counts.set(key, entry)
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, Math.max(1, limits.timeline))
}