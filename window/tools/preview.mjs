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
 *
 * 截图需要 `puppeteer-core` + 一个 Chromium 系浏览器（优先本机 Edge）。两者缺一
 * 都不致命：工具会照常写出 HTML 并报告 `screenshots: skipped`，闸门不会因此变红。
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
  const out = { root: '', out: join(root, '.preview'), shot: true, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') { index += 1; out.root = String(argv[index] ?? '') } else if (argv[index] === '--out') { index += 1; out.out = resolve(String(argv[index] ?? '.')) } else if (argv[index] === '--no-shot') out.shot = false
    else if (argv[index] === '--json') out.json = true
    else if (argv[index] === '--help' || argv[index] === '-h') out.help = true
    else {
      console.error(`preview: unknown argument "${argv[index]}"`)
      process.exit(2)
    }
  }
  return out
}

/**
 * 演示存储：9 条记忆（覆盖 8 种类型、7 种状态）、11 条关系（含一条悬空引用）、
 * 一段真实形状的日志。截图里能同时看到所有颜色语义，这比看空存储有意义。
 */
async function makeDemoStore() {
  const dir = await mkdtemp(join(tmpdir(), 'ana-preview-'))
  await mkdir(join(dir, 'journal'), { recursive: true })
  const { createMemory, emptyState } = await import(pathToFileURL(join(root, '..', 'src', 'store', 'schema.js')).href)
  const now = Date.now()
  const state = emptyState(now)
  const env = { now: now, embed: () => [0, 0, 0], sessionId: 'demo' }
  const specs = [
    { id: 'mem-mirror', kind: 'procedure', state: 'locked', subject: '始终通过只读镜像读取存储', body: '第二个写者会与单写者池竞争；窗口只读。', salience: 0.95, links: [{ rel: 'supports', to: 'mem-nowrite' }, { rel: 'part_of', to: 'mem-nowrite' }] },
    { id: 'mem-nowrite', kind: 'constraint', state: 'verified', subject: '窗口绝不持有写锁', body: '只读是结构性质，不是承诺。', salience: 0.92, links: [{ rel: 'related', to: 'mem-fact-rpc' }] },
    { id: 'mem-fail-exports', kind: 'failure', state: 'active', subject: '首次装包忘了解析 exports["./client"]', body: '缺这一项时 dsh.client 抛错，整行不激活。', salience: 0.88, links: [{ rel: 'caused_by', to: 'mem-nowrite' }] },
    { id: 'mem-hyp-entry', kind: 'hypothesis', state: 'draft', subject: '入口可能被 better-sidebar 覆盖', body: '尚未在真机确认。', salience: 0.61, links: [{ rel: 'contradicts', to: 'mem-fact-rpc' }] },
    { id: 'mem-probe', kind: 'heuristic', state: 'active', subject: '先形状探测再使用服务', body: '同名服务不等于同一个契约。', salience: 0.79, links: [{ rel: 'supports', to: 'mem-mirror' }] },
    { id: 'mem-fact-rpc', kind: 'fact', state: 'verified', subject: '客户端半没有包私有 host RPC', body: '所以数据走本包自己的只读路由。', salience: 0.74, links: [] },
    { id: 'mem-zh', kind: 'preference', state: 'active', subject: '界面一律中文', body: '中文用户要一眼看懂，不要机翻。', salience: 0.7, links: [{ rel: 'related', to: 'mem-fact-rpc' }] },
    { id: 'mem-episode', kind: 'episode', state: 'deprecated', subject: '2026-10-06 首次真机安装', body: 'install_bundle 返回 applied，无需重启。', salience: 0.4, links: [{ rel: 'supersedes', to: 'mem-old-assume' }] },
    { id: 'mem-old-assume', kind: 'constraint', state: 'expired', subject: '旧假设：装完必须重启', body: '已被 dsh-client-hmr 推翻。', salience: 0.35, links: [] },
  ]
  for (const spec of specs) {
    const record = createMemory({
      id: spec.id, kind: spec.kind, state: spec.state, subject: spec.subject, body: spec.body,
      gist: spec.subject, tags: ['demo'], links: spec.links, confidence: 0.8,
    }, env)
    record.salience = spec.salience
    record.lastUsedAt = now - 3600_000
    state.memories[record.id] = record
  }
  // 悬空引用：指向一条不在这张图里的记忆 —— 断掉的引用正是这张图要给人看的。
  state.memories['mem-mirror'].links.push({ rel: 'related', to: 'mem-not-in-graph' })
  state.version = 42
  await writeFile(join(dir, 'snapshot.json'), JSON.stringify({ state: state }, null, 2), 'utf8')

  const events = []
  let seq = 0
  const push = (type, payload) => {
    seq += 1
    events.push({ seq: seq, ts: now - (60 - seq) * 60_000, type: type, payload: payload })
  }
  for (const spec of specs) push('memory.remember', { id: spec.id, kind: spec.kind })
  push('memory.promote', { transitions: [{ id: 'mem-nowrite', from: 'draft', to: 'active' }, { id: 'mem-fact-rpc', from: 'draft', to: 'active' }, { id: 'mem-probe', from: 'draft', to: 'active' }] })
  push('memory.link', { rel: 'supports' })
  push('memory.promote', { transitions: [{ id: 'mem-nowrite', from: 'active', to: 'verified' }, { id: 'mem-fact-rpc', from: 'active', to: 'verified' }] })
  push('meta.tune', { param: 'recall.orient.tokenBudget', from: 1200, to: 1600 })
  push('strategy.setStack', { to: ['guard', 'exploit'] })
  push('memory.lock', { ids: ['mem-mirror'], reason: '结构约束' })
  push('memory.demote', { transitions: [{ id: 'mem-episode', from: 'active', to: 'deprecated' }] })
  push('meta.feedback', { objective: 'task_success', reward: 1 })
  push('memory.expire', { ids: ['mem-old-assume'], reason: '假设被推翻' })
  push('revert', { revertedType: 'meta.tune', revives: 1 })
  push('engine.quarantine', { strategy: 'explore' })
  await writeFile(join(dir, 'journal', 'journal-000001.jsonl'), events.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  return dir
}

const options = parseArgs(process.argv.slice(2))
if (options.help === true) {
  console.log('preview [--root <dir>] [--out <dir>] [--no-shot] [--json]')
  process.exit(0)
}

const R = loadRenderLayer()
const demo = options.root === '' ? await makeDemoStore() : ''
const storeRoot = options.root === '' ? demo : resolve(options.root)

const { readStoreMirror } = await import(pathToFileURL(join(root, '..', 'src', 'viz', 'mirror.js')).href)
const { buildDashboardModel, buildDiagramModel } = await import(pathToFileURL(join(root, '..', 'src', 'viz', 'model.js')).href)

const mirror = await readStoreMirror(storeRoot)
const dashModel = buildDashboardModel(mirror, { width: 96, color: 'never', limit: { events: 8, salience: 5 }, redaction: 'secrets' })
const graphModel = buildDiagramModel(mirror, { kind: 'memory-graph', limit: { nodes: 40, timeline: 12 }, redaction: 'secrets' })
const lifeModel = buildDiagramModel(mirror, { kind: 'lifecycle', limit: { nodes: 40, timeline: 12 }, redaction: 'secrets' })
const timeModel = buildDiagramModel(mirror, { kind: 'strategy-timeline', limit: { nodes: 40, timeline: 12 }, redaction: 'secrets' })

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

const report = {
  store: storeRoot, demo: options.root === '', html: htmlPath, bytes: html.length,
  models: {
    dashboardSections: dashModel.sections.length,
    graphNodes: graphModel.nodes.length, graphEdges: graphModel.edges.length,
    lifecycleTransitions: lifeModel.transitions.length, timelineEvents: timeModel.timeline.length,
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
  },
  screenshots: [],
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
  for (const [name, ok] of Object.entries(report.checks)) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (report.screenshots.length > 0) for (const file of report.screenshots) console.log(`  截图    ${file}`)
  else console.log(`  截图    跳过 —— ${report.screenshotsSkipped}`)
}
process.exit(Object.values(report.checks).every(Boolean) ? 0 : 1)