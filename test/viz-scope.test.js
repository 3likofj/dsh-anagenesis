/**
 * Scope isolation and the preset permission layer, as the visualization layer
 * has to show them.
 *
 * The existing `viz.test.js` suite pins that a render is a pure projection and
 * that the default English labels stay word for word. This suite pins the *new*
 * facts: whose memories a model is showing (current project / other projects /
 * global / session), what `allProjects` does to that set and how loudly it says
 * so, and that a source with no live service (the file mirror, the standalone
 * watcher) reports the gear as unknowable instead of pretending it is `none`.
 *
 * Nothing here needs a store on disk: the model is a total function of `state`,
 * so a hand-built state is the honest way to test it — and it keeps the suite
 * fast enough to run on every change.
 * @module dsh-anagenesis/test/viz-scope.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DASHBOARD_SECTIONS, buildDashboardModel, buildDiagramModel, visibleRecords } from '../src/viz/model.js'
import { renderFrame } from '../src/viz/tui.js'
import { renderDiagram } from '../src/viz/diagram.js'
import { terminalText } from '../src/viz/lang.js'
import { losslessIssues } from './lossless.mjs'

const NOW = 1_700_000_000_000
const MINE = 'p1_aaaaaaaaaaaa'
const OTHER = 'p1_bbbbbbbbbbbb'
const SESSION = 'sess-one'

/**
 * @param {string} id
 * @param {'global'|'project'|'session'} tier
 * @param {{ projectId?: string, session?: string, origin?: string }} [extra]
 * @returns {any}
 */
function record(id, tier, extra = {}) {
  const projectId = extra.projectId ?? (tier === 'global' ? null : MINE)
  return {
    id,
    kind: 'fact',
    state: 'active',
    subject: `subject ${id}`,
    body: `body ${id}`,
    gist: `gist ${id}`,
    tags: [],
    links: [],
    confidence: 0.8,
    salience: 0.5,
    salienceByScope: {},
    scope: {
      tier,
      projectId: tier === 'global' ? null : projectId,
      session: tier === 'session' ? (extra.session ?? SESSION) : null,
      workspace: null,
      preset: null,
      profile: null,
      global: tier === 'global',
      origin: extra.origin ?? 'default',
    },
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
 * Four namespaces in one store: this project, another project, global (with one
 * legacy un-tagged record in it) and two sessions — enough for every relation
 * `scopeRelation` can return except `unscoped`-by-missing-tier.
 */
function makeState() {
  return {
    schemaVersion: 7,
    version: 12,
    createdAt: NOW,
    updatedAt: NOW,
    memories: {
      a: record('a', 'project'),
      b: record('b', 'project', { projectId: OTHER }),
      c: record('c', 'global'),
      d: record('d', 'global', { origin: 'migrated-global' }),
      e: record('e', 'session'),
      f: record('f', 'session', { session: 'sess-two' }),
    },
    projects: {
      [MINE]: { id: MINE, kind: 'repo', root: '/work/a', remote: 'github.com/x/a', label: 'x/a', firstSeenAt: NOW, lastSeenAt: NOW },
      [OTHER]: { id: OTHER, kind: 'path', root: '/work/b', remote: '', label: 'work/b', firstSeenAt: NOW, lastSeenAt: NOW },
    },
    stacks: { global: ['guard', 'exploit'] },
    params: { global: {} },
    strategies: {},
    audit: [],
    stats: { commits: 0, recalls: 0, writes: 0, reverts: 0, hookFailures: 0 },
    embed: { id: 'hash', dim: 192 },
  }
}

/** `service.scopeReport()`'s shape, as the tool row passes it in. */
const SCOPE_REPORT = {
  current: {
    namespace: `project:${MINE}`,
    tier: 'project',
    projectId: MINE,
    projectLabel: 'x/a',
    basis: 'remote',
    root: '/work/a',
    remote: 'github.com/x/a',
    workspace: '/work/a',
    session: SESSION,
  },
  defaultScopeTier: 'project',
  sessionTtlMs: 86_400_000,
  crossProjectDefault: false,
  knownProjects: [
    { id: MINE, label: 'x/a', kind: 'repo', root: '/work/a', remote: 'github.com/x/a', firstSeenAt: NOW, lastSeenAt: NOW, current: true, memories: 1 },
    { id: OTHER, label: 'work/b', kind: 'path', root: '/work/b', remote: '', firstSeenAt: NOW, lastSeenAt: NOW, current: false, memories: 1 },
  ],
  namespaces: {
    [`project:${MINE}`]: { count: 1, tier: 'project', projectId: MINE, label: 'x/a', current: true },
    [`project:${OTHER}`]: { count: 1, tier: 'project', projectId: OTHER, label: 'work/b', current: false },
    global: { count: 2, tier: 'global', projectId: null, label: 'global', current: false },
    [`session:${SESSION}`]: { count: 1, tier: 'session', projectId: null, label: `session:${SESSION}`, current: false },
    'session:sess-two': { count: 1, tier: 'session', projectId: null, label: 'session:sess-two', current: false },
  },
  totals: { global: 2, project: 2, session: 2 },
  journalNamespaces: {},
}

/** `service.permissionReport()`'s shape, as the tool row passes it in. */
const PERMISSIONS = {
  preset: 'anagenesis',
  presetActive: true,
  gear: 'exploit',
  gearLabel: 'exploit',
  grants: ['agent:x'],
  tools: ['ana_recall', 'ana_remember'],
  writeToolsAvailable: true,
  adminAvailable: false,
  readOnlyTools: ['ana_recall'],
  scope: { namespace: `project:${MINE}`, tier: 'project', projectId: MINE, projectLabel: 'x/a', session: SESSION },
}

/** The default the tools use: what this agent could actually recall. */
const MINE_CONTEXT = { projectId: MINE, sessionId: SESSION, allProjects: false }

const liveSource = (extra = {}) => ({
  state: makeState(),
  origin: 'live',
  scope: SCOPE_REPORT,
  permissions: PERMISSIONS,
  ...extra,
})

/** @param {any} model @param {string} id */
function section(model, id) {
  return model.sections.find((item) => item.id === id)
}

/** @param {any} model @param {string} label */
function rowWith(model, label) {
  return section(model, 'scope').rows.find((item) => item.label === label)
}

// ── where a record stands, and who can see it ────────────────────────────────

test('viz-scope: the honest default hides another project, and allProjects shows it with a warning', () => {
  const state = makeState()
  const mine = { scopeContext: MINE_CONTEXT }
  const every = { scopeContext: { ...MINE_CONTEXT, allProjects: true } }

  assert.deepEqual(visibleRecords(state, mine).map((item) => item.id), ['a', 'c', 'd', 'e'],
    'the agent sees its project, global and its own session — and nothing else')
  assert.deepEqual(visibleRecords(state, every).map((item) => item.id), ['a', 'b', 'c', 'd', 'e'],
    'allProjects adds the other project; it does not add another session')
  assert.equal(visibleRecords(state, {}).length, 6, 'with no context at all the whole store is still shown')

  const hidden = buildDiagramModel(liveSource({ kind: 'memory-graph' }), { kind: 'memory-graph', scopeContext: MINE_CONTEXT, now: NOW })
  const shown = buildDiagramModel(liveSource({ kind: 'memory-graph' }), { kind: 'memory-graph', scopeContext: every.scopeContext, now: NOW })

  assert.equal(hidden.nodes.some((node) => node.id === 'b'), false)
  const foreign = shown.nodes.find((node) => node.id === 'b')
  assert.ok(foreign !== undefined, 'allProjects puts the other project back in the graph')
  assert.equal(foreign.relation, 'other-project')
  assert.equal(foreign.scope, `project:${OTHER.slice(0, 12)}`)
  assert.equal(foreign.tone, 'warn', 'a foreign node is marked, so a serializer can colour it')
  assert.equal(shown.nodes.find((node) => node.id === 'a').tone, 'accent')
  assert.equal(shown.nodes.find((node) => node.id === 'c').tone, 'accent', 'global is everyone\'s')

  assert.deepEqual(hidden.totals.byScope, { 'current-project': 1, global: 2, 'current-session': 1 })
  assert.deepEqual(shown.totals.byScope, { 'current-project': 1, 'other-project': 1, global: 2, 'current-session': 1 })

  const t = terminalText('en')
  assert.equal(hidden.warnings.includes(t.warning.allProjects), false, 'the default view does not warn about itself')
  assert.equal(shown.warnings.includes(t.warning.allProjects), true, 'widening the view is announced, not silent')
  assert.equal(hidden.scope.otherProjects, 1, 'the hidden project is still counted — otherwise nobody would know to look')
  assert.equal(shown.scope.count, 5)
})

test('viz-scope: the scope section separates the current project, a foreign project and global', () => {
  const model = buildDashboardModel(liveSource(), { scopeContext: MINE_CONTEXT, now: NOW, redaction: 'secrets' })
  assert.ok(DASHBOARD_SECTIONS.includes('scope'), 'the section is part of the default list')
  assert.equal(DASHBOARD_SECTIONS[1], 'scope', 'and it sits right after overview')

  const scope = section(model, 'scope')
  assert.equal(scope.title, 'scope')
  const current = rowWith(model, 'current project')
  assert.equal(current.tone, 'accent')
  assert.match(current.value, /x\/a/)
  assert.match(current.value, /project:p1_aaaaaaaaa\b/)
  assert.match(current.value, /\(repo\)/, 'the fingerprint basis is named, not implied')

  const mine = rowWith(model, `project:${MINE.slice(0, 12)}`)
  const other = rowWith(model, `project:${OTHER.slice(0, 12)}`)
  const global = rowWith(model, 'global')
  assert.equal(mine.tone, 'accent')
  assert.match(mine.value, /x\/a · 1 record\(s\)/)
  assert.equal(other.tone, 'warn')
  assert.match(other.value, /work\/b · 1 record\(s\)/)
  assert.equal(global.tone, 'plain')
  assert.equal(global.value, '2 record(s)')

  assert.equal(rowWith(model, 'default write tier').value, 'project')
  assert.match(rowWith(model, 'legacy untagged').value, /1 record\(s\) written before scope isolation/)

  assert.deepEqual(model.scope, {
    current: { known: true, projectId: MINE, label: 'x/a', namespace: `project:${MINE}`, tier: 'project', basis: 'remote', session: SESSION },
    count: 4,
    otherProjects: 1,
    global: 2,
    legacy: 1,
  })
  assert.deepEqual(losslessIssues(model), [], 'the dashboard model is still lossless JSON')

  // The scope travels with the salience rows too: in the value when there is no
  // body preview to carry it, in the note when there is.
  const noBody = buildDashboardModel(liveSource(), { scopeContext: MINE_CONTEXT, now: NOW, limit: { salience: 10 }, salienceScope: 'global' })
  const ranked = section(noBody, 'salience').rows
  assert.ok(ranked.length > 0)
  assert.match(ranked[0].value, /· (project|global|session):?/, 'the scope is appended to the value')
  assert.equal(ranked[0].note, '')
  const withBody = buildDashboardModel(liveSource(), {
    scopeContext: MINE_CONTEXT, now: NOW, limit: { salience: 10 }, includeBody: true, redaction: 'none',
  })
  const bodyRows = section(withBody, 'salience').rows
  assert.ok(bodyRows.every((item) => item.note.includes(' · ')), 'with a body preview the scope rides in the note')

  // The zh frame localizes the section, its labels and the basis — while the
  // namespace id stays verbatim (machine identifier, matched against ana_scope).
  const zh = buildDashboardModel(liveSource(), { scopeContext: MINE_CONTEXT, now: NOW, lang: 'zh' })
  const frame = renderFrame(zh, { width: 100, color: 'never' })
  assert.ok(frame.includes('├─ 作用域 '), 'the section title is Chinese')
  assert.ok(frame.includes('当前项目'), 'the current-project row is Chinese')
  assert.ok(frame.includes('默认写入档位') && frame.includes('权限档位') && frame.includes('未标注的旧记忆'))
  assert.ok(frame.includes(`project:${MINE.slice(0, 12)}`), 'the namespace id is not translated')
  assert.equal(frame.includes('current project'), false, 'no English label leaks into the zh frame')
})

test('viz-scope: the gear row reports a mirror as unknowable instead of "none"', () => {
  // The file mirror's placeholder: the shape of a real report plus `mirror`.
  const mirror = buildDashboardModel(
    { state: makeState(), origin: 'mirror', permissions: { gear: 'none', presetActive: false, mirror: true } },
    { now: NOW },
  )
  const mirrorGear = rowWith(mirror, 'gear')
  assert.equal(mirrorGear.tone, 'dim')
  assert.match(mirrorGear.value, /none \(read-only mirror/, 'the placeholder gear is shown, labelled as unknowable')
  assert.equal(mirror.scope.current.known, false, 'a file cannot name the caller\'s project')

  // The standalone watcher passes no permissions at all.
  const watcher = buildDashboardModel({ state: makeState(), origin: 'mirror' }, { now: NOW })
  const watcherGear = rowWith(watcher, 'gear')
  assert.equal(watcherGear.tone, 'dim')
  assert.equal(watcherGear.value, 'not available in a read-only mirror')

  // A live report with the write tier absent: `none` is a real answer here.
  const closed = buildDashboardModel(
    liveSource({ permissions: { ...PERMISSIONS, preset: null, presetActive: false, gear: 'none', writeToolsAvailable: false } }),
    { scopeContext: MINE_CONTEXT, now: NOW },
  )
  const closedGear = rowWith(closed, 'gear')
  assert.equal(closedGear.tone, 'warn')
  assert.equal(closedGear.value, 'none · read-only (no write tools)')
  assert.equal(closedGear.note, 'no preset active: write tools are not registered')

  const open = rowWith(buildDashboardModel(liveSource(), { scopeContext: MINE_CONTEXT, now: NOW }), 'gear')
  assert.equal(open.tone, 'ok')
  assert.equal(open.value, 'exploit · write tools available')
  assert.equal(open.note, 'preset anagenesis active')

  // And the whole thing survives the JSON seam with a mirror source.
  assert.deepEqual(losslessIssues(mirror), [])
  assert.deepEqual(losslessIssues(buildDashboardModel({ state: makeState() }, { now: NOW })), [])
})

test('viz-scope: cross-project nodes are marked in the text diagrams, and only then', () => {
  const opts = { kind: 'memory-graph', scopeContext: { ...MINE_CONTEXT, allProjects: true }, now: NOW }
  const model = buildDiagramModel(liveSource({ kind: 'memory-graph' }), opts)
  const mermaid = renderDiagram(model, { format: 'mermaid', embed: false }).source
  assert.match(mermaid, /classDef scope_foreign/)
  assert.match(mermaid, /class ana_b scope_foreign/)
  assert.equal(/class ana_a scope_foreign/.test(mermaid), false, 'the caller\'s own nodes stay unmarked')

  const ascii = renderDiagram(model, { format: 'ascii', embed: false }).source
  assert.ok(ascii.includes(`project:${OTHER.slice(0, 12)} (other-project)`), `ascii names the foreign scope: ${ascii}`)
  assert.ok(ascii.includes(`0.50  project:${MINE.slice(0, 12)}`))
  assert.equal(ascii.includes(`project:${MINE.slice(0, 12)} (`), false, 'the caller\'s own node carries no relation suffix')

  // The default view has no foreign node, so it emits no foreign marker at all —
  // the artifact stays byte-identical for a single-project store.
  const alone = buildDiagramModel(liveSource({ kind: 'memory-graph' }), { kind: 'memory-graph', scopeContext: MINE_CONTEXT, now: NOW })
  const plainMermaid = renderDiagram(alone, { format: 'mermaid', embed: false }).source
  assert.equal(plainMermaid.includes('scope_foreign'), false)
  assert.equal(renderDiagram(alone, { format: 'ascii', embed: false }).source.includes('other-project'), false)
})

// ── language ─────────────────────────────────────────────────────────────────

/** Every dotted path of nested objects, values treated as leaves. */
function shapeOf(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  const out = []
  for (const [key, item] of Object.entries(value)) out.push(...shapeOf(item, prefix === '' ? key : `${prefix}.${key}`))
  return out
}

test('viz-scope: every new English label exists in the Chinese table, key for key', () => {
  const en = terminalText('en')
  const zh = terminalText('zh')
  assert.deepEqual(shapeOf(en).sort(), shapeOf(zh).sort(),
    'the two language tables must stay parallel — a key that exists in one and not the other is a blank label waiting to happen')

  assert.deepEqual(
    {
      section: en.section.scope,
      currentProject: en.label.currentProject,
      defaultTier: en.label.defaultTier,
      gear: en.label.gear,
      legacy: en.label.legacy,
    },
    {
      section: 'scope',
      currentProject: 'current project',
      defaultTier: 'default write tier',
      gear: 'gear',
      legacy: 'legacy untagged',
    },
    'the English strings are the window\'s keys (window/src/render/10-i18n.js) — they must not drift',
  )

  for (const key of ['section', 'label', 'value', 'warning']) {
    for (const [name, value] of Object.entries(en[key])) {
      const counterpart = zh[key][name]
      assert.notEqual(counterpart, undefined, `zh.${key}.${name} is missing`)
      if (typeof value === 'function') {
        const produced = key === 'warning' ? value(1, 2) : value('a', 1, 'repo')
        const localized = key === 'warning' ? counterpart(1, 2) : counterpart('a', 1, 'repo')
        assert.equal(typeof produced, 'string', `en.${key}.${name} must produce a string`)
        assert.equal(typeof localized, 'string', `zh.${key}.${name} must produce a string`)
        assert.notEqual(localized, '', `zh.${key}.${name} must not be empty`)
      } else {
        assert.notEqual(counterpart, '', `zh.${key}.${name} must not be empty`)
      }
    }
  }
  assert.notEqual(zh.section.scope, en.section.scope, 'the section title is actually translated')
})

test('viz-scope: a model is a pure, total projection — partial sources included', () => {
  const empty = buildDashboardModel({ state: {} }, {})
  assert.equal(empty.scope.current.known, false)
  assert.equal(empty.scope.count, 0)
  assert.ok(section(empty, 'scope').rows.length >= 4, 'the section renders its shape even with nothing to show')
  assert.deepEqual(losslessIssues(empty), [])

  const bare = buildDiagramModel({ state: {} }, { kind: 'memory-graph' })
  assert.deepEqual(bare.scope, {
    current: { known: false, projectId: null, label: '', namespace: null, tier: null, basis: null, session: null },
    count: 0, otherProjects: 0, global: 0, legacy: 0,
  })
  assert.deepEqual(losslessIssues(bare), [])

  // A record with no `scope` at all (an older store mid-migration) is `unscoped`,
  // never a throw and never silently "current".
  const partial = { state: { ...makeState(), memories: { z: { id: 'z', kind: 'fact', state: 'active', subject: 'z', salience: 0.4, links: [] } } } }
  const graph = buildDiagramModel({ ...partial, kind: 'memory-graph' }, { kind: 'memory-graph', scopeContext: MINE_CONTEXT, now: NOW })
  assert.equal(graph.nodes[0].relation, 'unscoped')
  assert.equal(graph.nodes[0].tone, 'warn')
  assert.equal(graph.nodes[0].scope, 'unscoped')

  // Projection, not mutation: the state object is not touched, and neither is
  // its version (the store-level assertion lives in viz.test.js).
  const state = makeState()
  const before = JSON.stringify(state)
  const version = state.version
  buildDashboardModel({ state, origin: 'live', scope: SCOPE_REPORT, permissions: PERMISSIONS }, { scopeContext: MINE_CONTEXT, now: NOW })
  buildDiagramModel({ state, kind: 'lifecycle' }, { kind: 'lifecycle', scopeContext: MINE_CONTEXT, now: NOW })
  assert.equal(JSON.stringify(state), before, 'a render must not change the state it projects')
  assert.equal(state.version, version)
})
