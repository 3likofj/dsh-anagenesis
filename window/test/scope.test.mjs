/**
 * 窗口渲染层的作用域与权限档位。
 *
 * 这一层是**第二个落点**：模型（`src/viz/model.js`）保持语言中立、默认英文，窗口
 * 按英文标签查中文词表（`DASH_LABEL_ZH` / `SECTION_ZH`）。所以这里断言两件事：
 *
 *   1. **词表是完整的** —— 模型每新增一个英文标签，这里必须有一条中文；漏掉一个，
 *      界面上就会出现一个英文单词（这是第一版截图里 `40m前` 的同一类错误）。
 *   2. **渲染是真的** —— 用真实模型（不是手搓的假模型）跑一遍 `renderDashboardHtml`，
 *      断言中文、命名空间标识符、档位与预设那一行都在，且没有英文漏出来。
 *
 * 渲染层是无 import/export 的纯函数部件（浏览器侧靠拼接），所以用
 * `tools/render-lib.mjs` 装进来 —— 与窗口、与离线预览用的是同一份源码。
 * @module dsh-anagenesis-window/test/scope
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { loadRenderLayer } from '../tools/render-lib.mjs'
import { buildDashboardModel } from '../../src/viz/model.js'
import { terminalText } from '../../src/viz/lang.js'

const R = loadRenderLayer()
const EN = terminalText('en')

const NOW = 1_700_000_000_000
const MINE = 'p1_aaaaaaaaaaaa'
const OTHER = 'p1_bbbbbbbbbbbb'
const SESSION = 'sess-one'

/** @param {string} id @param {'global'|'project'|'session'} tier */
function record(id, tier) {
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
      projectId: tier === 'global' ? null : (id === 'b' ? OTHER : MINE),
      session: tier === 'session' ? SESSION : null,
      workspace: null,
      preset: null,
      profile: null,
      global: tier === 'global',
      origin: id === 'd' ? 'migrated-global' : 'default',
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

const STATE = {
  schemaVersion: 7,
  version: 12,
  createdAt: NOW,
  updatedAt: NOW,
  memories: { a: record('a', 'project'), b: record('b', 'project'), c: record('c', 'global'), d: record('d', 'global'), e: record('e', 'session') },
  projects: {
    [MINE]: { id: MINE, kind: 'repo', root: '/work/a', remote: 'github.com/x/a', label: 'x/a', firstSeenAt: NOW, lastSeenAt: NOW },
    [OTHER]: { id: OTHER, kind: 'path', root: '/work/b', remote: '', label: 'work/b', firstSeenAt: NOW, lastSeenAt: NOW },
  },
  stacks: { global: ['guard', 'exploit'] },
  params: { global: {} },
  strategies: {},
  audit: [],
  stats: {},
  embed: { id: 'hash', dim: 192 },
}

const SCOPE_REPORT = {
  current: { namespace: `project:${MINE}`, tier: 'project', projectId: MINE, projectLabel: 'x/a', basis: 'remote', root: '/work/a', remote: 'github.com/x/a', workspace: '/work/a', session: SESSION },
  defaultScopeTier: 'project',
  knownProjects: [],
  namespaces: {
    [`project:${MINE}`]: { count: 1, tier: 'project', projectId: MINE, label: 'x/a', current: true },
    [`project:${OTHER}`]: { count: 1, tier: 'project', projectId: OTHER, label: 'work/b', current: false },
    global: { count: 2, tier: 'global', projectId: null, label: 'global', current: false },
  },
  totals: { global: 2, project: 2, session: 1 },
  journalNamespaces: {},
}

const PERMISSIONS = {
  preset: 'anagenesis',
  presetActive: true,
  gear: 'exploit',
  gearLabel: 'exploit',
  grants: [],
  tools: [],
  writeToolsAvailable: true,
  adminAvailable: false,
  readOnlyTools: [],
  scope: {},
}

const liveModel = () => buildDashboardModel(
  { state: STATE, origin: 'live', scope: SCOPE_REPORT, permissions: PERMISSIONS },
  { now: NOW, redaction: 'secrets', scopeContext: { projectId: MINE, sessionId: SESSION, allProjects: false }, limit: { salience: 5 } },
)

const mirrorModel = () => buildDashboardModel(
  { state: STATE, origin: 'mirror', permissions: { gear: 'none', presetActive: false, mirror: true } },
  { now: NOW, redaction: 'secrets' },
)

/**
 * Every English fragment the scope section can emit. A window that prints any of
 * these has an untranslated string in it — which is exactly the failure the
 * model/window seam exists to prevent (`40m前` was the first version of it).
 */
const SCOPE_ENGLISH = Object.freeze([
  'current project',
  'default write tier',
  'legacy untagged',
  'record(s)',
  'write tools available',
  'read-only (no write tools)',
  'no preset active',
  'preset anagenesis active',
  'no caller to derive',
  'read-only mirror: no live service',
  'every record carries a scope',
  'written before scope isolation',
  'basis unknown',
])

test('window/scope: every English label the model can emit has a Chinese entry', () => {
  for (const [name, label] of Object.entries(EN.label)) {
    const key = String(label)
    assert.equal(
      Object.prototype.hasOwnProperty.call(R.DASH_LABEL_ZH, key), true,
      `the model's "${name}" label ("${key}") has no entry in the window's DASH_LABEL_ZH — it would render in English`,
    )
  }
  assert.equal(R.SECTION_ZH.scope, '作用域', 'the new section has a Chinese title')
  for (const id of ['overview', 'scope', 'lifecycle', 'kinds', 'strategy', 'tuning', 'journal', 'salience', 'viz']) {
    assert.equal(typeof R.SECTION_ZH[id], 'string', `SECTION_ZH.${id} is missing`)
  }
})

test('window/scope: the scope section renders the project, the namespaces and the gear in Chinese', () => {
  const html = R.renderDashboardHtml(liveModel(), {})

  assert.ok(html.includes('作用域'), 'the section title is Chinese')
  assert.ok(html.includes('当前项目'), 'the current project row is Chinese')
  assert.ok(html.includes('默认写入档位') && html.includes('权限档位') && html.includes('未标注的旧记忆'))
  assert.ok(html.includes(`project:${MINE.slice(0, 12)}`), 'the namespace id is shown verbatim — it is a machine identifier')
  assert.ok(html.includes(`project:${OTHER.slice(0, 12)}`), 'the other project is listed separately')
  assert.ok(html.includes('global'), 'and global is listed too')
  assert.ok(html.includes('（仓库）'), 'the fingerprint basis is translated')
  assert.ok(html.includes('x/a'), 'the project label survives')
  assert.ok(html.includes('条'), 'counts are in Chinese')
  assert.ok(html.includes('可写工具可用'), 'the gear row reports that write tools are registered')
  assert.ok(html.includes('预设 anagenesis 已激活'), 'and the preset line says which preset')

  // The English of the model must not reach the window.
  for (const leak of SCOPE_ENGLISH) {
    assert.equal(html.includes(leak), false, `English leaked into the window HTML: ${leak}`)
  }
})

test('window/scope: a mirror renders the gear as unknowable, and never crashes', () => {
  const model = mirrorModel()
  assert.equal(model.scope.current.known, false)
  const html = R.renderDashboardHtml(model, {})
  assert.ok(html.includes('未知'), 'an unknown current project says so')
  assert.ok(html.includes('只读镜像'), 'the gear row explains that a file cannot report a live gear')
  assert.ok(html.includes('作用域'))

  // The mirror path is where English leaks: every string the scope section can
  // produce for a file-only source has to have a Chinese form.
  for (const leak of SCOPE_ENGLISH) {
    assert.equal(html.includes(leak), false, `English leaked into the mirror HTML: ${leak}`)
  }

  // A model without any scope section (a hand-written one, an older plugin) must
  // still render: the window is not allowed to depend on the new section.
  const bare = {
    kind: 'dashboard', title: 'anagenesis dashboard', generatedAt: NOW, origin: 'live',
    store: { version: 3, schemaVersion: 7, memories: 1, live: 1, safeMode: false, stacks: [] },
    sections: [{ id: 'overview', title: 'overview', rows: [{ label: 'store', value: 'v3 · schema v7' }] }],
    warnings: [], limits: {}, redaction: { level: 'secrets', note: '' }, render: { lang: 'en' },
  }
  const bareHtml = R.renderDashboardHtml(bare, {})
  assert.ok(bareHtml.includes('总览'))
  assert.ok(bareHtml.includes('v3 · 结构 v7'))
})

test('window/scope: a salience row that carries its scope still parses its kind and state', () => {
  // `src/viz/model.js` appends `· <scope>` to the value when a row has no body
  // preview. The window parses that value positionally for the chips, so the
  // suffix must not break the read — and the scope itself gets its own chip.
  const model = liveModel()
  const salience = model.sections.find((item) => item.id === 'salience')
  assert.ok(salience.rows.some((item) => item.value.includes(' · ')), 'the model appends the scope')
  const html = R.renderDashboardHtml(model, {})
  assert.ok(html.includes('事实'), 'the kind chip still resolves')
  assert.ok(html.includes('活跃'), 'the state chip still resolves')
  assert.ok(html.includes(`project:${MINE.slice(0, 12)}`) || html.includes('global'), 'the scope is visible in the row too')
})
