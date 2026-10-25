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
 *   relevance = (wLex*coverage + wVec*cos+) / (wLex + wVec)
 *   score = relevance + wRecency*2^(-age/halfLife) + wConf*confidence
 *         + wSal*salience + wAccess*sat(log1p(hits)) + wScope*scopeMatch
 *         + sum(strategy score deltas)
 *   where `coverage` is IDF-weighted query coverage (not raw BM25: raw BM25
 *   grows with the number of matched terms and made a long, vaguely related
 *   record outrank a short, exact one), and `cos+` is `max(0, cos)` — the old
 *   `(cos+1)/2` gave every record a 0.5 semantic floor, so unrelated records
 *   collected 0.13 of free score and the ranking could not separate them.
 *
 * Two gates run before packing, because a composite score that always adds
 * priors can never say "nothing here is relevant":
 *   - an absolute floor (`recall.minRelevance`), and
 *   - a relative floor (a candidate must reach `relevanceMargin` of the best
 *     candidate's relevance), so one strong match does not drag nine weak ones
 *     into the context window.
 * Both are skipped for an empty query (the "orient" briefing case).
 * Packing is MMR-lite: greedy max(score - lambda * maxCos(alreadySelected)),
 * stopping at the token budget, so a high-recall plan does not ship five copies
 * of the same belief.
 *
 * **Scope isolation lives in this file's candidate loop**, and that is the point:
 * there is exactly one retrieval implementation, so there is exactly one place
 * the filter can be forgotten — and it is a closed set (`scopeMatch`), not a
 * default-allow. Every entry point (tools, service.recall, the viz mirror) runs
 * through `recall()` or through `inScope`, and a plan that names no project
 * excludes every project record instead of admitting them.
 * @module dsh-anagenesis/memory/recall
 */

import { clamp, estimateTokens, saturate, tokenizeTerms } from '../util.js'
import { cosine, embed } from './embed.js'
import { effectiveSalience, isLegacyUnscoped } from '../store/schema.js'
import { CONFLICT_PENALTY, createScopeFilter, detectScopeConflicts, scopeMatch } from '../scope/index.js'
import { scopeLabel } from '../scope/project.js'

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
 * A candidate must reach this fraction of the best candidate's relevance to be
 * injected. 0.45 was chosen on `bench/`: lower lets topical noise back in,
 * higher starts dropping the second and third genuinely useful record.
 */
export const RELEVANCE_MARGIN = 0.45

/**
 * MMR only ever considers this many top-scoring candidates. Re-scoring the
 * whole store after every pick would be O(N²); re-scoring a bounded shortlist
 * is the standard compromise and is enough for a context window.
 */
export const MMR_SHORTLIST = 120

/**
 * Per-intent multiplier on the relevance floor.
 *
 * The floor is one number on purpose — seven tunable floors would be seven ways
 * to drift. But the intents are not asking the same question: `verify` and
 * `orient` are "show me what exists" (a small store must still answer them),
 * while `recall_fact` and `reuse_procedure` are "answer this one question" and
 * should stay strict. The factors encode that difference once, in code.
 */
export const INTENT_FLOOR_FACTOR = Object.freeze({
  orient: 0.55,
  recall_fact: 1,
  recall_precedent: 0.9,
  avoid_mistake: 0.8,
  reuse_procedure: 1,
  verify: 0.5,
  contrast: 0.7,
})

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
    weights: {
      ...base.weights,
      // The scope term is what makes "this project's own experience" outrank an
      // otherwise identical record from somewhere else. Kept small on purpose:
      // scope decides *between* comparable candidates, it does not replace
      // relevance — a highly relevant local memory still beats a barely relevant
      // one, and an irrelevant local memory is still not injected.
      scope: pick(scopeParams, 'recall.scopeWeight', 0.12),
    },
    minConfidence: pick(scopeParams, `recall.${intent}.minConfidence`, base.minConfidence),
    tokenBudget: pick(scopeParams, `recall.${intent}.tokenBudget`, base.tokenBudget),
    halfLifeMs: pick(scopeParams, 'recall.halfLifeMs', 14 * 24 * 3600 * 1000),
    explorationRate: pick(scopeParams, 'recall.explorationRate', 0.25),
    diversity: pick(scopeParams, 'recall.diversity', base.diversity ?? 0.25),
    crossProjectFactor: pick(scopeParams, 'recall.crossProjectFactor', 0.4),
    // Query relevance floor. There was no floor before, so recall filled the
    // token budget with whatever ranked highest — a query about Kubernetes got
    // twelve unrelated records. Measured against `bench/`: see the table in
    // `HANDOFF.md` §5.
    minRelevance: pick(scopeParams, 'recall.minRelevance', 0.22),
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
 * @param {{ projectId?: string|null, sessionId?: string|null, crossProject?: boolean, reason?: string }} [context]
 *   **Where this call happens.** `projectId` is the fingerprint of the project
 *   the caller is working in; when it is absent the filter admits no project
 *   record at all (fail closed) rather than falling back to "everything".
 *   `crossProject: true` is the explicit authorization that lets another
 *   project's memories into the candidate pool — down-weighted and labelled.
 * @returns {any} RecallPlan
 */
export function planRecall(request = {}, params = {}, callerScope = 'global', embedFn = embed, context = {}) {
  const intent = INTENTS[request.intent] ? request.intent : 'orient'
  const defaults = defaultsFor(intent, params)
  const granularity = GRANULARITIES.includes(request.granularity) ? request.granularity : defaults.granularity
  // The filter is built here, once, from the two things that decide isolation:
  // the caller's project (from the context, never from the *records*) and the
  // explicit authorization flag. `request.scope` remains a legacy narrowing hint
  // for the caller's own session/workspace, but it can no longer *widen* the
  // search: `crossProject` is the only widening switch, and it is spelled out.
  const scopeFilter = context.scopeFilter ?? createScopeFilter({
    projectId: context.projectId ?? null,
    sessionId: context.sessionId ?? request.scope?.session ?? null,
    crossProject: context.crossProject === true || request.crossProject === true,
    authorized: context.crossProject === true || request.crossProject === true,
    reason: context.reason ?? '',
  })
  return {
    intent,
    label: defaults.label,
    query: String(request.query ?? '').trim(),
    tokens: tokenizeTerms(request.query ?? ''),
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
    scopeFilter,
    // The session status pulse (gear / permissions / current project). It is
    // carried on the plan so exactly one renderer emits it.
    pulse: context.pulse ?? null,
    callerScope,
    weights: defaults.weights,
    halfLifeMs: defaults.halfLifeMs,
    explorationRate: defaults.explorationRate,
    diversity: defaults.diversity,
    crossProjectFactor: defaults.crossProjectFactor,
    // An explicit caller floor wins; otherwise the intent's factor scales the
    // configured floor (see INTENT_FLOOR_FACTOR).
    minRelevance: request.minRelevance !== undefined
      ? clamp(request.minRelevance, 0, 1)
      : clamp(defaults.minRelevance * (INTENT_FLOOR_FACTOR[intent] ?? 1), 0, 1),
    // How far below the best candidate's relevance a weaker one may sit. Not a
    // tunable: it is a property of the query set, not of one installation.
    relevanceMargin: RELEVANCE_MARGIN,
    queryVector: request.query ? embedFn(String(request.query)) : null,
  }
}

/**
 * Inverted index over live records. Cached by the service on the identity of
 * `state.memories`, so an audit-only transaction does not rebuild it.
 * @param {import('../store/schema.js').AnagenesisState} state
 * @returns {{ postings: Map<string, Map<string, number>>, lengths: Map<string, number>, avgdl: number, total: number }}
 */
export function buildIndex(state) {
  const postings = new Map()
  const lengths = new Map()
  let total = 0
  for (const record of Object.values(state.memories)) {
    if (record.state === 'retired') continue
    const tokens = tokenizeTerms(`${record.subject} ${record.gist} ${record.body} ${record.tags.join(' ')}`)
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
  return { postings, lengths, avgdl: lengths.size === 0 ? 1 : total / lengths.size, total, docCount: lengths.size }
}

/**
 * Lexical match of a query against one record, as three numbers.
 *
 * `coverage` is IDF-weighted coverage over the query terms the store *knows*
 * (0..1) — the ranking signal. It answers "of the words this store understands,
 * how much does this record contain", so an unknown product name in the query
 * does not by itself punish a record.
 *
 * `coverageFull` puts the unknown terms back into the denominator at maximum
 * IDF. That is the *gate* signal: a query made mostly of words this store has
 * never seen ("Kubernetes Ingress 证书") must not look like a perfect match on
 * the one common word it happens to share.
 *
 * `evidence` is the raw IDF mass that matched, kept for traces.
 *
 * Replaces raw Okapi BM25 in ranking: BM25 is unbounded and grows with the
 * number of matched terms, so a long record sharing five common CJK bigrams
 * outranked the one record that actually answered the query.
 * @param {string[]} queryTokens
 * @param {string} id
 * @param {{ postings: Map<string, Map<string, number>>, lengths: Map<string, number>, avgdl: number, docCount?: number }} index
 * @param {number} [docCount] fallback when the index predates `docCount`
 * @returns {{ coverage: number, coverageFull: number, evidence: number }}
 */
export function lexicalMatch(queryTokens, id, index, docCount) {
  const total = index.docCount ?? docCount ?? index.lengths.size ?? 1
  const length = index.lengths.get(id) ?? 0
  const k1 = 1.2
  const b = 0.75
  let knownIdf = 0
  let allIdf = 0
  let matchedIdf = 0
  for (const token of new Set(queryTokens)) {
    const df = index.postings.get(token)?.size ?? 0
    const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
    allIdf += idf
    if (df > 0) knownIdf += idf
    const tf = df === 0 ? 0 : (index.postings.get(token)?.get(id) ?? 0)
    if (tf === 0) continue
    matchedIdf += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (length / index.avgdl))))
  }
  // The length-normalised term factor can exceed 1 for short documents; a
  // coverage above 1 would let one short record outrank a perfect longer match.
  return {
    coverage: knownIdf === 0 ? 0 : Math.min(1, matchedIdf / knownIdf),
    coverageFull: allIdf === 0 ? 0 : Math.min(1, matchedIdf / allIdf),
    evidence: matchedIdf,
  }
}

/**
 * @param {string[]} queryTokens
 * @param {string} id
 * @param {any} index
 * @param {number} [docCount]
 * @returns {number}
 */
export function coverage(queryTokens, id, index, docCount) {
  return lexicalMatch(queryTokens, id, index, docCount).coverage
}

/**
 * Timeframe + scope admission for one record.
 *
 * Two shapes are accepted, and the difference matters:
 *   - `plan.scopeFilter` (a `ScopeFilter`) — the closed-set judgment used by
 *     every retrieval. Missing/unknown project ⇒ project records are excluded.
 *   - `plan.scope` (the legacy `{session, workspace, preset}` object) — kept for
 *     the read-only projections (dashboard, diagram, the file mirror) that show
 *     the *whole* store to the operator. It still refuses to leak a session
 *     record into another session, and it now respects `tier` when it is
 *     present, but "no filter" continues to mean "the operator's own store".
 * @param {import('../store/schema.js').MemoryRecord} record
 * @param {any} plan
 * @returns {boolean}
 */
export function inScope(record, plan) {
  const since = plan?.timeframe?.since ?? null
  const until = plan?.timeframe?.until ?? null
  if (since !== null && record.createdAt < since) return false
  if (until !== null && record.createdAt > until) return false
  if (plan?.scopeFilter !== undefined && plan?.scopeFilter !== null) {
    return scopeMatch(record, plan.scopeFilter).ok
  }
  return legacyInScope(record, plan?.scope ?? {})
}

/**
 * The pre-isolation contract, kept only for read-only projections.
 * @param {any} record
 * @param {any} wanted
 * @returns {boolean}
 */
function legacyInScope(record, wanted) {
  const explicit = wanted !== null && typeof wanted === 'object' && Object.keys(wanted).length > 0
  const tier = String(record?.scope?.tier ?? '')
  if (tier === 'session') return record.scope.session === (wanted?.session ?? null)
  if (tier === 'global' || record?.scope?.global === true) {
    return wanted?.global === false ? false : true
  }
  if (!explicit) return true
  if (wanted?.session !== undefined && record?.scope?.session === wanted.session) return true
  if (wanted?.workspace !== undefined && record?.scope?.workspace === wanted.workspace) return true
  if (wanted?.preset !== undefined && record?.scope?.preset === wanted.preset) return true
  if (wanted?.projectId !== undefined && record?.scope?.projectId === wanted.projectId) return true
  return false
}

/**
 * Run a recall. `engine` is the Layer-2 strategy engine; every hook is optional.
 * @param {import('../store/store.js').MemoryStore} store
 * @param {object} request
 * @param {{ params?: Record<string, any>, engine?: any, scope?: string, now?: () => number,
 *   indexCache?: { memories: any, index: any },
 *   context?: { projectId?: string|null, sessionId?: string|null, crossProject?: boolean, reason?: string } }} [opts]
 * @returns {Promise<any>}
 */
export async function recall(store, request = {}, opts = {}) {
  const now = (opts.now ?? Date.now)()
  const state = store.state
  const params = opts.params ?? state.params.global ?? {}
  const engine = opts.engine
  const basePlan = planRecall(request, params, opts.scope ?? 'global', opts.embed, opts.context ?? {})
  // The stack reshapes the plan before anything is scored: explore widens what
  // counts as a candidate, exploit narrows via its filter, distill shrinks the
  // budget. Caller-specified maxTokens/minConfidence stay locked.
  const plan = engine?.plan !== undefined ? engine.plan(basePlan) : basePlan

  let index = opts.indexCache !== undefined && opts.indexCache.memories === state.memories
    ? opts.indexCache.index
    : undefined
  if (index === undefined) {
    index = buildIndex(state)
    if (opts.indexCache !== undefined) {
      opts.indexCache.memories = state.memories
      opts.indexCache.index = index
    }
  }

  const docCount = index.lengths.size || 1
  const candidates = []
  const rejected = { state: 0, kind: 0, confidence: 0, scope: 0, expired: 0, strategy: 0, crossProject: 0, relevance: 0, relevanceRelative: 0 }
  let crossProjectAdmitted = 0

  for (const record of Object.values(state.memories)) {
    if (record.state === 'retired') continue
    if (!plan.states.includes(record.state)) { rejected.state++; continue }
    if (plan.kinds !== null && !plan.kinds.includes(record.kind)) { rejected.kind++; continue }
    if (record.confidence < plan.minConfidence) { rejected.confidence++; continue }
    const verdict = scopeMatch(record, plan.scopeFilter)
    if (!verdict.ok) { rejected.scope++; continue }
    if (verdict.weight < 1) { crossProjectAdmitted += 1; rejected.crossProject += 1 }
    if (record.expiresAt !== null && record.expiresAt <= now && record.state !== 'expired') { rejected.expired++; continue }
    if (engine !== undefined && engine.admits !== undefined && !engine.admits(record, plan)) { rejected.strategy++; continue }
    const scored = scoreRecord(record, plan, index, docCount, now, engine, verdict)
    // The absolute relevance floor. Skipped for an empty query, which is the
    // deliberate "brief me on this project" path: there is nothing to be
    // relevant *to*, so recency/confidence are the whole ranking.
    if (plan.tokens.length > 0 && scored.matchFull < plan.minRelevance) { rejected.relevance++; continue }
    candidates.push(scored)
  }

  // The relative floor: keep the strong matches, drop the ones that are only
  // there because the budget had room.
  let scoredPool = candidates
  if (plan.tokens.length > 0 && candidates.length > 1) {
    const topRelevance = candidates.reduce((max, row) => Math.max(max, row.relevance), 0)
    scoredPool = candidates.filter((row) => row.relevance >= topRelevance * plan.relevanceMargin)
    rejected.relevanceRelative = candidates.length - scoredPool.length
  }

  const packed = pack(scoredPool, plan, now, engine)
  // Conflict detection runs on what was *selected*, and its only effect is on
  // the projection: the cross-project record's effective confidence is halved,
  // its score drops, and the injection block says so. No stored record is
  // touched — a read must not silently rewrite the memory it read.
  const conflicts = detectScopeConflicts(packed.selected, plan.scopeFilter)
  if (conflicts.length > 0) applyConflictPenalty(packed.selected, conflicts, plan)
  const text = renderInjection(packed.selected, plan, engine, conflicts)

  return {
    intent: plan.intent,
    granularity: plan.granularity,
    query: plan.query,
    scope: {
      projectId: plan.scopeFilter.projectId,
      sessionId: plan.scopeFilter.sessionId,
      crossProject: plan.scopeFilter.crossProject,
      admittedCrossProject: crossProjectAdmitted,
      conflicts: conflicts.length,
    },
    selected: packed.selected.map((row) => ({
      id: row.record.id,
      kind: row.record.kind,
      state: row.record.state,
      confidence: Number(row.record.confidence.toFixed(3)),
      effectiveConfidence: Number((row.effectiveConfidence ?? row.record.confidence).toFixed(3)),
      scope: scopeLabel(row.record.scope),
      crossProject: row.crossProject === true,
      conflict: row.conflict === true,
      score: Number(row.score.toFixed(4)),
      gist: row.record.gist,
      reason: row.reason,
    })),
    dropped: packed.dropped.length,
    tokenCost: text.tokens,
    // The memory block's own cost, without the status pulse — the number a
    // `maxTokens` budget is actually about.
    memoryTokens: text.memoryTokens,
    tokenBudget: plan.tokenBudget,
    text: text.text,
    strategy: engine?.describe?.() ?? ['(no engine)'],
    rejected,
    conflicts,
    trace: packed.selected.map((row) => ({ id: row.record.id, parts: row.parts })),
  }
}

/**
 * Apply the conflict penalty to the selected cross-project rows.
 * @param {any[]} selected
 * @param {import('../scope/index.js').ScopeConflict[]} conflicts
 * @param {any} plan
 * @returns {void}
 */
export function applyConflictPenalty(selected, conflicts, plan) {
  const byId = new Map(conflicts.map((row) => [String(row.otherId), row]))
  for (const row of selected) {
    const conflict = byId.get(String(row.record.id))
    if (conflict === undefined) continue
    row.conflict = true
    // Halved effective confidence, and the score follows it down. The stored
    // record keeps its real numbers: what changed is what *this session* is
    // willing to bet on, which is exactly the judgment that belongs to the
    // recall, not to the store.
    row.effectiveConfidence = clamp(row.record.confidence * CONFLICT_PENALTY, 0, 1)
    row.score *= CONFLICT_PENALTY
    row.parts.scopeConflict = -CONFLICT_PENALTY
    row.reason = `${row.reason}; scope conflict with ${conflict.currentId} (${conflict.basis}, sim=${conflict.similarity})`
  }
}

/**
 * @param {import('../store/schema.js').MemoryRecord} record
 * @param {any} plan
 * @param {any} index
 * @param {number} docCount
 * @param {number} now
 * @param {any} engine
 * @param {{ ok: boolean, weight: number, relation: string, reason: string }} [verdict]
 *   The scope judgment already made by the candidate loop. Passed in rather than
 *   recomputed so scoring and admission can never disagree about which project a
 *   record belongs to.
 * @returns {{ record: any, score: number, relevance: number, matchFull: number, evidence: number,
 *   parts: Record<string, number>, reason: string, vector: number[], crossProject: boolean,
 *   effectiveConfidence: number }}
 */
export function scoreRecord(record, plan, index, docCount, now, engine, verdict) {
  const match = plan.tokens.length === 0
    ? { coverage: 0, coverageFull: 1, evidence: 0 }
    : lexicalMatch(plan.tokens, record.id, index, docCount)
  const lex = match.coverage
  const vec = plan.queryVector === null ? 0 : Math.max(0, cosine(plan.queryVector, record.embedding))
  // Relevance is the *query-fitness* half of the score. Priors (recency,
  // confidence, salience, access, scope) are deliberately kept out of it: they
  // answer "is this record trustworthy/fresh", not "does it answer the query".
  const relevanceWeight = Math.max(1e-9, plan.weights.lex + plan.weights.vec)
  const relevance = plan.tokens.length === 0 ? 1 : (plan.weights.lex * lex + plan.weights.vec * vec) / relevanceWeight
  const halfLife = engine?.halfLifeMs !== undefined ? engine.halfLifeMs(record, plan) : plan.halfLifeMs
  // Confirmation time, not edit time: linking or retagging a belief must not
  // reset its decay clock (v8). Pre-v8 records without the field fall back to
  // `createdAt`, then to `updatedAt`, so a replay of an old journal still ranks.
  const age = Math.max(0, now - (Number(record.confirmedAt) || Number(record.createdAt) || Number(record.updatedAt) || now))
  const recency = !Number.isFinite(halfLife) || halfLife <= 0 ? 1 : Math.pow(2, -age / halfLife)
  const access = saturate(Math.log1p(record.access.hits), 1.2)
  const scopeVerdict = verdict ?? (plan.scopeFilter === undefined || plan.scopeFilter === null
    ? { ok: true, weight: 1, relation: 'unknown', reason: 'no scope filter on this plan' }
    : scopeMatch(record, plan.scopeFilter))
  const crossProject = scopeVerdict.weight < 1
  const parts = {
    lex: plan.weights.lex * lex,
    vec: plan.weights.vec * vec,
    recency: plan.weights.recency * recency,
    conf: plan.weights.conf * record.confidence,
    // Salience is read through the asking scope: one agent's citations must not
    // re-rank another agent's recall (schema v4).
    sal: plan.weights.sal * effectiveSalience(record, plan.callerScope),
    access: plan.weights.access * access,
    // The scope term: 1 for this project / this session / global, a small
    // constant for an authorized cross-project or pre-isolation hit.
    scope: Number(plan.weights.scope ?? 0) * scopeVerdict.weight,
    strategy: 0,
  }
  let reason = `rel=${relevance.toFixed(2)} (lex=${lex.toFixed(2)} vec=${vec.toFixed(2)}) recency=${recency.toFixed(2)} scope=${scopeVerdict.relation}`
  if (engine?.score !== undefined) {
    const contribution = engine.score(record, plan)
    parts.strategy = contribution.delta
    if (contribution.reason !== undefined) reason = `${reason}; ${contribution.reason}`
  }
  // The cross-project down-weight applies to the *priors*, not to relevance.
  // Multiplying the whole score (the old behaviour) meant an irrelevant local
  // record beat the foreign record that actually answered the question, which
  // made `crossProject: true` unusable. Isolation is already enforced upstream
  // by the scope filter; this factor only decides how much trust to extend.
  const prior = parts.recency + parts.conf + parts.sal + parts.access + parts.scope
  const score = parts.lex + parts.vec
    + (crossProject ? prior * Number(plan.crossProjectFactor ?? 1) : prior)
    + parts.strategy
  return {
    record,
    score,
    relevance,
    // Gate signal: coverage with unknown query terms counted against the
    // record. Kept separate from `relevance` so ranking stays fair to records
    // whose vocabulary simply differs from the query's.
    matchFull: match.coverageFull,
    evidence: match.evidence,
    parts,
    reason,
    vector: record.embedding,
    crossProject,
    scopeRelation: scopeVerdict.relation,
    effectiveConfidence: record.confidence,
  }
}

/**
 * MMR packing under a token budget.
 *
 * The old implementation sorted once and then subtracted a diversity penalty
 * while walking the list, so the order never changed — a near-duplicate that
 * should have been pushed down kept its slot. This is the actual MMR loop over
 * a bounded shortlist: each pick re-scores every remaining candidate against
 * what is already selected, and a candidate that does not fit the budget is
 * removed from the pool instead of silently blocking the next one.
 * @param {ReturnType<typeof scoreRecord>[]} candidates
 * @param {any} plan
 * @param {number} now
 * @param {any} engine
 * @returns {{ selected: ReturnType<typeof scoreRecord>[], dropped: ReturnType<typeof scoreRecord>[] }}
 */
export function pack(candidates, plan, now, engine) {
  const ranked = [...candidates].sort((a, b) => b.score - a.score)
  const pool = ranked.slice(0, MMR_SHORTLIST)
  const costOf = new Map(pool.map((candidate) => [
    candidate,
    estimateTokens(renderMemory(candidate.record, plan.granularity, engine, plan)) + 8,
  ]))
  const taken = new Set()
  /** @type {ReturnType<typeof scoreRecord>[]} */
  const selected = []
  let budget = plan.tokenBudget
  while (selected.length < plan.limit) {
    /** @type {{ candidate: any, mmr: number, similarity: number } | null} */
    let best = null
    for (const candidate of pool) {
      if (taken.has(candidate)) continue
      let similarity = 0
      if (selected.length > 0 && plan.diversity > 0) {
        for (const chosen of selected) similarity = Math.max(similarity, Math.max(0, cosine(candidate.vector, chosen.vector)))
      }
      const mmr = candidate.score - plan.diversity * similarity
      if (best === null || mmr > best.mmr) best = { candidate, mmr, similarity }
    }
    if (best === null) break
    // A candidate that only adds redundancy is worse than an empty slot.
    if (best.mmr <= 0 && selected.length > 0) break
    const cost = costOf.get(best.candidate) ?? plan.tokenBudget
    if (cost > budget) {
      taken.add(best.candidate)
      continue
    }
    best.candidate.parts.diversity = -(plan.diversity * best.similarity)
    best.candidate.mmrScore = best.mmr
    best.candidate.tokenCost = cost
    selected.push(best.candidate)
    taken.add(best.candidate)
    budget -= cost
  }
  const dropped = ranked.filter((candidate) => !taken.has(candidate))
  return { selected, dropped }
}

/**
 * @param {import('../store/schema.js').MemoryRecord} record
 * @param {string} granularity
 * @param {any} [engine]
 * @param {any} [plan] the plan, when the caller knows it: it is what makes a
 *   cross-project record *say* it is one. The token estimate in `pack` passes it
 *   too, so the budget accounts for the warning the model will actually read.
 * @returns {string}
 */
export function renderMemory(record, granularity, engine, plan) {
  const format = engine?.format !== undefined ? engine.format(record, { granularity }) : null
  const note = format?.note === undefined ? '' : ` ${format.note}`
  const marker = plan === undefined ? '' : crossMarker(record, plan)
  const head = `(${record.kind}/${record.state} c=${record.confidence.toFixed(2)})${marker === '' ? '' : ` ${marker}`}`
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
 * The per-record scope warning: what a model must read before it applies the
 * record. Empty for anything that matches the current project.
 * @param {any} record
 * @param {any} plan
 * @returns {string}
 */
function crossMarker(record, plan) {
  const filter = plan?.scopeFilter
  if (filter === undefined || filter === null) return ''
  const verdict = scopeMatch(record, filter)
  if (verdict.weight >= 1) return ''
  if (isLegacyUnscoped(record)) return '⚠[作用域未标注的旧记忆，请按当前项目核对]'
  if (verdict.relation === 'other-project') return `⚠[其他项目经验，请勿盲从 ${scopeLabel(record.scope)}]`
  return `⚠[${verdict.reason}]`
}

/**
 * Format the whole injection block. Strategy `format` hooks may move a record
 * into a named bucket and set its order; the default buckets are by kind.
 *
 * The header states the scope this block was retrieved under, and any
 * cross-project material is announced **before** the records rather than being
 * left for the model to notice.
 * @param {ReturnType<typeof scoreRecord>[]} selected
 * @param {any} plan
 * @param {any} engine
 * @param {import('../scope/index.js').ScopeConflict[]} [conflicts]
 * @returns {{ text: string, tokens: number, buckets: string[] }}
 */
export function renderInjection(selected, plan, engine, conflicts = []) {
  const pulse = pulseText(plan)
  if (selected.length === 0) {
    // Even an empty result carries the pulse: "nothing matched" is exactly the
    // moment the model needs to know which project it just searched.
    return { text: pulse, tokens: estimateTokens(pulse), memoryTokens: 0, buckets: [] }
  }
  /** @type {Map<string, { order: number, lines: string[] }>} */
  const buckets = new Map()
  let bodyTokens = 0
  for (const row of selected) {
    const format = engine?.format !== undefined ? engine.format(row.record, { granularity: plan.granularity }) : null
    const bucket = format?.bucket ?? `${ORDER_HINTS[row.record.kind] ?? 50}.${row.record.kind}`
    const entry = buckets.get(bucket) ?? { order: Number(bucket.split('.')[0]) || 50, lines: [] }
    const line = renderMemory(row.record, plan.granularity, engine, plan)
    bodyTokens += estimateTokens(line) + 2
    entry.lines.push(line)
    buckets.set(bucket, entry)
  }
  const ordered = [...buckets.entries()].sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
  const crossCount = selected.filter((row) => row.crossProject === true).length
  const filter = plan.scopeFilter ?? {}
  const header = `<anagenesis-memory intent="${plan.intent}" strategy="${(engine?.describe?.() ?? []).join('+')}" `
    + `items="${selected.length}" approxTokens="${bodyTokens}" granularity="${plan.granularity}" `
    + `scope="${filter.projectId === null || filter.projectId === undefined ? 'unscoped' : `project:${String(filter.projectId).slice(0, 12)}`}" `
    + `crossProject="${crossCount}" conflicts="${conflicts.length}">`
  const parts = [header]
  if (crossCount > 0) {
    parts.push(`⚠ 以下 ${crossCount} 条记忆来自其它项目（已按 ${Number(plan.crossProjectFactor ?? 0).toFixed(2)} 系数降权）。`
      + '把它们当作**参照**而不是结论：先核对当前项目的实际环境，不确定就问用户，不要直接套用。')
  }
  if (conflicts.length > 0) {
    parts.push(`⚠ 检测到跨项目记忆冲突 ${conflicts.length} 处（语义相似但内容相反）。`
      + '建议忽略历史经验，以当前环境为准；与当前项目记忆相左的那一条，有效置信度已减半。')
  }
  for (const [bucket, entry] of ordered) {
    parts.push(`## ${bucket.split('.').slice(1).join('.')}`)
    parts.push(...entry.lines)
  }
  parts.push('</anagenesis-memory>')
  const memoryText = parts.join('\n')
  // The pulse rides outside the block and outside the *budget*: `maxTokens` is a
  // statement about how much memory to inject, and silently spending a third of
  // it on status would be the kind of quiet overrun this project refuses. Both
  // numbers are reported so a caller can hold either line.
  const text = pulse === '' ? memoryText : `${memoryText}\n${pulse}`
  return {
    text,
    tokens: estimateTokens(text),
    memoryTokens: estimateTokens(memoryText),
    buckets: ordered.map(([bucket]) => bucket),
  }
}

/**
 * The session status pulse, when the caller supplied one.
 *
 * It rides *outside* the `<anagenesis-memory>` element on purpose: the memory
 * block is a parseable payload with a schema-ish header, and mixing a status
 * line into it would make every consumer learn an exception. The pulse is the
 * second thing the model reads and the last thing it should be able to ignore.
 * @param {any} plan
 * @returns {string}
 */
function pulseText(plan) {
  const pulse = plan?.pulse
  if (pulse === undefined || pulse === null) return ''
  return typeof pulse === 'string' ? pulse : String(pulse.text ?? '')
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
