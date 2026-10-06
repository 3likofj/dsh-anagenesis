/**
 * Safety guardrails — the part of the system that is NOT self-modifiable.
 *
 * The self-bootstrapping answer is implemented here: anagenesis may rewrite its
 * own strategies and tuning parameters, but it may not rewrite the rules that
 * bound that rewriting. Concretely, this module freezes:
 *   - the presence of the `guard` strategy in every stack,
 *   - the tunable-parameter envelope and the namespace whitelist,
 *   - the destruction budget for forgetting memory,
 *   - the requirement that a locked belief needs an explicit `force` + reason,
 *   - meta-level mutation entirely while `safeMode` is on.
 * Violations are refusals, not warnings: the transaction never reaches the
 * journal, so there is no state to roll back.
 * @module dsh-anagenesis/guard/invariants
 */

import { FORGET_BUDGET } from '../memory/ops.js'
import { TUNABLE_PREFIXES } from '../meta/tuner.js'

export const MASS_DELETE_RATIO = 0.25

export class InvariantViolation extends Error {
  /** @param {{ id: string, message: string }[]} violations */
  constructor(violations) {
    super(`anagenesis: refused by ${violations.length} invariant(s): ${violations.map((v) => `${v.id}: ${v.message}`).join(' | ')}`)
    this.name = 'InvariantViolation'
    this.violations = violations
  }
}

/**
 * State-level invariants, evaluated against a would-be patch before it is
 * journaled. Each returns `null` when satisfied or `{ id, message }` when not.
 * @type {{ id: string, describe: string, check: (ctx: any) => null | { id: string, message: string } }[]}
 */
export const INVARIANTS = [
  {
    id: 'stack.guard-present',
    describe: 'every strategy stack must keep the invariant guard strategy',
    check: ({ state, patch, allowStackRemoval }) => {
      for (const [scope, ids] of Object.entries(patch.stackSet ?? {})) {
        if (ids === null) {
          // Removing a scope entry is how a *newly created* scope is undone: the
          // inverse of `stackSet: {scope: [...]}` against a state that had no such
          // scope is `stackSet: {scope: null}` (patch.js invertPatch). Refusing
          // every null made scope-creating strategy switches irreversible — a hole
          // in the "every change has an inverse" rule this project promises. A
          // compensating transaction may therefore remove it; a *forward* change
          // still may not, which is the protection that actually matters.
          if (allowStackRemoval === true) continue
          return { id: 'stack.guard-present', message: `removing stack "${scope}" is not allowed; set it to at least ["guard"]` }
        }
        if (!ids.includes('guard')) {
          return { id: 'stack.guard-present', message: `stack "${scope}" would lose the guard strategy: [${ids.join(', ')}]` }
        }
      }
      const live = Object.entries(state.stacks)
      for (const [scope, ids] of live) {
        if (patch.stackSet !== undefined && Object.hasOwn(patch.stackSet, scope)) continue
        if (!ids.includes('guard')) {
          return { id: 'stack.guard-present', message: `pre-existing stack "${scope}" is already missing guard; fix it explicitly before any other change` }
        }
      }
      return null
    },
  },
  {
    id: 'params.envelope-only',
    describe: 'only whitelisted parameter namespaces may be tuned',
    check: ({ patch }) => {
      for (const [scope, values] of Object.entries(patch.paramsSet ?? {})) {
        if (values === null) continue
        for (const key of Object.keys(values)) {
          if (!TUNABLE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
            return { id: 'params.envelope-only', message: `param "${key}" (scope ${scope}) is outside the tunable envelope` }
          }
        }
      }
      return null
    },
  },
  {
    id: 'memory.destruction-budget',
    describe: `one transaction may remove at most ${FORGET_BUDGET} memories`,
    check: ({ patch }) => {
      const removed = (patch.memoryUnset ?? []).length
      if (removed > FORGET_BUDGET) {
        return { id: 'memory.destruction-budget', message: `patch removes ${removed} records, budget is ${FORGET_BUDGET}` }
      }
      return null
    },
  },
  {
    id: 'memory.mass-ratio',
    describe: `a single transaction may not empty the store without an explicit allowance`,
    check: ({ state, patch, allowMassDelete }) => {
      const total = Object.keys(state.memories).length
      if (total < 20) return null
      const removed = (patch.memoryUnset ?? []).length
      if (removed / total > MASS_DELETE_RATIO && allowMassDelete !== true) {
        return {
          id: 'memory.mass-ratio',
          message: `patch removes ${removed}/${total} records (> ${MASS_DELETE_RATIO * 100}%); set allowMassDelete on the caller before doing this`,
        }
      }
      return null
    },
  },
  {
    id: 'destructive-needs-reason',
    describe: 'forget/expire/rethink must carry a reason in the audit row',
    check: ({ patch, meta }) => {
      const destructive = ['memory.forget', 'memory.expire', 'memory.split', 'memory.rethink']
      if (!destructive.includes(meta?.type)) return null
      const reason = meta?.payload?.reason ?? meta?.payload?.premise
      if (typeof reason !== 'string' || reason.trim().length < 3) {
        return { id: 'destructive-needs-reason', message: `${meta.type} must carry a reason of at least 3 characters` }
      }
      return null
    },
  },
  {
    id: 'safeMode.freezes-meta',
    describe: 'safeMode blocks every meta-level mutation (strategies, stacks, params)',
    check: ({ patch, safeMode, allowMetaInSafeMode }) => {
      if (safeMode !== true || allowMetaInSafeMode === true) return null
      if (Object.keys(patch.strategySet ?? {}).length > 0 || (patch.strategyUnset ?? []).length > 0) {
        return { id: 'safeMode.freezes-meta', message: 'safeMode: strategy registration/removal is disabled' }
      }
      if (Object.keys(patch.stackSet ?? {}).length > 0) {
        return { id: 'safeMode.freezes-meta', message: 'safeMode: strategy switching is disabled' }
      }
      if (Object.keys(patch.paramsSet ?? {}).length > 0) {
        return { id: 'safeMode.freezes-meta', message: 'safeMode: meta tuning is disabled' }
      }
      return null
    },
  },
  {
    id: 'locked.integrity',
    describe: 'a locked belief may only be changed with an explicit force marker',
    check: ({ state, patch, meta }) => {
      for (const [id, next] of Object.entries(patch.memorySet ?? {})) {
        const previous = state.memories[id]
        if (previous === undefined) continue
        if (previous.state !== 'locked') continue
        if (next.state === 'locked') continue
        const forced = meta?.payload?.force === true || meta?.payload?.allowUnlock === true
        if (!forced) {
          return { id: 'locked.integrity', message: `"${id}" is locked; pass force: true to change it` }
        }
      }
      return null
    },
  },
]

/**
 * Build the pre-commit gate the store calls before journaling.
 * @param {{ safeMode?: boolean, logger?: any, extra?: typeof INVARIANTS }} [opts]
 * @returns {(ctx: { state: any, patch: any, meta: any, allowMassDelete?: boolean, allowMetaInSafeMode?: boolean }) => void}
 */
export function createInvariantGate(opts = {}) {
  const checks = [...INVARIANTS, ...(opts.extra ?? [])]
  return (ctx) => {
    const violations = []
    for (const invariant of checks) {
      let verdict = null
      try {
        verdict = invariant.check({ ...ctx, safeMode: opts.safeMode ?? false })
      } catch (error) {
        verdict = { id: invariant.id, message: `checker crashed: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (verdict !== null) violations.push(verdict)
    }
    if (violations.length > 0) throw new InvariantViolation(violations)
  }
}

/**
 * Tool-level guard for `ctx.tools.guard()`: a monotonic denial for anagenesis
 * tool calls that the state-level gate cannot see (they depend on arguments).
 * Returning a string denies the call; returning undefined allows it.
 * @param {{ store: import('../store/store.js').MemoryStore, safeMode: () => boolean, maxIdsPerCall?: number }} deps
 * @returns {(exec: any) => string | undefined}
 */
export function createToolGuard(deps) {
  const maxIdsPerCall = deps.maxIdsPerCall ?? FORGET_BUDGET
  return (exec) => {
    if (typeof exec?.name !== 'string' || !exec.name.startsWith('ana_')) return undefined
    const state = deps.store.state
    // The host hands a guard its *execution* object, and that object carries the
    // tool arguments under `arguments`: `createExecution()` in
    // `@deepseek-ai/dsh-tools@0.2.0-rc.2` builds
    // `{ ...base, arguments: deepFreeze(detached) }` and never defines `args`.
    // Reading `exec.args` therefore made every check below silently inert on the
    // real host — a 51-id `ana_lock` walked straight past the per-call budget and
    // died later inside `ops.lock` ("unknown memory"). `args` stays as an alias
    // for exec shapes that predate that confirmation.
    const args = exec.arguments ?? exec.args ?? {}
    const ids = Array.isArray(args.ids) ? args.ids : []
    if (ids.length > maxIdsPerCall) {
      return `anagenesis: ${exec.name} was given ${ids.length} ids; the per-call budget is ${maxIdsPerCall}. Batch the work and justify each batch.`
    }
    if (exec.name === 'ana_forget') {
      const locked = ids.filter((id) => state.memories[id]?.state === 'locked')
      if (locked.length > 0 && args.force !== true) {
        return `anagenesis: ${locked.length} target(s) are locked (${locked.slice(0, 3).join(', ')}...); ana_forget requires force: true and a reason for locked beliefs`
      }
      if (typeof args.reason !== 'string' || args.reason.trim().length < 3) {
        return 'anagenesis: ana_forget requires a reason of at least 3 characters; forgetting is permanent for the agent even though the journal can undo it'
      }
    }
    if (exec.name === 'ana_tune' && deps.safeMode()) {
      return 'anagenesis: safeMode is on — meta tuning is frozen until safeMode is disabled in the plugin config'
    }
    if (exec.name === 'ana_strategy' && deps.safeMode() && ['switch', 'register', 'derive', 'revert'].includes(args.action)) {
      return 'anagenesis: safeMode is on — strategy changes are frozen (read-only actions: list, health)'
    }
    return undefined
  }
}
