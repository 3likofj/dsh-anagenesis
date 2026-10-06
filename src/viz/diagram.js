/**
 * Text-as-diagram serializers: one model, four surfaces.
 *
 * Mermaid is the default because it renders in the Markdown a DSH agent already
 * writes; D2 is the alternative for people who use it; ASCII is the always-there
 * fallback that works in any terminal, log file or diff. All three consume the
 * same model as the TUI, so a new diagram kind is one builder plus (at most)
 * three small serializers — and nothing here touches the store.
 *
 * **Language boundary.** Text that ends up *rendered* (the empty-state marks, the
 * ASCII headers) comes from `./lang.js`, keyed off `model.render.lang`. Source
 * comments — mermaid's `%%`, D2's `#` — stay English on purpose: they are code
 * for a renderer, not copy for a reader. Node/edge text is store data.
 * @module dsh-anagenesis/viz/diagram
 */

import { STATES, TRANSITIONS } from '../store/schema.js'
import { ARTIFACT_VERSION, artifactMeta, wrapArtifact } from './artifact.js'
import { terminalText } from './lang.js'
import { padTo } from './tui.js'

export const DIAGRAM_FORMATS = Object.freeze(['mermaid', 'd2', 'ascii'])

/** Mermaid wants an id that cannot collide with its keywords. */
const NODE_PREFIX = 'ana_'

/**
 * @param {unknown} text
 * @param {number} [width]
 * @returns {string}
 */
function oneLine(text, width = 72) {
  const value = String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/["`]/g, "'")
    .replace(/[[\]{}()|]/g, '')
    .replace(/:/g, '·')
    .trim()
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`
}

/**
 * @param {string} id
 * @returns {string}
 */
function nodeId(id) {
  return `${NODE_PREFIX}${String(id).replace(/[^A-Za-z0-9_]/g, '_')}`
}

/**
 * @param {any} model
 * @param {{ format?: string, embed?: boolean, redactionNote?: string }} [opts]
 * @returns {{ text: string, source: string, format: string, kind: string, version: number, meta: Record<string, string|number> }}
 */
export function renderDiagram(model, opts = {}) {
  const format = DIAGRAM_FORMATS.includes(String(opts.format)) ? String(opts.format) : 'mermaid'
  const kind = String(model?.kind ?? 'memory-graph')
  const source = format === 'd2' ? renderD2(model) : format === 'ascii' ? renderAscii(model) : renderMermaid(model)
  const meta = artifactMeta(model, format)
  const text = opts.embed === false ? source : wrapArtifact(meta, source, { lang: format === 'ascii' ? '' : format })
  return { text, source, format, kind, version: ARTIFACT_VERSION, meta }
}

/**
 * @param {any} model
 * @returns {string}
 */
export function renderMermaid(model) {
  if (model?.kind === 'strategy-timeline') return mermaidTimeline(model)
  if (model?.kind === 'lifecycle') return mermaidLifecycle(model)
  return mermaidMemoryGraph(model)
}

/** @param {any} model @returns {string} */
function mermaidMemoryGraph(model) {
  const t = terminalText(model?.render?.lang)
  const lines = ['graph LR']
  // One class per state, with the two states that carry meaning in exploit mode
  // overridden once — a duplicate classDef would be legal but reads like a bug.
  for (const state of STATES) {
    if (state === 'locked' || state === 'verified') continue
    lines.push(`  classDef s_${state} fill:#111827,stroke:#6b7280,color:#e5e7eb`)
  }
  lines.push('  classDef s_locked fill:#4c1d95,stroke:#a78bfa,color:#fff')
  lines.push('  classDef s_verified fill:#064e3b,stroke:#34d399,color:#ecfdf5')
  lines.push('  classDef dangling stroke-dasharray:4 2')
  const nodes = model?.nodes ?? []
  const known = new Set(nodes.map((node) => String(node.id)))
  for (const node of nodes) {
    lines.push(`  ${nodeId(node.id)}["${oneLine(`[${node.kind}] ${node.label}`, 60)}"]:::s_${String(node.state).replace(/[^a-z]/g, '')}`)
  }
  for (const edge of model?.edges ?? []) {
    const to = nodeId(edge.to)
    if (!known.has(String(edge.to))) {
      lines.push(`  ${to}(["[missing] ${oneLine(edge.to, 24)}"]):::dangling`)
    }
    lines.push(`  ${nodeId(edge.from)} -->|${oneLine(edge.rel, 20)}| ${to}`)
  }
  if (nodes.length === 0) lines.push(`  empty["${t.diagram.noMemories}"]:::dangling`)
  return lines.join('\n')
}

/** @param {any} model @returns {string} */
function mermaidTimeline(model) {
  const t = terminalText(model?.render?.lang)
  const lines = ['timeline', `    title ${oneLine(model?.title ?? 'anagenesis timeline', 60)}`, `    section journal v${model?.store?.version ?? 0}`]
  const rows = model?.timeline ?? []
  if (rows.length === 0) lines.push(`        ${t.diagram.noGovernance} : —`)
  for (const row of rows) lines.push(`        #${row.seq} : ${oneLine(`${row.type} ${row.detail ?? ''}`, 56)}`)
  return lines.join('\n')
}

/** @param {any} model @returns {string} */
function mermaidLifecycle(model) {
  const lines = ['stateDiagram-v2', '    direction LR']
  const observed = model?.transitions ?? []
  if (observed.length === 0) {
    // Nothing observed: draw the *declared* machine so the picture is still
    // true, and say in a comment that the counts are absent.
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const to of targets) lines.push(`    ${from} --> ${to}`)
    }
    lines.push('    %% no lifecycle transitions in the journal window; edges are the declared machine, not observed counts')
    return lines.join('\n')
  }
  for (const row of observed) {
    // `from: null` means the journal recorded the destination but not the source
    // (`lock`/`expire`/`sweep`): draw it as an entry into the state, not as an
    // edge from a state nobody observed.
    if (row.from === null) lines.push(`    [*] --> ${row.to} : ${String(row.op ?? 'op').replace('memory.', '')} ×${row.count}`)
    else lines.push(`    ${row.from} --> ${row.to} : ${row.count}`)
  }
  const counts = model?.totals?.byState ?? {}
  lines.push(`    %% current: ${STATES.map((state) => `${state}=${counts[state] ?? 0}`).join(' ')}`)
  return lines.join('\n')
}

/**
 * @param {any} model
 * @returns {string}
 */
export function renderD2(model) {
  const t = terminalText(model?.render?.lang)
  const lines = [`# ${oneLine(model?.title ?? 'anagenesis diagram', 70)}`, `# store v${model?.store?.version ?? 0} · origin ${model?.origin ?? 'live'} · ${model?.redaction?.level ?? 'secrets'}`, '']
  if (model?.kind === 'lifecycle') {
    const observed = model?.transitions ?? []
    if (observed.length === 0) {
      lines.push('# no observed transitions; declared machine:')
      for (const [from, targets] of Object.entries(TRANSITIONS)) for (const to of targets) lines.push(`${from} -> ${to}`)
    } else {
      for (const row of observed) {
        if (row.from === null) lines.push(`[*] -> ${row.to}: ${String(row.op ?? 'op').replace('memory.', '')} ×${row.count}`)
        else lines.push(`${row.from} -> ${row.to}: ${row.count}`)
      }
    }
    return lines.join('\n')
  }
  if (model?.kind === 'strategy-timeline') {
    const rows = model?.timeline ?? []
    lines.push('timeline: {')
    rows.forEach((row, index) => {
      lines.push(`  t${index}: "#${row.seq} ${oneLine(`${row.type} ${row.detail ?? ''}`, 50)}"`)
    })
    lines.push('}')
    for (let index = 1; index < rows.length; index++) lines.push(`t${index - 1} -> t${index}`)
    return lines.join('\n')
  }
  for (const node of model?.nodes ?? []) {
    lines.push(`${nodeId(node.id)}: "${oneLine(`[${node.kind}] ${node.label}`, 60)}"`)
  }
  if ((model?.nodes ?? []).length === 0) lines.push(`empty: "${t.diagram.noMemories}"`)
  for (const edge of model?.edges ?? []) {
    lines.push(`${nodeId(edge.from)} -> ${nodeId(edge.to)}: ${oneLine(edge.rel, 24)}`)
  }
  return lines.join('\n')
}

/**
 * @param {any} model
 * @returns {string}
 */
export function renderAscii(model) {
  const t = terminalText(model?.render?.lang)
  if (model?.kind === 'strategy-timeline') {
    const rows = model?.timeline ?? []
    const lines = [t.diagram.asciiTimeline(rows.length)]
    for (const row of rows) lines.push(`  #${String(row.seq).padStart(4)}  ${oneLine(row.type, 22).padEnd(22)}  ${oneLine(row.detail ?? '', 40)}`)
    if (rows.length === 0) lines.push(t.diagram.asciiNothing)
    return lines.join('\n')
  }
  if (model?.kind === 'lifecycle') {
    const observed = model?.transitions ?? []
    const counts = model?.totals?.byState ?? {}
    const lines = [t.diagram.asciiLifecycle, observed.length === 0 ? t.diagram.asciiLifecycleNone : '']
    for (const row of observed) {
      const from = row.from === null ? t.diagram.asciiUnrecorded : row.from
      const op = row.from === null ? ` (${String(row.op ?? 'op')})` : ''
      lines.push(`  ${padTo(from, 11)} -> ${padTo(row.to, 11)} ${row.count}${op}`)
    }
    lines.push(t.diagram.asciiCurrent(STATES.map((state) => `${state}=${counts[state] ?? 0}`).join(' ')))
    return lines.filter((line) => line !== '').join('\n')
  }
  const nodes = model?.nodes ?? []
  const byId = new Map(nodes.map((node) => [String(node.id), node]))
  const lines = [t.diagram.asciiGraph(nodes.length, (model?.edges ?? []).length)]
  for (const node of nodes) {
    lines.push(`  [${node.state}] ${oneLine(node.label, 52)}  ${Number(node.salience).toFixed(2)}`)
    for (const edge of (model?.edges ?? []).filter((row) => String(row.from) === String(node.id))) {
      const target = byId.get(String(edge.to))
      lines.push(`      └─ ${oneLine(edge.rel, 14).padEnd(14)} -> ${target === undefined ? `${t.diagram.asciiOutside} ${oneLine(edge.to, 20)}` : oneLine(target.label, 40)}`)
    }
  }
  if (nodes.length === 0) lines.push(`  ${t.diagram.noMemories}`)
  return lines.join('\n')
}
