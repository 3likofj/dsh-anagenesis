/**
 * Client half, part 5/9 — the window engine and the Host transport.
 *
 * 这次改动最大的一块：窗口不再取**文本帧**，而是取**结构化模型**
 * （`dashboard` / `graph` 两个 RPC），再用共享渲染层生成 HTML/SVG。
 *
 * 为什么必须换：
 *   - 原来图表页拿的是 `renderDiagram()` 的 **Mermaid 源码**，窗口把它当正文打印 ——
 *     用户看到 `graph LR` / `classDef` / `#111827` / `ana_mem_0muw…`；
 *   - 原来仪表盘拿的是终端 ASCII 帧，在窗口里表现为单色字符堆叠。
 * 文本渲染器**没有删**：`ana_dashboard` / `ana_diagram` / `tools/viz-watch.mjs` 照旧用
 * 它们（终端需要文本），窗口走另一条路。
 *
 * 模型缓存：方向 / 缩放是**纯渲染参数**，改了不需要再问 Host 一次 —— engine 留住
 * 最后一次模型，本地重渲染即可。这是"性能可控"的落点：拖缩放不会打网络。
 */

/** Trim a parameter bag down to what the Host understands. */
function cleanParams(params) {
  const out = {}
  if (params === undefined || params === null) return out
  for (const key of Object.keys(params)) {
    const value = params[key]
    if (value === undefined || value === null || value === '') continue
    out[key] = Array.isArray(value) ? value.join(',') : String(value)
  }
  return out
}

/**
 * @param {any} log
 * @returns {(method: string, params?: any) => Promise<any>}
 */
function createHostTransport(log) {
  return async function request(method, params) {
    if (typeof fetch !== 'function') throw new Error('这个 shell 没有 fetch，窗口读不到 Host')
    const query = new URLSearchParams(cleanParams(Object.assign({ method: method }, cleanParams(params))))
    const response = await fetch(API_PATH + '?' + query.toString(), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error('窗口路由返回 HTTP ' + response.status)
    const payload = await response.json()
    if (payload === null || typeof payload !== 'object') throw new Error('窗口路由返回了非对象载荷')
    void log
    return payload
  }
}

/** 视图可选值（与渲染层的下拉框一一对应）。 */
const VIEWS = ['dashboard', 'graph']
/** 图的两种排布方向。 */
const DIRECTIONS = ['LR', 'TB']
/** 脱敏级别（渲染层给的是中文标签，机器值仍是这三个）。 */
const REDACTIONS = ['secrets', 'strict', 'none']

/**
 * @param {{ log: any, config: any, request: (method: string, params?: any) => Promise<any>, now?: () => number }} deps
 * @returns {any}
 */
function createWindowEngine(deps) {
  const log = deps.log
  const request = deps.request
  const now = deps.now === undefined ? () => Date.now() : deps.now
  /** @type {Set<() => void>} */
  const listeners = new Set()

  const state = {
    open: false,
    view: 'dashboard',
    kind: 'memory-graph',
    direction: 'LR',
    zoom: 1,
    maxNodes: 40,
    width: numberOr(deps.config.width, DEFAULT_CONFIG.width),
    redaction: deps.config.redaction,
    x: null,
    y: null,
    /** 渲染层产出的 HTML（图的部分是内联 SVG）。空串 = 还没读到数据。 */
    html: '',
    summary: '',
    /** `''` = 走结构化模型；`'frame'` / `'diagram'` = 降级成 Host 半的旧文本接口。 */
    degraded: '',
    warnings: [],
    error: '',
    busy: false,
    lastAt: 0,
    origin: '',
    storeVersion: 0,
    status: null,
    drained: 0,
    opens: 0,
    refreshes: 0,
    failures: 0,
  }
  /** 最后一次成功取回的模型。方向/缩放只重渲染，不再打扰 Host。 */
  let lastModel = null

  // React reads this through `useSyncExternalStore`, which requires a STABLE
  // object identity between notifications — returning a fresh object every call
  // is an infinite render loop, not a style preference.
  let cached = null

  const notify = () => {
    cached = null
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch (error) {
        console.error(PKG_ID + ': window listener failed', error)
      }
    }
  }

  const build = () => ({
    open: state.open,
    view: state.view,
    kind: state.kind,
    direction: state.direction,
    zoom: state.zoom,
    maxNodes: state.maxNodes,
    width: state.width,
    redaction: state.redaction,
    x: state.x,
    y: state.y,
    html: state.html,
    summary: state.summary,
    degraded: state.degraded,
    warnings: state.warnings.slice(),
    error: state.error,
    busy: state.busy,
    lastAt: state.lastAt,
    origin: state.origin,
    storeVersion: state.storeVersion,
    status: state.status,
    counters: { opens: state.opens, refreshes: state.refreshes, failures: state.failures, drained: state.drained },
  })

  const snap = () => {
    if (cached === null) cached = build()
    return cached
  }

  /**
   * 从最后一份模型重新生成 HTML。纯函数、不碰网络 —— 方向与缩放的每一次调整都走这里。
   */
  const render = () => {
    if (lastModel === null) return
    try {
      if (state.view === 'dashboard') {
        state.html = renderDashboardHtml(lastModel) + dashboardLegendHtml()
        state.summary = dashboardSummary(lastModel)
      } else {
        state.html = renderDiagramHtml(lastModel, { direction: state.direction, maxNodes: state.maxNodes, zoom: state.zoom })
        state.summary = diagramSummary(lastModel)
      }
      state.error = ''
      state.degraded = ''
    } catch (error) {
      state.error = '渲染失败：' + errorText(error)
      log.push('window.render-failed', { view: state.view, error: errorText(error) })
    }
  }

  /** First open centres the window; later opens keep wherever the user dragged it. */
  const centre = () => {
    if (state.x !== null && state.y !== null) return
    const win = typeof window !== 'undefined' ? window : undefined
    const innerWidth = win !== undefined && isFinite(win.innerWidth) ? win.innerWidth : 1280
    const innerHeight = win !== undefined && isFinite(win.innerHeight) ? win.innerHeight : 800
    state.x = Math.max(24, Math.round(innerWidth * 0.5 - 440))
    state.y = Math.max(24, Math.round(innerHeight * 0.12))
  }

  let inFlight = null

  /**
   * One model round-trip. Never concurrent: a second call joins the first, so a
   * fast poll cannot stack requests on the Host.
   * @returns {Promise<any>}
   */
  const refresh = () => {
    if (inFlight !== null) return inFlight
    state.busy = true
    notify()
    inFlight = (async () => {
      try {
        const isGraph = state.view === 'graph'
        let payload
        try {
          payload = isGraph
            ? await request('graph', { kind: state.kind, nodes: state.maxNodes, timeline: Math.max(6, deps.config.events * 2), redaction: state.redaction })
            : await request('dashboard', { width: state.width, events: deps.config.events, salience: deps.config.salience, redaction: state.redaction })
          if (payload.ok !== true) throw new Error(String(payload.error === undefined ? 'Host 拒绝了这次读取' : payload.error))
        } catch (modelError) {
          // 版本偏斜：Host 半还是只提供文本帧的旧版本（Node 侧不会热替换，
          // 要重启桌面端才会重新导入）。此时降到文本视图并**说明原因**，
          // 而不是把"未知方法"当成失败糊在用户脸上。
          const legacy = isGraph
            ? await request('diagram', { kind: state.kind, format: 'mermaid', nodes: state.maxNodes, timeline: Math.max(6, deps.config.events * 2), redaction: state.redaction })
            : await request('frame', { width: state.width, events: deps.config.events, salience: deps.config.salience, redaction: state.redaction })
          if (legacy.ok !== true) throw modelError
          lastModel = null
          state.degraded = isGraph ? 'diagram' : 'frame'
          state.html = renderTextFallbackHtml(String(legacy.text ?? ''), isGraph
            ? '当前 Host 半还是旧版本，只能给出图表源码文本。重启桌面端后，这里会变成真正的图形（内联 SVG）。'
            : '当前 Host 半还是旧版本，只能给出终端文本帧。重启桌面端后，这里会变成中文卡片与彩色分布条。')
          state.summary = ''
          state.origin = String(legacy.origin ?? 'mirror')
          state.storeVersion = numberOr(legacy.storeVersion, 0)
          state.warnings = Array.isArray(legacy.warnings) ? legacy.warnings.slice() : []
          log.push('window.degraded', { view: state.view, transport: state.degraded })
          state.lastAt = now()
          state.refreshes += 1
          return legacy
        }
        lastModel = payload.model
        state.degraded = ''
        state.warnings = Array.isArray(payload.model?.warnings) ? payload.model.warnings.slice() : []
        state.origin = typeof payload.model?.origin === 'string' ? payload.model.origin : ''
        state.storeVersion = numberOr(payload.model?.store?.version, 0)
        render()
        state.lastAt = now()
        state.refreshes += 1
        return payload
      } catch (error) {
        state.failures += 1
        state.error = '读取失败：' + errorText(error)
        log.push('window.render-failed', { view: state.view, error: errorText(error) })
        return null
      } finally {
        state.busy = false
        inFlight = null
        notify()
      }
    })()
    return inFlight
  }

  /** Slow facts only: the store's health, not the entry layer's. */
  const refreshStatus = async () => {
    try {
      const payload = await request('status', {})
      state.status = {
        ok: payload.ok === true,
        storeFound: payload.storeFound === true,
        root: String(payload.root === undefined || payload.root === null ? '' : payload.root),
        storeVersion: numberOr(payload.storeVersion, 0),
        memories: numberOr(payload.memories, 0),
        pendingOpen: payload.pendingOpen !== null && payload.pendingOpen !== undefined,
        at: now(),
      }
    } catch (error) {
      state.status = { ok: false, storeFound: false, root: '', storeVersion: 0, memories: 0, pendingOpen: false, at: now(), error: errorText(error) }
    }
    notify()
    return state.status
  }

  /**
   * Drain the Host's pending-open slot. This is the agent door: `ana_window`
   * cannot push, so it leaves a request and this poll takes it. Runs whether or
   * not the window is open — a closed window must still be openable by an agent.
   */
  const drain = async () => {
    let payload
    try {
      payload = await request('takeOpen', {})
    } catch (error) {
      return null
    }
    const item = payload === null || payload === undefined ? null : payload.request
    if (item === null || item === undefined) return null
    state.drained += 1
    const action = String(item.action === undefined ? 'open' : item.action)
    const detail = item.detail !== null && typeof item.detail === 'object' ? item.detail : {}
    log.push('window.request-drained', { action: action, seq: numberOr(item.seq, 0), source: 'ana_window' })
    if (action === 'close') close('agent')
    else if (action === 'toggle') toggle('agent')
    else {
      open({
        reason: 'agent',
        view: oneOf(detail.view, VIEWS, state.view),
        kind: detail.kind === '' || detail.kind === undefined ? state.kind : String(detail.kind),
      })
    }
    return item
  }

  /**
   * Raise the window. Idempotent by design: opening an already-open window only
   * applies the requested face change, so two seats cannot produce two windows.
   * @param {{ reason?: string, view?: string, kind?: string }} [options]
   */
  function open(options) {
    const opts = options === undefined || options === null ? {} : options
    const wasOpen = state.open
    centre()
    state.open = true
    const nextView = opts.view === undefined ? state.view : oneOf(opts.view, VIEWS, state.view)
    const viewChanged = nextView !== state.view
    state.view = nextView
    if (opts.kind !== undefined && String(opts.kind) !== '' && String(opts.kind) !== state.kind) {
      state.kind = String(opts.kind)
      lastModel = null
    }
    if (viewChanged) lastModel = null
    if (!wasOpen) state.opens += 1
    log.push(wasOpen ? 'window.raised' : 'window.opened', { reason: String(opts.reason === undefined ? 'unknown' : opts.reason), view: state.view })
    notify()
    void refresh()
    void refreshStatus()
    return snap()
  }

  /** @param {string} [reason] */
  function close(reason) {
    if (!state.open) {
      notify()
      return snap()
    }
    state.open = false
    log.push('window.closed', { reason: String(reason === undefined ? 'user' : reason) })
    notify()
    return snap()
  }

  /** @param {string} [reason] */
  function toggle(reason) {
    return state.open ? close(reason) : open({ reason: reason === undefined ? 'toggle' : reason })
  }

  /** Switch face without changing whether the window is open. @param {string} view */
  function setView(view) {
    const next = oneOf(view, VIEWS, state.view)
    if (next === state.view) return snap()
    state.view = next
    log.push('window.view', { view: state.view })
    lastModel = null // 仪表盘与图的模型不是同一个，必须重新取
    notify()
    if (state.open) void refresh()
    return snap()
  }

  /**
   * 工具栏上的一个控件变化。渲染参数本地重画；取数参数（图种、节点上限、脱敏、
   * 宽度）重新问 Host 一次。
   * @param {string} field
   * @param {string|number} value
   */
  function setField(field, value) {
    switch (String(field)) {
      case 'view':
        return setView(String(value))
      case 'kind': {
        const next = String(value)
        if (next === state.kind) return snap()
        state.kind = oneOf(next, ['memory-graph', 'strategy-timeline', 'lifecycle'], state.kind)
        lastModel = null
        log.push('window.kind', { kind: state.kind })
        notify()
        if (state.open) void refresh()
        return snap()
      }
      case 'direction':
        state.direction = oneOf(value, DIRECTIONS, state.direction)
        break
      case 'zoom':
        state.zoom = Math.max(0.4, Math.min(2.5, numberOr(value, state.zoom)))
        break
      case 'maxNodes': {
        const next = Math.max(4, Math.min(200, Math.round(numberOr(value, state.maxNodes))))
        if (next === state.maxNodes) return snap()
        state.maxNodes = next
        lastModel = null
        notify()
        if (state.open) void refresh()
        return snap()
      }
      case 'width': {
        const next = Math.max(48, Math.min(200, Math.round(numberOr(value, state.width))))
        if (next === state.width) return snap()
        state.width = next
        lastModel = null
        notify()
        if (state.open) void refresh()
        return snap()
      }
      case 'redaction': {
        const next = oneOf(value, REDACTIONS, state.redaction)
        if (next === state.redaction) return snap()
        state.redaction = next
        lastModel = null
        notify()
        if (state.open) void refresh()
        return snap()
      }
      default:
        log.push('window.unknown-field', { field: String(field) })
        return snap()
    }
    // 只影响本地渲染的字段：立刻重画，不打扰 Host。
    render()
    notify()
    return snap()
  }

  /**
   * 工具栏按钮的分发点（窗口根节点上一个事件委托最终走这里）。
   * @param {string} action
   */
  function dispatch(action) {
    switch (String(action)) {
      case 'view-dashboard': return setView('dashboard')
      case 'view-graph': return setView('graph')
      case 'zoom-in': return setField('zoom', Number((state.zoom * 1.2).toFixed(3)))
      case 'zoom-out': return setField('zoom', Number((state.zoom / 1.2).toFixed(3)))
      case 'zoom-reset': return setField('zoom', 1)
      case 'refresh': {
        lastModel = null
        void refresh()
        return snap()
      }
      case 'close': return close('user')
      default:
        log.push('window.unknown-action', { action: String(action) })
        return snap()
    }
  }

  /** @param {Record<string, any>} patch */
  function patch(patch) {
    if (patch !== null && typeof patch === 'object') {
      let needsFetch = false
      if (patch.view !== undefined) {
        const next = oneOf(patch.view, VIEWS, state.view)
        if (next !== state.view) {
          state.view = next
          needsFetch = true
        }
      }
      if (patch.kind !== undefined) {
        const next = oneOf(patch.kind, ['memory-graph', 'strategy-timeline', 'lifecycle'], state.kind)
        if (next !== state.kind) {
          state.kind = next
          needsFetch = true
        }
      }
      if (patch.direction !== undefined) state.direction = oneOf(patch.direction, DIRECTIONS, state.direction)
      if (patch.zoom !== undefined) state.zoom = Math.max(0.4, Math.min(2.5, numberOr(patch.zoom, state.zoom)))
      if (patch.maxNodes !== undefined) {
        const next = Math.max(4, Math.min(200, Math.round(numberOr(patch.maxNodes, state.maxNodes))))
        if (next !== state.maxNodes) {
          state.maxNodes = next
          needsFetch = true
        }
      }
      if (patch.width !== undefined) {
        const next = Math.max(48, Math.min(200, Math.round(numberOr(patch.width, state.width))))
        if (next !== state.width) {
          state.width = next
          needsFetch = true
        }
      }
      if (patch.redaction !== undefined) {
        const next = oneOf(patch.redaction, REDACTIONS, state.redaction)
        if (next !== state.redaction) {
          state.redaction = next
          needsFetch = true
        }
      }
      if (patch.x !== undefined) state.x = numberOr(patch.x, state.x)
      if (patch.y !== undefined) state.y = numberOr(patch.y, state.y)
      if (needsFetch) lastModel = null
      else render()
    }
    notify()
    if (state.open && lastModel === null) void refresh()
    return snap()
  }

  return {
    getSnapshot: snap,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    open: open,
    close: close,
    toggle: toggle,
    setView: setView,
    setField: setField,
    dispatch: dispatch,
    patch: patch,
    refresh: refresh,
    refreshStatus: refreshStatus,
    drain: drain,
    /** Read-only state, for callers that must not trigger a render. */
    peek() {
      return snap()
    },
  }
}