/**
 * 中文化词表 —— 渲染层第 1 部分（纯数据 + 纯函数，无宿主、无 DOM）。
 *
 * 这一层的存在理由：模型（`src/viz/model.js`）是**英文枚举**，TUI/Mermaid/D2
 * 序列化器按终端习惯消费它；而中文用户看到的是窗口。把翻译放在**渲染层**而不是
 * 模型层，模型保持语言中立、TUI 一字不改，窗口与预览共享同一张词表。
 *
 * 两条规则：
 *   1. **未知值原样透出并标记**（`未知类型 "xxx"`），绝不静默吞掉 —— 一个看不见
 *      的新枚举值比一个难看的中文更危险。
 *   2. 术语按中文技术习惯写，不机翻：`verified` 是"已验证"而不是"核实的"，
 *      `episode` 是"情景记录"而不是"集"。
 */

/** 记忆类型：`KINDS` 全表。 */
const KIND_ZH = Object.freeze({
  fact: '事实',
  preference: '偏好',
  procedure: '方法',
  heuristic: '经验法则',
  episode: '情景记录',
  hypothesis: '假设',
  constraint: '约束',
  failure: '失败',
})

/** 生命周期状态：`STATES` 全表。 */
const STATE_ZH = Object.freeze({
  draft: '草稿',
  active: '活跃',
  verified: '已验证',
  locked: '已锁定',
  deprecated: '已弃用',
  expired: '已过期',
  retired: '已归档',
})

/** 状态一句话解释 —— 悬停提示用，帮助用户区分"已弃用 / 已过期 / 已归档"。 */
const STATE_HINT_ZH = Object.freeze({
  draft: '探索期写入的初步记录，可信度低，随时会改写',
  active: '已在正常使用中，注入时会参与召回',
  verified: '有证据支撑，检索优先级更高',
  locked: '被钉住、不随时间衰减；改动需要显式 force',
  deprecated: '已不再采信，但记录保留',
  expired: '因时效失效，停止注入',
  retired: '终态，只用于审计回溯',
})

/** 仪表盘分区标题。 */
const SECTION_ZH = Object.freeze({
  overview: '总览',
  lifecycle: '生命周期分布',
  kinds: '记忆类型分布',
  strategy: '策略栈',
  tuning: '自调节',
  journal: '日志尾部',
  salience: '重要度排行',
  viz: '渲染器状态',
})

/** 分区副标题：一句话说明这一块在回答什么问题。 */
const SECTION_HINT_ZH = Object.freeze({
  overview: '这份存储的基本事实',
  lifecycle: '记忆在各生命周期状态上的分布',
  kinds: '记忆按类型分布，看清结构而非数量',
  strategy: '当前生效的注入策略栈与健康度',
  tuning: '元层自己调过的参数；偏离默认值的会被点亮',
  journal: '最近发生的操作，倒序',
  salience: '按重要度排序的记忆，含类型与状态',
  viz: '这个渲染器自己的运转情况',
})

/** 图的三种形态。 */
const DIAGRAM_KIND_ZH = Object.freeze({
  'memory-graph': '记忆关系图',
  'strategy-timeline': '策略时间线',
  lifecycle: '生命周期流转',
})

/** 图种副标题。 */
const DIAGRAM_KIND_HINT_ZH = Object.freeze({
  'memory-graph': '节点是记忆，连线是记忆之间的语义关系',
  'strategy-timeline': '策略栈切换、自调节与回滚的时间顺序',
  lifecycle: '日志里真实观测到的状态迁移，不是理论上的转移表',
})

/** 序列化格式（`ana_diagram` 工具的 `format`，也是下拉框）。 */
const FORMAT_ZH = Object.freeze({
  mermaid: 'Mermaid 图',
  d2: 'D2 图',
  ascii: 'ASCII 文本图',
})

/** 脱敏级别 —— 不是简单的"保密/不保密"，而是说清代价。 */
const REDACTION_ZH = Object.freeze({
  secrets: '脱敏（默认）',
  strict: '严格脱敏',
  none: '不脱敏（有风险）',
})
const REDACTION_HINT_ZH = Object.freeze({
  secrets: '抹掉凭据形状的文本并省略正文',
  strict: '连标签一起遮挡，只保留结构',
  none: '原样显示，含凭据；只在本机自己看时使用',
})

/** 关系类型：`links[].rel`。 */
const REL_ZH = Object.freeze({
  related: '相关',
  supports: '支持',
  contradicts: '矛盾',
  supersedes: '取代',
  superseded_by: '被取代',
  caused_by: '源于',
  part_of: '属于',
  challenged_by: '被质疑',
  counterfactual_of: '反事实',
  derived_from: '派生自',
})

/** 策略名。 */
const STRATEGY_ZH = Object.freeze({
  explore: '探索',
  exploit: '利用',
  debug: '调试',
  distill: '蒸馏',
  guard: '护栏',
  crisis: '危机',
})

const STRATEGY_HINT_ZH = Object.freeze({
  explore: '高召回、低门槛，写入落为草稿 —— 问题还在摸清阶段时用',
  exploit: '只注入已验证与已锁定的记忆，写入直接生效 —— 执行已知方案时用',
  debug: '失败、边界与未决假设优先，关闭时间衰减 —— 出事那一刻切过来',
  distill: '压缩优先，只注入要点 —— 长会话要省 token 时用',
  guard: '不变量策略，永远在栈底，不可移除',
  crisis: '失败 + 已验证事实同时注入 —— 已经在连续失败时用',
})

/** 日志事件类型 → 中文。前缀匹配，所以带后缀的 `strategy.setStack/agent:x` 也能命中。 */
const EVENT_ZH = Object.freeze([
  ['memory.remember', '记住'],
  ['memory.link', '建立关联'],
  ['memory.promote', '提升状态'],
  ['memory.demote', '降低状态'],
  ['memory.split', '拆分记忆'],
  ['memory.lock', '锁定'],
  ['memory.expire', '标记过期'],
  ['memory.sweep', '过期清扫'],
  ['memory.forget', '遗忘'],
  ['memory.usage', '被引用'],
  ['memory.rethink', '反事实重思'],
  ['memory.recall', '召回'],
  ['strategy.setStack', '切换策略栈'],
  ['strategy.activate', '启用策略'],
  ['strategy.register', '注册策略'],
  ['strategy.deactivate', '停用策略'],
  ['meta.tune', '自调节'],
  ['meta.feedback', '反馈'],
  ['preset.bind', '预设绑定'],
  ['engine.quarantine', '策略被隔离'],
  ['journal.prune', '日志剪枝'],
  ['revert', '回滚'],
  ['guard.denied', '护栏拦截'],
  ['viz.render', '渲染'],
  ['audit', '审计'],
])

/** 数据来源。 */
const ORIGIN_ZH = Object.freeze({
  live: '实时（服务）',
  mirror: '只读镜像（文件）',
})

/** 生命周期"只记录目的态"的操作名。 */
const OP_ZH = Object.freeze({
  'memory.lock': '锁定',
  'memory.expire': '过期',
  'memory.sweep': '清扫',
})

/** 窗口自身的两个视图。 */
const VIEW_ZH = Object.freeze({
  dashboard: '仪表盘',
  graph: '图表',
})

/** 图的排布方向。 */
const DIRECTION_ZH = Object.freeze({
  LR: '横向',
  TB: '纵向',
})

/**
 * 查表：命中返回中文，未命中返回 `未知…("原值")`。
 * 绝不返回空串 —— 一个空标签会让人以为是渲染坏了。
 * @param {Record<string, string>} table
 * @param {unknown} value
 * @param {string} noun
 * @returns {string}
 */
function zhLookup(table, value, noun) {
  const key = String(value ?? '')
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key]
  return key === '' ? `未知${noun}` : `${noun}「${key}」`
}

/** @param {unknown} value @returns {string} */
function zhKind(value) {
  return zhLookup(KIND_ZH, value, '类型')
}

/** @param {unknown} value @returns {string} */
function zhState(value) {
  return zhLookup(STATE_ZH, value, '状态')
}

/** @param {unknown} value @returns {string} */
function zhStateHint(value) {
  const key = String(value ?? '')
  return Object.prototype.hasOwnProperty.call(STATE_HINT_ZH, key) ? STATE_HINT_ZH[key] : ''
}

/** @param {unknown} value @returns {string} */
function zhSection(value) {
  return zhLookup(SECTION_ZH, value, '分区')
}

/** @param {unknown} value @returns {string} */
function zhSectionHint(value) {
  const key = String(value ?? '')
  return Object.prototype.hasOwnProperty.call(SECTION_HINT_ZH, key) ? SECTION_HINT_ZH[key] : ''
}

/** @param {unknown} value @returns {string} */
function zhDiagramKind(value) {
  return zhLookup(DIAGRAM_KIND_ZH, value, '图种')
}

/** @param {unknown} value @returns {string} */
function zhDiagramHint(value) {
  const key = String(value ?? '')
  return Object.prototype.hasOwnProperty.call(DIAGRAM_KIND_HINT_ZH, key) ? DIAGRAM_KIND_HINT_ZH[key] : ''
}

/** @param {unknown} value @returns {string} */
function zhFormat(value) {
  return zhLookup(FORMAT_ZH, value, '格式')
}

/** @param {unknown} value @returns {string} */
function zhRedaction(value) {
  return zhLookup(REDACTION_ZH, value, '脱敏级别')
}

/** @param {unknown} value @returns {string} */
function zhRedactionHint(value) {
  const key = String(value ?? '')
  return Object.prototype.hasOwnProperty.call(REDACTION_HINT_ZH, key) ? REDACTION_HINT_ZH[key] : ''
}

/** @param {unknown} value @returns {string} */
function zhRel(value) {
  return zhLookup(REL_ZH, value, '关系')
}

/** @param {unknown} value @returns {string} */
function zhStrategy(value) {
  return zhLookup(STRATEGY_ZH, value, '策略')
}

/** @param {unknown} value @returns {string} */
function zhStrategyHint(value) {
  const key = String(value ?? '')
  return Object.prototype.hasOwnProperty.call(STRATEGY_HINT_ZH, key) ? STRATEGY_HINT_ZH[key] : ''
}

/**
 * 事件类型的中文名。带后缀的类型（`strategy.setStack/agent:s1`）按前缀命中。
 * @param {unknown} value
 * @returns {string}
 */
function zhEvent(value) {
  const key = String(value ?? '')
  for (const [prefix, label] of EVENT_ZH) {
    if (key === prefix || key.startsWith(prefix + '/') || key.startsWith(prefix + ':')) return label
  }
  return key === '' ? '未知事件' : '事件「' + key + '」'
}

/** @param {unknown} value @returns {string} */
function zhOrigin(value) {
  return zhLookup(ORIGIN_ZH, value, '来源')
}

/** @param {unknown} value @returns {string} */
function zhOp(value) {
  return zhLookup(OP_ZH, value, '操作')
}

/** @param {unknown} value @returns {string} */
function zhView(value) {
  return zhLookup(VIEW_ZH, value, '视图')
}

/** @param {unknown} value @returns {string} */
function zhDirection(value) {
  return zhLookup(DIRECTION_ZH, value, '方向')
}

/**
 * 中文友好的数量与百分比。
 * @param {unknown} value @returns {string}
 */
function zhCount(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? String(Math.round(parsed)) : '—'
}

/**
 * 百分比：`0.8333` → `83%`。分母为 0 时给 `—` 而不是 `0%`
 * （"没有数据"和"比例是零"是两件事）。
 * @param {unknown} ratio
 * @param {unknown} [total]
 * @returns {string}
 */
function zhPercent(ratio, total) {
  if (total !== undefined) {
    const t = Number(total)
    const n = Number(ratio)
    if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(n)) return '—'
    return Math.round((n / t) * 100) + '%'
  }
  const parsed = Number(ratio)
  if (!Number.isFinite(parsed)) return '—'
  return Math.round(parsed * 100) + '%'
}

/**
 * 相对时间（中文）。
 * @param {unknown} ageMs
 * @returns {string}
 */
function zhAge(ageMs) {
  const ms = Number(ageMs)
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return seconds + ' 秒前'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes + ' 分钟前'
  const hours = Math.round(minutes / 60)
  if (hours < 48) return hours + ' 小时前'
  return Math.round(hours / 24) + ' 天前'
}

/**
 * 模型里的紧凑时长记号 → 中文。
 *
 * `src/viz/model.js` 的 `humanAge()` 按终端习惯产出 `40s / 40m / 3h / 2d`，TUI 与
 * 工具输出要原样保留（它们面向终端）。窗口是给人读的，所以在这里翻译 ——
 * 第一版截图里日志行显示 `40m前`，就是漏了这一步。
 * @param {unknown} text
 * @returns {string}
 */
function zhAgeToken(text) {
  const raw = String(text ?? '').trim()
  const match = raw.match(/^(\d+)\s*([smhd])$/)
  if (match === null) return zhTokens(raw)
  const unit = { s: '秒', m: '分钟', h: '小时', d: '天' }[match[2]]
  return match[1] + ' ' + unit
}