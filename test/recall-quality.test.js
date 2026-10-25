/**
 * Retrieval quality — the behaviour the 0.4 scoring change introduced.
 *
 * These are the assertions that would have gone red on the old algorithm:
 *   - an unrelated query used to fill the token budget (there was no floor);
 *   - the vector term added a 0.5 floor to every record, so "unrelated" scored
 *     like "half related";
 *   - MMR penalised duplicates without ever re-ordering them;
 *   - recency read `updatedAt`, so linking a record made it look fresh.
 * @module dsh-anagenesis/test/recall-quality
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { embed } from '../src/memory/embed.js'
import {
  buildIndex,
  coverage,
  lexicalMatch,
  pack,
  planRecall,
  recall,
  scoreRecord,
} from '../src/memory/recall.js'
import { createScopeFilter } from '../src/scope/index.js'
import { createMemory, emptyState } from '../src/store/schema.js'

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0)
const DAY = 24 * 3600 * 1000
const PROJECT = 'p1_recall_quality'

/**
 * @param {string} id
 * @param {any} spec
 * @param {number} [now]
 */
function makeRecord(id, spec, now = NOW) {
  return createMemory({ ...spec, id, state: spec.state ?? 'active' }, {
    now,
    embed,
    defaultScope: { tier: 'project', projectId: PROJECT },
  })
}

/** @param {any[]} records */
function makeStore(records) {
  const state = emptyState(NOW)
  for (const record of records) state.memories[record.id] = record
  state.version = 1
  return { state }
}

function contextFor(projectId = PROJECT) {
  return { scopeFilter: createScopeFilter({ projectId }) }
}

test('recall quality: an unrelated query injects nothing and says why', async () => {
  const store = makeStore([
    makeRecord('a', { kind: 'fact', subject: 'npm test runs the unit suite', body: 'node --test test/*.test.js' }),
    makeRecord('b', { kind: 'constraint', subject: 'never commit secrets', body: 'tokens stay out of config files' }),
    makeRecord('c', { kind: 'procedure', subject: 'release runs the gates first', body: 'test then check then pack' }),
  ])
  const result = await recall(store, { intent: 'recall_fact', query: 'kubernetes ingress certificate rotation' }, {
    context: contextFor(),
    now: () => NOW,
  })
  assert.equal(result.selected.length, 0, 'nothing matched, so nothing is injected')
  assert.ok(result.rejected.relevance >= 1, 'the rejection counter names the relevance floor')
})

test('recall quality: the vector term has no half-credit floor', () => {
  const store = makeStore([
    makeRecord('a', { kind: 'fact', subject: 'npm test runs the unit suite', body: 'node --test test/*.test.js' }),
    makeRecord('b', { kind: 'fact', subject: 'the office plants are watered on fridays', body: 'unrelated on purpose' }),
  ])
  const plan = planRecall({ intent: 'recall_fact', query: 'npm test' }, {}, 'global', embed, contextFor())
  const index = buildIndex(store.state)
  const unrelated = scoreRecord(store.state.memories.b, plan, index, 2, NOW)
  // Old mapping: (cos+1)/2 ≈ 0.5 → parts.vec ≈ 0.15. New: max(0, cos) ≈ 0.
  assert.ok(unrelated.parts.vec < 0.03, `an unrelated record must not collect a semantic floor (got ${unrelated.parts.vec})`)
  const related = scoreRecord(store.state.memories.a, plan, index, 2, NOW)
  assert.ok(related.parts.vec > unrelated.parts.vec, 'a related record still gets vector credit')
})

test('recall quality: coverage ignores unknown query words, the gate does not', () => {
  const store = makeStore([
    makeRecord('a', { kind: 'constraint', subject: 'alpha pins node 20', body: 'this repository builds on node 20 only' }),
  ])
  const index = buildIndex(store.state)
  const known = lexicalMatch(['node', 'version'], 'a', index)
  assert.equal(known.coverage, 1, '"node" is all the store knows, and it matches')
  assert.ok(known.coverageFull < 0.5, 'the unknown "version" still counts against the gate')
  assert.equal(lexicalMatch(['zzzz'], 'a', index).coverageFull, 0)
})

test('recall quality: MMR re-ranks a near-duplicate down instead of just annotating it', () => {
  const question = 'cache invalidation version counter tenant'
  const store = makeStore([
    makeRecord('a', { kind: 'fact', subject: 'cache invalidation uses a version counter', body: 'bump the counter on every write', confidence: 0.9 }),
    makeRecord('b', { kind: 'fact', subject: 'cache invalidation uses a version counter', body: 'bump the counter on every write', confidence: 0.85 }),
    makeRecord('c', { kind: 'fact', subject: 'the cache key includes the tenant id', body: 'tenant isolation is part of the key', confidence: 0.7 }),
  ])
  return recall(store, { intent: 'recall_fact', query: question, limit: 2, maxTokens: 900 }, {
    context: contextFor(),
    now: () => NOW,
  }).then((result) => {
    const ids = result.selected.map((row) => row.id)
    assert.deepEqual(ids.sort(), ['a', 'c'], `the diverse record must win the second slot, got ${ids.join(',')}`)
  })
})

test('recall quality: the index cache follows the memories object, not the version', async () => {
  const store = makeStore([
    makeRecord('a', { kind: 'fact', subject: 'npm test runs the unit suite', body: 'node --test test/*.test.js' }),
  ])
  const cache = { memories: null, index: null }
  const first = await recall(store, { intent: 'recall_fact', query: 'npm test' }, { context: contextFor(), indexCache: cache, now: () => NOW })
  assert.equal(first.selected.length, 1)
  assert.equal(cache.memories, store.state.memories, 'the cache keys on the memories object')

  // An audit-only transaction changes `version` but keeps the same memories
  // object; the cache must survive it.
  const audited = { ...store.state, version: 2 }
  await recall({ state: audited }, { intent: 'recall_fact', query: 'npm test' }, { context: contextFor(), indexCache: cache, now: () => NOW })
  assert.equal(cache.memories, store.state.memories, 'an audit write does not invalidate the index')

  // A real memory write replaces the object, and the next recall sees the new record.
  const added = makeRecord('b', { kind: 'fact', subject: 'release runs the gates first', body: 'test then check then pack' })
  const written = { ...store.state, version: 3, memories: { ...store.state.memories, b: added } }
  const after = await recall({ state: written }, { intent: 'recall_fact', query: 'release gates' }, { context: contextFor(), indexCache: cache, now: () => NOW })
  assert.equal(cache.memories, written.memories, 'a memory write replaces the cached key')
  assert.deepEqual(after.selected.map((row) => row.id), ['b'])
})

test('recall quality: recency reads confirmedAt, so editing a record does not refresh it', () => {
  const old = 60 * DAY
  const edited = makeRecord('edited', {
    kind: 'fact',
    subject: 'the build runs on node 20',
    body: 'pinned by the toolchain',
  })
  edited.createdAt = NOW - old
  edited.confirmedAt = NOW - old
  edited.updatedAt = NOW - 1000
  const untouched = makeRecord('untouched', {
    kind: 'fact',
    subject: 'the build runs on node 20',
    body: 'pinned by the toolchain',
  })
  untouched.createdAt = NOW - old
  untouched.confirmedAt = NOW - old
  untouched.updatedAt = NOW - old

  const plan = planRecall({ intent: 'recall_fact', query: 'build node' }, {}, 'global', embed, contextFor())
  const index = buildIndex(makeStore([edited, untouched]).state)
  const a = scoreRecord(edited, plan, index, 2, NOW)
  const b = scoreRecord(untouched, plan, index, 2, NOW)
  assert.equal(a.parts.recency, b.parts.recency, 'a link/retag edit must not reset the decay clock')
  assert.ok(coverage(['build'], 'edited', index) > 0)
})

test('recall quality: pack never mutates a score to make room for a worse record', () => {
  const plan = planRecall({ intent: 'recall_fact', query: 'cache', maxTokens: 64 }, {}, 'global', embed, contextFor())
  const rows = [
    { record: makeRecord('x', { kind: 'fact', subject: 'cache', body: 'cache' }), score: 0.9, relevance: 1, parts: {}, vector: embed('cache'), crossProject: false, effectiveConfidence: 0.9 },
    { record: makeRecord('y', { kind: 'fact', subject: 'cache', body: 'cache' }), score: 0.2, relevance: 0.5, parts: {}, vector: embed('cache'), crossProject: false, effectiveConfidence: 0.5 },
  ]
  const { selected } = pack(rows, plan, NOW, undefined)
  assert.deepEqual(selected.map((row) => row.record.id), ['x'])
  assert.equal(rows[1].score, 0.2, 'a dropped candidate keeps its own score')
})

test('recall quality: the exclusion report names the strongest near miss and why', async () => {
  const store = makeStore([
    makeRecord('a', { kind: 'fact', subject: 'cache invalidation uses a version counter', body: 'bump the counter on every write', confidence: 0.9 }),
    makeRecord('b', { kind: 'fact', subject: 'the cache is warmed after deploy', body: 'unrelated but shares one word', confidence: 0.9 }),
  ])
  const result = await recall(store, { intent: 'recall_fact', query: 'cache invalidation version counter' }, {
    context: contextFor(),
    now: () => NOW,
  })
  assert.deepEqual(result.selected.map((row) => row.id), ['a'])
  assert.equal(result.excluded.returned, 1)
  assert.equal(result.excluded.nearMisses.length, 1)
  assert.equal(result.excluded.nearMisses[0].id, 'b')
  assert.equal(result.excluded.nearMisses[0].why, 'below-relevance-floor')
  assert.match(result.excluded.nearMisses[0].gist, /cache is warmed/)
  assert.ok(result.excluded.summary.relevance >= 1)
})
