/**
 * Layer 1 — memory operation primitives (the semantic layer, not CRUD).
 *
 * Every operation is intent-shaped ("raise this to a belief I will trust",
 * "materialize the opposite of this premise") rather than record-shaped, and
 * every one of them:
 *   - validates against the pre-state under the store's single-writer lock,
 *   - writes through `store.transact` (journal first, then snapshot swap),
 *   - returns `revert()` — the compensating transaction derived from the
 *     pre-state — plus the journal seq for `ana_audit`.
 * @module dsh-anagenesis/memory/ops
 */

import { clamp, estimateTokens, hash32, nowMs, stableStringify, ulid } from '../util.js'
import { CONFIDENCE_FLOOR, createMemory, canTransition, effectiveSalience } from '../store/schema.js'
import { embed as defaultEmbed } from './embed.js'

/** Maximum records a single destructive call may touch (guardrail input). */
export const FORGET_BUDGET = 50

/**
 * @param {{ store: import('../store/store.js').MemoryStore, embed?: (t: string) => number[], clock?: () => number, logger?: any }} deps
 */
export function createMemoryOps(deps) {
  const store = deps.store
  const embed = deps.embed ?? ((text) => defaultEmbed(text))
  const now = deps.clock ?? nowMs

  /**
   * @param {{ id: string }} args
   * @returns {import('../store/schema.js').MemoryRecord}
   */
  function mustGet(id) {
    const record = store.state.memories[id]
    if (record === undefined) throw new Error(`anagenesis: unknown memory "${id}"`)
    return record
  }

  return {
    /** @type {(spec: any, opts?: { scope?: string, by?: string }) => Promise<any>} */
    async remember(spec, opts = {}) {
      const record = createMemory(spec, { now: now(), embed, sessionId: spec.scope?.session, presetId: spec.scope?.preset })
      // Idempotence guard: the same content at the same state is a no-op, so a
      // retrying agent does not flood the store with duplicates.
      const fingerprint = stableStringify({ k: record.kind, s: record.subject, b: record.body })
      for (const existing of Object.values(store.state.memories)) {
        if (existing.state === 'retired') continue
        if (stableStringify({ k: existing.kind, s: existing.subject, b: existing.body }) === fingerprint) {
          // No seq: this call wrote nothing, and the previous version returned
          // `store.state.version` — the seq of whatever transaction happened
          // last, so a caller reverting "its own write" undid someone else's.
          return { ok: true, id: existing.id, deduplicated: true }
        }
      }
      const result = await store.transact({
        memorySet: { [record.id]: record },
        // `stats.writes` counts successful memory commits, folded into the commit
        // itself so the counter cannot drift from the journal.
        stats: { writes: (store.state.stats?.writes ?? 0) + 1 },
      }, {
        type: 'memory.remember',
        scope: opts.scope ?? record.scope.session ?? 'global',
        by: opts.by ?? 'agent',
        payload: { id: record.id, kind: record.kind, state: record.state, gist: record.gist },
      })
      return { ok: true, id: record.id, seq: result.seq, record: store.state.memories[record.id], revert: result.revert }
    },

    /**
     * Raise lifecycle standing. All-or-nothing: a partially promoted batch would
     * leave the agent believing more than it verified.
     * @type {(args: { ids: string[], to: string, reason: string, evidence?: string[], force?: boolean }) => Promise<any>}
     */
    async promote({ ids, to, reason, evidence = [], force = false }) {
      return transitionBatch({ ids, to, reason, evidence, force, verb: 'promote', types: ['active', 'verified', 'locked'] })
    },

    /** @type {(args: { ids: string[], to: string, reason: string, force?: boolean }) => Promise<any>} */
    async demote({ ids, to, reason, force = false }) {
      return transitionBatch({ ids, to, reason, evidence: [], force, verb: 'demote', types: ['draft', 'deprecated', 'expired'] })
    },

    /**
     * Lock a belief against accidental decay. Locked records can only leave the
     * state with `force: true` plus a reason, and they are the only thing exploit
     * mode injects by default.
     * @type {(args: { ids: string[], reason: string, ttlMs?: number|null }) => Promise<any>}
     */
    async lock({ ids, reason, ttlMs = null }) {
      const ts = now()
      const patch = { memorySet: {} }
      for (const id of ids) {
        const record = mustGet(id)
        if (record.state === 'retired') throw new Error(`anagenesis: "${id}" is retired and cannot be locked`)
        patch.memorySet[id] = {
          ...record,
          state: 'locked',
          confidence: Math.max(record.confidence, CONFIDENCE_FLOOR.locked),
          expiresAt: ttlMs === null ? null : ts + Math.max(0, ttlMs),
          updatedAt: ts,
          provenance: { ...record.provenance, evidence: [...record.provenance.evidence, `locked: ${reason}`].slice(-32) },
        }
      }
      const result = await store.transact(patch, {
        type: 'memory.lock',
        scope: 'global',
        payload: { ids, reason, ttlMs },
      })
      return { ok: true, ids, seq: result.seq, revert: result.revert }
    },

    /**
     * Expire with optional grace: `graceMs > 0` pushes the expiry out instead of
     * retiring now, which is how "stop trusting this, but do not lose it yet"
     * is expressed without a second tool.
     * @type {(args: { ids: string[], reason: string, graceMs?: number }) => Promise<any>}
     */
    async expire({ ids, reason, graceMs = 0 }) {
      const ts = now()
      const patch = { memorySet: {} }
      for (const id of ids) {
        const record = mustGet(id)
        if (record.state === 'retired') continue
        patch.memorySet[id] = {
          ...record,
          state: 'expired',
          expiresAt: ts + Math.max(0, graceMs),
          updatedAt: ts,
          provenance: { ...record.provenance, evidence: [...record.provenance.evidence, `expired: ${reason}`].slice(-32) },
        }
      }
      if (Object.keys(patch.memorySet).length === 0) return { ok: true, ids: [], seq: store.state.version, noop: true }
      const result = await store.transact(patch, { type: 'memory.expire', scope: 'global', payload: { ids, reason, graceMs } })
      return { ok: true, ids, seq: result.seq, revert: result.revert }
    },

    /**
     * Split one memory into several narrower ones. The parent is retired in the
     * same transaction, and children carry `parentId`, so the lineage is
     * reconstructible without trusting the agent's summary. A reason is
     * mandatory: this is a structural change to a belief, and the invariant gate
     * refuses any destructive operation that cannot say why.
     * @type {(args: { id: string, into: any[], retireParent?: boolean, reason: string }) => Promise<any>}
     */
    async split({ id, into, retireParent = true, reason }) {
      const parent = mustGet(id)
      if (typeof reason !== 'string' || reason.trim().length < 3) {
        throw new Error('anagenesis: split requires a reason of at least 3 characters')
      }
      if (!Array.isArray(into) || into.length === 0) throw new Error('anagenesis: split needs at least one child')
      const ts = now()
      const children = into.map((child) => createMemory({
        ...child,
        kind: child.kind ?? parent.kind,
        tags: [...(child.tags ?? []), ...parent.tags].slice(0, 32),
        confidence: child.confidence ?? parent.confidence,
        state: child.state ?? 'draft',
        scope: child.scope ?? parent.scope,
        provenance: {
          source: 'agent',
          derivedFrom: [parent.id],
          evidence: child.provenance?.evidence ?? [],
          taskId: parent.provenance.taskId,
          author: null,
        },
        parentId: parent.id,
      }, { now: ts, embed }))
      const patch = { memorySet: {} }
      for (const child of children) patch.memorySet[child.id] = child
      patch.memorySet[parent.id] = {
        ...parent,
        state: retireParent ? 'deprecated' : parent.state,
        links: [
          ...parent.links,
          ...children.map((child) => ({ rel: 'split_into', to: child.id })),
        ].slice(-64),
        updatedAt: ts,
        provenance: { ...parent.provenance, evidence: [...parent.provenance.evidence, `split: ${reason}`].slice(-32) },
      }
      const result = await store.transact(patch, {
        type: 'memory.split',
        scope: parent.scope.session ?? 'global',
        payload: { id, reason, children: children.map((c) => c.id), retireParent },
      })
      return { ok: true, id, children: children.map((c) => c.id), seq: result.seq, revert: result.revert }
    },

    /**
     * Counterfactual re-reasoning. Assumes the opposite of `premise` and stores
     * that assumption as a first-class `hypothesis` challenger linked to every
     * affected record — the belief is questioned, never silently overwritten.
     * @type {(args: { premise: string, counterfactual: string, ids: string[], confidence?: number }) => Promise<any>}
     */
    async rethink({ premise, counterfactual, ids, confidence = 0.3 }) {
      if (!Array.isArray(ids) || ids.length === 0) throw new Error('anagenesis: rethink needs at least one affected memory id')
      const ts = now()
      const affected = ids.map(mustGet)
      const hypothesis = createMemory({
        kind: 'hypothesis',
        subject: `Counterfactual: ${premise}`,
        body: counterfactual,
        gist: `If not (${premise}) then...`,
        tags: ['counterfactual', ...affected.flatMap((r) => r.tags).slice(0, 8)],
        state: 'draft',
        confidence: clamp(confidence, 0, 0.5),
        salience: 0.7,
        links: affected.map((record) => ({ rel: 'counterfactual_of', to: record.id })),
        scope: affected[0].scope,
        provenance: { source: 'agent', evidence: [counterfactual], derivedFrom: affected.map((r) => r.id) },
      }, { now: ts, embed })
      const patch = { memorySet: { [hypothesis.id]: hypothesis } }
      for (const record of affected) {
        patch.memorySet[record.id] = {
          ...record,
          links: [...record.links, { rel: 'challenged_by', to: hypothesis.id }].slice(-64),
          updatedAt: ts,
        }
      }
      const result = await store.transact(patch, {
        type: 'memory.rethink',
        scope: affected[0].scope.session ?? 'global',
        payload: { premise, counterfactual, affected: affected.map((r) => r.id), hypothesis: hypothesis.id },
      })
      return { ok: true, hypothesisId: hypothesis.id, affected: affected.map((r) => r.id), seq: result.seq, revert: result.revert }
    },

    /**
     * Forget: real content deletion with an auditable tombstone. The journal
     * still holds the pre-image, so `revert()` restores the body exactly — the
     * agent gets a genuine delete without losing the ability to undo it.
     * @type {(args: { ids: string[], reason: string, force?: boolean }) => Promise<any>}
     */
    async forget({ ids, reason, force = false }) {
      if (ids.length > FORGET_BUDGET) {
        throw new Error(`anagenesis: refusing to forget ${ids.length} memories in one call (budget ${FORGET_BUDGET}); split the batch and justify each part`)
      }
      const ts = now()
      const patch = { memorySet: {} }
      for (const id of ids) {
        const record = mustGet(id)
        if (record.state === 'locked' && force !== true) {
          throw new Error(`anagenesis: "${id}" is locked; forgetting it requires force: true and a reason`)
        }
        const tombstone = `${record.kind}:${record.subject}:${hash32(record.body).toString(16)}`
        patch.memorySet[id] = {
          ...record,
          state: 'retired',
          subject: record.subject.slice(0, 80),
          body: '',
          gist: '',
          tags: [],
          links: [],
          embedding: [],
          confidence: 0,
          updatedAt: ts,
          provenance: {
            ...record.provenance,
            evidence: [`forgotten: ${reason}`, `tombstone: ${tombstone}`].slice(-32),
          },
        }
      }
      const result = await store.transact(patch, { type: 'memory.forget', scope: 'global', payload: { ids, reason, force } })
      return { ok: true, ids, seq: result.seq, revert: result.revert }
    },

    /**
     * @type {(args: { from: string, to: string, rel: string }) => Promise<any>}
     */
    async link({ from, to, rel }) {
      const source = mustGet(from)
      mustGet(to)
      const record = {
        ...source,
        links: [...source.links, { rel, to }].slice(-64),
        updatedAt: now(),
      }
      const result = await store.transact({ memorySet: { [from]: record } }, {
        type: 'memory.link',
        scope: 'global',
        payload: { from, to, rel },
      })
      return { ok: true, seq: result.seq, revert: result.revert }
    },

    /**
     * Recompute every stored vector with the active backend, in one reversible
     * transaction, and stamp which backend produced them.
     *
     * Switching backends without this would compare vectors from two different
     * spaces: `cosine` returns 0 on a length mismatch and arbitrary numbers on a
     * coincidence, so the failure mode is "quietly ranks nonsense" rather than
     * an error. That is what the stamp is for — `status()` can then say the store
     * is stale instead of pretending.
     * @type {(args?: { embed?: (text: string) => number[], id?: string, dim?: number }) => Promise<any>}
     */
    async reembed(args = {}) {
      const fn = args.embed ?? embed
      const current = store.state.embed
      const id = args.id ?? current?.id ?? 'hash'
      const dim = Number(args.dim ?? (current?.id === id ? current?.dim : undefined) ?? fn('').length)
      const migrated = current?.id === id
        && current?.dim === dim
        && Object.values(store.state.memories).every((record) => (record.embedding?.length ?? 0) === dim)
      if (migrated) {
        return { ok: true, noop: true, seq: store.state.version, id, dim, records: 0 }
      }
      /** @type {Record<string, any>} */
      const memorySet = {}
      for (const [key, record] of Object.entries(store.state.memories)) {
        // Mirrors what `createMemory` embeds, so a re-embed reproduces exactly
        // the vector this record would get if it were written today.
        memorySet[key] = { ...record, embedding: fn(`${record.subject}\n${record.body}`).slice() }
      }
      const result = await store.transact({ memorySet, embedSet: { id, dim } }, {
        type: 'memory.reembed',
        scope: 'global',
        payload: { id, dim, records: Object.keys(memorySet).length },
      })
      return { ok: true, seq: result.seq, revert: result.revert, id, dim, records: Object.keys(memorySet).length }
    },

    /**
     * Usage feedback for a recall: which injected memories the agent actually
     * used. This is the ground truth the meta layer learns from — retrievals
     * that were never cited lose salience, cited ones gain it.
     *
     * Salience is partitioned by caller scope (schema v4): a shared store serves
     * several agents, so one agent citing a record must not re-rank another
     * agent's recall. The record's global `salience` stays the write-time default
     * that a scope with no history of its own inherits.
     * @type {(args: { usedIds?: string[], ignoredIds?: string[], scope?: string }) => Promise<any>}
     */
    async recordUse({ usedIds = [], ignoredIds = [], scope = 'global' }) {
      const ts = now()
      const patch = { memorySet: {} }
      /**
       * @param {any} record
       * @param {number} delta
       * @param {'hits'|'misses'} field
       */
      const bump = (record, delta, field) => ({
        ...record,
        salienceByScope: {
          ...(record.salienceByScope ?? {}),
          [scope]: clamp(effectiveSalience(record, scope) + delta, 0, 1),
        },
        access: {
          ...record.access,
          count: record.access.count + 1,
          [field]: record.access[field] + 1,
          lastAt: ts,
        },
      })
      for (const id of usedIds) {
        const record = store.state.memories[id]
        if (record === undefined) continue
        patch.memorySet[id] = bump(record, 0.05, 'hits')
      }
      for (const id of ignoredIds) {
        const record = store.state.memories[id]
        if (record === undefined) continue
        patch.memorySet[id] = bump(record, -0.02, 'misses')
      }
      if (Object.keys(patch.memorySet).length === 0) {
        // No seq: nothing was written, and `store.state.version` is the seq of
        // whatever transaction ran last — handing that back as "this call's seq"
        // is how a caller ends up reverting someone else's change (D5).
        return { ok: true, noop: true }
      }
      const result = await store.transact(patch, {
        type: 'memory.usage',
        scope,
        payload: { used: usedIds.length, ignored: ignoredIds.length, scope },
      })
      return { ok: true, seq: result.seq, revert: result.revert }
    },

    /**
     * Sweep expired records into `expired`. Called by the strategy layer on a
     * timer; it is a normal transaction, so the sweep is as revertible as an
     * agent-initiated expiry.
     * @type {() => Promise<{ swept: string[] }>}
     */
    async sweepExpired() {
      const ts = now()
      const patch = { memorySet: {} }
      for (const record of Object.values(store.state.memories)) {
        if (record.expiresAt === null || record.expiresAt > ts) continue
        if (record.state === 'expired' || record.state === 'retired') continue
        patch.memorySet[record.id] = { ...record, state: 'expired', updatedAt: ts }
      }
      const swept = Object.keys(patch.memorySet)
      if (swept.length === 0) return { swept }
      await store.transact(patch, { type: 'memory.sweep', scope: 'global', payload: { swept: swept.length } })
      return { swept }
    },
  }

  /**
   * Shared implementation for promote/demote: validate the whole batch against
   * the transition table first, then commit it as one transaction.
   * @param {{ ids: string[], to: string, reason: string, evidence: string[], force: boolean, verb: string, types: string[] }} args
   */
  async function transitionBatch({ ids, to, reason, evidence, force, verb, types }) {
    if (!types.includes(to)) throw new Error(`anagenesis: ${verb} cannot target "${to}" (allowed: ${types.join(', ')})`)
    const ts = now()
    const patch = { memorySet: {} }
    const transitions = []
    for (const id of ids) {
      const record = mustGet(id)
      const verdict = canTransition(record.state, to, { force })
      if (!verdict.ok) throw new Error(`anagenesis: cannot ${verb} "${id}": ${verdict.reason}`)
      transitions.push({ id, from: record.state, to })
      patch.memorySet[id] = {
        ...record,
        state: to,
        confidence: Math.max(record.confidence, CONFIDENCE_FLOOR[to] ?? 0),
        updatedAt: ts,
        provenance: evidence.length === 0
          ? { ...record.provenance, evidence: [...record.provenance.evidence, `${verb}: ${reason}`].slice(-32) }
          : { ...record.provenance, evidence: [...record.provenance.evidence, ...evidence].slice(-32) },
      }
    }
    const result = await store.transact(patch, {
      type: `memory.${verb}`,
      scope: 'global',
      payload: { ids, to, reason, transitions },
    })
    return { ok: true, ids, to, seq: result.seq, transitions, revert: result.revert }
  }
}

/**
 * Token cost of a record at a given granularity, used by the recall packer.
 * @param {import('../store/schema.js').MemoryRecord} record
 * @param {'gist'|'claims'|'full'|'timeline'} granularity
 * @returns {number}
 */
export function recordTokens(record, granularity) {
  const text = granularity === 'gist' ? record.gist
    : granularity === 'full' ? `${record.subject}\n${record.body}`
      : `${record.subject}\n${record.body.slice(0, 400)}`
  return estimateTokens(text) + 8
}

/** Re-exported so tool code can mint ids without importing util directly. */
export { ulid }
