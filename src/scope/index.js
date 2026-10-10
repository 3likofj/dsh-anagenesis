/**
 * Scope isolation — the query-side half of it.
 *
 * 串扰在旧实现里有三个入口，这一层把三个都堵上：
 *
 *   1. **默认写到全局。** `createMemory` 的 `scope.global` 默认 true，于是"没有
 *      显式限定"的每一条经验都变成跨项目可见。写入侧改为默认 `project`（见
 *      `src/memory/ops.js` 的 `defaultScope`），这里负责把标签翻成命名空间。
 *   2. **召回不过滤。** 旧的 `inScope()` 在 `plan.scope` 为空时 `return true` ——
 *      "没传 scope"等于"看所有项目"。现在过滤条件是**闭集**：只有当前项目、
 *      当前会话、全局（以及显式授权时的其它项目）能通过，其余一律排除，
 *      并且缺字段一律**失败关闭**（fail closed），不失败开放。
 *   3. **打分不看作用域。** 命中项里有跨项目经验时，除了乘一个显著 <1 的系数，
 *      还会在注入块里逐条标注"其他项目经验，请勿盲从"，并做一次冲突检测：
 *      跨项目记忆与当前项目记忆语义相似但极性相反 → 该条的**有效置信度**当场
 *      减半，并在状态脉冲里要求模型以当前环境为准。
 *
 * 过滤与打分都在 `src/memory/recall.js` 的检索循环里发生，而那个循环是**唯一**
 * 的检索路径（工具、viz、mirror 全部经由它或它的纯投影）；显式授权
 * （`crossProject: true`）也必须走同一个入口，因此"绕过作用域过滤的查询路径"
 * 在这套代码里不存在 —— 见 `test/scope.test.js` 的 bypass 用例。
 * @module dsh-anagenesis/scope
 */

import { cosine } from '../memory/embed.js'
import { tokenize } from '../util.js'
import {
  GLOBAL_NAMESPACE,
  SCOPE_TIERS,
  cwdFromExec,
  fingerprintProject,
  namespaceOf,
  normalizeTier,
  parseNamespace,
  scopeLabel,
  scopeRelation,
  scopeTag,
  sessionFromExec,
} from './project.js'

export {
  GLOBAL_NAMESPACE, SCOPE_TIERS, canonicalPath, canonicalRemote, cwdFromExec, findRepoRoot,
  fingerprintProject, namespaceOf, namespaceSlug, normalizeTier, parseNamespace, readGitRemote,
  scopeLabel, scopeRelation, scopeTag, sessionFromExec,
} from './project.js'

/** 跨项目命中的默认加权：近似"排到最后，但仍然看得见"。 */
export const CROSS_PROJECT_WEIGHT = 0.35

/** 冲突命中时对跨项目那一条的额外惩罚（乘在分数上）。 */
export const CONFLICT_PENALTY = 0.5

/** 判定"主题相同"的余弦下限。低于它的两条记忆不算在谈同一件事。 */
export const CONFLICT_SIMILARITY = 0.62

/** 判定"内容相反"的否定标记。刻意保守：只用于降权与提示，绝不用于删除。 */
const NEGATION_PATTERNS = Object.freeze([
  /(?:不|没|无)(?:能|会|应|该|要|得|可|再|是|存在|成立|支持|允许|需要|应当|可以)/,
  /(?:禁止|避免|不要|别(?:再)?|无法|没有|并非|不能)/,
  /(?:^|[^a-z])(?:not|never|no|none|cannot|can't|don't|doesn't|didn't|isn't|aren't|won't|mustn't|without|disable|forbidden|avoid)(?:[^a-z]|$)/i,
])

/**
 * 一段文本是否带否定语气。
 * @param {string} text
 * @returns {boolean}
 */
export function isNegated(text) {
  const value = String(text ?? '')
  if (value === '') return false
  // 只看前 240 个字符：否定语气出现在断言最前面，长正文里的"不"多半是无关词。
  const head = value.slice(0, 240).toLowerCase()
  return NEGATION_PATTERNS.some((pattern) => pattern.test(head))
}

/**
 * @typedef {object} ScopeFilter
 * @property {string|null} projectId 当前项目指纹
 * @property {string|null} sessionId 当前会话 id
 * @property {boolean} crossProject 是否**显式**授权跨项目检索
 * @property {boolean} includeGlobal 是否纳入全局记忆（默认 true）
 * @property {boolean} includeLegacy 是否纳入迁移前未标注的记录（默认 true，标注后仍降权）
 * @property {boolean} authorized 这次 allow 是显式写下来的（写进审计）
 * @property {string} reason 授权的理由（审计用）
 */

/**
 * 构造闭集过滤条件。**没有"看了所有项目"这个状态**：crossProject 为 true 时跨项目
 * 记录进入候选池，但会被加权压低并逐条标注；为 false 时它们连候选都不是。
 * @param {{ projectId?: string|null, sessionId?: string|null, crossProject?: boolean,
 *   includeGlobal?: boolean, includeLegacy?: boolean, authorized?: boolean, reason?: string }} [input]
 * @returns {ScopeFilter}
 */
export function createScopeFilter(input = {}) {
  return {
    projectId: input.projectId === undefined || input.projectId === null || input.projectId === '' ? null : String(input.projectId),
    sessionId: input.sessionId === undefined || input.sessionId === null || input.sessionId === '' ? null : String(input.sessionId),
    crossProject: input.crossProject === true,
    includeGlobal: input.includeGlobal !== false,
    includeLegacy: input.includeLegacy !== false,
    authorized: input.authorized === true,
    reason: String(input.reason ?? ''),
  }
}

/**
 * 一条记录是否进入这次检索，以及它应当承受的作用域权重。
 *
 * 返回值是**判定**而不是布尔量：调用方需要知道"为什么进来"（全局 / 本项目 /
 * 显式授权的跨项目 / 迁移遗留），因为打分与注入标注都要用同一个判定。
 * @param {any} record
 * @param {ScopeFilter} filter
 * @returns {{ ok: boolean, relation: string, weight: number, reason: string }}
 */
export function scopeMatch(record, filter) {
  const relation = scopeRelation(record, { projectId: filter.projectId, sessionId: filter.sessionId })
  switch (relation) {
    case 'global':
      return filter.includeGlobal
        ? { ok: true, relation, weight: 1, reason: 'global' }
        : { ok: false, relation, weight: 0, reason: 'global memories excluded by this call' }
    case 'current-project':
    case 'current-session':
      return { ok: true, relation, weight: 1, reason: relation }
    case 'other-project':
      return filter.crossProject
        ? { ok: true, relation, weight: CROSS_PROJECT_WEIGHT, reason: 'cross-project (explicitly authorized)' }
        : { ok: false, relation, weight: 0, reason: 'belongs to another project; pass crossProject: true to include it' }
    case 'other-session':
      // 会话级记忆**永远**不跨会话：它不是"别人的项目经验"，它是尚未成为经验的
      // 临时工作状态。授权也不行 —— 授权是给经验的，不是给上下文的。
      return { ok: false, relation, weight: 0, reason: 'session-scoped: only visible inside the session that wrote it' }
    default:
      return filter.includeLegacy
        ? { ok: true, relation: 'unscoped', weight: CROSS_PROJECT_WEIGHT, reason: 'written before scope isolation existed; provenance unknown' }
        : { ok: false, relation: 'unscoped', weight: 0, reason: 'unscoped legacy record excluded by this call' }
  }
}

/**
 * 标记跨项目命中，供注入渲染使用。
 * @param {any} record
 * @param {ScopeFilter} filter
 * @returns {string} 空串表示"不需要警告"
 */
export function crossProjectMarker(record, filter) {
  const relation = scopeRelation(record, { projectId: filter.projectId, sessionId: filter.sessionId })
  if (relation === 'other-project') return `⚠ 其他项目经验，请勿盲从 (${scopeLabel(record.scope)})`
  if (relation === 'unscoped') return '⚠ 作用域未标注的旧记忆，请按当前项目核对'
  return ''
}

/**
 * @typedef {object} ScopeConflict
 * @property {string} currentId 当前项目（或全局）那一条
 * @property {string} otherId 跨项目那一条
 * @property {number} similarity 主题相似度
 * @property {'polarity'|'link'} basis 判据：极性相反，还是显式 contradicts 连线
 */

/**
 * 跨项目冲突检测：语义相似 + 极性相反（或有显式 contradicts 连线）。
 *
 * 只在**已选中的候选**里做，复杂度 O(跨项目 × 本项目)，两边都受 limit 约束。
 * 判据刻意保守：这只是把一条跨项目经验的**有效置信度**压下去并让模型看见，
 * 绝不修改存储、绝不删除任何东西 —— 一次读取不该改变记忆库。
 * @param {any[]} selected `{ record, score, parts }[]`
 * @param {ScopeFilter} filter
 * @param {{ similarity?: number }} [opts]
 * @returns {ScopeConflict[]}
 */
export function detectScopeConflicts(selected, filter, opts = {}) {
  const threshold = Number(opts.similarity ?? CONFLICT_SIMILARITY)
  const local = []
  const foreign = []
  for (const row of selected ?? []) {
    const relation = scopeRelation(row?.record?.scope, { projectId: filter.projectId, sessionId: filter.sessionId })
    if (relation === 'other-project' || relation === 'unscoped') foreign.push(row)
    else local.push(row)
  }
  /** @type {ScopeConflict[]} */
  const conflicts = []
  for (const other of foreign) {
    for (const mine of local) {
      const basis = conflictBasis(mine.record, other.record, threshold)
      if (basis === null) continue
      conflicts.push({
        currentId: String(mine.record.id),
        otherId: String(other.record.id),
        similarity: Number(basis.similarity.toFixed(3)),
        basis: basis.basis,
      })
    }
  }
  return conflicts
}

/**
 * @param {any} mine
 * @param {any} other
 * @param {number} threshold
 * @returns {{ similarity: number, basis: 'polarity'|'link' }|null}
 */
function conflictBasis(mine, other, threshold) {
  const linked = (mine?.links ?? []).some((link) => String(link?.to) === String(other?.id)
    && ['contradicts', 'challenged_by', 'counterfactual_of'].includes(String(link?.rel)))
  if (linked) return { similarity: 1, basis: 'link' }
  const similarity = Math.max(
    cosine(mine?.embedding ?? [], other?.embedding ?? []),
    lexicalOverlap(`${mine?.subject ?? ''} ${mine?.gist ?? ''}`, `${other?.subject ?? ''} ${other?.gist ?? ''}`),
  )
  if (similarity < threshold) return null
  const a = isNegated(`${mine?.subject ?? ''} ${mine?.gist ?? ''}`)
  const b = isNegated(`${other?.subject ?? ''} ${other?.gist ?? ''}`)
  if (a === b) return null
  return { similarity, basis: 'polarity' }
}

/**
 * 词面重合度（Jaccard）。哈希向量器在短句上的余弦偏低，所以词面重合是必要补充：
 * "不要用 X" 与 "用 X 是对的" 这类对立，靠主题词重合就足以判定在谈同一件事。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function lexicalOverlap(a, b) {
  const left = new Set(tokenize(a))
  const right = new Set(tokenize(b))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/**
 * 作用域解析器：把"这次调用发生在哪个项目/会话"变成稳定的标签。
 *
 * 缓存是**纯函数缓存**（cwd → 指纹），所以它不引入任何"重启后变化"的语义；
 * 真正的持久化只有一处：把首次见到的项目登记进 `state.projects`，好让
 * `ana_scope action=list` 与可视化层能用人话显示"另一个项目"是谁。
 * @param {{ fallbackCwd?: () => string, logger?: any }} [deps]
 */
export function createScopeResolver(deps = {}) {
  /** @type {Map<string, ReturnType<typeof fingerprintProject>>} */
  const identities = new Map()
  /** @type {Map<string, ReturnType<typeof fingerprintProject>>} */
  const byId = new Map()

  /** @param {string} cwd @returns {ReturnType<typeof fingerprintProject>} */
  const identityFor = (cwd) => {
    const key = String(cwd ?? '')
    const cached = identities.get(key)
    if (cached !== undefined) return cached
    const identity = fingerprintProject({ cwd: key })
    identities.set(key, identity)
    byId.set(identity.id, identity)
    return identity
  }

  return {
    identityFor,
    /**
     * A project we have seen before, by fingerprint. Callers that only have an
     * id (a record's `scope.projectId`, a `crossProject` authorization) need this
     * to print a human label or to register the project on first sight.
     * @param {string|null|undefined} id
     * @returns {ReturnType<typeof fingerprintProject>|null}
     */
    identityById(id) {
      if (id === null || id === undefined || id === '') return null
      return byId.get(String(id)) ?? null
    },
    /** @returns {ReturnType<typeof fingerprintProject>} */
    current() {
      const cwd = deps.fallbackCwd === undefined ? process.cwd() : deps.fallbackCwd()
      return identityFor(cwd)
    },
    /**
     * 一次调用的完整作用域上下文。
     * @param {any} exec 宿主给的执行对象（可能是 `{}`）
     * @param {{ tier?: string, crossProject?: boolean, sessionId?: string|null, presetId?: string|null,
     *   reason?: string, projectId?: string|null }} [explicit] 调用方显式指定的部分
     * @returns {{ identity: any, scope: any, filter: ScopeFilter, namespace: string, tier: string }}
     */
    forCall(exec, explicit = {}) {
      const cwd = cwdFromExec(exec)
      const identity = explicit.projectId !== undefined && explicit.projectId !== null
        ? { ...identityFor(cwd), id: String(explicit.projectId) }
        : identityFor(cwd)
      const sessionId = explicit.sessionId !== undefined ? explicit.sessionId : sessionFromExec(exec)
      const tier = SCOPE_TIERS.includes(String(explicit.tier)) ? String(explicit.tier) : 'project'
      const scope = scopeTag({
        tier,
        projectId: identity.id,
        sessionId,
        presetId: explicit.presetId ?? null,
        workspace: identity.root,
        origin: explicit.tier === undefined ? 'default' : 'explicit',
      })
      return {
        identity,
        scope,
        namespace: namespaceOf(scope),
        tier: scope.tier,
        // The *raw* session id the caller is in, separately from the scope tag.
        // They are not the same value: a project-tier tag deliberately carries no
        // session (a project memory belongs to the project), while the caller's
        // session is still needed to admit its own session-scoped records. Callers
        // that conflate the two silently hide a session's own memories from it.
        sessionId,
        filter: createScopeFilter({
          projectId: identity.id,
          sessionId,
          crossProject: explicit.crossProject === true,
          authorized: explicit.crossProject === true,
          reason: explicit.reason ?? '',
        }),
      }
    },
    /**
     * 把首次见到的项目登记进状态。返回可直接并入事务的 `projectSet`，
     * 已经登记过时返回 null（幂等，且不产生任何写入）。
     *
     * 接受三种输入：一个 identity、一个 projectId、或一条记录的 `scope`
     * —— 调用方（`ops.remember` 的 `projectRegistry` 钩子）手上只有后两种。
     * @param {any} state
     * @param {any} target
     * @param {number} now
     * @returns {{ projectSet: Record<string, any> }|null}
     */
    registryPatch(state, target, now) {
      const identity = target?.root !== undefined && target?.id !== undefined
        ? target
        : this.identityById(typeof target === 'string' ? target : target?.projectId)
      if (identity === null || identity === undefined) return null
      const known = state?.projects?.[identity.id]
      if (known !== undefined && known.root === identity.root && known.remote === identity.remote) {
        return null
      }
      return {
        projectSet: {
          [identity.id]: {
            id: identity.id,
            kind: identity.kind,
            root: identity.root,
            remote: identity.remote,
            label: identity.label,
            firstSeenAt: known?.firstSeenAt ?? now,
            lastSeenAt: now,
          },
        },
      }
    },
  }
}

/**
 * 已知项目的显示名。
 * @param {any} state
 * @param {string|null} projectId
 * @returns {string}
 */
export function projectLabel(state, projectId) {
  if (projectId === null || projectId === undefined || projectId === '') return 'global'
  const entry = state?.projects?.[String(projectId)]
  return entry?.label ?? String(projectId).slice(0, 12)
}

/**
 * 一个状态里各命名空间的记录数 —— 仪表盘"作用域"分区的数据源，纯投影。
 * @param {any} state
 * @returns {{ byNamespace: Record<string, number>, byTier: Record<string, number>, byTierLive: Record<string, number> }}
 */
export function namespaceCounts(state) {
  /** @type {Record<string, number>} */
  const byNamespace = {}
  /** @type {Record<string, number>} */
  const byTier = {}
  for (const record of Object.values(state?.memories ?? {})) {
    const ns = namespaceOf(/** @type {any} */ (record).scope)
    byNamespace[ns] = (byNamespace[ns] ?? 0) + 1
    const tier = normalizeTier(/** @type {any} */ (record).scope)
    byTier[tier] = (byTier[tier] ?? 0) + 1
  }
  return { byNamespace, byTier, byTierLive: byTier }
}

/**
 * 状态脉冲：会话内让模型"看得见自己在哪个档位、哪套权限、哪个项目"的那一行。
 *
 * 它不是装饰。档位与权限是**权限层的真相**（工具注册是它的投影），作用域是
 * 隔离层的真相；把它们写进模型每一轮都能看到的位置，是让"引用记忆前先确认
 * scope"这条规则可执行的唯一办法 —— 一条规则如果模型看不到上下文，就等于没有。
 *
 * 刻意写得**短**：这段文本每一步都会进上下文（`systemPrompt.context()`），
 * 也跟在每次召回后面。规则本身住在预设的 persona 里（那里有完整措辞），
 * 脉冲只负责"事实 + 一句提醒"，因此它不该变成第二份文档。
 * @param {{ projectId?: string|null, projectLabel?: string, tier?: string, sessionId?: string|null,
 *   gear?: string|null, preset?: string|null, allowed?: string[], conflicts?: number,
 *   crossProject?: boolean }} input
 * @returns {{ text: string, data: Record<string, any> }}
 */
export function buildPulse(input = {}) {
  const allowed = Array.isArray(input.allowed) ? input.allowed : []
  const hasWrite = allowed.includes('ana_remember')
  const data = {
    scope: String(input.tier ?? 'project'),
    project: String(input.projectLabel ?? input.projectId ?? 'unknown'),
    projectId: input.projectId ?? null,
    session: input.sessionId ?? null,
    preset: input.preset ?? null,
    gear: input.gear ?? 'none',
    allowed,
    crossProject: input.crossProject === true,
    conflicts: Number(input.conflicts ?? 0),
  }
  const lines = [
    `<anagenesis-pulse scope="${data.scope}" project="${data.project}" preset="${data.preset ?? 'inactive'}" gear="${data.gear}" tools="${hasWrite ? 'read+write' : 'read-only'}">`,
    `当前项目 ${data.project}（指纹 ${data.projectId ?? '未知'}）· 档位 ${data.gear} · ${hasWrite ? '可写' : '只读'}`,
  ]
  if (data.gear === 'none') {
    lines.push('预设未激活：写入类工具不可用。要写记忆请让用户启用 anagenesis 预设。')
  } else {
    lines.push('引用记忆前先核对它的 scope 是否与当前项目匹配；不匹配的不要直接套用，不确定就问用户。')
  }
  if (data.crossProject) lines.push('本次检索包含其它项目的记忆（已降权）：不要盲从，以当前环境为准。')
  if (data.conflicts > 0) lines.push(`检测到跨项目记忆冲突 ${data.conflicts} 处：建议忽略历史经验，以当前环境为准。`)
  lines.push('</anagenesis-pulse>')
  return { text: lines.join('\n'), data }
}
