/**
 * Layer 2 — the engine: executes a composed strategy stack.
 *
 * Deliberately boring and defensive. Every strategy hook call is:
 *   - wrapped in try/catch (a throwing strategy must never break a recall),
 *   - timed against a per-hook budget (a slow strategy must not stall a turn),
 *   - counted by a quarantine breaker (three failures in a window and that
 *     strategy stops participating until an explicit `ana_strategy` revive).
 * A broken strategy degrades retrieval to the remaining stack; it never
 * degrades to "no memory" and never takes the agent's turn down with it.
 * @module dsh-anagenesis/strategy/engine
 */

import { nowMs } from '../util.js'

const FAILURE_WINDOW_MS = 5 * 60 * 1000
const FAILURES_TO_QUARANTINE = 3

export class StrategyEngine {
  /** @type {import('./registry.js').StrategyRegistry} */
  #registry
  #logger
  /** @type {{ hookBudgetMs: number, scope: string, safeMode: boolean, onEvent?: Function, now: () => number }} */
  #options
  /** @type {Map<string, { failures: number[], quarantinedAt: number|null, lastReason: string|null }>} */
  #health = new Map()
  /** @type {Map<string, number>} */
  #hookCost = new Map()

  /**
   * @param {object} opts
   * @param {import('./registry.js').StrategyRegistry} opts.registry
   * @param {any} [opts.logger]
   * @param {{ hookBudgetMs?: number, scope?: string, safeMode?: boolean, onEvent?: Function, now?: () => number }} [opts.options]
   */
  constructor({ registry, logger, options = {} }) {
    this.#registry = registry
    this.#logger = logger ?? { info: () => {}, warn: () => {} }
    this.#options = {
      hookBudgetMs: options.hookBudgetMs ?? 8,
      scope: options.scope ?? 'global',
      safeMode: options.safeMode ?? false,
      onEvent: options.onEvent,
      now: options.now ?? nowMs,
    }
  }

  /** @returns {string} the scope this engine serves */
  get scope() {
    return this.#options.scope
  }

  /**
   * @param {string} scope
   * @returns {StrategyEngine} a sibling engine bound to another scope
   */
  forScope(scope) {
    return new StrategyEngine({ registry: this.#registry, logger: this.#logger, options: { ...this.#options, scope } })
  }

  /** @returns {{ ids: string[], entries: any[], hooks: any, params: any }} */
  composition() {
    return this.#registry.compose(this.#options.scope)
  }

  /** @returns {string[]} strategy ids currently participating, in order */
  describe() {
    return this.composition().ids
  }

  /**
   * Let the stack reshape a recall plan before any candidate is scored.
   *
   * Two different merge rules, on purpose:
   *   - VISIBILITY is monotone: `states`/`kinds` are unioned and
   *     `minConfidence` only ever moves down, so a strategy can widen what is
   *     considered but can never hide memory another strategy would surface
   *     (hiding is the `filter` hook's job, and it is visible in the trace);
   *   - PRESENTATION is last-writer-wins: budget, diversity, granularity and
   *     half-life are settled by the last strategy in the stack, which is how
   *     `distill` can shrink the block at the end of `['guard','explore','distill']`.
   * @param {any} plan
   * @returns {any} the effective plan
   */
  plan(plan) {
    const next = { ...plan, weights: { ...plan.weights } }
    for (const row of this.#invoke('plan', { plan })) {
      const value = row.value
      if (value === null || typeof value !== 'object') continue
      if (Array.isArray(value.states) && value.states.length > 0) {
        next.states = [...new Set([...next.states, ...value.states])]
      }
      if (Array.isArray(value.kinds) && value.kinds.length > 0) {
        next.kinds = next.kinds === null ? [...new Set(value.kinds)] : [...new Set([...next.kinds, ...value.kinds])]
      }
      if (typeof value.minConfidence === 'number') {
        next.minConfidence = Math.min(next.minConfidence, value.minConfidence)
      }
      if (typeof value.tokenBudget === 'number') next.tokenBudget = Math.max(64, Math.round(value.tokenBudget))
      if (typeof value.diversity === 'number') next.diversity = value.diversity
      if (typeof value.granularity === 'string') next.granularity = value.granularity
      if (typeof value.halfLifeMs === 'number') next.halfLifeMs = value.halfLifeMs
    }
    // An explicit caller override always wins over the stack.
    if (plan.tokenBudgetLocked === true) next.tokenBudget = plan.tokenBudget
    if (plan.confidenceLocked === true) next.minConfidence = plan.minConfidence
    return next
  }

  /**
   * @param {import('../store/schema.js').MemoryRecord} record
   * @param {any} plan
   * @returns {{ delta: number, reason?: string }}
   */
  score(record, plan) {
    const contribution = this.#invoke('score', { record, plan })
    let delta = 0
    /** @type {string[]} */
    const reasons = []
    for (const row of contribution) {
      const value = row.value
      if (typeof value === 'number') delta += value
      else if (value !== null && typeof value === 'object') {
        delta += Number(value.delta ?? 0)
        if (value.reason !== undefined) reasons.push(String(value.reason))
      }
    }
    return { delta, reason: reasons.length === 0 ? undefined : reasons.join('; ') }
  }

  /**
   * @param {import('../store/schema.js').MemoryRecord} record
   * @param {any} plan
   * @returns {boolean} true when every filter hook admits the record
   */
  admits(record, plan) {
    const results = this.#invoke('filter', { record, plan })
    for (const row of results) {
      const value = row.value
      if (value === false) return false
      if (value !== null && typeof value === 'object' && value.keep === false) return false
    }
    return true
  }

  /**
   * @param {import('../store/schema.js').MemoryRecord} record
   * @param {{ granularity?: string }} [context]
   * @returns {{ bucket?: string, note?: string }}
   */
  format(record, context = {}) {
    const merged = { bucket: undefined, note: undefined }
    for (const row of this.#invoke('format', { record, ...context })) {
      const value = row.value
      if (value === null || typeof value !== 'object') continue
      if (value.bucket !== undefined && merged.bucket === undefined) merged.bucket = String(value.bucket)
      if (value.note !== undefined) merged.note = `${merged.note ?? ''}${value.note}`
    }
    return merged
  }

  /**
   * Decide how a write lands. Default is the conservative one: active only when
   * a strategy says so, otherwise draft.
   * @param {any} draft
   * @param {any} [plan]
   * @returns {{ state: string, confidence?: number, ttlMs?: number, reject?: string, decidedBy: string[] }}
   */
  decideWrite(draft, plan = {}) {
    /** @type {{ state: string, confidence?: number, ttlMs?: number, reject?: string, decidedBy: string[] }} */
    const decision = { state: 'draft', decidedBy: [] }
    for (const row of this.#invoke('write', { draft, plan })) {
      const value = row.value
      if (value === null || typeof value !== 'object') continue
      if (value.reject !== undefined) {
        decision.reject = String(value.reject)
        decision.decidedBy.push(row.strategy)
        return decision
      }
      if (value.state !== undefined) {
        decision.state = String(value.state)
        decision.decidedBy.push(row.strategy)
      }
      if (value.confidence !== undefined) decision.confidence = Number(value.confidence)
      if (value.ttlMs !== undefined) decision.ttlMs = Number(value.ttlMs)
    }
    return decision
  }

  /**
   * @param {import('../store/schema.js').MemoryRecord} record
   * @param {any} plan
   * @returns {number} half-life in ms; Infinity disables decay
   */
  halfLifeMs(record, plan) {
    let halfLife = plan.halfLifeMs ?? Infinity
    for (const row of this.#invoke('decay', { record, plan })) {
      const value = Number(row.value)
      if (Number.isFinite(value) || value === Infinity) halfLife = value
    }
    return halfLife
  }

  /**
   * @param {{ usedIds?: string[], ignoredIds?: string[], success?: boolean, note?: string }} outcome
   * @returns {{ notes: string[], effects: any[] }}
   */
  notifyResult(outcome) {
    const notes = []
    const effects = []
    for (const row of this.#invoke('onResult', { outcome })) {
      const value = row.value
      if (value === null || typeof value !== 'object') continue
      effects.push({ strategy: row.strategy, value })
      if (value.note !== undefined) notes.push(String(value.note))
    }
    return { notes, effects }
  }

  /**
   * @returns {{ strategy: string, failures: number, quarantined: boolean, lastReason: string|null }[]}
   */
  health() {
    return [...this.#health.entries()].map(([strategy, row]) => ({
      strategy,
      failures: row.failures.length,
      quarantined: row.quarantinedAt !== null,
      lastReason: row.lastReason,
    }))
  }

  /**
   * Bring a quarantined strategy back.
   * @param {string} id
   * @returns {boolean}
   */
  revive(id) {
    const row = this.#health.get(id)
    if (row === undefined) return false
    row.quarantinedAt = null
    row.failures = []
    this.#emit('strategy.revived', { id })
    return true
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  quarantine(id) {
    const row = this.#health.get(id) ?? { failures: [], quarantinedAt: null, lastReason: null }
    row.quarantinedAt = this.#options.now()
    this.#health.set(id, row)
    this.#emit('strategy.quarantined', { id, reason: 'manual' })
    return true
  }

  /**
   * Run one hook across the composed stack, skipping quarantined strategies.
   * @param {string} hook
   * @param {Record<string, any>} payload
   * @returns {{ strategy: string, value: any }[]}
   */
  #invoke(hook, payload) {
    const composition = this.composition()
    /** @type {{ strategy: string, value: any }[]} */
    const results = []
    const now = this.#options.now()
    for (const entry of composition.entries) {
      const fn = entry.hooks[hook]
      if (fn === undefined) continue
      const health = this.#health.get(entry.id)
      if (health !== undefined && health.quarantinedAt !== null) continue
      const started = this.#options.now()
      try {
        const value = fn({ ...payload, params: entry.params, now })
        const cost = this.#options.now() - started
        this.#recordCost(entry.id, hook, cost)
        results.push({ strategy: entry.id, value })
      } catch (error) {
        this.#recordFailure(entry.id, hook, error, now)
      }
    }
    return results
  }

  /**
   * @param {string} id
   * @param {string} hook
   * @param {number} cost
   */
  #recordCost(id, hook, cost) {
    const key = `${id}:${hook}`
    const previous = this.#hookCost.get(key) ?? 0
    this.#hookCost.set(key, previous * 0.8 + cost * 0.2)
    if (cost > this.#options.hookBudgetMs * 4) {
      this.#logger.warn?.(`anagenesis: strategy "${id}" hook ${hook} took ${cost}ms (budget ${this.#options.hookBudgetMs}ms)`)
    }
  }

  /**
   * @param {string} id
   * @param {string} hook
   * @param {unknown} error
   * @param {number} now
   */
  #recordFailure(id, hook, error, now) {
    const row = this.#health.get(id) ?? { failures: [], quarantinedAt: null, lastReason: null }
    row.failures = [...row.failures.filter((at) => now - at < FAILURE_WINDOW_MS), now]
    row.lastReason = `hook ${hook}: ${error instanceof Error ? error.message : String(error)}`
    if (row.failures.length >= FAILURES_TO_QUARANTINE && row.quarantinedAt === null) {
      row.quarantinedAt = now
      this.#logger.warn?.(`anagenesis: strategy "${id}" quarantined after ${row.failures.length} failures (${row.lastReason})`)
      this.#emit('strategy.quarantined', { id, reason: row.lastReason })
    }
    this.#health.set(id, row)
  }

  /**
   * @param {string} type
   * @param {unknown} detail
   */
  #emit(type, detail) {
    if (typeof this.#options.onEvent === 'function') {
      try {
        this.#options.onEvent(type, detail)
      } catch {
        // observability must never be load-bearing
      }
    }
  }
}
