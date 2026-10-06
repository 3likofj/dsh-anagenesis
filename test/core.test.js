/**
 * Core suite: the host-agnostic engine. Store, patch algebra, lifecycle ops,
 * recall, strategies, meta-tuner and the invariants.
 *
 * These tests exercise real filesystem journals in temp directories, so they
 * also cover durability and restart behaviour rather than only in-memory logic.
 * @module dsh-anagenesis/test/core.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '../src/store/store.js'
import { applyPatch, invertPatch } from '../src/store/patch.js'
import { emptyState, migrateState, SCHEMA_VERSION, effectiveSalience } from '../src/store/schema.js'
import { createMemoryOps } from '../src/memory/ops.js'
import { recall, planRecall, INTENTS, buildIndex, scoreRecord } from '../src/memory/recall.js'
import { resolveEmbedder, registerEmbedProvider, EMBED_DIM } from '../src/memory/embed.js'
import { StrategyRegistry } from '../src/strategy/registry.js'
import { StrategyEngine } from '../src/strategy/engine.js'
import { Tuner } from '../src/meta/tuner.js'
import { createInvariantGate, createToolGuard } from '../src/guard/invariants.js'

const quiet = { info() {}, warn() {}, debug() {} }

/** @param {(store: MemoryStore, dir: string) => Promise<void>} fn */
async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ana-core-'))
  const store = await MemoryStore.open({ rootDir: dir, logger: quiet })
  try {
    await fn(store, dir)
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

// ── patch algebra ───────────────────────────────────────────────────────────

test('patch: inverse of a multi-collection patch restores the pre-state exactly', () => {
  const before = emptyState(1000)
  const patch = {
    memorySet: { m1: { id: 'm1', state: 'draft' } },
    stackSet: { global: ['guard', 'debug'] },
    paramsSet: { global: { 'recall.halfLifeMs': 42 } },
    auditAppend: [{ id: 'a1', at: 1, type: 't', detail: null }],
  }
  const after = applyPatch(before, patch)
  assert.equal(after.memories.m1.id, 'm1')
  assert.deepEqual(after.stacks.global, ['guard', 'debug'])

  const undo = invertPatch(before, patch)
  const restored = applyPatch(after, undo)
  assert.deepEqual(restored.memories, before.memories)
  assert.deepEqual(restored.stacks, before.stacks)
  assert.deepEqual(restored.params, before.params)
})

test('patch: inverse of an unset restores the removed record, and of a replace restores the old one', () => {
  const before = applyPatch(emptyState(1), { memorySet: { m1: { id: 'm1', body: 'old' } } })
  const removed = applyPatch(before, { memoryUnset: ['m1'] })
  assert.equal(removed.memories.m1, undefined)
  assert.deepEqual(applyPatch(removed, invertPatch(before, { memoryUnset: ['m1'] })).memories, before.memories)

  const replaced = applyPatch(before, { memorySet: { m1: { id: 'm1', body: 'new' } } })
  const back = applyPatch(replaced, invertPatch(before, { memorySet: { m1: { id: 'm1', body: 'new' } } }))
  assert.equal(back.memories.m1.body, 'old')
})

// ── migrations ──────────────────────────────────────────────────────────────

test('schema: a v1 document migrates forward to the current version', () => {
  const migrated = migrateState({
    schemaVersion: 1,
    records: [{ id: 'legacy', text: 'an old memory', kind: 'fact', ts: 5, status: 'archived', confidence: 0.7 }],
  }, 1000)
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION)
  assert.equal(migrated.memories.legacy.body, 'an old memory')
  assert.equal(migrated.memories.legacy.state, 'deprecated')
  assert.ok(Array.isArray(migrated.memories.legacy.embedding))
  assert.ok(migrated.stacks.global.includes('guard'))
})

test('schema: migrating garbage yields a usable empty state instead of throwing', () => {
  const migrated = migrateState(null, 7)
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION)
  assert.deepEqual(migrated.memories, {})
})

// ── durability and restart ──────────────────────────────────────────────────

test('store: a committed memory survives a restart even when the snapshot is deleted (journal wins)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-restart-'))
  try {
    const first = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const ops = createMemoryOps({ store: first })
    const saved = await ops.remember({ kind: 'fact', subject: 'durable', body: 'written to the journal' })
    await first.close()

    const files = await readdir(join(dir, 'journal'))
    assert.ok(files.some((name) => name.startsWith('journal-')), 'journal segment written')

    // Remove the snapshot cache: replay must reconstruct from the journal alone.
    await rm(join(dir, 'snapshot.json'), { force: true })
    const second = await MemoryStore.open({ rootDir: dir, logger: quiet })
    assert.equal(second.state.memories[saved.id].body, 'written to the journal')
    assert.equal(second.state.version, saved.seq)
    await second.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('store: reference counting gives two rows one writer for the same rootDir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-pool-'))
  try {
    const a = await MemoryStore.acquire({ rootDir: dir, logger: quiet })
    const b = await MemoryStore.acquire({ rootDir: dir, logger: quiet })
    assert.equal(a.store, b.store, 'both rows share a single store instance')
    assert.equal(b.shared, true)
    assert.equal(await a.store.release(), false, 'first release keeps it open')
    assert.equal(await b.store.release(), true, 'last release closes it')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── revert of a real transaction ────────────────────────────────────────────

test('store: revert() undoes a commit through a compensating journal event', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    const saved = await ops.remember({ kind: 'heuristic', subject: 'temporary', body: 'x' })
    assert.ok(store.state.memories[saved.id])

    const reverted = await saved.revert('test rollback')
    assert.equal(store.state.memories[saved.id], undefined)
    assert.equal(reverted.event.type, 'revert')
    assert.equal(reverted.event.payload.revives, saved.seq)
    assert.equal(store.state.stats.reverts, 1)

    // Reverting the revert reapplies the original patch: reversibility is total.
    await reverted.revert('undo the undo')
    assert.ok(store.state.memories[saved.id])
  })
})

// ── Layer 1: lifecycle ops ──────────────────────────────────────────────────

test('ops: remember deduplicates identical content instead of growing the store', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    const first = await ops.remember({ kind: 'fact', subject: 'same', body: 'same body' })
    const second = await ops.remember({ kind: 'fact', subject: 'same', body: 'same body' })
    assert.equal(second.id, first.id)
    assert.equal(second.deduplicated, true)
    // A deduplicated call writes nothing, so it must not hand back a seq: the
    // old value was `store.state.version` — the seq of whatever ran last.
    assert.equal(second.seq, undefined)
    assert.equal(Object.keys(store.state.memories).length, 1)
    assert.equal(store.state.stats.writes, 1, 'only the accepted commit counts as a write')
  })
})

test('ops: the write counter rides the commit that owns it and survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-writes-'))
  try {
    const store = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const ops = createMemoryOps({ store })
    await ops.remember({ kind: 'fact', subject: 'a', body: 'a' })
    await ops.remember({ kind: 'fact', subject: 'b', body: 'b' })
    await ops.remember({ kind: 'fact', subject: 'a', body: 'a' }) // dedup — not a write
    assert.equal(store.state.stats.writes, 2)
    assert.ok(store.state.stats.commits >= store.state.stats.writes, 'writes are a subset of commits')
    await store.close()
    await rm(join(dir, 'snapshot.json'), { force: true })
    const rebuilt = await MemoryStore.open({ rootDir: dir, logger: quiet })
    assert.equal(rebuilt.state.stats.writes, 2, 'the counter is replayed like any other state')
    await rebuilt.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ops: promote raises confidence to the state floor and refuses an illegal jump', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    const saved = await ops.remember({ kind: 'fact', subject: 's', body: 'b', confidence: 0.1 })
    await assert.rejects(
      () => ops.promote({ ids: [saved.id], to: 'verified', reason: 'skipping active' }),
      /illegal transition/,
    )
    await ops.promote({ ids: [saved.id], to: 'active', reason: 'first rung', evidence: ['test passed'] })
    assert.equal(store.state.memories[saved.id].state, 'active')
    assert.ok(store.state.memories[saved.id].confidence >= 0.4)
    assert.ok(store.state.memories[saved.id].provenance.evidence.includes('test passed'))
  })
})

test('ops: lock protects a belief and force is required to leave it', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    const saved = await ops.remember({ kind: 'constraint', subject: 'invariant', body: 'never delete the journal' })
    await ops.lock({ ids: [saved.id], reason: 'core invariant' })
    assert.equal(store.state.memories[saved.id].state, 'locked')
    await assert.rejects(
      () => ops.demote({ ids: [saved.id], to: 'deprecated', reason: 'changed my mind' }),
      /locked/,
    )
    await ops.demote({ ids: [saved.id], to: 'deprecated', reason: 'superseded', force: true })
    assert.equal(store.state.memories[saved.id].state, 'deprecated')
  })
})

test('ops: split keeps lineage through parentId and linked children', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    const parent = await ops.remember({ kind: 'episode', subject: 'big episode', body: 'many things happened' })
    const result = await ops.split({
      id: parent.id,
      reason: 'two independent claims in one record',
      into: [
        { subject: 'part one', body: 'first claim', gist: 'one' },
        { subject: 'part two', body: 'second claim', gist: 'two' },
      ],
    })
    assert.equal(result.children.length, 2)
    for (const child of result.children) {
      assert.equal(store.state.memories[child].parentId, parent.id)
      assert.deepEqual(store.state.memories[child].provenance.derivedFrom, [parent.id])
    }
    assert.equal(store.state.memories[parent.id].state, 'deprecated')
    assert.ok(store.state.memories[parent.id].links.some((link) => link.rel === 'split_into'))
  })
})

test('ops: rethink materializes a counterfactual hypothesis rather than overwriting belief', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    const belief = await ops.remember({ kind: 'fact', subject: 'the cache is warm', body: 'assumed warm on boot' })
    const result = await ops.rethink({
      premise: 'the cache is warm',
      counterfactual: 'if the cache is cold, the first query is slow and we must prewarm',
      ids: [belief.id],
    })
    const hypothesis = store.state.memories[result.hypothesisId]
    assert.equal(hypothesis.kind, 'hypothesis')
    assert.equal(hypothesis.state, 'draft')
    assert.ok(hypothesis.confidence <= 0.5)
    assert.equal(store.state.memories[belief.id].state, 'draft', 'the original belief is untouched in content')
    assert.ok(store.state.memories[belief.id].links.some((link) => link.rel === 'challenged_by'))
  })
})

test('ops: forget wipes content but keeps a tombstone, and enforces the destruction budget', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    const secret = await ops.remember({ kind: 'fact', subject: 'api key', body: 'super-secret-value' })
    await ops.forget({ ids: [secret.id], reason: 'credential must not persist' })
    const tombstone = store.state.memories[secret.id]
    assert.equal(tombstone.state, 'retired')
    assert.equal(tombstone.body, '')
    assert.ok(tombstone.provenance.evidence.some((line) => line.startsWith('tombstone:')))

    const many = Array.from({ length: 51 }, (_, index) => `missing-${index}`)
    await assert.rejects(() => ops.forget({ ids: many, reason: 'too much at once' }), /budget/)
  })
})

test('ops: recordUse moves salience in the direction of actual use', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    const used = await ops.remember({ kind: 'fact', subject: 'helpful', body: 'x' })
    const ignored = await ops.remember({ kind: 'fact', subject: 'useless', body: 'y' })
    await ops.recordUse({ usedIds: [used.id], ignoredIds: [ignored.id] })
    // Salience is partitioned by caller scope (schema v4): the write-time
    // default on the record stays put, and the scope that reported the usage is
    // the one whose number moves.
    assert.equal(store.state.memories[used.id].salience, 0.5, 'the shared default is untouched')
    assert.ok(effectiveSalience(store.state.memories[used.id], 'global') > 0.5)
    assert.ok(effectiveSalience(store.state.memories[ignored.id], 'global') < 0.5)
    assert.equal(store.state.memories[used.id].access.hits, 1)
    assert.equal(store.state.memories[ignored.id].access.misses, 1)
  })
})

test('salience: usage feedback is partitioned per caller scope, and v3 migrates to v4', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    const shared = await ops.remember({ kind: 'fact', subject: 'shared', body: 'both agents read this' })

    await ops.recordUse({ usedIds: [shared.id], scope: 'agent:one' })
    await ops.recordUse({ usedIds: [shared.id], scope: 'agent:one' })
    await ops.recordUse({ ignoredIds: [shared.id], scope: 'agent:two' })

    const record = store.state.memories[shared.id]
    /** Salience accumulates in floating point, so compare with a tolerance. */
    const near = (value, expected, label) => assert.ok(Math.abs(value - expected) < 1e-9, `${label}: ${value} ≈ ${expected}`)
    assert.equal(record.salience, 0.5, 'the write-time default never moves')
    near(effectiveSalience(record, 'agent:one'), 0.6, 'two citations at +0.05')
    near(effectiveSalience(record, 'agent:two'), 0.48, 'one miss at -0.02')
    assert.equal(effectiveSalience(record, 'agent:three'), 0.5, 'a scope with no history inherits the default')

    // The partition has to show up in ranking, not only in the field: one
    // agent's citations must not re-rank another agent's recall.
    const index = buildIndex(store.state)
    const citing = scoreRecord(record, planRecall({ intent: 'recall_fact' }, {}, 'agent:one'), index, 1, Date.now(), undefined)
    const ignoring = scoreRecord(record, planRecall({ intent: 'recall_fact' }, {}, 'agent:two'), index, 1, Date.now(), undefined)
    assert.ok(citing.parts.sal > ignoring.parts.sal, 'the citing scope scores the memory higher')
  })

  // Migration: a v3 document has no per-scope map, and its single salience
  // becomes the default every scope inherits. Losing that number would silently
  // reset every memory's ranking on the first boot after the upgrade.
  const migrated = migrateState({
    schemaVersion: 3,
    memories: {
      m1: {
        id: 'm1', kind: 'fact', state: 'active', salience: 0.7,
        access: { count: 3, hits: 2, misses: 1, lastAt: 5 }, embedding: [],
      },
    },
  }, 1000)
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION)
  assert.equal(migrated.schemaVersion, 6)
  assert.deepEqual(migrated.memories.m1.salienceByScope, {})
  assert.equal(effectiveSalience(migrated.memories.m1, 'agent:anyone'), 0.7, 'the pre-v4 salience survives as the default')
  assert.deepEqual(migrated.memories.m1.access, { count: 3, hits: 2, misses: 1, lastAt: 5 })

  // A *populated* v2 document is the case the empty-fixture test above missed:
  // the migration body only runs when there are records, and it used to throw
  // "{} is not a function" there (ASI turned `??= {…}` + a leading `(record)`
  // into a call of the object literal).
  const fromV2 = migrateState({
    schemaVersion: 2,
    memories: {
      m2: {
        id: 'm2', kind: 'fact', state: 'active', salience: 0.4,
        access: { count: 0, hits: 0, misses: 0, lastAt: null }, embedding: [],
      },
    },
    meta: { params: { global: { 'recall.diversity': 0.3 } } },
  }, 1000)
  assert.equal(fromV2.schemaVersion, SCHEMA_VERSION, 'v2 walks the whole chain to the current version')
  assert.deepEqual(fromV2.memories.m2.salienceByScope, {})
  assert.equal(fromV2.params.global['recall.diversity'], 0.3, 'v2 meta params still move into params')

  // v5 → v6 moves the tuner's learning state into `state` (it used to be private
  // fields, so a restart silently zeroed the sample window and `revert` of a
  // feedback event had nothing to roll back). A v5 document has no such field, so
  // the migration must leave an empty container — `undefined` would break the
  // tuner's hydration on the first boot after the upgrade.
  const fromV5 = migrateState({ schemaVersion: 5, memories: {} }, 1000)
  assert.equal(fromV5.schemaVersion, SCHEMA_VERSION)
  assert.deepEqual(fromV5.tuning, { samples: [], arms: {}, history: [] })

  // A corrupt tuning field degrades to an empty window instead of throwing: the
  // meta layer must not be able to brick the store on load.
  const damaged = migrateState({
    schemaVersion: 6,
    memories: {},
    tuning: { samples: ['x', 0.5], arms: { 'recall.diversity:1': { pulls: '2', reward: null } }, history: 'nope' },
  }, 1000)
  assert.deepEqual(damaged.tuning.samples, [0.5], 'non-numeric samples are dropped')
  assert.deepEqual(damaged.tuning.arms['recall.diversity:1'], { pulls: 2, reward: 0 })
  assert.deepEqual(damaged.tuning.history, [])
})

test('embed: a plugged-in backend re-embeds the whole store in one revertible transaction', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    const one = await ops.remember({ kind: 'fact', subject: 'alpha', body: 'first' })
    assert.equal(store.state.embed.id, 'hash', 'a fresh store records the built-in backend')
    assert.equal(store.state.memories[one.id].embedding.length, EMBED_DIM)

    // An 8-dimension toy backend: small enough to check by hand, real enough
    // that a vector can only have come from it.
    const toy = { id: 'toy-8', dim: 8, embed: (text) => Array.from({ length: 8 }, (_, i) => (text.includes(`k${i}`) ? 1 : 0)) }
    const migrated = await ops.reembed({ id: toy.id, dim: toy.dim, embed: toy.embed })
    assert.equal(migrated.ok, true)
    assert.equal(migrated.records, 1)
    assert.deepEqual(store.state.embed, { id: 'toy-8', dim: 8 })
    assert.equal(store.state.memories[one.id].embedding.length, 8, 'the stored vector was recomputed')

    // Same backend again: a no-op, not another transaction.
    const versionBefore = store.version
    const again = await ops.reembed({ id: toy.id, dim: toy.dim, embed: toy.embed })
    assert.equal(again.noop, true)
    assert.equal(store.version, versionBefore, 'nothing was journaled')

    // An ordinary transaction: revert restores the vectors *and* the stamp, so
    // a migration can be backed out like anything else.
    const undone = await store.revert(migrated.seq, 'test: back to the hashing backend')
    assert.deepEqual(store.state.embed, { id: 'hash', dim: EMBED_DIM })
    assert.equal(store.state.memories[one.id].embedding.length, EMBED_DIM)
    assert.ok(undone.seq > 0)
  })

  // Provider resolution. A typo must fail loudly: silently falling back would
  // vectorise the store with a backend nobody asked for.
  assert.equal(resolveEmbedder('hash').dim, EMBED_DIM)
  assert.equal(resolveEmbedder({ id: 'inline', embed: (text) => [text.length, 1] }).dim, 2)
  assert.throws(() => resolveEmbedder('nope'), /unknown embed provider/)
  const withdraw = registerEmbedProvider('probe-4', () => [1, 0, 0, 0])
  assert.equal(resolveEmbedder('probe-4').dim, 4)
  assert.throws(() => registerEmbedProvider('hash', () => [1]), /built-in/)
  withdraw()
  assert.throws(() => resolveEmbedder('probe-4'), /unknown embed provider/, 'withdrawing removes it again')

  // v4 → v5: a store that predates the stamp was vectorised by the built-in
  // backend — nothing else could have written a vector — and the migration has
  // to say that rather than claim a backend the vectors never saw.
  const fromV4 = migrateState({ schemaVersion: 4, memories: {} }, 1000)
  assert.equal(fromV4.schemaVersion, SCHEMA_VERSION)
  assert.deepEqual(fromV4.embed, { id: 'hash', dim: EMBED_DIM })
  const fromV1 = migrateState({ schemaVersion: 1, records: [] }, 1000)
  assert.deepEqual(fromV1.embed, { id: 'hash', dim: EMBED_DIM }, 'the whole chain lands on the same stamp')
})

test('ops: the expiry sweep is an ordinary revertible transaction', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    const short = await ops.remember({ kind: 'fact', subject: 'goes stale', body: 'x', ttlMs: 0 })
    const swept = await ops.sweepExpired()
    assert.deepEqual(swept.swept, [short.id])
    assert.equal(store.state.memories[short.id].state, 'expired')
  })
})

// ── Layer 1: retrieval ──────────────────────────────────────────────────────

test('recall: an intent alone produces a scored, formatted, budgeted block', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    await ops.remember({ kind: 'constraint', subject: 'never remove the guard strategy', body: 'it is the safety floor', state: 'verified', confidence: 0.95 })
    await ops.remember({ kind: 'fact', subject: 'irrelevant trivia', body: 'the sky is up', state: 'verified', confidence: 0.9 })

    const registry = new StrategyRegistry({ store, logger: quiet })
    const engine = new StrategyEngine({ registry, logger: quiet })
    const result = await recall(store, { intent: 'orient', query: 'guard safety', maxTokens: 400 }, { engine })

    assert.equal(result.intent, 'orient')
    assert.match(result.text, /<anagenesis-memory/)
    assert.match(result.text, /never remove the guard strategy/)
    assert.ok(result.tokenCost <= 460, `budget respected (got ${result.tokenCost})`)
    assert.ok(result.selected.every((row) => row.score > 0))
    assert.deepEqual(result.strategy, ['guard', 'exploit'])
  })
})

test('recall: every declared intent plans without throwing and keeps a token budget', () => {
  for (const intent of Object.keys(INTENTS)) {
    const plan = planRecall({ intent, query: 'x' })
    assert.ok(plan.tokenBudget >= 64, intent)
    assert.ok(Array.isArray(plan.states) && plan.states.length > 0, intent)
    assert.ok(plan.granularity !== undefined, intent)
  }
})

test('recall: exploit mode refuses drafts that explore mode would surface', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    await ops.remember({ kind: 'heuristic', subject: 'draft hunch', body: 'maybe the retry helps', confidence: 0.8 })
    const registry = new StrategyRegistry({ store, logger: quiet })
    const engine = new StrategyEngine({ registry, logger: quiet })

    const exploitResult = await recall(store, { intent: 'reuse_procedure', query: 'retry' }, { engine })
    assert.equal(exploitResult.selected.length, 0)

    const explore = await registry.activate('explore')
    const exploreResult = await recall(store, { intent: 'recall_precedent', query: 'retry' }, { engine })
    assert.ok(exploreResult.selected.length >= 1)
    await explore.revert('back to default')
  })
})

// ── Layer 2: strategies ─────────────────────────────────────────────────────

test('strategy: activate is one reversible transaction, and guard cannot be dropped', async () => {
  await withStore(async (store) => {
    const registry = new StrategyRegistry({ store, logger: quiet })
    assert.deepEqual(registry.stack(), ['guard', 'exploit'])

    const switched = await registry.activate('debug', { reason: 'a test is failing' })
    assert.deepEqual(registry.stack(), ['guard', 'debug'])
    await switched.revert('done debugging')
    assert.deepEqual(registry.stack(), ['guard', 'exploit'])

    await assert.rejects(() => registry.setStack(['exploit']), /guard/)
    await assert.rejects(() => registry.setStack(['guard', 'nope']), /unknown strategy/)
  })
})

test('strategy: preset stacks, derive with lineage, and unknown params are refused', async () => {
  await withStore(async (store) => {
    const registry = new StrategyRegistry({ store, logger: quiet })
    await registry.activate('crisis', { mode: 'preset' })
    assert.deepEqual(registry.stack(), ['guard', 'debug', 'exploit'])

    const derived = await registry.derive('debug', { params: { failureBoost: 0.5 }, rationale: 'failures were underweighted' })
    assert.equal(store.state.strategies[derived.id].lineage.derivedFrom, 'debug')
    assert.equal(store.state.strategies[derived.id].params.failureBoost, 0.5)
    assert.ok(derived.id.startsWith('debug-'))

    await assert.rejects(() => registry.derive('debug', { params: { madeUpKnob: 1 } }), /no parameter/)
    await assert.rejects(() => registry.derive('debug', { disableHooks: ['filter'] }), /filter hook/)
    await assert.rejects(() => registry.register({ impl: 'not-a-strategy' }), /unknown implementation/)
  })
})

test('strategy engine: a throwing hook is contained and eventually quarantined', async () => {
  await withStore(async (store) => {
    const registry = new StrategyRegistry({ store, logger: quiet })
    const broken = await registry.register({
      impl: 'distill',
      params: { tokenBudget: 900 },
      disabledHooks: [],
    })
    // Inject a genuinely broken hook for the test, at the registry boundary.
    const original = registry.resolve
    registry.resolve = (id) => {
      const resolved = original.call(registry, id)
      if (id === broken.id && resolved !== undefined) {
        resolved.hooks = { ...resolved.hooks, score: () => { throw new Error('boom') } }
      }
      return resolved
    }
    await registry.setStack(['guard', broken.id])

    const engine = new StrategyEngine({ registry, logger: quiet, options: { hookBudgetMs: 50 } })
    const plan = planRecall({ intent: 'orient' })
    const record = {
      id: 'r1', kind: 'fact', state: 'verified', confidence: 0.9, salience: 0.5,
      createdAt: Date.now(), updatedAt: Date.now(), embedding: [], access: { hits: 0 },
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const contribution = engine.score(record, plan)
      assert.equal(contribution.delta, 0, 'a broken strategy contributes nothing')
    }
    assert.equal(engine.health().find((row) => row.strategy === broken.id)?.quarantined, true)
    assert.equal(engine.revive(broken.id), true)
    assert.equal(engine.health().find((row) => row.strategy === broken.id)?.quarantined, false)
  })
})

test('strategy engine: debug mode disables time decay', async () => {
  await withStore(async (store) => {
    const registry = new StrategyRegistry({ store, logger: quiet })
    const engine = new StrategyEngine({ registry, logger: quiet })
    const record = { id: 'r', kind: 'failure', state: 'verified', confidence: 1, embedding: [], createdAt: 0, updatedAt: 0 }
    const plan = planRecall({ intent: 'orient' })
    assert.equal(engine.halfLifeMs(record, plan), 14 * 24 * 3600 * 1000)
    await registry.activate('debug')
    assert.equal(engine.halfLifeMs(record, plan), Number.POSITIVE_INFINITY)
  })
})

// ── Layer 3: meta ───────────────────────────────────────────────────────────

test('meta: observe -> propose -> apply -> rollback is a closed, audited loop', async () => {
  await withStore(async (store) => {
    const registry = new StrategyRegistry({ store, logger: quiet })
    const tuner = new Tuner({ store, registry, logger: quiet })

    for (let index = 0; index < 20; index++) {
      await tuner.observe({ usedIds: ['a', 'b'], ignoredIds: [], success: index % 4 !== 0, tokenCost: 600 })
    }
    assert.ok(tuner.report().samples === 20)

    const proposal = tuner.propose({ param: 'recall.halfLifeMs' })
    assert.equal(proposal.param, 'recall.halfLifeMs')
    const before = tuner.value('recall.halfLifeMs')

    const applied = await tuner.apply(proposal, { reason: 'test: shorten half-life' })
    assert.equal(tuner.value('recall.halfLifeMs'), proposal.to)
    assert.ok(applied.auditId.startsWith('tune_'))

    const evaluation = tuner.evaluate()
    assert.equal(typeof evaluation.metric, 'number')
    assert.ok(evaluation.samples >= 20)

    await tuner.rollback(applied.auditId, { reason: 'test: revert' })
    assert.equal(tuner.value('recall.halfLifeMs'), before)
  })
})

test('meta: the learning state is state — it survives a restart and a revert takes it back out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-tuning-'))
  try {
    const store = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const registry = new StrategyRegistry({ store, logger: quiet })
    const tuner = new Tuner({ store, registry, logger: quiet })
    await tuner.observe({ usedIds: [], ignoredIds: [], success: true, tokenCost: 0, objective: 'task_success' })
    assert.equal(store.state.tuning.samples.length, 1, 'the sample is written as state, not held in a private field')
    assert.equal(store.state.tuning.samples[0], 1, 'task_success with success=true rewards 1')
    const feedbackSeq = store.version // the observe transaction is the newest event

    // Arm credit must be persisted too, or UCB1 restarts blind.
    const proposal = tuner.propose({ param: 'recall.diversity' })
    const applied = await tuner.apply(proposal, { reason: 'test: credit an arm', force: true })
    assert.ok(Object.keys(store.state.tuning.arms).length >= 1, 'the applied arm is in state')
    assert.equal(store.state.tuning.history.length, 1)

    await store.close()
    await rm(join(dir, 'snapshot.json'), { force: true })
    const rebuilt = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const resumed = new Tuner({ store: rebuilt, registry: new StrategyRegistry({ store: rebuilt, logger: quiet }), logger: quiet })
    assert.equal(resumed.report().samples, 1, 'a restart resumes the sample window instead of zeroing it')
    assert.equal(resumed.report().applied, 1, 'and the tune history with it')

    // Rolling the tuning change back restores the arms it credited.
    await resumed.rollback(applied.auditId, { reason: 'test: rollback the arm credit' })
    assert.equal(rebuilt.state.tuning.history.length, 0, 'the history is state, so the revert removes it')
    assert.equal(resumed.report().applied, 0)

    // A feedback observation is revertible in the same way.
    await rebuilt.revert(feedbackSeq, 'test: that observation never happened')
    assert.equal(rebuilt.state.tuning.samples.length, 0)
    await rebuilt.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('meta: apply refuses below the sample floor, and safeMode freezes the tuner', async () => {
  await withStore(async (store) => {
    const registry = new StrategyRegistry({ store, logger: quiet })
    const tuner = new Tuner({ store, registry, logger: quiet })
    const proposal = tuner.propose({ param: 'recall.diversity' })
    await assert.rejects(() => tuner.apply(proposal, { reason: 'too early' }), /feedback samples/)

    const frozen = new Tuner({ store, registry, logger: quiet, safeMode: true })
    await assert.rejects(() => frozen.apply(proposal, { reason: 'frozen' }), /safeMode/)
  })
})

// ── guardrails ──────────────────────────────────────────────────────────────

test('guard: the invariant gate refuses stack, envelope and safeMode violations', async () => {
  await withStore(async (store) => {
    const gate = createInvariantGate({ safeMode: false })
    assert.throws(
      () => gate({ state: store.state, patch: { stackSet: { global: ['exploit'] } }, meta: { type: 'x' } }),
      /stack\.guard-present/,
    )
    assert.throws(
      () => gate({ state: store.state, patch: { paramsSet: { global: { 'evil.knob': 1 } } }, meta: { type: 'x' } }),
      /params\.envelope-only/,
    )
    assert.throws(
      () => gate({
        state: store.state,
        patch: { memorySet: {} },
        meta: { type: 'memory.split', payload: {} },
      }),
      /destructive-needs-reason/,
    )

    const safeGate = createInvariantGate({ safeMode: true })
    assert.throws(
      () => safeGate({ state: store.state, patch: { stackSet: { global: ['guard', 'debug'] } }, meta: { type: 'x' } }),
      /safeMode/,
    )
  })
})

test('guard: a registered validator blocks a transaction before it reaches the journal', async () => {
  await withStore(async (store) => {
    const registry = new StrategyRegistry({ store, logger: quiet })
    const gate = store.use(createInvariantGate({ safeMode: true }))
    const versionBefore = store.version
    await assert.rejects(() => registry.activate('debug'), /safeMode/)
    assert.equal(store.version, versionBefore, 'nothing was journaled')
    gate.dispose()
    await registry.activate('debug')
    assert.deepEqual(registry.stack(), ['guard', 'debug'])
  })
})

test('revert: a stack transaction that created a scope can be undone, a live stack still cannot be deleted', async () => {
  await withStore(async (store) => {
    store.use(createInvariantGate({ safeMode: false }))
    const scope = 'agent:undo-scope'

    // Forward: creating a scope is allowed.
    const created = await store.transact(
      { stackSet: { [scope]: ['guard', 'explore'] } },
      { type: 'strategy.setStack', scope, payload: { to: ['guard', 'explore'] } },
    )
    assert.deepEqual(store.state.stacks[scope], ['guard', 'explore'])

    // Regression: the inverse of a scope creation is `stackSet: {scope: null}`,
    // and the gate used to refuse every null — which made a per-agent strategy
    // switch impossible to roll back (reproduced live on 2026-10-06).
    const undone = await created.revert('test: drop the created scope')
    assert.equal(store.state.stacks[scope], undefined, 'the compensating transaction removes the scope it created')

    // revert-of-revert is a redo; it must work too, or the pair is not a real inverse.
    await undone.revert('test: redo the scope creation')
    assert.deepEqual(store.state.stacks[scope], ['guard', 'explore'])

    // A *forward* deletion of a live stack is still refused, and leaves no trace.
    const versionBefore = store.version
    await assert.rejects(
      () => store.transact({ stackSet: { [scope]: null } }, { type: 'strategy.setStack', scope }),
      /stack\.guard-present/,
    )
    assert.equal(store.version, versionBefore, 'the refused change never reached the journal')
    assert.deepEqual(store.state.stacks[scope], ['guard', 'explore'])
  })
})

test('journal: compaction archives the log, keeps every seq traceable, and still rebuilds the state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-compact-'))
  try {
    const store = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const ops = createMemoryOps({ store })
    await ops.remember({ kind: 'fact', subject: 'one', body: 'first' })
    await ops.remember({ kind: 'fact', subject: 'two', body: 'second' })
    await ops.remember({ kind: 'constraint', subject: 'three', body: 'third' })
    const remembered = await ops.remember({ kind: 'fact', subject: 'four', body: 'fourth' })
    const boundary = store.version
    assert.equal(boundary, 4, 'four remembers, four events')

    const result = await store.compact({ minEvents: 2 })
    assert.equal(result.compacted, true)
    assert.equal(result.boundary, boundary)
    assert.equal(result.archived, boundary, 'every event reaches the archive')

    const journalDir = join(dir, 'journal')
    const files = await readdir(journalDir)
    assert.equal(files.filter((name) => name.startsWith('journal-')).length, 0, 'live segments were folded away')
    assert.equal(files.filter((name) => name.startsWith('archive-')).length, 1)
    assert.equal(files.filter((name) => name.startsWith('checkpoint-')).length, 1)
    assert.equal(files.includes('pruned.json'), false, 'nothing is pruned unless a retention window is configured')

    // Traceability — the acceptance criterion for compaction: `ana_audit
    // view=journal` reads recentEvents and must still reach seq 1, whose segment
    // no longer exists.
    const traced = store.recentEvents({ limit: 500 })
    assert.equal(traced.length, boundary)
    assert.equal(traced[traced.length - 1].seq, 1, 'the oldest seq is still traceable')
    assert.equal(store.event(1).archived, true, 'and it is marked as archived')

    // The archive kept `undo`, so the oldest event is still revertible.
    const undone = await store.revert(1, 'test: revert an archived event')
    assert.ok(undone.seq > boundary)

    // A snapshot-less replay must rebuild the state from checkpoint + live log.
    const expected = {
      version: store.version,
      memories: Object.keys(store.state.memories).sort(),
      stacks: JSON.stringify(store.state.stacks),
      params: JSON.stringify(store.state.params),
    }
    await store.close()
    await rm(join(dir, 'snapshot.json'), { force: true })
    const rebuilt = await MemoryStore.open({ rootDir: dir, logger: quiet })
    assert.equal(rebuilt.state.version, expected.version, 'checkpoint + live log reproduces the version')
    assert.deepEqual(Object.keys(rebuilt.state.memories).sort(), expected.memories)
    assert.equal(JSON.stringify(rebuilt.state.stacks), expected.stacks)
    assert.equal(JSON.stringify(rebuilt.state.params), expected.params)
    assert.ok(rebuilt.state.memories[remembered.id] !== undefined, 'surviving records are intact after the checkpoint replay')

    // The second compaction *appends* a segment instead of folding history back
    // into one file — that layout is the whole point (O(live), not O(history)),
    // so the older segment must come out byte-identical.
    const oldest = join(journalDir, `archive-${String(boundary).padStart(6, '0')}.jsonl`)
    const before = await readFile(oldest, 'utf8')
    const again = await rebuilt.compact({ minEvents: 1 })
    assert.equal(again.compacted, true)
    assert.equal(again.archived, 1, 'only the events that were still live are folded')
    assert.equal(again.folded, 1)
    const after = await readFile(oldest, 'utf8')
    assert.equal(after, before, 'the existing archive segment was never rewritten')
    assert.equal((await readdir(journalDir)).filter((name) => name.startsWith('archive-')).length, 2)
    const tracedAgain = rebuilt.recentEvents({ limit: 500 })
    assert.equal(tracedAgain.length, expected.version, 'appending a segment keeps every seq traceable')
    assert.equal(tracedAgain[0].seq, expected.version)
    const layout = rebuilt.journalStats()
    assert.equal(layout.live, 1)
    assert.equal(layout.archives, 2)
    assert.equal(layout.checkpoints, 1)
    assert.equal(layout.prunedThroughSeq, 0)
    await rebuilt.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('journal: the segment-count guard merges the oldest archives without losing a seq', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-segmerge-'))
  try {
    const store = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const ops = createMemoryOps({ store })
    const retain = { maxSegments: 2 }
    for (let round = 0; round < 3; round++) {
      await ops.remember({ kind: 'fact', subject: `round ${round}`, body: `body ${round}` })
      await ops.remember({ kind: 'fact', subject: `round ${round} b`, body: `body ${round} b` })
      await store.compact({ minEvents: 1, retain })
    }
    const journalDir = join(dir, 'journal')
    const archives = (await readdir(journalDir)).filter((name) => name.startsWith('archive-'))
    assert.equal(archives.length, 2, 'the guard holds the archive count at the configured bound')

    // Merging is lossless: every seq is still traceable, the oldest one is still
    // marked archived, and its `undo` survived the rewrite.
    const traced = store.recentEvents({ limit: 500 })
    assert.equal(traced.length, 6)
    assert.equal(traced[5].seq, 1)
    assert.equal(store.event(1).archived, true)
    const undone = await store.revert(1, 'test: revert an event that survived a segment merge')
    assert.equal(undone.seq, 7)
    assert.equal(store.journalStats().archives, 2)
    assert.equal(store.journalStats().prunedThroughSeq, 0, 'merging never prunes')
    assert.equal((await readdir(journalDir)).includes('pruned.json'), false)
    await store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('journal: the opt-in retention policy prunes whole segments, marks it, and explains the lost reverts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-retain-'))
  try {
    const store = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const ops = createMemoryOps({ store })
    await ops.remember({ kind: 'fact', subject: 'old one', body: 'will be pruned' })
    await ops.remember({ kind: 'fact', subject: 'old two', body: 'will be pruned' })
    await store.compact({ minEvents: 1 }) // archive #2 owns seq 1..2
    for (let i = 0; i < 10; i++) {
      await ops.remember({ kind: 'fact', subject: `kept ${i}`, body: `kept body ${i}` })
    }
    const result = await store.compact({ minEvents: 1, retain: { events: 2 } })
    assert.equal(result.compacted, true)
    assert.equal(result.pruned.enabled, true)
    assert.equal(result.pruned.segments, 1, 'the one segment outside the retained window is dropped')
    assert.equal(result.pruned.events, 2)
    assert.equal(result.pruned.throughSeq, 2)
    assert.equal(result.pruned.cutoff, 10)

    const journalDir = join(dir, 'journal')
    const marker = JSON.parse(await readFile(join(journalDir, 'pruned.json'), 'utf8'))
    assert.equal(marker.throughSeq, 2)
    assert.equal(marker.retainEvents, 2)
    assert.equal(marker.droppedSegments, 1)

    // The loss is visible, not silent: the seq leaves memory immediately, and a
    // revert explains the policy instead of reporting a non-existent seq.
    assert.equal(store.event(1), undefined)
    assert.equal(store.journalStats().prunedThroughSeq, 2)
    await assert.rejects(() => store.revert(2, 'test: pruned'), /pruned by the journal retention policy/)
    assert.equal(store.auditTrail(5).some((row) => row.type === 'journal.prune'), true, 'the prune is audited')

    // Pruning never touches domain state: the checkpoint still carries every
    // memory, and a restart rebuilds them from it alone.
    assert.equal(Object.keys(store.state.memories).length, 12)
    const settled = store.version
    await store.close()
    await rm(join(dir, 'snapshot.json'), { force: true })
    const rebuilt = await MemoryStore.open({ rootDir: dir, logger: quiet })
    assert.equal(rebuilt.state.version, settled)
    assert.equal(Object.keys(rebuilt.state.memories).length, 12, 'the checkpoint alone still rebuilds the pruned state')
    assert.equal(rebuilt.journalStats().prunedThroughSeq, 2, 'the marker survives the restart')
    await rebuilt.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('revert: an audit-only event is refused instead of reporting a phantom rollback', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    const remembered = await ops.remember({ kind: 'fact', subject: 'real change', body: 'has an inverse' })
    const auditOnly = await store.audit('recall', { intent: 'orient', selected: 0 })
    const versionBefore = store.version

    await assert.rejects(
      () => store.revert(auditOnly.seq, 'undo a recall record'),
      /only appended an audit row/,
    )
    assert.equal(store.version, versionBefore, 'the refusal never reaches the journal')
    assert.equal(
      store.state.audit.some((row) => row.type === 'recall'),
      true,
      'and the audit row it refused to erase is still there',
    )

    // The same path still compensates a real change.
    const undone = await store.revert(remembered.seq, 'a real change has a real inverse')
    assert.equal(undone.seq, versionBefore + 1)
    assert.equal(store.state.memories[remembered.id], undefined)
  })
})

test('guard: the tool guard denies locked forgets, missing reasons and safeMode meta changes', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    const locked = await ops.remember({ kind: 'fact', subject: 'locked thing', body: 'x' })
    await ops.lock({ ids: [locked.id], reason: 'test' })

    let safeMode = false
    const guard = createToolGuard({ store, safeMode: () => safeMode })

    // The host's *execution* object carries the tool arguments under
    // `arguments` (dsh-tools `createExecution`: `{ ...base, arguments: … }`),
    // never `args`. Asserting the real shape is the whole point of this test:
    // with `args` every check below passed here and was silently inert on the
    // host (live probe: a 51-id ana_lock reached ops.lock).
    assert.equal(guard({ name: 'read', arguments: {} }), undefined, 'unrelated tools are untouched')
    assert.match(guard({ name: 'ana_forget', arguments: { ids: [locked.id], reason: 'because' } }), /locked/)
    assert.match(guard({ name: 'ana_forget', arguments: { ids: ['other'], reason: '' } }), /reason/)
    assert.equal(guard({ name: 'ana_recall', arguments: {} }), undefined)
    const tooMany = { ids: Array.from({ length: 51 }, (_, index) => `m${index}`) }
    assert.match(guard({ name: 'ana_lock', arguments: tooMany }), /per-call budget/, 'the id budget reads the real argument field')
    assert.match(guard({ name: 'ana_lock', args: tooMany }), /per-call budget/, 'the pre-0.2 `args` alias still resolves')

    safeMode = true
    assert.match(guard({ name: 'ana_tune', arguments: { action: 'apply' } }), /safeMode/)
    assert.equal(guard({ name: 'ana_strategy', arguments: { action: 'list' } }), undefined, 'read-only strategy calls stay allowed')
  })
})
