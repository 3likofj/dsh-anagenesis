/**
 * 图表渲染器 —— 渲染层第 5 部分。**这是本次优化的重点。**
 *
 * 之前窗口把 `renderDiagram()` 的 **Mermaid 源码**当正文打印出来，用户看到的是
 * `graph LR` / `classDef` / `#111827` / `ana_mem_0muw…`。现在改成：模型 → 布局 → SVG。
 *
 * 为什么自己写布局与 SVG，而不是用 mermaid：
 *   1. `dsh.client` 的 `require` 是**封闭表**（平台种子 + 显式 external），拿不到
 *      `dsh-better-sidebar` 那个 7MB 的 mermaid chunk；引 CDN 又违反本插件
 *      `offlineMode: true` 的披露；
 *   2. 记忆图谱只需**分层有向图**这一种布局，几十行就能写对，而且能保证中文换行、
 *      颜色语义、悬停提示、节点上限这些本任务明确要求的东西都由自己控制；
 *   3. 纯函数 ⇒ 同一段 SVG 既能进窗口，也能被光栅化成截图来验收。
 *
 * 视觉规则（与 `20-theme.js` 一致）：
 *   - 方框填充/描边 = **类型色**（这是什么）
 *   - 左上角圆点   = **状态色**（现在怎么样）
 *   - 连线颜色     = **关系色**，虚线 = 指向图外的悬空引用
 *   - 悬停显示完整标题、类型、状态、重要度、原始 id（`<title>`，零 JS）
 */

/** 节点框的固定尺寸（单位：SVG 用户单位 = CSS 像素）。 */
const GRAPH_NODE_W = 178
/** 两行标签 + 一行副行：20 / 35 / h-7。h=58 时三行互不重叠。 */
const GRAPH_NODE_H = 58
const GRAPH_COL_GAP = 74
const GRAPH_ROW_GAP = 18
const GRAPH_PAD = 22
/**
 * 一行放得下多少"单位"（CJK 记 2，其余记 1）。
 * 可用宽度 = 178 − 左边距 24 − 右边距 10 = 144px；12px 字号下汉字约 12px，
 * 所以 22 单位（11 个汉字）是安全值。取 25 会让第二行压到副行上 —— 这是
 * 第一版截图上真实发生的重叠，不是理论余量。
 */
const GRAPH_LABEL_UNITS = 22
const GRAPH_LABEL_LINES = 2

/**
 * 中文/ASCII 混排的定宽换行（CJK 记 2 个单位，其余记 1）。
 *
 * 按**词**排，不按字符排：一个汉字是一个词，一段拉丁文（`exports["./client"]`）
 * 也是一个词。第一版按字符硬切，把 `exports` 切成了 `expor` / `ts` —— 中文读者能
 * 接受汉字任意断行，但不会接受英文单词被劈开。
 * @param {unknown} text
 * @param {number} unitsPerLine
 * @param {number} maxLines
 * @returns {string[]}
 */
function wrapLabel(text, unitsPerLine, maxLines) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value === '') return ['（无标题）']
  const tokens = []
  let latin = ''
  for (const char of value) {
    if (isWide(char)) {
      if (latin !== '') {
        tokens.push(latin)
        latin = ''
      }
      tokens.push(char)
    } else if (char === ' ') {
      if (latin !== '') {
        tokens.push(latin)
        latin = ''
      }
      tokens.push(' ')
    } else {
      latin += char
    }
  }
  if (latin !== '') tokens.push(latin)

  /** @type {string[]} */
  const lines = []
  let line = ''
  let used = 0
  let truncated = false
  for (const token of tokens) {
    let piece = token
    while (piece !== '') {
      const width = textUnits(piece)
      if (used + width <= unitsPerLine) {
        line += piece
        used += width
        piece = ''
        continue
      }
      if (line.trim() !== '') {
        if (lines.length === maxLines - 1) {
          // 最后一行：剩下的全部塞进来再截断。
          const room = unitsPerLine - used
          if (room > 1) line += piece.slice(0, Math.max(1, room - 1))
          truncated = true
          break
        }
        lines.push(line.trim())
        line = ''
        used = 0
        continue
      }
      // 单个词比整行还宽 —— 只能硬切。
      const cut = Math.max(1, unitsPerLine - 1)
      line = piece.slice(0, cut)
      used = textUnits(line)
      piece = piece.slice(cut)
      if (lines.length === maxLines - 1) {
        truncated = true
        break
      }
      lines.push(line)
      line = ''
      used = 0
    }
    if (truncated) break
  }
  if (!truncated && line.trim() !== '' && lines.length < maxLines) lines.push(line.trim())
  if (lines.length === 0) return ['（无标题）']
  if (truncated) {
    const last = lines[lines.length - 1] ?? ''
    lines[lines.length - 1] = last.slice(0, Math.max(1, last.length - 1)) + '…'
  }
  return lines
}

/** 全角字符判定（CJK、假名、谚文、全角标点）。 */
function isWide(char) {
  return /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(char)
}

/** 字符串的显示宽度（单位数）。 */
function textUnits(text) {
  let total = 0
  for (const char of String(text ?? '')) total += isWide(char) ? 2 : 1
  return total
}

/**
 * 按**显示宽度**截断（不是按字符数）。
 *
 * 节点副行只有一行位置，可用宽度 = 22 单位。按字符裁 24 会在第 12 个汉字处溢出
 * 框外 —— 第一版生命周期截图上，状态解释就是这样顶出边框的。
 * @param {unknown} text
 * @param {number} units
 * @returns {string}
 */
function clipUnits(text, units) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (textUnits(value) <= units) return value
  let out = ''
  let used = 0
  for (const char of value) {
    const width = isWide(char) ? 2 : 1
    if (used + width > units - 1) break
    out += char
    used += width
  }
  return out + '…'
}

/**
 * 分层有向图布局（最长路径分层 + 两轮重心排序）。
 *
 * 输入是模型里的 `nodes` / `edges`，输出是带绝对坐标的盒子与三次贝塞尔连线。
 * 悬空引用（`exists: false`，指向窗口外的记忆）**保留**并给一个虚线"未在图中"
 * 幽灵节点 —— 一个断掉的引用正是这张图要给人看的东西，丢掉它等于撒谎。
 * @param {any[]} rawNodes
 * @param {any[]} rawEdges
 * @param {{ direction?: 'LR'|'TB', maxNodes?: number }} [opts]
 * @returns {any}
 */
function layoutGraph(rawNodes, rawEdges, opts) {
  const options = opts === undefined || opts === null ? {} : opts
  const direction = options.direction === 'TB' ? 'TB' : 'LR'
  const maxNodes = Math.max(1, Number(options.maxNodes ?? 60))

  const sorted = rawNodes.slice().sort((a, b) => Number(b.salience ?? 0) - Number(a.salience ?? 0))
  const capped = sorted.slice(0, maxNodes)
  const kept = new Set(capped.map((node) => String(node.id)))
  const dropped = rawNodes.length - capped.length

  /** @type {Map<string, any>} */
  const nodes = new Map()
  for (const node of capped) {
    nodes.set(String(node.id), {
      id: String(node.id),
      label: String(node.label ?? ''),
      kind: String(node.kind ?? ''),
      state: String(node.state ?? ''),
      salience: Number(node.salience ?? 0),
      ghost: false,
      // 调用方可以覆盖这三样，让同一个布局引擎服务两种图：
      //   color —— 方框颜色（记忆图用类型色，生命周期图用状态色）
      //   sub   —— 方框底部一行的读法（生命周期图不该显示"重要度"）
      //   title —— 悬停全文
      color: typeof node.color === 'string' && node.color !== '' ? node.color : '',
      sub: typeof node.sub === 'string' && node.sub !== '' ? node.sub : '',
      title: typeof node.title === 'string' && node.title !== '' ? node.title : '',
    })
  }
  /** @type {any[]} */
  const edges = []
  const seen = new Set()
  for (const edge of rawEdges ?? []) {
    const to = String(edge.to ?? '')
    const from = String(edge.from ?? '')
    if (from === '' || to === '' || from === to) continue
    const key = from + '\u0000' + to + '\u0000' + String(edge.rel ?? '')
    if (seen.has(key)) continue
    seen.add(key)
    if (kept.has(from) && !kept.has(to)) {
      const ghostId = 'ghost:' + to
      if (!nodes.has(ghostId)) {
        // 幽灵节点是"这条连线指向的东西不在图里"，不是一条真记忆：给一个中文标题，
        // 原始 id 只留在悬停里。截断到 14 个字符会把英文 id 切在词中间（第一版截图
        // 里就是 `mem-not-in-gra`），所以标题只写"未在图中"，id 归 tooltip。
        nodes.set(ghostId, {
          id: ghostId,
          label: '未在图中',
          kind: '',
          state: '',
          salience: 0,
          ghost: true,
          color: 'dim',
          sub: '指向图外的记忆',
          title: '这条连线指向 ' + to + '\n它不在当前这张图里：可能超出节点上限，也可能已经被删除',
        })
      }
    }
    if (!kept.has(from)) continue
    edges.push({
      from: from,
      to: to,
      rel: String(edge.rel ?? 'related'),
      exists: edge.exists !== false,
      label: edge.label,
      color: edge.color,
    })
  }

  // 边指向的 id 若不在 nodes 里，改指幽灵节点。
  const ids = new Set(nodes.keys())
  for (const edge of edges) if (!ids.has(edge.to)) edge.to = 'ghost:' + edge.to

  // ── 分层：从入度为 0 的根做最长路径，环由迭代上限兜住。 ──────────────────
  /** @type {Map<string, number>} */
  const layer = new Map()
  const incoming = new Map()
  for (const id of nodes.keys()) incoming.set(id, [])
  for (const edge of edges) {
    if (incoming.has(edge.to)) incoming.get(edge.to).push(edge.from)
  }
  const roots = []
  for (const [id, preds] of incoming) if (preds.length === 0) roots.push(id)
  if (roots.length === 0 && nodes.size > 0) roots.push(nodes.keys().next().value)
  for (const id of nodes.keys()) layer.set(id, 0)
  const order = [...nodes.keys()]
  for (let pass = 0; pass < order.length + 2; pass += 1) {
    let changed = false
    for (const edge of edges) {
      if (!layer.has(edge.from) || !layer.has(edge.to)) continue
      const want = layer.get(edge.from) + 1
      if (layer.get(edge.to) < want) {
        layer.set(edge.to, Math.min(want, order.length))
        changed = true
      }
    }
    if (!changed) break
  }

  // ── 层内排序：两轮重心，让连线尽量不交叉。 ────────────────────────────────
  /** @type {Map<number, string[]>} */
  const buckets = new Map()
  for (const [id, index] of layer) {
    if (!buckets.has(index)) buckets.set(index, [])
    buckets.get(index).push(id)
  }
  const layerCount = buckets.size === 0 ? 1 : Math.max(...buckets.keys()) + 1
  for (let index = 0; index < layerCount; index += 1) {
    const bucket = buckets.get(index) ?? []
    bucket.sort((a, b) => Number(nodes.get(b).salience) - Number(nodes.get(a).salience))
    buckets.set(index, bucket)
  }
  for (let pass = 0; pass < 2; pass += 1) {
    for (const bucket of buckets.values()) {
      const position = new Map()
      let cursor = 0
      for (const id of bucket) position.set(id, cursor++)
      const barycenter = (id) => {
        const preds = (incoming.get(id) ?? []).map((pred) => position.get(pred)).filter((value) => value !== undefined)
        if (preds.length === 0) return position.get(id) ?? 0
        return preds.reduce((sum, value) => sum + value, 0) / preds.length
      }
      bucket.sort((a, b) => (barycenter(a) - barycenter(b)) || (position.get(a) - position.get(b)))
    }
  }

  // ── 摆位 ─────────────────────────────────────────────────────────────────
  const columnSpan = direction === 'LR' ? GRAPH_NODE_W + GRAPH_COL_GAP : GRAPH_NODE_H + GRAPH_ROW_GAP
  const rowSpan = direction === 'LR' ? GRAPH_NODE_H + GRAPH_ROW_GAP : GRAPH_NODE_W + GRAPH_COL_GAP
  const tallest = Math.max(1, ...[...buckets.values()].map((bucket) => bucket.length))
  const extent = tallest * rowSpan
  /** @type {any[]} */
  const placed = []
  /** @type {Map<string, any>} */
  const byId = new Map()
  for (let index = 0; index < layerCount; index += 1) {
    const bucket = buckets.get(index) ?? []
    const band = bucket.length * rowSpan
    const offset = (extent - band) / 2
    bucket.forEach((id, position) => {
      const node = nodes.get(id)
      const crossA = GRAPH_PAD + offset + position * rowSpan
      const crossB = GRAPH_PAD + index * columnSpan
      const box = direction === 'LR'
        ? { x: crossB, y: crossA, w: GRAPH_NODE_W, h: GRAPH_NODE_H }
        : { x: crossA, y: crossB, w: GRAPH_NODE_W, h: GRAPH_NODE_H }
      const box2 = { id: id, ...node, ...box }
      placed.push(box2)
      byId.set(id, box2)
    })
  }

  // ── 连线：三次贝塞尔 + 中点标签 + 箭头。 ───────────────────────────────────
  /** @type {any[]} */
  const links = []
  for (const edge of edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (from === undefined || to === undefined) continue
    let p0
    let p3
    let c1
    let c2
    if (direction === 'LR') {
      const forward = to.x >= from.x
      p0 = { x: forward ? from.x + from.w : from.x, y: from.y + from.h / 2 }
      p3 = { x: forward ? to.x : to.x + to.w, y: to.y + to.h / 2 }
      const bend = Math.max(26, Math.abs(p3.x - p0.x) * 0.42)
      c1 = { x: p0.x + (forward ? bend : -bend), y: p0.y }
      c2 = { x: p3.x - (forward ? bend : -bend), y: p3.y }
    } else {
      const forward = to.y >= from.y
      p0 = { x: from.x + from.w / 2, y: forward ? from.y + from.h : from.y }
      p3 = { x: to.x + to.w / 2, y: forward ? to.y : to.y + to.h }
      const bend = Math.max(26, Math.abs(p3.y - p0.y) * 0.42)
      c1 = { x: p0.x, y: p0.y + (forward ? bend : -bend) }
      c2 = { x: p3.x, y: p3.y - (forward ? bend : -bend) }
    }
    const midX = (p0.x + 3 * c1.x + 3 * c2.x + p3.x) / 8
    const midY = (p0.y + 3 * c1.y + 3 * c2.y + p3.y) / 8
    links.push({
      rel: edge.rel,
      from: edge.from,
      to: edge.to,
      exists: edge.exists !== false,
      d: 'M' + p0.x + ',' + p0.y + ' C' + c1.x + ',' + c1.y + ' ' + c2.x + ',' + c2.y + ' ' + p3.x + ',' + p3.y,
      // 调用方可以给现成的标签（生命周期图要的是「×3 次」而不是一个关系名）；
      // 没有就给关系名的中文。空串是**合法的**：那表示这条线不需要标签。
      label: typeof edge.label === 'string' ? edge.label : zhRel(edge.rel),
      relZh: zhRel(edge.rel),
      lx: midX,
      ly: midY,
      color: typeof edge.color === 'string' && edge.color !== '' ? edge.color : relColor(edge.rel),
    })
  }

  const maxX = placed.reduce((max, node) => Math.max(max, node.x + node.w), 0)
  const maxY = placed.reduce((max, node) => Math.max(max, node.y + node.h), 0)
  return {
    direction: direction,
    width: Math.max(320, maxX + GRAPH_PAD + 16),
    height: Math.max(180, maxY + GRAPH_PAD + 16),
    nodes: placed,
    edges: links,
    dropped: dropped,
    capped: dropped > 0,
  }
}

/**
 * 布局 → SVG 字符串。
 * @param {any} layout
 * @returns {string}
 */
function renderGraphSvg(layout) {
  const out = []
  /** 连线提示里用**人看的标签**而不是机器 id —— 生命周期图里 id 就是状态枚举，
   *  直接把 `draft → active` 甩给用户等于把翻译工作推回给用户。机器 id 仍然留在
   *  节点的提示里（排查时要用），但不再出现在关系描述里。 */
  const labelById = new Map()
  for (const node of layout.nodes) labelById.set(node.id, node.label)
  const nameOf = (id) => labelById.get(id) ?? String(id)
  out.push('<defs>')
  for (const color of ['ok', 'bad', 'violet', 'info', 'indigo', 'teal', 'warn', 'accent', 'dim']) {
    out.push('<marker id="ana-arrow-' + color + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
      + '<path d="M0,0 L10,5 L0,10 z" fill="' + esc(evoColor(color)) + '"></path></marker>')
  }
  out.push('</defs>')

  for (const edge of layout.edges) {
    const dash = edge.exists ? '' : ' ana-edge--dangling'
    const describe = edge.relZh === edge.label
      ? edge.relZh + '：' + nameOf(edge.from) + ' → ' + nameOf(edge.to)
      : nameOf(edge.from) + ' → ' + nameOf(edge.to) + '：' + edge.label
    out.push('<path class="ana-edge' + dash + '" d="' + edge.d + '" stroke="' + esc(evoColor(edge.color))
      + '" marker-end="url(#ana-arrow-' + edge.color + ')"'
      + (edge.exists ? '' : ' stroke-opacity="0.8"')
      + '><title>' + esc(describe + (edge.exists ? '' : '（目标不在图中）')) + '</title></path>')
    // 关系标签压在连线与节点上会读不清：垫一块同背景色的圆角底，再把文字放上去。
    // 空标签直接跳过 —— 生命周期图不需要在每条迁移线上写一遍"相关"。
    if (edge.label !== '') {
      const labelWidth = textUnits(edge.label) * 6 + 12
      out.push('<rect class="ana-elabel-bg" x="' + (edge.lx - labelWidth / 2).toFixed(1) + '" y="' + (edge.ly - 13).toFixed(1)
        + '" width="' + labelWidth.toFixed(1) + '" height="16" rx="4"></rect>')
      out.push('<text class="ana-elabel" x="' + edge.lx.toFixed(1) + '" y="' + (edge.ly - 1).toFixed(1)
        + '" text-anchor="middle" fill="' + esc(evoColor(edge.color)) + '">' + esc(edge.label) + '</text>')
    }
  }

  for (const node of layout.nodes) {
    const semantic = node.color !== '' ? node.color : kindColor(node.kind)
    const fill = node.ghost ? 'none' : evoColor(semantic)
    const stroke = node.ghost ? evoColor('dim') : evoColor(semantic)
    const lines = wrapLabel(node.label, GRAPH_LABEL_UNITS, GRAPH_LABEL_LINES)
    const title = node.title !== ''
      ? node.title
      : node.ghost
        ? node.label + ' —— 这条连线指向一条不在当前图中的记忆（超出节点上限或已删除）'
        : node.label + '\n类型：' + zhKind(node.kind) + '　状态：' + zhState(node.state)
          + '\n重要度：' + Number(node.salience ?? 0).toFixed(2) + '　原始 id：' + node.id
    out.push('<g class="ana-node">')
    out.push('<title>' + esc(title) + '</title>')
    out.push('<rect class="ana-node-box" x="' + node.x + '" y="' + node.y + '" width="' + node.w + '" height="' + node.h
      + '" rx="9" fill="' + esc(fill) + '" fill-opacity="' + (node.ghost ? '0' : '0.14') + '" stroke="' + esc(stroke)
      + '"' + (node.ghost ? ' stroke-dasharray="5 4"' : '') + '></rect>')
    if (!node.ghost && node.state !== '') {
      out.push('<circle class="ana-dot" cx="' + (node.x + 12) + '" cy="' + (node.y + 12) + '" r="4.5" fill="'
        + esc(evoColor(stateColor(node.state))) + '"><title>' + esc(zhState(node.state) + ' —— ' + zhStateHint(node.state)) + '</title></circle>')
    }
    lines.forEach((line, index) => {
      out.push('<text class="ana-node-label" x="' + (node.x + 24) + '" y="' + (node.y + 20 + index * 15)
        + '">' + esc(line) + '</text>')
    })
    const sub = node.sub !== ''
      ? node.sub
      : node.ghost
        ? '悬空引用'
        : zhKind(node.kind) + ' · ' + zhState(node.state) + ' · ' + Number(node.salience ?? 0).toFixed(2)
    out.push('<text class="ana-node-sub" x="' + (node.x + 24) + '" y="' + (node.y + node.h - 7) + '">' + esc(clipUnits(sub, GRAPH_LABEL_UNITS)) + '</text>')
    out.push('</g>')
  }

  return '<svg class="ana-svg" width="' + layout.width + '" height="' + layout.height
    + '" viewBox="0 0 ' + layout.width + ' ' + layout.height + '" role="img" aria-label="记忆关系图">'
    + out.join('') + '</svg>'
}

/** 节点/连线的图例。 */
function graphLegendHtml() {
  return legend([
    { title: '节点颜色（类型）', items: ['constraint', 'failure', 'hypothesis', 'fact', 'procedure', 'preference', 'heuristic'].map((kind) => ({
      color: kindColor(kind), text: zhKind(kind),
    })) },
    { title: '左上圆点（状态）', items: ['active', 'verified', 'locked', 'draft', 'expired'].map((state) => ({
      color: stateColor(state), text: zhState(state), hint: zhStateHint(state),
    })) },
    { title: '连线（关系）', items: ['supports', 'contradicts', 'supersedes', 'related'].map((rel) => ({
      color: relColor(rel), text: zhRel(rel),
    })) },
  ])
}

/**
 * 记忆关系图。
 * @param {any} model
 * @param {{ direction?: string, maxNodes?: number, zoom?: number }} [opts]
 * @returns {string}
 */
function renderMemoryGraphHtml(model, opts) {
  const options = opts === undefined || opts === null ? {} : opts
  const nodes = Array.isArray(model.nodes) ? model.nodes : []
  const edges = Array.isArray(model.edges) ? model.edges : []
  const out = []
  if (nodes.length === 0) {
    return emptyState('还没有可画的关系', '记忆之间还没有建立 links；用 ana_link 连起来之后再回来看')
  }
  const layout = layoutGraph(nodes, edges, { direction: options.direction, maxNodes: options.maxNodes })
  if (layout.capped) {
    out.push(notice('记忆较多，这里只画了重要度最高的 ' + layout.nodes.filter((node) => !node.ghost).length + ' 个节点；把工具栏的「节点上限」调大可以看到更多', 'info'))
  }
  if (edges.length === 0) {
    out.push(notice('这些记忆之间还没有任何关联 —— 现在看到的是孤立节点。用 ana_link 建立关系后，图会连起来', 'info'))
  }
  const zoom = Math.max(0.4, Math.min(2.5, Number(options.zoom ?? 1)))
  out.push('<div class="ana-graph"><div class="ana-graph-inner" style="transform:scale(' + zoom.toFixed(2) + ')">'
    + renderGraphSvg(layout) + '</div></div>')
  return out.join('')
}

/** 生命周期状态的固定展示顺序（`STATES` 的语义顺序，不是字母序）。 */
const LIFECYCLE_ORDER = Object.freeze(['draft', 'active', 'verified', 'locked', 'deprecated', 'expired', 'retired'])

/**
 * 生命周期流转图：节点是状态，连线是**日志里真实观测到**的迁移次数。
 * `from: null` 的迁移来自只记录目的态的操作（lock / expire / sweep），画成一条
 * 从虚线"操作"节点进入状态的箭头，而不是编一个来源。
 * @param {any} model
 * @param {{ direction?: string, zoom?: number }} [opts]
 * @returns {string}
 */
function renderLifecycleHtml(model, opts) {
  const options = opts === undefined || opts === null ? {} : opts
  const transitions = Array.isArray(model.transitions) ? model.transitions : []
  if (transitions.length === 0) {
    return emptyState('还没有观测到状态迁移', '日志里还没有 promote / demote / lock / expire 记录')
  }
  const counts = model.totals?.byState ?? {}
  const opNames = [...new Set(transitions.filter((row) => row.from === null || row.from === undefined).map((row) => String(row.op ?? 'memory.lock')))]
  /** @type {any[]} */
  const nodes = LIFECYCLE_ORDER.map((state) => ({
    id: state,
    label: zhState(state),
    kind: '',
    state: '',
    salience: Number(counts[state] ?? 0),
    // 生命周期图里"类型"没有意义：方框按**状态**上色，副行写状态解释，
    // 悬停给"日志里出现过多少条"，而不是把它伪装成一条记忆。
    color: stateColor(state),
    sub: zhStateHint(state),
    // 不把原始枚举（`draft` 之类）写进提示：中文名已经无歧义，机器名属于
// `ana_audit`，不属于给人看的界面。记忆节点的提示里保留 `原始 id`，
// 那是因为用户可能要拿它去查审计 —— 这里有取舍，不是随手加的。
    title: zhState(state) + '\n' + zhStateHint(state) + '\n当前处于该状态的记忆：' + zhCount(counts[state] ?? 0) + ' 条',
  }))
  for (const op of opNames) {
    nodes.push({
      id: 'op:' + op,
      label: zhOp(op),
      kind: '',
      state: '',
      salience: 0,
      ghost: true,
      color: 'dim',
      sub: '只记录目的态的操作',
      title: zhOp(op) + '：这类操作在日志里只写了到达的状态，没有写从哪里来\n'
        + '所以这里画成一条从"操作"进入状态的虚线箭头 —— 不编造一个来源',
    })
  }
  /** @type {any[]} */
  const edges = []
  for (const row of transitions) {
    const from = row.from === null || row.from === undefined ? 'op:' + String(row.op ?? 'memory.lock') : String(row.from)
    const count = Number(row.count ?? 0)
    edges.push({
      from: from,
      to: String(row.to),
      rel: 'related',
      exists: true,
      // 生命周期图里"相关"是个没有信息量的关系名：这里要的是次数。
      // 线的颜色按**目标状态**上色，读者一眼就知道"多少条流进了已过期"。
      label: '×' + zhCount(count),
      color: stateColor(String(row.to)),
      count: count,
    })
  }
  const layout = layoutGraph(nodes, edges, { direction: options.direction, maxNodes: 40 })
  const zoom = Math.max(0.4, Math.min(2.5, Number(options.zoom ?? 1)))
  return '<div class="ana-graph"><div class="ana-graph-inner" style="transform:scale(' + zoom.toFixed(2) + ')">'
    + renderGraphSvg(layout) + '</div></div>'
    + legend([{ title: '状态（方框与连线）', items: LIFECYCLE_ORDER.map((state) => ({ color: stateColor(state), text: zhState(state), hint: zhStateHint(state) })) }])
}

/**
 * 策略时间线：垂直时间轴，每条是一个治理事件。
 * @param {any} model
 * @returns {string}
 */
function renderTimelineHtml(model) {
  const timeline = Array.isArray(model.timeline) ? model.timeline : []
  if (timeline.length === 0) {
    return emptyState('还没有治理事件', '日志里还没有策略切换、自调节或回滚记录')
  }
  const now = Number(model.generatedAt ?? Date.now())
  const items = timeline.map((row) => {
    const color = eventColor(row.type)
    const age = Number(row.at) > 0 ? zhAge(now - Number(row.at)) : '时间未知'
    return '<div class="ana-tl-item" style="--ana-c:' + esc(evoColor(color)) + '">'
      + '<div class="ana-tl-dot"></div>'
      + '<div class="ana-tl-main"><div class="ana-tl-head">'
      + '<span class="ana-tl-type">' + esc(zhEvent(row.type)) + '</span>'
      + chip('dim', '#' + zhCount(row.seq))
      + '<span class="ana-tl-meta">' + esc(age) + '</span>'
      + '</div>'
      + (String(row.detail ?? '') === '' ? '' : '<div class="ana-tl-detail">' + esc(zhTokens(row.detail)) + '</div>')
      + '</div></div>'
  })
  return '<div class="ana-tl">' + items.join('') + '</div>'
    + legend([{ title: '事件', items: ['strategy.setStack', 'meta.tune', 'memory.promote', 'revert', 'memory.expire'].map((type) => ({
      color: eventColor(type), text: zhEvent(type),
    })) }])
}

/**
 * 图表总入口：按模型 kind 分发。
 * @param {any} model `buildDiagramModel()` 的产物
 * @param {{ direction?: string, maxNodes?: number, zoom?: number }} [opts]
 * @returns {string} HTML（图的部分是内联 SVG）
 */
function renderDiagramHtml(model, opts) {
  const options = opts === undefined || opts === null ? {} : opts
  const kind = String(model?.kind ?? 'memory-graph')
  const warnings = Array.isArray(model?.warnings) ? model.warnings : []
  const head = warnings.length === 0 ? '' : notice(warnings.map(zhWarning).join('；'), 'info')
  if (kind === 'memory-graph') return head + renderMemoryGraphHtml(model, options)
  if (kind === 'lifecycle') return head + renderLifecycleHtml(model, options)
  return head + renderTimelineHtml(model)
}

/**
 * 图表页脚的一条统计摘要（节点数、连线数、数据来源）。
 * @param {any} model
 * @returns {string}
 */
function diagramSummary(model) {
  const kind = String(model?.kind ?? '')
  const parts = []
  parts.push('数据来源：' + zhOrigin(model?.origin))
  if (kind === 'memory-graph') {
    parts.push('节点 ' + zhCount((model?.nodes ?? []).length) + ' 个')
    parts.push('连线 ' + zhCount((model?.edges ?? []).length) + ' 条')
  } else if (kind === 'lifecycle') {
    const transitions = model?.transitions ?? []
    parts.push('迁移 ' + zhCount(transitions.length) + ' 种')
    parts.push('合计 ' + zhCount(transitions.reduce((sum, row) => sum + Number(row.count ?? 0), 0)) + ' 次')
  } else {
    parts.push('事件 ' + zhCount((model?.timeline ?? []).length) + ' 条')
  }
  parts.push('存储版本 v' + zhCount(model?.store?.version))
  return parts.join('　·　')
}