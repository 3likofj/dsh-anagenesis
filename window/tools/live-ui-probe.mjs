/**
 * 真机交互探针 —— 在**运行中的 GUI 页面**里验证窗口能不能点。
 *
 * 为什么需要它：72 个离线测试用的是 mini-React 与假 DOM，没有布局、没有命中测试、
 * 也没有真实的 React 事件系统。用户报"点不动"时，只有真页面能给出答案。
 *
 * 用法：node tools/live-ui-probe.mjs [--url http://127.0.0.1:19387] [--shot <dir>]
 * @module dsh-anagenesis-window/tools/live-ui-probe
 */

import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function loadPuppeteer() {
  for (const base of [
    process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'package.json') : null,
    join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'profiles', 'desktop', 'package.json'),
  ].filter((value) => typeof value === 'string' && value !== '')) {
    try {
      return createRequire(pathToFileURL(base).href)('puppeteer-core')
    } catch {
      /* next */
    }
  }
  return null
}

function findBrowser() {
  const candidates = [
    process.env['PROGRAMFILES(X86)'] ? join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  ]
  for (const candidate of candidates) if (candidate !== null && existsSync(candidate)) return candidate
  return null
}

const argv = process.argv.slice(2)
const url = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://127.0.0.1:19387'
const shotDir = argv.includes('--shot') ? resolve(argv[argv.indexOf('--shot') + 1]) : ''
if (shotDir !== '') mkdirSync(shotDir, { recursive: true })

const puppeteer = loadPuppeteer()
const browserPath = findBrowser()
if (puppeteer === null || browserPath === null) {
  console.log('live-ui-probe: skipped — puppeteer-core or a Chromium browser is unavailable')
  process.exit(0)
}

const steps = []
const say = (ok, text, extra) => {
  steps.push({ ok, text, extra })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}${extra === undefined ? '' : ' — ' + JSON.stringify(extra)}`)
}

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  page.on('pageerror', (error) => console.log('  [pageerror] ' + String(error.message).slice(0, 200)))
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  // 真 GUI 要连 websocket、拉会话，给足时间。
  await page.waitForFunction(() => document.querySelector('#root, [data-dsh-app], body') !== null, { timeout: 30000 })
  await new Promise((r) => setTimeout(r, 6000))

  const booted = await page.evaluate(() => ({
    title: document.title,
    roots: document.querySelectorAll('div').length,
    hasHeaderButton: document.querySelector('[data-dsh-anagenesis-window-button]') !== null,
    styleNodes: document.querySelectorAll('style').length,
  }))
  say(true, 'the GUI page booted', booted)

  // 打开窗口：优先点顶部栏入口；找不到就直接挂载一次侧栏入口（两者走同一个 engine）。
  let opened = await page.evaluate(() => document.querySelector('[data-dsh-anagenesis-window="window"]') !== null)
  if (!opened) {
    const button = await page.$('[data-dsh-anagenesis-window-button]')
    if (button !== null) {
      await button.click()
      await new Promise((r) => setTimeout(r, 1500))
      opened = await page.evaluate(() => document.querySelector('[data-dsh-anagenesis-window="window"]') !== null)
      say(opened, 'the header entrance opened the window')
    } else {
      say(false, 'no entrance button was found in this page (the conversation view may not be mounted)')
    }
  } else {
    say(true, 'the window was already open')
  }

  if (opened) {
    const dom = await page.evaluate(() => {
      const win = document.querySelector('[data-dsh-anagenesis-window="window"]')
      const cs = getComputedStyle(win)
      const cards = win.querySelectorAll('.ana-card')
      const cardStyle = cards.length > 0 ? getComputedStyle(cards[0]) : null
      const svgNodes = win.querySelectorAll('.ana-svg .ana-node-box')
      return {
        pointerEvents: cs.pointerEvents,
        display: cs.display,
        width: Math.round(win.getBoundingClientRect().width),
        height: Math.round(win.getBoundingClientRect().height),
        actions: win.querySelectorAll('[data-ana-action]').length,
        fields: win.querySelectorAll('[data-ana-field]').length,
        selects: win.querySelectorAll('select').length,
        cards: cards.length,
        cardBorder: cardStyle === null ? null : cardStyle.borderTopWidth,
        cardRadius: cardStyle === null ? null : cardStyle.borderTopLeftRadius,
        svgNodes: svgNodes.length,
        bars: win.querySelectorAll('.ana-pbar').length,
        paneOverflow: (() => { const p = win.querySelector('.ana-pane'); return p === null ? null : getComputedStyle(p).overflowY })(),
        tabs: [...win.querySelectorAll('[data-ana-action^="view-"]')].map((b) => b.textContent.trim()),
      }
    })
    say(dom.cards > 0 || dom.svgNodes > 0, 'the window renders content', dom)
    say(dom.pointerEvents === 'auto', 'the window opts back into pointer events', { pointerEvents: dom.pointerEvents })
    say(dom.paneOverflow === 'auto', 'the content pane scrolls instead of overflowing the window', { overflowY: dom.paneOverflow })
    say(dom.cards > 0 ? dom.cardRadius !== '0px' : true, 'cards are actually styled (not a bare stack)', { radius: dom.cardRadius })

    // ── 真的点一下：切到图表面，然后换方向 ────────────────────────────────
    const before = await page.evaluate(() => document.querySelector('[data-dsh-anagenesis-window="window"]').innerHTML.length)
    const graphTab = await page.$('[data-ana-action="view-graph"]')
    if (graphTab !== null) {
      await graphTab.click()
      await new Promise((r) => setTimeout(r, 2500))
      const after = await page.evaluate(() => {
        const win = document.querySelector('[data-dsh-anagenesis-window="window"]')
        return { svg: win.querySelectorAll('.ana-svg').length, nodes: win.querySelectorAll('.ana-node').length, html: win.innerHTML.length }
      })
      say(after.svg > 0, 'clicking 「图表」 actually switched the face and drew an SVG', after)
    } else {
      say(false, 'the 「图表」 button was not found')
    }

    const dirSelect = await page.$('[data-ana-field="direction"]')
    if (dirSelect !== null) {
      await dirSelect.select('TB')
      await new Promise((r) => setTimeout(r, 1200))
      const selected = await page.evaluate(() => {
        const el = document.querySelector('[data-ana-field="direction"]')
        return el === null ? null : el.value
      })
      say(selected === 'TB', 'changing 「方向」 took effect', { value: selected })
    } else {
      say(false, 'the 「方向」 control is not on the graph face')
    }

    const refreshed = await page.evaluate(() => ({
      before: 0,
    }))
    void before
    void refreshed

    if (shotDir !== '') {
      await page.screenshot({ path: join(shotDir, 'live-window.png') })
      say(true, 'screenshot written', { file: join(shotDir, 'live-window.png') })
    }
  }
} finally {
  await browser.close()
}

const failed = steps.filter((step) => step.ok !== true)
console.log(failed.length === 0 ? '\nLIVE UI PROBE PASSED' : `\nLIVE UI PROBE: ${failed.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)