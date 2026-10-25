/**
 * Wave 3: the meta layer's loop is actually closed.
 *
 * Before this, `observe()` appended samples and credited no arm, `apply()` only
 * counted the reward a caller explicitly attached, and `evaluate()` compared
 * the rolling metric with a baseline recorded at apply time — so a change was
 * judged against samples that predated it. These tests pin the corrected loop:
 * one reward per pull, taken from the window *after* the change, and no second
 * change while the first is still being measured.
 * @module dsh-anagenesis/test/tuner-loop
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '../src/store/store.js'
import { StrategyRegistry } from '../src/strategy/registry.js'
import { EVALUATION_WINDOW, Tuner } from '../src/meta/tuner.js'

const quiet = { info() {}, warn() {}, debug() {} }

/** @param {(tuner: Tuner, store: MemoryStore) => Promise<void>} fn */
async function withTuner(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ana-tuner-loop-'))
  try {
    const store = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const registry = new StrategyRegistry({ store, logger: quiet })
    const tuner = new Tuner({ store, registry, logger: quiet })
    await fn(tuner, store)
    await store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** @param {Tuner} tuner @param {boolean} success */
async function feedback(tuner, success) {
  await tuner.observe({ usedIds: success ? ['a'] : [], ignoredIds: success ? [] : ['a'], success, tokenCost: 0, objective: 'task_success' })
}

test('tuner loop: a change is credited with the mean of its own evaluation window', async () => {
  await withTuner(async (tuner, store) => {
    for (let index = 0; index < 20; index++) await feedback(tuner, true)
    const proposal = tuner.propose({ param: 'recall.diversity' })
    const applied = await tuner.apply(proposal, { reason: 'test' })
    const row = store.state.tuning.history.at(-1)
    assert.equal(row.auditId, applied.auditId)
    assert.equal(row.samplesAt, 20, 'the baseline records where the window starts')
    assert.equal(row.evaluatedAt, undefined, 'nothing has been judged yet')

    for (let index = 0; index < EVALUATION_WINDOW; index++) await feedback(tuner, false)
    const judged = store.state.tuning.history.at(-1)
    assert.ok(judged.evaluatedAt > 0, 'the window closed')
    assert.equal(judged.windowSamples, EVALUATION_WINDOW)
    assert.equal(judged.windowReward, 0)
    const arm = store.state.tuning.arms[row.armId]
    assert.equal(arm.pulls, 1, 'one pull')
    assert.equal(arm.reward, 0, 'credited with the window mean, not five rewards')
  })
})

test('tuner loop: a second change waits until the first is measured', async () => {
  await withTuner(async (tuner) => {
    for (let index = 0; index < 20; index++) await feedback(tuner, true)
    const first = tuner.propose({ param: 'recall.diversity' })
    await tuner.apply(first, { reason: 'first' })
    const second = tuner.propose({ param: 'recall.halfLifeMs' })
    await assert.rejects(() => tuner.apply(second, { reason: 'too early' }), /still being evaluated/)
    const forced = await tuner.apply(second, { reason: 'forced', force: true })
    assert.ok(forced.auditId)
    assert.equal(tuner.report().applied, 2)
  })
})

test('tuner loop: evaluate compares only the samples after the change', async () => {
  await withTuner(async (tuner) => {
    for (let index = 0; index < 20; index++) await feedback(tuner, true)
    const proposal = tuner.propose({ param: 'recall.diversity' })
    await tuner.apply(proposal, { reason: 'test' })

    const empty = tuner.evaluate()
    assert.equal(empty.delta, 0)
    assert.match(empty.note, /no feedback since/)

    for (let index = 0; index < EVALUATION_WINDOW; index++) await feedback(tuner, false)
    const judged = tuner.evaluate()
    assert.equal(judged.delta, -1, 'post-change rewards are 0 against a baseline of 1')
    assert.equal(judged.rollback, true)
    assert.match(judged.note, /roll back/)

    const report = tuner.report()
    assert.equal(report.ready, true)
    assert.equal(report.evaluation.auditId, judged.auditId)
  })
})
