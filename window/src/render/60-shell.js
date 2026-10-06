/**
 * 窗口骨架（标题栏 / 工具栏 / 页脚 / 事件接线）—— 渲染层第 6 部分。
 *
 * 工具栏是**纯函数产出的 HTML**，理由和内容面板一样：预览里能截到它，验收时看到的
 * 就是窗口里的。交互靠 `data-ana-action` / `data-ana-field` 属性 + 根节点上的事件
 * 委托，所以这里不需要 React，也不需要每个按钮一个回调。
 *
 * **接线必须是原生监听器，不能用 React 的 `onClick` / `onChange` 属性。**
 * 这一条是用户报"图种、方向、宽度点不动"之后才定位到的：那些控件是
 * `dangerouslySetInnerHTML` 注入的，React **没有它们的 fiber**；而 React 的
 * `onChange` 是**合成事件** —— 只有在它自己注册过的表单元素上才会被合成出来，
 * 对注入的 `<select>` / `<input>` 永远不会触发。所以 `onChange` 挂在外层 div 上
 * 等于没挂。原生 `change` 监听器没有这个问题，也不受 React 事件系统实现细节影响。
 *
 * 全部文案中文，全部控件都带 `title` 解释"这个按钮会做什么"。
 */

/**
 * 把窗口根节点上的原生事件接到 engine 上，返回精确的逆操作。
 *
 * 依赖全部由参数传入（节点、engine、拖拽钩子），所以它可以在 Node 里用一个十行的
 * 假节点测到 —— 这正是它不写成 React 属性的另一个原因。
 * @param {any} node 窗口根节点
 * @param {{ dispatch: (action: string) => any, setField: (field: string, value: any) => any, peek: () => any }} engine
 * @param {{ beginDrag?: (event: any) => void, endDrag?: () => void }} [hooks]
 * @returns {() => void} disposer
 */
function wireWindowEvents(node, engine, hooks) {
  if (node === undefined || node === null || typeof node.addEventListener !== 'function') return () => {}
  const opts = hooks === undefined || hooks === null ? {} : hooks

  const onClick = (event) => {
    const target = event.target
    if (target === undefined || target === null || typeof target.closest !== 'function') return
    const button = target.closest('[data-ana-action]')
    if (button === null) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    engine.dispatch(String(button.getAttribute('data-ana-action')))
  }

  // 原生 `change`：`<select>` 选中即触发；`<input type=number>` 在回车 / 失焦 /
  // 点上下箭头时触发。用 `change` 而不是 `input`，是为了让"宽度"这种会触发一次
  // Host 往返的字段只在用户**敲定**时生效，而不是每敲一个字符发一次请求。
  const onChange = (event) => {
    const target = event.target
    if (target === undefined || target === null || typeof target.getAttribute !== 'function') return
    const field = target.getAttribute('data-ana-field')
    if (field === null || field === '') return
    engine.setField(String(field), target.value)
  }

  const onPointerDown = (event) => {
    if (event.button !== 0) return
    const target = event.target
    if (target === undefined || target === null || typeof target.closest !== 'function') return
    if (target.closest('.ana-bar.ana-drag') === null) return
    if (target.closest('button,select,input') !== null) return
    if (typeof opts.beginDrag === 'function') opts.beginDrag(event)
  }

  const onPointerUp = () => {
    if (typeof opts.endDrag === 'function') opts.endDrag()
  }

  node.addEventListener('click', onClick)
  node.addEventListener('change', onChange)
  node.addEventListener('pointerdown', onPointerDown)
  node.addEventListener('pointerup', onPointerUp)
  return () => {
    node.removeEventListener('click', onClick)
    node.removeEventListener('change', onChange)
    node.removeEventListener('pointerdown', onPointerDown)
    node.removeEventListener('pointerup', onPointerUp)
  }
}

/** 小图标（内联 SVG，跟随 currentColor）。 */
const ANA_ICON = Object.freeze({
  refresh: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.9"/><path d="M13.6 2.2v3.1h-3.1"/></svg>',
  close: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>',
  zoomIn: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.4"/><path d="M10.4 10.4L14 14M7 5.2v3.6M5.2 7h3.6"/></svg>',
  zoomOut: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.4"/><path d="M10.4 10.4L14 14M5.2 7h3.6"/></svg>',
  fit: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>',
  dashboard: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 2.5h5v5h-5zM8.5 2.5h5v3h-5zM2.5 9.5h5v4h-5zM8.5 7.5h5v6h-5z"/></svg>',
  graph: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="3.4" cy="12" r="1.7"/><circle cx="8" cy="4" r="1.9"/><circle cx="12.8" cy="10.4" r="1.5"/><path d="M4.6 10.7 6.9 5.7M9.6 4.9l2.7 4.2"/></svg>',
})

/** 带图标的功能按钮。 */
function toolButton(action, label, icon, opts) {
  const options = opts === undefined || opts === null ? {} : opts
  const pressed = options.pressed === true ? ' aria-pressed="true"' : ''
  const extra = options.attrs === undefined ? '' : ' ' + options.attrs
  return '<button type="button" class="ana-btn' + (options.iconOnly === true ? ' ana-icon' : '') + '"'
    + ' data-ana-action="' + esc(action) + '"' + pressed + extra
    + ' title="' + esc(options.hint ?? label) + '">' + (icon ?? '') + esc(label) + '</button>'
}

/** 下拉框。 */
function toolSelect(field, label, value, options, hint) {
  const body = options.map((item) => '<option value="' + esc(item.value) + '"'
    + (String(item.value) === String(value) ? ' selected' : '') + '>' + esc(item.label) + '</option>').join('')
  return '<label class="ana-field" title="' + esc(hint ?? label) + '">' + esc(label)
    + '<select class="ana-input" data-ana-field="' + esc(field) + '">' + body + '</select></label>'
}

/** 数字输入。 */
function toolNumber(field, label, value, min, max, hint) {
  return '<label class="ana-field" title="' + esc(hint ?? label) + '">' + esc(label)
    + '<input class="ana-input ana-input--w" type="number" data-ana-field="' + esc(field) + '"'
    + ' min="' + esc(min) + '" max="' + esc(max) + '" value="' + esc(value) + '"></label>'
}

/**
 * 视图切换（仪表盘 / 图表）。
 * @param {string} view
 * @returns {string}
 */
function viewSwitch(view) {
  return '<div class="ana-zoom">'
    + '<button type="button" class="ana-btn" data-ana-action="view-dashboard"'
    + (view === 'dashboard' ? ' aria-pressed="true"' : '') + ' title="看整体状态：规模、生命周期、策略、日志">'
    + ANA_ICON.dashboard + '仪表盘</button>'
    + '<button type="button" class="ana-btn" data-ana-action="view-graph"'
    + (view === 'graph' ? ' aria-pressed="true"' : '') + ' title="看关系与流转：记忆图谱、生命周期、策略时间线">'
    + ANA_ICON.graph + '图表</button>'
    + '</div>'
}

/**
 * 工具栏。控件随视图变化：仪表盘有宽度，图表有图种/方向/缩放/节点上限。
 * @param {any} state
 * @returns {string}
 */
function renderToolbarHtml(state) {
  const view = state.view === 'graph' ? 'graph' : 'dashboard'
  const parts = [viewSwitch(view), '<span class="ana-sep"></span>']
  if (view === 'graph') {
    parts.push(toolSelect('kind', '图种', state.kind, [
      { value: 'memory-graph', label: zhDiagramKind('memory-graph') },
      { value: 'strategy-timeline', label: zhDiagramKind('strategy-timeline') },
      { value: 'lifecycle', label: zhDiagramKind('lifecycle') },
    ], zhDiagramHint(state.kind)))
    parts.push(toolSelect('direction', '方向', state.direction, [
      { value: 'LR', label: '横向（从左到右）' },
      { value: 'TB', label: '纵向（从上到下）' },
    ], '关系图的排布方向；节点多的时候横向更好读'))
    parts.push('<span class="ana-zoom">'
      + toolButton('zoom-out', '', ANA_ICON.zoomOut, { iconOnly: true, hint: '缩小图表' })
      + toolButton('zoom-reset', Math.round(Number(state.zoom ?? 1) * 100) + '%', null, { hint: '恢复到 100%' })
      + toolButton('zoom-in', '', ANA_ICON.zoomIn, { iconOnly: true, hint: '放大图表' })
      + '</span>')
    parts.push(toolNumber('maxNodes', '节点', state.maxNodes, 4, 200, '最多画多少个记忆节点（按重要度取前 N 个）；超出的部分不画，但悬空引用会保留'))
  } else {
    parts.push(toolNumber('width', '宽度', state.width, 48, 200, '终端帧的宽度；只影响 ana_dashboard 的文本视图'))
  }
  parts.push(toolSelect('redaction', '脱敏', state.redaction, [
    { value: 'secrets', label: zhRedaction('secrets') },
    { value: 'strict', label: zhRedaction('strict') },
    { value: 'none', label: zhRedaction('none') },
  ], zhRedactionHint(state.redaction)))
  parts.push('<span class="ana-spacer"></span>')
  parts.push(toolButton('refresh', '刷新', ANA_ICON.refresh, { hint: '立刻重新读取一次存储' }))
  parts.push(toolButton('close', '关闭', ANA_ICON.close, { hint: '关闭这个窗口（席位保留，入口还在）' }))
  return '<div class="ana-bar">' + parts.join('') + '</div>'
}

/**
 * 版本偏斜时的降级视图：Host 半还只会 `frame` / `diagram`（只提供文本），
 * 客户端半已经是新版。
 *
 * 这不是"可选的美化"：客户端半由 `dsh-client-modules` 热替换，Host 半要重启桌面端
 * 才会重新导入 —— 中间那段时间两边版本不一致是**必然**会发生的。此时窗口必须
 * 显示能看的东西加一句解释，而不是一句"未知方法"的报错。
 * @param {string} text
 * @param {string} note
 * @returns {string}
 */
function renderTextFallbackHtml(text, note) {
  return notice(note, 'warn') + '<pre class="ana-text">' + esc(text) + '</pre>'
}

/**
 * 标题栏。
 * @param {{ title: string, subtitle?: string }} opts
 * @returns {string}
 */
function renderTitlebarHtml(opts) {
  return '<div class="ana-bar ana-drag" data-ana-drag="1">'
    + '<span class="ana-title">' + esc(opts.title)
    + (opts.subtitle === undefined || opts.subtitle === '' ? '' : '<span class="ana-sect-hint">　' + esc(opts.subtitle) + '</span>')
    + '</span>'
    + '<span class="ana-btn ana-icon" aria-hidden="true" title="按住这里拖动窗口">⠿</span>'
    + '</div>'
}

/**
 * 页脚状态行。
 * @param {any} state
 * @returns {string}
 */
function renderFooterHtml(state) {
  const parts = []
  parts.push('<span title="这一屏的数据来自哪里">' + esc(zhOrigin(state.origin)) + '</span>')
  parts.push('<span title="存储版本号；每次写入都会推进">版本 v' + esc(zhCount(state.storeVersion)) + '</span>')
  parts.push('<span title="上一次成功渲染的时间">'
    + esc(Number(state.lastAt) > 0 ? zhAge(Date.now() - Number(state.lastAt)) + '刷新' : '尚未渲染') + '</span>')
  if (state.busy === true) parts.push('<span class="ana-c-dim">读取中…</span>')
  if (String(state.degraded ?? '') !== '') {
    parts.push('<span class="ana-warn-text" title="Host 半还是旧版本，只能给出文本；重启桌面端后恢复图形视图">降级为文本视图</span>')
  }
  const warnings = Array.isArray(state.warnings) ? state.warnings : []
  if (warnings.length > 0) parts.push('<span class="ana-warn-text" title="' + esc(warnings.join('；')) + '">' + warnings.length + ' 条提示</span>')
  if (String(state.error ?? '') !== '') parts.push('<span class="ana-error-text" title="' + esc(state.error) + '">读取失败：' + esc(clip(state.error, 60)) + '</span>')
  return '<div class="ana-foot">' + parts.join('') + '</div>'
}