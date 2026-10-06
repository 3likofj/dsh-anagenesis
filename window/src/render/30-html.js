/**
 * 字符串组装与转义 —— 渲染层第 3 部分。
 *
 * 渲染器产出 **HTML 字符串**（图的部分是内联 SVG），窗口用
 * `dangerouslySetInnerHTML` 注入，离线预览直接写进文件。这么做的两个理由：
 *   1. **可验证** —— 同一段字符串既能进 DOM，也能被光栅化成截图，我在预览里看到的
 *      像素就是窗口里的像素；
 *   2. **无依赖** —— 不需要 mermaid（7MB，且 `dsh.client` 的 require 是封闭表，
 *      拿不到别人的 chunk），不需要 react-dom 之外的任何渲染器。
 *
 * 代价是每一条来自 store 的文本都必须手动转义 —— 所以渲染器里**不允许**出现裸的
 * 字符串插值，一律走 `esc()` / `chip()` / `row()` 这些构造器。
 */

/**
 * HTML 转义（含属性上下文要用的引号）。
 * @param {unknown} value
 * @returns {string}
 */
function esc(value) {
  if (value === undefined || value === null) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 把值截断到 `max` 个字符并补省略号。中文按字符数算即可，不做终端宽度对齐 ——
 * 这里是 HTML，换行交给浏览器。
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return text.slice(0, Math.max(1, max - 1)) + '…'
}

/**
 * 一段带悬停提示的 HTML。
 * @param {string} tag
 * @param {Record<string, unknown>} attributes
 * @param {string} [inner]
 */
function tag(tagName, attributes, inner) {
  let out = '<' + tagName
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null || value === false) continue
    out += ' ' + key + '="' + esc(value === true ? '' : value) + '"'
  }
  if (inner === undefined) return out + '>'
  return out + '>' + inner + '</' + tagName + '>'
}

/**
 * 语义色块（图例与徽标共用的原子）。
 * @param {string} color 语义色名（`ok` / `bad` / …）
 * @param {string} text
 * @param {string} [hint] 悬停解释
 * @returns {string}
 */
function chip(color, text, hint) {
  const title = hint === undefined || hint === '' ? text : text + ' —— ' + hint
  return '<span class="ana-chip ana-c-' + esc(color) + '" title="' + esc(title) + '">' + esc(text) + '</span>'
}

/** 无圆点的纯色标签。 */
function dot(color, hint) {
  return '<span class="ana-legend-swatch ana-c-' + esc(color) + '" title="' + esc(hint ?? '') + '"></span>'
}

/**
 * 一条 `标签 / 值` 行，可带语义色与副行。
 * @param {{ label: string, value: string, color?: string, hint?: string, note?: string }} row
 * @returns {string}
 */
function row(row) {
  const color = row.color === undefined ? 'plain' : row.color
  const hint = row.hint === undefined ? '' : row.hint
  const title = hint === '' ? '' : ' title="' + esc(hint) + '"'
  let out = '<div class="ana-row ana-tone-' + esc(color) + '">'
    + '<div class="ana-row-label"' + title + '>' + esc(row.label) + '</div>'
    + '<div class="ana-row-value">' + esc(row.value) + '</div>'
    + '<div></div>'
  if (row.note !== undefined && row.note !== '') out += '<div class="ana-row-note">' + esc(row.note) + '</div>'
  return out + '</div>'
}

/**
 * 一条带进度条的行（生命周期/类型分布用）。
 * @param {{ label: string, color: string, ratio: number, count: string, percent: string, hint?: string }} spec
 * @returns {string}
 */
function barRow(spec) {
  const width = Math.max(0, Math.min(1, Number(spec.ratio) || 0)) * 100
  const title = spec.hint === undefined || spec.hint === '' ? spec.label : spec.label + ' —— ' + spec.hint
  return '<div class="ana-pbar-cell" title="' + esc(title) + '">'
    + '<div class="ana-row-label">' + esc(spec.label) + '</div>'
    + '<div class="ana-pbar ana-pbar--' + esc(spec.color) + '"><div class="ana-pbar-fill" style="width:' + width.toFixed(1) + '%"></div></div>'
    + '<div class="ana-num">' + esc(spec.count) + (spec.percent === '' ? '' : '<span class="ana-pbar-pct"> ' + esc(spec.percent) + '</span>') + '</div>'
    + '</div>'
}

/**
 * 一个分区卡片。
 * @param {string} title
 * @param {string} hint
 * @param {string} body
 * @returns {string}
 */
function section(title, hint, body) {
  return '<section class="ana-sect"><div class="ana-sect-head">'
    + '<span class="ana-sect-title">' + esc(title) + '</span>'
    + (hint === '' ? '' : '<span class="ana-sect-hint">' + esc(hint) + '</span>')
    + '</div><div class="ana-sect-body">' + body + '</div></section>'
}

/**
 * 关键指标卡。`hot` 用于"必须一眼看到"的状态（如安全模式开启）。
 * @param {{ label: string, value: string, unit?: string, sub?: string, tone?: string, hot?: boolean, hint?: string }} card
 * @returns {string}
 */
function metricCard(card) {
  const tone = card.tone === undefined ? 'accent' : card.tone
  const hot = card.hot === true ? ' ana-card--hot' : ''
  return '<div class="ana-card ana-card--' + esc(tone) + hot + '" title="' + esc(card.hint ?? '') + '">'
    + '<div class="ana-card-label">' + esc(card.label) + '</div>'
    + '<div class="ana-card-value">' + esc(card.value)
    + (card.unit === undefined ? '' : '<small>' + esc(card.unit) + '</small>') + '</div>'
    + (card.sub === undefined ? '' : '<div class="ana-card-sub">' + esc(card.sub) + '</div>')
    + '</div>'
}

/** @param {string} text @param {'info'|'warn'|'bad'} [kind] */
function notice(text, kind) {
  const modifier = kind === undefined || kind === 'warn' ? '' : ' ana-notice--' + kind
  return '<div class="ana-notice' + modifier + '">' + esc(text) + '</div>'
}

/** @param {string} title @param {string} body */
function emptyState(title, body) {
  return '<div class="ana-empty"><div class="ana-empty-title">' + esc(title) + '</div><div>' + esc(body) + '</div></div>'
}

/**
 * 图例：把这一屏用到的颜色语义讲清楚。**没有图例的颜色编码等于没有编码。**
 * @param {{ title: string, items: { color: string, text: string, hint?: string }[] }[]} groups
 * @returns {string}
 */
function legend(groups) {
  let out = '<div class="ana-legend">'
  for (const group of groups) {
    out += '<span class="ana-legend-title">' + esc(group.title) + '</span>'
    for (const item of group.items) {
      out += '<span class="ana-legend-item">' + dot(item.color, item.hint) + esc(item.text) + '</span>'
    }
  }
  return out + '</div>'
}