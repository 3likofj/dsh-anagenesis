/**
 * Layer 2 — built-in strategy implementations.
 *
 * A strategy is a *pure function bundle* hung off six lifecycle hooks. It is
 * persisted as data (`{ id, impl, params, lineage }`), never as a closure, so
 * the store stays serializable and an agent can only derive strategies by
 * naming a built-in implementation plus a bounded parameter diff. That is a
 * deliberate restriction: an agent that could persist arbitrary code would be
 * an agent that can brick its own harness, which the safety section forbids.
 *
 * Hook contract (all hooks are optional, total, and side-effect free):
 *   score(h)      -> { delta: number, reason?: string }
 *   filter(h)     -> true | { keep: boolean, reason: string }
 *   format(h)     -> { bucket?: string, note?: string }
 *   write(h)      -> { state?: string, confidence?: number, ttlMs?: number, reject?: string }
 *   decay(h)      -> number      // half-life in ms, Infinity disables decay
 *   onResult(h)   -> { salience?: number, note?: string }
 *
 * `h` always carries `{ record, plan, params, now }`, plus `draft` for write and
 * `outcome` for onResult.
 * @module dsh-anagenesis/strategy/builtin
 */

import { clamp } from '../util.js'

/** @typedef {{ delta: number, reason?: string }} ScoreContribution */

/**
 * @typedef {object} StrategyImpl
 * @property {string} label
 * @property {string} description
 * @property {Record<string, number|boolean|string>} params
 * @property {Record<string, { min?: number, max?: number, step?: number, enum?: any[] }>} paramSpace
 * @property {Record<string, (h: any) => any>} hooks
 */

/** @type {Record<string, StrategyImpl>} */
export const BUILTIN_IMPLS = Object.freeze({
  guard: {
    label: 'guard',
    description: 'Non-removable invariant strategy: keeps the store honest and always in the stack. Never injects content on its own.',
    params: { lockedBoost: 0.08, draftPenalty: 0.05 },
    paramSpace: { lockedBoost: { min: 0, max: 0.3, step: 0.01 }, draftPenalty: { min: 0, max: 0.3, step: 0.01 } },
    hooks: {
      score: ({ record, params }) => {
        if (record.state === 'locked') return { delta: Number(params.lockedBoost), reason: 'locked belief' }
        if (record.state === 'draft') return { delta: -Number(params.draftPenalty), reason: 'unverified draft' }
        return { delta: 0 }
      },
      filter: ({ record }) => (record.state === 'retired'
        ? { keep: false, reason: 'retired records are never injected' }
        : true),
      format: ({ record }) => ({ bucket: undefined, note: record.state === 'locked' ? '[locked]' : undefined }),
    },
  },

  explore: {
    label: 'explore',
    description: 'High recall, low thresholds, writes land as drafts. For the stage where the agent is still mapping the problem.',
    params: { minConfidence: 0.15, tokenBudget: 2600, diversity: 0.35, draftTtlMs: 3 * 24 * 3600 * 1000, recencyBoost: 0.1 },
    paramSpace: {
      minConfidence: { min: 0, max: 0.6, step: 0.05 },
      tokenBudget: { min: 512, max: 8000, step: 128 },
      diversity: { min: 0, max: 0.8, step: 0.05 },
      draftTtlMs: { min: 3600e3, max: 30 * 24 * 3600e3, step: 3600e3 },
      recencyBoost: { min: 0, max: 0.4, step: 0.02 },
    },
    hooks: {
      score: ({ record, params, now }) => {
        const fresh = now - record.createdAt < 6 * 3600 * 1000
        return { delta: fresh ? Number(params.recencyBoost) : 0, reason: fresh ? 'recent draft' : undefined }
      },
      plan: ({ params }) => ({
        states: ['draft', 'active', 'verified', 'locked', 'deprecated'],
        minConfidence: Number(params.minConfidence),
        tokenBudget: Number(params.tokenBudget),
        diversity: Number(params.diversity),
      }),
      write: ({ params }) => ({ state: 'draft', ttlMs: Number(params.draftTtlMs) }),
      format: () => ({ bucket: '20.exploration' }),
    },
  },

  exploit: {
    label: 'exploit',
    description: 'High precision: inject only verified/locked memory, prefer rules over narrative, admit writes straight to active.',
    params: { minConfidence: 0.6, tokenBudget: 1400, diversity: 0.15, admitState: 'active', requireVerifiedForLock: true },
    paramSpace: {
      minConfidence: { min: 0.3, max: 0.95, step: 0.05 },
      tokenBudget: { min: 256, max: 4000, step: 64 },
      diversity: { min: 0, max: 0.5, step: 0.05 },
    },
    hooks: {
      plan: ({ params }) => ({
        states: ['active', 'verified', 'locked'],
        minConfidence: Number(params.minConfidence),
        tokenBudget: Number(params.tokenBudget),
      }),
      filter: ({ record, params }) => {
        if (record.state === 'draft' || record.state === 'deprecated') {
          return { keep: false, reason: `exploit injects only established memory (saw ${record.state})` }
        }
        if (record.confidence < Number(params.minConfidence)) {
          return { keep: false, reason: `confidence ${record.confidence.toFixed(2)} below exploit floor` }
        }
        return true
      },
      score: ({ record }) => (record.kind === 'procedure' || record.kind === 'constraint'
        ? { delta: 0.12, reason: 'actionable kind' }
        : { delta: 0 }),
      format: ({ record }) => (record.kind === 'procedure' ? { bucket: '10.rules' } : { bucket: undefined }),
      write: ({ params, draft }) => ({
        state: draft?.kind === 'hypothesis' ? 'draft' : String(params.admitState),
        confidence: undefined,
      }),
    },
  },

  debug: {
    label: 'debug',
    description: 'Focus on errors, boundaries and open questions; time decay disabled so an old failure is as loud as a new one.',
    params: { failureBoost: 0.25, tokenBudget: 2000, includeDeprecated: true, minConfidence: 0 },
    paramSpace: {
      failureBoost: { min: 0, max: 0.6, step: 0.05 },
      tokenBudget: { min: 512, max: 6000, step: 128 },
      minConfidence: { min: 0, max: 0.5, step: 0.05 },
    },
    hooks: {
      plan: () => ({
        states: ['draft', 'active', 'verified', 'locked', 'deprecated', 'expired'],
        minConfidence: 0,
      }),
      score: ({ record, params }) => {
        if (record.kind === 'failure') return { delta: Number(params.failureBoost), reason: 'known failure' }
        if (record.kind === 'hypothesis') return { delta: 0.1, reason: 'unresolved question' }
        return { delta: 0 }
      },
      decay: () => Number.POSITIVE_INFINITY,
      filter: ({ record, params }) => (record.state === 'deprecated' && params.includeDeprecated !== true
        ? { keep: false, reason: 'deprecated hidden in debug mode' }
        : true),
      format: ({ record, params }) => ({
        bucket: record.kind === 'failure' ? '05.failures' : undefined,
        note: record.kind === 'failure' ? `[debug:${String(params.failureBoost)}]` : undefined,
      }),
    },
  },

  distill: {
    label: 'distill',
    description: 'Compression-first: gist granularity, tight budget, heavy redundancy penalty. For a long session that must stay cheap.',
    params: { tokenBudget: 800, diversity: 0.6, gistOnly: true },
    paramSpace: {
      tokenBudget: { min: 256, max: 3000, step: 64 },
      diversity: { min: 0.2, max: 0.9, step: 0.05 },
    },
    hooks: {
      plan: ({ params }) => ({
        tokenBudget: Number(params.tokenBudget),
        diversity: Number(params.diversity),
      }),
      format: ({ params }) => ({ bucket: params.gistOnly === true ? '15.distilled' : undefined }),
      score: ({ record }) => ({ delta: record.gist.length > 0 ? 0.05 : -0.1, reason: 'gist availability' }),
    },
  },
})

/**
 * The stack every scope starts with: `guard` is invariant, `exploit` is the
 * conservative default for a cold agent.
 */
export const DEFAULT_STACK = Object.freeze(['guard', 'exploit'])

/**
 * The five preset singletons an agent can switch between through `ana_strategy`.
 */
export const BUILTIN_STACKS = Object.freeze({
  explore: ['guard', 'explore'],
  exploit: ['guard', 'exploit'],
  debug: ['guard', 'debug'],
  distill: ['guard', 'distill'],
  recon: ['guard', 'explore', 'distill'],
  crisis: ['guard', 'debug', 'exploit'],
})

/**
 * Coerce one parameter into its declared space.
 *
 * Three cases, all explicit:
 *   - a numeric knob (declared in `paramSpace`) is clamped to [min, max];
 *   - a declared but non-numeric knob (a boolean/string default such as
 *     `includeDeprecated`) keeps its declared type — it is not silently clamped;
 *   - an undeclared knob is refused, which is what stops a derivation from
 *     smuggling in an unmodelled handle.
 * @param {string} impl
 * @param {string} key
 * @param {any} value
 * @returns {any}
 */
export function clampParam(impl, key, value) {
  const spec = BUILTIN_IMPLS[impl]
  const declared = spec?.params !== undefined && Object.hasOwn(spec.params, key)
  const space = spec?.paramSpace?.[key]
  if (!declared && space === undefined) {
    throw new Error(`anagenesis: strategy "${impl}" has no parameter "${key}"`)
  }
  if (space === undefined) {
    const template = /** @type {any} */ (spec).params[key]
    if (typeof template === 'boolean') return value === true || value === 'true'
    if (typeof template === 'string') return String(value)
    return value
  }
  if (space.enum !== undefined) return space.enum.includes(value) ? value : space.enum[0]
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`anagenesis: parameter "${key}" must be numeric`)
  return clamp(n, space.min ?? -Infinity, space.max ?? Infinity)
}

/**
 * Validate a full parameter set against a strategy's declared space.
 * @param {string} impl
 * @param {Record<string, any>} params
 * @param {{ strict?: boolean }} [opts] `strict: false` tolerates keys left over
 *   from a previous schema version instead of refusing to resolve the strategy.
 * @returns {Record<string, any>}
 */
export function validateParams(impl, params, opts = {}) {
  const strict = opts.strict !== false
  const spec = BUILTIN_IMPLS[impl]
  if (spec === undefined) throw new Error(`anagenesis: unknown strategy implementation "${impl}"`)
  const merged = { ...spec.params }
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue
    try {
      merged[key] = clampParam(impl, key, value)
    } catch (error) {
      if (strict) throw error
    }
  }
  return merged
}

/**
 * Lenient read path used when resolving a strategy from persisted state: an
 * unknown leftover key is ignored rather than fatal.
 * @param {string} impl
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
export function defaultParams(impl, overrides = {}) {
  return validateParams(impl, overrides, { strict: false })
}
