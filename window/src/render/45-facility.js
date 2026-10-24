/**
 * 设施视图（运维仪表盘）—— 渲染层第 4.5 部分。
 *
 * 设计参考：Kombai 画廊的 GridSense（智能楼宇运维台）——Bauhaus 式平面几何、
 * 冷调石板白画布 + 黑色金属框、信号黄 / 红 / 蓝系统标记、等宽数字；布局是
 * **左侧图标栏 / 中央平面图 / 右侧分区详情 / 上下状态条**。
 *
 * 迁移的是**这套排版与配色语言**，不是那栋楼的内容。在这里：
 *
 *   楼 = 存储      楼层 = 命名空间（当前项目 / 全局 / 每个会话）
 *   分区 = 记忆类型  传感器 = 一条活跃记忆
 *   读数 = 显著度 / 置信度 / 新鲜度（不是温度、湿度、勒克斯 —— 我们只画真的东西）
 *   能耗对比 = 本分区单条记录的能量 vs 全楼基线（基线是实测均值，不是拍的指标）
 *   告警 = 矛盾链接 / 即将过期 / 高显著但陈旧 / 悬空链接 / 锁定 / 安全模式
 *   电文 = 日志尾部的事件流
 *
 * 规则和仪表盘一样：**颜色只编码身份与健康度，比例只来自模型里的数字**。
 * 这里不出现裸字符串插值，一切走 `esc()`。
 */

/** 状态 → 传感器颜色（沿用主题的语义色名，不另造一套）。 */
const GX_STATE_TONE = Object.freeze({
  draft: 'warn',
  active: 'info',
  verified: 'okBright',
  locked: 'violet',
  deprecated: 'dim',
  expired: 'bad',
  retired: 'dim',
})

/** 告警级别 → 主题色。 */
const GX_LEVEL_TONE = Object.freeze({ alert: 'bad', warn: 'warn', info: 'info' })

/**
 * 告警文案 —— **中文层**。模型给的是英文短语（`title` / `detail`），窗口以 `code`
 * 为键翻译：模型的默认语言必须保持 en，否则别的消费者（终端帧、`ana_dashboard`）
 * 会跟着变。数量来自模型的 `count`，不是从英文句子里解析出来的。
 * @param {any} item
 * @returns {{ title: string, detail: string }}
 */
function gxAnomalyText(item) {
  const code = String(item?.code ?? '')
  const count = gxNum(item?.count)
  if (code === 'safe-mode') return { title: '安全模式已启用', detail: '策略切换与自调参被冻结；记忆本身照常工作' }
  if (code === 'contradiction') return { title: count + ' 条互相矛盾的链接', detail: '两条记录说法相反且都还活着 —— 先解决，再信其中任何一条' }
  if (code === 'expiring') return { title: count + ' 条记录将在 24 小时内过期', detail: '过期后不再被注入；要保留就提升或钉住' }
  if (code === 'stale-hot') return { title: count + ' 条"很响但很旧"的记录', detail: '显著度高、30 天没动过 —— 用之前先核实' }
  if (code === 'orphan-link') return { title: count + ' 条链接指向不存在的记录', detail: '目标被遗忘或从未存在；图谱里会看到悬空的边' }
  if (code === 'locked') return { title: count + ' 条钉住的记录', detail: '锁定的记录不会衰减；离开当前状态需要理由与 force' }
  if (code === 'read-only') return { title: '只读档位', detail: '没有生效的预设许可，模型看不到写入工具' }
  if (code === 'unredacted') return { title: '脱敏已关闭', detail: '这一屏可能包含凭据 —— 不要截图或外传' }
  if (code === 'empty') return { title: '还没有记忆', detail: '存储是健康的，只是空的 —— 第一笔写入会造出第一层楼' }
  return { title: String(item?.title ?? code), detail: String(item?.detail ?? '') }
}

/** 楼层层级 → 短代号。 */
const GX_TIER_CODE = Object.freeze({ project: 'P', global: 'G', session: 'S' })

/** @param {unknown} value @returns {number} */
function gxNum(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 0–1 夹紧，用于条宽。 */
function gxFill(ratio) {
  return Math.max(0, Math.min(1, gxNum(ratio))) * 100
}

/** 把毫秒折成 `2h` / `3d` 这类短读数（等宽字体里对齐）。 */
function gxAgeShort(ms) {
  const value = Math.max(0, gxNum(ms))
  if (value < 60_000) return Math.round(value / 1000) + 's'
  if (value < 3_600_000) return Math.round(value / 60_000) + 'm'
  if (value < 86_400_000) return Math.round(value / 3_600_000) + 'h'
  return Math.round(value / 86_400_000) + 'd'
}

/** 小时数 → 短读数。 */
function gxHours(hours) {
  const value = Math.max(0, gxNum(hours))
  if (value < 1) return Math.round(value * 60) + 'm'
  if (value < 48) return Math.round(value) + 'h'
  return Math.round(value / 24) + 'd'
}

/** `HH:MM`，取模型自己的时钟（不是浏览器时钟 —— 截图才可复现）。 */
function gxClock(at) {
  const date = new Date(gxNum(at))
  const pad = (value) => String(value).padStart(2, '0')
  return pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/**
 * 一个分区的健康度：有值得处理的事就是红的，有草稿就是黄的，否则是蓝的。
 * @param {any} zone
 * @returns {'bad'|'warn'|'ok'}
 */
function gxZoneHealth(zone) {
  const states = zone?.states ?? {}
  if (gxNum(states.expired) > 0 || gxNum(states.deprecated) > 0) return 'bad'
  if (gxNum(states.draft) > 0) return 'warn'
  return 'ok'
}

/**
 * 图标（内联 SVG，几何、无圆角，跟随 currentColor）。
 * @param {string} name
 */
function gxIcon(name) {
  if (name === 'floor') {
    return '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">'
      + '<rect x="2.2" y="2.2" width="11.6" height="11.6"/><path d="M2.2 8h11.6M8 2.2v11.6"/></svg>'
  }
  if (name === 'stack') {
    return '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">'
      + '<rect x="2.2" y="2.4" width="11.6" height="3.2"/><rect x="2.2" y="6.4" width="11.6" height="3.2"/>'
      + '<rect x="2.2" y="10.4" width="11.6" height="3.2"/></svg>'
  }
  if (name === 'graph') {
    return '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">'
      + '<circle cx="3.4" cy="12" r="1.7"/><circle cx="8" cy="4" r="1.9"/><circle cx="12.8" cy="10.4" r="1.5"/>'
      + '<path d="M4.6 10.7 6.9 5.7M9.6 4.9l2.7 4.2"/></svg>'
  }
  if (name === 'refresh') {
    return '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true">'
      + '<path d="M13.4 8a5.4 5.4 0 1 1-1.7-3.9"/><path d="M13.6 2.3v3.1h-3.1"/></svg>'
  }
  return '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" aria-hidden="true">'
    + '<path d="M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2"/></svg>'
}

/**
 * 顶部状态条。
 * @param {any} model
 * @param {string} view
 */
function gxTopBar(model, view) {
  const building = model?.building ?? {}
  const metrics = model?.metrics ?? {}
  const floor = Array.isArray(model?.floors) && model.floors.length > 0 ? model.floors[0] : null
  const mirror = building.mirror !== false
  const alerts = Array.isArray(model?.anomalies) ? model.anomalies.filter((item) => item.level === 'alert').length : 0
  const kvs = [
    ['项目', floor === null ? '—' : String(floor.label), floor === null ? '' : String(floor.detail ?? '')],
    ['记录', String(gxNum(metrics.records)), '活跃 ' + gxNum(metrics.live)],
    ['版本', 'v' + gxNum(building.storeVersion), '结构 v' + gxNum(building.schemaVersion)],
  ]
  const cells = kvs.map(([key, value, hint]) => '<span class="gx-kv" title="' + esc(hint) + '">'
    + '<i>' + esc(key) + '</i><b>' + esc(value) + '</b></span>').join('')
  return '<header class="gx-top">'
    + '<div class="gx-brand">'
    + '<span class="gx-mark" aria-hidden="true"><i></i><i></i><i></i></span>'
    + '<span class="gx-brand-name">ANAGENESIS</span>'
    + '<span class="gx-brand-sub">记忆设施 · ' + esc(view === 'facility' ? 'FLOORPLAN' : view === 'graph' ? 'GRAPH' : 'OVERVIEW') + '</span>'
    + '</div>'
    + '<div class="gx-topmeta">' + cells
    + (alerts > 0 ? '<span class="gx-pill gx-pill--bad" title="有需要立刻处理的事项">' + alerts + ' ALERT</span>' : '<span class="gx-pill gx-pill--ok" title="没有需要立刻处理的事项">CLEAR</span>')
    + '<span class="gx-pill' + (mirror ? ' gx-pill--warn' : ' gx-pill--ok') + '" title="只读镜像：不持有写锁，也不会写一个字节">' + (mirror ? 'MIRROR' : 'SERVICE') + '</span>'
    + '<span class="gx-clock" title="模型生成时间">' + esc(gxClock(model?.generatedAt)) + '</span>'
    + '</div></header>'
}

/**
 * 左侧图标栏。按钮走 `data-ana-action`，由窗口根节点上的原生事件委托接住。
 * @param {string} view
 */
function gxRail(view) {
  const item = (action, icon, label, active, hint) => '<button type="button" class="gx-rail-btn' + (active ? ' gx-rail-btn--on' : '') + '"'
    + ' data-ana-action="' + esc(action) + '" aria-pressed="' + (active ? 'true' : 'false') + '" title="' + esc(hint) + '">'
    + gxIcon(icon) + '<span class="gx-rail-label">' + esc(label) + '</span></button>'
  return '<nav class="gx-rail" aria-label="视图切换">'
    + item('view-facility', 'floor', '平面', view === 'facility', '设施视图：楼层 / 分区 / 传感器')
    + item('view-dashboard', 'stack', '体检', view === 'dashboard', '存储体检：规模、生命周期、策略、日志')
    + item('view-graph', 'graph', '图谱', view === 'graph', '关系与流转：记忆图谱、生命周期、策略时间线')
    + '<span class="gx-rail-gap"></span>'
    + item('refresh', 'refresh', '刷新', false, '立刻重新读取一次存储')
    + item('close', 'close', '关闭', false, '关闭这个窗口（入口还在）')
    + '</nav>'
}

/**
 * 一条楼层里的分区块。宽度按分区占比走，最小 22%，这样"很小但有事"的分区不会被挤没。
 * @param {any} floor
 * @param {any} zone
 * @param {boolean} selected
 * @param {any} sensorById
 */
function gxZone(floor, zone, selected, sensorById) {
  const health = gxZoneHealth(zone)
  // 占比下限 9%：再小也要看得见（方块 tooltip 与右侧详情仍是全量数字）。
  const width = Math.max(9, Math.min(100, gxFill(zone?.share ?? 0)))
  const dots = []
  const ids = Array.isArray(zone?.sensorIds) ? zone.sensorIds : []
  for (const id of ids) {
    const sensor = sensorById.get(String(id))
    if (sensor === undefined) continue
    dots.push('<span class="gx-dot gx-dot--' + esc(GX_STATE_TONE[sensor.state] ?? 'dim') + '" title="'
      + esc(sensor.label + ' · ' + zhKind(sensor.kind) + '/' + zhState(sensor.state) + ' · 显著度 ' + sensor.salience + ' · ' + gxHours(sensor.ageHours) + '前')
      + '"></span>')
  }
  const tip = zhKind(zone.kind) + ' · ' + gxNum(zone.live) + '/' + gxNum(zone.count) + ' 活跃'
    + ' · 显著度 ' + Number(zone.salience ?? 0).toFixed(2)
    + ' · 置信度 ' + Number(zone.confidence ?? 0).toFixed(2)
    + ' · 单条能量 ' + Number(zone.energyRatio ?? 0).toFixed(2) + '× 基线'
    + ' · ' + gxHours(zone.freshnessHours) + '内更新过'
  return '<button type="button" class="gx-zone gx-zone--' + esc(health) + (selected ? ' gx-zone--on' : '') + '"'
    + ' data-ana-action="zone:' + esc(String(zone.id)) + '"'
    + ' style="--gx-zone-w:' + width.toFixed(1) + '%"'
    + ' aria-pressed="' + (selected ? 'true' : 'false') + '" title="' + esc(tip) + '">'
    + '<span class="gx-zone-strip"></span>'
    + '<span class="gx-zone-body">'
    + '<span class="gx-zone-name">' + esc(zhKind(zone.kind)) + '</span>'
    + '<span class="gx-zone-num">' + gxNum(zone.live) + '<small>/' + gxNum(zone.count) + '</small></span>'
    + '<span class="gx-zone-bar"><i style="width:' + gxFill(zone.salience).toFixed(0) + '%"></i></span>'
    + '<span class="gx-zone-dots">' + (dots.length === 0 ? '<span class="gx-dot gx-dot--none"></span>' : dots.join('')) + '</span>'
    + '</span>'
    + '<span class="gx-zone-floor" title="本格占这一层的条数比例">' + Math.round(gxFill(zone?.share ?? 0)) + '%</span>'
    + '</button>'
}

/**
 * 平面图画布。
 * @param {any} model
 * @param {{ floor: any, zone: any }} selection
 */
function gxCanvas(model, selection) {
  const floors = Array.isArray(model?.floors) ? model.floors : []
  const sensorById = new Map((Array.isArray(model?.sensors) ? model.sensors : []).map((sensor) => [String(sensor.id), sensor]))
  const legend = '<div class="gx-legend">'
    + '<span class="gx-legend-item"><i class="gx-swatch gx-swatch--ok"></i>健康</span>'
    + '<span class="gx-legend-item"><i class="gx-swatch gx-swatch--warn"></i>有草稿</span>'
    + '<span class="gx-legend-item"><i class="gx-swatch gx-swatch--bad"></i>有异常</span>'
    + '<span class="gx-legend-item"><i class="gx-swatch gx-swatch--ink"></i>每格宽度 = 分区占比</span>'
    + '</div>'
  const head = '<div class="gx-canvas-head">'
    + '<div><span class="gx-kicker">FLOORPLAN</span><h2 class="gx-h2">楼层平面</h2></div>'
    + legend
    + '</div>'
  if (floors.length === 0) {
    return '<main class="gx-canvas">' + head
      + '<div class="gx-empty"><b>还没有任何楼层</b><span>存储是空的 —— 第一笔记忆写进来，这里就会出现第一层楼与第一个分区。</span></div>'
      + '</main>'
  }
  const hidden = gxNum(model?.building?.floors) - floors.length
  const parts = floors.map((floor, index) => {
    const zones = Array.isArray(floor.zones) ? floor.zones : []
    const selectedFloor = selection?.floor !== null && selection?.floor?.id === floor.id
    const code = GX_TIER_CODE[floor.tier] ?? '?'
    const zoneHtml = zones.map((zone) => gxZone(floor, zone, selectedFloor && selection.zone?.id === zone.id, sensorById)).join('')
    return '<section class="gx-floor' + (selectedFloor ? ' gx-floor--on' : '') + '">'
      + '<div class="gx-floor-head">'
      + '<span class="gx-floor-no">' + String(index + 1).padStart(2, '0') + '</span>'
      + '<span class="gx-floor-name">' + esc(floor.label) + '</span>'
      + '<span class="gx-floor-tag">' + esc(code) + ' · ' + esc(zhTier(floor.tier)) + '</span>'
      + '<span class="gx-floor-meta">' + gxNum(floor.live) + '/' + gxNum(floor.count) + ' 活跃　·　单条能量 '
      + (gxNum(floor.zones.reduce((sum, zone) => sum + gxNum(zone.energy), 0)) / Math.max(1, gxNum(floor.live))).toFixed(2) + '× 基线</span>'
      + '<span class="gx-floor-bar"><i style="width:' + gxFill(floor.share).toFixed(0) + '%"></i></span>'
      + '</div>'
      + '<div class="gx-zones">' + zoneHtml + '</div>'
      + '</section>'
  }).join('')
  const note = hidden > 0
    ? '<div class="gx-canvas-note">还有 ' + hidden + ' 层没有画 —— 楼层上限 ' + floors.length + '。调大 floorCap 或减少命名空间。</div>'
    : ''
  return '<main class="gx-canvas">' + head + '<div class="gx-floors">' + parts + '</div>' + note + '</main>'
}

/**
 * 右侧分区详情柱。
 * @param {any} model
 * @param {{ floor: any, zone: any }} selection
 */
function gxDetail(model, selection) {
  const floor = selection?.floor ?? null
  const zone = selection?.zone ?? null
  if (floor === null || zone === null) {
    return '<aside class="gx-detail"><div class="gx-detail-head"><span class="gx-kicker">ZONE</span><h3 class="gx-h3">分区详情</h3></div>'
      + '<p class="gx-detail-empty">这一屏没有可展开的分区。</p></aside>'
  }
  const sensorById = new Map((Array.isArray(model?.sensors) ? model.sensors : []).map((sensor) => [String(sensor.id), sensor]))
  const readout = (label, value, unit, ratio, hint) => '<div class="gx-readout" title="' + esc(hint) + '">'
    + '<span class="gx-readout-label">' + esc(label) + '</span>'
    + '<span class="gx-readout-value">' + esc(value) + '<small>' + esc(unit) + '</small></span>'
    + '<span class="gx-readout-bar"><i style="width:' + gxFill(ratio).toFixed(0) + '%"></i></span>'
    + '</div>'
  const readouts = '<div class="gx-readouts">'
    + readout('显著度', Number(zone.salience ?? 0).toFixed(2), 'SAL', zone.salience, '被召回时的权重（0–1）；同一分区里取活跃记录的平均值')
    + readout('置信度', Number(zone.confidence ?? 0).toFixed(2), 'CONF', zone.confidence, '这条分区里的记录有多可信（0–1）；低于 0.4 不会被注入')
    + readout('新鲜度', gxHours(zone.freshnessHours), 'AGE', 1 - Math.min(1, gxNum(zone.freshnessHours) / (24 * 30)), '活跃记录平均多久没更新；条越长越新（30 天归零）')
    + '</div>'

  // 能量 vs 基线：同一层楼里每个分区的单条能量，基线固定在 1.00×。
  const siblings = Array.isArray(floor.zones) ? floor.zones : []
  const energyRows = siblings.map((item) => {
    const ratio = gxNum(item.energyRatio)
    const width = Math.max(0, Math.min(100, (ratio / 2) * 100))
    return '<div class="gx-energy-row' + (item.id === zone.id ? ' gx-energy-row--on' : '') + '" title="'
      + esc(zhKind(item.kind) + '：单条记录能量 ' + ratio.toFixed(2) + '× 全楼基线（显著度 × 置信度，按活跃记录求平均）') + '">'
      + '<span class="gx-energy-name">' + esc(zhKind(item.kind)) + '</span>'
      + '<span class="gx-energy-bar"><i style="width:' + width.toFixed(0) + '%"></i>'
      + '<b class="gx-energy-base" style="left:50%"></b></span>'
      + '<span class="gx-energy-num">' + ratio.toFixed(2) + '</span>'
      + '</div>'
  }).join('')
  const energy = '<div class="gx-block">'
    + '<div class="gx-block-head"><span class="gx-kicker">ENERGY / BASELINE</span><span class="gx-block-note">黄 = 本层 · 黑线 = 全楼 1.00×</span></div>'
    + energyRows + '</div>'

  const ids = Array.isArray(zone.sensorIds) ? zone.sensorIds : []
  const sensorRows = ids.map((id) => sensorById.get(String(id))).filter((sensor) => sensor !== undefined).slice(0, 4).map((sensor) => {
    const expires = sensor.expiresInHours === null ? '' : '<span class="gx-sensor-exp">' + gxHours(sensor.expiresInHours) + '后过期</span>'
    return '<li class="gx-sensor">'
      + '<span class="gx-dot gx-dot--' + esc(GX_STATE_TONE[sensor.state] ?? 'dim') + '"></span>'
      + '<span class="gx-sensor-main"><b>' + esc(clip(sensor.label, 42)) + '</b>'
      + '<small>' + esc(zhState(sensor.state)) + ' · 显著度 ' + sensor.salience.toFixed(2) + ' · ' + gxHours(sensor.ageHours) + '前' + expires + '</small></span>'
      + '</li>'
  }).join('')
  const sensorBlock = '<div class="gx-block">'
    + '<div class="gx-block-head"><span class="gx-kicker">SENSORS</span><span class="gx-block-note">' + gxNum(zone.live) + ' 条活跃</span></div>'
    + (sensorRows === '' ? '<p class="gx-detail-empty">这一格没有活跃记录。</p>' : '<ul class="gx-sensors">' + sensorRows + '</ul>')
    + '</div>'

  const anomalies = Array.isArray(model?.anomalies) ? model.anomalies.slice(0, 4) : []
  const alertRows = anomalies.map((item) => {
    const text = gxAnomalyText(item)
    return '<li class="gx-alert gx-alert--' + esc(item.level) + '">'
      + '<span class="gx-alert-dot gx-dot--' + esc(GX_LEVEL_TONE[item.level] ?? 'dim') + '"></span>'
      + '<span class="gx-alert-main"><b>' + esc(text.title) + '</b><small>' + esc(text.detail) + '</small></span>'
      + '</li>'
  }).join('')
  const alerts = '<div class="gx-block">'
    + '<div class="gx-block-head"><span class="gx-kicker">ANOMALIES</span><span class="gx-block-note">'
    + gxNum(model?.anomaliesTotal) + ' 条</span></div>'
    + (alertRows === '' ? '<p class="gx-detail-empty">没有需要处理的异常。</p>' : '<ul class="gx-alerts">' + alertRows + '</ul>')
    + '</div>'

  return '<aside class="gx-detail">'
    + '<div class="gx-detail-head">'
    + '<span class="gx-kicker">ZONE DETAIL</span>'
    + '<h3 class="gx-h3">' + esc(zhKind(zone.kind)) + '</h3>'
    + '<span class="gx-detail-sub">' + esc(floor.label) + ' · ' + esc(zhTier(floor.tier)) + ' · ' + gxNum(zone.live) + '/' + gxNum(zone.count) + ' 活跃</span>'
    + '</div>'
    + readouts + energy + sensorBlock + alerts
    + '</aside>'
}

/**
 * 底部状态条：实时电文 + 计数。
 * @param {any} model
 */
function gxTicker(model) {
  const ticker = Array.isArray(model?.ticker) ? model.ticker : []
  const metrics = model?.metrics ?? {}
  const mirror = model?.building?.mirror !== false
  const items = ticker.length === 0
    ? '<span class="gx-wire-item"><b>—</b>还没有事件</span>'
    : ticker.map((event) => '<span class="gx-wire-item"><b>#' + gxNum(event.seq) + '</b>'
      + esc(zhEvent(event.type)) + '<i>' + gxAgeShort(event.ageMs) + '前</i></span>').join('')
  return '<footer class="gx-wire">'
    + '<span class="gx-wire-live' + (mirror ? ' gx-wire-live--mirror' : '') + '" title="' + esc(mirror ? '只读镜像正在轮询文件' : '来自运行中的服务') + '">'
    + '<i></i>' + (mirror ? 'MIRROR' : 'LIVE') + '</span>'
    + '<div class="gx-wire-track"><div class="gx-wire-run">' + items + '</div><div class="gx-wire-run" aria-hidden="true">' + items + '</div></div>'
    + '<span class="gx-wire-count">' + gxNum(metrics.records) + ' 条 · ' + gxNum(metrics.events) + ' 事件</span>'
    + '</footer>'
}

/**
 * 选中哪个分区：调用方点过的那个；否则是能量最高的那个（"最响的一格"）。
 * @param {any} model
 * @param {string} wanted
 * @returns {{ floor: any, zone: any }}
 */
function gxResolveSelection(model, wanted) {
  const floors = Array.isArray(model?.floors) ? model.floors : []
  if (floors.length === 0) return { floor: null, zone: null }
  if (typeof wanted === 'string' && wanted !== '') {
    for (const floor of floors) {
      for (const zone of Array.isArray(floor.zones) ? floor.zones : []) {
        if (zone.id === wanted) return { floor: floor, zone: zone }
      }
    }
  }
  let best = { floor: floors[0], zone: null }
  let bestEnergy = -1
  for (const floor of floors) {
    for (const zone of Array.isArray(floor.zones) ? floor.zones : []) {
      if (gxNum(zone.live) === 0) continue
      if (gxNum(zone.energy) > bestEnergy) {
        bestEnergy = gxNum(zone.energy)
        best = { floor: floor, zone: zone }
      }
    }
  }
  if (best.zone === null) best = { floor: floors[0], zone: (floors[0].zones ?? [])[0] ?? null }
  return best
}

/**
 * 整屏设施视图。
 * @param {any} model `buildFacilityModel()` 的产物
 * @param {{ view?: string, zone?: string }} [opts]
 * @returns {string} HTML
 */
function renderFacilityHtml(model, opts) {
  const options = opts === undefined || opts === null ? {} : opts
  const view = typeof options.view === 'string' && options.view !== '' ? options.view : 'facility'
  const selection = gxResolveSelection(model, typeof options.zone === 'string' ? options.zone : '')
  return '<div class="gx-shell">'
    + gxTopBar(model, view)
    + '<div class="gx-body">'
    + gxRail(view)
    + gxCanvas(model, selection)
    + gxDetail(model, selection)
    + '</div>'
    + gxTicker(model)
    + '</div>'
}

/**
 * 页脚一句话（给 `ana_window` 的 `status` 与测试用）。
 * @param {any} model
 * @returns {string}
 */
function facilitySummary(model) {
  const metrics = model?.metrics ?? {}
  const building = model?.building ?? {}
  return [
    '记录 ' + gxNum(metrics.records) + ' 条',
    '活跃 ' + gxNum(metrics.live),
    '楼层 ' + gxNum(building.floorsShown) + '/' + gxNum(building.floors),
    '告警 ' + gxNum(model?.anomaliesTotal),
    '版本 v' + gxNum(building.storeVersion),
  ].join('　·　')
}
