#!/usr/bin/env node
/**
 * preview —— 把渲染层真正跑一遍，产出可看的 HTML 与 PNG 截图。
 *
 * 这是本模块唯一的"视觉验收"手段：窗口在 GUI 里，我没有眼睛；但渲染层是纯函数，
 * 同一段 HTML 写进文件、用真 Chromium 打开、截图 —— 截到的像素就是窗口里的像素。
 *
 *   node tools/preview.mjs                 演示数据（临时沙箱），五种视图各截一张
 *   node tools/preview.mjs --root <dir>    用真实存储（只读）
 *   node tools/preview.mjs --no-shot       只写 HTML，不截图
 *   node tools/preview.mjs --scope mirror  用文件镜像自己的作用域/权限块（第二张对照）
 *
 * **演示数据是多命名空间、多项目的**，因为这是唯一能让"作用域分区"这句话可验证的
 * 办法：单命名空间的存储只会渲染出镜像那条 `none（只读镜像…）` 的档位行，看不出
 * 隔离到底做了什么。数据里同时有当前项目、另一个项目、全局、当前会话，以及几条
 * `origin: 'migrated-global'` 的迁移遗留记录（未标注计数器因此非零）。
 *
 * 截图需要 `puppeteer-core` + 一个 Chromium 系浏览器（优先本机 Edge）。两者缺一
 * 都不致命：工具会照常写出 HTML 并报告 `screenshots: skipped`，闸门不会因此变红。
 *
 * **README 里的四张图**（`assets/dashboard.png`、`graph-lr.png`、`lifecycle.png`、
 * `timeline.png`）是本工具产物的下采样副本，没有第二套渲染路径：截完图后按内容裁掉
 * 页边留白、再等比缩放到 1200 / 1500 宽（Pillow LANCZOS）。`graph-tb.png` 与它无关，
 * 它只是同一张图的纵向排布，供人工对照。结构有变时这一步要重跑，否则 README 会停在
 * 旧数据上 —— 上一版就是这样：数据是单命名空间的，图片里根本看不到"另一个项目"。
 * @module dsh-anagenesis-window/tools/preview
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadRenderLayer } from './render-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** 找一个 Chromium 系浏览器。 */
function findBrowser() {
  const candidates = [
    process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    process.env['PROGRAMFILES(X86)'] ? join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    process.env['PROGRAMFILES(X86)'] ? join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
  ]
  for (const candidate of candidates) {
    if (candidate !== null && existsSync(candidate)) return candidate
  }
  return null
}

/** `puppeteer-core` 住在 profile 的 node_modules 里，从本包解析不到，所以显式定位。 */
function loadPuppeteer() {
  const bases = [
    process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'package.json') : null,
    join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'profiles', 'desktop', 'package.json'),
    join(process.env.APPDATA ?? '', '@deepseek-ai', 'dsh-desktop', 'package.json'),
  ].filter((value) => typeof value === 'string' && value !== '')
  for (const base of bases) {
    try {
      const require = createRequire(pathToFileURL(base).href)
      return require('puppeteer-core')
    } catch {
      /* try the next base */
    }
  }
  return null
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { root: '', out: join(root, '.preview'), shot: true, json: false, scope: 'live' }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') { index += 1; out.root = String(argv[index] ?? '') } else if (argv[index] === '--out') { index += 1; out.out = resolve(String(argv[index] ?? '.')) } else if (argv[index] === '--no-shot') out.shot = false
    else if (argv[index] === '--json') out.json = true
    else if (argv[index] === '--scope') {
      index += 1
      const wanted = String(argv[index] ?? '')
      if (wanted !== 'live' && wanted !== 'mirror') {
        console.error(`preview: --scope must be "live" or "mirror", got "${wanted}"`)
        process.exit(2)
      }
      out.scope = wanted
    } else if (argv[index] === '--help' || argv[index] === '-h') out.help = true
    else {
      console.error(`preview: unknown argument "${argv[index]}"`)
      process.exit(2)
    }
  }
  return out
}

// ── 演示数据 ──────────────────────────────────────────────────────────────────
//
// 项目身份是**算出来的**（`fingerprintProject`），不是编出来的：算出来的 id 与真实
// 服务在同一份 remote 上得到的 id 一致，标签也才和窗口里会打印的那个一样。remote
// 写死是刻意的 —— 这个演示要的是"看起来像一个真仓库"，而不是"跟着本机 checkout 走"。

/** 演示里的"当前项目"：一个认 remote 的仓库，标签与 remote 都是真的。 */
const DEMO_REMOTE = 'https://github.com/3likofj/dsh-anagenesis.git'

/** 另一个项目：**没有** remote 的本地仓库，指纹因此按路径算（`basis: 'path'`）。 */
const OTHER_PROJECT = Object.freeze({
  id: 'p1_9f2k7c1m4d0q',
  root: '/work/notes/agent-docs',
  remote: '',
  label: 'notes/agent-docs',
})

/** 演示里的会话：一条会话级记忆写在它里面。 */
const DEMO_SESSION = 'preview-session-01'

/** 会话级记忆的 TTL（与 `config.sessionTtlMs` 的默认值一致）。 */
const SESSION_TTL_MS = 24 * 3600 * 1000

/** 当前项目的身份：纯函数，同样的 remote 永远给同样的 id。 */
const { fingerprintProject } = await import(pathToFileURL(join(root, '..', 'src', 'scope', 'project.js')).href)

async function demoIdentity() {
  return fingerprintProject({ cwd: resolve(root, '..'), remote: DEMO_REMOTE })
}

/**
 * 演示存储：19 条记忆（四种命名空间：当前项目 / 另一个项目 / 全局 / 当前会话）、
 * 18 条关系（含一条悬空引用）、一段真实形状的日志。
 *
 * 三种作用域来源都刻意留了样本：`explicit`（今天写的）、`migrated-global`（隔离
 * 之前写的，未标注计数器因此非零）、以及会话级的 TTL 记录。截图里能同时看到
 * accent / warn / plain / dim 四种色调，这比看空存储有意义。
 */
async function makeDemoStore() {
  const dir = await mkdtemp(join(tmpdir(), 'ana-preview-'))
  await mkdir(join(dir, 'journal'), { recursive: true })
  const { createMemory, emptyState } = await import(pathToFileURL(join(root, '..', 'src', 'store', 'schema.js')).href)
  const { createScopeResolver } = await import(pathToFileURL(join(root, '..', 'src', 'scope', 'index.js')).href)
  const identity = await demoIdentity()
  const now = Date.now()
  const state = emptyState(now)
  const env = { now: now, embed: () => [0, 0, 0], sessionId: DEMO_SESSION }
  const mine = (origin) => ({ tier: 'project', projectId: identity.id, workspace: identity.root, origin: origin })
  const specs = [
    // ── 当前项目（accent） ────────────────────────────────────────────────────
    { id: 'mem-mirror', kind: 'procedure', state: 'locked', subject: '始终通过只读镜像读取存储', body: '第二个写者会与单写者池竞争；窗口只读。', salience: 0.95, scope: mine('explicit'), links: [{ rel: 'supports', to: 'mem-nowrite' }, { rel: 'part_of', to: 'mem-nowrite' }] },
    { id: 'mem-nowrite', kind: 'constraint', state: 'verified', subject: '窗口绝不持有写锁', body: '只读是结构性质，不是承诺。', salience: 0.92, scope: mine('explicit'), links: [{ rel: 'related', to: 'mem-fact-rpc' }] },
    { id: 'mem-fail-exports', kind: 'failure', state: 'active', subject: '首次装包忘了解析 exports["./client"]', body: '缺这一项时 dsh.client 抛错，整行不激活。', salience: 0.88, scope: mine('explicit'), links: [{ rel: 'caused_by', to: 'mem-nowrite' }] },
    { id: 'mem-probe', kind: 'heuristic', state: 'active', subject: '先形状探测再使用服务', body: '同名服务不等于同一个契约。', salience: 0.79, scope: mine('explicit'), links: [{ rel: 'supports', to: 'mem-mirror' }] },
    { id: 'mem-scope-iso', kind: 'constraint', state: 'locked', subject: '写入默认落在当前项目', body: '没有显式作用域时落到项目层，绝不落全局 —— 隔离不能靠自觉。', salience: 0.87, scope: mine('explicit'), links: [{ rel: 'supports', to: 'mem-nowrite' }, { rel: 'related', to: 'mem-global-rule' }] },
    { id: 'mem-gear-layer', kind: 'constraint', state: 'verified', subject: '预设是权限层而不是建议', body: '写入类工具只由预设组合注册；档位决定它们存不存在，护栏在调用时再拦一次。', salience: 0.84, scope: mine('explicit'), links: [{ rel: 'part_of', to: 'mem-scope-iso' }] },
    { id: 'mem-window-viz', kind: 'procedure', state: 'active', subject: '视觉验收靠离线预览截图', body: '渲染层是纯函数，所以截图里的像素就是窗口里的像素。', salience: 0.68, scope: mine('explicit'), links: [{ rel: 'related', to: 'mem-mirror' }] },
    { id: 'mem-hyp-entry', kind: 'hypothesis', state: 'draft', subject: '入口可能被 better-sidebar 覆盖', body: '尚未在真机确认。', salience: 0.61, scope: mine('explicit'), links: [{ rel: 'contradicts', to: 'mem-fact-rpc' }] },
    { id: 'mem-remember-worktree', kind: 'episode', state: 'active', subject: '换工作树后指纹没有变', body: 'remote 相同即同一个项目：同一份代码的多个 checkout 共享经验。', salience: 0.63, scope: mine('migrated-workspace'), links: [{ rel: 'supports', to: 'mem-scope-iso' }] },
    // ── 发到全局（plain） ─────────────────────────────────────────────────────
    { id: 'mem-fact-rpc', kind: 'fact', state: 'verified', subject: '客户端半没有包私有 host RPC', body: '所以数据走本包自己的只读路由。', salience: 0.74, scope: { tier: 'global', origin: 'explicit' }, links: [] },
    { id: 'mem-global-rule', kind: 'preference', state: 'active', subject: '跨项目检索必须显式授权', body: '默认只看当前项目 + 全局 + 当前会话；越界要写明理由。', salience: 0.72, scope: { tier: 'global', origin: 'explicit' }, links: [{ rel: 'related', to: 'mem-zh' }] },
    { id: 'mem-zh', kind: 'preference', state: 'active', subject: '界面一律中文', body: '中文用户要一眼看懂，不要机翻。', salience: 0.7, scope: { tier: 'global', origin: 'explicit' }, links: [{ rel: 'related', to: 'mem-fact-rpc' }] },
    // ── 当前会话（accent） ────────────────────────────────────────────────────
    { id: 'mem-sess-plan', kind: 'episode', state: 'active', subject: '本轮先把作用域分区画对', body: '会话级记录只在本会话里可召回，任务结束就过期。', salience: 0.66, ttlMs: SESSION_TTL_MS, scope: { tier: 'session', session: DEMO_SESSION, projectId: identity.id, origin: 'explicit' }, links: [{ rel: 'related', to: 'mem-scope-iso' }] },
    { id: 'mem-sess-check', kind: 'heuristic', state: 'draft', subject: '截图后先自己看一眼再交付', body: '闸门是绿的也可能画错东西。', salience: 0.52, ttlMs: SESSION_TTL_MS, scope: { tier: 'session', session: DEMO_SESSION, projectId: identity.id, origin: 'explicit' }, links: [] },
    // ── 另一个项目（warn） ───────────────────────────────────────────────────
    { id: 'mem-other-bump', kind: 'procedure', state: 'verified', subject: '文档仓库的版本号集中在 package.json', body: '另一个项目的经验：别照抄，先核对当前环境。', salience: 0.71, scope: { tier: 'project', projectId: OTHER_PROJECT.id, workspace: OTHER_PROJECT.root, origin: 'migrated-workspace' }, links: [{ rel: 'related', to: 'mem-zh' }] },
    { id: 'mem-other-index', kind: 'fact', state: 'active', subject: '索引重建要等锁释放', body: '那份仓库的索引是单写者模型。', salience: 0.58, scope: { tier: 'project', projectId: OTHER_PROJECT.id, workspace: OTHER_PROJECT.root, origin: 'migrated-workspace' }, links: [{ rel: 'supports', to: 'mem-other-bump' }] },
    { id: 'mem-other-onboard', kind: 'episode', state: 'deprecated', subject: '新人先读一遍术语表', body: '已被新的上手流程取代。', salience: 0.37, scope: { tier: 'project', projectId: OTHER_PROJECT.id, workspace: OTHER_PROJECT.root, origin: 'migrated-workspace' }, links: [] },
    // ── 隔离之前写的（migrated-global，未标注计数器靠这三条非零） ─────────────
    { id: 'mem-episode', kind: 'episode', state: 'deprecated', subject: '2026-10-06 首次真机安装', body: 'install_bundle 返回 applied，无需重启。', salience: 0.4, scope: { tier: 'global', origin: 'migrated-global' }, links: [{ rel: 'supersedes', to: 'mem-old-assume' }] },
    { id: 'mem-old-assume', kind: 'constraint', state: 'expired', subject: '旧假设：装完必须重启', body: '已被 dsh-client-hmr 推翻。', salience: 0.35, scope: { tier: 'global', origin: 'migrated-global' }, links: [] },
    { id: 'mem-first-note', kind: 'fact', state: 'active', subject: '第一版只有终端仪表盘', body: '那时还没有窗口，也没有作用域。', salience: 0.3, scope: { tier: 'global', origin: 'migrated-global' }, links: [] },
  ]
  // 项目登记走 `scopeResolver.registryPatch` —— 与实时服务登记"第一次见到的项目"用的是
  // 同一个构造器，所以 `state.projects` 的形状与真实存储一致，标签来源也一致。
  const registry = createScopeResolver({ fallbackCwd: () => identity.root })
  const registered = new Set()
  const register = (id, projectRoot, remote, label) => {
    if (registered.has(id)) return
    registered.add(id)
    const patch = registry.registryPatch(state, { id: id, kind: remote === '' ? 'path' : 'repo', root: projectRoot, remote: remote, label: label }, now)
    Object.assign(state.projects, patch === null ? {} : patch.projectSet)
  }
  register(identity.id, identity.root, identity.remote, identity.label)
  register(OTHER_PROJECT.id, OTHER_PROJECT.root, OTHER_PROJECT.remote, OTHER_PROJECT.label)
  for (const spec of specs) {
    const record = createMemory({
      id: spec.id, kind: spec.kind, state: spec.state, subject: spec.subject, body: spec.body,
      gist: spec.subject, tags: ['demo'], links: spec.links, confidence: 0.8,
      ttlMs: spec.ttlMs ?? null, scope: spec.scope,
    }, env)
    // `createMemory` 只要看到显式 tier 就把 origin 记成 'explicit'（写入路径的判据是
    // "调用方说了算"），而 `origin` 恰恰是"这条记录是谁写的、什么时候写的"的唯一判据
    // —— 未标注计数器读的就是它。`repairRecordScopes` 也是这么改的：标签留着，来源
    // 换成"迁移写的"。所以这里照做，而不是把手写 origin 塞进 spec。
    if (spec.scope.origin !== undefined) record.scope.origin = spec.scope.origin
    record.salience = spec.salience
    record.lastUsedAt = now - 3600_000
    state.memories[record.id] = record
  }
  // 悬空引用：指向一条不在这张图里的记忆 —— 断掉的引用正是这张图要给人看的。
  state.memories['mem-mirror'].links.push({ rel: 'related', to: 'mem-not-in-graph' })
  // 调参器真调过的两个旋钮：`tuning` 分区靠这一项才算有内容（偏离默认值的会被点亮）。
  state.params.global = {
    'recall.orient.tokenBudget': 1600,
    'recall.scopeWeight': 0.16,
    'recall.explorationRate': 0.25,
  }
  state.tuning.samples = [0.62, 0.7, 0.66, 0.74, 0.71]
  state.tuning.history = [{ metric: 0.74, at: now - 1800_000, auditId: 'tune_demo_1' }]
  state.stats = { commits: 64, recalls: 118, writes: 19, reverts: 1, hookFailures: 0 }
  state.version = 42
  await writeFile(join(dir, 'snapshot.json'), JSON.stringify({ state: state }, null, 2), 'utf8')

  const events = []
  let seq = 0
  const push = (type, payload) => {
    seq += 1
    events.push({ seq: seq, ts: now - (60 - seq) * 60_000, type: type, payload: payload })
  }
  for (const spec of specs) push('memory.remember', { id: spec.id, kind: spec.kind, namespace: spec.scope.tier === 'project' ? `project:${spec.scope.projectId}` : spec.scope.tier })
  push('memory.usage', { id: 'mem-global-rule', reason: 'cross-project recall must be authorized' })
  push('preset.bind', { preset: 'anagenesis', stack: ['guard', 'exploit'] })
  push('memory.promote', { transitions: [{ id: 'mem-nowrite', from: 'draft', to: 'active' }, { id: 'mem-fact-rpc', from: 'draft', to: 'active' }, { id: 'mem-probe', from: 'draft', to: 'active' }] })
  push('memory.link', { rel: 'supports' })
  push('memory.promote', { transitions: [{ id: 'mem-nowrite', from: 'active', to: 'verified' }, { id: 'mem-fact-rpc', from: 'active', to: 'verified' }, { id: 'mem-scope-iso', from: 'active', to: 'verified' }, { id: 'mem-gear-layer', from: 'draft', to: 'verified' }] })
  push('meta.tune', { param: 'recall.orient.tokenBudget', from: 1200, to: 1600 })
  push('strategy.setStack', { to: ['guard', 'exploit'] })
  push('meta.tune', { param: 'recall.scopeWeight', from: 0.12, to: 0.16 })
  push('memory.lock', { ids: ['mem-mirror', 'mem-scope-iso'], reason: '结构约束' })
  push('memory.demote', { transitions: [{ id: 'mem-episode', from: 'active', to: 'deprecated' }, { id: 'mem-other-onboard', from: 'active', to: 'deprecated' }] })
  push('meta.feedback', { objective: 'task_success', reward: 1 })
  push('memory.expire', { ids: ['mem-old-assume'], reason: '假设被推翻' })
  push('revert', { revertedType: 'meta.tune', revives: 1 })
  push('engine.quarantine', { strategy: 'explore' })
  await writeFile(join(dir, 'journal', 'journal-000001.jsonl'), events.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  return dir
}

// ── 作用域与权限：实时服务那两个 report 的形状 ────────────────────────────────

/**
 * `service.scopeReport()` 的形状，从真实 state 投影出来。
 *
 * 预览只读文件，没有活着的服务可以问 —— 而"作用域分区"要找的正是服务的答案。
 * 所以这里按 `src/index.js` 的 `scopeReport()` 逐字段构造：每个命名空间的条数来自
 * `namespaceCounts(state)`（与模型用的同一个函数），项目标签来自 `projectLabel()`
 * （与"另一个项目"的显示名同一个来源）。**没有一处是编出来的数字。**
 *
 * `knownProjects` 与 `namespaces` 不是渲染器要用的字段（模型只读 `current` 与
 * `defaultScopeTier`），它们留在这里是为了让这份块与服务返回的那份**同形状** ——
 * 一个只长着渲染器需要的字段的假报告，会让人以为服务也只给这些。
 * @param {any} state
 * @param {any} identity
 * @param {{ defaultScopeTier: string, session: string|null }} input
 * @returns {any}
 */
function scopeReportFor(state, identity, input) {
  const { namespaceCounts, parseNamespace, projectLabel } = scopeModule
  const counts = namespaceCounts(state)
  /** @type {Record<string, any>} */
  const namespaces = {}
  for (const [namespace, count] of Object.entries(counts.byNamespace)) {
    const parsed = parseNamespace(namespace)
    namespaces[namespace] = {
      count: count,
      tier: parsed.tier,
      projectId: parsed.tier === 'project' ? parsed.key : null,
      label: parsed.tier === 'project' ? projectLabel(state, parsed.key) : namespace,
      current: namespace === `project:${identity.id}`,
    }
  }
  const currentNamespace = `project:${identity.id}`
  return {
    current: {
      namespace: currentNamespace,
      tier: 'project',
      projectId: identity.id,
      projectLabel: identity.label,
      basis: identity.basis,
      root: identity.root,
      remote: identity.remote,
      workspace: identity.root,
      session: input.session,
    },
    defaultScopeTier: input.defaultScopeTier,
    sessionTtlMs: SESSION_TTL_MS,
    crossProjectDefault: false,
    knownProjects: Object.values(state.projects ?? {}).map((entry) => ({
      id: String(entry.id),
      label: String(entry.label),
      kind: String(entry.kind),
      root: String(entry.root),
      remote: String(entry.remote),
      firstSeenAt: Number(entry.firstSeenAt),
      lastSeenAt: Number(entry.lastSeenAt),
      current: entry.id === identity.id,
      memories: counts.byNamespace[`project:${String(entry.id)}`] ?? 0,
    })),
    namespaces: namespaces,
    totals: counts.byTier,
    journalNamespaces: {},
  }
}

/**
 * `service.permissionReport()` 的形状，来自**真的权限注册表**。
 *
 * 档位不是字符串常量：这里真的建一个 in-memory 注册表、真的发一份 `assisted` 授权，
 * 然后问它档位是什么、写入类工具在不在。于是"截图里的档位行"与"运行时那一行"读到
 * 的是同一套判定（`gearCovers(gear, 'write')`），不可能各说各话。
 * @param {{ gear: string, presetId: string, scopeKey: string, session: string|null }} input
 * @returns {Promise<any>}
 */
async function permissionReportFor(state, identity, input) {
  const { createPermissions } = await import(pathToFileURL(join(root, '..', 'src', 'permission', 'registry.js')).href)
  const { GEAR_NONE, gearCovers, toolsForGear } = await import(pathToFileURL(join(root, '..', 'src', 'permission', 'tiers.js')).href)
  const permissions = createPermissions({})
  const grant = permissions.grant({
    scopeKey: input.scopeKey, gear: input.gear, by: 'preset', reason: 'preview demo: the preset row is bound',
  })
  const gear = grant.live() ? permissions.gear() : GEAR_NONE
  const report = {
    preset: permissions.activeCount() > 0 ? input.presetId : null,
    presetActive: permissions.activeCount() > 0,
    gear: gear,
    gearLabel: gear === GEAR_NONE ? '未启用预设' : gear,
    grants: permissions.describe().scopeKeys,
    tools: permissions.allowedTools(),
    writeToolsAvailable: gearCovers(gear, 'write'),
    adminAvailable: gearCovers(gear, 'admin'),
    readOnlyTools: toolsForGear(GEAR_NONE),
    scope: {
      namespace: `project:${identity.id}`,
      tier: 'project',
      projectId: identity.id,
      projectLabel: identity.label,
      session: input.session,
    },
  }
  return { report: report, count: permissions.activeCount(), registered: toolsForGear(gear).length }
}

// ── 装配 ──────────────────────────────────────────────────────────────────────

const options = parseArgs(process.argv.slice(2))
if (options.help === true) {
  console.log('preview [--root <dir>] [--out <dir>] [--no-shot] [--scope live|mirror] [--json]')
  process.exit(0)
}

const R = loadRenderLayer()
/** 与模型共用的同一套纯函数 —— 作用域投影不允许有第二份实现。 */
const scopeModule = await import(pathToFileURL(join(root, '..', 'src', 'scope', 'index.js')).href)
const demo = options.root === '' ? await makeDemoStore() : ''
const storeRoot = options.root === '' ? demo : resolve(options.root)

const { readStoreMirror } = await import(pathToFileURL(join(root, '..', 'src', 'viz', 'mirror.js')).href)
const { buildDashboardModel, buildDiagramModel } = await import(pathToFileURL(join(root, '..', 'src', 'viz', 'model.js')).href)

const mirror = await readStoreMirror(storeRoot)

/** 演示数据里那个"当前调用方"：项目身份 + 会话。真实存储没有调用方，只能给 null。 */
const identity = demo === '' ? null : await demoIdentity()
const session = demo === '' ? null : DEMO_SESSION
/** 这次渲染站在哪里。演示数据按"能看到整份存储的运维视角"画（`allProjects: true`）。 */
const scopeContext = identity === null
  ? null
  : { projectId: identity.id, sessionId: session, allProjects: true }

/** 实时服务的两个块（`--scope mirror` 时退回镜像自己给的块）。 */
const liveScope = identity === null
  ? null
  : scopeReportFor(mirror.state, identity, { defaultScopeTier: 'project', session: session })
const livePermissions = identity === null
  ? null
  : (await permissionReportFor(mirror.state, identity, { gear: 'assisted', presetId: 'anagenesis', scopeKey: 'preset:anagenesis', session: session })).report

/**
 * 渲染源。默认走"实时服务"这套块（档位行因此是真的档位），`--scope mirror` 时
 * 原样用镜像自己的块（档位行会说"只读镜像下不可知"）。
 */
const source = {
  ...mirror,
  engine: { active: ['guard', 'exploit'], health: [] },
  selfStatus: { renders: 128, diagrams: 41, lastAt: Date.now() - 90_000, errors: 0, mode: 'tool' },
  ...(options.scope === 'mirror'
    ? { scope: mirror.scope, permissions: mirror.permissions }
    : { origin: 'live', scope: liveScope ?? mirror.scope, permissions: livePermissions ?? mirror.permissions }),
}
const modelOpts = scopeContext === null ? {} : { scopeContext: scopeContext }
const dashModel = buildDashboardModel(source, { width: 96, color: 'never', limit: { events: 8, salience: 5 }, redaction: 'secrets', ...modelOpts })
const graphModel = buildDiagramModel(source, { kind: 'memory-graph', limit: { nodes: 40, timeline: 12 }, redaction: 'secrets', ...modelOpts })
const lifeModel = buildDiagramModel(source, { kind: 'lifecycle', limit: { nodes: 40, timeline: 12 }, redaction: 'secrets', ...modelOpts })
const timeModel = buildDiagramModel(source, { kind: 'strategy-timeline', limit: { nodes: 40, timeline: 12 }, redaction: 'secrets', ...modelOpts })

/** 一个视图 = 标题栏 + 工具栏 + 内容 + 页脚（就是窗口里那四段）。 */
function frame(id, caption, state, body, extraFooter) {
  return '<div class="ana-preview-frame" id="' + id + '" data-dsh-anagenesis-window="preview">'
    + R.renderTitlebarHtml({ title: state.title, subtitle: caption })
    + R.renderToolbarHtml(state)
    + '<div class="ana-pane">' + body + '</div>'
    + R.renderFooterHtml(state)
    + (extraFooter === undefined ? '' : extraFooter)
    + '</div>'
}

/** 单视图页面：截图用。整页截图不会被元素定位/滚动裁掉顶部。 */
function pageFor(title, inner) {
  return '<!doctype html><html lang="zh-CN" data-ana-preview><head><meta charset="utf-8">'
    + '<title>' + R.esc(title) + '</title><style>' + R.ANA_CSS + '</style></head><body>' + inner + '</body></html>'
}

const baseState = {
  title: 'anagenesis · 可视化', view: 'dashboard', kind: 'memory-graph', direction: 'LR', zoom: 1,
  maxNodes: 40, width: 96, redaction: 'secrets', origin: dashModel.origin,
  storeVersion: dashModel.store.version, lastAt: Date.now(), busy: false, warnings: dashModel.warnings, error: '',
}

const frames = [
  frame('frame-dashboard', '仪表盘 —— 关键指标 + 中文分区', { ...baseState, view: 'dashboard' },
    R.renderDashboardHtml(dashModel) + R.dashboardLegendHtml()),
  frame('frame-graph-lr', '图表 · 记忆关系图（横向）', { ...baseState, view: 'graph', direction: 'LR' },
    R.renderDiagramHtml(graphModel, { direction: 'LR', maxNodes: 40 }) + R.graphLegendHtml()),
  frame('frame-graph-tb', '图表 · 记忆关系图（纵向）', { ...baseState, view: 'graph', direction: 'TB' },
    R.renderDiagramHtml(graphModel, { direction: 'TB', maxNodes: 40 }) + R.graphLegendHtml()),
  frame('frame-lifecycle', '图表 · 生命周期流转', { ...baseState, view: 'graph', kind: 'lifecycle', direction: 'LR' },
    R.renderDiagramHtml(lifeModel, { direction: 'LR' })),
  frame('frame-timeline', '图表 · 策略时间线', { ...baseState, view: 'graph', kind: 'strategy-timeline' },
    R.renderDiagramHtml(timeModel, {})),
]

const html = pageFor('anagenesis 可视化预览',
  '<h1 style="max-width:1000px;margin:0 auto 18px;color:#e9e9ec;font:650 18px var(--ana-sans)">'
  + 'anagenesis 可视化 —— 离线渲染预览</h1>' + frames.join(''))

mkdirSync(options.out, { recursive: true })
const htmlPath = join(options.out, 'preview.html')
writeFileSync(htmlPath, html, 'utf8')

/** 每个视图一个独立页面文件，供逐张截图与人工打开。 */
const perView = [
  ['dashboard', '仪表盘', frames[0]],
  ['graph-lr', '记忆关系图（横向）', frames[1]],
  ['graph-tb', '记忆关系图（纵向）', frames[2]],
  ['lifecycle', '生命周期流转', frames[3]],
  ['timeline', '策略时间线', frames[4]],
]
const viewPages = new Map()
for (const [id, caption, body] of perView) {
  const file = join(options.out, 'view-' + id + '.html')
  writeFileSync(file, pageFor('预览 · ' + caption, body), 'utf8')
  viewPages.set(id, file)
}

/**
 * 作用域分区的**事实检查**：这一屏到底画出了什么。
 *
 * 闸门绿不等于画对了 —— 这正是上一版截图的问题：数据是单命名空间的，于是"另一个
 * 项目"那一行根本不存在，而所有检查依然全绿。所以这里数一遍色调，把"至少有一条
 * accent（当前项目）、一条 warn（其它项目）、一条 plain（全局）"变成可断言的。
 */
const scopeSection = (dashModel.sections ?? []).find((item) => String(item.id) === 'scope')
const scopeRows = Array.isArray(scopeSection?.rows) ? scopeSection.rows : []
const tones = { accent: 0, warn: 0, plain: 0, dim: 0 }
for (const item of scopeRows) if (Object.prototype.hasOwnProperty.call(tones, String(item.tone))) tones[String(item.tone)] += 1
const rowWith = (label) => scopeRows.find((item) => String(item.label) === label)
const htmlScope = /作用域/.test(html)
const demoMode = options.root === ''

const report = {
  store: storeRoot, demo: options.root === '', scope: options.scope, html: htmlPath, bytes: html.length,
  models: {
    dashboardSections: dashModel.sections.length,
    graphNodes: graphModel.nodes.length, graphEdges: graphModel.edges.length,
    lifecycleTransitions: lifeModel.transitions.length, timelineEvents: timeModel.timeline.length,
  },
  scopeFacts: {
    currentProject: String(dashModel.scope?.current?.label ?? ''),
    currentNamespace: String(dashModel.scope?.current?.namespace ?? ''),
    basis: String(dashModel.scope?.current?.basis ?? ''),
    otherProjects: Number(dashModel.scope?.otherProjects ?? 0),
    namespaceRows: scopeRows.length - 4,
    tones: tones,
    defaultWriteTier: String(rowWith('default write tier')?.value ?? ''),
    gear: String(rowWith('gear')?.value ?? ''),
    gearTone: String(rowWith('gear')?.tone ?? ''),
    legacyUntagged: String(rowWith('legacy untagged')?.value ?? ''),
  },
  checks: {
    svgRendered: frames[1].includes('<svg'),
    noMermaidSource: !/classDef|graph LR|flowchart |style \w+ fill:#/.test(html),
    noHexLeak: !/#(111827|1f2937|0f172a)\b/.test(html),
    noRawNodeId: !/ana_mem_/.test(html),
    // 只看**可见文本**：`<option value="lifecycle">` 里的机器值是必须保留的，
    // 样式表里还有 `:active` 这类选择器。扫描前把 `<style>` 块和标签一起去掉，
    // 剩下的是用户真正会读到的东西。
    chineseOnly: !/\b(overview|lifecycle|draft|active|verified|locked|deprecated|expired|retired|safe mode|archives|checkpoints|default)\b/
      .test(html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]*>/g, ' ')),
    // 作用域分区必须真的在页面上。
    scopeSectionDrawn: htmlScope && scopeRows.length > 0,
    // 三种色调是**演示数据**的断言：README 那几张图靠它们证明"当前项目 / 另一个项目 /
    // 全局"真的画成了三种颜色。真实存储里有没有别的项目不是这个工具能要求的事，
    // 所以 `--root` 跑真实数据时这三项不参与判定（也不该把它判红）。
    scopeHasMine: !demoMode || tones.accent > 0,
    scopeHasOtherProject: !demoMode || tones.warn > 0,
    scopeHasGlobal: !demoMode || tones.plain > 0,
  },
  screenshots: [],
  screenshotsSkipped: '',
}

if (options.shot) {
  const puppeteer = loadPuppeteer()
  const browserPath = findBrowser()
  if (puppeteer === null || browserPath === null) {
    report.screenshotsSkipped = puppeteer === null ? 'puppeteer-core not resolvable' : 'no Chromium browser found'
  } else {
    const browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb'],
    })
    try {
      const page = await browser.newPage()
      await page.setViewport({ width: 1100, height: 1000, deviceScaleFactor: 2 })
      for (const [id, file] of viewPages.entries()) {
        await page.goto(pathToFileURL(file).href, { waitUntil: 'load' })
        const target = join(options.out, id + '.png')
        // 整页截图：元素截图在元素高于视口时会裁掉顶部（第一版 lifecycle 就丢了工具栏）。
        await page.screenshot({ path: target, fullPage: true, captureBeyondViewport: true })
        report.screenshots.push(target)
      }
    } finally {
      await browser.close()
    }
  }
}

if (demo !== '') await rm(demo, { recursive: true, force: true }).catch(() => {})

if (options.json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`anagenesis 窗口预览 —— 存储 ${report.store}${report.demo ? '（演示数据）' : '（真实数据，只读）'}`)
  console.log(`  HTML    ${report.html}  (${report.bytes} 字节)`)
  console.log(`  模型    仪表盘分区 ${report.models.dashboardSections} · 图谱 ${report.models.graphNodes} 节点/${report.models.graphEdges} 连线`
    + ` · 迁移 ${report.models.lifecycleTransitions} 种 · 时间线 ${report.models.timelineEvents} 条`)
  console.log(`  作用域  ${report.scopeFacts.currentProject} · ${report.scopeFacts.currentNamespace}（${report.scopeFacts.basis}）`
    + ` · 其它项目 ${report.scopeFacts.otherProjects} 个 · 命名空间行 ${report.scopeFacts.namespaceRows}`
    + ` · 色调 accent/warn/plain/dim = ${report.scopeFacts.tones.accent}/${report.scopeFacts.tones.warn}/${report.scopeFacts.tones.plain}/${report.scopeFacts.tones.dim}`)
  console.log(`  档位    ${report.scopeFacts.gear}（${report.scopeFacts.gearTone}）· 默认写入 ${report.scopeFacts.defaultWriteTier}`
    + ` · 未标注旧记忆 ${report.scopeFacts.legacyUntagged} · 来源块 ${report.scope}`)
  for (const [name, ok] of Object.entries(report.checks)) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (report.screenshots.length > 0) for (const file of report.screenshots) console.log(`  截图    ${file}`)
  else console.log(`  截图    跳过 —— ${report.screenshotsSkipped !== '' ? report.screenshotsSkipped : '--no-shot（本次只要 HTML）'}`)
}
process.exit(Object.values(report.checks).every(Boolean) ? 0 : 1)
