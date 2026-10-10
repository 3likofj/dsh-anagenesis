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
 *
 * **Language.** Labels come from `./lang.js` and default to `en`, which is the
 * historical output **word for word** — the window's Chinese layer keys on those
 * English labels (`window/src/render/10-i18n.js`), so the default must not move.
 * Terminal-facing callers (`ana_dashboard`, `ana_diagram`, `tools/viz-watch.mjs`)
 * pass `lang: 'zh'` and get a Chinese frame. The chosen language travels on
 * `model.render.lang` so a serializer never has to guess.
 * @module dsh-anagenesis/viz/model
 */

import { KINDS, STATES, LIVE_STATES, effectiveSalience, isLegacyUnscoped } from '../store/schema.js'
import { PARAM_ENVELOPE } from '../meta/tuner.js'
import { inScope } from '../memory/recall.js'
import {
  GLOBAL_NAMESPACE,
  createScopeFilter,
  namespaceCounts,
  parseNamespace,
  projectLabel,
  scopeLabel,
  scopeMatch,
  scopeRelation,
} from '../scope/index.js'
import { DEFAULT_REDACTION, redactRecord, redactionNote } from './redact.js'
import { terminalText } from './lang.js'

export const DASHBOARD_SECTIONS = Object.freeze([
  'overview', 'scope', 'lifecycle', 'kinds', 'strategy', 'tuning', 'journal', 'salience', 'viz',
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
 * @property {any} [scope] `service.scopeReport()`: where this caller stands
 *   (project fingerprint, namespace, default write tier) and every namespace the
 *   store physically holds. When it is present the model prefers it over
 *   re-deriving anything from `state.projects`.
 * @property {any} [permissions] `service.permissionReport()`: preset, gear and
 *   whether write tools are registered. A read-only mirror or the standalone
 *   watcher has no live service and passes nothing (or a `mirror: true`
 *   placeholder) — the gear row then says so instead of guessing.
 */

/**
 * @param {VizSource} source
 * @param {any} [opts] `lang: 'en' | 'zh'` (default `en`, see the module note)
 * @returns {any} a JSON-safe dashboard model
 */
export function buildDashboardModel(source, opts = {}) {
  const state = source.state ?? {}
  const limits = mergeLimits(opts.limit)
  const redaction = opts.redaction ?? DEFAULT_REDACTION
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const t = terminalText(opts.lang)
  const warnings = collectWarnings(source, opts, limits, t)
  const wanted = Array.isArray(opts.sections) && opts.sections.length > 0 ? opts.sections : DASHBOARD_SECTIONS
  const scopeView = buildScopeView(state, source, opts)
  const context = {
    state, source, opts, limits, redaction, now, warnings, t, scopeView,
    selfStatus: opts.selfStatus ?? source.selfStatus ?? {},
  }

  const builders = {
    overview: overviewSection,
    scope: scopeSection,
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
      warnings.push(t.warning.unknownSection(id))
      continue
    }
    sections.push(build(context))
  }

  return {
    kind: 'dashboard',
    title: t.title,
    generatedAt: now,
    origin: source.origin ?? 'live',
    store: storeFacts(state),
    scope: modelScope(scopeView),
    sections,
    warnings,
    limits: { events: limits.events, salience: limits.salience, nodes: limits.nodes },
    redaction: { level: redaction, note: redactionNote(redaction, opts) },
    render: { width: Number(opts.width ?? 96), color: String(opts.color ?? 'never'), lang: t.lang },
  }
}

/**
 * @param {VizSource} source
 * @param {any} [opts] `lang: 'en' | 'zh'` (default `en`, see the module note)
 * @returns {any} a JSON-safe diagram model
 */
export function buildDiagramModel(source, opts = {}) {
  const state = source.state ?? {}
  const kind = DIAGRAM_KINDS.includes(opts.kind) ? opts.kind : 'memory-graph'
  const limits = mergeLimits(opts.limit)
  const redaction = opts.redaction ?? DEFAULT_REDACTION
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const t = terminalText(opts.lang)
  const warnings = collectWarnings(source, opts, limits, t)
  const scopeView = buildScopeView(state, source, opts)
  const records = visibleRecords(state, scopeView.opts)

  const base = {
    kind,
    title: `anagenesis ${kind}`,
    generatedAt: now,
    origin: source.origin ?? 'live',
    store: storeFacts(state),
    scope: modelScope(scopeView),
    nodes: [],
    edges: [],
    timeline: [],
    transitions: [],
    totals: {
      byState: countBy(records, (record) => record.state),
      byKind: countBy(records, (record) => record.kind),
      byEventType: countEventTypes(source.events ?? []),
      // Counts by *relation to this caller* (current-project / other-project /
      // global / current-session / …). With no caller context at all every
      // project record reads as `other-project` — `model.scope.current.known`
      // says whether the relation was computed against a real caller.
      byScope: countBy(records, (record) => relationOf(record, scopeView.context)),
    },
    warnings,
    limits: { nodes: limits.nodes, timeline: limits.timeline },
    redaction: { level: redaction, note: redactionNote(redaction, opts) },
    render: { lang: t.lang },
  }

  if (kind === 'memory-graph') {
    const graph = memoryGraph(state, scopeView.opts, limits, redaction, t, scopeView.context)
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
 * Records visible to a caller.
 *
 * Three mutually exclusive shapes, in this order:
 *   1. `opts.scopeContext = { projectId, sessionId, allProjects }` — the closed
 *      set the caller can actually recall (`scopeMatch`): current project,
 *      global, current session, and — only when `allProjects` is explicitly
 *      true — other projects, still marked as foreign. Session-scoped records
 *      stay inside their session even then: another session's working state is
 *      not "another project's experience" and no switch makes it visible.
 *   2. `opts.scope` (the legacy `{ session, workspace, preset }` object) — the
 *      pre-isolation contract, kept for callers that still pass it. It can only
 *      narrow the set further, never widen it.
 *   3. Neither — the whole store. This is the operator's own view (the file
 *      mirror and the standalone watcher have no caller to scope by), and it is
 *      what every pre-scope caller of this function already got.
 * @param {any} state
 * @param {any} opts
 * @returns {any[]}
 */
export function visibleRecords(state, opts = {}) {
  const records = Object.values(state.memories ?? {})
  const context = opts?.scopeContext
  const legacy = opts?.scope
  let out = records
  if (context !== undefined && context !== null) {
    const filter = createScopeFilter({
      projectId: context.projectId ?? null,
      sessionId: context.sessionId ?? null,
      crossProject: context.allProjects === true,
    })
    out = out.filter((record) => scopeMatch(/** @type {any} */ (record), filter).ok)
  }
  if (legacy !== undefined && legacy !== null) {
    out = out.filter((record) => inScope(/** @type {any} */ (record), { scope: legacy }))
  }
  return out
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

// ── scope projection ─────────────────────────────────────────────────────────
//
// Scope isolation only means something if it is *visible*: which project this
// view stands in, which namespaces the store holds, and which of those records
// the agent could actually recall. Everything below is a pure projection of
// `state` + the caller's `scopeContext` + (when the live service supplied them)
// `source.scope` / `source.permissions`. Nothing here writes, and nothing here
// guesses: an unknowable fact becomes `null`/`known: false`, never a plausible
// default.

/** @param {any} value @returns {string|null} */
function asId(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** @param {any} value @returns {boolean} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * `project:<id>` / `session:<id>` shortened exactly the way `scopeLabel`
 * shortens a record's scope, so a graph node and a namespace row name the same
 * namespace the same way. Full ids stay in `model.scope`, where they are data
 * rather than display.
 * @param {string} namespace
 * @returns {string}
 */
function shortNamespace(namespace) {
  const value = String(namespace ?? '')
  if (value === '' || value === GLOBAL_NAMESPACE) return value
  const parsed = parseNamespace(value)
  if (parsed.tier === 'session') return scopeLabel({ tier: 'session', session: parsed.key })
  if (parsed.tier === 'project') return scopeLabel({ tier: 'project', projectId: parsed.key })
  return value
}

/**
 * One record's position relative to this caller.
 * @param {any} record
 * @param {{ projectId: string|null, sessionId: string|null }} context
 * @returns {string}
 */
function relationOf(record, context) {
  return scopeRelation(record, {
    projectId: context?.projectId ?? null,
    sessionId: context?.sessionId ?? null,
  })
}

/**
 * The tone a serializer should paint a relation with.
 *
 * `accent` = this is mine (current project / current session) or it is global
 * and meant for everyone; `warn` = not mine to trust blindly (another project,
 * an un-scoped legacy record, another session); `dim` = unknowable, because
 * there is no caller context to compare against. That last case matters: with
 * no context `scopeRelation` calls every project `other-project`, and painting
 * the operator's own store yellow would assert something the model cannot know.
 * @param {string} relation
 * @param {boolean} known
 * @returns {string}
 */
function scopeTone(relation, known) {
  if (relation === 'global') return 'accent'
  if (relation === 'unscoped') return 'warn'
  if (known !== true) return 'dim'
  if (relation === 'current-project' || relation === 'current-session') return 'accent'
  return 'warn'
}

/** Project namespaces sort before global, global before sessions. */
const NAMESPACE_TIER_RANK = Object.freeze({ project: 0, global: 1, session: 2 })

/** @param {any} a @param {any} b @returns {number} */
function compareNamespaces(a, b) {
  if (a.current !== b.current) return a.current ? -1 : 1
  const rank = (NAMESPACE_TIER_RANK[a.tier] ?? 3) - (NAMESPACE_TIER_RANK[b.tier] ?? 3)
  if (rank !== 0) return rank
  if (a.count !== b.count) return b.count - a.count
  return a.namespace.localeCompare(b.namespace)
}

/**
 * @param {any} entry
 * @param {any} context
 * @param {string|null} currentNamespace
 * @returns {string}
 */
function namespaceTone(entry, context, currentNamespace) {
  if (currentNamespace !== null && entry.namespace === currentNamespace) return 'accent'
  if (entry.tier === 'global') return 'plain'
  if (entry.tier === 'session') {
    return context.sessionId !== null && entry.key === context.sessionId ? 'accent' : 'dim'
  }
  // Another project. With no caller context this is not a judgment the model can
  // make, so it makes none (see `scopeTone`).
  return context.known === true ? 'warn' : 'plain'
}

/**
 * Normalize whatever the caller said about permissions. `mirror: true` is the
 * file mirror's placeholder (`{ gear: 'none', presetActive: false, mirror: true }`):
 * it exists so the row renders as "unknowable" instead of crashing — the file
 * genuinely cannot report the gear of a live process.
 * @param {any} source
 * @returns {{ available: boolean, mirror: boolean, gear: string|null, gearLabel: string|null,
 *   preset: string|null, presetActive: boolean, write: boolean }}
 */
function permissionView(source) {
  const report = isPlainObject(source?.permissions) ? source.permissions : null
  if (report === null) {
    return { available: false, mirror: false, gear: null, gearLabel: null, preset: null, presetActive: false, write: false }
  }
  const gear = asId(report.gear) ?? 'none'
  const preset = asId(report.preset)
  return {
    available: true,
    mirror: report.mirror === true,
    gear,
    gearLabel: asId(report.gearLabel) ?? gear,
    preset,
    presetActive: report.presetActive === true && preset !== null,
    write: report.writeToolsAvailable === true,
  }
}

/**
 * Where this projection stands, and what the store around it looks like.
 *
 * Precedence, deliberately: an explicit `opts.scopeContext` is the caller's own
 * statement about where it is; a `source.scope` report (`service.scopeReport()`)
 * is the next best thing and wins over re-deriving from `state.projects`; with
 * neither, the model still describes the store but refuses to name a current
 * project (`current.known === false`). Records are filtered by the same
 * precedence — with no context at all they are not filtered, which is the
 * operator's own whole-store view.
 * @param {any} state
 * @param {any} source
 * @param {any} opts
 * @returns {any}
 */
function buildScopeView(state, source, opts) {
  const report = isPlainObject(source?.scope) ? source.scope : null
  const asked = isPlainObject(opts?.scopeContext) ? opts.scopeContext : null
  const reported = isPlainObject(report?.current) ? report.current : null

  const askedProject = asked === null ? null : asId(asked.projectId)
  const reportedProject = reported === null ? null : asId(reported.projectId)
  const projectId = asked !== null ? askedProject : reportedProject
  const sessionId = asked !== null
    ? asId(asked.sessionId)
    : (reported === null ? null : asId(reported.session))
  const known = projectId !== null
  const allProjects = asked !== null && asked.allProjects === true
  const context = { projectId, sessionId, known, allProjects }

  const effective = { ...opts }
  if (asked === null && known) {
    effective.scopeContext = { projectId, sessionId, allProjects }
  }

  /** @type {any} */
  const current = { known: false, projectId: null, label: '', namespace: null, tier: null, basis: null, session: null }
  if (reported !== null && reportedProject !== null) {
    // The scope report is the service's own answer for *this* call, so it
    // describes the caller better than anything re-derived from the store.
    current.known = true
    current.projectId = reportedProject
    current.label = String(reported.projectLabel ?? projectLabel(state, reportedProject))
    current.namespace = String(reported.namespace ?? scopeLabel({ tier: 'project', projectId: reportedProject }))
    current.tier = asId(reported.tier)
    current.basis = reported.basis === 'remote' ? 'remote' : reported.basis === 'path' ? 'path' : null
    current.session = asId(reported.session) ?? sessionId
  } else if (known) {
    current.known = true
    current.projectId = projectId
    current.label = projectLabel(state, projectId)
    current.namespace = scopeLabel({ tier: 'project', projectId })
    current.session = sessionId
  }
  const currentNamespace = current.known === true ? String(current.namespace) : null

  const counts = namespaceCounts(state)
  /** @type {Map<string, number>} */
  const totals = new Map()
  for (const [namespace, count] of Object.entries(counts.byNamespace)) totals.set(namespace, Number(count) || 0)
  const reportedNamespaces = isPlainObject(report?.namespaces) ? report.namespaces : null
  if (reportedNamespaces !== null) {
    for (const [namespace, info] of Object.entries(reportedNamespaces)) {
      const value = Number(info?.count)
      totals.set(namespace, Number.isFinite(value) && value >= 0 ? value : (totals.get(namespace) ?? 0))
    }
  }
  /** @type {any[]} */
  const namespaces = []
  for (const [namespace, count] of totals) {
    const parsed = parseNamespace(namespace)
    const info = reportedNamespaces === null ? null : reportedNamespaces[namespace]
    const label = parsed.tier === 'project' ? String(info?.label ?? projectLabel(state, parsed.key)) : ''
    namespaces.push({ namespace, label, count, tier: parsed.tier, key: parsed.key, current: namespace === currentNamespace, tone: 'plain' })
  }
  for (const entry of namespaces) entry.tone = namespaceTone(entry, context, currentNamespace)
  namespaces.sort(compareNamespaces)

  const visible = visibleRecords(state, effective)
  const otherProjects = new Set()
  for (const entry of namespaces) {
    if (entry.tier !== 'project') continue
    if (known && entry.key === projectId) continue
    otherProjects.add(entry.key)
  }
  const legacy = Object.values(state.memories ?? {}).filter((record) => isLegacyUnscoped(/** @type {any} */ (record))).length
  const global = visible.filter((record) => relationOf(record, context) === 'global').length
  const defaultTier = report === null ? null : asId(report.defaultScopeTier)

  return {
    context,
    opts: effective,
    report,
    current,
    namespaces,
    counts: { visible: visible.length, legacy, global, otherProjects: otherProjects.size },
    defaultTier,
    permissions: permissionView(source),
  }
}

/**
 * The `model.scope` block: JSON-safe, no `undefined`, identifiers exact.
 *
 * The bases differ on purpose, because the questions differ:
 *   - `count`         records visible under this context (what this render shows);
 *   - `otherProjects` distinct projects that hold memories anywhere in the store
 *                     and are not the current one — the hidden ones included,
 *                     which is the point of the number (with no caller context it
 *                     counts every project, since none of them can be called
 *                     "current");
 *   - `global`        visible records in the global namespace;
 *   - `legacy`        records still un-tagged by the scope migration (store-wide;
 *                     they are global, so they are visible either way).
 * @param {any} view
 * @returns {any}
 */
function modelScope(view) {
  return {
    current: { ...view.current },
    count: view.counts.visible,
    otherProjects: view.counts.otherProjects,
    global: view.counts.global,
    legacy: view.counts.legacy,
  }
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
 * @param {typeof import('./lang.js').terminalText extends (lang: any) => infer R ? R : never} t
 * @returns {string[]}
 */
function collectWarnings(source, opts, limits, t) {
  const warnings = []
  if ((source.origin ?? 'live') === 'mirror') {
    warnings.push(t.warning.mirror)
  }
  if ((opts.redaction ?? DEFAULT_REDACTION) === 'none') {
    warnings.push(t.warning.redactionNone)
  }
  const eventCount = (source.events ?? []).length
  if (eventCount > limits.events && eventCount > 0) {
    warnings.push(t.warning.journalWindow(limits.events, eventCount))
  }
  // Widening the view past what the caller can actually recall is a decision the
  // reader has to see, not a silent default: everything below is one store, but
  // only part of it is this agent's experience.
  if (opts?.scopeContext !== undefined && opts.scopeContext !== null && opts.scopeContext.allProjects === true) {
    warnings.push(t.warning.allProjects)
  }
  return warnings
}

// ── dashboard sections ────────────────────────────────────────────────────────

/** @param {any} ctx @returns {any} */
function overviewSection(ctx) {
  const { state, source, t } = ctx
  /** @type {any[]} */
  const rows = [
    { label: t.label.store, value: t.value.storeVersion(state.version ?? 0, state.schemaVersion ?? 0) },
    { label: t.label.memories, value: t.value.memoryCount(Object.keys(state.memories ?? {}).length, totalLive(state)), tone: 'accent' },
    { label: t.label.safeMode, value: state.safeMode === true ? t.value.safeOn : t.value.safeOff, tone: state.safeMode === true ? 'warn' : 'ok' },
    { label: t.label.origin, value: t.value.origin(source.origin ?? 'live') },
  ]
  const journal = stateJournal(ctx)
  rows.splice(3, 0, { label: t.label.journal, value: t.value.journalCounters(journal) })
  if (journal.prunedThroughSeq > 0) {
    rows.push({ label: t.label.pruned, value: t.value.pruned(journal.prunedThroughSeq), tone: 'warn' })
  }
  return { id: 'overview', title: t.section.overview, rows }
}

/**
 * The scope section: where this view stands, which namespaces the store holds,
 * where writes land, which gear is in force, and how much of the store is still
 * un-tagged legacy. It answers the one question a memory dashboard has to answer
 * honestly — *whose* memories am I looking at.
 * @param {any} ctx
 * @returns {any}
 */
function scopeSection(ctx) {
  const { t, scopeView } = ctx
  const current = scopeView.current
  /** @type {any[]} */
  const rows = []
  if (current.known !== true) {
    rows.push({ label: t.label.currentProject, value: t.value.scopeUnknown, tone: 'dim' })
  } else {
    const basis = current.basis === 'remote'
      ? t.value.basisRepo
      : current.basis === 'path' ? t.value.basisPath : t.value.basisUnknown
    rows.push({
      label: t.label.currentProject,
      value: t.value.currentProject(current.label, shortNamespace(current.namespace ?? current.projectId), basis),
      tone: 'accent',
    })
  }
  for (const entry of scopeView.namespaces) {
    rows.push({
      // A namespace id is a machine identifier (like a journal event type), not
      // interface copy: it is shown verbatim so it can be matched against the
      // scope report and the journal segments.
      label: shortNamespace(entry.namespace),
      value: t.value.namespace(entry.label, entry.count),
      tone: entry.tone,
    })
  }
  rows.push({
    label: t.label.defaultTier,
    value: scopeView.defaultTier === null ? t.value.tierUnknown : t.value.defaultTier(scopeView.defaultTier),
    tone: scopeView.defaultTier === null ? 'dim' : 'plain',
  })
  rows.push(gearRow(scopeView.permissions, t))
  rows.push({
    label: t.label.legacy,
    value: scopeView.counts.legacy === 0 ? t.value.legacyNone : t.value.legacyCount(scopeView.counts.legacy),
    tone: scopeView.counts.legacy > 0 ? 'warn' : 'dim',
  })
  return { id: 'scope', title: t.section.scope, rows }
}

/**
 * The gear row. Three states, and the difference matters: a live report (gear +
 * whether write tools are registered), the mirror's placeholder (unknowable —
 * the file cannot see a live process's gear), and nothing at all (the standalone
 * watcher). The last two render `dim` and say why instead of implying "none".
 * @param {any} permissions
 * @param {any} t
 * @returns {any}
 */
function gearRow(permissions, t) {
  if (permissions.available !== true) {
    return { label: t.label.gear, value: t.value.gearUnavailable, tone: 'dim' }
  }
  if (permissions.mirror === true) {
    return { label: t.label.gear, value: t.value.gearMirror(permissions.gear), tone: 'dim' }
  }
  return {
    label: t.label.gear,
    value: t.value.gear(permissions.gear, permissions.write),
    tone: permissions.gear === 'none' ? 'warn' : 'ok',
    note: permissions.presetActive ? t.value.presetActive(permissions.preset ?? 'anagenesis') : t.value.presetInactive,
  }
}

/** @param {any} ctx @returns {any} */
function lifecycleSection(ctx) {
  const { t } = ctx
  const records = visibleRecords(ctx.state, ctx.opts)
  const counts = countBy(records, (record) => record.state)
  const total = records.length
  const rows = STATES.map((state) => {
    const count = counts[state] ?? 0
    return {
      label: t.state(state),
      value: total > 0 ? t.value.ratio(count, Math.round((count / total) * 100)) : String(count),
      bar: total > 0 ? count / total : 0,
      tone: count === 0 ? 'dim' : LIVE_STATES.includes(state) ? 'accent' : 'warn',
    }
  })
  return { id: 'lifecycle', title: t.section.lifecycle(total), rows }
}

/** @param {any} ctx @returns {any} */
function kindsSection(ctx) {
  const { t } = ctx
  const records = visibleRecords(ctx.state, ctx.opts)
  const counts = countBy(records, (record) => record.kind)
  const max = Math.max(1, ...Object.values(counts))
  const rows = KINDS.map((kind) => {
    const count = counts[kind] ?? 0
    return { label: t.kind(kind), value: String(count), bar: count / max, tone: count === 0 ? 'dim' : 'plain' }
  })
  return { id: 'kinds', title: t.section.kinds, rows }
}

/** @param {any} ctx @returns {any} */
function strategySection(ctx) {
  const { state, source, t } = ctx
  /** @type {any[]} */
  const rows = []
  for (const scope of Object.keys(state.stacks ?? {}).sort(scopeOrder)) {
    rows.push({
      label: scope === 'global' ? t.label.global : shorten(scope, 28),
      value: (state.stacks[scope] ?? []).join(' → ') || t.value.empty,
      tone: scope === 'global' ? 'accent' : 'plain',
    })
  }
  if (Array.isArray(source.engine?.active)) {
    rows.push({ label: t.label.active, value: source.engine.active.join(' → ') || t.value.none, tone: 'ok' })
    const quarantined = (source.engine.health ?? []).filter((row) => row?.quarantined)
    rows.push({
      label: t.label.health,
      value: quarantined.length === 0 ? t.value.healthOk : t.value.healthQuarantined(quarantined.map((row) => row.strategy).join(', ')),
      tone: quarantined.length === 0 ? 'ok' : 'bad',
    })
  } else {
    rows.push({ label: t.label.health, value: t.value.healthMirror, tone: 'dim' })
  }
  if (Object.keys(state.strategies ?? {}).length > 0) {
    rows.push({ label: t.label.registered, value: Object.keys(state.strategies).join(', ') })
  }
  return { id: 'strategy', title: t.section.strategy, rows }
}

/** @param {any} ctx @returns {any} */
function tuningSection(ctx) {
  const { state, source, t } = ctx
  const tuning = source.tuning ?? state.tuning ?? { metric: 0, samples: 0, applied: 0 }
  const samples = Array.isArray(tuning.samples) ? tuning.samples.length : Number(tuning.samples ?? 0)
  const applied = Array.isArray(tuning.history) ? tuning.history.length : Number(tuning.applied ?? 0)
  /** @type {any[]} */
  const rows = [
    { label: t.label.metric, value: Number(tuning.metric ?? 0).toFixed(3) },
    { label: t.label.samples, value: String(samples) },
    { label: t.label.applied, value: String(applied) },
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
  if (rows.length === 3) rows.push({ label: t.label.knobs, value: t.value.envelopeDefaults, tone: 'dim' })
  return { id: 'tuning', title: t.section.tuning, rows }
}

/** @param {any} ctx @returns {any} */
function journalSection(ctx) {
  const { t } = ctx
  const journal = stateJournal(ctx)
  /** @type {any[]} */
  const rows = [
    { label: t.label.segments, value: t.value.journalCounters(journal) },
  ]
  if (journal.prunedThroughSeq > 0) rows.push({ label: t.label.prunedThrough, value: `#${journal.prunedThroughSeq}`, tone: 'warn' })
  const events = (ctx.source.events ?? []).slice(0, ctx.limits.events)
  for (const event of events) {
    rows.push({
      label: `#${event.seq ?? '?'}`,
      value: `${shorten(event.type ?? 'unknown', 30)} · ${t.value.age(humanAge(Number(event.ts), ctx.now))}`,
      tone: 'dim',
    })
  }
  return { id: 'journal', title: t.section.journal(events.length), rows }
}

/** @param {any} ctx @returns {any} */
function salienceSection(ctx) {
  const { t } = ctx
  const records = visibleRecords(ctx.state, ctx.opts)
  const scopeKey = typeof ctx.opts.salienceScope === 'string' ? ctx.opts.salienceScope : 'global'
  const ranked = records
    .map((record) => ({ record, salience: effectiveSalience(/** @type {any} */ (record), scopeKey) }))
    .sort((a, b) => b.salience - a.salience)
    .slice(0, ctx.limits.salience)
  const rows = ranked.map(({ record, salience }) => {
    const view = redactRecord(record, { level: ctx.redaction, includeBody: ctx.opts.includeBody === true, bodyChars: ctx.opts.bodyChars })
    // Where a memory came from is part of how much it is worth to *this* caller,
    // so the scope travels with the row. The row's `value` already carries
    // `score kind/state` and the window parses it positionally, so the scope is
    // only appended there when there is no note to carry it instead.
    const scope = scopeLabel(record.scope)
    const note = view.bodyPreview === '' ? '' : `${shorten(view.bodyPreview, 60)} · ${scope}`
    const value = t.value.salience(salience.toFixed(2), t.kind(record.kind), t.state(record.state))
    return {
      label: shorten(view.label, 46),
      value: note === '' ? `${value} · ${scope}` : value,
      tone: record.state === 'locked' ? 'accent' : 'plain',
      // Empty string, never `undefined`: a model is JSON too, and the host
      // rejects an answer that does not survive a round trip (HANDOFF §10.18).
      note,
    }
  })
  if (rows.length === 0) rows.push({ label: t.label.noMemories, value: t.value.nothingToRank, tone: 'dim' })
  return { id: 'salience', title: t.section.salience(rows.length, scopeKey), rows }
}

/** @param {any} ctx @returns {any} */
function vizSection(ctx) {
  const { t } = ctx
  const self = ctx.selfStatus ?? {}
  /** @type {any[]} */
  const rows = [
    { label: t.label.mode, value: String(self.mode ?? 'tool') },
    { label: t.label.renders, value: String(Number(self.renders ?? 0)) },
    { label: t.label.diagrams, value: String(Number(self.diagrams ?? 0)) },
    { label: t.label.lastRender, value: self.lastAt === null || self.lastAt === undefined ? t.value.never : t.value.age(humanAge(Number(self.lastAt), ctx.now)), tone: 'dim' },
    { label: t.label.errors, value: String(Number(self.errors ?? 0)), tone: Number(self.errors ?? 0) > 0 ? 'bad' : 'ok' },
    { label: t.label.redaction, value: ctx.redaction, tone: ctx.redaction === 'none' ? 'warn' : 'ok' },
    { label: t.label.liveTui, value: String(self.mode ?? 'tool') === 'watch' ? t.value.liveTuiWatch : t.value.liveTuiTool, tone: 'dim' },
  ]
  return { id: 'viz', title: t.section.viz, rows }
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
 *
 * Every node also carries where it came from: `scope` (short label), `relation`
 * to this caller and a `tone` a serializer can paint it with, so a graph that
 * mixes projects says so instead of looking like one homogeneous memory.
 * @param {any} state
 * @param {any} opts
 * @param {any} limits
 * @param {string} redaction
 * @param {any} t the language table from `./lang.js`
 * @param {{ projectId: string|null, sessionId: string|null, known: boolean }} context
 * @returns {{ nodes: any[], edges: any[], warnings: string[] }}
 */
function memoryGraph(state, opts, limits, redaction, t, context) {
  const warnings = []
  const records = visibleRecords(state, opts)
  const wanted = Array.isArray(opts.ids) && opts.ids.length > 0 ? new Set(opts.ids.map(String)) : null
  const ranked = records
    .map((record) => ({ record, salience: effectiveSalience(/** @type {any} */ (record), String(opts.salienceScope ?? 'global')) }))
    .sort((a, b) => b.salience - a.salience)
  const chosen = (wanted === null ? ranked : ranked.filter(({ record }) => wanted.has(String(record.id)))).slice(0, Math.max(1, limits.nodes))
  if (chosen.length < (wanted === null ? ranked.length : (opts.ids ?? []).length)) {
    warnings.push(t.warning.graphCapped(limits.nodes))
  }
  const ids = new Set(chosen.map(({ record }) => String(record.id)))
  const nodes = chosen.map(({ record, salience }) => {
    const view = redactRecord(record, { level: redaction, includeBody: false })
    const relation = relationOf(record, context)
    return {
      id: String(record.id),
      label: shorten(view.label, 60),
      kind: view.kind,
      state: view.state,
      salience: Number(salience.toFixed(3)),
      scope: scopeLabel(record.scope),
      relation,
      tone: scopeTone(relation, context.known === true),
    }
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
