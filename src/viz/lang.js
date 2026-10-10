/**
 * 终端面向文案词表（en / zh）—— 只有 TUI 文本帧与文本图表用得到。
 *
 * 为什么需要一条**缝**：模型的标签是窗口侧中文层的**键**（`window/src/render/10-i18n.js`
 * 用 `zhLabel(item.label)`、`item.label === 'safe mode'`、`skip.indexOf(item.label)` 这类
 * 判断把英文标签翻译成中文界面）。如果直接把模型里的英文标签改成中文，窗口会一夜之间
 * 变成「未知标签「存储」」—— 那不是中文化，那是把一层翻译打坏。
 *
 * 所以分工是：
 *   - **模型默认输出英文**（`lang: 'en'`，且与历史输出逐字相同）→ 窗口侧拿到它熟悉的键；
 *   - **终端面向的调用方**（`ana_dashboard` / `ana_diagram` / `tools/viz-watch.mjs`）
 *     传 `lang: 'zh'` → 帧与图表是中文。
 *
 * 与 `window/src/render/10-i18n.js` 的分工（有意保留两份词表）：
 *   1. 窗口那张表还有**悬停解释**、分区副标题、自由文本改写（`40m前` → `40 分钟前`）等
 *      终端不需要的东西；
 *   2. 反过来，这一张表要负责帧的**结构文案**（分区标题修饰、告警、空态）；
 *   3. 两边的键必须都是英文枚举，靠这条缝隔开，谁也不必去改对方的表。
 *      —— 只有「类型/状态」这 15 个术语两边都有（`KIND_ZH` / `STATE_ZH`），因为帧里也要
 *      把它们当**标签**显示；改术语时请两边一起改。
 *
 * 终端惯例原样保留的记号：日志事件类型（`memory.remember`）、时长记号（`40m`）、
 * 参数键（`recall.halfLifeMs`）、版本号与 seq —— 它们是机器标识，不是界面文案。
 *
 * `en` 是本文件的默认形状，任何未知语言都回落到它（绝不抛错、绝不出现空文案）。
 * @module dsh-anagenesis/viz/lang
 */

/** 记忆类型（`KINDS` 全表）。窗口侧同表见 `window/src/render/10-i18n.js` 的 `KIND_ZH`。 */
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

/**
 * 作用域层级（`SCOPE_TIERS` 全表）。窗口侧同表见 `10-i18n.js` 的 `TIER_ZH`。
 * `none` 不是层级而是"没有档位"（镜像/未激活），一并放在这里好让 `defaultTier` 只有一个答案。
 */
const TIER_ZH = Object.freeze({
  global: '全局',
  project: '项目',
  session: '会话',
})

/** 生命周期状态（`STATES` 全表）。窗口侧同表见 `10-i18n.js` 的 `STATE_ZH`。 */
const STATE_ZH = Object.freeze({
  draft: '草稿',
  active: '活跃',
  verified: '已验证',
  locked: '已锁定',
  deprecated: '已弃用',
  expired: '已过期',
  retired: '已归档',
})

/**
 * @param {Record<string, string>} table
 * @param {unknown} value
 * @returns {string}
 */
function lookup(table, value) {
  const key = String(value ?? '')
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key
}

const EN = {
  lang: 'en',
  title: 'anagenesis dashboard',
  section: {
    overview: 'overview',
    scope: 'scope',
    kinds: 'kinds',
    strategy: 'strategy',
    tuning: 'tuning',
    viz: 'viz',
    lifecycle: (total) => `lifecycle · ${total} record(s)`,
    journal: (shown) => `journal · last ${shown}`,
    salience: (shown, scope) => `salience · top ${shown} (scope ${scope})`,
    unknown: (id) => `section ${id}`,
  },
  label: {
    store: 'store',
    memories: 'memories',
    safeMode: 'safe mode',
    origin: 'origin',
    journal: 'journal',
    pruned: 'pruned',
    global: 'global',
    active: 'active',
    health: 'health',
    registered: 'registered',
    metric: 'metric',
    samples: 'samples',
    applied: 'applied',
    knobs: '(knobs)',
    segments: 'segments',
    prunedThrough: 'pruned through',
    noMemories: '(no memories yet)',
    mode: 'mode',
    renders: 'renders',
    diagrams: 'diagrams',
    lastRender: 'last render',
    errors: 'errors',
    redaction: 'redaction',
    liveTui: 'live TUI',
    currentProject: 'current project',
    defaultTier: 'default write tier',
    gear: 'gear',
    legacy: 'legacy untagged',
  },
  value: {
    storeVersion: (version, schema) => `v${version} · schema v${schema}`,
    memoryCount: (count, live) => `${count} (${live} live)`,
    safeOn: 'ON (meta frozen)',
    safeOff: 'off',
    origin: (origin) => (origin === 'mirror' ? 'mirror (read-only)' : String(origin)),
    journalCounters: (journal) => `live ${journal.live} · archives ${journal.archives} · checkpoints ${journal.checkpoints}`,
    pruned: (seq) => `every seq ≤ #${seq} was dropped by the retention policy`,
    empty: '(empty)',
    none: '(none)',
    healthOk: 'ok — no strategy quarantined',
    healthQuarantined: (ids) => `quarantined: ${ids}`,
    healthMirror: 'not available in a read-only mirror',
    envelopeDefaults: 'all at their envelope defaults',
    age: (token) => `${token} ago`,
    never: 'never',
    ratio: (count, percent) => `${count} (${percent}%)`,
    salience: (score, kind, state) => `${score} ${kind}/${state}`,
    nothingToRank: 'nothing to rank',
    liveTuiWatch: 'Ctrl+C stops it · this process never writes to the store',
    liveTuiTool: 'node tools/viz-watch.mjs --watch (separate read-only process)',
    currentProject: (label, namespace, basis) => `${label} · ${namespace} (${basis})`,
    basisRepo: 'repo',
    basisPath: 'path',
    basisUnknown: 'basis unknown',
    namespace: (label, count) => (label === '' ? `${count} record(s)` : `${label} · ${count} record(s)`),
    defaultTier: (tier) => String(tier ?? ''),
    tierUnknown: 'unknown (the default write tier lives in the live service)',
    gear: (gear, write) => `${gear} · ${write === true ? 'write tools available' : 'read-only (no write tools)'}`,
    gearMirror: (gear) => `${gear} (read-only mirror: no live service to report a gear)`,
    gearUnavailable: 'not available in a read-only mirror',
    presetActive: (preset) => `preset ${preset} active`,
    presetInactive: 'no preset active: write tools are not registered',
    legacyCount: (count) => `${count} record(s) written before scope isolation`,
    legacyNone: '0 (every record carries a scope)',
    scopeUnknown: 'unknown — a file mirror has no caller to derive a project from',
  },
  warning: {
    mirror: 'read-only mirror: engine health, tuner metric and journal counters come from state/files, not a live service',
    redactionNone: 'redaction=none: this artifact may contain credentials — do not paste it outside your own terminal',
    journalWindow: (shown, total) => `journal window shows ${shown} of ${total} in-memory events`,
    graphCapped: (nodes) => `graph capped at ${nodes} node(s)`,
    unknownSection: (id) => `unknown section "${id}" ignored`,
    allProjects: 'showing every project in this store; the agent itself would see only its own (current project + global + current session)',
  },
  frame: {
    warnings: 'warnings',
    emptySection: '(empty)',
    sectionFallback: 'section',
  },
  diagram: {
    noMemories: '(no memories visible)',
    noGovernance: '(no governance events in the journal window)',
    asciiTimeline: (events) => `timeline · ${events} governance event(s), oldest first`,
    asciiNothing: '  (nothing in the journal window)',
    asciiLifecycle: 'lifecycle · observed transitions',
    asciiLifecycleNone: '  (none observed; the declared machine is in the mermaid/d2 form)',
    asciiUnrecorded: '(unrecorded)',
    asciiCurrent: (pairs) => `current: ${pairs}`,
    asciiGraph: (nodes, links) => `memory graph · ${nodes} node(s), ${links} link(s)`,
    asciiOutside: '[outside window]',
  },
  kind: (value) => String(value ?? ''),
  state: (value) => String(value ?? ''),
}

const ZH = {
  lang: 'zh',
  title: 'anagenesis 仪表盘',
  section: {
    overview: '总览',
    scope: '作用域',
    kinds: '记忆类型',
    strategy: '策略栈',
    tuning: '自调节',
    viz: '渲染器',
    lifecycle: (total) => `生命周期 · ${total} 条`,
    journal: (shown) => `日志 · 最近 ${shown} 条`,
    salience: (shown, scope) => `重要度 · 前 ${shown} 条（作用域 ${scope}）`,
    unknown: (id) => `分区 ${id}`,
  },
  label: {
    store: '存储',
    memories: '记忆',
    safeMode: '安全模式',
    origin: '来源',
    journal: '日志',
    pruned: '已剪枝',
    global: '全局',
    active: '生效中',
    health: '健康度',
    registered: '已注册',
    metric: '综合指标',
    samples: '样本数',
    applied: '已应用',
    knobs: '（旋钮）',
    segments: '日志段',
    prunedThrough: '剪枝至',
    noMemories: '（还没有记忆）',
    mode: '模式',
    renders: '渲染次数',
    diagrams: '图表次数',
    lastRender: '上次渲染',
    errors: '错误',
    redaction: '脱敏级别',
    liveTui: '实时视图',
    currentProject: '当前项目',
    defaultTier: '默认写入档位',
    gear: '权限档位',
    legacy: '未标注的旧记忆',
  },
  value: {
    storeVersion: (version, schema) => `v${version} · 结构 v${schema}`,
    memoryCount: (count, live) => `${count} 条（活跃 ${live}）`,
    safeOn: '已开启（元层冻结）',
    safeOff: '已关闭',
    origin: (origin) => (origin === 'mirror' ? '镜像（只读）' : '实时（服务）'),
    journalCounters: (journal) => `活动段 ${journal.live} · 归档段 ${journal.archives} · 检查点 ${journal.checkpoints}`,
    pruned: (seq) => `所有 seq ≤ #${seq} 已被保留策略丢弃`,
    empty: '（空）',
    none: '（无）',
    healthOk: '正常 —— 没有策略被隔离',
    healthQuarantined: (ids) => `已隔离：${ids}`,
    healthMirror: '只读镜像下不可用',
    envelopeDefaults: '全部处于包络默认值',
    age: (token) => `${token} 前`,
    never: '从未',
    ratio: (count, percent) => `${count} 条（${percent}%）`,
    salience: (score, kind, state) => `${score} ${kind}/${state}`,
    nothingToRank: '没有可排序的记录',
    liveTuiWatch: 'Ctrl+C 结束 · 本进程绝不写存储',
    liveTuiTool: '在真终端里跑 node tools/viz-watch.mjs --watch（独立只读进程）',
    currentProject: (label, namespace, basis) => `${label} · ${namespace}（${basis}）`,
    basisRepo: '仓库',
    basisPath: '路径',
    basisUnknown: '来源未知',
    namespace: (label, count) => (label === '' ? `${count} 条` : `${label} · ${count} 条`),
    defaultTier: (tier) => lookup(TIER_ZH, tier),
    tierUnknown: '未知（默认写入档位由实时服务决定）',
    gear: (gear, write) => `${gear} · ${write === true ? '可写工具可用' : '只读（无写入工具）'}`,
    gearMirror: (gear) => `${gear}（只读镜像：没有实时服务可报告档位）`,
    gearUnavailable: '只读镜像下不可用',
    presetActive: (preset) => `预设 ${preset} 已激活`,
    presetInactive: '预设未激活：写入类工具未注册',
    legacyCount: (count) => `${count} 条写于作用域隔离之前`,
    legacyNone: '0（每条记录都带 scope）',
    scopeUnknown: '未知 —— 文件镜像没有调用方可推断',
  },
  warning: {
    mirror: '只读镜像：引擎健康度、调参指标与日志计数来自文件，不是实时服务',
    redactionNone: 'redaction=none：产物可能含凭据 —— 不要贴到自己的终端之外',
    journalWindow: (shown, total) => `日志窗口只显示内存中 ${total} 条事件里的 ${shown} 条`,
    graphCapped: (nodes) => `图被限制在 ${nodes} 个节点`,
    unknownSection: (id) => `未知分区「${id}」已忽略`,
    allProjects: '正在显示这份存储里的所有项目（运维视角）；Agent 自己只看得到它自己的（当前项目 + 全局 + 当前会话）',
  },
  frame: {
    warnings: '告警',
    emptySection: '（空）',
    sectionFallback: '分区',
  },
  diagram: {
    noMemories: '（没有可见的记忆）',
    noGovernance: '（日志窗口里没有治理事件）',
    asciiTimeline: (events) => `时间线 · ${events} 条治理事件，最早在前`,
    asciiNothing: '  （日志窗口里什么都没有）',
    asciiLifecycle: '生命周期 · 观测到的迁移',
    asciiLifecycleNone: '  （没有观测到迁移；声明式状态机见 mermaid/d2 形式）',
    asciiUnrecorded: '未记录',
    asciiCurrent: (pairs) => `当前：${pairs}`,
    asciiGraph: (nodes, links) => `记忆关系图 · ${nodes} 个节点，${links} 条连线`,
    asciiOutside: '[窗口之外]',
  },
  kind: (value) => lookup(KIND_ZH, value),
  state: (value) => lookup(STATE_ZH, value),
}

/** 支持的语言。未知值回落到 `en`，绝不抛错。 */
export const TERMINAL_LANGS = Object.freeze(['en', 'zh'])

/**
 * @param {unknown} lang
 * @returns {typeof EN}
 */
export function terminalText(lang) {
  return String(lang ?? '') === 'zh' ? ZH : EN
}
