/**
 * Layer 3 — meta-policy: feedback in, bounded parameter adjustment out.
 *
 * Design choices worth stating:
 *   - the parameter space is DECLARED (envelope), not discovered: every knob has
 *     hard min/max, so the worst case of a runaway optimiser is a clamped value;
 *   - the adjustment algorithm is UCB1 over (param, delta) arms plus a
 *     regression check — deterministic given the observed signals, so an audit
 *     row plus the journal can reproduce it;
 *   - every applied change is an ordinary store transaction carrying the
 *     previous values, therefore `rollback(auditId)` is just `revert()`;
 *   - the tuner never touches the guard invariants, the envelope or the tool
 *     schema. That boundary is the self-bootstrapping answer made executable.
 * @module dsh-anagenesis/meta/tuner
 */

import { clamp } from '../util.js'
import { defaultTuning } from '../store/schema.js'

/**
 * Hard envelope. `min`/`max` here are the outer safety bounds; a strategy's own
 * `paramSpace` in builtin.js is usually narrower.
 */
export const PARAM_ENVELOPE = Object.freeze({
  'recall.halfLifeMs': { min: 600_000, max: 90 * 24 * 3600 * 1000, step: 600_000, default: 14 * 24 * 3600 * 1000 },
  'recall.diversity': { min: 0, max: 0.9, step: 0.05, default: 0.25 },
  // Query-relevance floor. Tunable because how strict "relevant enough" should
  // be is a property of the store's own vocabulary, and the benchmark only
  // covers the vocabulary we wrote for it.
  'recall.minRelevance': { min: 0, max: 0.85, step: 0.05, default: 0.22 },
  // The two scope-isolation knobs. They are tunable on purpose: how much a
  // project should trust *another* project's experience is exactly the kind of
  // thing that has to be learned from results rather than decided once. The
  // ceiling on `crossProjectFactor` is 1 and not more, because "another project
  // ranks equal to this one" is the failure this whole change exists to remove.
  'recall.scopeWeight': { min: 0, max: 0.4, step: 0.02, default: 0.12 },
  'recall.crossProjectFactor': { min: 0, max: 1, step: 0.05, default: 0.4 },
  'recall.orient.tokenBudget': { min: 256, max: 8000, step: 128, default: 1200 },
  'recall.recall_precedent.tokenBudget': { min: 256, max: 8000, step: 128, default: 1800 },
  'recall.recall_precedent.minConfidence': { min: 0, max: 0.7, step: 0.05, default: 0.3 },
  'write.admissionThreshold': { min: 0.2, max: 0.95, step: 0.05, default: 0.55 },
  'write.draftTtlMs': { min: 3600e3, max: 30 * 24 * 3600e3, step: 3600e3, default: 3 * 24 * 3600e3 },
  'promote.hitRateThreshold': { min: 0.05, max: 0.8, step: 0.05, default: 0.3 },
  'demote.missRateThreshold': { min: 0.2, max: 0.95, step: 0.05, default: 0.6 },
  'meta.minSamples': { min: 5, max: 200, step: 5, default: 20 },
  'meta.improvementEpsilon': { min: 0.01, max: 0.3, step: 0.01, default: 0.05 },
})

export const OBJECTIVES = Object.freeze(['utilization', 'precision', 'token_efficiency', 'task_success'])

/**
 * How many feedback samples a change needs before it can be judged.
 *
 * The old loop learned from *nothing*: `observe` appended samples and never
 * credited an arm, so UCB1's means stayed at zero and only `proposal.reward`
 * (which callers rarely pass) moved them. Credit now accrues to the arm of the
 * most recent change from the samples that arrive after it, and a change is
 * "in flight" until this window is filled — which is also what stops two
 * changes from being judged against each other.
 */
export const EVALUATION_WINDOW = 5

/**
 * Namespaces whose knobs the tuner may write. Anything outside this list — the
 * guard stack, envelopes, schema — is frozen against self-modification.
 */
export const TUNABLE_PREFIXES = Object.freeze(['recall.', 'write.', 'promote.', 'demote.', 'meta.'])

export class Tuner {
  #store
  #registry
  #logger

  /**
   * @param {{ store: import('../store/store.js').MemoryStore, registry: import('../strategy/registry.js').StrategyRegistry, logger?: any, safeMode?: boolean }} deps
   */
  constructor({ store, registry, logger, safeMode = false }) {
    this.#store = store
    this.#registry = registry
    this.#logger = logger ?? { info: () => {}, warn: () => {} }
    this.safeMode = safeMode
  }

  /**
   * The learning state — read from the store every time, never cached.
   *
   * It used to live in private fields, which made the meta layer's only ground
   * truth process-local: every restart zeroed the sample window and the UCB1
   * arms, and `revert(seq)` on a feedback event had nothing to roll back. Now
   * `state.tuning` is the single source of truth, which is also what makes a
   * revert visible to the tuner the instant it happens instead of on restart.
   * @returns {{ samples: number[], arms: Record<string, { pulls: number, reward: number }>, history: any[] }}
   */
  #tuning() {
    return this.#store.state.tuning ?? defaultTuning()
  }

  /**
   * Write the learning state as part of the transaction that changed it.
   * @param {{ samples: number[], arms: Record<string, { pulls: number, reward: number }>, history: any[] }} tuning
   * @returns {{ samples: number[], arms: Record<string, { pulls: number, reward: number }>, history: any[] }}
   */
  #patch(tuning) {
    return {
      samples: [...tuning.samples],
      arms: Object.fromEntries(Object.entries(tuning.arms).map(([armId, arm]) => [armId, { ...arm }])),
      history: tuning.history.map((row) => ({ ...row })),
    }
  }

  /**
   * Effective value of a knob for a scope, envelope default when unset.
   * @param {string} key
   * @param {string} [scope]
   * @returns {number}
   */
  value(key, scope = 'global') {
    const spec = PARAM_ENVELOPE[key]
    if (spec === undefined) throw new Error(`anagenesis: "${key}" is not in the tunable envelope`)
    const raw = this.#store.state.params[scope]?.[key]
    // `undefined`/`null` means "never tuned": fall back to the envelope default
    // rather than coercing through Number(), which would silently pin the knob
    // to the envelope's lower bound.
    if (raw === undefined || raw === null) return spec.default
    const value = Number(raw)
    return Number.isFinite(value) ? clamp(value, spec.min, spec.max) : spec.default
  }

  /**
   * @param {string} [scope]
   * @returns {Record<string, number>} every knob's effective value
   */
  snapshot(scope = 'global') {
    /** @type {Record<string, number>} */
    const out = {}
    for (const key of Object.keys(PARAM_ENVELOPE)) out[key] = this.value(key, scope)
    return out
  }

  /**
   * Observe one outcome. Signals are the feedback data source: whether injected
   * memories were actually cited, whether the task succeeded, and how much the
   * injection cost.
   * @param {object} signal
   * @param {string[]} [signal.usedIds]
   * @param {string[]} [signal.ignoredIds]
   * @param {boolean} [signal.success]
   * @param {number} [signal.tokenCost]
   * @param {string} [signal.objective]
   * @returns {Promise<{ reward: number, objective: string, components: Record<string, number> }>}
   */
  async observe(signal) {
    const objective = OBJECTIVES.includes(signal.objective) ? signal.objective : 'utilization'
    const used = signal.usedIds?.length ?? 0
    const ignored = signal.ignoredIds?.length ?? 0
    const precision = used + ignored === 0 ? 0 : used / (used + ignored)
    const efficiency = signal.tokenCost === undefined ? 0.5 : clamp(1 - signal.tokenCost / 8000, 0, 1)
    const success = signal.success === undefined ? 0.5 : (signal.success ? 1 : 0)
    /** @type {Record<string, number>} */
    const components = { precision, efficiency, success }
    let reward
    if (objective === 'precision') reward = precision
    else if (objective === 'token_efficiency') reward = efficiency
    else if (objective === 'task_success') reward = success
    else reward = 0.5 * precision + 0.3 * efficiency + 0.2 * success

    const tuning = this.#tuning()
    const samples = [...tuning.samples, reward].slice(-200)
    // Credit the change under evaluation with this sample. This is the missing
    // half of the loop: without it the bandit only ever saw the rewards a
    // caller happened to attach to a proposal.
    const history = tuning.history.map((row) => ({ ...row }))
    let arms = tuning.arms
    const last = history[history.length - 1]
    if (last !== undefined && last.evaluatedAt === undefined && typeof last.armId === 'string') {
      const since = samples.length - Number(last.samplesAt ?? 0)
      if (since >= EVALUATION_WINDOW) {
        // One pull, one reward: the arm is credited with the *mean* of the
        // window that followed the change, not with five separate rewards.
        const window = samples.slice(Number(last.samplesAt ?? 0))
        const windowReward = window.reduce((sum, value) => sum + value, 0) / window.length
        const arm = { ...(arms[last.armId] ?? { pulls: 0, reward: 0 }) }
        arm.reward += windowReward
        arms = { ...arms, [last.armId]: arm }
        last.evaluatedAt = Date.now()
        last.windowReward = Number(windowReward.toFixed(4))
        last.windowSamples = window.length
      }
    }
    await this.#store.transact({
      // The learning state rides the same transaction as the row that explains
      // it: a restart resumes from the journal, and `revert(seq)` takes the
      // sample back out.
      tuningSet: this.#patch({ ...tuning, samples, history, arms }),
      auditAppend: [{
        id: `fb_${this.#store.state.version + 1}`,
        at: Date.now(),
        type: 'meta.feedback',
        detail: { objective, reward: Number(reward.toFixed(4)), components, used, ignored },
      }],
    }, { type: 'meta.feedback', scope: 'global', payload: { objective, reward } })
    return { reward, objective, components }
  }

  /**
   * Propose one bounded adjustment. Purely advisory: `propose` never writes.
   * @param {{ objective?: string, param?: string, direction?: 1|-1 }} [request]
   * @returns {{ param: string, from: number, to: number, delta: number, rationale: string, armReward: number, samples: number }}
   */
  propose(request = {}) {
    const objective = OBJECTIVES.includes(request.objective) ? request.objective : 'utilization'
    const candidates = request.param === undefined
      ? Object.keys(PARAM_ENVELOPE)
      : [request.param]
    for (const key of candidates) {
      if (PARAM_ENVELOPE[key] === undefined) throw new Error(`anagenesis: "${key}" is not tunable`)
      if (!TUNABLE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        throw new Error(`anagenesis: "${key}" is outside the tunable envelope`)
      }
    }
    // UCB1 over the arm space (param, direction). Cold arms get +Infinity so the
    // first proposal explores every knob before exploiting any.
    const tuning = this.#tuning()
    const totalPulls = Object.values(tuning.arms).reduce((sum, arm) => sum + arm.pulls, 0)
    let best = /** @type {any} */ (null)
    for (const key of candidates) {
      const spec = PARAM_ENVELOPE[key]
      const current = this.value(key)
      for (const direction of [1, -1]) {
        const target = current + direction * spec.step
        if (target < spec.min || target > spec.max) continue
        const armId = `${key}:${direction}`
        const arm = tuning.arms[armId] ?? { pulls: 0, reward: 0 }
        const mean = arm.pulls === 0 ? 0 : arm.reward / arm.pulls
        const bonus = arm.pulls === 0 ? Number.POSITIVE_INFINITY : Math.sqrt((2 * Math.log(totalPulls + 1)) / arm.pulls)
        const score = mean + bonus + (direction > 0 ? 0.001 : 0)
        if (best === null || score > best.score) {
          best = { score, param: key, from: current, to: target, direction, armId, arm, mean }
        }
      }
    }
    if (best === null) throw new Error('anagenesis: every knob sits at its envelope edge; nothing to propose')
    const samples = tuning.samples.length
    return {
      param: best.param,
      from: best.from,
      to: best.to,
      delta: best.to - best.from,
      rationale: `UCB1(${best.armId}) mean=${best.mean.toFixed(3)} samples=${samples} objective=${objective}`,
      armReward: best.mean,
      samples,
    }
  }

  /**
   * Apply a proposal. Refuses when: safe mode is on, the sample budget is not
   * met, or the previous change is still inside its evaluation window.
   * @param {object} proposal
   * @param {{ reason: string, scope?: string, force?: boolean, by?: string }} opts
   * @returns {Promise<{ auditId: string, param: string, from: number, to: number, seq: number, revert: Function }>}
   */
  async apply(proposal, opts) {
    if (this.safeMode && opts.force !== true) {
      throw new Error('anagenesis: safeMode is on; meta tuning is disabled (set safeMode: false in the plugin config to re-enable)')
    }
    const minSamples = this.value('meta.minSamples')
    const tuning = this.#tuning()
    if (!opts.force && tuning.samples.length < minSamples) {
      throw new Error(`anagenesis: only ${tuning.samples.length} feedback samples (need ${minSamples}); call ana_feedback after a few recalls first`)
    }
    // One change in flight at a time: two overlapping changes cannot be told
    // apart by the samples that follow them, so the comparison would be noise.
    const pending = tuning.history[tuning.history.length - 1]
    if (!opts.force && pending !== undefined && pending.evaluatedAt === undefined) {
      const since = tuning.samples.length - Number(pending.samplesAt ?? 0)
      if (since < EVALUATION_WINDOW) {
        throw new Error(`anagenesis: the change "${pending.auditId}" is still being evaluated (${since}/${EVALUATION_WINDOW} samples); send feedback first, or pass force: true`)
      }
    }
    const spec = PARAM_ENVELOPE[proposal.param]
    if (spec === undefined) throw new Error(`anagenesis: "${proposal.param}" is not tunable`)
    const to = clamp(Number(proposal.to), spec.min, spec.max)
    const from = this.value(proposal.param)
    const scope = opts.scope ?? 'global'
    const auditId = `tune_${this.#store.state.version + 1}`
    // Credit the arm *before* writing, so the credit and the parameter change are
    // one transaction — `rollback(auditId)` then restores the arm as well, and a
    // restart keeps whatever the previous process learned about it.
    const direction = to >= from ? 1 : -1
    const armId = `${proposal.param}:${direction}`
    const arm = { ...(tuning.arms[armId] ?? { pulls: 0, reward: 0 }) }
    arm.pulls += 1
    if (proposal.reward !== undefined) {
      arm.reward += Number(proposal.reward)
    }
    const history = [...tuning.history, {
      metric: this.#metric(),
      at: Date.now(),
      auditId,
      armId,
      samplesAt: tuning.samples.length,
    }].slice(-100)
    const result = await this.#store.transact({
      paramsSet: { [scope]: { [proposal.param]: to } },
      tuningSet: this.#patch({ samples: tuning.samples, arms: { ...tuning.arms, [armId]: arm }, history }),
      auditAppend: [{
        id: auditId,
        at: Date.now(),
        type: 'meta.tune',
        detail: { param: proposal.param, from, to, rationale: proposal.rationale, reason: opts.reason, proposal },
      }],
    }, {
      type: 'meta.tune',
      scope,
      by: opts.by ?? 'agent',
      payload: { auditId, param: proposal.param, from, to, reason: opts.reason },
    })
    return { auditId, param: proposal.param, from, to, seq: result.seq, revert: result.revert }
  }

  /**
   * Evaluate whether an applied change actually helped. Called after enough new
   * samples; a regression returns `{ rollback: true }` and the caller (or the
   * agent) can then run `rollback(auditId)`.
   * @returns {{ metric: number, samples: number, delta: number, rollback: boolean, note: string }}
   */
  evaluate() {
    const tuning = this.#tuning()
    const metric = this.#metric()
    const previous = tuning.history[tuning.history.length - 1]
    const epsilon = this.value('meta.improvementEpsilon')
    if (previous === undefined) {
      return { metric, samples: tuning.samples.length, delta: 0, rollback: false, window: EVALUATION_WINDOW, note: 'no previous tune to compare against' }
    }
    // Compare like with like: the baseline was recorded at apply time, so only
    // the samples that arrived *after* it describe this change.
    const since = tuning.samples.slice(Number(previous.samplesAt ?? tuning.samples.length))
    if (since.length === 0) {
      return {
        metric,
        samples: tuning.samples.length,
        delta: 0,
        rollback: false,
        window: EVALUATION_WINDOW,
        pending: since.length,
        note: `no feedback since ${previous.auditId}; send ${EVALUATION_WINDOW} samples before judging it`,
      }
    }
    const after = since.reduce((sum, value) => sum + value, 0) / since.length
    const delta = after - previous.metric
    const rollback = delta < -epsilon
    return {
      metric: Number(after.toFixed(4)),
      samples: tuning.samples.length,
      delta: Number(delta.toFixed(4)),
      rollback,
      window: EVALUATION_WINDOW,
      pending: since.length,
      auditId: previous.auditId,
      note: rollback
        ? `metric regressed by ${Math.abs(delta).toFixed(3)} (> ${epsilon}); roll back ${previous.auditId}`
        : `metric ${delta >= 0 ? 'improved' : 'drifted'} by ${delta.toFixed(3)} (within epsilon ${epsilon})`,
    }
  }

  /**
   * Undo an applied tuning change by its audit id. The audit entry stores the
   * pre-values, so this works after a restart.
   * @param {string} auditId
   * @param {{ reason?: string }} [opts]
   * @returns {Promise<{ param: string, restored: number, seq: number, revert: Function }>}
   */
  async rollback(auditId, opts = {}) {
    const entry = [...this.#store.state.audit].reverse().find((row) => row.id === auditId && row.type === 'meta.tune')
    if (entry === undefined) throw new Error(`anagenesis: no tuning audit row "${auditId}"`)
    const detail = /** @type {any} */ (entry.detail)
    const seq = [...this.#store.recentEvents({ limit: 500 })].find((event) => event.type === 'meta.tune' && event.payload?.auditId === auditId)?.seq
    if (seq === undefined) {
      throw new Error(`anagenesis: tuning "${auditId}" is no longer in the journal window; cannot derive its inverse`)
    }
    const result = await this.#store.revert(seq, opts.reason ?? `rollback ${auditId}`)
    return { param: detail.param, restored: detail.from, seq: result.seq, revert: result.revert }
  }

  /** @returns {{ metric: number, samples: number, applied: number, objectiveHistory: any[] }} */
  report() {
    const tuning = this.#tuning()
    return {
      metric: this.#metric(),
      samples: tuning.samples.length,
      ready: tuning.samples.length >= this.value('meta.minSamples'),
      applied: tuning.history.length,
      evaluation: this.evaluate(),
      objectiveHistory: tuning.history.slice(-10),
    }
  }

  /** @returns {number} mean reward over the recent window */
  #metric() {
    const samples = this.#tuning().samples
    if (samples.length === 0) return 0
    const window = samples.slice(-20)
    return window.reduce((sum, value) => sum + value, 0) / window.length
  }
}

/**
 * Lifecycle suggestions from observed usage — the consumers for
 * `promote.hitRateThreshold` / `demote.missRateThreshold`.
 *
 * Before this existed, both knobs were declared in the envelope and read by
 * nobody, so the tuner could spend its exploration budget moving a number that
 * changed nothing. The rates come from `ana_feedback` (the only writer of
 * `access.hits` / `access.misses`), which keeps the suggestion auditable: every
 * number here traces back to a feedback row.
 *
 * Pure and read-only: it suggests, it never writes. Acting on it is `ana_promote`
 * / `ana_demote`, with a reason and a revertible transaction.
 * @param {any} state
 * @param {{ promoteAt?: number, demoteAt?: number, minSamples?: number }} [opts]
 * @returns {{ promoteAt: number, demoteAt: number, promotable: any[], demotable: any[] }}
 */
export function lifecycleSuggestions(state, opts = {}) {
  const promoteAt = Number(opts.promoteAt ?? 0.3)
  const demoteAt = Number(opts.demoteAt ?? 0.6)
  const minSamples = Math.max(1, Number(opts.minSamples ?? 2))
  /** @type {any[]} */
  const promotable = []
  /** @type {any[]} */
  const demotable = []
  for (const record of Object.values(state?.memories ?? {})) {
    const row = /** @type {any} */ (record)
    if (row.state === 'retired' || row.state === 'expired') continue
    const hits = Number(row.access?.hits ?? 0)
    const misses = Number(row.access?.misses ?? 0)
    const total = hits + misses
    if (total < minSamples) continue
    const hitRate = hits / total
    const missRate = misses / total
    const entry = { id: row.id, state: row.state, hits, misses, hitRate: Number(hitRate.toFixed(3)) }
    if ((row.state === 'draft' || row.state === 'active') && hits >= minSamples && hitRate >= promoteAt) {
      promotable.push(entry)
    }
    if ((row.state === 'active' || row.state === 'verified') && misses >= minSamples && missRate >= demoteAt) {
      demotable.push({ ...entry, missRate: Number(missRate.toFixed(3)) })
    }
  }
  const byRate = (key) => (a, b) => b[key] - a[key]
  return {
    promoteAt,
    demoteAt,
    promotable: promotable.sort(byRate('hitRate')).slice(0, 5),
    demotable: demotable.sort(byRate('missRate')).slice(0, 5),
  }
}
