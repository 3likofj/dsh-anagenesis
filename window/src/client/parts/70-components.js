/**
 * Client half, part 7/9 — the React surface.
 *
 * 分工是刻意的：**外壳是 React，内容是纯函数产出的 HTML**。
 *
 *   - 外壳（`AnagenesisWindow` / `AnagenesisHeaderButton` / `AnagenesisLauncher`）要持有
 *     开合、拖动、缩放、轮询这些**状态**，本来就是 React 的活；
 *   - 内容（指标卡、进度条、图谱 SVG、时间线）由渲染层生成字符串，通过
 *     `dangerouslySetInnerHTML` 注入。这样同一段字符串既是窗口里的 DOM，也是
 *     `tools/preview.mjs` 截图里的 DOM —— "我截到的"就是"你看到的"。
 *
 * 交互只挂三个监听在窗口根节点上（事件委托）：`onPointerDown` 拖标题栏、
 * `onClick` 分发 `data-evo-action`、`onChange` 分发 `data-evo-field`。工具栏里的
 * 每个按钮/下拉框因此不需要各自的回调，也就不会随控件增减而漏接。
 *
 * 注入的内容全部来自本包渲染层，且**每一条 store 文本都过了 `esc()`**：这里注入的
 * 不是第三方内容。
 */

/** `useSyncExternalStore` when the host has it, a subscription shim when it does not. */
function useStoreValue(subscribe, getSnapshot) {
  if (typeof useSyncExternalStore === 'function') {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  }
  const pair = useState(0)
  const bump = pair[1]
  useEffect(() => subscribe(() => bump((value) => value + 1)), [subscribe])
  return getSnapshot()
}

/** @param {any} engine */
function useWindowState(engine) {
  return useStoreValue(engine.subscribe, engine.getSnapshot)
}

/** Monochrome glyph (currentColor, per the shell's icon contract). */
function AnagenesisIcon(props) {
  const size = props !== undefined && props.size !== undefined ? props.size : 14
  return createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false',
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
  },
    createElement('circle', { cx: 3.2, cy: 12, r: 1.7, key: 'a' }),
    createElement('circle', { cx: 8, cy: 4, r: 1.9, key: 'b' }),
    createElement('circle', { cx: 12.8, cy: 10.4, r: 1.5, key: 'c' }),
    createElement('path', { d: 'M4.4 10.7 6.9 5.7M9.6 4.9l2.7 4.2M4.9 11.6l6.4-0.8', key: 'd' }),
  )
}

/**
 * One trigger, used by every seat. `autoOpen` is what makes a *row* behave like a
 * door: the tab's own mount is the click, so the user picks the row and the window
 * appears — no intermediate page is drawn and nothing is rendered twice.
 * @param {{ engine: any, title: string, reason: string, autoOpen?: boolean, hint?: string }} props
 */
function AnagenesisLauncher(props) {
  const engine = props.engine
  const snap = useWindowState(engine)
  const fired = useRef(false)
  useEffect(() => {
    if (props.autoOpen !== true || fired.current) return
    fired.current = true
    engine.open({ reason: props.reason })
  }, [engine, props.autoOpen, props.reason])
  return createElement('div', { className: 'evo-launcher' },
    createElement('button', {
      type: 'button',
      className: 'evo-launch-btn',
      'aria-pressed': snap.open === true,
      onClick: () => engine.toggle(props.reason),
    }, createElement(AnagenesisIcon, { size: 15 }), snap.open ? '收起可视化窗口' : '打开可视化窗口'),
    createElement('div', { className: 'evo-launch-hint' },
      props.hint === undefined
        ? '这是入口，不是第二个界面：仪表盘与图表全部在这个原生窗口里渲染，所有入口打开的是同一个窗口。'
        : props.hint),
  )
}

/**
 * The header seat's control: a compact toggle in the conversation / Trajectory
 * top bar. It is a button, not a panel, so it cannot disturb the header's layout.
 * @param {{ engine: any }} props
 */
function AnagenesisHeaderButton(props) {
  const engine = props.engine
  const snap = useWindowState(engine)
  const label = 'anagenesis 可视化'
  return createElement('button', {
    type: 'button',
    className: 'evo-header-button',
    title: label + '（原生窗口，只读；所有入口打开同一个窗口）',
    'aria-label': label,
    'aria-pressed': snap.open === true,
    'data-dsh-anagenesis-window-button': 'header',
    onClick: () => engine.toggle('conversation-header'),
  }, createElement(AnagenesisIcon, { size: 13 }), createElement('span', null, '可视化'))
}

/** 把一段渲染层产出的 HTML 放进一个容器节点。 */
function injectChrome(className, html) {
  return createElement('div', { className: className, dangerouslySetInnerHTML: { __html: html } })
}

/**
 * The desktop window.
 *
 * Hooks run before the `null` return so the closed state still owns the two
 * timers: the drain timer is the agent's only door (`ana_window` leaves a request
 * on the Host and this poll picks it up), and it must run while the window is
 * closed. Both timers stand down while the page is hidden.
 * @param {{ engine: any, title: string, refreshMs: number }} props
 */
function AnagenesisWindow(props) {
  const engine = props.engine
  const snap = useWindowState(engine)
  const drag = useRef(null)
  const rootRef = useRef(null)
  const pair = useState(false)
  const dragging = pair[0]
  const setDragging = pair[1]

  /**
   * 事件接线：**原生监听器接在窗口根节点上，不用 React 的 onClick / onChange。**
   *
   * 工具栏与内容都是 `dangerouslySetInnerHTML` 注入的，React 没有这些节点的 fiber；
   * React 的 `onChange` 是合成事件，只对它自己注册过的表单元素合成 —— 挂在外层 div
   * 上永远不会触发。用户报的"图种 / 方向 / 宽度点不动"就是这个：那三个控件全是
   * `data-evo-field`（两个 `<select>` 加一个数字 `<input>`）。
   */
  useEffect(() => {
    if (snap.open !== true) return undefined
    return wireWindowEvents(rootRef.current, engine, {
      beginDrag(event) {
        const state = engine.peek()
        drag.current = { px: event.clientX, py: event.clientY, x: numberOr(state.x, 0), y: numberOr(state.y, 0) }
        setDragging(true)
      },
      endDrag() {
        setDragging(false)
      },
    })
  }, [engine, snap.open, setDragging])

  // Agent door + status: always on, at the window's own cadence.
  useEffect(() => {
    const period = Math.max(1000, numberOr(props.refreshMs, DEFAULT_CONFIG.refreshMs))
    const tick = () => {
      if (typeof document !== 'undefined' && document !== null && document.hidden === true) return
      void engine.drain()
    }
    tick()
    const timer = setInterval(tick, period)
    return () => clearInterval(timer)
  }, [engine, props.refreshMs])

  // Content refresh: only while the window is open and visible.
  useEffect(() => {
    if (snap.open !== true) return undefined
    const period = Math.max(500, numberOr(props.refreshMs, DEFAULT_CONFIG.refreshMs))
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document !== null && document.hidden === true) return
      void engine.refresh()
    }, period)
    return () => clearInterval(timer)
  }, [engine, snap.open, props.refreshMs, snap.view, snap.kind, snap.maxNodes, snap.width, snap.redaction])

  // Dragging: listeners on the window so the pointer may leave the bar without
  // dropping the gesture.
  useEffect(() => {
    if (dragging !== true) return undefined
    const win = typeof window !== 'undefined' ? window : undefined
    if (win === undefined) return undefined
    const move = (event) => {
      const origin = drag.current
      if (origin === null) return
      const x = Math.max(0, Math.min(win.innerWidth - 120, origin.x + (event.clientX - origin.px)))
      const y = Math.max(0, Math.min(win.innerHeight - 40, origin.y + (event.clientY - origin.py)))
      engine.patch({ x: x, y: y })
    }
    const stop = () => setDragging(false)
    win.addEventListener('pointermove', move)
    win.addEventListener('pointerup', stop)
    win.addEventListener('pointercancel', stop)
    return () => {
      win.removeEventListener('pointermove', move)
      win.removeEventListener('pointerup', stop)
      win.removeEventListener('pointercancel', stop)
    }
  }, [engine, dragging, setDragging])

  if (snap.open !== true) return null

  const toolbarState = {
    view: snap.view, kind: snap.kind, direction: snap.direction, zoom: snap.zoom,
    maxNodes: snap.maxNodes, width: snap.width, redaction: snap.redaction,
  }
  const footerState = {
    origin: snap.origin, storeVersion: snap.storeVersion, lastAt: snap.lastAt,
    busy: snap.busy, warnings: snap.warnings, error: snap.error, degraded: snap.degraded,
  }

  return createElement('div', {
    'data-dsh-anagenesis-window': 'window',
    ref: rootRef,
    style: { left: numberOr(snap.x, 40) + 'px', top: numberOr(snap.y, 40) + 'px' },
    role: 'dialog',
    'aria-label': props.title,
  },
    injectChrome('evo-chrome', renderTitlebarHtml({ title: props.title, subtitle: snap.summary })),
    injectChrome('evo-chrome', renderToolbarHtml(toolbarState)),
    createElement('div', { className: 'evo-pane' },
      snap.html === ''
        ? createElement('div', { className: 'evo-empty' },
            createElement('div', { className: 'evo-empty-title' }, snap.busy ? '正在读取存储…' : '还没有数据'),
            createElement('div', null, snap.error === '' ? '首次读取通常在一秒内完成' : snap.error))
        : createElement('div', { dangerouslySetInnerHTML: { __html: snap.html } }),
    ),
    injectChrome('evo-chrome', renderFooterHtml(footerState)),
  )
}