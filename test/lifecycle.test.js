/**
 * Wave 2: the write path becomes useful instead of merely safe.
 *
 *   - `ana_remember` reports near-duplicates and suggests an action, without
 *     ever merging on its own;
 *   - `supersedes` consolidates a set of records into one in a single
 *     transaction (the replacement and both sets of pointers land together);
 *   - `write.admissionThreshold` and `promote/demote.*` finally have consumers,
 *     and `recall.explorationRate` — which had none — is gone.
 * @module dsh-anagenesis/test/lifecycle
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '../src/store/store.js'
import { createMemoryOps, suggestAction } from '../src/memory/ops.js'
import { admitState } from '../src/tools/definitions.js'
import { lifecycleSuggestions, PARAM_ENVELOPE } from '../src/meta/tuner.js'
import { recall } from '../src/memory/recall.js'
import { createScopeFilter, GLOBAL_NAMESPACE } from '../src/scope/index.js'
import { emptyState } from '../src/store/schema.js'

const quiet = { info() {}, warn() {}, debug() {} }

test('lifecycle: admission only downgrades an explicitly low confidence', () => {
  assert.deepEqual(admitState('active', 0.4, 0.55), { state: 'draft', downgraded: true })
  assert.deepEqual(admitState('verified', 0.9, 0.55), { state: 'verified', downgraded: false })
  assert.deepEqual(admitState('active', undefined, 0.55), { state: 'active', downgraded: false }, 'omitting confidence keeps the strategy decision')
  assert.deepEqual(admitState('draft', 0.1, 0.55), { state: 'draft', downgraded: false })
})

test('lifecycle: the tunable envelope has no knob without a consumer', () => {
  assert.equal(Object.hasOwn(PARAM_ENVELOPE, 'recall.explorationRate'), false)
  assert.ok(PARAM_ENVELOPE['write.admissionThreshold'])
  assert.ok(PARAM_ENVELOPE['promote.hitRateThreshold'])
  assert.ok(PARAM_ENVELOPE['demote.missRateThreshold'])
})

test('lifecycle: usage feedback produces promote/demote suggestions', () => {
  const state = emptyState(1000)
  const add = (id, fields) => {
    state.memories[id] = {
      id, kind: 'fact', state: 'active', gist: id,
      access: { count: 0, hits: 0, misses: 0, lastAt: null },
      ...fields,
    }
  }
  add('good', { state: 'draft', access: { count: 3, hits: 3, misses: 0, lastAt: 1 } })
  add('bad', { state: 'active', access: { count: 3, hits: 0, misses: 3, lastAt: 1 } })
  add('mixed', { state: 'active', access: { count: 2, hits: 1, misses: 1, lastAt: 1 } })
  add('quiet', { state: 'active', access: { count: 1, hits: 1, misses: 0, lastAt: 1 } })
  add('gone', { state: 'retired', access: { count: 9, hits: 0, misses: 9, lastAt: 1 } })

  const report = lifecycleSuggestions(state, { promoteAt: 0.3, demoteAt: 0.6 })
  assert.deepEqual(report.promotable.map((row) => row.id), ['good'])
  assert.deepEqual(report.demotable.map((row) => row.id), ['bad'])
})

test('lifecycle: a similar write reports near-duplicates and never merges them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-similar-'))
  try {
    const store = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const ops = createMemoryOps({ store })
    const first = await ops.remember({
      kind: 'procedure',
      subject: '构建命令用 pnpm build',
      body: '本仓库 lockfile 是 pnpm-lock.yaml',
    })
    const second = await ops.remember({
      kind: 'procedure',
      subject: '构建命令用 pnpm build',
      body: '本仓库 lockfile 是 pnpm-lock.yaml，不要用 npm',
    })
    assert.equal(Object.keys(store.state.memories).length, 2, 'both records were written')
    assert.equal(second.similar.length, 1)
    assert.equal(second.similar[0].id, first.id)
    assert.ok(second.similar[0].similarity > 0.8)
    assert.equal(second.suggestedAction, 'supersede')
    assert.equal(store.state.memories[second.id].state, 'draft', 'the new record is untouched by the suggestion')
    await store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('lifecycle: suggestAction maps similarity to an action, and nothing to null', () => {
  assert.equal(suggestAction([]), null)
  assert.equal(suggestAction([{ similarity: 0.92 }]), 'supersede')
  assert.equal(suggestAction([{ similarity: 0.7 }]), 'merge')
  assert.equal(suggestAction([{ similarity: 0.4 }]), 'link')
})

test('lifecycle: remember can consolidate old records in the same transaction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-consolidate-'))
  try {
    const store = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const ops = createMemoryOps({ store })
    const a = await ops.remember({ kind: 'fact', state: 'active', subject: '构建用 pnpm', body: 'pnpm build' })
    const b = await ops.remember({ kind: 'fact', state: 'active', subject: '构建不用 npm', body: 'npm run build 会污染 lockfile' })
    const versionBefore = store.state.version
    const merged = await ops.remember({
      kind: 'procedure',
      state: 'active',
      subject: '构建：只用 pnpm build',
      body: '合并自两条旧记录：pnpm build；npm run build 会污染 lockfile',
      supersedes: [a.id, b.id],
    })
    assert.deepEqual(merged.supersedes.sort(), [a.id, b.id].sort())
    assert.equal(store.state.version, versionBefore + 1, 'one transaction, not three')
    assert.equal(store.state.memories[a.id].supersededBy, merged.id)
    assert.equal(store.state.memories[b.id].supersededBy, merged.id)
    assert.deepEqual(store.state.memories[merged.id].supersedes.sort(), [a.id, b.id].sort())

    // The old beliefs are gone from ordinary recall, present when asked for.
    const request = { intent: 'orient', query: '构建 pnpm npm lockfile' }
    const plain = await recall({ state: store.state }, request, {
      context: { scopeFilter: createScopeFilter({ projectId: null }) },
      now: () => Date.now(),
    })
    const ids = plain.selected.map((row) => row.id)
    assert.ok(ids.includes(merged.id))
    assert.equal(ids.includes(a.id), false)
    assert.equal(ids.includes(b.id), false)
    await store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('lifecycle: consolidation refuses unknown ids and other namespaces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-consolidate-refuse-'))
  try {
    const store = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const ops = createMemoryOps({ store })
    const foreign = await ops.remember({
      kind: 'fact',
      subject: 'other project rule',
      body: 'belongs elsewhere',
      scope: { tier: 'project', projectId: 'other' },
    })
    await assert.rejects(
      () => ops.remember({ kind: 'fact', subject: 'x', body: 'x', supersedes: ['mem_nope'] }),
      /unknown memory/,
    )
    await assert.rejects(
      () => ops.remember({ kind: 'fact', subject: 'x', body: 'x', supersedes: [foreign.id] }),
      /same namespace/,
    )
    assert.equal(store.state.memories[foreign.id].supersededBy, null)
    assert.equal(store.state.memories[foreign.id].scope.projectId, 'other')
    assert.equal(GLOBAL_NAMESPACE, 'global')
    await store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
