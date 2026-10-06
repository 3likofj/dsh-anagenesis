/**
 * Reflection: the engine questioning its own beliefs, on a timer.
 *
 * A belief is only as good as the evidence behind it, and evidence goes stale
 * while nobody is watching. This module finds the records whose support has
 * visibly decayed and files a *counterfactual* against them through exactly the
 * same `ops.rethink` path an agent would use — so every reflection is an
 * ordinary, revertible, audited memory write and nothing more.
 *
 * Hard limits, enforced here rather than by convention:
 *   - it can only create memories. Tier-2 (the parameter envelope, the tunable
 *     whitelist, the presence of `guard`, the tool schemas, this code) is not
 *     reachable from this module at all;
 *   - one run is bounded, and a belief that already carries a live
 *     `challenged_by` link is never asked twice, so a stuck clock cannot pile up
 *     hypotheses;
 *   - `safeMode` disables it at the caller, and each reflection is a normal
 *     transaction that hands back its own `revert()`.
 * @module dsh-anagenesis/meta/reflect
 */

import { CONFIDENCE_FLOOR } from '../store/schema.js'

/** Default staleness window: a month without the belief being touched. */
export const DEFAULT_STALE_AFTER_MS = 30 * 24 * 3600 * 1000

/**
 * Which beliefs deserve a counterfactual right now.
 *
 * Selection is deliberately narrow: only established beliefs (`verified`,
 * `locked` — the ones exploit mode injects), only ones that already carry a
 * concrete decay signal, and never one that is still being challenged.
 * @param {import('../store/schema.js').AnagenesisState} state
 * @param {{ now?: number, staleAfterMs?: number, limit?: number }} [opts]
 * @returns {{ record: any, reason: string }[]}
 */
export function selectReflectionTargets(state, opts = {}) {
  const now = opts.now ?? Date.now()
  const staleAfterMs = Number(opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)
  const limit = Math.max(1, opts.limit ?? 2)
  const memoryIds = new Set(Object.keys(state.memories ?? {}))
  /** @type {{ record: any, reason: string }[]} */
  const targets = []
  for (const record of Object.values(state.memories ?? {})) {
    if (targets.length >= limit) break
    if (record.state !== 'verified' && record.state !== 'locked') continue
    // An open challenge means the engine already asked this question; asking
    // again every interval would bury the answer in duplicates.
    if (record.links.some((link) => link.rel === 'challenged_by' && memoryIds.has(link.to))) continue
    const age = now - (record.updatedAt ?? record.createdAt ?? now)
    if (age < staleAfterMs) continue
    const reason = decayReason(record, now, staleAfterMs)
    if (reason === null) continue
    targets.push({ record, reason })
  }
  return targets
}

/**
 * The concrete reason a belief is worth questioning, or null when age alone is
 * not enough. Kept separate from selection so the audit row says *why*.
 * @param {any} record
 * @param {number} now
 * @param {number} staleAfterMs
 * @returns {string|null}
 */
function decayReason(record, now, staleAfterMs) {
  if (record.expiresAt !== null && record.expiresAt !== undefined && record.expiresAt <= now) {
    return 'the evidence window it was given has closed'
  }
  if ((record.provenance?.evidence ?? []).length === 0) {
    return 'it was promoted without recording any evidence'
  }
  const floor = CONFIDENCE_FLOOR[record.state] ?? 0
  if (typeof record.confidence === 'number' && record.confidence < floor) {
    return `its confidence ${record.confidence} fell below the ${record.state} floor ${floor}`
  }
  if (now - (record.updatedAt ?? 0) > staleAfterMs * 2) {
    return 'nothing has touched it in twice the staleness window'
  }
  return null
}

/**
 * File counterfactuals against up to `limit` stale beliefs.
 *
 * Each one is a `memory.rethink` transaction, which is what makes the audit row
 * and the `revert()` free: this function never writes state itself.
 * @param {{
 *   store: import('../store/store.js').MemoryStore,
 *   ops: { rethink: (args: any) => Promise<any> },
 *   logger?: { info: Function, warn: Function },
 *   now?: () => number,
 *   config?: any,
 * }} deps
 * @returns {Promise<{ filed: { id: string, hypothesisId: string, reason: string, seq: number }[], considered: number }>}
 */
export async function runReflection(deps) {
  const { store, ops, logger } = deps
  const now = (deps.now ?? Date.now)()
  const config = deps.config ?? {}
  const limit = Math.max(1, Math.min(Number(config.maxReflectionsPerRun ?? 2), 10))
  const targets = selectReflectionTargets(store.state, {
    now,
    staleAfterMs: Number(config.reflectionStaleAfterMs ?? DEFAULT_STALE_AFTER_MS),
    limit,
  })
  const filed = []
  for (const { record, reason } of targets) {
    const premise = record.subject
    const counterfactual = `If "${premise}" no longer holds, everything derived from it has to be `
      + `re-derived before it is used again. This counterfactual was filed automatically because ${reason}. `
      + 'Re-verify against current evidence, then either refresh the evidence, demote the belief, or dismiss this hypothesis.'
    try {
      const result = await ops.rethink({ premise, counterfactual, ids: [record.id], confidence: 0.3 })
      filed.push({ id: record.id, hypothesisId: result.hypothesisId, reason, seq: result.seq })
      logger?.info?.(`anagenesis-reflect: filed a counterfactual against "${premise}" — ${reason}`)
    } catch (error) {
      // One unwritable belief must not stop the rest of the sweep.
      logger?.warn?.(`anagenesis-reflect: could not challenge ${record.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { filed, considered: targets.length }
}
