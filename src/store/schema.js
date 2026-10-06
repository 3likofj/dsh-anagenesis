/**
 * Memory schema, lifecycle transition table and schema migrations.
 *
 * The persisted state is a plain JSON document; `SCHEMA_VERSION` is bumped for
 * every breaking change and `migrateState()` is a pure, idempotent chain, so an
 * old journal or snapshot always loads forward into the current shape.
 * @module dsh-anagenesis/store/schema
 */

import { clamp, ulid } from '../util.js'

export const SCHEMA_VERSION = 6

/**
 * Which vector backend produced the stored embeddings.
 *
 * This lives in state on purpose: swapping backends without re-embedding would
 * compare vectors from two different spaces, and `cosine` cannot tell that apart
 * from "unrelated" — it would just quietly rank nonsense. Keeping the id lets
 * `status()` report "stale" instead. The literal mirrors `EMBED_DIM` in
 * `memory/embed.js`, kept literal so the store layer does not depend on the
 * memory layer.
 */
export const DEFAULT_EMBED = Object.freeze({ id: 'hash', dim: 192 })

/** @typedef {'fact'|'preference'|'procedure'|'heuristic'|'episode'|'hypothesis'|'constraint'|'failure'} MemoryKind */

export const KINDS = /** @type {MemoryKind[]} */ (Object.freeze([
  'fact', 'preference', 'procedure', 'heuristic', 'episode', 'hypothesis', 'constraint', 'failure',
]))

/**
 * Lifecycle states. `draft` is deliberately cheap (explore mode writes here),
 * `verified`/`locked` are the only states exploit mode injects, and `retired`
 * is terminal — nothing leaves it, which is what makes `forget` auditable.
 */
export const STATES = Object.freeze([
  'draft', 'active', 'verified', 'locked', 'deprecated', 'expired', 'retired',
])

/** @type {Record<string, string[]>} */
export const TRANSITIONS = Object.freeze({
  draft: ['active', 'deprecated', 'retired'],
  active: ['verified', 'deprecated', 'expired', 'locked', 'retired'],
  verified: ['locked', 'deprecated', 'expired', 'retired'],
  locked: ['deprecated', 'retired'],
  deprecated: ['active', 'expired', 'retired'],
  expired: ['active', 'retired'],
  retired: [],
})

/** Transitions that leave `locked` and therefore require an explicit `force`. */
export const FORCE_TRANSITIONS = Object.freeze(new Set(['locked->deprecated', 'locked->retired']))

/** Minimum confidence that admits a record into each state. */
export const CONFIDENCE_FLOOR = Object.freeze({
  draft: 0, active: 0.4, verified: 0.7, locked: 0.9, deprecated: 0, expired: 0, retired: 0,
})

/** States that are candidates for injection by default. */
export const LIVE_STATES = Object.freeze(['draft', 'active', 'verified', 'locked'])

/**
 * @param {string} from
 * @param {string} to
 * @param {{ force?: boolean }} [opts]
 * @returns {{ ok: boolean, reason?: string }}
 */
export function canTransition(from, to, opts = {}) {
  if (!STATES.includes(from) || !STATES.includes(to)) {
    return { ok: false, reason: `unknown lifecycle state: ${from} -> ${to}` }
  }
  if (from === to) return { ok: false, reason: `already ${to}` }
  if (!TRANSITIONS[from]?.includes(to)) {
    return { ok: false, reason: `illegal transition ${from} -> ${to}` }
  }
  if (FORCE_TRANSITIONS.has(`${from}->${to}`) && opts.force !== true) {
    return { ok: false, reason: `${from} is locked; pass force: true with a reason to leave it` }
  }
  return { ok: true }
}

/**
 * @param {{
 *   id?: string, kind?: MemoryKind, subject?: string, body?: string, gist?: string,
 *   tags?: string[], links?: {rel?: string, to: string}[], state?: string,
 *   confidence?: number, salience?: number,
 *   scope?: {global?: boolean, session?: string|null, workspace?: string|null, preset?: string|null},
 *   provenance?: {source?: string, author?: string|null, taskId?: string|null, evidence?: string[], derivedFrom?: string[]},
 *   ttlMs?: number|null, supersedes?: string[], supersededBy?: string|null, parentId?: string|null,
 * }} spec
 * @param {object} env
 * @param {number} env.now
 * @param {(text: string) => number[]} env.embed
 * @param {string} [env.sessionId]
 * @param {string} [env.presetId]
 * @returns {MemoryRecord}
 */
export function createMemory(spec, env) {
  const now = env.now
  const kind = KINDS.includes(spec.kind) ? spec.kind : 'fact'
  const state = STATES.includes(spec.state) ? spec.state : 'draft'
  const confidence = clamp(spec.confidence ?? 0.5, 0, 1)
  const ttlMs = spec.ttlMs ?? null
  const text = `${spec.subject ?? ''}\n${spec.body ?? ''}`
  return {
    id: spec.id ?? ulid('mem', { time: now }),
    kind,
    subject: String(spec.subject ?? '').slice(0, 400),
    body: String(spec.body ?? '').slice(0, 20000),
    gist: String(spec.gist ?? spec.subject ?? spec.body ?? '').slice(0, 400),
    tags: [...new Set((spec.tags ?? []).map((t) => String(t).slice(0, 64)))].slice(0, 32),
    links: (spec.links ?? []).slice(0, 64).map((l) => ({
      rel: String(l.rel ?? 'related'),
      to: String(l.to),
    })),
    state,
    confidence,
    salience: clamp(spec.salience ?? 0.5, 0, 1),
    scope: {
      global: spec.scope?.global ?? true,
      session: spec.scope?.session ?? env.sessionId ?? null,
      workspace: spec.scope?.workspace ?? null,
      preset: spec.scope?.preset ?? env.presetId ?? null,
    },
    provenance: {
      source: spec.provenance?.source ?? 'agent',
      author: spec.provenance?.author ?? null,
      taskId: spec.provenance?.taskId ?? null,
      evidence: (spec.provenance?.evidence ?? []).slice(0, 32),
      derivedFrom: (spec.provenance?.derivedFrom ?? []).slice(0, 32),
    },
    createdAt: now,
    updatedAt: now,
    expiresAt: ttlMs === null ? null : now + Math.max(0, ttlMs),
    supersedes: (spec.supersedes ?? []).slice(0, 32),
    supersededBy: spec.supersededBy ?? null,
    parentId: spec.parentId ?? null,
    access: { count: 0, hits: 0, misses: 0, lastAt: null },
    // Salience is partitioned per caller scope: a shared store serves several
    // agents, and one agent citing a memory must not inflate another agent's
    // ranking. `salience` stays the write-time default a fresh scope inherits.
    salienceByScope: {},
    embedding: env.embed(text).slice(),
    schemaVersion: SCHEMA_VERSION,
  }
}

/**
 * @typedef {object} MemoryRecord
 * @property {string} id
 * @property {MemoryKind} kind
 * @property {string} subject
 * @property {string} body
 * @property {string} gist
 * @property {string[]} tags
 * @property {{ rel: string, to: string }[]} links
 * @property {string} state
 * @property {number} confidence
 * @property {number} salience
 * @property {Record<string, number>} salienceByScope per-caller-scope salience;
 *   a scope with no entry inherits the global `salience` (see `effectiveSalience`)
 * @property {{ global: boolean, session: string|null, workspace: string|null, preset: string|null }} scope
 * @property {{ source: string, author: string|null, taskId: string|null, evidence: string[], derivedFrom: string[] }} provenance
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number|null} expiresAt
 * @property {string[]} supersedes
 * @property {string|null} supersededBy
 * @property {string|null} parentId
 * @property {{ count: number, hits: number, misses: number, lastAt: number|null }} access
 * @property {number[]} embedding
 * @property {number} schemaVersion
 */

/**
 * @typedef {object} AnagenesisState
 * @property {number} schemaVersion
 * @property {number} version
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {Record<string, MemoryRecord>} memories
 * @property {Record<string, any>} strategies
 * @property {Record<string, string[]>} stacks
 * @property {Record<string, Record<string, number|string|boolean>>} params
 * @property {Array<{ id: string, at: number, type: string, detail: unknown }>} audit
 * @property {{ commits: number, recalls: number, writes: number, reverts: number, hookFailures: number }} stats
 *   Lifetime counters, each incremented by the operation that owns it, inside
 *   the same transaction it counts — so the numbers can never drift from the
 *   journal. `commits` = every transaction, `reverts` = every compensating
 *   transaction, `recalls` = every `service.recall()` call (selected or not),
 *   `writes` = every accepted `ops.remember()` commit (lifecycle transitions
 *   such as promote/lock are not writes; they are recorded by `commits`).
 * @property {{ id: string, dim: number }} embed which vector backend produced the stored embeddings
 * @property {{ samples: number[], arms: Record<string, { pulls: number, reward: number }>, history: { metric: number, at: number, auditId: string }[] }} tuning
 *   The tuner's learning state. It lives in `state` because it *is* state:
 *   feedback is the meta layer's only ground truth, so losing it on restart (it
 *   used to live in private fields) made "the tuner learns" true only within one
 *   process — and made `revert` of a feedback event unable to roll it back.
 */

/**
 * @returns {{ samples: number[], arms: Record<string, { pulls: number, reward: number }>, history: any[] }}
 */
export function defaultTuning() {
  return { samples: [], arms: {}, history: [] }
}

/**
 * Coerce anything that claims to be tuning state into the real shape. Used by
 * the migration chain, by `applyPatch`, and by the tuner when it hydrates — one
 * owner for the shape, so a corrupt field degrades to an empty window instead of
 * crashing the meta layer.
 * @param {any} raw
 * @returns {{ samples: number[], arms: Record<string, { pulls: number, reward: number }>, history: any[] }}
 */
export function normalizeTuning(raw) {
  if (raw === null || typeof raw !== 'object') return defaultTuning()
  /** @type {Record<string, { pulls: number, reward: number }>} */
  const arms = {}
  for (const [armId, arm] of Object.entries(raw.arms ?? {})) {
    arms[armId] = { pulls: Number(/** @type {any} */ (arm)?.pulls) || 0, reward: Number(/** @type {any} */ (arm)?.reward) || 0 }
  }
  return {
    samples: Array.isArray(raw.samples) ? raw.samples.filter((value) => Number.isFinite(value)).slice(-200) : [],
    arms,
    history: Array.isArray(raw.history) ? raw.history.slice(-100) : [],
  }
}

/**
 * @param {number} now
 * @returns {AnagenesisState}
 */
export function emptyState(now = Date.now()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    version: 0,
    createdAt: now,
    updatedAt: now,
    memories: {},
    strategies: {},
    stacks: { global: ['guard', 'exploit'] },
    params: { global: {} },
    audit: [],
    stats: { commits: 0, recalls: 0, writes: 0, reverts: 0, hookFailures: 0 },
    embed: { ...DEFAULT_EMBED },
    tuning: defaultTuning(),
  }
}

export const AUDIT_CAP = 4000

/**
 * Pure migration chain. Each step takes a document of version N and returns
 * version N+1; unknown/older shapes are coerced rather than rejected so a
 * corrupt snapshot degrades into a smaller store instead of a dead plugin.
 * @param {any} raw
 * @param {number} now
 * @returns {AnagenesisState}
 */
export function migrateState(raw, now = Date.now()) {
  let state = normalizeRoot(raw, now)
  /** @type {Record<number, (s: any, now: number) => any>} */
  const steps = { 1: v1ToV2, 2: v2ToV3, 3: v3ToV4, 4: v4ToV5, 5: v5ToV6 }
  let guard = 0
  while (state.schemaVersion < SCHEMA_VERSION && guard++ < 16) {
    const step = steps[state.schemaVersion]
    if (step === undefined) break
    state = step(state, now)
  }
  state.schemaVersion = SCHEMA_VERSION
  return state
}

/**
 * @param {any} raw
 * @param {number} now
 * @returns {any}
 */
function normalizeRoot(raw, now) {
  if (raw === null || typeof raw !== 'object') return emptyState(now)
  const base = emptyState(now)
  const version = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 1
  return {
    ...base,
    ...raw,
    schemaVersion: version,
    memories: raw.memories ?? {},
    audit: Array.isArray(raw.audit) ? raw.audit.slice(-AUDIT_CAP) : [],
    stats: { ...base.stats, ...(raw.stats ?? {}) },
    tuning: normalizeTuning(raw.tuning),
  }
}

/** v1: `{ records: [{ id, text, kind, ts, status, confidence }] }` → v2 memories map. */
function v1ToV2(state, now) {
  const memories = {}
  for (const row of state.records ?? []) {
    if (row === null || typeof row !== 'object' || typeof row.id !== 'string') continue
    const ts = Number(row.ts) || now
    memories[row.id] = {
      id: row.id,
      kind: KINDS.includes(row.kind) ? row.kind : 'fact',
      subject: String(row.subject ?? row.text ?? '').slice(0, 400),
      body: String(row.text ?? row.body ?? '').slice(0, 20000),
      gist: String(row.gist ?? row.text ?? '').slice(0, 400),
      tags: Array.isArray(row.tags) ? row.tags.map(String).slice(0, 32) : [],
      links: [],
      state: row.status === 'archived' ? 'deprecated' : 'active',
      confidence: clamp(row.confidence ?? 0.5, 0, 1),
      salience: 0.5,
      scope: { global: true, session: null, workspace: null, preset: null },
      provenance: { source: 'import', author: null, taskId: null, evidence: [], derivedFrom: [] },
      createdAt: ts,
      updatedAt: ts,
      expiresAt: null,
      supersedes: [],
      supersededBy: null,
      parentId: null,
      access: { count: 0, hits: 0, misses: 0, lastAt: null },
      salienceByScope: {},
      embedding: [],
      schemaVersion: 2,
    }
  }
  return { ...state, schemaVersion: 2, memories, records: undefined }
}

/** v2: records lacked embeddings/access counters and kept meta params under `meta`. */
function v2ToV3(state) {
  for (const record of Object.values(state.memories ?? {})) {
    // The cast lives in a variable on purpose: writing
    // `(record).access ??= {...}` and starting the next line with `(record)`
    // makes ASI parse `{...}(record)` as a *call* of the object literal, which
    // threw "{} is not a function" for every v2 document that had records.
    const row = /** @type {any} */ (record)
    row.embedding ??= []
    row.access ??= { count: 0, hits: 0, misses: 0, lastAt: null }
    row.schemaVersion = 3
  }
  // `normalizeRoot` always fills `params` from `emptyState`, so the original
  // `state.params ?? state.meta.params` never fired and a v2 store's tuned
  // parameters were silently dropped on upgrade. Merge the legacy namespace in
  // *under* whatever the document already carries, so the newer shape wins.
  /** @type {Record<string, Record<string, any>>} */
  const params = {}
  for (const [scope, values] of Object.entries(state.meta?.params ?? {})) params[scope] = { ...values }
  for (const [scope, values] of Object.entries(state.params ?? {})) params[scope] = { ...(params[scope] ?? {}), ...values }
  if (Object.keys(params).length === 0) params.global = {}
  return { ...state, schemaVersion: 3, params, meta: undefined }
}

/** v3: salience became per-caller-scope; the old field stays as the default. */
function v3ToV4(state) {
  for (const record of Object.values(state.memories ?? {})) {
    const row = /** @type {any} */ (record)
    row.salienceByScope ??= {}
    row.schemaVersion = 4
  }
  return { ...state, schemaVersion: 4 }
}

/**
 * v4: the store records which vector backend produced its embeddings. Every
 * pre-v5 vector came from the built-in hashing vectorizer — nothing else could
 * have written one — so that is what the stamp has to say; claiming otherwise
 * would make `status()` report a backend the vectors never saw.
 */
function v4ToV5(state) {
  return { ...state, schemaVersion: 5, embed: state.embed ?? { ...DEFAULT_EMBED } }
}

/**
 * v5: the tuner's learning state moved into `state` (it used to be private
 * fields, so every restart silently reset the sample window and the UCB1 arms —
 * and `revert` of a feedback event had nothing to roll back). A v5 document has
 * no such field by definition, so it comes up empty rather than undefined.
 */
function v5ToV6(state) {
  return { ...state, schemaVersion: 6, tuning: normalizeTuning(state.tuning) }
}

/**
 * Salience as *this* scope has experienced the record.
 *
 * One store can serve several agents (the bundle row mounts the service
 * globally, and sessions add their own scopes). Salience is feedback, and
 * feedback only means something to the agent that produced it: one agent citing
 * a record must not re-rank another agent's recall. So a scope with its own
 * history reads its own number, while a scope that has never cited the record
 * inherits the write-time default — which keeps a fresh agent useful from its
 * very first turn instead of starting every memory at zero.
 * @param {any} record
 * @param {string} [scope]
 * @returns {number}
 */
export function effectiveSalience(record, scope = 'global') {
  const scoped = record?.salienceByScope?.[scope]
  if (typeof scoped === 'number') return scoped
  return typeof record?.salience === 'number' ? record.salience : 0.5
}
