/**
 * Adapter suite: the four DSH rows, driven through a minimal host stub.
 *
 * The point is to execute the *real* row code — registration shapes, effect
 * nesting, service publication, tool execution, the monotonic guard — not to
 * re-test the engine (that is core.test.js). `test/host-loader.mjs` maps the two
 * host packages to stubs, because the real ones live in the running profile.
 * @module dsh-anagenesis/test/adapter.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply as coreApply, Config as CoreConfig, compactionPolicy, defaultRootDir } from '../src/index.js'
import { apply as toolsApply, Config as ToolsConfig } from '../src/tools/index.js'
import { apply as guardApply, Config as GuardConfig } from '../src/guard/index.js'
import { apply as presetApply, Config as PresetConfig, hasPresetRegistry } from '../src/preset/index.js'
import { apply as bindApply } from '../src/preset/bind.js'
import { apply as vizApply, Config as VizConfig } from '../src/viz/index.js'
import { losslessProblem } from './lossless.mjs'

const quiet = { info() {}, warn() {}, debug() {} }

/**
 * A host stub with exactly the surface the rows use.
 * @param {Record<string, any>} [seed]
 */
function makeHost(seed = {}) {
  const services = { ...seed }
  const tools = new Map()
  const guards = []
  const disposers = []
  const injected = []
  const ctx = {
    logger: quiet,
    get: (name) => services[name],
    provide(name, value) {
      services[name] = value
      return () => { delete services[name] }
    },
    inject(deps, callback) {
      injected.push({ deps, callback })
      return { id: `child-${injected.length}` }
    },
    effect(body) {
      const result = body()
      const disposer = async () => {
        if (typeof result === 'function') await result()
        else if (result !== null && typeof result?.then === 'function') {
          const inner = await result
          if (typeof inner === 'function') await inner()
        }
      }
      disposers.push(disposer)
      return disposer
    },
    on: () => ({ dispose() {} }),
    emit() {},
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate registration of "${definition.name}"`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      guard(guard) {
        guards.push(guard)
        return () => {
          const index = guards.indexOf(guard)
          if (index >= 0) guards.splice(index, 1)
        }
      },
      restrict() {
        throw new Error('tools.restrict() requires a scoped context (agent.ctx)')
      },
    },
  }
  return { ctx, services, tools, guards, disposers, injected }
}

/**
 * Run every effect disposer the fake host collected, newest first — the same
 * order Cordis uses on fibre unload.
 * @param {{ disposers: (() => Promise<void>)[] }} host
 */
async function disposeHost(host) {
  for (const dispose of [...host.disposers].reverse()) await dispose()
}

test('adapters: every row declares the documented plugin contract', () => {
  assert.equal(typeof coreApply, 'function')
  assert.equal(typeof toolsApply, 'function')
  assert.equal(typeof guardApply, 'function')
  assert.equal(typeof presetApply, 'function')
  for (const Config of [CoreConfig, ToolsConfig, GuardConfig, PresetConfig]) {
    assert.ok(Config !== undefined, 'each row exports a Config schema')
  }
  assert.ok(defaultRootDir().endsWith('anagenesis'), defaultRootDir())
})

test('adapters: the compaction policy maps host config onto the journal options, and defaults to keeping every seq', () => {
  assert.deepEqual(
    compactionPolicy({ compactAfterEvents: 10, archiveMaxSegments: 3, retainEvents: 5 }),
    { minEvents: 10, retain: { maxSegments: 3, events: 5 } },
    'the three keys must reach the journal unchanged',
  )
  const defaults = compactionPolicy({})
  assert.equal(defaults.minEvents, 2000)
  assert.equal(defaults.retain.maxSegments, 16)
  assert.equal(defaults.retain.events, 0, 'retention is off unless a host asks for it, whatever the code around it does')
  // Garbage in the config must degrade to the safe side: unbounded segments and
  // no pruning, rather than NaN reaching a comparison and reading as "enabled".
  const junk = compactionPolicy({ compactAfterEvents: 'abc', archiveMaxSegments: null, retainEvents: undefined })
  assert.ok(Number.isNaN(junk.minEvents) || junk.minEvents === 2000)
  assert.equal(junk.retain.events, 0)
})

test('adapters: core publishes ctx.anagenesis and the tool row registers the whole ana_* surface', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-adapter-'))
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: dir, safeMode: false })
    assert.ok(host.services.anagenesis, 'ctx.provide("anagenesis", ...) ran')
    assert.equal(host.services.anagenesis.store.rootDir, dir)

    toolsApply(host.ctx, {})
    const names = [...host.tools.keys()].sort()
    assert.equal(names.length, 14, `expected 14 tools, got ${names.length}: ${names.join(', ')}`)
    for (const required of [
      'ana_recall', 'ana_remember', 'ana_promote', 'ana_demote', 'ana_lock', 'ana_expire',
      'ana_split', 'ana_rethink', 'ana_forget', 'ana_strategy', 'ana_tune', 'ana_feedback',
      'ana_audit', 'ana_link',
    ]) {
      assert.ok(names.includes(required), `missing tool ${required}`)
    }
    for (const [, definition] of host.tools) {
      assert.equal(typeof definition.execute, 'function', `${definition.name} has execute`)
      assert.equal(typeof definition.output.render, 'function', `${definition.name} renders output`)
      assert.equal(definition.parameters.type, 'object', `${definition.name} declares an object parameter root`)
    }

    guardApply(host.ctx, {})
    assert.equal(host.guards.length, 1, 'one monotonic guard installed')

    await disposeHost(host)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('adapters: a full agent round-trip through the registered tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-roundtrip-'))
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: dir })
    toolsApply(host.ctx, {})
    guardApply(host.ctx, {})
    const callRaw = (name, args, exec = {}) => host.tools.get(name).execute(args, exec)
    // Every answer this test sees is checked the way the real host checks it: a
    // round trip through JSON must not lose anything, otherwise the host rejects
    // the whole call with `value is not lossless JSON`. The stub host does not
    // validate, which is how `ana_audit view=memory` shipped broken.
    const call = async (name, args, exec = {}) => {
      const value = await callRaw(name, args, exec)
      assert.equal(losslessProblem(value, `${name} output`), null)
      return value
    }

    // 1. commit — exploit is the default stack, so the write lands active.
    const remembered = await call('ana_remember', {
      kind: 'constraint',
      subject: 'the journal is append-only',
      body: 'never rewrite a journal segment; compensating events only',
      confidence: 0.9,
      evidence: ['store.test.js: journal replay'],
    })
    assert.equal(remembered.state, 'active')
    assert.ok(remembered.decidedBy.includes('exploit'))
    assert.equal(remembered.seq, 1)

    // 2. recall by intent
    const recalled = await call('ana_recall', { intent: 'orient', query: 'journal append-only' })
    assert.match(recalled.text, /append-only/)
    assert.ok(recalled.selected.includes(remembered.id))
    assert.deepEqual(recalled.strategy, ['guard', 'exploit'])

    // 3. promote with evidence
    const promoted = await call('ana_promote', {
      ids: [remembered.id],
      to: 'verified',
      reason: 'checked against the store implementation',
      evidence: ['read store.js'],
    })
    assert.equal(promoted.to, 'verified')

    // 4. split
    const split = await call('ana_split', {
      id: remembered.id,
      reason: 'one record turned out to hold two claims',
      into: [{ subject: 'journal is append-only', body: 'never rewrite segments', kind: 'constraint' }],
    })
    assert.equal(split.children.length, 1)

    // 5. switch cognitive mode, then revert it by seq
    const switched = await call('ana_strategy', { action: 'switch', id: 'debug', rationale: 'hunting a bug' })
    assert.deepEqual(switched.stack, ['guard', 'debug'])
    const reverted = await call('ana_strategy', { action: 'revert', seq: switched.seq })
    assert.deepEqual(reverted.stack, ['guard', 'exploit'])

    // 6. rethink — an explicit competing hypothesis
    const rethought = await call('ana_rethink', {
      premise: 'the journal is append-only',
      counterfactual: 'if a segment is corrupt we must be able to truncate it',
      ids: [remembered.id],
    })
    assert.ok(rethought.hypothesisId)

    // 7. feedback closes the loop
    const feedback = await call('ana_feedback', {
      usedIds: [remembered.id],
      ignoredIds: [split.children[0]],
      success: true,
      tokenCost: recalled.tokens,
    })
    assert.ok(feedback.reward > 0)
    assert.equal(feedback.objective, 'utilization')

    // 8. observability
    const status = await call('ana_audit', { view: 'status' })
    assert.ok(status.status.memories >= 3)
    assert.deepEqual(status.status.stacks.global, ['guard', 'exploit'])
    const journal = await call('ana_audit', { view: 'journal', limit: 5 })
    assert.ok(journal.rows.length > 0)
    assert.ok(journal.rows[0].seq > 0)

    // 8b. the per-memory view — the regression that made every `view=memory`
    // call fail on the live host: a 192-float embedding assigned as `undefined`
    // kept its key, JSON dropped it, and the host rejected the answer as lossy.
    // It is also the only view that shows resolved links and provenance, i.e.
    // the eye a rollback check needs.
    const linked = await call('ana_link', { from: split.children[0], to: remembered.id, rel: 'part_of' })
    assert.ok(linked.ok)
    const memoryView = await call('ana_audit', { view: 'memory', id: split.children[0] })
    assert.equal(memoryView.memory.id, split.children[0])
    assert.equal(Object.hasOwn(memoryView.memory, 'embedding'), false, 'the embedding key must be absent, never present-and-undefined')
    assert.equal(memoryView.memory.linksResolved.length, 1)
    assert.equal(memoryView.memory.linksResolved[0].to, remembered.id)
    assert.equal(memoryView.memory.linksResolved[0].exists, true, 'a link whose target exists must say so')
    assert.ok(memoryView.memory.provenance !== undefined, 'provenance is part of why-do-I-believe-this')
    assert.equal(typeof memoryView.memory.provenance.source, 'string')
    assert.ok(Array.isArray(memoryView.memory.provenance.evidence))
    assert.equal(typeof memoryView.memory.createdAt, 'number')

    // 9. the meta layer is advisory until evidence exists
    const proposal = await call('ana_tune', { action: 'propose', param: 'recall.diversity' })
    assert.equal(proposal.proposal.param, 'recall.diversity')
    await assert.rejects(
      () => call('ana_tune', { action: 'apply', param: 'recall.diversity', value: 0.4, reason: 'too early' }),
      /feedback samples/,
    )

    // 10. the monotonic guard denies a locked forget without force.
    // The exec passed to a guard is the host's execution object, whose argument
    // field is `arguments` (dsh-tools `createExecution`), not `args`.
    const locked = await call('ana_lock', { ids: [remembered.id], reason: 'core invariant' })
    assert.ok(locked.ok)
    const reason = host.guards[0]({ name: 'ana_forget', arguments: { ids: [remembered.id], reason: 'tidy up' } })
    assert.match(String(reason), /locked/)
    assert.equal(host.guards[0]({ name: 'ana_recall', arguments: { intent: 'orient' } }), undefined)

    // 11. an explicit agent scope reaches the tool without breaking the default
    const scoped = await call('ana_recall', { intent: 'orient' }, { agent: { id: 'agent-42' } })
    assert.equal(scoped.intent, 'orient')

    await disposeHost(host)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('adapters: the lifetime counters move with the operations that own them, and a deduplicated write reports no seq', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-stats-'))
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: dir })
    toolsApply(host.ctx, {})
    const call = async (name, args, exec = {}) => {
      const value = await host.tools.get(name).execute(args, exec)
      assert.equal(losslessProblem(value, `${name} output`), null)
      return value
    }

    const first = await call('ana_remember', { kind: 'fact', subject: 'counted once', body: 'body' })
    assert.ok(first.seq > 0)
    const duplicate = await call('ana_remember', { kind: 'fact', subject: 'counted once', body: 'body' })
    assert.equal(duplicate.deduplicated, true, 'identical content is deduplicated')
    assert.equal(Object.hasOwn(duplicate, 'seq'), false, 'a deduplicated write has no seq of its own — the key is absent, not undefined')

    await call('ana_recall', { intent: 'orient' })
    await call('ana_recall', { intent: 'orient', query: 'counted once' })

    const status = await call('ana_audit', { view: 'status' })
    assert.equal(status.status.stats.writes, 1, 'one accepted commit; the deduplicated call wrote nothing')
    assert.equal(status.status.stats.recalls, 2, 'each recall call is one observation, selected or not')
    assert.ok(status.status.stats.commits > status.status.stats.writes, 'transactions still outnumber writes')

    // The same contract for the other "no transaction of my own" path: a feedback
    // with nothing to credit still feeds the tuner but must not hand back a seq
    // that belongs to the previous transaction.
    const emptyFeedback = await call('ana_feedback', { usedIds: [], ignoredIds: [], success: true, objective: 'task_success' })
    assert.equal(emptyFeedback.reward, 1, 'task_success with success=true is a reward of 1')
    assert.equal(Object.hasOwn(emptyFeedback, 'seq'), false, 'nothing was written, so there is no seq')
    const credited = await call('ana_feedback', { usedIds: [first.id], ignoredIds: [], success: true })
    assert.ok(credited.seq > 0, 'a feedback that actually booked salience does have a seq')
    await disposeHost(host)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('adapters: the viz row adds two read-only tools, and withdrawing it leaves the core untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-viz-row-'))
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: dir })
    toolsApply(host.ctx, {})
    guardApply(host.ctx, {})
    const coreTools = [...host.tools.keys()].sort()
    assert.equal(coreTools.length, 14, 'the tools row owns the fourteen')
    assert.ok(VizConfig !== undefined, 'the viz row declares a Config schema')

    // The stub host does not collect registration disposers into a fibre the way
    // Cordis does, so capture them here: withdrawal is the property under test.
    const captured = []
    const register = host.ctx.tools.register.bind(host.ctx.tools)
    host.ctx.tools.register = (definition) => {
      const dispose = register(definition)
      captured.push(dispose)
      return dispose
    }
    vizApply(host.ctx, { color: 'never', width: 80 })
    assert.deepEqual(
      [...host.tools.keys()].sort(),
      [...coreTools, 'ana_dashboard', 'ana_diagram'].sort(),
      'the viz row adds exactly its two tools',
    )
    assert.equal(host.guards.length, 1, 'and no guard: visualization is not a safety layer')
    assert.equal(host.services['anagenesis-viz'], undefined, 'and no service — ctx.provide would collide in the preset scope')

    const call = async (name, args, exec = {}) => {
      const value = await host.tools.get(name).execute(args, exec)
      assert.equal(losslessProblem(value, `${name} output`), null)
      return value
    }
    const versionBefore = host.services.anagenesis.store.version
    const dashboard = await call('ana_dashboard', { width: 76 }, {})
    assert.match(dashboard.text, /anagenesis 仪表盘/, 'the frame is terminal-facing and the row defaults to zh')
    assert.equal(dashboard.storeVersion, versionBefore)
    assert.equal(dashboard.auditSeq, 0, 'auditRenders is off by default: a read must not grow the journal')
    assert.equal(dashboard.redaction, 'secrets')

    const diagram = await call('ana_diagram', { kind: 'lifecycle', format: 'mermaid' }, {})
    assert.equal(diagram.kind, 'lifecycle')
    assert.equal(diagram.format, 'mermaid')
    assert.equal(diagram.artifactVersion, 1)
    assert.match(diagram.text, /anagenesis-viz v1/)
    assert.match(diagram.text, /stateDiagram-v2/)

    // The layer is observable about itself: the viz section reports its own counters.
    const selfView = await call('ana_dashboard', { sections: ['viz'], width: 76 }, {})
    assert.match(selfView.text, /渲染次数\s+2/, 'the frame reports the render it is producing, not the one before it')
    assert.match(selfView.text, /图表次数\s+1/)

    // Rendering is not a transaction, even through the tool boundary.
    assert.equal(host.services.anagenesis.store.version, versionBefore, 'a render must not write to the store')

    for (const dispose of [...captured].reverse()) dispose()
    assert.deepEqual([...host.tools.keys()].sort(), coreTools, 'unloading the row withdraws both tools and nothing else')
    assert.ok(host.services.anagenesis !== undefined, 'the core service is still published')
    await disposeHost(host)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('adapters: auditRenders is the one opt-in write, and it names the seq it wrote', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-viz-audit-'))
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: dir })
    toolsApply(host.ctx, {})
    vizApply(host.ctx, { color: 'never', auditRenders: true })
    const before = host.services.anagenesis.store.version
    const dashboard = await host.tools.get('ana_dashboard').execute({ sections: ['overview'] }, {})
    assert.equal(losslessProblem(dashboard, 'ana_dashboard output'), null)
    assert.ok(dashboard.auditSeq > before, `expected a fresh seq, got ${dashboard.auditSeq}`)
    assert.equal(host.services.anagenesis.store.version > before, true, 'with auditRenders on the render does write — by request')
    assert.equal(
      host.services.anagenesis.store.auditTrail(5).some((row) => row.type === 'viz.render'),
      true,
      'the audit trail names the render',
    )
    await disposeHost(host)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('adapters: ana_recall honours a caller token budget even under explore mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-budget-'))
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: dir })
    toolsApply(host.ctx, {})
    const call = (name, args) => host.tools.get(name).execute(args, {})
    for (let index = 0; index < 6; index++) {
      await call('ana_remember', { kind: 'fact', subject: `fact ${index}`, body: 'x'.repeat(200), confidence: 0.8 })
    }
    await call('ana_strategy', { action: 'switch', id: 'explore' })
    const tight = await call('ana_recall', { intent: 'orient', maxTokens: 120 })
    assert.ok(tight.tokens <= 200, `expected a tight block, got ${tight.tokens} tokens`)
    await disposeHost(host)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('adapters: the core row is idempotent — a second mount adopts the existing service', async () => {
  // The bundle mounts the core row globally and the `anagenesis` preset mounts it
  // again in the preset scope; ctx.provide refuses a duplicate name in one
  // isolation scope, so the row must adopt instead of republishing.
  const dir = await mkdtemp(join(tmpdir(), 'ana-idempotent-'))
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: dir })
    const first = host.services.anagenesis
    assert.ok(first, 'first mount published the service')

    const resolved = await coreApply(host.ctx, { rootDir: dir })
    assert.equal(resolved, undefined)
    assert.equal(host.services.anagenesis, first, 'second mount reused the existing service instance')
    assert.equal(host.disposers.length, 1, 'second mount created no extra lifetime effect')
    await disposeHost(host)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('adapters: every row apply resolves to an effect-legal value', async () => {
  // Regression guard for the bug that broke the first live install: Cordis
  // collects an `apply` result as an effect. A function is collected as a
  // disposer, null/undefined is accepted, a promise is awaited and its resolved
  // value collected — any other object throws `TypeError: Invalid effect` and
  // the fibre teardown rolls back everything the body created. An async row that
  // returns a `{ mode }` / `{ dispose }` status object therefore destroys itself.
  const dir = await mkdtemp(join(tmpdir(), 'ana-contract-'))
  const host = makeHost()
  try {
    const results = [
      ['anagenesis-core', await coreApply(host.ctx, { rootDir: dir })],
      ['anagenesis-tools', await toolsApply(host.ctx, {})],
      ['anagenesis-guard', await guardApply(host.ctx, {})],
      ['anagenesis-preset', await presetApply(host.ctx, { autoInstallDirectoryForm: false })],
    ]
    for (const [name, value] of results) {
      const legal = value === undefined || value === null || typeof value === 'function'
      assert.ok(
        legal,
        `${name}: apply resolved to ${Object.prototype.toString.call(value)}; Cordis would throw Invalid effect and unload the row`,
      )
    }
    // The core row's service must survive its own apply, and a dependent row
    // must actually start — the two symptoms the live boot lost.
    assert.ok(host.services.anagenesis, 'ctx.provide("anagenesis") survived apply')
    assert.equal(host.tools.size, 14, 'dependent tool row started and registered its tools')
    await disposeHost(host)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('adapters: preset-bind settles its bind before apply resolves, and disposes exactly once', async () => {
  // Two regressions guarded here:
  //  - the bind used to be fired and forgotten, so the preset could mount
  //    "ready" while the first turn still recalled under the default stack;
  //  - returning the effect disposer from apply made Cordis collect it twice,
  //    which reverted the activated stack twice and put the old one back.
  const calls = []
  const host = makeHost()
  host.services.anagenesis = {
    registry: {
      stack: () => ['guard', 'exploit'],
      setStack: async (ids) => {
        calls.push(['setStack', ids])
        return { stack: ids, seq: 1, revert: async () => { calls.push(['revert-stack']) } }
      },
    },
    store: {
      transact: async () => {
        calls.push(['transact'])
        return { seq: 2, revert: async () => { calls.push(['revert-budget']) } }
      },
    },
  }

  const resolved = await bindApply(host.ctx, { stack: ['guard', 'debug'], tokenBudget: 900, scope: 'global' })
  assert.equal(resolved, undefined, 'a row must not resolve to a value Cordis would collect as an effect')
  assert.deepEqual(calls[0], ['setStack', ['guard', 'debug']], 'the bind is awaited, not fired and forgotten')
  assert.ok(calls.some(([name]) => name === 'transact'), 'the budget write landed before apply resolved')

  await disposeHost(host)
  // Both writes must be compensated, newest first. Dropping the budget undo left
  // `recall.orient.tokenBudget` pinned in the scope after every preset unload —
  // the real journal recorded three unloads that reverted only the stack.
  assert.deepEqual(
    calls.filter(([name]) => name.startsWith('revert')),
    [['revert-budget'], ['revert-stack']],
    'unload undoes the budget write and the activation, newest first',
  )
})

test('adapters: the preset row registers the anagenesis preset through the service and withdraws it on unload', async () => {
  const registered = []
  const host = makeHost({
    agentPresets: {
      async register(definition) {
        registered.push(definition)
        return async () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
  })
  assert.equal(hasPresetRegistry(host.services.agentPresets), true)
  assert.equal(hasPresetRegistry({}), false)

  const resolved = await presetApply(host.ctx, {})
  assert.equal(resolved, undefined, 'a row must not resolve to a value Cordis would collect as an effect')
  assert.equal(registered.length, 1)
  const preset = registered[0]
  assert.equal(preset.id, 'anagenesis')
  assert.equal(preset.name, 'Anagenesis 自进化 Agent')
  assert.ok(preset.plugins.some((row) => row.id === 'anagenesis-core'))
  assert.ok(preset.plugins.some((row) => row.id === 'anagenesis-preset-bind'))
  const persona = preset.plugins.find((row) => row.id === 'persona')
  // The persona row's real schema is `{ prefix (required), suffix, … }`; the
  // preset identity goes in `prefix` and the operating notes in `suffix`.
  assert.equal(persona.name, '@deepseek-ai/dsh-persona')
  assert.match(persona.config.prefix, /ana_recall/)
  assert.match(persona.config.prefix, /\{\{model\}\}/)
  assert.ok(persona.config.suffix.length > 0, 'the operating notes are delivered as the row\u2019s suffix section')
})

test('adapters: the preset row binds reactively when agentPresets appears after this row applies', async () => {
  const host = makeHost() // no agentPresets yet — the late-publish case
  const resolved = await presetApply(host.ctx, { autoInstallDirectoryForm: false })

  assert.equal(resolved, undefined, 'a row must not resolve to a value Cordis would collect as an effect')
  assert.equal(host.injected.length, 1, 'one reactive bind was installed')
  assert.deepEqual(host.injected[0].deps, ['agentPresets'])

  // The service shows up later; the bind must register the preset now.
  const registered = []
  host.services.agentPresets = {
    async register(definition) {
      registered.push(definition)
      return async () => {}
    },
  }
  host.injected[0].callback(host.ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'anagenesis')
  assert.ok(registered[0].plugins.some((row) => row.id === 'anagenesis-tools'))
})
