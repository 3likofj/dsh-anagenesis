/**
 * TUI serializer: a model becomes a fixed-width, terminal-native frame.
 *
 * Everything here is a total function of the model — no store, no clock, no
 * terminal state — which is what lets the same code serve a tool call (one frame
 * into the chat) and the standalone watcher (frames into a real TTY). Two details
 * that make it look right rather than almost right:
 *
 *   - **display width, not string length.** Memories are frequently Chinese, and
 *     a box drawn with `str.length` tears itself apart on the first CJK label.
 *   - **colour after padding.** SGR escapes count as characters, so a coloured
 *     string is padded and truncated while still bare, then wrapped.
 *
 * The few strings this file owns itself (`warnings`, the empty-section mark, the
 * section fallback) come from `./lang.js`, keyed off `model.render.lang` so the
 * caller only ever states the language once. `opts.lang` overrides it.
 * @module dsh-anagenesis/viz/tui
 */

import { terminalText } from './lang.js'

const RESET = '\x1b[0m'

/** @type {Record<string, string>} */
const TONES = {
  plain: '',
  dim: '\x1b[2m',
  accent: '\x1b[36m',
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  bad: '\x1b[31m',
}

const WIDE_RANGES = /** @type {[number, number][]} */ ([
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
])

const ZERO_WIDTH_RANGES = /** @type {[number, number][]} */ ([
  [0x0300, 0x036f], [0x200b, 0x200f], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
])

/**
 * @param {number} code
 * @param {[number, number][]} ranges
 * @returns {boolean}
 */
function inRanges(code, ranges) {
  for (const [from, to] of ranges) if (code >= from && code <= to) return true
  return false
}

/**
 * Terminal cells a string occupies.
 * @param {unknown} text
 * @returns {number}
 */
export function displayWidth(text) {
  let width = 0
  for (const char of String(text ?? '')) {
    const code = /** @type {number} */ (char.codePointAt(0))
    if (code === 0 || inRanges(code, ZERO_WIDTH_RANGES)) continue
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue
    width += inRanges(code, WIDE_RANGES) ? 2 : 1
  }
  return width
}

/**
 * Cut a string to `width` cells, marking the cut with an ellipsis.
 * @param {unknown} text
 * @param {number} width
 * @returns {string}
 */
export function truncateTo(text, width) {
  const value = String(text ?? '')
  if (width <= 0) return ''
  if (displayWidth(value) <= width) return value
  const budget = width - 1
  let out = ''
  let used = 0
  for (const char of value) {
    const code = /** @type {number} */ (char.codePointAt(0))
    const cells = code === 0 || inRanges(code, ZERO_WIDTH_RANGES) || code < 0x20 ? 0 : inRanges(code, WIDE_RANGES) ? 2 : 1
    if (used + cells > budget) break
    out += char
    used += cells
  }
  return `${out}…`
}

/**
 * @param {unknown} text
 * @param {number} width
 * @returns {string}
 */
export function padTo(text, width) {
  const value = String(text ?? '')
  const pad = Math.max(0, width - displayWidth(value))
  return `${value}${' '.repeat(pad)}`
}

/**
 * @param {number} fraction
 * @param {number} width
 * @returns {string}
 */
export function bar(fraction, width = 12) {
  const ratio = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  const filled = Math.round(ratio * width)
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`
}

/**
 * @param {'auto'|'always'|'never'|string} mode
 * @param {boolean} isTty
 * @returns {'always'|'never'}
 */
export function resolveColor(mode, isTty) {
  if (mode === 'always') return 'always'
  if (mode === 'never') return 'never'
  return isTty ? 'always' : 'never'
}

/**
 * @param {number} width
 * @param {string} left
 * @param {string} inner
 * @param {string} right
 * @returns {string}
 */
function borderLine(width, left, inner, right) {
  return `${left}${inner.repeat(Math.max(0, width - 2))}${right}`
}

/**
 * A separator that carries a section title: `├─ lifecycle ────────┤`.
 * @param {number} width
 * @param {string} title
 * @returns {string}
 */
function sectionLine(width, title) {
  const head = `─ ${title} `
  const used = displayWidth(head)
  const fill = Math.max(0, width - 2 - used)
  return `├${head}${'─'.repeat(fill)}┤`
}

/**
 * Render one frame.
 * @param {any} model a dashboard model from `buildDashboardModel`
 * @param {{ width?: number, color?: string, isTty?: boolean, sections?: string[], lang?: string }} [opts]
 * @returns {string}
 */
export function renderFrame(model, opts = {}) {
  const rawWidth = Number(opts.width ?? model?.render?.width ?? 96)
  const width = Math.min(200, Math.max(48, Number.isFinite(rawWidth) ? Math.round(rawWidth) : 96))
  const color = resolveColor(opts.color ?? model?.render?.color ?? 'never', opts.isTty === true)
  const t = terminalText(opts.lang ?? model?.render?.lang)
  /** @param {string} tone @param {string} text */
  const paint = (tone, text) => (color === 'always' && TONES[tone] !== undefined && TONES[tone] !== '' ? `${TONES[tone]}${text}${RESET}` : text)
  const inner = width - 2 // inside the outer borders: '│' + content + '│'
  const check = inner - 2 // usable content width (' ' + content + ' ')

  const wanted = Array.isArray(opts.sections) && opts.sections.length > 0 ? opts.sections : null
  const sections = (model?.sections ?? []).filter((section) => wanted === null || wanted.includes(section?.id))

  // One label column for the whole frame: ragged tables are the difference
  // between a dashboard and a dump.
  let labelWidth = 12
  for (const section of sections) {
    for (const row of section.rows ?? []) labelWidth = Math.max(labelWidth, displayWidth(row?.label ?? ''))
  }
  labelWidth = Math.min(labelWidth, Math.max(12, Math.floor(check * 0.42)))

  const lines = []
  const store = model?.store ?? {}
  const stamp = new Date(Number(model?.generatedAt ?? Date.now())).toISOString().slice(11, 19)
  const headTitle = `${model?.title ?? t.title}`
  const headRight = `v${store.version ?? 0} · ${model?.origin ?? 'live'} · ${stamp}Z`
  // '╭─'(2) + ' '(1) + title + ' '(1) + fill + ' '(1) + right + ' '(1) + '─╮'(2)
  const headFill = Math.max(1, width - 8 - displayWidth(headTitle) - displayWidth(headRight))
  lines.push(`${paint('accent', '╭─')} ${headTitle} ${'─'.repeat(headFill)} ${headRight} ${paint('accent', '─╮')}`)

  /** @param {any} row @returns {void} */
  const pushRow = (row) => {
    const field = Math.max(0, check - labelWidth - 1)
    // Truncate and pad *before* painting: SGR escapes are characters, so a
    // coloured string measured by `padTo` would be padded short by exactly the
    // escape length. Every width assertion in the suite exists because of this.
    const label = padTo(truncateTo(row?.label ?? '', labelWidth), labelWidth)
    const barText = row?.bar === undefined ? '' : bar(Number(row.bar), 12)
    const valueText = barText === '' ? String(row?.value ?? '') : `${barText} ${row?.value ?? ''}`
    const value = padTo(truncateTo(valueText, field), field)
    const painted = barText !== '' && field > barText.length
      ? `${paint('ok', barText)}${value.slice(barText.length)}`
      : value
    lines.push(`│ ${paint(row?.tone ?? 'plain', label)} ${painted} │`)
    const note = String(row?.note ?? '')
    if (note !== '') {
      lines.push(`│ ${' '.repeat(labelWidth + 1)}${paint('dim', padTo(truncateTo(note, field), field))} │`)
    }
  }

  for (const section of sections) {
    lines.push(paint('accent', sectionLine(width, String(section?.title ?? section?.id ?? t.frame.sectionFallback))))
    const rows = section?.rows ?? []
    if (rows.length === 0) lines.push(`│ ${padTo(paint('dim', t.frame.emptySection), check)} │`)
    for (const row of rows) pushRow(row)
  }

  const warnings = model?.warnings ?? []
  if (warnings.length > 0) {
    lines.push(paint('warn', sectionLine(width, t.frame.warnings)))
    for (const warning of warnings) {
      lines.push(`│ ${paint('warn', padTo(truncateTo(warning, check), check))} │`)
    }
  }

  const footer = String(model?.redaction?.note ?? '')
  lines.push(paint('accent', borderLine(width, '╰', '─', '╯')))
  // Outside the frame: provenance is a caption on the picture, not another
  // warning inside it. Truncated to the frame width so a narrow frame never
  // emits a line that wraps under itself.
  if (footer !== '') lines.push(paint('dim', `  ${truncateTo(footer, width - 2)}`))

  return lines.map((line) => (line.length === 0 ? '' : line)).join('\n')
}
