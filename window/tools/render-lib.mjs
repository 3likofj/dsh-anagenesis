/**
 * render-lib —— 把 `src/render/*.js` 那组**无 import/export 的纯函数部件**装进一个
 * 作用域里，供 Node 侧（预览工具与测试）调用。
 *
 * 为什么是这样而不是 ESM 模块：同一批文件要被 `tools/build-client.mjs` **原样拼接**进
 * `client.js` —— 浏览器的 `dsh.client` 包是经典脚本，不能有顶层 import/export。所以
 * 部件按"共享一个作用域的文本"写，浏览器侧靠拼接，Node 侧靠 `new Function`。一份源码，
 * 两个宿主，不存在"预览和窗口渲染得不一样"的可能。
 * @module dsh-anagenesis-window/tools/render-lib
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const RENDER_DIR = resolve(here, '..', 'src', 'render')

/** 渲染层对外暴露的名字（其余是内部实现）。 */
const PUBLIC = [
  'ANA_CSS',
  'esc',
  'clip',
  'chip',
  'legend',
  'notice',
  'emptyState',
  'metricCard',
  'renderDashboardHtml',
  'dashboardLegendHtml',
  'renderDiagramHtml',
  'diagramSummary',
  'graphLegendHtml',
  'renderToolbarHtml',
  'renderTitlebarHtml',
  'renderFooterHtml',
  'renderTextFallbackHtml',
  'wireWindowEvents',
  'clipUnits',
  'textUnits',
  'layoutGraph',
  'renderGraphSvg',
  'wrapLabel',
  'zhKind',
  'zhState',
  'zhEvent',
  'zhRel',
  'zhStrategy',
  'zhFormat',
  'zhRedaction',
  'zhDiagramKind',
  'zhWarning',
  'zhValue',
  'zhTokens',
  'zhLabel',
  'zhAge',
  'zhPercent',
  'toneColor',
  'stateColor',
  'kindColor',
  'relColor',
  'eventColor',
  'evoColor',
  'KIND_ZH',
  'STATE_ZH',
  'DASH_LABEL_ZH',
  'SECTION_ZH',
  'DIAGRAM_KIND_ZH',
]

/** 部件文件名，按前缀排序即为拼接顺序。 */
export function renderPartNames() {
  return readdirSync(RENDER_DIR).filter((name) => name.endsWith('.js')).sort()
}

/** 拼接后的渲染层源码（与 build-client 用的是同一份文件）。 */
export function renderLayerSource() {
  return renderPartNames()
    .map((name) => `/* ── render part: ${name} ── */\n` + readFileSync(join(RENDER_DIR, name), 'utf8'))
    .join('\n')
}

/**
 * 装入并返回公开面。
 * @returns {Record<string, any>}
 */
export function loadRenderLayer() {
  const source = renderLayerSource() + '\nreturn {' + PUBLIC.map((name) => name + ': ' + name).join(', ') + '}'
  const factory = new Function(source)
  return factory()
}

export { RENDER_DIR }