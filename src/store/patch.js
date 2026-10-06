/**
 * Declarative patch algebra: the ONLY way state ever changes.
 *
 * A patch is data (JSON), never a closure. That buys three things at once:
 *   1. `applyPatch` is a pure function, so the store can swap immutable
 *      snapshots instead of mutating in place (lock-free readers);
 *   2. `invertPatch(before, patch)` derives the exact inverse from the
 *      pre-state, which is what every mutation hands back as its revert
 *      function — reversibility is computed, not hand-written;
 *   3. both the patch and its inverse are journaled, so a rollback survives a
 *      restart and `ana_audit` can replay it.
 * @module dsh-anagenesis/store/patch
 */

import { DEFAULT_EMBED, normalizeTuning } from './schema.js'

/** @typedef {ReturnType<typeof emptyPatch>} Patch */

/** @returns {Patch} */
export function emptyPatch() {
  return {
    /** @type {Record<string, any>} */ memorySet: {},
    /** @type {string[]} */ memoryUnset: [],
    /** @type {Record<string, any>} */ strategySet: {},
    /** @type {string[]} */ strategyUnset: [],
    /** @type {Record<string, string[]|null>} */ stackSet: {},
    /** @type {Record<string, Record<string, number|string|boolean>|null>} */ paramsSet: {},
    /**
     * The vector backend that produced the stored embeddings. A single value
     * rather than a map, so `null` means "no change" and the inverse is a plain
     * restore — see `invertPatch`.
     * @type {{ id: string, dim: number }|null}
     */
    embedSet: null,
    /**
     * The tuner's learning state — samples, arms, tune history. A single value
     * rather than a map, exactly like `embedSet`: it is one snapshot that the
     * tuner rewrites wholesale, so the inverse is a plain restore and a revert
     * of a feedback or tune event takes the learning state back with it.
     * @type {{ samples: number[], arms: Record<string, { pulls: number, reward: number }>, history: any[] }|null}
     */
    tuningSet: null,
    /** @type {Array<{ id: string, at: number, type: string, detail: unknown }>} */ auditAppend: [],
  }
}

/**
 * `auditAppend` has deliberately **no inverse**, and that is a decision rather
 * than a gap: an audit row is the in-state mirror of the journal — it records
 * that something happened, so erasing it would destroy exactly the evidence the
 * audit trail exists to keep (a revert could otherwise scrub a `guard.denied`
 * row). Consequence, enforced by `MemoryStore.revert`: an event whose only
 * effect was an audit append is refused instead of being "reverted" into a
 * phantom success. Every *domain* change keeps its exact inverse below.
 */

/**
 * @param {import('./schema.js').AnagenesisState} state
 * @param {Patch} patch
 * @returns {import('./schema.js').AnagenesisState} a NEW state; `state` is never touched
 */
export function applyPatch(state, patch) {
  /** @type {import('./schema.js').AnagenesisState} */
  const next = { ...state }

  const memoryUnset = patch.memoryUnset ?? []
  const memorySet = patch.memorySet ?? {}
  if (memoryUnset.length > 0 || Object.keys(memorySet).length > 0) {
    const memories = { ...state.memories }
    for (const id of memoryUnset) delete memories[id]
    for (const [id, record] of Object.entries(memorySet)) memories[id] = record
    next.memories = memories
  }

  const strategyUnset = patch.strategyUnset ?? []
  const strategySet = patch.strategySet ?? {}
  if (strategyUnset.length > 0 || Object.keys(strategySet).length > 0) {
    const strategies = { ...state.strategies }
    for (const id of strategyUnset) delete strategies[id]
    for (const [id, doc] of Object.entries(strategySet)) strategies[id] = doc
    next.strategies = strategies
  }

  const stackSet = patch.stackSet ?? {}
  if (Object.keys(stackSet).length > 0) {
    const stacks = { ...state.stacks }
    for (const [scope, ids] of Object.entries(stackSet)) {
      if (ids === null) delete stacks[scope]
      else stacks[scope] = ids
    }
    next.stacks = stacks
  }

  const paramsSet = patch.paramsSet ?? {}
  if (Object.keys(paramsSet).length > 0) {
    const params = { ...state.params }
    for (const [scope, values] of Object.entries(paramsSet)) {
      if (values === null) {
        delete params[scope]
        continue
      }
      // A `null` value means "this key had no value before" — remove it rather
      // than storing null, so the inverse of a first-time tune restores the
      // envelope default instead of pinning the knob to a bogus value.
      const merged = { ...(state.params[scope] ?? {}) }
      for (const [key, value] of Object.entries(values)) {
        if (value === null || value === undefined) delete merged[key]
        else merged[key] = value
      }
      params[scope] = merged
    }
    next.params = params
  }

  if ((patch.auditAppend ?? []).length > 0) {
    next.audit = [...state.audit, ...patch.auditAppend].slice(-4000)
  }

  if (patch.embedSet !== undefined && patch.embedSet !== null) {
    next.embed = { ...patch.embedSet }
  }

  if (patch.tuningSet !== undefined && patch.tuningSet !== null) {
    next.tuning = normalizeTuning(patch.tuningSet)
  }

  if (patch.stats !== undefined) next.stats = { ...state.stats, ...patch.stats }

  return next
}

/**
 * Derive the inverse patch. Every field is reconstructed from `before`, so the
 * inverse is exact even when the forward patch replaced a record wholesale.
 * @param {import('./schema.js').AnagenesisState} before
 * @param {Patch} patch
 * @returns {Patch}
 */
export function invertPatch(before, patch) {
  const undo = emptyPatch()

  for (const [id, previous] of Object.entries(patch.memorySet ?? {})) {
    if (Object.hasOwn(before.memories, id)) undo.memorySet[id] = before.memories[id]
    else undo.memoryUnset.push(id)
  }
  for (const id of patch.memoryUnset ?? []) {
    const previous = before.memories[id]
    if (previous !== undefined) undo.memorySet[id] = previous
  }

  for (const [id, previous] of Object.entries(patch.strategySet ?? {})) {
    if (Object.hasOwn(before.strategies, id)) undo.strategySet[id] = before.strategies[id]
    else undo.strategyUnset.push(id)
  }
  for (const id of patch.strategyUnset ?? []) {
    const previous = before.strategies[id]
    if (previous !== undefined) undo.strategySet[id] = previous
  }

  for (const scope of Object.keys(patch.stackSet ?? {})) {
    undo.stackSet[scope] = Object.hasOwn(before.stacks, scope) ? before.stacks[scope] : null
  }

  for (const [scope, values] of Object.entries(patch.paramsSet ?? {})) {
    if (values === null) {
      undo.paramsSet[scope] = before.params[scope] ?? null
      continue
    }
    /** @type {Record<string, number|string|boolean|null>} */
    const previousValues = {}
    let touchedExistingKey = false
    for (const key of Object.keys(values)) {
      if (Object.hasOwn(before.params[scope] ?? {}, key)) {
        previousValues[key] = /** @type {any} */ (before.params[scope])[key]
        touchedExistingKey = true
      } else {
        previousValues[key] = /** @type {any} */ (null)
      }
    }
    if (!touchedExistingKey && before.params[scope] === undefined) undo.paramsSet[scope] = null
    else undo.paramsSet[scope] = previousValues
  }

  if (patch.embedSet !== undefined && patch.embedSet !== null) {
    // A full restore, never a merge: the stamp is a single fact, and a store
    // predating the field could only ever have been vectorised by the default
    // backend — which is exactly what that constant records.
    undo.embedSet = before.embed ?? { ...DEFAULT_EMBED }
  }

  if (patch.tuningSet !== undefined && patch.tuningSet !== null) {
    // Full restore, never a merge — the same reason as `embedSet`: the tuner
    // writes the whole window, and a partial inverse would leave samples that
    // the reverted observation never produced.
    undo.tuningSet = normalizeTuning(before.tuning)
  }

  return undo
}

/**
 * Merge patches left-to-right (later values win). Used when one agent action
 * needs to touch several collections — e.g. promote + link in one transaction.
 * @param {Patch[]} patches
 * @returns {Patch}
 */
export function mergePatches(...patches) {
  const out = emptyPatch()
  for (const patch of patches) {
    Object.assign(out.memorySet, patch.memorySet ?? {})
    Object.assign(out.strategySet, patch.strategySet ?? {})
    Object.assign(out.stackSet, patch.stackSet ?? {})
    Object.assign(out.paramsSet, patch.paramsSet ?? {})
    out.memoryUnset.push(...(patch.memoryUnset ?? []))
    out.strategyUnset.push(...(patch.strategyUnset ?? []))
    out.auditAppend.push(...(patch.auditAppend ?? []))
    if (patch.embedSet !== undefined && patch.embedSet !== null) out.embedSet = { ...patch.embedSet }
    if (patch.tuningSet !== undefined && patch.tuningSet !== null) out.tuningSet = normalizeTuning(patch.tuningSet)
    if (patch.stats !== undefined) out.stats = { ...(out.stats ?? {}), ...patch.stats }
  }
  // A set later in the merge order cancels an earlier unset of the same id.
  out.memoryUnset = out.memoryUnset.filter((id) => !Object.hasOwn(out.memorySet, id))
  out.strategyUnset = out.strategyUnset.filter((id) => !Object.hasOwn(out.strategySet, id))
  return out
}

/**
 * @param {Patch} patch
 * @returns {boolean} whether the patch would change anything
 */
export function isEmptyPatch(patch) {
  return Object.keys(patch.memorySet ?? {}).length === 0
    && (patch.memoryUnset ?? []).length === 0
    && Object.keys(patch.strategySet ?? {}).length === 0
    && (patch.strategyUnset ?? []).length === 0
    && Object.keys(patch.stackSet ?? {}).length === 0
    && Object.keys(patch.paramsSet ?? {}).length === 0
    && (patch.embedSet === undefined || patch.embedSet === null)
    && (patch.tuningSet === undefined || patch.tuningSet === null)
    && (patch.auditAppend ?? []).length === 0
}

/**
 * @param {Patch} patch
 * @returns {string[]} the ids a patch touches, for invariants and audit rows
 */
export function touchedMemoryIds(patch) {
  return [...new Set([...Object.keys(patch.memorySet ?? {}), ...(patch.memoryUnset ?? [])])]
}
