/**
 * Scope-isolation suite — the acceptance evidence for 改造任务一.
 *
 * 这一套测试不测"函数返回了什么"，它测**两个项目之间会不会串扰**：
 * 在两个各自是 git 仓库的临时目录里各写一条记忆，然后以对方的身份召回 ——
 * 看得见就当失败。全局记忆与会话记忆各自有明确的可见范围，也逐一断言。
 *
 * 测试用的是**真行**：`src/index.js` + `src/tools/index.js` + `src/tools/gated.js`
 * 在一个最小宿主桩上装配起来，工具是 `defineTool` 出来的真定义，写入与召回走的是
 * 生产路径。唯一被替换的是宿主（`ctx`）与 cwd（用两个临时仓库当"两个项目"）。
 * @module dsh-anagenesis/test/scope.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply as coreApply } from '../src/index.js'
import { apply as toolsApply } from '../src/tools/index.js'
import { apply as gatedApply } from '../src/tools/gated.js'
import { apply as guardApply } from '../src/guard/index.js'
import { apply as bindApply } from '../src/preset/bind.js'
import { fingerprintProject, canonicalRemote, namespaceOf } from '../src/scope/project.js'
import { migrateState } from '../src/store/schema.js'
import { losslessProblem } from './lossless.mjs'

const quiet = { info() {}, warn() {}, debug() {} }

/**
 * A host stub with exactly the surface the rows use. Kept local to this suite so
 * the isolation tests can be read (and run) on their own.
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

/** @param {{ disposers: (() => Promise<void>)[] }} host */
async function disposeHost(host) {
  for (const dispose of [...host.disposers].reverse()) await dispose()
}

/**
 * A temporary directory that *is* a git repository with the given remote, so the
 * project fingerprint is derived from the remote (the stable, portable identity)
 * rather than from a machine-specific path.
 * @param {string} remote
 * @returns {Promise<string>}
 */
async function makeRepo(remote) {
  const dir = await mkdtemp(join(tmpdir(), 'ana-scope-'))
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${remote}\n`, 'utf8')
  return dir
}

/**
 * The exec shape the real host hands a tool: `exec.agent.session.header.cwd`.
 * @param {string} cwd
 * @param {string} [sessionId]
 */
const execFor = (cwd, sessionId = 'session-1') => ({ agent: { id: `agent-${sessionId}`, session: { header: { cwd, id: sessionId } } } })

test('scope: a memory written in one project is invisible from another, while a global one is shared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ana-scope-store-'))
  const alpha = await makeRepo('git@github.com:acme/alpha.git')
  const beta = await makeRepo('git@github.com:acme/beta.git')
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: root })
    toolsApply(host.ctx, {})
    guardApply(host.ctx, {})
    gatedApply(host.ctx, { gear: 'assisted' })
    await bindApply(host.ctx, { stack: ['guard', 'exploit'], gear: 'assisted', scope: 'global' })

    const call = async (name, args, exec) => {
      const value = await host.tools.get(name).execute(args, exec)
      assert.equal(losslessProblem(value, `${name} output`), null)
      return value
    }

    const alphaExec = execFor(alpha, 's-alpha')
    const betaExec = execFor(beta, 's-beta')

    // 1. Two projects, one fact each, plus one deliberately global fact.
    const alphaFact = await call('ana_remember', {
      kind: 'constraint',
      subject: 'alpha pins node 20',
      body: 'this repository builds on node 20 only; node 22 breaks the test runner',
      confidence: 0.9,
    }, alphaExec)
    const betaFact = await call('ana_remember', {
      kind: 'constraint',
      subject: 'beta needs the legacy openssl flag',
      body: 'the beta build only works with --openssl-legacy-provider',
      confidence: 0.9,
    }, betaExec)
    const globalFact = await call('ana_remember', {
      kind: 'preference',
      subject: 'the team writes commit messages in the imperative mood',
      body: 'this convention holds for every repository in the organisation',
      confidence: 0.9,
      scope: { tier: 'global' },
    }, alphaExec)

    // The label tells the truth about where each one landed.
    assert.equal(alphaFact.scope, `project:${fingerprintProject({ cwd: alpha }).id.slice(0, 12)}`)
    assert.equal(betaFact.scope, `project:${fingerprintProject({ cwd: beta }).id.slice(0, 12)}`)
    assert.equal(globalFact.scope, 'global')

    // 2. Recall from alpha: its own fact and the global one, never beta's.
    const fromAlpha = await call('ana_recall', { intent: 'verify', query: 'build flags and node version' }, alphaExec)
    assert.ok(fromAlpha.selected.includes(alphaFact.id), 'alpha must see its own memory')
    assert.ok(fromAlpha.selected.includes(globalFact.id), 'alpha must see the global memory')
    assert.equal(fromAlpha.selected.includes(betaFact.id), false, 'alpha must NOT see beta\'s memory')

    // 3. And the mirror image from beta.
    const fromBeta = await call('ana_recall', { intent: 'verify', query: 'build flags and node version' }, betaExec)
    assert.ok(fromBeta.selected.includes(betaFact.id), 'beta must see its own memory')
    assert.ok(fromBeta.selected.includes(globalFact.id), 'beta must see the global memory')
    assert.equal(fromBeta.selected.includes(alphaFact.id), false, 'beta must NOT see alpha\'s memory')

    // 4. The rejection counter says *why* it was dropped, and the pulse says
    //    which project the search ran in — a silent empty answer would be the
    //    wrong kind of "isolated".
    assert.ok(fromAlpha.rejected.scope >= 1, 'the other project\'s record is counted as rejected-by-scope')
    assert.match(fromAlpha.text, /<anagenesis-pulse/)
    assert.match(fromAlpha.text, /scope="project"/)

    // 5. A by-id read is a query path too: `ana_audit view=memory` must not be a
    //    side door into the other project.
    await assert.rejects(
      () => call('ana_audit', { view: 'memory', id: betaFact.id }, alphaExec),
      /belongs to project:|crossProject/,
    )
    const crossed = await call('ana_audit', { view: 'memory', id: betaFact.id, crossProject: true }, alphaExec)
    assert.equal(crossed.memory.id, betaFact.id, 'with explicit authorization the read goes through')

    // 6. `ana_list` obeys the same filter.
    const listed = await call('ana_list', {}, alphaExec)
    const listedIds = listed.rows.map((row) => row.id)
    assert.ok(listedIds.includes(alphaFact.id))
    assert.ok(listedIds.includes(globalFact.id))
    assert.equal(listedIds.includes(betaFact.id), false)

    await disposeHost(host)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(alpha, { recursive: true, force: true })
    await rm(beta, { recursive: true, force: true })
  }
})

test('scope: cross-project retrieval needs an explicit authorization, is down-weighted, and is labelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ana-scope-cross-'))
  const alpha = await makeRepo('git@github.com:acme/alpha.git')
  const beta = await makeRepo('git@github.com:acme/beta.git')
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: root })
    toolsApply(host.ctx, {})
    gatedApply(host.ctx, { gear: 'assisted' })
    await bindApply(host.ctx, { stack: ['guard', 'exploit'], gear: 'assisted', scope: 'global' })
    const call = async (name, args, exec) => host.tools.get(name).execute(args, exec)
    const alphaExec = execFor(alpha, 's-alpha')
    const betaExec = execFor(beta, 's-beta')

    // The same topic, one project apart.
    const alphaRule = await call('ana_remember', {
      kind: 'constraint',
      subject: 'this repository builds with the incremental compiler enabled',
      body: 'the incremental compiler is the supported path here',
      confidence: 0.9,
    }, alphaExec)
    const betaRule = await call('ana_remember', {
      kind: 'constraint',
      subject: 'this repository builds with the incremental compiler enabled',
      body: 'the incremental compiler is the supported path here as well',
      confidence: 0.9,
    }, betaExec)

    // Without authorization: only beta's own.
    const plain = await call('ana_recall', { intent: 'verify', query: 'incremental compiler build' }, betaExec)
    assert.ok(plain.selected.includes(betaRule.id))
    assert.equal(plain.selected.includes(alphaRule.id), false)
    assert.equal(plain.crossProject, 0)

    // With authorization: alpha's record is admitted, but down-weighted and
    // explicitly announced.
    const widened = await call('ana_recall', {
      intent: 'verify',
      query: 'incremental compiler build',
      crossProject: true,
      authorizeReason: 'no local precedent, checking whether this was solved elsewhere',
    }, betaExec)
    assert.ok(widened.selected.includes(alphaRule.id), 'the authorized cross-project record is admitted')
    assert.equal(widened.crossProject, 1)
    assert.match(widened.text, /其他项目经验，请勿盲从/)
    assert.ok(widened.scopes[alphaRule.id].startsWith('project:'), 'every selected row carries its scope label')

    // Down-weighted: the foreign record scores below the local one even though
    // their lexical/semantic merit is nearly identical.
    const recalled = await host.services.anagenesis.recall({ intent: 'verify', query: 'incremental compiler build', crossProject: true }, {
      scope: 'global',
      exec: betaExec,
      crossProject: true,
      reason: 'test',
    })
    const foreign = recalled.selected.find((row) => row.id === alphaRule.id)
    const local = recalled.selected.find((row) => row.id === betaRule.id)
    assert.ok(foreign.score < local.score, `cross-project must lose to the local record: ${foreign.score} vs ${local.score}`)

    // The authorization is recorded where it can be reviewed — a cross-project
    // recall is a decision, not a default.
    const store = host.services.anagenesis.store
    const trail = store.auditTrail(20).filter((row) => row.type === 'recall')
    assert.ok(trail.some((row) => row.detail?.authorization !== null && row.detail?.authorization !== undefined), 'the audit row names the authorization')

    await disposeHost(host)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(alpha, { recursive: true, force: true })
    await rm(beta, { recursive: true, force: true })
  }
})

test('scope: a cross-project memory that contradicts the local one is detected, downgraded, and never rewritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ana-scope-conflict-'))
  const alpha = await makeRepo('git@github.com:acme/alpha.git')
  const beta = await makeRepo('git@github.com:acme/beta.git')
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: root })
    toolsApply(host.ctx, {})
    gatedApply(host.ctx, { gear: 'assisted' })
    await bindApply(host.ctx, { stack: ['guard', 'exploit'], gear: 'assisted', scope: 'global' })
    const call = async (name, args, exec) => host.tools.get(name).execute(args, exec)
    const alphaExec = execFor(alpha, 's-alpha')
    const betaExec = execFor(beta, 's-beta')

    // Alpha learned that pnpm works. Beta learned the opposite. Same topic,
    // opposite polarity — the exact shape that used to cause "张冠李戴".
    const alphaPnpm = await call('ana_remember', {
      kind: 'procedure',
      subject: 'the build must run with pnpm in this repository',
      body: 'pnpm install then pnpm build is the supported path here',
      confidence: 0.9,
    }, alphaExec)
    const betaPnpm = await call('ana_remember', {
      kind: 'constraint',
      subject: 'the build must not run with pnpm in this repository',
      body: 'pnpm is broken here, use npm install instead',
      confidence: 0.9,
    }, betaExec)

    const recalled = await call('ana_recall', {
      intent: 'verify',
      query: 'which package manager does the build use',
      crossProject: true,
      authorizeReason: 'checking a conflicting precedent',
    }, betaExec)

    assert.equal(recalled.conflicts.length, 1, 'the contradiction is detected')
    assert.equal(recalled.conflicts[0].otherId, alphaPnpm.id)
    assert.equal(recalled.conflicts[0].currentId, betaPnpm.id)
    assert.match(recalled.text, /检测到跨项目记忆冲突/)
    assert.match(recalled.text, /以当前环境为准/)

    const store = host.services.anagenesis.store
    const before = store.state.memories[alphaPnpm.id]
    // The downgrade lands on the *projection*, never on the stored record: a read
    // must not rewrite the memory it read (that would be the plugin silently
    // editing another project's knowledge).
    assert.equal(before.confidence, 0.9, 'the stored confidence is untouched by a conflicting read')
    assert.equal(before.scope.tier, 'project')
    const reflected = await call('ana_audit', { view: 'memory', id: alphaPnpm.id, crossProject: true }, betaExec)
    assert.equal(reflected.memory.confidence, 0.9, 'and it stays untouched afterwards')

    await disposeHost(host)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(alpha, { recursive: true, force: true })
    await rm(beta, { recursive: true, force: true })
  }
})

test('scope: session memories stay inside their session and expire on their own TTL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ana-scope-session-'))
  const alpha = await makeRepo('git@github.com:acme/alpha.git')
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: root, sessionTtlMs: 60_000 })
    toolsApply(host.ctx, {})
    // `ana_scope action="drop-session"` is an admin-tier action, so this test
    // mounts the preset at the gear that legitimately grants it — the permission
    // coverage itself is `test/permission.test.js`'s job.
    guardApply(host.ctx, {})
    gatedApply(host.ctx, { gear: 'autonomous' })
    await bindApply(host.ctx, { stack: ['guard', 'exploit'], gear: 'autonomous', scope: 'global' })
    const call = async (name, args, exec) => host.tools.get(name).execute(args, exec)

    const first = execFor(alpha, 'session-one')
    const second = execFor(alpha, 'session-two')

    const scratch = await call('ana_remember', {
      kind: 'episode',
      subject: 'the migration is half-finished in this working tree',
      body: 'temporary state: three files still need renaming',
      confidence: 0.9,
      scope: { tier: 'session' },
    }, first)
    assert.equal(scratch.scope, 'session:session-one', 'an explicit session scope binds to the calling session')

    const store = host.services.anagenesis.store
    const record = store.state.memories[scratch.id]
    assert.equal(record.scope.tier, 'session')
    assert.ok(record.expiresAt !== null, 'session memories carry a TTL: a temporary task must not become a permanent belief')

    const sameSession = await call('ana_recall', { intent: 'verify', query: 'migration half-finished' }, first)
    assert.ok(sameSession.selected.includes(scratch.id), 'the session that wrote it can still see it')

    const otherSession = await call('ana_recall', { intent: 'verify', query: 'migration half-finished' }, second)
    assert.equal(otherSession.selected.includes(scratch.id), false, 'another session must not inherit it — not even from the same project')

    // Explicit session teardown is an ordinary, revertible expiry.
    const dropped = await call('ana_scope', { action: 'drop-session', sessionId: 'session-one', reason: 'task finished' }, first)
    assert.deepEqual(dropped.ids, [scratch.id])
    assert.equal(store.state.memories[scratch.id].state, 'expired')
    const reverted = await store.revert(dropped.seq, 'test: session teardown is revertible')
    assert.equal(store.state.memories[scratch.id].state, 'active', 'the teardown has an exact inverse')

    await disposeHost(host)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(alpha, { recursive: true, force: true })
  }
})

test('scope: storage is physically partitioned per namespace, and the global legacy layout is preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ana-scope-files-'))
  const alpha = await makeRepo('git@github.com:acme/alpha.git')
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: root })
    toolsApply(host.ctx, {})
    gatedApply(host.ctx, { gear: 'assisted' })
    await bindApply(host.ctx, { stack: ['guard', 'exploit'], gear: 'assisted', scope: 'global' })
    const call = async (name, args, exec) => host.tools.get(name).execute(args, exec)
    const alphaExec = execFor(alpha, 's-alpha')

    await call('ana_remember', { kind: 'fact', subject: 'project local fact', body: 'lives in the project segment', confidence: 0.9 }, alphaExec)
    await call('ana_remember', { kind: 'fact', subject: 'shared fact', body: 'lives in the global segment', confidence: 0.9, scope: { tier: 'global' } }, alphaExec)

    const files = await readdir(join(root, 'journal'))
    const projectFiles = files.filter((name) => /^journal-project-.*\.jsonl$/.test(name))
    assert.equal(projectFiles.length, 1, `the project's events own their own segment file: ${files.join(', ')}`)
    assert.ok(files.includes('journal-000001.jsonl'), 'global keeps the original, unprefixed layout — a pre-isolation store still loads unchanged')

    // The event itself records which namespace it belongs to, and the two
    // namespaces are genuinely different files.
    const events = host.services.anagenesis.store.recentEvents({ limit: 50 })
    const projectEvent = events.find((event) => event.type === 'memory.remember' && String(event.ns).startsWith('project:'))
    const globalEvent = events.find((event) => event.type === 'memory.remember' && event.ns === 'global')
    assert.ok(projectEvent !== undefined, 'the project write is filed under its project namespace')
    assert.ok(globalEvent !== undefined, 'the global write is filed under the global namespace')

    // A mixed transaction is labelled as mixed rather than silently attributed
    // to whichever record came first.
    const store = host.services.anagenesis.store
    const localId = Object.values(store.state.memories).find((record) => record.scope.tier === 'project').id
    const globalId = Object.values(store.state.memories).find((record) => record.scope.tier === 'global').id
    await store.transact({ memorySet: { [localId]: { ...store.state.memories[localId], updatedAt: Date.now() + 1 }, [globalId]: { ...store.state.memories[globalId], updatedAt: Date.now() + 1 } } }, { type: 'test.mixed', scope: 'global' })
    assert.equal(store.recentEvents({ limit: 1 })[0].ns, 'mixed', 'a genuinely multi-namespace transaction says so')

    // The journal counters expose the physical split for the dashboard.
    const layout = store.journalStats()
    assert.ok(layout.byNamespace !== undefined, 'per-namespace layout counters are reported')
    assert.equal(layout.byNamespace.global !== undefined, true, 'the global namespace owns its segment')

    await disposeHost(host)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(alpha, { recursive: true, force: true })
  }
})

test('scope: the project fingerprint is a stable pure function, and a legacy workspace record migrates onto it', async () => {
  const alpha = await makeRepo('git@github.com:acme/alpha.git')
  const beta = await makeRepo('git@github.com:acme/beta.git')
  try {
    // Stability: two independent computations agree, and nothing ambient (time,
    // session, environment) takes part.
    const first = fingerprintProject({ cwd: alpha })
    const second = fingerprintProject({ cwd: alpha })
    assert.equal(first.id, second.id)
    assert.equal(first.basis, 'remote', 'with a remote, identity follows the repository, not the checkout path')
    assert.notEqual(fingerprintProject({ cwd: beta }).id, first.id, 'two repositories are two projects')

    // A second checkout of the same remote is the *same* project — experience
    // should travel with the code, not with the directory.
    const clone = await makeRepo('https://github.com/acme/alpha.git')
    assert.equal(fingerprintProject({ cwd: clone }).id, first.id, 'https and scp forms of one remote converge')
    await rm(clone, { recursive: true, force: true })

    // A path-only project is still deterministic, and case/punctuation noise in
    // the spelling does not invent a second identity (Windows semantics).
    const plain = await mkdtemp(join(tmpdir(), 'ana-plain-'))
    const pathA = fingerprintProject({ cwd: plain })
    const pathB = fingerprintProject({ cwd: plain.toUpperCase() })
    assert.equal(pathA.basis, 'path')
    if (process.platform === 'win32') assert.equal(pathA.id, pathB.id, 'a case-insensitive filesystem must not yield two projects')

    // Migration: a v6 record that carried a workspace path is filed under that
    // project (not "global"), and one that carried nothing is marked as legacy
    // global so recall can down-weight it.
    const migrated = migrateState({
      schemaVersion: 6,
      memories: {
        withPath: { id: 'withPath', kind: 'fact', state: 'active', confidence: 0.8, createdAt: 1, updatedAt: 1, salience: 0.5, access: { count: 0, hits: 0, misses: 0, lastAt: null }, salienceByScope: {}, embedding: [], scope: { global: true, session: null, workspace: plain, preset: null } },
        bare: { id: 'bare', kind: 'fact', state: 'active', confidence: 0.8, createdAt: 1, updatedAt: 1, salience: 0.5, access: { count: 0, hits: 0, misses: 0, lastAt: null }, salienceByScope: {}, embedding: [], scope: { global: true, session: null, workspace: null, preset: null } },
        sessionish: { id: 'sessionish', kind: 'fact', state: 'active', confidence: 0.8, createdAt: 1, updatedAt: 1, salience: 0.5, access: { count: 0, hits: 0, misses: 0, lastAt: null }, salienceByScope: {}, embedding: [], scope: { global: false, session: 's-legacy', workspace: null, preset: null } },
      },
    }, 1000)

    assert.equal(migrated.schemaVersion, 7)
    assert.equal(migrated.memories.withPath.scope.tier, 'project')
    assert.equal(migrated.memories.withPath.scope.projectId, pathA.id)
    assert.equal(migrated.memories.withPath.scope.origin, 'migrated-workspace')
    assert.equal(migrated.memories.bare.scope.tier, 'global')
    assert.equal(migrated.memories.bare.scope.origin, 'migrated-global')
    assert.equal(migrated.memories.sessionish.scope.tier, 'session')
    assert.equal(migrated.memories.sessionish.scope.session, 's-legacy')
    assert.equal(namespaceOf(migrated.memories.withPath.scope), `project:${pathA.id}`)
    assert.ok(migrated.projects[pathA.id] !== undefined, 'the migrated project is registered so it can be named')

    // The remote canonicalisation table is the reason two spellings converge.
    assert.equal(canonicalRemote('git@github.com:acme/alpha.git'), canonicalRemote('https://github.com/acme/alpha'))
    await rm(plain, { recursive: true, force: true })
  } finally {
    await rm(alpha, { recursive: true, force: true })
    await rm(beta, { recursive: true, force: true })
  }
})

test('scope: re-filing a memory is reversible, and widening it to global needs an authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ana-scope-retag-'))
  const alpha = await makeRepo('git@github.com:acme/alpha.git')
  const host = makeHost()
  try {
    await coreApply(host.ctx, { rootDir: root })
    toolsApply(host.ctx, {})
    guardApply(host.ctx, {})
    gatedApply(host.ctx, { gear: 'autonomous' })
    await bindApply(host.ctx, { stack: ['guard', 'exploit'], gear: 'autonomous', scope: 'global' })
    const call = async (name, args, exec) => host.tools.get(name).execute(args, exec)
    const alphaExec = execFor(alpha, 's-alpha')
    const store = host.services.anagenesis.store

    const fact = await call('ana_remember', { kind: 'fact', subject: 'a local detail', body: 'only true here', confidence: 0.9 }, alphaExec)
    assert.equal(store.state.memories[fact.id].scope.tier, 'project')

    // Widening without authorization is refused — by the operation *and* by the
    // invariant gate behind it.
    await assert.rejects(
      () => call('ana_scope', { action: 'retag', ids: [fact.id], tier: 'global', reason: 'seems universal' }, alphaExec),
      /authorizeGlobal|refused/,
    )
    assert.equal(store.state.memories[fact.id].scope.tier, 'project', 'the refusal left no trace at all')

    // With an explicit authorization it goes through, is audited, and reverses.
    const widened = await call('ana_scope', { action: 'retag', ids: [fact.id], tier: 'global', reason: 'user confirmed this holds for every project', authorizeGlobal: true }, alphaExec)
    assert.equal(store.state.memories[fact.id].scope.tier, 'global')
    assert.deepEqual(widened.changes, [{ id: fact.id, from: 'project', to: 'global' }])
    await store.revert(widened.seq, 'test: the widening is undone')
    assert.equal(store.state.memories[fact.id].scope.tier, 'project', 'revert(seq) restores the previous scope exactly')

    // And the invariant is not bypassable by writing a record directly through
    // the store: an untagged record is refused before it can be journaled.
    await assert.rejects(
      () => store.transact({ memorySet: { rogue: { id: 'rogue', kind: 'fact', state: 'active', scope: { global: true } } } }, { type: 'test.rogue' }),
      /scope\.tagged/,
    )
    assert.equal(store.state.memories.rogue, undefined, 'a refused write leaves no state behind')

    await disposeHost(host)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(alpha, { recursive: true, force: true })
  }
})
