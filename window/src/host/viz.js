/**
 * The window's only data path: a **read-only** projection of the anagenesis store.
 *
 * Everything the desktop window shows is produced here, by exactly the same pure
 * functions the `ana_dashboard` / `ana_diagram` tools and the standalone TUI use
 * (`dsh-anagenesis/viz/model.js` → `tui.js` / `diagram.js`). Three consequences,
 * all deliberate:
 *
 *   1. **One renderer.** The window is a second *surface* for one model, never a
 *      second implementation of it. A frame in the window and a frame in a tool
 *      answer are byte-identical for the same inputs.
 *   2. **Never a writer.** `readStoreMirror()` takes no `MemoryStore` handle and
 *      therefore no place in the single-writer pool; it replays `snapshot.json`,
 *      the journal segments and the newest checkpoint. The window cannot change
 *      the store's version, so a render is not a transaction and has no inverse
 *      to roll back.
 *   3. **Redaction before transport.** The redaction level is applied while the
 *      model is built, so the scrubbed text is what crosses the wire. The client
 *      half never receives unredacted store content.
 *
 * `loadVizLayer()` resolves the sibling package twice on purpose: the bare
 * specifier is the installed form (`dsh-anagenesis` linked or installed as a
 * dependency), the relative path is the in-repository form this checkout ships
 * (`window/` lives inside the `dsh-anagenesis` repository). Both are the same
 * code; the fallback exists so the package works before it is published.
 * @module dsh-anagenesis-window/host/viz
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The viz entry points the window consumes, in one shape whatever resolved. */
let viz = null

/**
 * Resolve `dsh-anagenesis`'s visualization layer.
 * @returns {Promise<any>}
 */
export async function loadVizLayer() {
  if (viz !== null) return viz
  const parts = ['model', 'tui', 'diagram', 'redact', 'mirror']
  let bags = []
  let resolvedBy = 'package'
  try {
    for (const part of parts) bags.push(await import(`dsh-anagenesis/viz/${part}`))
  } catch {
    resolvedBy = 'relative'
    bags = []
    for (const part of parts) bags.push(await import(`../../../src/viz/${part}.js`))
  }
  const [model, tui, diagram, redact, mirror] = bags
  viz = {
    resolvedBy,
    DASHBOARD_SECTIONS: model.DASHBOARD_SECTIONS,
    DIAGRAM_KINDS: model.DIAGRAM_KINDS,
    buildDashboardModel: model.buildDashboardModel,
    buildDiagramModel: model.buildDiagramModel,
    renderFrame: tui.renderFrame,
    DIAGRAM_FORMATS: diagram.DIAGRAM_FORMATS,
    renderDiagram: diagram.renderDiagram,
    REDACTION_LEVELS: redact.REDACTION_LEVELS,
    DEFAULT_REDACTION: redact.DEFAULT_REDACTION,
    looksLikeStore: mirror.looksLikeStore,
    readStoreMirror: mirror.readStoreMirror,
  }
  return viz
}

/**
 * 存储位置的解析来自**核心包**的 `paths` 子路径（无宿主依赖），而不是在这里
 * 另算一遍。
 *
 * 为什么必须共用：窗口是**独立读取**存储的。如果它自己算 `$DSH_HOME/anagenesis`，
 * 而核心因为兼容回退在用 `$DSH_HOME/evolution`，用户就会看到"核心记得住、窗口
 * 显示 0 条记忆"。真机上确实出现过这个分叉 —— 同一个位置只有一个所有者。
 * @type {{ resolveRootDir: (configured?: string) => { rootDir: string, source: string }, defaultRootDir: () => string } | null}
 */
let paths = null

/**
 * @returns {Promise<any>}
 */
async function loadPaths() {
  if (paths !== null) return paths
  try {
    paths = await import('dsh-anagenesis/paths')
  } catch {
    paths = await import('../../../src/paths.js')
  }
  return paths
}

/**
 * The store directory the core row writes by default.
 *
 * 保留 `env` 形参是为了测试能注入一个假的 `DSH_HOME`；没有它时走核心那一套
 * 回退链（见 `resolveRootDir`），这样窗口与核心永远指向同一个存储。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function defaultRoot(env = process.env) {
  const home = env.DSH_HOME !== undefined && String(env.DSH_HOME).trim() !== ''
    ? String(env.DSH_HOME)
    : join(homedir(), '.dsh')
  return join(home, 'anagenesis')
}

/**
 * 实际要读的存储根：显式配置优先，否则与核心同一套回退链。
 * @param {string} configured
 * @returns {Promise<{ rootDir: string, source: string }>}
 */
export async function resolveStoreRoot(configured) {
  const module = await loadPaths()
  return module.resolveRootDir(configured)
}

/**
 * Lossless-JSON sanitizer.
 *
 * The host validates JSON on several seams and one `undefined` anywhere in a
 * payload fails the whole call (HANDOFF §10.18) — an "intended to delete this
 * key" is not a thing. This drops `undefined`/functions/symbols, turns
 * non-finite numbers into `null`, and refuses cycles by path rather than by
 * value so a shared sub-object is still copied rather than silently dropped.
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {any}
 */
export function jsonSafe(value, seen = new WeakSet()) {
  if (value === undefined || value === null) return null
  const kind = typeof value
  if (kind === 'number') return Number.isFinite(value) ? value : null
  if (kind === 'string' || kind === 'boolean') return value
  if (kind === 'bigint') return Number(value)
  if (kind === 'function' || kind === 'symbol') return null
  if (Array.isArray(value)) {
    return value.map((item) => jsonSafe(item, seen))
  }
  if (kind === 'object') {
    if (seen.has(value)) return null
    if (value instanceof Date) return value.toISOString()
    if (value instanceof Error) return { name: value.name, message: value.message }
    seen.add(value)
    /** @type {Record<string, any>} */
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = jsonSafe(item, seen)
    }
    seen.delete(value)
    return out
  }
  return null
}

/** @param {unknown} value @param {number} fallback @returns {number} */
export function num(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback @returns {number} */
export function clamp(value, min, max, fallback) {
  return Math.max(min, Math.min(max, num(value, fallback)))
}

/**
 * The read-only renderer behind both the HTTP face and the `ana_window` tool.
 * @param {{ rootDir?: string, redaction?: string, width?: number, color?: string, events?: number,
 *   salience?: number, diagramNodes?: number, includeBodies?: boolean, cacheMs?: number,
 *   now?: () => number, logger?: any }} options
 */
export function createRenderer(options = {}) {
  const now = options.now ?? (() => Date.now())
  const cacheMs = clamp(options.cacheMs, 0, 60_000, 750)
  /** One-entry memo. The window polls; the store is not re-read for a repeat. */
  let memo = { key: '', at: 0, value: null }
  const stats = { frames: 0, diagrams: 0, status: 0, errors: 0, lastAt: null, lastError: '' }

  // 解析结果与核心**共用同一套回退链**；第一次解析会异步加载 `paths`，之后缓存。
  let resolvedRoot = null
  const rootDirSync = () => resolve(resolvedRoot === null ? defaultRoot() : resolvedRoot.rootDir)
  const ensureRoot = async () => {
    if (resolvedRoot !== null) return resolvedRoot
    resolvedRoot = await resolveStoreRoot(String(options.rootDir ?? ''))
    return resolvedRoot
  }
  const rootDir = () => rootDirSync()

  /**
   * @param {string} key
   * @param {() => Promise<any>} produce
   */
  const cached = async (key, produce) => {
    const at = now()
    if (cacheMs > 0 && memo.key === key && at - memo.at < cacheMs) return memo.value
    const value = await produce()
    memo = { key, at, value }
    return value
  }

  /** @param {any} layer */
  const limits = (layer) => ({
    width: clamp(options.width, 48, 200, 96),
    color: options.color === 'always' ? 'always' : 'never',
    events: clamp(options.events, 1, 200, 8),
    salience: clamp(options.salience, 1, 50, 5),
    diagramNodes: clamp(options.diagramNodes, 1, 200, 40),
    redaction: layer.REDACTION_LEVELS.includes(String(options.redaction))
      ? String(options.redaction)
      : layer.DEFAULT_REDACTION,
    includeBodies: options.includeBodies === true,
  })

  /** Human-readable "nothing here yet" that is still a real answer. */
  const emptyStore = (root, layer) => ({
    ok: true,
    empty: true,
    storeFound: false,
    root,
    text: `anagenesis 存储尚未创建：${root}\n`
      + '先让 dsh-anagenesis 的核心行运行一次（它会写入 snapshot.json 与 journal/），'
      + '或者把本行的 rootDir 指向已有的存储目录。',
    warnings: [`no anagenesis store at ${root} (expected a journal/ directory)`],
    origin: 'mirror',
    redaction: layer.DEFAULT_REDACTION,
    storeVersion: 0,
    width: limits(layer).width,
    sections: [],
    kind: '',
    format: '',
    nodes: 0,
    edges: 0,
    at: now(),
  })

  return {
    rootDir,
    stats,

    /** Store + journal facts, no render. */
    async status() {
      const layer = await loadVizLayer()
      // 与核心共用回退链：第一次调用先把存储根解析出来
      await ensureRoot()
      stats.status += 1
      stats.lastAt = now()
      const root = rootDir()
      const storeFound = layer.looksLikeStore(root)
      if (!storeFound) {
        return jsonSafe({
          ok: true, storeFound: false, root, origin: 'mirror',
          storeVersion: 0, memories: 0, journal: null,
          layers: { resolvedBy: layer.resolvedBy, sections: layer.DASHBOARD_SECTIONS, kinds: layer.DIAGRAM_KINDS, formats: layer.DIAGRAM_FORMATS, redactions: layer.REDACTION_LEVELS },
          stats, at: now(),
        })
      }
      const mirror = await layer.readStoreMirror(root)
      const memories = mirror.state?.memories !== undefined && typeof mirror.state.memories === 'object'
        ? Object.keys(mirror.state.memories).length
        : 0
      return jsonSafe({
        ok: true, storeFound: true, root, origin: 'mirror',
        storeVersion: Number(mirror.state?.version ?? 0),
        memories,
        journal: mirror.journal,
        layers: { resolvedBy: layer.resolvedBy, sections: layer.DASHBOARD_SECTIONS, kinds: layer.DIAGRAM_KINDS, formats: layer.DIAGRAM_FORMATS, redactions: layer.REDACTION_LEVELS },
        stats, at: now(),
      })
    },

    /** One TUI frame. */
    async frame(request = {}) {
      // 与核心共用回退链：第一次调用先把存储根解析出来
      const storeRoot = await ensureRoot()
      const layer = await loadVizLayer()
      const cfg = limits(layer)
      const width = clamp(request.width, 48, 200, cfg.width)
      const events = clamp(request.events, 1, 200, cfg.events)
      const salience = clamp(request.salience, 1, 50, cfg.salience)
      const redaction = layer.REDACTION_LEVELS.includes(String(request.redaction)) ? String(request.redaction) : cfg.redaction
      const sections = Array.isArray(request.sections) && request.sections.length > 0
        ? request.sections.map((item) => String(item)).filter((item) => layer.DASHBOARD_SECTIONS.includes(item))
        : null
      const key = `frame:${rootDir()}:${width}:${events}:${salience}:${redaction}:${cfg.color}:${sections === null ? 'all' : sections.join(',')}`
      try {
        const value = await cached(key, async () => {
          const root = rootDir()
          if (!layer.looksLikeStore(root)) return emptyStore(root, layer)
          const mirror = await layer.readStoreMirror(root)
          const model = layer.buildDashboardModel(mirror, {
            sections: sections ?? undefined,
            width,
            color: cfg.color,
            limit: { events, salience },
            redaction,
            includeBody: cfg.includeBodies,
            // Same language the terminal surfaces use (`ana_dashboard`): the frame
            // here and the frame in a tool answer must stay the same bytes.
            lang: 'zh',
            // Deliberately NO `selfStatus`: the window must be a pure viewer, so the
            // same mirror plus the same options yields the same bytes here as in
            // `ana_dashboard`. The window's own counters live in its footer (a UI
            // concern), never in the frame — `tools/live-probe.mjs` asserts the
            // equality over real HTTP.
          })
          const text = layer.renderFrame(model, { width: model.render.width, color: model.render.color, sections: sections ?? undefined, isTty: false })
          return {
            ok: true, empty: false, storeFound: true, root, text,
            width: model.render.width,
            sections: model.sections.map((section) => String(section.id)),
            storeVersion: Number(model.store?.version ?? 0),
            origin: String(model.origin ?? 'mirror'),
            redaction: String(model.redaction?.level ?? redaction),
            warnings: Array.isArray(model.warnings) ? model.warnings : [],
            at: now(),
          }
        })
        if (value.empty !== true) stats.frames += 1
        stats.lastAt = now()
        return jsonSafe(value)
      } catch (error) {
        stats.errors += 1
        stats.lastError = error instanceof Error ? error.message : String(error)
        options.logger?.warn?.(`anagenesis-window: frame render failed: ${stats.lastError}`)
        throw error
      }
    },

    /** One text diagram. */
    async diagram(request = {}) {
      // 与核心共用回退链：第一次调用先把存储根解析出来
      const storeRoot = await ensureRoot()
      const layer = await loadVizLayer()
      const cfg = limits(layer)
      const kind = layer.DIAGRAM_KINDS.includes(String(request.kind)) ? String(request.kind) : layer.DIAGRAM_KINDS[0]
      const format = layer.DIAGRAM_FORMATS.includes(String(request.format)) ? String(request.format) : layer.DIAGRAM_FORMATS[0]
      const nodes = clamp(request.nodes, 1, 200, cfg.diagramNodes)
      const timeline = clamp(request.timeline, 1, 400, Math.max(4, cfg.events * 2))
      const redaction = layer.REDACTION_LEVELS.includes(String(request.redaction)) ? String(request.redaction) : cfg.redaction
      const key = `diagram:${rootDir()}:${kind}:${format}:${nodes}:${timeline}:${redaction}`
      try {
        const value = await cached(key, async () => {
          const root = rootDir()
          if (!layer.looksLikeStore(root)) return emptyStore(root, layer)
          const mirror = await layer.readStoreMirror(root)
          const model = layer.buildDiagramModel(mirror, { kind, limit: { nodes, timeline }, redaction })
          const rendered = layer.renderDiagram(model, { format, embed: false })
          return {
            ok: true, empty: false, storeFound: true, root,
            text: rendered.text, source: rendered.source,
            kind: String(rendered.kind), format: String(rendered.format),
            artifactVersion: Number(rendered.version ?? 1),
            nodes: model.nodes.length, edges: model.edges.length,
            storeVersion: Number(model.store?.version ?? 0),
            origin: String(model.origin ?? 'mirror'),
            redaction: String(model.redaction?.level ?? redaction),
            warnings: Array.isArray(model.warnings) ? model.warnings : [],
            at: now(),
          }
        })
        if (value.empty !== true) stats.diagrams += 1
        stats.lastAt = now()
        return jsonSafe(value)
      } catch (error) {
        stats.errors += 1
        stats.lastError = error instanceof Error ? error.message : String(error)
        options.logger?.warn?.(`anagenesis-window: diagram render failed: ${stats.lastError}`)
        throw error
      }
    },

    /**
     * 结构化**仪表盘模型** —— 窗口拿它自己在客户端渲染 HTML。
     *
     * 这是本轮最重要的接口变化：窗口不再取 `frame()` 的终端 ASCII 文本（单色字符
     * 堆叠），而是取 `buildDashboardModel()` 的原始对象（分区 + 行 + 数值 + 比例 +
     * tone），由共享渲染层画成中文卡片与彩色进度条。`frame()` **没有删** ——
     * `ana_dashboard` 与 `tools/viz-watch.mjs` 照旧用它。
     * @param {any} [request]
     */
    async dashboard(request = {}) {
      // 与核心共用回退链：第一次调用先把存储根解析出来
      const storeRoot = await ensureRoot()
      const layer = await loadVizLayer()
      const cfg = limits(layer)
      const width = clamp(request.width, 48, 200, cfg.width)
      const events = clamp(request.events, 1, 200, cfg.events)
      const salience = clamp(request.salience, 1, 50, cfg.salience)
      const redaction = layer.REDACTION_LEVELS.includes(String(request.redaction)) ? String(request.redaction) : cfg.redaction
      const sections = Array.isArray(request.sections) && request.sections.length > 0
        ? request.sections.map((item) => String(item)).filter((item) => layer.DASHBOARD_SECTIONS.includes(item))
        : null
      const key = `dashboard:${rootDir()}:${width}:${events}:${salience}:${redaction}:${sections === null ? 'all' : sections.join(',')}`
      try {
        const value = await cached(key, async () => {
          const root = rootDir()
          if (!layer.looksLikeStore(root)) return { ok: true, empty: true, storeFound: false, root, model: emptyDashboardModel(layer, root) }
          const mirror = await layer.readStoreMirror(root)
          const model = layer.buildDashboardModel(mirror, {
            sections: sections ?? undefined,
            width,
            color: 'never',
            limit: { events, salience },
            redaction,
            includeBody: cfg.includeBodies,
          })
          return { ok: true, empty: false, storeFound: true, root, model }
        })
        if (value.empty !== true) stats.frames += 1
        stats.lastAt = now()
        return jsonSafe(value)
      } catch (error) {
        stats.errors += 1
        stats.lastError = error instanceof Error ? error.message : String(error)
        options.logger?.warn?.(`anagenesis-window: dashboard model failed: ${stats.lastError}`)
        throw error
      }
    },

    /**
     * 结构化**图表模型**（记忆关系图 / 生命周期 / 策略时间线）。
     *
     * 窗口拿到 nodes/edges/timeline/transitions 后自己布局成 SVG。原来的
     * `diagram()` 返回的是 Mermaid/D2/ASCII **源码文本**，窗口把它当正文打印，
     * 用户看到 `graph LR` / `classDef` / `#111827` —— 那条路只留给工具与终端。
     * @param {any} [request]
     */
    async graph(request = {}) {
      // 与核心共用回退链：第一次调用先把存储根解析出来
      const storeRoot = await ensureRoot()
      const layer = await loadVizLayer()
      const cfg = limits(layer)
      const kind = layer.DIAGRAM_KINDS.includes(String(request.kind)) ? String(request.kind) : layer.DIAGRAM_KINDS[0]
      const nodes = clamp(request.nodes, 1, 200, cfg.diagramNodes)
      const timeline = clamp(request.timeline, 1, 400, Math.max(4, cfg.events * 2))
      const redaction = layer.REDACTION_LEVELS.includes(String(request.redaction)) ? String(request.redaction) : cfg.redaction
      const key = `graph:${rootDir()}:${kind}:${nodes}:${timeline}:${redaction}`
      try {
        const value = await cached(key, async () => {
          const root = rootDir()
          if (!layer.looksLikeStore(root)) return { ok: true, empty: true, storeFound: false, root, model: emptyDiagramModel(layer, root, kind) }
          const mirror = await layer.readStoreMirror(root)
          const model = layer.buildDiagramModel(mirror, { kind, limit: { nodes, timeline }, redaction })
          return { ok: true, empty: false, storeFound: true, root, model }
        })
        if (value.empty !== true) stats.diagrams += 1
        stats.lastAt = now()
        return jsonSafe(value)
      } catch (error) {
        stats.errors += 1
        stats.lastError = error instanceof Error ? error.message : String(error)
        options.logger?.warn?.(`anagenesis-window: graph model failed: ${stats.lastError}`)
        throw error
      }
    },
  }
}

/**
 * 没有存储时的**空模型**。
 *
 * 关键点：给的是一个结构正确的模型，不是一个错误。客户端渲染层因此可以照常工作，
 * 只要 `memories === 0` 就会显示"还没有记忆"的空态 —— 而不是让窗口卡在"读取失败"。
 * @param {any} layer
 * @param {string} root
 */
function emptyDashboardModel(layer, root) {
  return {
    kind: 'dashboard',
    title: 'anagenesis dashboard',
    generatedAt: Date.now(),
    origin: 'mirror',
    store: { version: 0, schemaVersion: 0, memories: 0, live: 0, safeMode: false, stacks: [] },
    sections: [],
    warnings: [`no anagenesis store at ${root} (expected a journal/ directory)`],
    limits: { events: 0, salience: 0, nodes: 0 },
    redaction: { level: layer.DEFAULT_REDACTION, note: '' },
    render: { width: 96, color: 'never' },
  }
}

/**
 * @param {any} layer
 * @param {string} root
 * @param {string} kind
 */
function emptyDiagramModel(layer, root, kind) {
  return {
    kind,
    title: `anagenesis ${kind}`,
    generatedAt: Date.now(),
    origin: 'mirror',
    store: { version: 0, schemaVersion: 0, memories: 0, live: 0, safeMode: false, stacks: [] },
    nodes: [],
    edges: [],
    timeline: [],
    transitions: [],
    totals: { byState: {}, byKind: {}, byEventType: {} },
    warnings: [`no anagenesis store at ${root} (expected a journal/ directory)`],
    limits: { nodes: 0, timeline: 0 },
    redaction: { level: layer.DEFAULT_REDACTION, note: '' },
  }
}