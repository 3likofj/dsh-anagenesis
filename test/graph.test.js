/**
 * Graph retrieval and supersession (Wave 1).
 *
 * Two promises are under test:
 *   1. a typed link can bring in a record the lexical gates would have missed
 *      (and only one hop, only from a strong seed, only for the relations that
 *      carry an argument: supports / part_of / caused_by / derived_from);
 *   2. `supersedes` is written on both sides and a superseded rule stops being
 *      injected — except when the caller (or the `debug` stack) asks for
 *      history deliberately.
 * @module dsh-anagenesis/test/graph
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '../src/store/store.js'
import { createMemoryOps } from '../src/memory/ops.js'
import { embed } from '../src/memory/embed.js'
import { buildIndex, recall } from '../src/memory/recall.js'
import { createScopeFilter } from '../src/scope/index.js'
import { createMemory, emptyState } from '../src/store/schema.js'
import { BUILTIN_IMPLS } from '../src/strategy/builtin.js'

const quiet = { info() {}, warn() {}, debug() {} }
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0)
const PROJECT = 'p1_graph'

/** @param {string} id @param {any} spec */
function record(id, spec) {
  return createMemory({ ...spec, id, state: spec.state ?? 'active' }, {
    now: NOW,
    embed,
    defaultScope: { tier: 'project', projectId: PROJECT },
  })
}

/** @param {any[]} records */
function storeOf(records) {
  const state = emptyState(NOW)
  for (const item of records) state.memories[item.id] = item
  state.version = 1
  return { state }
}

const context = () => ({ scopeFilter: createScopeFilter({ projectId: PROJECT }) })

test('graph: a typed edge revives a record the lexical gate dropped', async () => {
  const seed = record('a', {
    kind: 'failure',
    subject: 'npm publish returns 403 while whoami is fine',
    body: 'the granular token was issued without Bypass 2FA',
    state: 'verified',
    confidence: 0.9,
  })
  const cause = record('b', {
    kind: 'procedure',
    subject: '发布凭据走仓库外临时 userconfig',
    body: '临时 npmrc 用完即删，仓库里不留 token',
    state: 'verified',
    confidence: 0.8,
    links: [{ rel: 'caused_by', to: 'a' }],
  })
  const unrelated = record('c', {
    kind: 'fact',
    subject: 'the office plants are watered on fridays',
    body: 'unrelated on purpose',
    state: 'verified',
    confidence: 0.8,
    links: [{ rel: 'related', to: 'a' }],
  })
  const result = await recall(storeOf([seed, cause, unrelated]), {
    intent: 'verify',
    query: 'npm publish 403 whoami',
  }, { context: context(), now: () => NOW })

  const ids = result.selected.map((row) => row.id)
  assert.ok(ids.includes('a'), 'the seed is selected')
  assert.ok(ids.includes('b'), 'the cause is revived through the edge')
  assert.equal(ids.includes('c'), false, 'a `related` edge may not smuggle in an unrelated record')
  const revived = result.selected.find((row) => row.id === 'b')
  assert.match(revived.reason, /graph ← caused_by a/, 'the output says how it was reached')
  assert.ok(result.graph.revived >= 1)
})

test('graph: expansion can be switched off for a pure lexical comparison', async () => {
  const seed = record('a', {
    kind: 'failure', subject: 'npm publish 403', body: 'token without Bypass 2FA', state: 'verified', confidence: 0.9,
  })
  const cause = record('b', {
    kind: 'procedure', subject: '凭据放临时 userconfig', body: '用完即删', state: 'verified', confidence: 0.8,
    links: [{ rel: 'caused_by', to: 'a' }],
  })
  const result = await recall(storeOf([seed, cause]), {
    intent: 'verify', query: 'npm publish 403', graphExpansion: false,
  }, { context: context(), now: () => NOW })
  assert.deepEqual(result.selected.map((row) => row.id), ['a'])
  assert.equal(result.graph.revived, 0)
})

test('supersede: both sides are written in one transaction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-supersede-'))
  try {
    const store = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const ops = createMemoryOps({ store })
    const older = await ops.remember({ kind: 'constraint', subject: '发布前只跑 npm test', body: '旧约定' })
    const newer = await ops.remember({ kind: 'constraint', subject: '发布前必须跑全部闸门', body: '新约定' })

    const linked = await ops.link({ from: newer.id, to: older.id, rel: 'supersedes' })
    assert.equal(linked.supersedes, older.id)
    assert.equal(linked.supersededBy, newer.id)

    const oldRecord = store.state.memories[older.id]
    const newRecord = store.state.memories[newer.id]
    assert.equal(oldRecord.supersededBy, newer.id, 'the old record points at its replacement')
    assert.ok(oldRecord.links.some((link) => link.rel === 'superseded_by' && link.to === newer.id))
    assert.ok(newRecord.links.some((link) => link.rel === 'supersedes' && link.to === older.id))
    assert.deepEqual(newRecord.supersedes, [older.id], 'the dead `supersedes` field is finally used')

    // Undo restores both sides — the inverse is a declarative patch, not a closure.
    await linked.revert('test')
    assert.equal(store.state.memories[older.id].supersededBy, null)
    assert.deepEqual(store.state.memories[newer.id].supersedes, [])
    await store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('supersede: self-links, cycles and cross-namespace replacements are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-supersede-refuse-'))
  try {
    const store = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const ops = createMemoryOps({ store })
    const a = await ops.remember({ kind: 'fact', subject: 'a', body: 'a' })
    const b = await ops.remember({ kind: 'fact', subject: 'b', body: 'b' })
    const foreign = await ops.remember({ kind: 'fact', subject: 'c', body: 'c', scope: { tier: 'project', projectId: 'other' } })

    await assert.rejects(() => ops.link({ from: a.id, to: a.id, rel: 'related' }), /cannot link to itself/)
    await ops.link({ from: a.id, to: b.id, rel: 'supersedes' })
    await assert.rejects(() => ops.link({ from: b.id, to: a.id, rel: 'supersedes' }), /supersede each other/)
    await assert.rejects(() => ops.link({ from: a.id, to: foreign.id, rel: 'supersedes' }), /same namespace/)
    await store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('supersede: recall hides the replaced rule unless history is requested', async () => {
  const older = record('old', {
    kind: 'constraint',
    subject: '发布前只需跑 npm test',
    body: '旧约定，已被取代',
    state: 'active',
    confidence: 0.7,
    supersededBy: 'new',
    links: [{ rel: 'superseded_by', to: 'new' }],
  })
  const newer = record('new', {
    kind: 'constraint',
    subject: '发布前必须跑全部闸门',
    body: '新约定：test/check/verify/boot/gate',
    state: 'verified',
    confidence: 0.9,
    supersedes: ['old'],
    links: [{ rel: 'supersedes', to: 'old' }],
  })
  const store = storeOf([older, newer])
  const request = { intent: 'orient', query: '发布前 跑 什么 门禁' }

  const plain = await recall(store, request, { context: context(), now: () => NOW })
  assert.deepEqual(plain.selected.map((row) => row.id), ['new'])
  assert.ok(plain.rejected.superseded >= 1, 'the old rule is reported as superseded, not silently missing')

  const history = await recall(store, { ...request, includeSuperseded: true }, { context: context(), now: () => NOW })
  const ids = history.selected.map((row) => row.id)
  assert.ok(ids.includes('old'), 'history is available when asked for')
  assert.ok(ids.includes('new'))
  const oldRow = history.selected.find((row) => row.id === 'old')
  assert.match(oldRow.reason, /superseded by new/)
})

test('supersede: the debug stack asks for history through its plan hook', () => {
  const plan = BUILTIN_IMPLS.debug.hooks.plan({ params: BUILTIN_IMPLS.debug.params })
  assert.equal(plan.includeSuperseded, true)
})

test('graph: the reverse index is keyed by target id', () => {
  const a = record('a', { kind: 'fact', subject: 'a', body: 'a' })
  const b = record('b', { kind: 'fact', subject: 'b', body: 'b', links: [{ rel: 'part_of', to: 'a' }] })
  const index = buildIndex(storeOf([a, b]).state)
  assert.deepEqual(index.inbound.get('a'), [{ from: 'b', rel: 'part_of' }])
})
