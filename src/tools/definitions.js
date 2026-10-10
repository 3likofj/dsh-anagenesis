/**
 * anagenesis tool definitions — the catalogue, split by permission tier.
 *
 * Why the tools live in a definitions module instead of directly in a row: the
 * refactor that makes the preset a permission layer needs the *same* tool bodies
 * to be reachable from two different registration sites —
 *
 *   - `src/tools/index.js`       registers the **read** tier, always, from the
 *                                bundle row. Nothing here writes a memory.
 *   - `src/tools/gated.js`       registers the **write** tier, and only inside a
 *                                live preset grant. Without the preset these
 *                                tools are not merely discouraged; they were
 *                                never registered, so the model cannot see them.
 *
 * The `admin` tier is not a third registration site: `ana_strategy`, `ana_tune`,
 * `ana_scope` and `ana_preset` carry read *actions* that must stay available in
 * every gear (inspection is not a privilege), so they are registered with the
 * read tier and their mutating actions are refused at execution time by
 * `src/permission/guard.js`. That is the difference between "not shown" and "not
 * allowed", and the spec asks for both.
 * @module dsh-anagenesis/tools/definitions
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { INTENTS, GRANULARITIES } from '../memory/recall.js'
import { KINDS } from '../store/schema.js'
import { BUILTIN_STACKS } from '../strategy/builtin.js'
import { HOOKS } from '../strategy/registry.js'
import { OBJECTIVES, PARAM_ENVELOPE } from '../meta/tuner.js'
import { GEAR_IDS, GEAR_NONE } from '../permission/tiers.js'
import { SCOPE_TIERS, scopeLabel } from '../scope/project.js'

/**
 * @param {any} value
 * @returns {string}
 */
function asText(value) {
  if (value === null || value === undefined) return '（无结果）'
  if (typeof value === 'string') return value
  if (typeof value.text === 'string' && value.text.trim() !== '') return value.text
  const json = JSON.stringify(value, null, 2)
  return json.length > 6000 ? `${json.slice(0, 6000)}\n…（已截断）` : json
}

/**
 * Shared output contract: a flat, explicitly closed object plus a text renderer.
 * Keeping every output schema flat is deliberate — it survives DSH's schema
 * subset rules, PTC codegen and the UI renderer without special cases.
 * @param {Record<string, any>} properties
 */
function output(properties) {
  return {
    schema: { type: 'object', additionalProperties: false, properties },
    render: (_args, value) => [{ type: 'text', text: asText(value) }],
  }
}

/** @param {string} description */
const ids = (description) => ({ type: 'array', required: true, items: { type: 'string' }, description })
const seq = { type: 'integer', description: '产生这个结果的那笔事务在日志里的 seq。' }
const ok = { type: 'boolean', required: true, description: '操作是否已生效。' }
const scopeJson = {
  type: 'json',
  description: '作用域。三种写法：{tier:"global"} 跨项目通用；{tier:"project"}（默认，落到当前项目，可带 projectId）；'
    + '{tier:"session", session:"<id>"} 临时任务，TTL 到期自动过期。也接受旧写法 {global:true} / {session:"<id>"} / {workspace:"<path>"}。',
}

/**
 * @param {any} value
 * @param {string[]} keys
 * @returns {Record<string, any>}
 */
function pick(value, keys) {
  /** @type {Record<string, any>} */
  const out = { ok: value.ok !== false }
  for (const key of keys) if (value[key] !== undefined) out[key] = value[key]
  return out
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function require_(value, label) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`anagenesis: "${label}" is required for this action`)
  }
}

/**
 * Derive the strategy/param scope from the calling agent when the host exposes
 * one. `registry.stack(scope)` falls back to the global stack for an unknown
 * scope, so an older host that reports no agent degrades to the default stack
 * instead of failing.
 * @param {any} exec
 * @returns {string} a scope key, or 'global'
 */
function agentScope(exec) {
  const agent = exec?.agent
  const id = agent?.id ?? agent?.sessionId ?? agent?.name
  return typeof id === 'string' && id !== '' ? `agent:${id}` : 'global'
}

/**
 * Every tool the read tier owns. Registered unconditionally by
 * `src/tools/index.js` — this set must stay free of anything that mutates a
 * memory, because it is the set a session gets when no preset is enabled.
 * @param {{ service: () => any, config: any }} deps
 * @returns {any[]}
 */
export function buildReadTools(deps) {
  const { service, config } = deps
  /** @type {any[]} */
  const tools = []

  // ── 1. recall ────────────────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'ana_recall',
    description: '按意图（而不是关键词）向自己的记忆发问，取回你当下真正需要的东西。'
      + `intent 决定认知模式：${Object.keys(INTENTS).join(', ')}。`
      + '**默认只召回当前项目与全局作用域的记忆**；其它项目的记忆需要显式传 crossProject: true，'
      + '而且回来时会被降权、逐条标注，请勿盲从。'
      + '返回一个已按 maxTokens 裁剪好的 <anagenesis-memory> 块，紧跟一段 <anagenesis-pulse>（当前项目/档位/权限）；'
      + '真正用上的 id 记得在 ana_feedback 里引用。',
    parameters: {
      intent: { type: 'string', required: true, enum: Object.keys(INTENTS), description: '你接下来要做什么。orient=任务开始，recall_fact=回答一个事实问题，recall_precedent=以前是怎么处理的，avoid_mistake=已知的失败，reuse_procedure=验证过的步骤，verify=目前真正站得住的东西，contrast=一个有争议信念的两面。' },
      query: { type: 'string', description: '用你自己的话写要匹配什么。可选：只给 intent 也说得通。' },
      granularity: { type: 'string', enum: GRANULARITIES, description: 'gist=每条一行，claims=主题加最多三行，full=完整正文，timeline=按时间顺序。' },
      maxTokens: { type: 'integer', description: '返回块的硬 token 预算。打包到预算就停。' },
      minConfidence: { type: 'number', description: '覆盖 intent/策略给出的置信度下限（0..1）。' },
      kinds: { type: 'array', items: { type: 'string' }, description: `限定为这些记忆类型：${KINDS.join(', ')}。` },
      timeframe: { type: 'json', description: '{"since": epoch_ms, "until": epoch_ms}，按时间范围限定记忆。' },
      scope: { type: 'json', description: '{"session": id, "workspace": path, "preset": id}，用于纳入当前会话/工作区的作用域（不会扩大到其它项目）。' },
      crossProject: { type: 'boolean', description: '显式授权：把**其它项目**的记忆也纳入候选。它们会被降权并逐条标注。只有在"本项目没有相关经验、但想参考别处"时才传 true。' },
      authorizeReason: { type: 'string', description: 'crossProject: true 的理由，写进审计轨迹。' },
      limit: { type: 'integer', description: '最多注入多少条记录。' },
    },
    output: output({
      ok,
      intent: { type: 'string', description: '实际使用的 intent。' },
      text: { type: 'string', description: '可直接使用的 <anagenesis-memory> 块 + 状态脉冲。' },
      selected: { type: 'array', items: { type: 'string' }, description: '被注入记忆的 id，供 ana_feedback 使用。' },
      scopes: { type: 'json', description: '每条被注入记忆的作用域标签，按 id 对齐。' },
      crossProject: { type: 'integer', description: '其中来自其它项目的条数（>0 时不要盲从）。' },
      conflicts: { type: 'json', description: '检测到的跨项目冲突（语义相似但内容相反）。' },
      tokens: { type: 'integer', description: '整个回答（记忆块 + 状态脉冲）大致消耗多少 token。' },
      memoryTokens: { type: 'integer', description: '其中记忆块本身的 token 数 —— maxTokens 预算管的是这个数。' },
      strategy: { type: 'array', items: { type: 'string' }, description: '产生这个结果的策略栈。' },
      rejected: { type: 'json', description: '候选项被丢弃的原因，按原因归类（scope 一项就是被作用域隔离挡掉的数量）。' },
    }),
    execute: async (args, exec) => {
      const result = await service().recall({
        intent: args.intent,
        query: args.query,
        granularity: args.granularity,
        maxTokens: args.maxTokens,
        minConfidence: args.minConfidence,
        kinds: args.kinds,
        timeframe: args.timeframe,
        scope: args.scope,
        limit: args.limit,
      }, {
        scope: agentScope(exec),
        exec,
        crossProject: args.crossProject === true,
        reason: args.authorizeReason ?? '',
      })
      const empty = result.selected.length === 0
      return {
        ok: true,
        intent: result.intent,
        text: result.text === ''
          ? '没有记忆匹配这个 intent。可以改用 intent "orient" 再召回一次，或者调低 minConfidence。'
          : (empty ? `没有记忆匹配这个 intent（已检索当前项目与全局作用域）。\n\n${result.text}` : result.text),
        selected: result.selected.map((row) => row.id),
        scopes: Object.fromEntries(result.selected.map((row) => [row.id, row.scope])),
        crossProject: result.selected.filter((row) => row.crossProject).length,
        conflicts: result.conflicts,
        tokens: result.tokenCost,
        memoryTokens: result.memoryTokens,
        strategy: result.strategy,
        rejected: result.rejected,
      }
    },
  }))

  // ── 2. list (read-only, scope-aware) ─────────────────────────────────────
  tools.push(defineTool({
    name: 'ana_list',
    description: '列出记忆库里的记录**及其作用域标签**，不做检索排序。'
      + '默认只列当前项目 + 全局 + 当前会话；要列其它项目必须显式传 crossProject: true。'
      + '当你想确认"库里到底有什么、分别属于谁"时用它；当你需要一个 intent 相关的答案时用 ana_recall。',
    parameters: {
      limit: { type: 'integer', description: '最多列多少条（默认 25，最大 200）。' },
      states: { type: 'array', items: { type: 'string' }, description: '只看这些生命周期状态（默认除 retired 外全部）。' },
      kinds: { type: 'array', items: { type: 'string' }, description: `只看这些类型：${KINDS.join(', ')}。` },
      crossProject: { type: 'boolean', description: '显式授权：连其它项目的记录一起列出来（会被标注）。' },
    },
    output: output({
      ok,
      rows: { type: 'json', description: '记录摘要：id / scope / kind / state / gist。' },
      counts: { type: 'json', description: '按作用域层级与命名空间的计数。' },
      project: { type: 'string', description: '当前项目指纹。' },
    }),
    execute: async (args, exec) => {
      const result = await service().listMemories({
        limit: args.limit,
        states: args.states,
        kinds: args.kinds,
        crossProject: args.crossProject === true,
        exec,
      })
      return { ok: true, rows: result.rows, counts: result.counts, project: result.project }
    },
  }))

  // ── 3. audit ─────────────────────────────────────────────────────────────
  if (config.exposeAuditTool !== false) {
    tools.push(defineTool({
      name: 'ana_audit',
      description: '查看你自己的记忆与 anagenesis 机制：当前状态（含当前项目、档位与权限）、日志尾部、审计轨迹、'
        + '某条记忆及其连线和 provenance，或者某个策略。用它回答“我为什么相信这个”，也用它找到'
        + '回滚调用所需的 seq。查看别的项目的记忆需要显式 crossProject: true。',
      parameters: {
        view: { type: 'string', required: true, enum: ['status', 'journal', 'audit', 'memory', 'strategies', 'health', 'scope'], description: '要看什么。view=scope 专门看作用域与项目清单。' },
        id: { type: 'string', description: 'view=memory 时是记忆 id，view=strategies 时是策略 id。' },
        limit: { type: 'integer', description: 'journal/audit 视图的行数上限（默认 25，最大 500）。' },
        since: { type: 'integer', description: 'view=journal 的时间下界（epoch 毫秒）。' },
        type: { type: 'string', description: '日志事件类型过滤，例如 memory.forget 或 strategy.setStack。' },
        crossProject: { type: 'boolean', description: '显式授权：允许 view=memory 读取属于其它项目的记录。' },
      },
      output: output({
        ok,
        view: { type: 'string' },
        status: { type: 'json' },
        rows: { type: 'json' },
        memory: { type: 'json' },
      }),
      execute: async (args, exec) => {
        const svc = service()
        switch (args.view) {
          case 'status':
            return { ok: true, view: 'status', status: svc.status() }
          case 'scope':
            return { ok: true, view: 'scope', status: svc.scopeReport(exec) }
          case 'journal':
            return {
              ok: true,
              view: 'journal',
              rows: svc.store.recentEvents({ limit: args.limit, type: args.type, since: args.since }).map((event) => ({
                seq: event.seq,
                at: event.ts,
                type: event.type,
                scope: event.scope,
                ns: event.ns,
                touched: event.touched,
                payload: event.payload,
              })),
            }
          case 'audit':
            return { ok: true, view: 'audit', rows: svc.store.auditTrail(args.limit ?? 25) }
          case 'memory': {
            require_(args.id, 'id')
            const record = svc.store.state.memories[args.id]
            if (record === undefined) throw new Error(`anagenesis: unknown memory "${args.id}"`)
            // The isolation layer's third enforcement point: a direct read by id
            // is a query path like any other. Reading outside the current scope
            // requires the same explicit authorization a recall does.
            const access = svc.canRead(record, exec, args.crossProject === true)
            if (!access.ok) {
              throw new Error(`anagenesis: "${args.id}" belongs to ${scopeLabel(record.scope)} (${access.reason}); pass crossProject: true if you really mean to cross projects`)
            }
            // The 192-float embedding is noise for an agent reading a belief, so
            // it is left out — by *destructuring*, not by assigning
            // `embedding: undefined`. An undefined value keeps the key, JSON
            // drops it on the way out, and the host's lossless-JSON check then
            // rejects the entire answer (`value is not lossless JSON`).
            const { embedding: _drop, ...rest } = record
            return {
              ok: true,
              view: 'memory',
              memory: {
                ...rest,
                scopeLabel: scopeLabel(record.scope),
                linksResolved: rest.links.map((link) => ({
                  ...link,
                  exists: svc.store.state.memories[link.to] !== undefined,
                })),
              },
            }
          }
          case 'strategies':
            return { ok: true, view: 'strategies', rows: svc.registry.list('global'), status: { stack: svc.registry.stack('global') } }
          case 'health':
            return { ok: true, view: 'health', rows: svc.engine.health(), status: { stack: svc.engine.describe() } }
          default:
            throw new Error(`anagenesis: unknown ana_audit view "${args.view}"`)
        }
      },
    }))
  }

  // ── 4. scope administration (read actions here, mutations are admin tier) ──
  tools.push(defineTool({
    name: 'ana_scope',
    description: '记忆作用域的自省与修正。status/list/namespaces 是只读的；'
      + 'retag 把记录重新归档到别的作用域（需要 admin 档位），adopt 把迁移遗留的旧记忆按你确认的项目重新归档，'
      + 'drop-session 让一个会话的临时记忆立刻过期。**把项目级记忆提升为全局记忆必须显式传 authorizeGlobal，'
      + '而且要有用户授权** —— 一个项目的经验不是全世界的事实。',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'list', 'namespaces', 'retag', 'adopt', 'drop-session'], description: '要做什么。' },
      ids: { type: 'array', items: { type: 'string' }, description: 'retag/adopt 的目标记忆。' },
      tier: { type: 'string', enum: [...SCOPE_TIERS], description: 'retag 的目标层级。' },
      projectId: { type: 'string', description: 'retag 到 project 时的目标项目指纹（默认当前项目）。' },
      sessionId: { type: 'string', description: 'retag 到 session 时的会话 id。' },
      reason: { type: 'string', description: '为什么改作用域（至少 3 个字符，写进 provenance）。' },
      authorizeGlobal: { type: 'boolean', description: '显式授权把项目级记忆提升为全局。没有用户授权就不要传。' },
    },
    output: output({
      ok,
      action: { type: 'string' },
      report: { type: 'json', description: 'action=status/namespaces 的作用域报告。' },
      rows: { type: 'json', description: 'action=list 的记录摘要。' },
      changes: { type: 'json', description: 'retag/adopt 实际改动了哪些记录（from -> to）。' },
      seq,
    }),
    execute: async (args, exec) => {
      const svc = service()
      switch (args.action) {
        case 'status':
          return { ok: true, action: 'status', report: svc.scopeReport(exec) }
        case 'namespaces':
          return { ok: true, action: 'namespaces', report: svc.scopeReport(exec).namespaces }
        case 'list': {
          const result = await svc.listMemories({ limit: 200, exec, crossProject: true })
          return { ok: true, action: 'list', rows: result.rows }
        }
        case 'retag': {
          require_(args.reason, 'reason')
          require_(args.tier, 'tier')
          if (!Array.isArray(args.ids) || args.ids.length === 0) throw new Error('anagenesis: retag needs ids')
          const target = args.tier === 'project' ? (args.projectId ?? svc.scopeFor(exec).identity.id) : null
          const result = await svc.ops.retag({
            ids: args.ids,
            tier: args.tier,
            projectId: target,
            sessionId: args.sessionId ?? svc.scopeFor(exec).scope.session,
            reason: args.reason,
            authorizeGlobal: args.authorizeGlobal === true,
          })
          return pick({ ...result, action: 'retag' }, ['action', 'changes', 'seq'])
        }
        case 'adopt': {
          require_(args.reason, 'reason')
          const legacy = Object.values(svc.store.state.memories)
            .filter((record) => record.scope?.origin === 'migrated-global' && record.state !== 'retired')
            .map((record) => record.id)
            .slice(0, 50)
          if (legacy.length === 0) return { ok: true, action: 'adopt', changes: [] }
          const result = await svc.ops.retag({
            ids: legacy,
            tier: 'project',
            projectId: svc.scopeFor(exec).identity.id,
            reason: args.reason,
          })
          return pick({ ...result, action: 'adopt' }, ['action', 'changes', 'seq'])
        }
        case 'drop-session': {
          const sessionId = args.sessionId ?? svc.scopeFor(exec).scope.session
          if (sessionId === null || sessionId === undefined || sessionId === '') {
            throw new Error('anagenesis: drop-session needs a session id (none could be derived from this call)')
          }
          const result = await svc.dropSession(sessionId, args.reason ?? 'session ended')
          return pick({ ...result, action: 'drop-session' }, ['action', 'ids', 'seq'])
        }
        default:
          throw new Error(`anagenesis: unknown ana_scope action "${args.action}"`)
      }
    },
  }))

  // ── 5. preset / permission status (gear switching is admin tier) ─────────
  tools.push(defineTool({
    name: 'ana_preset',
    description: '查看当前预设与**权限档位**：预设是否激活、档位是什么、你手上到底有哪些工具。'
      + 'action=gear 可以切换档位（需要 admin 档位；可以向下降级，向上升级需要宿主授权）。'
      + '档位：passive=只读，assisted=可写（关键操作要显式调用），autonomous=可写且策略可自动调度、技能可自动结晶。',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'tools', 'gear'], description: 'status=预设与权限总览，tools=当前可用工具集，gear=切换档位。' },
      gear: { type: 'string', enum: [...GEAR_IDS], description: 'action=gear 的目标档位。' },
      reason: { type: 'string', description: '切换档位的理由，写进审计轨迹。' },
    },
    output: output({
      ok,
      action: { type: 'string' },
      status: { type: 'json', description: '预设、档位、工具集与作用域总览。' },
      tools: { type: 'array', items: { type: 'string' }, description: '当前档位允许的工具名。' },
      seq,
    }),
    execute: async (args, exec) => {
      const svc = service()
      switch (args.action) {
        case 'status':
          return { ok: true, action: 'status', status: svc.permissionReport(exec) }
        case 'tools':
          return { ok: true, action: 'tools', tools: svc.permissions.allowedTools(), status: svc.permissionReport(exec) }
        case 'gear': {
          require_(args.gear, 'gear')
          const result = await svc.setGear(args.gear, { reason: args.reason ?? 'agent requested a gear change', by: 'agent' })
          return { ok: true, action: 'gear', seq: result.seq, status: { gear: result.gear, previous: result.previous, stack: svc.engine.describe() } }
        }
        default:
          throw new Error(`anagenesis: unknown ana_preset action "${args.action}"`)
      }
    },
  }))

  // ── 6. strategy control (read actions here, mutations are admin tier) ────
  tools.push(defineTool({
    name: 'ana_strategy',
    description: '在运行时查看并切换注入策略栈。策略是纯函数包：'
      + 'explore（高召回，写入 draft）、exploit（只注入已验证内容，给出可执行规则）、debug（失败与未决问题，不做时间衰减）、'
      + 'distill（压缩优先）。每个写操作都是一笔可回滚的日志事务，且需要 admin 档位。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'switch', 'preset', 'push', 'register', 'derive', 'deactivate', 'revert', 'health'],
        description: 'list=列出可用策略，switch=用 guard+id 整体替换栈，preset=改用具名栈，push=追加，register=注册一份新策略文档，derive=按某个基础策略的参数差异派生新策略，deactivate=移除一个，revert=回滚到之前的某个 seq，health=hook 失败/熔断状态。',
      },
      id: { type: 'string', description: '策略 id；action=preset 时是预设名。' },
      preset: { type: 'string', enum: Object.keys(BUILTIN_STACKS), description: `action=preset 使用的具名栈：${Object.keys(BUILTIN_STACKS).join(', ')}。` },
      baseId: { type: 'string', description: 'action=derive 的基础策略。' },
      params: { type: 'json', description: '参数覆盖。register 时：{"impl","params","disabledHooks"}；derive 时：受 envelope 约束的参数差异。' },
      disableHooks: { type: 'array', items: { type: 'string' }, description: `在派生策略上要禁用的 hook：${HOOKS.join(', ')}。filter hook 不可禁用。` },
      rationale: { type: 'string', description: '为什么做这次策略变更，写入审计轨迹。' },
      seq: { type: 'integer', description: 'action=revert 用的日志 seq。' },
      scope: { type: 'string', description: '栈的作用域（默认 global）。' },
    },
    output: output({
      ok,
      action: { type: 'string' },
      stack: { type: 'array', items: { type: 'string' }, description: '变更后的栈。' },
      strategies: { type: 'json', description: 'action=list 的策略清单。' },
      health: { type: 'json', description: 'action=health 的 hook 健康状态。' },
      id: { type: 'string', description: 'register/derive 产生的新策略 id。' },
      seq,
    }),
    execute: async (args) => {
      const svc = service()
      const scope = args.scope ?? 'global'
      switch (args.action) {
        case 'list':
          return { ok: true, action: 'list', strategies: svc.registry.list(scope), stack: svc.registry.stack(scope) }
        case 'switch': {
          require_(args.id, 'id')
          const result = await svc.registry.activate(args.id, { scope, reason: args.rationale })
          return { ok: true, action: 'switch', stack: result.stack, seq: result.seq }
        }
        case 'preset': {
          const preset = args.preset ?? args.id
          require_(preset, 'preset')
          const result = await svc.registry.activate(preset, { scope, mode: 'preset', reason: args.rationale })
          return { ok: true, action: 'preset', stack: result.stack, seq: result.seq }
        }
        case 'push': {
          require_(args.id, 'id')
          const result = await svc.registry.activate(args.id, { scope, mode: 'push', reason: args.rationale })
          return { ok: true, action: 'push', stack: result.stack, seq: result.seq }
        }
        case 'register': {
          const spec = args.params ?? {}
          const registered = await svc.registry.register({
            id: args.id,
            impl: spec.impl ?? args.baseId,
            params: spec.params ?? {},
            disabledHooks: spec.disabledHooks ?? args.disableHooks,
            label: spec.label,
            lineage: { by: 'agent', rationale: args.rationale ?? null, at: Date.now() },
            scope,
          })
          return { ok: true, action: 'register', id: registered.id, seq: registered.seq }
        }
        case 'derive': {
          require_(args.baseId, 'baseId')
          const derived = await svc.registry.derive(args.baseId, {
            params: args.params ?? {},
            disableHooks: args.disableHooks,
            rationale: args.rationale,
          }, { scope })
          return { ok: true, action: 'derive', id: derived.id, seq: derived.seq, stack: svc.registry.stack(scope) }
        }
        case 'deactivate': {
          require_(args.id, 'id')
          const result = await svc.registry.deactivate(args.id, { scope })
          return { ok: true, action: 'deactivate', stack: result.stack, seq: result.seq }
        }
        case 'revert': {
          require_(args.seq, 'seq')
          const result = await svc.store.revert(args.seq, args.rationale ?? 'ana_strategy revert')
          return { ok: true, action: 'revert', seq: result.seq, stack: svc.registry.stack(scope) }
        }
        case 'health':
          return { ok: true, action: 'health', health: svc.engine.health(), stack: svc.engine.describe() }
        default:
          throw new Error(`anagenesis: unknown ana_strategy action "${args.action}"`)
      }
    },
  }))

  // ── 7. meta tuning (read actions here, mutations are admin tier) ─────────
  if (config.exposeTuneTool !== false) {
    tools.push(defineTool({
      name: 'ana_tune',
      description: '第 3 层：依据观察到的结果调整你自己的策略参数，然后验证、必要时回滚。'
        + 'propose=只给建议（不写入），apply=提交一处受约束的改动（admin 档位），evaluate=与上一次调参做对比，'
        + 'rollback=按 auditId 撤销一次已应用的改动（admin 档位），report=当前指标。每个旋钮都被钳制在声明好的 envelope 内，'
        + 'safeMode 会完全冻结这个工具。',
      parameters: {
        action: { type: 'string', required: true, enum: ['propose', 'apply', 'evaluate', 'rollback', 'report'], description: '要做什么。' },
        objective: { type: 'string', enum: OBJECTIVES, description: '优化哪个信号：utilization、precision、token_efficiency、task_success。' },
        param: { type: 'string', description: `envelope 的键，例如 ${Object.keys(PARAM_ENVELOPE).slice(0, 4).join(', ')}。` },
        value: { type: 'number', description: 'action=apply 的目标值（会被钳制到 envelope 内）。' },
        auditId: { type: 'string', description: 'action=rollback 用的调参审计 id（由 apply 返回）。' },
        reason: { type: 'string', description: '为什么做这次调整；apply 时必填。' },
        force: { type: 'boolean', description: '跳过最小样本数门槛或 safeMode 冻结（日志里记为 forced）。' },
      },
      output: output({
        ok,
        action: { type: 'string' },
        proposal: { type: 'json', description: '提议的或给定的改动及其理由。' },
        evaluation: { type: 'json', description: 'action=evaluate 的结果。' },
        report: { type: 'json', description: 'action=report 的当前指标与历史。' },
        auditId: { type: 'string' },
        seq,
      }),
      execute: async (args) => {
        const svc = service()
        switch (args.action) {
          case 'propose':
            return { ok: true, action: 'propose', proposal: svc.tuner.propose({ objective: args.objective, param: args.param }) }
          case 'apply': {
            require_(args.param, 'param')
            require_(args.reason, 'reason')
            const proposal = args.value === undefined
              ? svc.tuner.propose({ objective: args.objective, param: args.param })
              : { param: args.param, to: args.value, from: svc.tuner.value(args.param), rationale: args.reason }
            const applied = await svc.tuner.apply(proposal, { reason: args.reason, force: args.force })
            return { ok: true, action: 'apply', auditId: applied.auditId, seq: applied.seq, proposal: { param: applied.param, from: applied.from, to: applied.to } }
          }
          case 'evaluate':
            return { ok: true, action: 'evaluate', evaluation: svc.tuner.evaluate() }
          case 'rollback': {
            require_(args.auditId, 'auditId')
            const rolled = await svc.tuner.rollback(args.auditId, { reason: args.reason })
            return { ok: true, action: 'rollback', auditId: args.auditId, seq: rolled.seq, proposal: { param: rolled.param, restored: rolled.restored } }
          }
          case 'report':
            return { ok: true, action: 'report', report: svc.tuner.report() }
          default:
            throw new Error(`anagenesis: unknown ana_tune action "${args.action}"`)
        }
      },
    }))
  }

  return tools
}

/**
 * Every tool the write tier owns. Registered **only** by `src/tools/gated.js`,
 * which only ever runs inside a live preset grant.
 *
 * Nothing in this list may be reachable without a grant — that is the property
 * `test/permission.test.js` asserts by name.
 * @param {{ service: () => any, config: any }} deps
 * @returns {any[]}
 */
export function buildWriteTools(deps) {
  const { service } = deps
  /** @type {any[]} */
  const tools = []

  // ── 1. remember ──────────────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'ana_remember',
    description: '把一件事写进你自己的记忆。**默认写入当前项目作用域**（不是全局）——'
      + '这样它就不会在别的项目里被召回。要写跨项目通用的事实，显式传 scope: {tier:"global"}。'
      + '初始生命周期状态由策略栈决定（explore 写为 draft，exploit 直接收为 active），内容重复时按作用域去重。',
    parameters: {
      kind: { type: 'string', enum: KINDS, description: `这是哪一类东西：${KINDS.join(', ')}。` },
      subject: { type: 'string', required: true, description: '一句话的断言或标题。' },
      body: { type: 'string', required: true, description: '内容本体。要自包含：未来的你只能看到这一段。' },
      gist: { type: 'string', description: '以 gist 粒度注入这条记忆时用的一行压缩。' },
      tags: { type: 'array', items: { type: 'string' }, description: '自由标签，方便以后筛选。' },
      confidence: { type: 'number', description: '你的置信度 0..1。要诚实：它决定注入阈值。' },
      salience: { type: 'number', description: '这件事有多重要 0..1。若这条记忆从未被引用，重要度会衰减。' },
      ttlMs: { type: 'integer', description: '存活毫秒数；到期后这条记忆自动过期。' },
      state: { type: 'string', enum: ['draft', 'active', 'verified'], description: '强制指定初始状态，压过策略的决定。' },
      evidence: { type: 'array', items: { type: 'string' }, description: '你凭什么相信它：观察到的输出、文件路径、测试结果。' },
      scope: scopeJson,
    },
    output: output({
      ok,
      id: { type: 'string', description: '记忆的 id（命中去重时是已存在那条的 id）。' },
      state: { type: 'string', description: '实际采用的初始生命周期状态。' },
      scope: { type: 'string', description: '这条记忆实际落在哪个作用域。' },
      decidedBy: { type: 'array', items: { type: 'string' }, description: '参与决定这次写入的策略。' },
      deduplicated: { type: 'boolean', description: '内容已存在并命中去重时为 true。' },
      seq,
    }),
    execute: async (args, exec) => {
      const svc = service()
      const draft = { ...args }
      const decision = svc.engine.decideWrite(draft, { intent: 'write' })
      if (decision.reject !== undefined) throw new Error(`anagenesis: write refused by strategy: ${decision.reject}`)
      const scope = svc.writeScope(exec, args.scope)
      const result = await svc.ops.remember({
        ...draft,
        kind: args.kind ?? 'fact',
        state: args.state ?? decision.state,
        confidence: args.confidence ?? decision.confidence,
        ttlMs: args.ttlMs ?? decision.ttlMs ?? null,
        scope,
        provenance: { source: 'agent', evidence: args.evidence ?? [] },
      })
      const value = {
        ok: true,
        id: result.id,
        state: draft.state ?? decision.state,
        // Labelled from what was actually **stored** (`createMemory` normalizes
        // the request: a tier with no id to bind to degrades narrower, never
        // wider). Labelling the request object instead would report a scope the
        // record does not have — the one lie this whole change exists to stop.
        scope: scopeLabel(result.record?.scope ?? scope),
        decidedBy: decision.decidedBy,
        deduplicated: result.deduplicated === true,
      }
      // A deduplicated write produced no event, so it has no seq to hand back.
      // The old code returned the *current store version*, which is the seq of
      // whatever transaction ran last — a caller reverting "its own write" would
      // have compensated an unrelated one. Absent is honest; wrong is not.
      if (result.seq !== undefined) value.seq = result.seq
      return value
    },
  }))

  // ── 2. lifecycle: promote / demote / lock / expire ───────────────────────
  tools.push(defineTool({
    name: 'ana_promote',
    description: '把一条记忆提升到更强的生命周期状态（active -> verified -> locked）。'
      + '整批要么全部成功、要么全部不做，同时把置信度抬到该状态的下限。请附上 evidence —— 没有证据的提升正是记忆库腐烂的方式。'
      + '**不能把项目级记忆提升为全局记忆**：那是 ana_scope retag 的事，而且需要用户显式授权。',
    parameters: {
      ids: ids('要提升的记忆。'),
      to: { type: 'string', required: true, enum: ['active', 'verified', 'locked'], description: '目标状态。' },
      reason: { type: 'string', required: true, description: '为什么它现在可信了。会记入 provenance。' },
      evidence: { type: 'array', items: { type: 'string' }, description: '具体的验证：跑过的测试、核对过的来源。' },
      force: { type: 'boolean', description: '要把记忆移出 locked 状态，必须显式传 force。' },
    },
    output: output({ ok, ids: { type: 'array', items: { type: 'string' } }, to: { type: 'string' }, seq }),
    execute: async (args) => pick(await service().ops.promote(args), ['ids', 'to', 'seq']),
  }))

  tools.push(defineTool({
    name: 'ana_demote',
    description: '把一条记忆降级，因为它被证明是错的、过时的或未经证实的。'
      + 'to=draft 表示继续探索它，deprecated 表示默认不再注入，expired 表示现在就停止信任它。',
    parameters: {
      ids: ids('要降级的记忆。'),
      to: { type: 'string', required: true, enum: ['draft', 'deprecated', 'expired'], description: '目标状态。' },
      reason: { type: 'string', required: true, description: '是什么证伪或削弱了它。' },
      force: { type: 'boolean', description: '要把记忆移出 locked 状态，必须显式传 force。' },
    },
    output: output({ ok, ids: { type: 'array', items: { type: 'string' } }, to: { type: 'string' }, seq }),
    execute: async (args) => pick(await service().ops.demote(args), ['ids', 'to', 'seq']),
  }))

  tools.push(defineTool({
    name: 'ana_lock',
    description: '把一个信念钉成已验证，不再受衰减和降级影响。锁定记忆是 exploit 模式默认唯一会注入的东西，'
      + '要离开 locked 状态必须显式 force: true。请克制使用锁定。',
    parameters: {
      ids: ids('要锁定的记忆。'),
      reason: { type: 'string', required: true, description: '为什么它绝不能衰减。' },
      ttlMs: { type: 'integer', description: '可选的复检截止时间（毫秒）；到点后锁定即转为过期。' },
    },
    output: output({ ok, ids: { type: 'array', items: { type: 'string' } }, seq }),
    execute: async (args) => pick(await service().ops.lock(args), ['ids', 'seq']),
  }))

  tools.push(defineTool({
    name: 'ana_expire',
    description: '不再信任一条记忆，但不删除它 —— 可以立刻生效，也可以给一段宽限期'
      + '（graceMs > 0 表示“再注入一阵子，然后放手”）。当时间让这个断言失效时使用。',
    parameters: {
      ids: ids('要过期的记忆。'),
      reason: { type: 'string', required: true, description: '为什么它不再成立。' },
      graceMs: { type: 'integer', description: '宽限期（毫秒），到点后这条记忆才被当作已过期。' },
    },
    output: output({ ok, ids: { type: 'array', items: { type: 'string' } }, seq }),
    execute: async (args) => pick(await service().ops.expire(args), ['ids', 'seq']),
  }))

  // ── 3. split / rethink / forget ──────────────────────────────────────────
  tools.push(defineTool({
    name: 'ana_split',
    description: '把一条信息过载的记忆拆成更窄的几条。父记录在同一笔事务里退休，子记录携带 parentId（并继承父记录的作用域），'
      + '血缘因此保留。当一条记忆混着几个各自独立成立或失效的断言时使用。',
    parameters: {
      id: { type: 'string', required: true, description: '要拆分的记忆。' },
      into: {
        type: 'array',
        required: true,
        items: { type: 'json' },
        description: '子记录，每条形如 {"subject","body","gist?","kind?","confidence?"}。至少一条。',
      },
      reason: { type: 'string', required: true, description: '为什么这条记忆必须被拆开。会记在父记录的 provenance 上。' },
      retireParent: { type: 'boolean', description: '把父记录降级为 deprecated（默认 true）。' },
    },
    output: output({ ok, id: { type: 'string' }, children: { type: 'array', items: { type: 'string' } }, seq }),
    execute: async (args) => pick(await service().ops.split(args), ['id', 'children', 'seq']),
  }))

  tools.push(defineTool({
    name: 'ana_rethink',
    description: '反事实重思：假设 `premise` 的反面成立，把它作为一条一等公民的 "hypothesis" 记忆存下来，'
      + '并与每一条受影响的记录连线（rel=counterfactual_of，反向是 challenged_by）。'
      + '任何东西都不会被覆盖 —— 你得到一个可以权衡的、显式的对立信念，这正是重思可被审计的原因。',
    parameters: {
      premise: { type: 'string', required: true, description: '要被质疑的信念，用一个命题表述。' },
      counterfactual: { type: 'string', required: true, description: '如果该前提为假会推出什么，以及你会怎么做才不同。' },
      ids: ids('受这次重思影响的记忆（通常来自 ana_recall）。'),
      confidence: { type: 'number', description: '你对这个反事实的置信度，设计上限为 0.5。' },
    },
    output: output({ ok, hypothesisId: { type: 'string' }, affected: { type: 'array', items: { type: 'string' } }, seq }),
    execute: async (args) => pick(await service().ops.rethink(args), ['hypothesisId', 'affected', 'seq']),
  }))

  tools.push(defineTool({
    name: 'ana_forget',
    description: '真正删除记忆内容，只留下一块可审计的墓碑。日志保留了删除前的原像，'
      + '所以可以按日志 seq 回滚 —— 但 agent 再也看不到它了。锁定中的记忆需要显式 force: true。',
    parameters: {
      ids: ids('要遗忘的记忆。'),
      reason: { type: 'string', required: true, description: '为什么必须移除它（至少 3 个字符）。' },
      force: { type: 'boolean', description: '要遗忘一条锁定中的记忆，必须显式传 force。' },
    },
    output: output({ ok, ids: { type: 'array', items: { type: 'string' } }, seq }),
    execute: async (args) => pick(await service().ops.forget(args), ['ids', 'seq']),
  }))

  // ── 4. cross-memory linking (used by rethink/split chains) ───────────────
  tools.push(defineTool({
    name: 'ana_link',
    description: '显式地把两条记忆关联起来（rel：related、supports、contradicts、supersedes、caused_by、part_of）。'
      + '连线会影响召回排序，也是让一条重思链日后仍可被遍历的原因。',
    parameters: {
      from: { type: 'string', required: true, description: '源记忆 id。' },
      to: { type: 'string', required: true, description: '目标记忆 id。' },
      rel: { type: 'string', required: true, description: '关系名。' },
    },
    output: output({ ok, seq }),
    execute: async (args) => pick(await service().ops.link(args), ['seq']),
  }))

  // ── 5. feedback ──────────────────────────────────────────────────────────
  tools.push(defineTool({
    name: 'ana_feedback',
    description: '汇报你拿到手的那些记忆后来怎么样了。这是元层唯一的学习依据：'
      + '被引用的记忆重要度上升，被忽略的下降，成功/失败则驱动调参器。'
      + '在一件实质性任务结束时调用一次。',
    parameters: {
      usedIds: { type: 'array', items: { type: 'string' }, description: '来自 ana_recall、且真正改变了你行为的 id。' },
      ignoredIds: { type: 'array', items: { type: 'string' }, description: '被注入但毫无用处的 id。' },
      success: { type: 'boolean', description: '任务成功了吗？' },
      tokenCost: { type: 'integer', description: '注入的记忆块大致消耗多少 token。' },
      objective: { type: 'string', enum: OBJECTIVES, description: '这条反馈给哪个目标打分。' },
      note: { type: 'string', description: '自由文本观察，写入审计轨迹。' },
    },
    output: output({
      ok,
      reward: { type: 'number', description: '针对这次观察算出的奖励。' },
      objective: { type: 'string' },
      components: { type: 'json' },
      seq,
    }),
    execute: async (args, exec) => {
      const svc = service()
      // Feedback is per-caller: salience is partitioned by scope (schema v4), so
      // the agent that reports usage is the agent whose ranking moves.
      const usage = await svc.ops.recordUse({
        usedIds: args.usedIds ?? [],
        ignoredIds: args.ignoredIds ?? [],
        scope: agentScope(exec),
      })
      const signal = await svc.tuner.observe({
        usedIds: args.usedIds,
        ignoredIds: args.ignoredIds,
        success: args.success,
        tokenCost: args.tokenCost,
        objective: args.objective,
      })
      const engineNotes = svc.engine.notifyResult({ ...args, outcome: signal })
      const scopeContext = svc.scopeFor(exec)
      await svc.store.audit('feedback.report', {
        note: args.note ?? null,
        success: args.success ?? null,
        project: scopeContext.identity.id,
        gear: svc.permissions.gear(),
        engineNotes: engineNotes.notes,
      }, {
        // The event payload is what reactive layers read (the autonomy policies
        // switch the cognitive mode on a reported failure). The audit row keeps
        // the prose; the payload keeps the machine-readable signal.
        payload: {
          success: args.success ?? null,
          used: (args.usedIds ?? []).length,
          ignored: (args.ignoredIds ?? []).length,
          objective: args.objective ?? signal.objective,
        },
      })
      const value = {
        ok: true,
        reward: Number(signal.reward.toFixed(4)),
        objective: signal.objective,
        components: signal.components,
      }
      // `usage.seq` is the salience transaction, which only exists when there was
      // something to book. With no ids to credit the call still feeds the tuner,
      // but it has no seq of its own — and the previous code returned the current
      // store version, which belongs to somebody else's transaction.
      if (usage.seq !== undefined) value.seq = usage.seq
      return value
    },
  }))

  return tools
}

/**
 * The gear ids, re-exported so a row can validate config without importing the
 * permission module directly.
 * @returns {string[]}
 */
export function gearIds() {
  return [...GEAR_IDS, GEAR_NONE]
}
