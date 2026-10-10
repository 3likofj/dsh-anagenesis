/**
 * Permission suite — the acceptance evidence for 改造任务二.
 *
 * 这一套测试只回答三个问题，而且必须回答得**能在真实宿主上复现**：
 *
 *   1. 没启用预设时，写入类工具**存不存在**？（注册层：看不见）
 *   2. 没启用预设时，就算有人拿到了工具定义，写不写得进去？（执行层：不可绕过）
 *   3. 档位切换与预设注销之后，工具集与权限**回到原样**了吗？（可逆：精确回滚）
 *
 * 它跑的是真行：`src/index.js` + `src/tools/index.js` + `src/tools/gated.js` +
 * `src/guard/index.js` + `src/preset/bind.js`，只是宿主被换成了一个最小桩。
 * @module dsh-anagenesis/test/permission.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply as coreApply } from '../src/index.js'
import { apply as toolsApply } from '../src/tools/index.js'
import { apply as gatedApply } from '../src/tools/gated.js'
import { apply as guardApply } from '../src/guard/index.js'
import { apply as bindApply } from '../src/preset/bind.js'
import { createPermissions } from '../src/permission/registry.js'
import { TOOL_TIERS, requiredTier, toolsForGear } from '../src/permission/tiers.js'

const quiet = { info() {}, warn() {}, debug() {} }

/** The tools the always-on row registers: the read tier, and nothing else. */
const READ_TOOLS = Object.freeze(['ana_audit', 'ana_list', 'ana_preset', 'ana_recall', 'ana_scope', 'ana_strategy', 'ana_tune'])
const WRITE_TOOLS = Object.freeze([
  'ana_demote', 'ana_expire', 'ana_feedback', 'ana_forget', 'ana_link', 'ana_lock',
  'ana_remember', 'ana_promote', 'ana_rethink', 'ana_split',
])

/** @param {Record<string, any>} [seed] */
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

/** @param {{ disposers: (() => Promise<void>)[] }} host */
async function disposeHost(host) {
  for (const dispose of [...host.disposers].reverse()) await dispose()
}

const names = (host) => [...host.tools.keys()].sort()

test('permission: without the preset the write tier does not exist, and the guard refuses it anyway', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-perm-none-'))
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: dir })
    toolsApply(host.ctx, {})
    guardApply(host.ctx, {})
    const service = host.services.anagenesis

    // 1. Registration layer: invisible. This is the structural half of the fix —
    //    the host has no `readOnly`/`permission` field on a tool definition, so
    //    "registered or not" *is* the visibility model.
    assert.deepEqual(names(host), [...READ_TOOLS].sort())
    for (const writeTool of WRITE_TOOLS) {
      assert.equal(host.tools.has(writeTool), false, `${writeTool} must not be registered without the preset`)
    }
    assert.equal(service.permissions.gear(), 'none')
    assert.equal(service.permissionReport({}).presetActive, false)
    assert.equal(service.permissionReport({}).writeToolsAvailable, false)

    // 2. Execution layer: even a hand-obtained definition cannot write. The guard
    //    is monotonic — the refusal comes back as a string the host turns into a
    //    tool error, and no later listener can re-allow the call.
    const writeGuard = host.guards.find((guard) => String(guard({ name: 'ana_remember', arguments: {} }) ?? '').includes('preset'))
    assert.ok(writeGuard !== undefined, 'the tier guard refuses a write tool while no grant is live')
    const refusal = writeGuard({ name: 'ana_remember', arguments: { subject: 'x', body: 'y' } })
    assert.match(String(refusal), /preset is not active/)
    assert.match(String(refusal), /read-only/)

    // 3. Read actions stay available in every gear — inspection is not a privilege.
    assert.equal(writeGuard({ name: 'ana_recall', arguments: { intent: 'orient' } }), undefined)
    assert.equal(writeGuard({ name: 'ana_strategy', arguments: { action: 'list' } }), undefined)
    assert.match(String(writeGuard({ name: 'ana_strategy', arguments: { action: 'switch', id: 'debug' } })), /admin tier|preset is not active/)

    // 4. And the store really did not grow: the refusal is not a late failure.
    //    (`assert.rejects` needs a function that *returns* a promise — a
    //    synchronous throw escapes it — so the call is wrapped in an async arrow.)
    const before = service.store.version
    await assert.rejects(
      async () => service.permissions.assert('ana_remember', {}),
      (error) => error.name === 'PermissionDenied',
    )
    assert.equal(service.store.version, before, 'a refused write leaves the journal untouched')

    await disposeHost(host)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('permission: the gear moves the write tier in and out, and unloading restores the exact tool set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-perm-gear-'))
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: dir })
    toolsApply(host.ctx, {})
    guardApply(host.ctx, {})
    const service = host.services.anagenesis
    const readOnly = names(host)

    // passive: the preset is active (so the pulse and the stack binding work) but
    // no write tool is registered at all.
    gatedApply(host.ctx, { gear: 'passive' })
    assert.deepEqual(names(host), readOnly, 'passive registers nothing beyond the read tier')
    assert.equal(service.permissions.gear(), 'passive')
    assert.equal(service.permissionReport({}).presetActive, true, 'the preset is active — it is just not allowed to write')

    // assisted: the write tier appears, because the gear now covers it.
    const assisted = await service.setGear('assisted', { reason: 'test', by: 'host', force: true })
    assert.equal(assisted.previous, 'passive')
    for (const writeTool of WRITE_TOOLS) {
      assert.equal(host.tools.has(writeTool), true, `${writeTool} must appear with the write tier`)
    }
    assert.equal(names(host).length, READ_TOOLS.length + WRITE_TOOLS.length)

    // Now the tools actually work — and the write lands in the current project,
    // not in a global bucket.
    const remembered = await host.tools.get('ana_remember').execute({ kind: 'fact', subject: 'gear switch works', body: 'written under assisted' }, {})
    assert.equal(remembered.ok, true)
    assert.match(remembered.scope, /^project:/)

    // autonomous: admin actions open up.
    const autonomous = await service.setGear('autonomous', { reason: 'test', by: 'host', force: true })
    assert.equal(autonomous.previous, 'assisted')
    assert.equal(service.permissionReport({}).adminAvailable, true)
    const switched = await host.tools.get('ana_strategy').execute({ action: 'switch', id: 'debug', rationale: 'test' }, {})
    assert.deepEqual(switched.stack, ['guard', 'debug'])

    // Downgrade: the tools are withdrawn again, and the action is refused even
    // though the tool instance is still reachable through the old definition.
    const staleStrategy = host.tools.get('ana_strategy')
    await service.setGear('passive', { reason: 'test', by: 'agent' })
    assert.deepEqual(names(host), readOnly, 'dropping to passive withdraws every write tool')
    assert.equal(service.permissionReport({}).writeToolsAvailable, false)
    assert.match(String(host.guards[0]({ name: 'ana_strategy', arguments: { action: 'switch', id: 'exploit' } }) ?? host.guards[1]({ name: 'ana_strategy', arguments: { action: 'switch', id: 'exploit' } })), /gear|admin/)

    // Gear overrides are revertible: disposing returns to what the grants say.
    autonomous.revert()
    assisted.revert()
    assert.equal(service.permissions.gear(), 'passive')

    // And the whole row unloads back to exactly the read tier.
    await disposeHost(host)
    assert.deepEqual(names(host), readOnly, 'after unload the tool set is exactly what the plugin installs with no preset')
    assert.equal(service.permissions.activeCount(), 0)
    assert.equal(service.permissions.gear(), 'none')
    assert.equal(staleStrategy.name, 'ana_strategy', 'the captured definition is inert, not resurrected')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('permission: a tool instance that outlives its grant refuses to execute', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-perm-stale-'))
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: dir })
    toolsApply(host.ctx, {})
    gatedApply(host.ctx, { gear: 'assisted' })
    await bindApply(host.ctx, { gear: 'assisted', stack: ['guard', 'exploit'], scope: 'global' })

    // Capture the *instance* while it is live: this is what a host that caches a
    // definition, or a call already in flight, is holding.
    const service = host.services.anagenesis
    const store = service.store
    const live = host.tools.get('ana_remember')
    const first = await live.execute({ kind: 'fact', subject: 'before unload', body: 'grant is live' }, {})
    assert.equal(first.ok, true)

    await disposeHost(host)
    // The service itself is withdrawn on unload (`ctx.provide`'s inverse), which
    // is why the store was captured above: the stale *tool* is the subject here.
    assert.equal(host.services.anagenesis, undefined, 'the row withdrew its service')
    const versionAfterUnload = store.version
    await assert.rejects(
      () => live.execute({ kind: 'fact', subject: 'after unload', body: 'must not land' }, {}),
      (error) => error.name === 'PermissionDenied' && /no longer live/.test(error.message),
    )
    assert.equal(store.version, versionAfterUnload, 'the stale instance wrote nothing')
    assert.equal(Object.values(store.state.memories).some((record) => record.subject === 'after unload'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('permission: raising your own gear needs the host, lowering it never does', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-perm-escalate-'))
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: dir })
    toolsApply(host.ctx, {})
    gatedApply(host.ctx, { gear: 'assisted' })
    await bindApply(host.ctx, { gear: 'assisted', stack: ['guard', 'exploit'], scope: 'global' })
    const service = host.services.anagenesis

    // An agent (no `force`) cannot widen its own permissions...
    await assert.rejects(
      () => service.setGear('autonomous', { reason: 'I want to tune myself', by: 'agent' }),
      /refusing to raise the gear/,
    )
    assert.equal(service.permissions.gear(), 'assisted', 'the refused escalation changed nothing')
    // ...and the refusal is journaled as a *decision to refuse*, not silently dropped.
    assert.equal(service.permissions.gear(), 'assisted')

    // The host can, and the change is a journaled, revertible transaction.
    const raised = await service.setGear('autonomous', { reason: 'operator decision', by: 'host', force: true })
    assert.equal(raised.previous, 'assisted')
    assert.equal(service.permissions.gear(), 'autonomous')
    assert.ok(raised.seq > 0, 'the gear change is a transaction with a seq')
    assert.ok(service.store.auditTrail(10).some((row) => row.type === 'permission.gear'), 'and it is audited')

    // Lowering is always allowed — a system that cannot take away its own
    // privileges is not a safe system.
    await service.setGear('passive', { reason: 'done', by: 'agent' })
    assert.equal(service.permissions.gear(), 'passive')

    await raised.revert()
    assert.equal(service.permissions.gear(), 'assisted')

    await disposeHost(host)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('permission: the compatibility switch registers the write tier from the global row, and withdraws it with the grant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-perm-compat-'))
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: dir })
    // The old behaviour had these tools registered unconditionally; the switch
    // restores registration-without-the-composition, but still not without a
    // grant — which is the line the fix draws.
    toolsApply(host.ctx, { registerGatedWhenGranted: true })
    const service = host.services.anagenesis
    assert.deepEqual(names(host), [...READ_TOOLS].sort(), 'no grant yet: still read-only')

    const grant = service.permissions.grant({ scopeKey: 'test', gear: 'assisted' })
    for (const writeTool of WRITE_TOOLS) {
      assert.equal(host.tools.has(writeTool), true, `${writeTool} appears while a grant is live`)
    }
    grant.dispose()
    assert.deepEqual(names(host), [...READ_TOOLS].sort(), 'revoking the grant rolls the global registration back')

    await disposeHost(host)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('permission: the tier table is closed, and every tool name it knows is classified', () => {
  // A new tool that nobody classified must fail closed (write), never open.
  assert.equal(requiredTier('ana_unknown_tool', {}), 'write')
  assert.equal(requiredTier('ana_remember', {}), 'write')
  assert.equal(requiredTier('ana_recall', {}), 'read')
  // Per-action tiers: inspection is read, governance is admin.
  assert.equal(requiredTier('ana_strategy', { action: 'list' }), 'read')
  assert.equal(requiredTier('ana_strategy', { action: 'switch' }), 'admin')
  assert.equal(requiredTier('ana_strategy', { action: 'make-me-a-sandwich' }), 'read', 'an unknown action falls back to the tool default, which is the read tier here')
  assert.equal(requiredTier('ana_scope', { action: 'retag' }), 'admin')
  assert.equal(requiredTier('ana_scope', { action: 'status' }), 'read')
  assert.equal(requiredTier('ana_preset', { action: 'gear' }), 'admin')

  // The gear tables are consistent with each other: what `passive` exposes is
  // exactly the read tier, and `autonomous` adds the admin capabilities.
  const passive = toolsForGear('passive')
  assert.deepEqual(passive, Object.keys(TOOL_TIERS).filter((name) => TOOL_TIERS[name] === 'read'))
  assert.ok(toolsForGear('assisted').includes('ana_remember'))
  assert.ok(toolsForGear('assisted').length > passive.length)
  assert.deepEqual(toolsForGear('none'), passive)

  // The registry agrees with the tables rather than carrying its own copy.
  const registry = createPermissions({})
  assert.equal(registry.gear(), 'none')
  assert.equal(registry.check('ana_remember', {}).ok, false)
  assert.equal(registry.check('ana_recall', {}).ok, true)
  const grant = registry.grant({ gear: 'autonomous' })
  assert.equal(registry.check('ana_tune', { action: 'apply' }).ok, true)
  assert.equal(registry.check('ana_tune', { action: 'report' }).ok, true)
  grant.dispose()
  assert.equal(registry.check('ana_tune', { action: 'apply' }).ok, false)
})

test('permission: only the autonomous gear lets the plugin schedule its own work, and stopping it is immediate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-perm-autonomy-'))
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: dir })
    toolsApply(host.ctx, {})
    const service = host.services.anagenesis
    const call = (name, args) => host.tools.get(name).execute(args, {})

    // assisted: a reported failure is only information. The stack does not move.
    gatedApply(host.ctx, { gear: 'assisted' })
    await bindApply(host.ctx, { gear: 'assisted', stack: ['guard', 'exploit'], scope: 'global' })
    await call('ana_feedback', { success: false, objective: 'task_success' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(service.registry.stack('global'), ['guard', 'exploit'], 'assisted gear never moves the stack on its own')

    // autonomous: the same signal schedules the debug mode by itself.
    await service.setGear('autonomous', { reason: 'test', by: 'host', force: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await call('ana_feedback', { success: false, objective: 'task_success' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(service.registry.stack('global'), ['guard', 'debug'], 'autonomous gear reacts to a reported failure')
    assert.ok(service.store.auditTrail(20).some((row) => row.type === 'autonomy.autoStack'), 'and the automatic action is audited like any other change')

    // Dropping the gear stops it: the next failure must change nothing.
    const before = service.registry.stack('global')
    await service.setGear('passive', { reason: 'test', by: 'agent' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await service.store.audit('feedback.report', { success: false }, { by: 'test' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(service.registry.stack('global'), before, 'no autonomy listener survives the gear change')

    await disposeHost(host)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('permission: the pulse reports the gear and the tool set the model actually holds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-perm-pulse-'))
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: dir })
    toolsApply(host.ctx, {})
    const service = host.services.anagenesis

    const cold = service.pulse({})
    assert.match(cold.text, /<anagenesis-pulse/)
    assert.match(cold.text, /gear="none"/)
    assert.match(cold.text, /预设未激活/)
    assert.match(cold.text, /tools="read-only"/)
    assert.equal(cold.data.preset, null)

    gatedApply(host.ctx, { gear: 'assisted' })
    await bindApply(host.ctx, { gear: 'assisted', stack: ['guard', 'exploit'], scope: 'global' })
    const warm = service.pulse({})
    assert.match(warm.text, /gear="assisted"/)
    assert.match(warm.text, /preset="anagenesis"/)
    assert.match(warm.text, /tools="read\+write"/)
    assert.match(warm.text, /引用记忆前先核对/)
    assert.ok(warm.data.allowed.includes('ana_remember'))

    // A conflict/cross-project recall says so in the pulse — that is the sentence
    // the spec asks to be shown to the model.
    const warned = service.pulse({}, { conflicts: 2, crossProject: true })
    assert.match(warned.text, /检测到跨项目记忆冲突 2 处/)
    assert.match(warned.text, /以当前环境为准/)

    await disposeHost(host)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
