/**
 * Retrieval: intent -> plan -> candidates -> fusion -> token-budget packing -> render.
 *
 * The agent expresses an intent ("I am orienting", "I must not repeat a known
 * mistake"), never a query string over a record shape. The intent expands into a
 * RecallPlan (which kinds/states, which weights, which granularity, how many
 * tokens), the plan is scored against the store, and the strategy stack in scope
 * contributes score deltas, vetoes and section formatting at every step.
 *
 * Scoring (all terms normalized to [0,1] before weighting):
 *   score = wLex*sat(bm25) + wVec*(cos+1)/2 + wRecency*2^(-age/halfLife)
 *         + wConf*confidence + wSal*salience + wAccess*sat(log1p(hits))
 *         + sum(strategy score deltas)
 * Packing is MMR-lite: greedy max(score - lambda * maxCos(alreadySelected)),
 * stopping at the token budget, so a high-recall plan does not ship five copies
 * of the same belief.
 * @module dsh-anagenesis/memory/recall
 */

import { clamp, estimateTokens, saturate, tokenize } from '../util.js'
import { cosine, embed } from './embed.js'
import { effectiveSalience } from '../store/schema.js'

/** Intent table: what the agent is about to do decides how memory is shaped. */
export const INTENTS = Object.freeze({
  orient: {
    label: 'orient before starting work',
    kinds: ['fact', 'constraint', 'procedure', 'preference'],
    states: ['verified', 'active', 'locked'],
    minConfidence: 0.45,
    granularity: 'gist',
    tokenBudget: 1200,
    weights: { lex: 0.45, vec: 0.25, recency: 0.2, conf: 0.1, sal: 0.05, access: 0.05 },
  },
  recall_fact: {
    label: 'answer a factual question from memory',
    kinds: ['fact', 'constraint'],
    states: ['verified', 'active', 'locked'],
    minConfidence: 0.5,
    granularity: 'claims',
    tokenBudget: 900,
    weights: { lex: 0.4, vec: 0.3, recency: 0.1, conf: 0.15, sal: 0.05, access: 0.05 },
  },
  recall_precedent: {
    label: 'find how this was handled before',
    kinds: ['episode', 'heuristic', 'procedure'],
    states: ['verified', 'active', 'locked', 'deprecated'],
    minConfidence: 0.3,
    granularity: 'claims',
    tokenBudget: 1800,
    weights: { lex: 0.35, vec: 0.3, recency: 0.2, conf: 0.05, sal: 0.05, access: 0.1 },
  },
  avoid_mistake: {
    label: 'avoid repeating a known failure',
    kinds: ['failure', 'constraint'],
    states: ['verified', 'active', 'locked', 'draft', 'deprecated'],
    minConfidence: 0.2,
    granularity: 'claims',
    tokenBudget: 1500,
    weights: { lex: 0.35, vec: 0.25, recency: 0.15, conf: 0.1, sal: 0.1, access: 0.05 },
  },
  reuse_procedure: {
    label: 'reuse a proven procedure',
    kinds: ['procedure', 'heuristic'],
    states: ['verified', 'locked', 'active'],
    minConfidence: 0.6,
    granularity: 'full',
    tokenBudget: 2200,
    weights: { lex: 0.4, vec: 0.3, recency: 0.05, conf: 0.2, sal: 0.05, access: 0.1 },
  },
  verify: {
    label: 'check what is actually established',
    kinds: null,
    states: ['active', 'verified', 'locked'],
    minConfidence: 0,
    granularity: 'claims',
    tokenBudget: 1400,
    weights: { lex: 0.35, vec: 0.25, recency: 0.1, conf: 0.25, sal: 0.05, access: 0.05 },
  },
  contrast: {
    label: 'see both sides of a contested belief',
    kinds: ['hypothesis', 'fact', 'heuristic', 'failure'],
    states: ['verified', 'active', 'locked', 'draft'],
    minConfidence: 0,
    granularity: 'claims',
    tokenBudget: 2000,
    weights: { lex: 0.35, vec: 0.25, recency: 0.15, conf: 0.05, sal: 0.15, access: 0.05 },
    diversity: 0.4,
  },
})

export const GRANULARITIES = Object.freeze(['gist', 'claims', 'full', 'timeline'])

/**
 * Merge scope params over intent defaults over caller overrides.
 * @param {string} intent
 * @param {Record<string, number|string|boolean>} [scopeParams]
 * @returns {any}
 */
export function defaultsFor(intent, scopeParams = {}) {
  const base = INTENTS[intent] ?? INTENTS.orient
  return {
    ...base,
    weights: { ...base.weights },
    minConfidence: pick(scopeParams, `recall.${intent}.minConfidence`, base.minConfidence),
    tokenBudget: pick(scopeParams, `recall.${intent}.tokenBudget`, base.tokenBudget),
    halfLifeMs: pick(scopeParams, 'recall.halfLifeMs', 14 * 24 * 3600 * 1000),
    explorationRate: pick(scopeParams, 'recall.explorationRate', 0.25),
    diversity: pick(scopeParams, 'recall.diversity', base.diversity ?? 0.25),
  }
}

/**
 * @param {Record<string, any>} params
 * @param {string} key
 * @param {any} fallback
 * @returns {any}
 */
function pick(params, key, fallback) {
  return params[key] === undefined ? fallback : params[key]
}

/**
 * @param {object} request
 * @param {string} [request.intent]
 * @param {string} [request.query]
 * @param {string[]} [request.kinds]
 * @param {number} [request.maxTokens]
 * @param {number} [request.minConfidence]
 * @param {string} [request.granularity]
 * @param {{ since?: number, until?: number }} [request.timeframe]
 * @param {{ session?: string, workspace?: string, preset?: string }} [request.scope]
 * @param {number} [request.limit]
 * @param {Record<string, number|string|boolean>} [params]
 * @param {string} [callerScope] the scope asking for memory; salience is
 *   partitioned by it (schema v4), so this is what decides whose numbers rank.
 * @param {(text: string) => number[]} [embedFn] the active vector backend. It
 *   has to be the one that produced the stored vectors: comparing a query from
 *   one space against records from another ranks noise.
 * @returns {any} RecallPlan
 */
export function planRecall(request = {}, params = {}, callerScope = 'global', embedFn = embed) {
  const intent = INTENTS[request.intent] ? request.intent : 'orient'
  const defaults = defaultsFor(intent, params)
  const granularity = GRANULARITIES.includes(request.granularity) ? request.granularity : defaults.granularity
  return {
    intent,
    label: defaults.label,
    query: String(request.query ?? '').trim(),
    tokens: tokenize(request.query ?? ''),
    kinds: Array.isArray(request.kinds) && request.kinds.length > 0 ? request.kinds : defaults.kinds,
    states: defaults.states,
    minConfidence: clamp(request.minConfidence ?? defaults.minConfidence, 0, 1),
    granularity,
    tokenBudget: Math.max(64, Math.round(request.maxTokens ?? defaults.tokenBudget)),
    // An explicit caller instruction outranks the strategy stack; these flags
    // are what stop a mode from silently overruling "at most N tokens".
    tokenBudgetLocked: request.maxTokens !== undefined,
    confidenceLocked: request.minConfidence !== undefined,
    limit: Math.max(1, Math.min(request.limit ?? 40, 200)),
    timeframe: {
      since: request.timeframe?.since ?? null,
      until: request.timeframe?.until ?? null,
    },
    scope: request.scope ?? {},
    callerScope,
    weights: defaults.weights,
    halfLifeMs: defaults.halfLifeMs,
    explorationRate: defaults.explorationRate,
    diversity: defaults.diversity,
    queryVector: request.query ? embedFn(String(request.query)) : null,
  }
}

/**
 * Inverted index over live records. Rebuilt lazily per snapshot version.
 * @param {import('../store/schema.js').AnagenesisState} state
 * @returns {{ postings: Map<string, Map<string, number>>, lengths: Map<string, number>, avgdl: number, total: number }}
 */
export function buildIndex(state) {
  const postings = new Map()
  const lengths = new Map()
  let total = 0
  for (const record of Object.values(state.memories)) {
    if (record.state === 'retired') continue
    const tokens = tokenize(`${record.subject} ${record.gist} ${record.body} ${record.tags.join(' ')}`)
    const counts = new Map()
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    for (const [token, count] of counts) {
      let bucket = postings.get(token)
      if (bucket === undefined) {
        bucket = new Map()
        postings.set(token, bucket)
      }
      bucket.set(record.id, count)
    }
    lengths.set(record.id, tokens.length)
    total += tokens.length
  }
  return { postings, lengths, avgdl: lengths.size === 0 ? 1 : total / lengths.size, total }
}

/**
 * Okapi BM25 over the in-memory inverted index.
 * @param {string[]} queryTokens
 * @param {string} id
 * @param {{ postings: Map<string, Map<string, number>>, lengths: Map<string, number>, avgdl: number }} index
 * @param {number} docCount
 * @returns {number}
 */
export function bm25(queryTokens, id, index, docCount) {
  const k1 = 1.2
  const b = 0.75
  const length = index.lengths.get(id) ?? 0
  let score = 0
  for (const token of new Set(queryTokens)) {
    const df = index.postings.get(token)?.size ?? 0
    if (df === 0) continue
    const tf = index.postings.get(token)?.get(id) ?? 0
    if (tf === 0) continue
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5))
    score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (length / index.avgdl))))
  }
  return score
}

/**
 * @param {import('../store/schema.js').MemoryRecord} record
 * @param {any} plan
 * @param {number} now
 * @param {number} halfLifeMs
 * @returns {boolean}
 */
export function inScope(record, plan) {
  const since = plan.timeframe.since
  const until = plan.timeframe.until
  if (since !== null && record.createdAt < since) return false
  if (until !== null && record.createdAt > until) return false
  if (record.scope.global) return true
  const wanted = plan.scope
  if (wanted.session !== undefined && record.scope.session === wanted.session) return true
  if (wanted.workspace !== undefined && record.scope.workspace === wanted.workspace) return true
  if (wanted.preset !== undefined && record.scope.preset === wanted.preset) return true
  return Object.keys(wanted).length === 0
}

/**
 * Run a recall. `engine` is the Layer-2 strategy engine; every hook is optional.
 * @param {import('../store/store.js').MemoryStore} store
 * @param {object} request
 * @param {{ params?: Record<string, any>, engine?: any, scope?: string, now?: () => number, indexCache?: { version: number, index: any } }} [opts]
 * @returns {Promise<any>}
 */
export async function recall(store, request = {}, opts = {}) {
  const now = (opts.now ?? Date.now)()
  const state = store.state
  const params = opts.params ?? state.params.global ?? {}
  const engine = opts.engine
  const basePlan = planRecall(request, params, opts.scope ?? 'global', opts.embed)
  // The stack reshapes the plan before anything is scored: explore widens what
  // counts as a candidate, exploit narrows via its filter, distill shrinks the
  // budget. Caller-specified maxTokens/minConfidence stay locked.
  const plan = engine?.plan !== undefined ? engine.plan(basePlan) : basePlan

  let index = opts.indexCache?.index
  if (index === undefined || opts.indexCache?.version !== state.version) {
    index = buildIndex(state)
    if (opts.indexCache) {
      opts.indexCache.index = index
      opts.indexCache.version = state.version
    }
  }

  const docCount = index.lengths.size || 1
  const candidates = []
  const rejected = { state: 0, kind: 0, confidence: 0, scope: 0, expired: 0, strategy: 0 }

  for (const record of Object.values(state.memories)) {
    if (record.state === 'retired') continue
    if (!plan.states.includes(record.state)) { rejected.state++; continue }
    if (plan.kinds !== null && !plan.kinds.includes(record.kind)) { rejected.kind++; continue }
    if (record.confidence < plan.minConfidence) { rejected.confidence++; continue }
    if (!inScope(record, plan)) { rejected.scope++; continue }
    if (record.expiresAt !== null && record.expiresAt <= now && record.state !== 'expired') { rejected.expired++; continue }
    if (engine !== undefined && engine.admits !== undefined && !engine.admits(record, plan)) { rejected.strategy++; continue }
    candidates.push(scoreRecord(record, plan, index, docCount, now, engine))
  }

  const packed = pack(candidates, plan, now, engine)
  const text = renderInjection(packed.selected, plan, engine)

  return {
    intent: plan.intent,
    granularity: plan.granularity,
    query: plan.query,
    selected: packed.selected.map((row) => ({
      id: row.record.id,
      kind: row.record.kind,
      state: row.record.state,
      confidence: Number(row.record.confidence.toFixed(3)),
      score: Number(row.score.toFixed(4)),
      gist: row.record.gist,
      reason: row.reason,
    })),
    dropped: packed.dropped.length,
    tokenCost: text.tokens,
    tokenBudget: plan.tokenBudget,
    text: text.text,
    strategy: engine?.describe?.() ?? ['(no engine)'],
    rejected,
    trace: packed.selected.map((row) => ({ id: row.record.id, parts: row.parts })),
  }
}

/**
 * @param {import('../store/schema.js').MemoryRecord} record
 * @param {any} plan
 * @param {any} index
 * @param {number} docCount
 * @param {number} now
 * @param {any} engine
 * @returns {{ record: any, score: number, parts: Record<string, number>, reason: string, vector: number[] }}
 */
export function scoreRecord(record, plan, index, docCount, now, engine) {
  const lex = plan.tokens.length === 0 ? 0 : saturate(bm25(plan.tokens, record.id, index, docCount), 1.5)
  const vec = plan.queryVector === null ? 0 : (cosine(plan.queryVector, record.embedding) + 1) / 2
  const halfLife = engine?.halfLifeMs !== undefined ? engine.halfLifeMs(record, plan) : plan.halfLifeMs
  const age = Math.max(0, now - record.updatedAt)
  const recency = !Number.isFinite(halfLife) || halfLife <= 0 ? 1 : Math.pow(2, -age / halfLife)
  const access = saturate(Math.log1p(record.access.hits), 1.2)
  const parts = {
    lex: plan.weights.lex * lex,
    vec: plan.weights.vec * vec,
    recency: plan.weights.recency * recency,
    conf: plan.weights.conf * record.confidence,
    // Salience is read through the asking scope: one agent's citations must not
    // re-rank another agent's recall (schema v4).
    sal: plan.weights.sal * effectiveSalience(record, plan.callerScope),
    access: plan.weights.access * access,
    strategy: 0,
  }
  let reason = `lex=${lex.toFixed(2)} vec=${vec.toFixed(2)} recency=${recency.toFixed(2)}`
  if (engine?.score !== undefined) {
    const contribution = engine.score(record, plan)
    parts.strategy = contribution.delta
    if (contribution.reason !== undefined) reason = `${reason}; ${contribution.reason}`
  }
  const score = Object.values(parts).reduce((sum, value) => sum + value, 0)
  return { record, score, parts, reason, vector: record.embedding }
}

/**
 * MMR-lite packing under a token budget.
 * @param {ReturnType<typeof scoreRecord>[]} candidates
 * @param {any} plan
 * @param {number} now
 * @param {any} engine
 * @returns {{ selected: ReturnType<typeof scoreRecord>[], dropped: ReturnType<typeof scoreRecord>[] }}
 */
export function pack(candidates, plan, now, engine) {
  const ranked = [...candidates].sort((a, b) => b.score - a.score)
  /** @type {ReturnType<typeof scoreRecord>[]} */
  const selected = []
  let budget = plan.tokenBudget
  for (const candidate of ranked) {
    if (selected.length >= plan.limit) break
    const cost = estimateTokens(renderMemory(candidate.record, plan.granularity, engine)) + 8
    if (cost > budget) continue
    if (selected.length > 0 && plan.diversity > 0) {
      let maxSim = 0
      for (const chosen of selected) maxSim = Math.max(maxSim, (cosine(candidate.vector, chosen.vector) + 1) / 2)
      const penalty = plan.diversity * maxSim
      candidate.parts.diversity = -penalty
      candidate.score -= penalty
      if (candidate.score <= 0) continue
    }
    candidate.tokenCost = cost
    selected.push(candidate)
    budget -= cost
  }
  const dropped = ranked.filter((candidate) => !selected.includes(candidate))
  return { selected, dropped }
}

/**
 * @param {import('../store/schema.js').MemoryRecord} record
 * @param {string} granularity
 * @param {any} [engine]
 * @returns {string}
 */
export function renderMemory(record, granularity, engine) {
  const format = engine?.format !== undefined ? engine.format(record, { granularity }) : null
  const note = format?.note === undefined ? '' : ` ${format.note}`
  const head = `(${record.kind}/${record.state} c=${record.confidence.toFixed(2)})`
  if (granularity === 'gist') return `- ${head} ${record.gist}${note}`
  if (granularity === 'full') {
    return [
      `- ${head} ${record.subject}${note}`,
      `  id=${record.id}`,
      ...record.body.split('\n').map((line) => `  ${line}`),
    ].join('\n')
  }
  if (granularity === 'timeline') {
    return `- ${new Date(record.createdAt).toISOString().slice(0, 10)} ${head} ${record.gist}${note}`
  }
  const claims = record.body.split('\n').filter((line) => line.trim() !== '').slice(0, 3)
  return [`- ${head} ${record.subject}${note}`, ...claims.map((line) => `  · ${line}`)].join('\n')
}

/**
 * Format the whole injection block. Strategy `format` hooks may move a record
 * into a named bucket and set its order; the default buckets are by kind.
 * @param {ReturnType<typeof scoreRecord>[]} selected
 * @param {any} plan
 * @param {any} engine
 * @returns {{ text: string, tokens: number, buckets: string[] }}
 */
export function renderInjection(selected, plan, engine) {
  if (selected.length === 0) {
    return { text: '', tokens: 0, buckets: [] }
  }
  /** @type {Map<string, { order: number, lines: string[] }>} */
  const buckets = new Map()
  let bodyTokens = 0
  for (const row of selected) {
    const format = engine?.format !== undefined ? engine.format(row.record, { granularity: plan.granularity }) : null
    const bucket = format?.bucket ?? `${ORDER_HINTS[row.record.kind] ?? 50}.${row.record.kind}`
    const entry = buckets.get(bucket) ?? { order: Number(bucket.split('.')[0]) || 50, lines: [] }
    const line = renderMemory(row.record, plan.granularity, engine)
    bodyTokens += estimateTokens(line) + 2
    entry.lines.push(line)
    buckets.set(bucket, entry)
  }
  const ordered = [...buckets.entries()].sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
  const header = `<anagenesis-memory intent="${plan.intent}" strategy="${(engine?.describe?.() ?? []).join('+')}" `
    + `items="${selected.length}" approxTokens="${bodyTokens}" granularity="${plan.granularity}">`
  const parts = [header]
  for (const [bucket, entry] of ordered) {
    parts.push(`## ${bucket.split('.').slice(1).join('.')}`)
    parts.push(...entry.lines)
  }
  parts.push('</anagenesis-memory>')
  const text = parts.join('\n')
  return { text, tokens: estimateTokens(text), buckets: ordered.map(([bucket]) => bucket) }
}

const ORDER_HINTS = Object.freeze({
  constraint: 10,
  failure: 20,
  procedure: 30,
  preference: 40,
  heuristic: 45,
  fact: 50,
  episode: 60,
  hypothesis: 70,
})
