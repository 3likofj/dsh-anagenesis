/**
 * MemoryStore — the single writer.
 *
 * Concurrency model, stated once and enforced everywhere:
 *   - ONE async mutex serializes every mutation (the `transact` path);
 *   - readers never take a lock: they read the current frozen snapshot;
 *   - a transaction = validate against the pre-state -> build a declarative
 *     patch -> append the event to the journal -> swap in a new frozen state;
 *   - every transaction returns `revert()`, a compensating transaction built
 *     from `invertPatch(preState, patch)`.
 * There is no unjournaled write path: `applyState()` exists only for journal
 * replay and is private.
 * @module dsh-anagenesis/store/store
 */

import { join } from 'node:path'
import { Mutex, atomicWriteFile, debounce, nowMs, readJsonSync } from '../util.js'
import { Journal } from './journal.js'
import { applyPatch, invertPatch, isEmptyPatch, mergePatches, touchedMemoryIds } from './patch.js'
import { SCHEMA_VERSION, emptyState, migrateState, recordNamespace } from './schema.js'
import { GLOBAL_NAMESPACE } from '../scope/project.js'
import { embed as defaultEmbed } from '../memory/embed.js'

const SNAPSHOT_FILE = 'snapshot.json'

/**
 * rootDir -> { refs, store, promise }. See `MemoryStore.acquire`.
 * @type {Map<string, { refs: number, store: MemoryStore|undefined, promise: Promise<any>|undefined }>}
 */
const POOL = new Map()

/** @typedef {{ dispose: () => void }} Subscription */

export class MemoryStore {
  /** @type {import('./schema.js').AnagenesisState} */
  #state
  /** @type {Journal} */
  #journal
  /** @type {Mutex} */
  #mutex = new Mutex()
  /** @type {string} */
  #rootDir
  /** @type {(text: string) => number[]} */
  #embed
  /** @type {{ info: Function, warn: Function, debug?: Function }} */
  #logger
  /** @type {Map<number, object>} */
  #events = new Map()
  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map()
  /** @type {((ctx: any) => void)[]} pre-commit invariants (guard layer) */
  #validators = []
  /** @type {ReturnType<typeof debounce>} */
  #persist
  /** @type {boolean} */
  #closed = false
  #clock

  /**
   * @param {object} opts
   * @param {string} opts.rootDir
   * @param {Journal} opts.journal
   * @param {import('./schema.js').AnagenesisState} opts.state
   * @param {(text: string) => number[]} [opts.embed]
   * @param {{ info: Function, warn: Function }} [opts.logger]
   * @param {{ now: () => number, debounceMs?: number }} [opts.clock]
   */
  constructor(opts) {
    this.#rootDir = opts.rootDir
    this.#journal = opts.journal
    this.#state = opts.state
    this.#embed = opts.embed ?? ((text) => defaultEmbed(text))
    this.#logger = opts.logger ?? { info: () => {}, warn: () => {} }
    const now = opts.clock?.now ?? nowMs
    this.#clock = now
    // The debounced persist is fire-and-forget: a failure here (a removed
    // directory, a full disk) must degrade to "the snapshot is stale" and never
    // surface as an unhandled rejection in the host process.
    this.#persist = debounce(() => {
      void this.flush().catch((error) => {
        this.#logger.warn(`anagenesis: snapshot write failed, journal is still authoritative: ${asMessage(error)}`)
      })
    }, opts.clock?.debounceMs ?? 250)
  }

  /**
   * Open or create a store: load the snapshot cache, then replay every journal
   * event newer than it. The journal always wins.
   * @param {object} opts
   * @param {string} opts.rootDir
   * @param {(text: string) => number[]} [opts.embed]
   * @param {{ info: Function, warn: Function }} [opts.logger]
   * @param {{ now: () => number, debounceMs?: number }} [opts.clock]
   * @returns {Promise<MemoryStore>}
   */
  static async open(opts) {
    const now = opts.clock?.now ?? nowMs
    const journal = await Journal.open({ dir: join(opts.rootDir, 'journal') })
    const snapshot = readJsonSync(join(opts.rootDir, SNAPSHOT_FILE), null)
    const loaded = snapshot?.state !== undefined
      ? migrateState(snapshot.state, now())
      : emptyState(now())
    const store = new MemoryStore({ ...opts, journal, state: loaded })
    await store.#replay()
    return store
  }

  /**
   * Acquire the single writer for a root directory, reference counted.
   *
   * Two rows can legitimately want the same store — the profile bundle mounts
   * `anagenesis-core` globally *and* the `anagenesis` preset mounts it inside the
   * preset scope. Two independent `MemoryStore` instances over one journal would
   * be two writers on one file, so the pool makes them share one instance; the
   * last `release()` closes it. Without this, a preset-scoped mount could
   * corrupt the global journal.
   * @param {object} opts see {@link MemoryStore.open}
   * @returns {Promise<{ store: MemoryStore, shared: boolean }>}
   */
  static async acquire(opts) {
    const key = String(opts.rootDir)
    const existing = POOL.get(key)
    if (existing !== undefined) {
      const entry = await existing.promise
      entry.refs += 1
      return { store: entry.store, shared: true }
    }
    /** @type {any} */
    const entry = { refs: 1, store: undefined, promise: undefined }
    entry.promise = MemoryStore.open(opts).then((store) => {
      entry.store = store
      return entry
    })
    POOL.set(key, entry)
    const ready = await entry.promise
    return { store: ready.store, shared: false }
  }

  /**
   * Drop one reference; the last holder flushes and closes.
   * @returns {Promise<boolean>} true when this call closed the store
   */
  async release() {
    const entry = POOL.get(this.#rootDir)
    if (entry === undefined) {
      await this.close()
      return true
    }
    entry.refs -= 1
    if (entry.refs > 0) return false
    POOL.delete(this.#rootDir)
    await this.close()
    return true
  }

  /** @returns {import('./schema.js').AnagenesisState} frozen snapshot */
  get state() {
    return this.#state
  }

  /** @returns {number} monotonic transaction counter, usable for optimistic checks */
  get version() {
    return this.#state.version
  }

  get rootDir() {
    return this.#rootDir
  }

  /**
   * Replay journal events after the snapshot's version.
   * @returns {Promise<void>}
   */
  async #replay() {
    // A compaction checkpoint freezes the state at its boundary; everything at or
    // below it lives in `archive-*.jsonl` without forward patches, so the
    // checkpoint — not an empty store — is where replay has to start.
    const checkpoint = await this.#journal.loadCheckpoint()
    if (checkpoint !== null && checkpoint.seq > this.#state.version) {
      const migrated = migrateState(checkpoint.state, this.#clock())
      this.#state = freezeState({ ...migrated, version: checkpoint.seq })
    }
    const events = await this.#journal.readAll()
    let state = this.#state
    let applied = 0
    let archived = 0
    for (const event of events) {
      if (typeof event.seq !== 'number') continue
      if (event.seq <= state.version) {
        // Already folded into the snapshot or the checkpoint. Still held in
        // memory because `ana_audit view=journal` must trace the seq and
        // `revert(seq)` needs the archived `undo` patch.
        this.#events.set(event.seq, event)
        if (event.archived === true) archived += 1
        continue
      }
      if (event.patch === undefined) {
        this.#events.set(event.seq, event)
        continue
      }
      state = applyPatch(state, event.patch)
      state = { ...state, version: event.seq, updatedAt: event.ts ?? state.updatedAt }
      this.#events.set(event.seq, event)
      applied += 1
    }
    this.#state = freezeState(state)
    if (applied > 0) this.#logger.info(`anagenesis: replayed ${applied} journal event(s)`)
    if (archived > 0) this.#logger.info(`anagenesis: checkpoint restored ${archived} archived event(s) for audit and revert`)
  }

  /**
   * The one mutation entry point.
   * @param {import('./patch.js').Patch|import('./patch.js').Patch[]} patch
   * @param {{ type: string, scope?: string, payload?: unknown, by?: string }} meta
   * @returns {Promise<{ seq: number, version: number, event: object, revert: (reason?: string) => Promise<any> }>}
   */
  async transact(patch, meta) {
    if (this.#closed) throw new Error('anagenesis: store is closed')
    const merged = Array.isArray(patch) ? mergePatches(...patch) : patch
    if (isEmptyPatch(merged)) throw new Error(`anagenesis: refusing empty transaction (${meta.type})`)
    return this.#mutex.runExclusive(async () => {
      const before = this.#state
      const seq = before.version + 1
      const ts = this.#clock()
      const withStats = mergePatches(merged, {
        stats: { commits: (before.stats?.commits ?? 0) + 1 },
      })
      // Records are frozen at the boundary: a reader that grabs a record from
      // the snapshot cannot mutate the store behind the writer's back.
      for (const [id, record] of Object.entries(withStats.memorySet ?? {})) {
        withStats.memorySet[id] = Object.freeze({ ...record, embedding: Object.freeze(record.embedding) })
      }
      const after = applyPatch(before, withStats)
      const undo = invertPatch(before, merged)
      // Guardrails run between building and journaling: a refused change leaves
      // no trace at all, which is what makes a violation non-negotiable.
      for (const validator of this.#validators) {
        validator({
          state: before,
          patch: withStats,
          meta,
          allowMassDelete: meta.allowMassDelete === true,
          allowMetaInSafeMode: meta.allowMetaInSafeMode === true,
          // Only a compensating transaction may remove a stack entry: the undo of a
          // scope creation is `stackSet: {scope: null}`, and without this flag the
          // `stack.guard-present` invariant refused it, which made every
          // scope-creating strategy switch irreversible (see `revert()` below).
          allowStackRemoval: meta.allowStackRemoval === true,
        })
      }
      const event = {
        seq,
        ts,
        type: meta.type,
        scope: meta.scope ?? 'global',
        // Which namespace's segment this event lands in. It is derived from the
        // records the transaction actually touches, so the physical layout
        // follows the data instead of the caller's claim — a write that says
        // "scope: global" while touching a project record cannot smuggle that
        // record into the global segment.
        ns: meta.ns ?? namespaceOfPatch(before, merged),
        by: meta.by ?? 'agent',
        payload: meta.payload ?? null,
        patch: withStats,
        undo,
        schemaVersion: SCHEMA_VERSION,
        touched: touchedMemoryIds(merged),
      }
      await this.#journal.append(event)
      this.#events.set(seq, event)
      this.#state = freezeState({ ...after, version: seq, updatedAt: ts })
      this.#persist.call()
      this.#dispatch(event)
      return {
        seq,
        version: seq,
        event,
        revert: (reason) => this.revert(seq, reason),
      }
    })
  }

  /**
   * Compensating transaction for a past commit. This is the inverse function
   * the spec asks for, and it works after a restart because the inverse patch
   * was journaled next to the forward patch.
   * @param {number} seq
   * @param {string} [reason]
   * @returns {Promise<{ seq: number, version: number, event: object, revert: (reason?: string) => Promise<any> }>}
   */
  async revert(seq, reason) {
    const event = this.#events.get(seq) ?? (await this.#journal.find(seq))
    if (event === undefined) {
      // A pruned seq must say so: "no journal event" would read like a typo in
      // the seq, when the truth is that the journal retention policy deleted it.
      const prunedThrough = this.#journal.prunedThroughSeq
      if (prunedThrough > 0 && seq <= prunedThrough) {
        throw new Error(`anagenesis: journal event #${seq} was pruned by the journal retention policy (every seq up to #${prunedThrough} was dropped); its inverse patch is no longer on disk`)
      }
      throw new Error(`anagenesis: no journal event #${seq} to revert`)
    }
    if (event.undo === undefined) throw new Error(`anagenesis: event #${seq} carries no inverse patch`)
    // An audit-only event (a recall record, a refusal, a feedback note) changed
    // nothing but `state.audit`, and `invertPatch` deliberately has no inverse for
    // an audit append: an audit row records that something *happened*. Reporting
    // success here used to write a `revert.applied` row plus a bumped counter
    // while the original row stayed put — a phantom rollback. Refusing is the
    // honest answer; the caller can still see the row and record a correction.
    if (isEmptyPatch(event.undo)) {
      throw new Error(`anagenesis: journal event #${seq} (${event.type}) only appended an audit row — audit entries are history, not state, so there is nothing to compensate`)
    }
    // One atomic compensation: the inverse patch plus its own audit row, so a
    // rollback is both the state change and its trace in a single journal event.
    return this.transact(mergePatches(event.undo, {
      stats: { reverts: (this.#state.stats?.reverts ?? 0) + 1 },
      auditAppend: [{
        id: `rev_${seq}`,
        at: this.#clock(),
        type: 'revert.applied',
        detail: { revives: seq, revertedType: event.type, reason: reason ?? null },
      }],
    }), {
      type: 'revert',
      scope: event.scope,
      by: 'agent',
      payload: { revives: seq, revertedType: event.type, reason: reason ?? null },
      // The inverse of a scope creation deletes that scope entry; it is only ever
      // produced here, so the permission lives on this path alone. A forward
      // transaction still cannot delete a live stack.
      allowStackRemoval: true,
    })
  }

  /**
   * Append an audit-only entry (no domain state change) — used for recalls,
   * rejections and strategy decisions that must be observable but are not
   * themselves memory writes.
   *
   * `opts.stats` folds the caller's own lifetime counter into the same
   * transaction. That is the pattern `revert()` already uses for
   * `stats.reverts`: the operation that knows what happened owns its counter,
   * instead of the store guessing from the event's type string.
   *
   * `opts.payload` puts a machine-readable summary on the *event* as well as the
   * human-readable detail on the audit row. Reactive consumers (the autonomy
   * policies are the first) see events, not audit rows, so without this they
   * would have to dig into `patch.auditAppend[0].detail` — a shape that is a
   * storage detail, not an interface.
   * @param {string} type
   * @param {unknown} detail
   * @param {{ scope?: string, by?: string, stats?: Record<string, number>, payload?: unknown }} [opts]
   * @returns {Promise<any>}
   */
  async audit(type, detail, opts = {}) {
    return this.transact({
      auditAppend: [{ id: `aud_${this.#state.version + 1}`, at: this.#clock(), type, detail }],
      ...(opts.stats === undefined ? {} : { stats: opts.stats }),
    }, { type: `audit:${type}`, scope: opts.scope ?? 'global', by: opts.by ?? 'agent', payload: opts.payload ?? null })
  }

  /**
   * Register a pre-commit validator. Returns its disposer; the guard layer is
   * the only intended user, which is why this is not exposed as an agent tool.
   * @param {(ctx: any) => void} validator
   * @returns {Subscription}
   */
  use(validator) {
    this.#validators.push(validator)
    return {
      dispose: () => {
        const index = this.#validators.indexOf(validator)
        if (index >= 0) this.#validators.splice(index, 1)
      },
    }
  }

  /**
   * @param {string} type
   * @param {(payload: any, event: object, state: import('./schema.js').AnagenesisState) => void} listener
   * @returns {Subscription}
   */
  on(type, listener) {
    const set = this.#listeners.get(type) ?? new Set()
    set.add(listener)
    this.#listeners.set(type, set)
    return { dispose: () => { set.delete(listener) } }
  }

  /**
   * @param {object} event
   */
  #dispatch(event) {
    for (const [type, listeners] of this.#listeners) {
      if (type !== '*' && type !== event.type) continue
      for (const listener of listeners) {
        try {
          listener(event.payload, event, this.#state)
        } catch (error) {
          this.#logger.warn(`anagenesis: state listener for ${type} failed: ${asMessage(error)}`)
        }
      }
    }
  }

  /**
   * Compact the journal: fold the live events into a new `archive-*.jsonl`
   * segment plus a `checkpoint-*.json`, then start a fresh segment.
   *
   * Lossless by default. Both things the journal owes survive: `undo` is in the
   * archive (`revert(seq)` keeps working for the oldest event) and the
   * checkpoint stands in for the dropped forward patches (a snapshot-less replay
   * still rebuilds the exact state). `opts.retain` adds the two layout bounds the
   * host can configure — `maxSegments` merges the oldest segments (nothing lost)
   * and `events` prunes segments outside the retained window (the one lossy
   * policy, off unless configured). Runs under the single writer so it can never
   * interleave with an append.
   * @param {{ minEvents?: number, retain?: { maxSegments?: number, events?: number } }} [opts]
   * @returns {Promise<object>}
   */
  async compact(opts = {}) {
    if (this.#closed) throw new Error('anagenesis: store is closed')
    const result = await this.#mutex.runExclusive(async () => {
      const outcome = await this.#journal.compact({
        state: this.#state,
        ts: this.#clock(),
        minEvents: opts.minEvents ?? 1,
        retain: opts.retain,
      })
      if (outcome.compacted === true) {
        // Rebuild the in-memory trace from what is actually on disk — same seq,
        // same `undo`, archived shape, no forward patch. Clearing first is what
        // makes a *pruned* seq stop being revertible right away instead of
        // surviving in memory until the next restart.
        this.#events.clear()
        for (const event of await this.#journal.readAll()) this.#events.set(event.seq, event)
        this.#logger.info(`anagenesis: compacted the journal — ${outcome.archived} event(s) archived up to #${outcome.boundary}`)
        // Refresh the cache so a restart replays from the checkpoint, not from
        // a snapshot older than the archive boundary.
        this.#persist.call()
      }
      return outcome
    })
    // Auditing is a transaction and `transact` takes this same mutex, so a prune
    // report can only be written after the compaction has released it. The
    // durable record is `pruned.json`; this row makes the loss visible in
    // `ana_audit view=audit` too, and a failure here must not fail the prune.
    if (result.compacted === true && (result.pruned?.segments ?? 0) > 0) {
      await this.audit('journal.prune', {
        segments: result.pruned.segments,
        events: result.pruned.events,
        throughSeq: result.pruned.throughSeq,
        cutoff: result.pruned.cutoff,
      }).catch((error) => {
        this.#logger.warn(`anagenesis: could not audit the journal prune: ${asMessage(error)}`)
      })
    }
    return result
  }

  /**
   * Persist the snapshot cache. Safe to call concurrently: writes go through a
   * temp file plus rename, and a lost race only costs a redundant replay.
   * @returns {Promise<void>}
   */
  async flush() {
    const payload = JSON.stringify({
      savedAt: this.#clock(),
      schemaVersion: SCHEMA_VERSION,
      state: this.#state,
    })
    await atomicWriteFile(join(this.#rootDir, SNAPSHOT_FILE), payload)
  }

  /** @returns {Promise<void>} */
  async close() {
    if (this.#closed) return
    // Cancel before flushing: a pending debounce would otherwise fire after the
    // caller has torn the directory down.
    this.#persist.cancel()
    this.#closed = true
    try {
      await this.flush()
    } catch (error) {
      this.#logger.warn(`anagenesis: final snapshot failed: ${asMessage(error)}`)
    }
    await this.#journal.close()
  }

  /**
   * @param {number} seq
   * @returns {object|undefined}
   */
  event(seq) {
    return this.#events.get(seq)
  }

  /**
   * Journal tail for `ana_audit`, newest first.
   * @param {{ limit?: number, type?: string, since?: number }} [opts]
   * @returns {object[]}
   */
  recentEvents(opts = {}) {
    const limit = Math.max(1, Math.min(opts.limit ?? 25, 500))
    const rows = [...this.#events.values()]
      .filter((event) => (opts.type === undefined || event.type === opts.type))
      .filter((event) => (opts.since === undefined || (event.ts ?? 0) >= opts.since))
      .sort((a, b) => b.seq - a.seq)
    return rows.slice(0, limit)
  }

  /** @returns {{ id: string, at: number, type: string, detail: unknown }[]} */
  auditTrail(limit = 25) {
    return this.#state.audit.slice(-Math.max(1, Math.min(limit, 500))).reverse()
  }

  /**
   * Journal layout + retention marker for `ana_audit view=status`. Synchronous
   * by design: `status()` is not async, and these counters are cached in memory.
   * @returns {{ live: number, archives: number, checkpoints: number, prunedThroughSeq: number, pruned: object }}
   */
  journalStats() {
    return { ...this.#journal.stats(), pruned: this.#journal.pruneMarker() }
  }
}

/**
 * Freeze the outer state plus the collections a reader could otherwise mutate
 * by reference. Records are frozen on write, so this stays O(collections)
 * rather than O(records).
 * @param {import('./schema.js').AnagenesisState} state
 * @returns {import('./schema.js').AnagenesisState}
 */
function freezeState(state) {
  return Object.freeze({
    ...state,
    memories: Object.freeze(state.memories),
    projects: Object.freeze({ ...(state.projects ?? {}) }),
    strategies: Object.freeze(state.strategies),
    stacks: Object.freeze(Object.fromEntries(
      Object.entries(state.stacks).map(([scope, ids]) => [scope, Object.freeze([...ids])]),
    )),
    params: Object.freeze(Object.fromEntries(
      Object.entries(state.params).map(([scope, values]) => [scope, Object.freeze({ ...values })]),
    )),
    stats: Object.freeze(state.stats),
    // The tuner hydrates from these, so the arms have to be frozen too — and the
    // tuner must copy them out rather than mutate a shared state object (it does:
    // see the hydration in meta/tuner.js).
    tuning: Object.freeze({
      samples: Object.freeze([...(state.tuning?.samples ?? [])]),
      arms: Object.freeze(Object.fromEntries(
        Object.entries(state.tuning?.arms ?? {}).map(([armId, arm]) => [armId, Object.freeze({ ...arm })]),
      )),
      history: Object.freeze([...(state.tuning?.history ?? [])]),
    }),
  })
}

/**
 * Which namespace segment a transaction belongs to.
 *
 * The rule is "follow the data, not the claim": the namespace is read off the
 * records the patch touches (the post-record when there is one, otherwise the
 * pre-record), so a transaction cannot name one namespace while moving another
 * namespace's bytes. A transaction that genuinely spans namespaces — a revert of
 * a mixed patch, a promote batch the agent assembled from two projects — is
 * filed under `mixed` rather than being silently attributed to whichever record
 * came first.
 * @param {import('./schema.js').AnagenesisState} state
 * @param {import('./patch.js').Patch} patch
 * @returns {string}
 */
export function namespaceOfPatch(state, patch) {
  const ids = touchedMemoryIds(patch)
  let ns = null
  for (const id of ids) {
    const record = /** @type {any} */ (patch.memorySet ?? {})[id] ?? state.memories[id]
    if (record === undefined) continue
    const current = recordNamespace(record)
    if (ns === null) ns = current
    else if (ns !== current) return 'mixed'
  }
  // Audit-only, stack-only and param-only transactions belong to no project:
  // they are store-level facts, and the global segment is where those live.
  return ns ?? GLOBAL_NAMESPACE
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function asMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
