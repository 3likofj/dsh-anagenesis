#!/usr/bin/env node
/**
 * viz-watch — the live TUI, in its own process, read-only.
 *
 * Why a separate process: the plugin runs inside a host that owns a Web GUI, not
 * a terminal, and its disclosure says `subprocess: none` — so it must never spawn
 * anything. A human who wants a continuously redrawing dashboard in a real
 * terminal runs this file; it opens no store handle, takes no writer lock, and
 * never writes a byte. It replays `snapshot.json` + the journal through
 * `src/viz/mirror.js` and renders through exactly the same code the
 * `ana_dashboard` tool uses.
 *
 * Usage:
 *   node tools/viz-watch.mjs --watch            # redraw every second
 *   node tools/viz-watch.mjs --once             # one frame, for a pipe or a log
 *   node tools/viz-watch.mjs --diagram lifecycle --format mermaid
 *   node tools/viz-watch.mjs --root <store> --width 120 --section overview,journal
 * @module dsh-anagenesis/tools/viz-watch
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { looksLikeStore, readStoreMirror } from '../src/viz/mirror.js'
import { DASHBOARD_SECTIONS, DIAGRAM_KINDS, buildDashboardModel, buildDiagramModel } from '../src/viz/model.js'
import { renderFrame } from '../src/viz/tui.js'
import { DIAGRAM_FORMATS, renderDiagram } from '../src/viz/diagram.js'
import { DEFAULT_REDACTION, REDACTION_LEVELS } from '../src/viz/redact.js'

const HELP = `anagenesis viz-watch — read-only TUI for a dsh-anagenesis store

  --watch                 keep redrawing (default when stdout is a TTY)
  --once                  render one frame and exit
  --root <dir>            store directory (default $DSH_HOME/anagenesis)
  --width <cells>         frame width, 48–200 (default 96)
  --interval <ms>         redraw interval, ≥ 250 (default 1000)
  --section <a,b>         dashboard sections: ${DASHBOARD_SECTIONS.join(', ')}
  --events <n>            journal events to show (default 8)
  --salience <n>          top records to show (default 5)
  --redaction <level>     ${REDACTION_LEVELS.join(' | ')} (default ${DEFAULT_REDACTION})
  --color <mode>          auto | always | never (default: auto → always on a TTY)
  --diagram <kind>        ${DIAGRAM_KINDS.join(' | ')} — render a diagram instead of the dashboard
  --format <fmt>          ${DIAGRAM_FORMATS.join(' | ')} (default mermaid)
  --help                  this text

The watcher never writes to the store and never takes the single-writer handle:
it replays the snapshot and journal that the running host already wrote.`

/**
 * @param {string[]} argv
 * @returns {Record<string, any>}
 */
function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const out = { color: 'auto' }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => {
      index += 1
      return argv[index]
    }
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--watch') out.watch = true
    else if (arg === '--once') out.once = true
    else if (arg === '--no-color') out.color = 'never'
    else if (arg === '--root') out.root = next()
    else if (arg === '--width') out.width = Number(next())
    else if (arg === '--interval') out.interval = Number(next())
    else if (arg === '--section') out.sections = String(next() ?? '').split(',').map((part) => part.trim()).filter((part) => part !== '')
    else if (arg === '--events') out.events = Number(next())
    else if (arg === '--salience') out.salience = Number(next())
    else if (arg === '--redaction') out.redaction = next()
    else if (arg === '--color') out.color = next()
    else if (arg === '--diagram') out.diagram = next()
    else if (arg === '--format') out.format = next()
    else {
      console.error(`viz-watch: unknown argument "${arg}" (try --help)`)
      process.exit(2)
    }
  }
  return out
}

/** @returns {string} */
function defaultRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'anagenesis')
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

const opts = parseArgs(process.argv.slice(2))
if (opts.help === true) {
  console.log(HELP)
  process.exit(0)
}

const root = resolve(opts.root ?? defaultRoot())
if (!looksLikeStore(root)) {
  console.error(`viz-watch: no anagenesis store at ${root} (expected a journal/ directory).\n`
    + '  Pass --root <dir>, or install/mount the plugin so it creates one.')
  process.exit(1)
}

const isTty = process.stdout.isTTY === true
const color = opts.color === 'always' || (opts.color === 'auto' && isTty) ? 'always' : 'never'
const watch = opts.watch === true || (opts.once !== true && opts.diagram === undefined && isTty)
if (watch && !isTty) {
  console.error('viz-watch: --watch needs a terminal; use --once when stdout is a pipe or a file.')
  process.exit(1)
}
const interval = Math.max(250, Number.isFinite(opts.interval) ? Number(opts.interval) : 1000)
const width = Math.min(200, Math.max(48, Number.isFinite(opts.width) ? Number(opts.width) : 96))
const redaction = REDACTION_LEVELS.includes(String(opts.redaction)) ? String(opts.redaction) : DEFAULT_REDACTION
const selfStatus = { renders: 0, diagrams: 0, lastAt: /** @type {number|null} */ (null), errors: 0, mode: 'watch' }

/** @returns {Promise<string>} */
async function draw() {
  const mirror = await readStoreMirror(root)
  selfStatus.renders += 1
  selfStatus.lastAt = Date.now()
  if (opts.diagram !== undefined) {
    const model = buildDiagramModel(mirror, {
      kind: opts.diagram,
      redaction,
      limit: { nodes: 40, timeline: Math.max(6, Number(opts.events ?? 8) * 2) },
    })
    return renderDiagram(model, { format: opts.format, embed: false }).text
  }
  const model = buildDashboardModel(mirror, {
    sections: opts.sections,
    width,
    color,
    redaction,
    selfStatus,
    limit: { events: Number(opts.events ?? 8), salience: Number(opts.salience ?? 5) },
  })
  return renderFrame(model, { width, color, sections: opts.sections, isTty })
}

process.on('SIGINT', () => {
  if (watch) process.stdout.write('\x1b[?25h\n')
  process.exit(0)
})

if (!watch) {
  process.stdout.write(`${await draw()}\n`)
  process.exit(0)
}

process.stdout.write('\x1b[?25l') // hide the cursor while redrawing
let running = true
process.on('SIGTERM', () => { running = false })
while (running) {
  const frame = await draw().catch((error) => {
    selfStatus.errors += 1
    return `viz-watch: render failed — ${error instanceof Error ? error.message : String(error)}`
  })
  process.stdout.write(`\x1b[2J\x1b[H${frame}\n`)
  await sleep(interval)
}
process.stdout.write('\x1b[?25h\n')