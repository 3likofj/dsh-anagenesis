/**
 * Memory schema, lifecycle transition table and schema migrations.
 *
 * The persisted state is a plain JSON document; `SCHEMA_VERSION` is bumped for
 * every breaking change and `migrateState()` is a pure, idempotent chain, so an
 * old journal or snapshot always loads forward into the current shape.
 * @module dsh-anagenesis/store/schema
 */

import { clamp, ulid } from '../util.js'
import { fingerprintProject, namespaceOf, normalizeTier, scopeTag } from '../scope/project.js'

export const SCHEMA_VERSION = 7

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
 * @param {{ tier?: string, projectId?: string|null, workspace?: string|null, profile?: string|null,
 *   origin?: string, sessionTtlMs?: number|null }} [env.defaultScope]
 *   The scope a write lands in when the caller did not name one. The service passes
 *   `{ tier: 'project', projectId: <current fingerprint> }`, so "no explicit scope"
 *   now means "this project" instead of "everyone".
 * @returns {MemoryRecord}
 */
export function createMemory(spec, env) {
  const now = env.now
  const kind = KINDS.includes(spec.kind) ? spec.kind : 'fact'
  const state = STATES.includes(spec.state) ? spec.state : 'draft'
  const confidence = clamp(spec.confidence ?? 0.5, 0, 1)
  const ttlMs = spec.ttlMs ?? null
  const text = `${spec.subject ?? ''}\n${spec.body ?? ''}`
  const scope = resolveScope(spec.scope, env)
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
    scope,
    provenance: {
      source: spec.provenance?.source ?? 'agent',
      author: spec.provenance?.author ?? null,
      taskId: spec.provenance?.taskId ?? null,
      evidence: (spec.provenance?.evidence ?? []).slice(0, 32),
      derivedFrom: (spec.provenance?.derivedFrom ?? []).slice(0, 32),
    },
    createdAt: now,
    updatedAt: now,
    // Session memories are the one tier that is *supposed* to die: a temporary
    // task's working notes must not outlive the task. A TTL is attached at write
    // time unless the caller set one, and the ordinary expiry sweep enforces it —
    // so "session scope disappears" is the same revertible transaction as any
    // other expiry, not a special cleanup path.
    expiresAt: ttlMs !== null ? now + Math.max(0, ttlMs)
      : scope.tier === 'session' && Number(env.defaultScope?.sessionTtlMs ?? 0) > 0
        ? now + Number(env.defaultScope?.sessionTtlMs)
        : null,
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
 * The single place a record's scope tag is produced.
 *
 * 写入路径**只**通过这里生成标签，所以"每条记忆都必须带 scope 与 project_id"是
 * 结构性的：没有办法写出一条没有 tier 的记录。旧字段（`global` / `workspace` /
 * `preset`）继续与 `tier` 保持同步，因为窗口侧与旧工具仍在读它们。
 * @param {any} spec
 * @param {any} env
 * @returns {{ tier: string, projectId: string|null, session: string|null, workspace: string|null,
 *   preset: string|null, profile: string|null, global: boolean, origin: string }}
 */
function resolveScope(spec, env) {
  const explicit = spec ?? {}
  const fallback = env.defaultScope ?? { tier: 'global', origin: 'legacy-default' }
  const asked = explicit.tier !== undefined || explicit.projectId !== undefined
    ? { tier: explicit.tier, projectId: explicit.projectId, origin: 'explicit' }
    : {}
  return scopeTag({
    tier: explicit.tier ?? fallback.tier,
    projectId: explicit.projectId ?? explicit.project_id ?? fallback.projectId ?? null,
    // `session` is the shape a *record's* scope carries; `sessionId` is the shape
    // the service's `writeScope()` returns. Both are accepted because dropping
    // either one silently degrades a session-scoped write into a project one —
    // and the caller would only notice by reading the scope tag afterwards.
    sessionId: explicit.session ?? explicit.sessionId ?? env.sessionId ?? null,
    presetId: explicit.preset ?? env.presetId ?? null,
    workspace: explicit.workspace ?? fallback.workspace ?? null,
    profile: explicit.profile ?? fallback.profile ?? null,
    origin: asked.origin ?? fallback.origin ?? 'default',
  })
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
 * @property {{ tier: 'global'|'project'|'session'|'unscoped', projectId: string|null,
 *   session: string|null, workspace: string|null, preset: string|null, profile: string|null,
 *   global: boolean, origin: string }} scope
 *   `tier` is the authority; `global`/`workspace`/`preset` are kept in sync for
 *   readers that predate scope isolation. `origin` records *how* the tier was
 *   decided (`explicit` / `default` / `migrated-workspace` / `legacy-default`),
 *   which is what lets recall down-weight records that were written before
 *   isolation existed instead of pretending they were always tagged.
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
 * @property {Record<string, { id: string, kind: 'repo'|'path', root: string, remote: string,
 *   label: string, firstSeenAt: number, lastSeenAt: number }>} projects
 *   Known project fingerprints. This exists so a human (and the visualization
 *   layer) can tell "another project" apart by name instead of by hash, and so
 *   `ana_scope action=list` can offer the ids that `crossProject: true` may be
 *   authorized against. Registration is a normal, invertible `projectSet` patch.
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
    projects: {},
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
  const steps = { 1: v1ToV2, 2: v2ToV3, 3: v3ToV4, 4: v4ToV5, 5: v5ToV6, 6: v6ToV7 }
  let guard = 0
  while (state.schemaVersion < SCHEMA_VERSION && guard++ < 16) {
    const step = steps[state.schemaVersion]
    if (step === undefined) break
    state = step(state, now)
  }
  state.schemaVersion = SCHEMA_VERSION
  // Records can also arrive *without* a scope tag through journal replay: a store
  // that never flushed a snapshot (replay-only boot) rebuilds records from
  // pre-upgrade events, and the document-level chain above would then never see
  // them. One cheap pass repairs those in place — and only when there is
  // something to repair, so the common path pays for one property check per
  // record and nothing else.
  if (hasUntaggedRecords(state)) state = repairRecordScopes(state, now)
  return state
}

/**
 * @param {any} state
 * @returns {boolean}
 */
export function hasUntaggedRecords(state) {
  for (const record of Object.values(state?.memories ?? {})) {
    if (typeof (/** @type {any} */ (record))?.scope?.tier !== 'string') return true
  }
  return false
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
    projects: raw.projects ?? {},
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
 * v6 → v7: **every record gets an explicit scope**.
 *
 * 这一版回答的是"这条记忆属于谁"。旧记录没有 `tier`，而旧写入路径的默认值是
 * `scope.global = true` —— 也就是说，除了少数显式限定了 workspace 的记录，
 * 历史上写的每一条都被当成全局记忆。迁移不能凭空发明归属，但也不必假装它们
 * 一直如此：
 *
 *   - 带 `workspace` 的记录 → 按那个路径算项目指纹，归入**正确的项目**
 *     （同一台机器上，那个路径当时就是那个项目，这是可复核的事实）；
 *   - 其余 `global: true` 的记录 → `tier: 'global'` + `origin: 'migrated-global'`。
 *     它们继续可召回（不丢数据），但召回打分按"迁移遗留"显著降权，并在注入块里
 *     逐条标注 —— 因为"当时默认写成全局"不等于"这条经验真的跨项目通用"。
 *   - 带 `session` 的记录 → 会话级。
 *
 * 迁移是纯函数、幂等，并且**不删除任何东西**：唯一的变化是加上一层标签，
 * 而标签本身随着记录一起进日志，因此 `revert(seq)` 一样能把它撤回去。
 * @param {any} state
 * @param {number} now
 */
function v6ToV7(state, now) {
  return { ...repairRecordScopes(state, now), schemaVersion: 7 }
}

/**
 * 给所有缺 `tier` 的记录补上作用域标签。`migrateState` 在迁移链之后也会调用它，
 * 用来接住"只有日志、没有快照"的重放路径。
 * @param {any} state
 * @param {number} now
 * @returns {any}
 */
export function repairRecordScopes(state, now = Date.now()) {
  /** @type {Map<string, any>} */
  const byWorkspace = new Map()
  /** @type {Record<string, any>} */
  const projects = { ...(state.projects ?? {}) }
  const memories = { ...(state.memories ?? {}) }
  let repaired = 0
  for (const [id, raw] of Object.entries(memories)) {
    const record = /** @type {any} */ (raw)
    if (typeof record?.scope?.tier === 'string') continue
    const scope = migrateRecordScope(record, byWorkspace, projects, now)
    memories[id] = { ...record, scope, schemaVersion: SCHEMA_VERSION }
    repaired += 1
  }
  if (repaired === 0) return state
  return { ...state, memories, projects }
}

/**
 * @param {any} record
 * @param {Map<string, any>} cache
 * @param {Record<string, any>} projects
 * @param {number} now
 * @returns {any}
 */
function migrateRecordScope(record, cache, projects, now) {
  const legacy = record?.scope ?? {}
  if (typeof legacy.session === 'string' && legacy.session !== '') {
    return scopeTag({ tier: 'session', sessionId: legacy.session, presetId: legacy.preset, workspace: legacy.workspace, origin: 'migrated-session' })
  }
  if (typeof legacy.workspace === 'string' && legacy.workspace.trim() !== '') {
    let identity = cache.get(legacy.workspace)
    if (identity === undefined) {
      identity = fingerprintProject({ cwd: legacy.workspace })
      cache.set(legacy.workspace, identity)
      projects[identity.id] ??= {
        id: identity.id,
        kind: identity.kind,
        root: identity.root,
        remote: identity.remote,
        label: identity.label,
        firstSeenAt: Number(record.createdAt) || now,
        lastSeenAt: now,
      }
    }
    return scopeTag({
      tier: 'project',
      projectId: identity.id,
      presetId: legacy.preset,
      workspace: identity.root,
      origin: 'migrated-workspace',
    })
  }
  return scopeTag({ tier: 'global', presetId: legacy.preset, origin: 'migrated-global' })
}

/**
 * 一条记录落在哪个命名空间（日志分段、可视化分组、`ana_scope` 都用它）。
 * @param {any} record
 * @returns {string}
 */
export function recordNamespace(record) {
  return namespaceOf(record?.scope ?? {})
}

/**
 * 这条记录是否写于作用域隔离之前。`origin` 是唯一判据 —— 猜内容是不诚实的，
 * 而"迁移时它没有归属信息"是有记录的。
 * @param {any} record
 * @returns {boolean}
 */
export function isLegacyUnscoped(record) {
  const scope = record?.scope
  if (scope?.tier !== 'global') return false
  return scope.origin === 'migrated-global' || scope.origin === 'legacy-default'
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
