/**
 * 仪表盘渲染器 —— 渲染层第 4 部分。
 *
 * 输入是 `buildDashboardModel()` 的**结构化模型**（分区 + 行 + 数值 + 进度比例），
 * 输出是一段 HTML。没有任何一处把模型里已有的比例再猜一遍 —— `bar` 字段就是比例，
 * 颜色来自行上的 `tone` 或状态/类型枚举。
 *
 * 关于"英文值"的处理，规则写在 `zhValue()`：模型的 `value` 是给人看的自由文本，
 * 里面嵌了版本号、计数、状态词。我不改模型（TUI 与工具输出必须一字不变），而是在
 * 渲染层按**已知标签**逐个格式化，并对未知形状做一次通用 token 替换后原样透出。
 * `test/i18n.test.mjs` 用真实模型跑一遍并断言输出里不再出现英文术语 —— 漂移会被
 * 那张黑名单抓住，而不是靠人眼。
 */

/** 模型里的自由文本标签 → 中文。 */
const DASH_LABEL_ZH = Object.freeze({
  store: '存储',
  memories: '记忆',
  'safe mode': '安全模式',
  origin: '数据来源',
  journal: '日志',
  pruned: '已剪枝',
  segments: '日志段',
  'pruned through': '剪枝至',
  metric: '综合指标',
  samples: '样本数',
  applied: '已应用次数',
  '(knobs)': '调参项',
  mode: '运行模式',
  renders: '渲染次数',
  diagrams: '图表次数',
  'last render': '上次渲染',
  errors: '错误数',
  redaction: '脱敏级别',
  'live TUI': '实时终端视图',
  global: '全局',
  active: '生效中',
  health: '健康度',
  registered: '已注册策略',
  'pruned through seq': '剪枝至序号',
  '(no memories yet)': '（还没有记忆）',
})

/** 通用短语替换：嵌在自由文本里的固定说法。 */
const PHRASE_ZH = Object.freeze([
  ['(meta frozen)', '（元层冻结）'],
  ['(read-only)', '（只读）'],
  ['(default)', '（默认值）'],
  ['(none)', '（无）'],
  ['(empty)', '（空）'],
  ['(no memories yet)', '（还没有记忆）'],
  ['not available in a read-only mirror', '只读镜像下不可用'],
  ['ok — no strategy quarantined', '正常 —— 没有被隔离的策略'],
  ['all at their envelope defaults', '全部处于包络默认值'],
  ['never', '从未'],
  ['live', '活动'],
  ['archives', '归档段'],
  ['checkpoints', '检查点'],
  ['default', '默认'],
  ['ago', '前'],
  ['mode', '模式'],
])

/** @param {unknown} value @returns {string} */
function zhLabel(en) {
  const key = String(en ?? '')
  if (Object.prototype.hasOwnProperty.call(DASH_LABEL_ZH, key)) return DASH_LABEL_ZH[key]
  return zhTokens(key)
}

/**
 * 自由文本里的枚举与固定短语替换（兜底路径）。
 * 顺序很重要：先长短语，再单词，避免 `(read-only)` 被 `live` 之类的规则切碎。
 * @param {unknown} text
 * @returns {string}
 */
function zhTokens(text) {
  let out = String(text ?? '')
  for (const [from, to] of PHRASE_ZH) {
    if (out.indexOf(from) >= 0) out = out.split(from).join(to)
  }
  // 嵌入的枚举：状态、类型、策略、事件类型。
  out = out.replace(/\b(draft|active|verified|locked|deprecated|expired|retired)\b/g, (match) => zhState(match))
  out = out.replace(/\b(fact|preference|procedure|heuristic|episode|hypothesis|constraint|failure)\b/g, (match) => zhKind(match))
  out = out.replace(/\b(explore|exploit|debug|distill|guard|crisis)\b/g, (match) => zhStrategy(match))
  return out
}

/**
 * 按已知标签格式化 `value`。
 * @param {string} label 原始英文标签
 * @param {unknown} value
 * @param {any} model
 * @returns {string}
 */
function zhValue(label, value, model) {
  const raw = String(value ?? '')
  switch (label) {
    case 'store': {
      const match = raw.match(/^v(\d+)\s*·\s*schema v(\d+)$/)
      return match === null ? zhTokens(raw) : '版本 v' + match[1] + ' · 结构 v' + match[2]
    }
    case 'memories': {
      const match = raw.match(/^(\d+)\s*\((\d+) live\)$/)
      if (match === null) return zhTokens(raw)
      return match[1] + ' 条（' + match[2] + ' 条活跃）'
    }
    case 'safe mode':
      if (raw === 'off') return '已关闭'
      if (raw.indexOf('ON') === 0) return '已开启（元层冻结）'
      return zhTokens(raw)
    case 'origin':
      if (raw.indexOf('mirror') === 0) return '只读镜像（不写入）'
      if (raw === 'live') return '实时服务'
      return zhTokens(raw)
    case 'journal':
    case 'segments': {
      const match = raw.match(/^live (\d+) · archives (\d+) · checkpoints (\d+)$/)
      if (match === null) return zhTokens(raw)
      return '活动段 ' + match[1] + ' · 归档段 ' + match[2] + ' · 检查点 ' + match[3]
    }
    case 'pruned':
      return '序号 ≤ #' + raw.replace(/[^\d]/g, '') + ' 已被保留策略丢弃'
    case 'pruned through':
      return '#' + raw.replace(/[^\d]/g, '')
    case 'last render':
      return raw === 'never' ? '从未' : zhTokens(raw)
    case 'redaction':
      return zhRedaction(raw)
    case 'mode':
      return raw === 'watch' ? '独立监视进程' : raw === 'better-sidebar' ? '侧栏入口' : '内置工具'
    case 'errors': {
      const count = Number(raw)
      return count > 0 ? count + ' 次（需要看看）' : '0 次'
    }
    case 'metric':
      return raw
    case 'live TUI':
      if (raw.indexOf('Ctrl+C') === 0) return '按 Ctrl+C 结束 · 该进程不写入存储'
      if (raw.indexOf('node tools/viz-watch.mjs') === 0) return '在真终端里跑 node tools/viz-watch.mjs --watch（独立只读进程）'
      return zhTokens(raw)
    default:
      return zhTokens(raw)
  }
}

/** 模型里的告警句 → 中文。 */
function zhWarning(text) {
  const raw = String(text ?? '')
  const capped = raw.match(/^graph capped at (\d+) node\(s\)$/)
  if (capped !== null) return '节点数超出上限，只画了重要度最高的 ' + capped[1] + ' 个（把"节点上限"调大可以看到更多）'
  const window = raw.match(/^journal window shows (\d+) of (\d+) in-memory events$/)
  if (window !== null) return '日志窗口只显示内存中 ' + window[2] + ' 条事件里的 ' + window[1] + ' 条'
  if (raw.startsWith('read-only mirror')) return '只读镜像：引擎健康度、调参指标与日志计数来自文件，不是实时服务'
  if (raw.startsWith('redaction=none')) return '当前不做脱敏：这一屏可能含凭据，不要截图外发'
  const unknown = raw.match(/^unknown section "(.+)" ignored$/)
  if (unknown !== null) return '忽略了未知分区「' + unknown[1] + '」'
  return zhTokens(raw)
}

/**
 * 关键指标卡。四种"一眼要看到"的事实：规模、活跃比例、安全模式、数据来源。
 * @param {any} model
 * @returns {string}
 */
function dashboardCards(model) {
  const store = model.store ?? {}
  const total = Number(store.memories ?? 0)
  const live = Number(store.live ?? 0)
  const ratio = total > 0 ? live / total : 0
  const safe = store.safeMode === true
  const mirror = String(model.origin ?? 'live') !== 'live'
  const cards = [
    metricCard({
      label: '记忆总数', value: zhCount(total), unit: '条',
      sub: total === 0 ? '存储还是空的' : '全部生命周期状态合计',
      tone: 'accent', hint: '这个存储里的记忆条数，含草稿、已过期与已归档',
    }),
    metricCard({
      label: '活跃记忆', value: zhPercent(ratio), unit: live + '/' + total,
      sub: ratio >= 0.6 ? '结构健康' : ratio > 0 ? '有不少记录不可注入' : '没有可注入的记忆',
      tone: ratio >= 0.6 ? 'ok' : ratio > 0 ? 'warn' : 'bad',
      hint: '活跃 = 草稿 / 活跃 / 已验证 / 已锁定，这四种会被召回；其余不会被注入',
    }),
    metricCard({
      label: '安全模式', value: safe ? '已开启' : '已关闭',
      sub: safe ? '元层已冻结：策略与调参不再变化' : '元层可自我修改',
      tone: safe ? 'bad' : 'ok', hot: safe,
      hint: '安全模式开启时，策略切换与自调节被冻结 —— 这是出了问题时的那道刹车',
    }),
    metricCard({
      label: '存储版本', value: 'v' + zhCount(store.version),
      sub: '结构 v' + zhCount(store.schemaVersion),
      tone: 'plain', hint: '每次写入都会推进版本号；它也是 ana_audit 里的定位句柄',
    }),
    metricCard({
      label: '数据来源', value: mirror ? '只读镜像' : '实时服务',
      sub: mirror ? '直接读文件，不持有写锁' : '来自运行中的 anagenesis 服务',
      tone: mirror ? 'warn' : 'ok',
      hint: '只读镜像由本窗口的文件读取产生；它永远不会写入你的存储',
    }),
  ]
  return '<div class="ana-cards">' + cards.join('') + '</div>'
}

/**
 * 生命周期 / 类型分布：进度条 + 鲜明色块。比例、条宽、颜色三者同源。
 * @param {any} section
 * @param {string} kind  'state' | 'kind'
 * @returns {string}
 */
function barSection(section, kind) {
  const rows = Array.isArray(section.rows) ? section.rows : []
  const total = rows.reduce((sum, item) => sum + (kind === 'state' ? countFromValue(item.value) : Number(item.bar ?? 0)), 0)
  const out = []
  for (const item of rows) {
    const isState = kind === 'state'
    const count = isState ? countFromValue(item.value) : Math.round(Number(item.bar ?? 0) * maxBar(rows))
    const color = isState ? stateColor(item.label) : kindColor(item.label)
    const ratio = isState ? Number(item.bar ?? 0) : Number(item.bar ?? 0)
    out.push(barRow({
      label: isState ? zhState(item.label) : zhKind(item.label),
      color: color,
      ratio: ratio,
      count: zhCount(count),
      percent: isState ? zhPercent(item.bar, 1) : '',
      hint: isState ? zhStateHint(item.label) : '',
    }))
  }
  if (out.length === 0) return emptyState('没有数据', '存储里还没有记忆')
  void total
  return out.join('')
}

/** `"5 (83%)"` → `5`。 */
function countFromValue(value) {
  const match = String(value ?? '').match(/^(\d+)/)
  return match === null ? 0 : Number(match[1])
}

/** 类型分布用的是"占最大值"的比例，画条时反推计数。 */
function maxBar(rows) {
  let max = 1
  for (const item of rows) max = Math.max(max, Number(item.bar ?? 0))
  return max
}

/** 策略栈：把 `探索 → 护栏` 拆成色块链条，健康度单独成徽标。 */
function strategySectionBody(section) {
  const rows = Array.isArray(section.rows) ? section.rows : []
  const out = []
  for (const item of rows) {
    const label = zhLabel(item.label)
    const raw = String(item.value ?? '')
    if (item.label === 'health') {
      const bad = item.tone === 'bad'
      out.push('<div class="ana-row"><div class="ana-row-label">' + esc(label) + '</div><div class="ana-row-value">'
        + chip(bad ? 'bad' : item.tone === 'dim' ? 'dim' : 'ok', zhValue(item.label, raw, null)) + '</div><div></div></div>')
      continue
    }
    if (item.label === 'registered') {
      out.push('<div class="ana-row"><div class="ana-row-label">' + esc(label) + '</div><div class="ana-row-value">'
        + raw.split(',').map((name) => chip('info', zhStrategy(name.trim()), zhStrategyHint(name.trim()))).join('')
        + '</div><div></div></div>')
      continue
    }
    const chain = raw.split('→').map((name) => name.trim()).filter((name) => name !== '')
    const body = chain.length === 0
      ? '<span class="ana-c-dim">（空栈）</span>'
      : chain.map((name) => chip(name === '(empty)' ? 'dim' : 'accent', zhStrategy(name), zhStrategyHint(name))).join('<span class="ana-arrow">→</span>')
    out.push('<div class="ana-row"><div class="ana-row-label">' + esc(label === '生效中' && item.label === 'active' ? '生效中' : label) + '</div>'
      + '<div class="ana-row-value">' + body + '</div><div></div></div>')
  }
  if (out.length === 0) return emptyState('没有策略信息', '这一屏读不到策略栈')
  return out.join('')
}

/** 自调节：偏离包络默认值的旋钮被点亮。 */
function tuningSectionBody(section) {
  const rows = Array.isArray(section.rows) ? section.rows : []
  const out = []
  for (const item of rows) {
    const value = zhValue(item.label, item.value, null)
    const drifted = String(item.value ?? '').indexOf('(default') >= 0
    const label = drifted ? zhTokens(item.label) : zhLabel(item.label)
    out.push(row({
      label: drifted ? '参数 ' + label : label,
      value: drifted ? '已偏离默认 → ' + value.replace(/\s*\(默认值?\)/, '') : value,
      color: drifted ? 'accent' : toneColor(item.tone),
      hint: drifted ? '这个旋钮已经被自调节改过，不再是包络默认值' : '',
    }))
  }
  return out.join('')
}

/** 日志尾部：每条一个序号徽标 + 中文事件名 + 相对时间。 */
function journalSectionBody(section) {
  const rows = Array.isArray(section.rows) ? section.rows : []
  const out = []
  for (const item of rows) {
    const label = String(item.label ?? '')
    if (!label.startsWith('#')) {
      out.push(row({ label: zhLabel(item.label), value: zhValue(item.label, item.value, null), color: toneColor(item.tone) }))
      continue
    }
    const raw = String(item.value ?? '')
    const match = raw.match(/^(.+?)\s*·\s*(.+?)\s*ago$/)
    const type = match === null ? raw : match[1]
    const age = match === null ? '' : match[2]
    out.push('<div class="ana-row"><div class="ana-row-label">'
      + chip('dim', label) + '</div><div class="ana-row-value">'
      + esc(zhEvent(type)) + '</div><div class="ana-row-value ana-c-dim">'
      + esc(age === '' ? '' : zhAgeToken(age) + '前') + '</div></div>')
  }
  return out.join('')
}

/** 重要度排行：名次 + 主题 + 正文摘要 + 重要度条 + 类型/状态徽标。 */
function salienceSectionBody(section) {
  const rows = Array.isArray(section.rows) ? section.rows : []
  const out = []
  let index = 0
  for (const item of rows) {
    index += 1
    const raw = String(item.value ?? '')
    const match = raw.match(/^([\d.]+)\s+(\S+)\/(\S+)$/)
    const salience = match === null ? 0 : Number(match[1])
    const kind = match === null ? '' : match[2]
    const state = match === null ? '' : match[3]
    out.push('<div class="ana-rank">'
      + '<div class="ana-rank-no">' + index + '</div>'
      + '<div class="ana-rank-main"><div class="ana-rank-subject">' + esc(item.label) + '</div>'
      + (item.note === undefined || item.note === '' ? '' : '<div class="ana-rank-body">' + esc(item.note) + '</div>')
      + '</div>'
      + '<div class="ana-rank-right">'
      + '<div class="ana-chips">'
      + (kind === '' ? '' : chip(kindColor(kind), zhKind(kind)))
      + (state === '' ? '' : chip(stateColor(state), zhState(state), zhStateHint(state)))
      + '</div>'
      + '<div class="ana-meter" title="重要度 ' + salience.toFixed(2) + '（0–1，越高越容易被召回）">'
      + '<div class="ana-meter-fill" style="width:' + (Math.max(0, Math.min(1, salience)) * 100).toFixed(0) + '%"></div></div>'
      + '<div class="ana-num">' + salience.toFixed(2) + '</div>'
      + '</div></div>')
  }
  if (out.length === 0) return emptyState('还没有可排行的记忆', '先让 agent 记住点什么')
  return out.join('')
}

/** 通用分区：按行渲染，带 tone 与副行。 */
function plainSectionBody(section) {
  // 总览里这三行与上方的指标卡是同一个数字，隔 40px 再说一遍是噪音而不是强调。
  // 详情保留在卡片里，总览只补充卡片没有的东西（版本、日志段）。
  const skip = String(section.id ?? '') === 'overview' ? ['memories', 'safe mode', 'origin'] : []
  const rows = (Array.isArray(section.rows) ? section.rows : []).filter((item) => skip.indexOf(String(item.label)) < 0)
  const body = rows.map((item) => row({
    label: zhLabel(item.label),
    value: zhValue(item.label, item.value, null),
    color: toneColor(item.tone),
    note: item.note === undefined || item.note === '' ? '' : zhTokens(item.note),
    hint: item.label === 'safe mode' ? '开启时元层冻结：策略与调参不再自动变化' : '',
  })).join('')
  if (skip.length > 0 && rows.length > 0) {
    return body + '<div class="ana-row"><div class="ana-row-note">规模、活跃比例与数据来源见上方指标卡</div></div>'
  }
  return body
}

/** 每个分区用哪个渲染体。 */
const SECTION_RENDERERS = Object.freeze({
  overview: (section) => plainSectionBody(section),
  lifecycle: (section) => barSection(section, 'state'),
  kinds: (section) => barSection(section, 'kind'),
  strategy: (section) => strategySectionBody(section),
  tuning: (section) => tuningSectionBody(section),
  journal: (section) => journalSectionBody(section),
  salience: (section) => salienceSectionBody(section),
  viz: (section) => plainSectionBody(section),
})

/**
 * 渲染整个仪表盘。
 * @param {any} model `buildDashboardModel()` 的产物
 * @param {{ compact?: boolean }} [opts]
 * @returns {string} HTML
 */
function renderDashboardHtml(model, opts) {
  const options = opts === undefined || opts === null ? {} : opts
  const out = []
  const warnings = Array.isArray(model.warnings) ? model.warnings : []
  const real = warnings.filter((text) => String(text).indexOf('unknown section') < 0)
  if (real.length > 0) out.push(notice(real.map(zhWarning).join('；'), 'info'))
  out.push(dashboardCards(model))

  const sections = Array.isArray(model.sections) ? model.sections : []
  if (sections.length === 0) {
    out.push(emptyState('没有可展示的分区', '在配置里打开至少一个分区，或直接用 ana_dashboard'))
    return out.join('')
  }
  for (const item of sections) {
    // `compact` 只画关键三块：总览 / 生命周期 / 重要度排行。
    if (options.compact === true && ['overview', 'lifecycle', 'salience'].indexOf(String(item.id)) < 0) continue
    const render = SECTION_RENDERERS[String(item.id)]
    const body = render === undefined ? plainSectionBody(item) : render(item)
    out.push(section(zhSection(item.id), zhSectionHint(item.id), body))
  }
  return out.join('')
}

/**
 * 仪表盘页脚摘要：数据来源、规模、活跃比例、版本。
 * @param {any} model
 * @returns {string}
 */
function dashboardSummary(model) {
  const store = model?.store ?? {}
  const total = Number(store.memories ?? 0)
  const live = Number(store.live ?? 0)
  return [
    '数据来源：' + zhOrigin(model?.origin),
    '记忆 ' + zhCount(total) + ' 条',
    total > 0 ? '活跃 ' + zhPercent(live, total) : '',
    '存储版本 v' + zhCount(store.version),
  ].filter((part) => part !== '').join('　·　')
}

/**
 * 仪表盘图例：颜色在这个页面上意味着什么。
 * @returns {string}
 */
function dashboardLegendHtml() {
  return legend([
    { title: '生命周期', items: ['draft', 'active', 'verified', 'locked', 'deprecated', 'expired'].map((state) => ({
      color: stateColor(state), text: zhState(state), hint: zhStateHint(state),
    })) },
    { title: '记忆类型', items: ['constraint', 'failure', 'hypothesis', 'fact', 'procedure'].map((kind) => ({
      color: kindColor(kind), text: zhKind(kind),
    })) },
  ])
}