/**
 * The two visualization tools, end to end through their row.
 *
 * `test/viz-scope.test.js` pins the *model*, which is a total function of its
 * inputs. But a model can only be as honest as the arguments the tool row hands
 * it, and nothing else covers that seam — so this file mounts the row against a
 * host stub and calls the tools the way the host does.
 *
 * The bug it was written for lives exactly there. `service.scopeFor(exec)`
 * returns two different session values on purpose:
 *   - `scope.session` — the session *recorded in the scope tag*, which is `null`
 *     for a project-tier caller (a project memory belongs to the project); and
 *   - `sessionId` — the session the caller is actually in, which is what the
 *     closed-set filter needs to admit that session's own records.
 * Passing the first one makes a project-tier agent blind to its own session
 * memories: the default view promises "current project + global + current
 * session", and the session half silently disappears.
 * @module dsh-anagenesis/test/viz-tools-scope
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply as vizApply } from '../src/viz/index.js'
import { createScopeResolver, namespaceCounts, parseNamespace, projectLabel } from '../src/scope/index.js'
import { losslessIssues } from './lossless.mjs'

const NOW = 1_700_000_000_000
const SESSION = 'sess-one'
/** The caller's cwd: the real one, so `cwdFromExec` resolves identically on any platform. */
const CWD = process.cwd()
/** A project this store has seen but this caller is not in. */
const OTHER = 'p1_bbbbbbbbbbbb'
const quiet = { info() {}, warn() {}, debug() {}, error() {} }

/**
 * @param {string} id
 * @param {string} subject
 * @param {any} scope
 * @returns {any}
 */
function record(id, subject, scope) {
  return {
    id,
    kind: 'fact',
    state: 'active',
    subject,
    body: `${subject} — body`,
    gist: subject,
    tags: [],
    links: [],
    confidence: 0.8,
    salience: 0.5,
    salienceByScope: {},
    scope,
    provenance: { source: 'test', author: null, taskId: null, evidence: [], derivedFrom: [] },
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: null,
    supersedes: [],
    supersededBy: null,
    parentId: null,
    access: { count: 0, hits: 0, misses: 0, lastAt: null },
    embedding: [],
    schemaVersion: 7,
  }
}

/**
 * Four namespaces: this project, another project, global, and one record in the
 * caller's *own* session (the record the default view must not lose).
 * @param {string} mine
 * @returns {any}
 */
function makeState(mine) {
  return {
    schemaVersion: 7,
    version: 9,
    createdAt: NOW,
    updatedAt: NOW,
    safeMode: false,
    memories: {
      mine: record('mine', 'mine note', { tier: 'project', projectId: mine, session: null, workspace: null, preset: null, profile: null, global: false, origin: 'default' }),
      scratch: record('scratch', 'session note', { tier: 'session', projectId: mine, session: SESSION, workspace: null, preset: null, profile: null, global: false, origin: 'default' }),
      shared: record('shared', 'global note', { tier: 'global', projectId: null, session: null, workspace: null, preset: null, profile: null, global: true, origin: 'default' }),
      other: record('other', 'other project note', { tier: 'project', projectId: OTHER, session: null, workspace: null, preset: null, profile: null, global: false, origin: 'default' }),
    },
    projects: {
      [mine]: { id: mine, kind: 'repo', root: CWD, remote: '', label: 'this/repo', firstSeenAt: NOW, lastSeenAt: NOW },
      [OTHER]: { id: OTHER, kind: 'path', root: '/work/b', remote: '', label: 'work/b', firstSeenAt: NOW, lastSeenAt: NOW },
    },
    stacks: { global: ['guard'] },
    params: { global: {} },
    strategies: {},
    audit: [],
    stats: { commits: 0, recalls: 0, writes: 0, reverts: 0, hookFailures: 0 },
    embed: { id: 'hash', dim: 192 },
  }
}

/**
 * The slice of `service` the viz row actually reads, shaped like `src/index.js`:
 * `scopeFor` is the real resolver, and the two reports are projections of the
 * same store, so the tool row is exercised against the contract it ships with.
 * @param {any} resolver
 * @param {any} state
 * @returns {any}
 */
function makeService(resolver, state) {
  return {
    store: {
      state,
      recentEvents: () => [],
      journalStats: () => ({ live: 0, archives: 0, checkpoints: 0, prunedThroughSeq: 0, byNamespace: {} }),
    },
    engine: { describe: () => ['guard'], health: () => [] },
    tuner: { report: () => ({ metric: 0, samples: 0, applied: 0 }) },
    scopeFor: (exec) => resolver.forCall(exec, {}),
    scopeReport(exec) {
      const context = resolver.forCall(exec, {})
      const counts = namespaceCounts(state)
      /** @type {Record<string, any>} */
      const namespaces = {}
      for (const [namespace, count] of Object.entries(counts.byNamespace)) {
        const parsed = parseNamespace(namespace)
        namespaces[namespace] = {
          count,
          tier: parsed.tier,
          projectId: parsed.tier === 'project' ? parsed.key : null,
          label: parsed.tier === 'project' ? projectLabel(state, parsed.key) : namespace,
          current: namespace === context.namespace,
        }
      }
      return {
        current: {
          namespace: context.namespace,
          tier: context.tier,
          projectId: context.identity.id,
          projectLabel: context.identity.label,
          basis: context.identity.basis,
          root: context.identity.root,
          remote: context.identity.remote,
          workspace: context.identity.root,
          session: context.sessionId,
        },
        defaultScopeTier: 'project',
        sessionTtlMs: 86_400_000,
        crossProjectDefault: false,
        knownProjects: Object.values(state.projects).map((entry) => ({
          id: entry.id, label: entry.label, kind: entry.kind, root: entry.root, remote: entry.remote,
          firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.lastSeenAt,
          current: entry.id === context.identity.id,
          memories: counts.byNamespace[`project:${entry.id}`] ?? 0,
        })),
        namespaces,
        totals: counts.byTier,
        journalNamespaces: {},
      }
    },
    permissionReport(exec) {
      const context = resolver.forCall(exec, {})
      return {
        preset: 'anagenesis',
        presetActive: true,
        gear: 'exploit',
        gearLabel: 'exploit',
        grants: ['preset:anagenesis'],
        tools: ['ana_recall', 'ana_remember'],
        writeToolsAvailable: true,
        adminAvailable: false,
        readOnlyTools: ['ana_recall'],
        scope: {
          namespace: context.namespace,
          tier: context.tier,
          projectId: context.identity.id,
          projectLabel: context.identity.label,
          session: context.sessionId,
        },
      }
    },
  }
}

/** A host stub with exactly the surface `src/viz/index.js` touches. */
function makeHost(service, config = {}) {
  /** @type {Map<string, any>} */
  const tools = new Map()
  const ctx = {
    logger: quiet,
    get: (name) => (name === 'anagenesis' ? service : undefined),
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate registration of "${definition.name}"`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  vizApply(ctx, { color: 'never', width: 88, ...config })
  return { ctx, tools }
}

/** Everything one call needs: the caller's cwd and the session it is in. */
const EXEC = { agent: { id: SESSION, session: { header: { cwd: CWD, id: SESSION } } } }

function fixture(config) {
  const resolver = createScopeResolver({ fallbackCwd: () => CWD })
  const mine = resolver.identityFor(CWD).id
  const state = makeState(mine)
  const host = makeHost(makeService(resolver, state), config)
  /** @param {string} name @param {any} args */
  const call = (name, args) => {
    const tool = host.tools.get(name)
    assert.ok(tool !== undefined, `${name} is registered`)
    return tool.execute(args, EXEC)
  }
  return { mine, state, host, call }
}

test('viz tools: the default view is what the agent could recall — its own session included', async () => {
  const { call } = fixture({ lang: 'en' })
  const diagram = await call('ana_diagram', { kind: 'memory-graph', format: 'ascii', embed: false })
  assert.equal(diagram.ok, true)
  // The three namespaces a caller may read, and the one it may not.
  assert.ok(diagram.text.includes('mine note'), 'the current project is visible')
  assert.ok(diagram.text.includes('global note'), 'global is visible')
  assert.ok(
    diagram.text.includes('session note'),
    `the caller's own session memory must not be filtered out by passing the scope tag's null session: ${diagram.text}`,
  )
  assert.equal(diagram.text.includes('other project note'), false, 'another project stays hidden by default')
  assert.deepEqual(losslessIssues(diagram), [], 'the tool answer is still lossless JSON')
})

test('viz tools: allProjects widens the view to the whole store and says so', async () => {
  const { call } = fixture({ lang: 'en' })
  const wide = await call('ana_diagram', { kind: 'memory-graph', format: 'ascii', embed: false, allProjects: true })
  assert.ok(wide.text.includes('other project note'), 'the other project appears')
  assert.equal(
    wide.warnings.some((warning) => /showing every project/.test(warning)),
    true,
    `widening past what the agent can recall is announced: ${JSON.stringify(wide.warnings)}`,
  )

  const hidden = await call('ana_diagram', { kind: 'memory-graph', format: 'ascii', embed: false })
  assert.equal(hidden.text.includes('other project note'), false)
  assert.equal(
    hidden.warnings.some((warning) => /showing every project/.test(warning)),
    false,
    'the default view does not warn about itself',
  )
})

test('viz tools: the scope section reports the live project, write tier and gear', async () => {
  const { call, mine } = fixture({ lang: 'en' })
  const dashboard = await call('ana_dashboard', { sections: ['scope'], width: 88 })
  assert.equal(dashboard.ok, true)
  assert.deepEqual(dashboard.sections, ['scope'])
  assert.equal(dashboard.origin, 'live')
  assert.ok(dashboard.text.includes('current project'), 'the section renders')
  assert.ok(dashboard.text.includes('this/repo'), 'the live project label reaches the row')
  assert.ok(dashboard.text.includes(`project:${mine.slice(0, 12)}`), 'and the namespace it maps to')
  assert.ok(dashboard.text.includes('repo'), 'the fingerprint basis is named')
  assert.ok(dashboard.text.includes('default write tier'), 'the write tier comes from scopeReport')
  assert.ok(
    dashboard.text.includes('exploit · write tools available'),
    `the gear comes from permissionReport: ${dashboard.text}`,
  )
  assert.ok(dashboard.text.includes('work/b · 1 record(s)'), 'the other project is listed with its label and count')
  assert.deepEqual(losslessIssues(dashboard), [])
})

test('viz tools: both tools declare allProjects, and neither writes the store', async () => {
  const { host, state } = fixture({ lang: 'en' })
  for (const name of ['ana_dashboard', 'ana_diagram']) {
    const tool = host.tools.get(name)
    // The stub compiles the simplified spec to JSON Schema, exactly like the host.
    assert.equal(tool.parameters.properties.allProjects.type, 'boolean', `${name} declares allProjects`)
  }
  const before = JSON.stringify(state)
  const version = state.version
  await host.tools.get('ana_dashboard').execute({}, EXEC)
  await host.tools.get('ana_diagram').execute({ kind: 'lifecycle' }, EXEC)
  assert.equal(JSON.stringify(state), before, 'a render is a projection, not a transaction')
  assert.equal(state.version, version)
  // `auditRenders` is off by default, which is what keeps a render out of the journal.
  assert.equal(host.tools.get('ana_dashboard').description.includes('只读'), true)
})
