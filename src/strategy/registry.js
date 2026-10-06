/**
 * Layer 2 — the strategy registry: runtime-registerable, switchable, revertible.
 *
 * Two things are deliberately separated:
 *   - the REGISTRY owns persisted strategy documents + per-scope stacks, and
 *     every mutation goes through `store.transact`, so register/activate/derive
 *     all return a compensating `revert()`;
 *   - the ENGINE owns execution: composition of the stack into one hook bundle,
 *     per-hook time budget, failure circuit breaker, and the current trace.
 *
 * Reactive coeffect: the engine composes from the store snapshot on demand and
 * `store.on('*')` invalidates the composition cache, so a strategy switch made
 * by another component (or by a replayed journal event) is picked up by every
 * consumer on its next call without any manual plumbing.
 * @module dsh-anagenesis/strategy/registry
 */

import { ulid } from '../util.js'
import { BUILTIN_IMPLS, BUILTIN_STACKS, DEFAULT_STACK, defaultParams, validateParams } from './builtin.js'

/** Re-exported so consumers get the invariant default stack from one place. */
export { DEFAULT_STACK }

/**
 * The six hook points, plus `plan`.
 *
 * `plan` runs before candidate selection and may only WIDEN a recall plan
 * (union the states/kinds, lower the confidence floor, raise the budget). That
 * monotonicity is deliberate: a strategy can make more memory visible or filter
 * it away at the `filter` stage, but no strategy can silently hide memory that
 * another strategy in the same stack would have surfaced.
 */
export const HOOKS = Object.freeze(['plan', 'score', 'filter', 'format', 'write', 'decay', 'onResult'])

/** A strategy switch that would empty the stack is refused outright. */
export const MAX_STACK_DEPTH = 6

export class StrategyRegistry {
  /** @type {import('../store/store.js').MemoryStore} */
  #store
  #logger
  /** @type {number} */
  #cacheVersion = -1
  /** @type {Map<string, any>} */
  #cache = new Map()

  /**
   * @param {{ store: import('../store/store.js').MemoryStore, logger?: any }} deps
   */
  constructor({ store, logger }) {
    this.#store = store
    this.#logger = logger ?? { info: () => {}, warn: () => {} }
  }

  /**
   * Every strategy visible in a scope: built-in impls plus persisted documents.
   * @param {string} [scope]
   * @returns {Array<{ id: string, impl: string, label: string, description: string, params: any, kind: string, lineage: any, persisted: boolean }>}
   */
  list(scope = 'global') {
    const state = this.#store.state
    const rows = []
    for (const [impl, spec] of Object.entries(BUILTIN_IMPLS)) {
      if (impl === 'guard') {
        rows.push({
          id: 'guard', impl, label: spec.label, description: spec.description,
          params: defaultParams('guard', state.params.guard ?? {}), kind: 'invariant', lineage: null, persisted: false,
        })
        continue
      }
      rows.push({
        id: impl, impl, label: spec.label, description: spec.description,
        params: defaultParams(impl, state.params[impl] ?? {}), kind: 'builtin', lineage: null, persisted: false,
      })
    }
    for (const doc of Object.values(state.strategies)) {
      rows.push({
        id: doc.id,
        impl: doc.impl,
        label: doc.label ?? doc.id,
        description: BUILTIN_IMPLS[doc.impl]?.description ?? '',
        params: doc.params,
        kind: doc.kind ?? 'derived',
        lineage: doc.lineage ?? null,
        persisted: true,
      })
    }
    return rows
  }

  /**
   * @param {string} id
   * @returns {any}
   */
  resolve(id) {
    const state = this.#store.state
    if (BUILTIN_IMPLS[id] !== undefined) {
      return {
        id,
        impl: id,
        label: BUILTIN_IMPLS[id].label,
        kind: id === 'guard' ? 'invariant' : 'builtin',
        // Only this strategy's own namespace is read here. `state.params.global`
        // holds recall/meta knobs, and leaking those into a strategy's parameter
        // set would both break validation and let a recall knob change strategy
        // behaviour by accident.
        params: defaultParams(id, state.params[id] ?? {}),
        hooks: BUILTIN_IMPLS[id].hooks,
        disabledHooks: [],
      }
    }
    const doc = state.strategies[id]
    if (doc === undefined) return undefined
    const impl = BUILTIN_IMPLS[doc.impl]
    if (impl === undefined) return undefined
    const disabled = new Set(doc.disabledHooks ?? [])
    const hooks = {}
    for (const [name, fn] of Object.entries(impl.hooks)) {
      if (!disabled.has(name)) hooks[name] = fn
    }
    return { id: doc.id, impl: doc.impl, label: doc.label ?? doc.id, kind: doc.kind ?? 'derived', params: doc.params, hooks, disabledHooks: [...disabled] }
  }

  /**
   * @param {string} [scope]
   * @returns {string[]}
   */
  stack(scope = 'global') {
    const state = this.#store.state
    const ids = state.stacks[scope] ?? state.stacks.global ?? [...DEFAULT_STACK]
    return [...ids]
  }

  /**
   * Live composition of a scope's stack, memoized per store version.
   * @param {string} [scope]
   * @returns {{ ids: string[], entries: any[], hooks: Record<string, Function[]>, params: Record<string, any> }}
   */
  compose(scope = 'global') {
    if (this.#cacheVersion !== this.#store.version) {
      this.#cache.clear()
      this.#cacheVersion = this.#store.version
    }
    const ids = this.stack(scope)
    const cacheKey = `${scope}:${ids.join('>')}`
    const cached = this.#cache.get(cacheKey)
    if (cached !== undefined) return cached
    const entries = []
    for (const id of ids) {
      const resolved = this.resolve(id)
      if (resolved === undefined) {
        this.#logger.warn(`anagenesis: strategy "${id}" in stack ${scope} does not resolve; skipping`)
        continue
      }
      entries.push(resolved)
    }
    /** @type {Record<string, Function[]>} */
    const hooks = {}
    for (const hook of HOOKS) hooks[hook] = entries.filter((entry) => entry.hooks[hook] !== undefined).map((entry) => entry.hooks[hook])
    /** @type {Record<string, any>} */
    const params = {}
    for (const entry of entries) params[entry.id] = entry.params
    const composed = { ids: entries.map((entry) => entry.id), entries, hooks, params }
    this.#cache.set(cacheKey, composed)
    return composed
  }

  /**
   * Register a strategy document. Reversible: unloading restores the previous
   * document for that id (or removes the id if it did not exist).
   * @param {{ id?: string, impl: string, label?: string, params?: any, disabledHooks?: string[], kind?: string, lineage?: any, scope?: string }} doc
   * @returns {Promise<{ id: string, seq: number, revert: Function }>}
   */
  async register(doc) {
    if (BUILTIN_IMPLS[doc.impl] === undefined) {
      throw new Error(`anagenesis: cannot register a strategy over unknown implementation "${doc.impl}" (known: ${Object.keys(BUILTIN_IMPLS).join(', ')})`)
    }
    const id = doc.id ?? `${doc.impl}-${ulid('s', { time: Date.now() }).slice(2, 8)}`
    if (BUILTIN_IMPLS[id] !== undefined) throw new Error(`anagenesis: "${id}" is a built-in strategy id and cannot be redefined`)
    const params = validateParams(doc.impl, doc.params ?? {})
    const record = {
      id,
      impl: doc.impl,
      label: doc.label ?? id,
      kind: doc.kind ?? 'derived',
      params,
      disabledHooks: (doc.disabledHooks ?? []).filter((hook) => HOOKS.includes(hook)),
      lineage: doc.lineage ?? null,
      version: 1,
      createdAt: Date.now(),
    }
    const result = await this.#store.transact({ strategySet: { [id]: record } }, {
      type: 'strategy.register',
      scope: doc.scope ?? 'global',
      payload: { id, impl: doc.impl, params, lineage: record.lineage },
    })
    return { id, seq: result.seq, revert: result.revert }
  }

  /**
   * @param {string} id
   * @param {{ scope?: string }} [opts]
   * @returns {Promise<{ seq: number, revert: Function }>}
   */
  async unregister(id, opts = {}) {
    if (BUILTIN_IMPLS[id] !== undefined) throw new Error(`anagenesis: built-in strategy "${id}" cannot be unregistered`)
    if (this.#store.state.strategies[id] === undefined) throw new Error(`anagenesis: no strategy "${id}"`)
    const result = await this.#store.transact({ strategyUnset: [id] }, {
      type: 'strategy.unregister',
      scope: opts.scope ?? 'global',
      payload: { id },
    })
    return { seq: result.seq, revert: result.revert }
  }

  /**
   * Replace a scope's stack wholesale. This is the primitive both `activate`
   * and `deactivate` build on, and the reason a switch is exactly one journal
   * event with exactly one inverse.
   * @param {string[]} ids
   * @param {{ scope?: string, reason?: string }} [opts]
   * @returns {Promise<{ previous: string[], stack: string[], seq: number, revert: Function }>}
   */
  async setStack(ids, opts = {}) {
    const scope = opts.scope ?? 'global'
    const next = [...new Set(ids)]
    if (next.length === 0) throw new Error('anagenesis: an empty strategy stack is not allowed (at least guard must stay active)')
    if (next.length > MAX_STACK_DEPTH) throw new Error(`anagenesis: stack depth ${next.length} exceeds ${MAX_STACK_DEPTH}`)
    for (const id of next) {
      if (this.resolve(id) === undefined) throw new Error(`anagenesis: unknown strategy "${id}"`)
    }
    if (!next.includes('guard')) throw new Error('anagenesis: the "guard" strategy is invariant and cannot be removed from the stack')
    const previous = this.stack(scope)
    const result = await this.#store.transact({ stackSet: { [scope]: next } }, {
      type: 'strategy.setStack',
      scope,
      payload: { from: previous, to: next, reason: opts.reason ?? null },
    })
    return { previous, stack: next, seq: result.seq, revert: result.revert }
  }

  /**
   * Activate one strategy, optionally as a named preset stack.
   * @param {string} id
   * @param {{ scope?: string, mode?: 'replace'|'push'|'preset', reason?: string }} [opts]
   * @returns {Promise<{ stack: string[], seq: number, revert: Function }>}
   */
  async activate(id, opts = {}) {
    const mode = opts.mode ?? 'replace'
    const current = this.stack(opts.scope)
    if (mode === 'preset') {
      const preset = BUILTIN_STACKS[id]
      if (preset === undefined) throw new Error(`anagenesis: "${id}" is not a preset stack (known: ${Object.keys(BUILTIN_STACKS).join(', ')})`)
      const result = await this.setStack(preset, { scope: opts.scope, reason: opts.reason ?? `activate preset ${id}` })
      return { stack: result.stack, seq: result.seq, revert: result.revert }
    }
    if (mode === 'push') {
      if (current.includes(id)) return { stack: current, seq: this.#store.version, noop: true, revert: async () => {} }
      const result = await this.setStack([...current, id], { scope: opts.scope, reason: opts.reason ?? `push ${id}` })
      return { stack: result.stack, seq: result.seq, revert: result.revert }
    }
    const result = await this.setStack(['guard', id], { scope: opts.scope, reason: opts.reason ?? `activate ${id}` })
    return { stack: result.stack, seq: result.seq, revert: result.revert }
  }

  /**
   * @param {string} id
   * @param {{ scope?: string }} [opts]
   * @returns {Promise<{ stack: string[], seq: number, revert: Function }>}
   */
  async deactivate(id, opts = {}) {
    if (id === 'guard') throw new Error('anagenesis: "guard" cannot be deactivated')
    const current = this.stack(opts.scope)
    const next = current.filter((entry) => entry !== id)
    if (next.length === current.length) return { stack: current, seq: this.#store.version, noop: true, revert: async () => {} }
    const result = await this.setStack(next.length === 0 ? [...DEFAULT_STACK] : next, { scope: opts.scope, reason: `deactivate ${id}` })
    return { stack: result.stack, seq: result.seq, revert: result.revert }
  }

  /**
   * Derive a new strategy from a base: same implementation, bounded parameter
   * diff, optional hook disabling. The lineage is stored so `ana_tune` can trace
   * which adaption produced which strategy.
   * @param {string} baseId
   * @param {{ id?: string, params?: any, disableHooks?: string[], label?: string, rationale?: string }} diff
   * @param {{ scope?: string, by?: string }} [opts]
   * @returns {Promise<{ id: string, params: any, lineage: any, seq: number, revert: Function }>}
   */
  async derive(baseId, diff = {}, opts = {}) {
    const base = this.resolve(baseId)
    if (base === undefined) throw new Error(`anagenesis: unknown base strategy "${baseId}"`)
    if (base.kind === 'invariant') throw new Error('anagenesis: the guard strategy cannot be used as a derivation base')
    const params = validateParams(base.impl, { ...base.params, ...(diff.params ?? {}) })
    for (const hook of diff.disableHooks ?? []) {
      if (!HOOKS.includes(hook)) throw new Error(`anagenesis: "${hook}" is not a strategy hook (known: ${HOOKS.join(', ')})`)
      if (hook === 'filter') throw new Error('anagenesis: disabling the filter hook would let a derived strategy inject retired memory')
    }
    const lineage = { derivedFrom: baseId, at: Date.now(), by: opts.by ?? 'agent', diff: diff.params ?? {}, rationale: diff.rationale ?? null }
    const registered = await this.register({
      id: diff.id,
      impl: base.impl,
      label: diff.label ?? `${base.label}+`,
      params,
      disabledHooks: diff.disableHooks ?? [],
      kind: 'derived',
      lineage,
      scope: opts.scope,
    })
    return { id: registered.id, params, lineage, seq: registered.seq, revert: registered.revert }
  }

  /** @returns {Promise<{ seq: number, revert: Function }>} */
  async resetScope(scope = 'global') {
    return this.setStack([...DEFAULT_STACK], { scope, reason: 'reset to default stack' })
  }
}
