/**
 * Reflection suite: the timer-driven counterfactual sweep.
 *
 * These tests pin the three properties that make an autonomous writer
 * acceptable at all — it is bounded, it is idempotent per belief, and every
 * write it makes is an ordinary revertible transaction that cannot reach the
 * frozen tier-2 surface.
 * @module dsh-anagenesis/test/reflect.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '../src/store/store.js'
import { createMemoryOps } from '../src/memory/ops.js'
import { selectReflectionTargets, runReflection, DEFAULT_STALE_AFTER_MS } from '../src/meta/reflect.js'

const quiet = { info() {}, warn() {}, debug() {} }
const DAY = 24 * 3600 * 1000

/** @param {(store: MemoryStore, dir: string) => Promise<void>} fn */
async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'evo-reflect-'))
  const store = await MemoryStore.open({ rootDir: dir, logger: quiet })
  try {
    await fn(store, dir)
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('reflect: only established beliefs with a concrete decay signal are selected', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    const unfounded = await ops.remember({ kind: 'fact', subject: 'unfounded', body: 'b', state: 'verified', confidence: 0.9 })
    const founded = await ops.remember({
      kind: 'fact',
      subject: 'founded',
      body: 'b',
      state: 'verified',
      confidence: 0.9,
      // `ops.remember` reads evidence from `provenance`; the flat `evidence`
      // argument belongs to the `ana_remember` tool, which maps it in.
      provenance: { source: 'agent', evidence: ['measured while the code was open'] },
    })
    const draft = await ops.remember({ kind: 'fact', subject: 'still a draft', body: 'b', state: 'draft' })

    // Age is simulated by asking from the future: selection takes an explicit
    // `now`, so the test never has to backdate a record to age it.
    const aged = Date.now() + DEFAULT_STALE_AFTER_MS + DAY
    const targets = selectReflectionTargets(store.state, { now: aged, limit: 10 })
    assert.deepEqual(targets.map((row) => row.record.id), [unfounded.id], 'only the unfounded belief is worth questioning')
    assert.match(targets[0].reason, /without recording any evidence/)

    const ids = targets.map((row) => row.record.id)
    assert.ok(!ids.includes(founded.id), 'a belief with recorded evidence is left alone')
    assert.ok(!ids.includes(draft.id), 'unestablished beliefs are not this sweep\'s business')

    // A belief whose window has closed is a target even with evidence recorded.
    const lapsed = await ops.remember({
      kind: 'fact',
      subject: 'lapsed',
      body: 'b',
      state: 'verified',
      confidence: 0.9,
      provenance: { source: 'agent', evidence: ['was true once'] },
      ttlMs: 1,
    })
    const later = selectReflectionTargets(store.state, { now: Date.now() + DEFAULT_STALE_AFTER_MS + DAY, limit: 10 })
    const lapsedRow = later.find((row) => row.record.id === lapsed.id)
    assert.ok(lapsedRow !== undefined, 'a closed evidence window selects the record')
    assert.match(lapsedRow.reason, /evidence window/)
  })
})

test('reflect: a reflection is a bounded, idempotent, revertible memory.rethink transaction', async () => {
  await withStore(async (store) => {
    const ops = createMemoryOps({ store })
    const a = await ops.remember({ kind: 'fact', subject: 'belief A', body: 'b', state: 'verified', confidence: 0.9 })
    const b = await ops.remember({ kind: 'fact', subject: 'belief B', body: 'b', state: 'verified', confidence: 0.9 })
    const c = await ops.remember({ kind: 'fact', subject: 'belief C', body: 'b', state: 'verified', confidence: 0.9 })

    const versionBefore = store.version
    const paramsBefore = JSON.stringify(store.state.params)
    const stacksBefore = JSON.stringify(store.state.stacks)
    const strategiesBefore = JSON.stringify(store.state.strategies)
    const clock = () => Date.now() + DEFAULT_STALE_AFTER_MS + DAY

    const first = await runReflection({ store, ops, logger: quiet, now: clock, config: { maxReflectionsPerRun: 2 } })
    assert.equal(first.filed.length, 2, 'one run is bounded')
    assert.equal(first.considered, 2)
    assert.ok(store.version > versionBefore, 'reflection is a real transaction, not a mutation in place')

    for (const row of first.filed) {
      const hypothesis = store.state.memories[row.hypothesisId]
      assert.equal(hypothesis.kind, 'hypothesis')
      assert.equal(hypothesis.state, 'draft', 'a reflection proposes, it never promotes')
      assert.ok(hypothesis.links.some((link) => link.rel === 'counterfactual_of' && link.to === row.id))
      assert.ok(
        store.state.memories[row.id].links.some((link) => link.rel === 'challenged_by' && link.to === row.hypothesisId),
        'the questioned belief points back at its challenger',
      )
    }

    // Tier-2 is not merely avoided by convention — nothing here can reach it.
    assert.equal(JSON.stringify(store.state.params), paramsBefore, 'the tunable envelope is untouched')
    assert.equal(JSON.stringify(store.state.stacks), stacksBefore, 'strategy stacks are untouched')
    assert.equal(JSON.stringify(store.state.strategies), strategiesBefore, 'no strategy was registered')

    // Idempotent per belief: the next run picks up exactly the one still open.
    const second = await runReflection({ store, ops, logger: quiet, now: clock, config: { maxReflectionsPerRun: 2 } })
    assert.deepEqual(second.filed.map((row) => row.id), [c.id], 'a belief that already carries a live challenge is not asked twice')

    const third = await runReflection({ store, ops, logger: quiet, now: clock, config: { maxReflectionsPerRun: 2 } })
    assert.equal(third.filed.length, 0, 'with every established belief challenged the sweep goes quiet')

    const audit = store.recentEvents({ limit: 50, type: 'memory.rethink' })
    assert.equal(audit.length, 3, 'each reflection left its own audit row')

    // Fully revertible, like any other memory write.
    const withdrawn = await store.revert(first.filed[0].seq, 'test: withdraw the counterfactual')
    assert.ok(withdrawn.seq > 0)
    assert.equal(store.state.memories[first.filed[0].hypothesisId], undefined, 'the hypothesis is gone')
    assert.ok(
      !store.state.memories[first.filed[0].id].links.some((link) => link.rel === 'challenged_by'),
      'and the challenge link went with it, so the belief can be questioned again',
    )
    const reopened = await runReflection({ store, ops, logger: quiet, now: clock, config: { maxReflectionsPerRun: 2 } })
    assert.ok(reopened.filed.some((row) => row.id === first.filed[0].id), 'the withdrawn belief is selectable again')
  })
})
