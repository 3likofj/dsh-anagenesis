/**
 * anagenesis-viz — the visualization row.
 *
 * A separate Loader row, on purpose: visualization is the one part of anagenesis
 * that is allowed to be absent. `disabled: true` on this row removes both tools
 * and nothing else; the memory layer, the strategy engine and the guard keep
 * running because this row never touches them. It also **provides no service** —
 * the bundle mounts it globally and the `anagenesis` preset mounts it again in its
 * own scope, and `ctx.provide` refuses a duplicate name inside one isolation
 * scope (HANDOFF §10.16). Registering two tools, which the tool layer handles
 * per layer, is the whole surface.
 *
 * The row is read-only with respect to the store: `ana_dashboard` and
 * `ana_diagram` project state that already exists, and the store's version is
 * unchanged by a render. The only optional write is `auditRenders`, off by
 * default, which appends a non-compensable `viz.render` audit row — audit rows
 * are records that something happened (HANDOFF §16/D3), and a render is exactly
 * that.
 * @module dsh-anagenesis/viz
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

import { DASHBOARD_SECTIONS, DIAGRAM_KINDS, buildDashboardModel, buildDiagramModel } from './model.js'
import { renderFrame } from './tui.js'
import { DIAGRAM_FORMATS, renderDiagram } from './diagram.js'
import { DEFAULT_REDACTION, REDACTION_LEVELS } from './redact.js'

export const name = 'anagenesis-viz'

/** Needs the tool registry and the service; both must exist before a render can mean anything. */
export const inject = ['tools', 'anagenesis']

export const Config = Schema.object({
  /** 'never' by default: a frame inside a tool answer is not a TTY. */
  color: Schema.string().default('never')
    .description('文本着色策略；默认 never —— 工具回答里的文本帧不是 TTY，不该带颜色码。'),
  width: Schema.number().default(96)
    .description('文本帧宽度（终端格数；中文按显示宽度计算）。'),
  lang: Schema.string().default('zh')
    .description('终端文本帧与文本图表的语言：zh（默认）| en。窗口界面有自己的中文层，不受它影响。'),
  redaction: Schema.string().default(DEFAULT_REDACTION)
    .description(`产出文本的脱敏策略：${REDACTION_LEVELS.join(' | ')}。默认只擦洗凭据并省略正文。`),
  events: Schema.number().default(8)
    .description('默认显示多少条日志事件。'),
  salience: Schema.number().default(5)
    .description('默认显示多少条最高显著度的记录。'),
  diagramNodes: Schema.number().default(40)
    .description('memory-graph 的默认节点上限。'),
  includeBodies: Schema.boolean().default(false)
    .description('默认是否在最高显著度记录下面附一段截断的正文预览（脱敏开启时会被擦洗）。'),
  auditRenders: Schema.boolean().default(false)
    .description('为 true 时每次渲染追加一条 viz.render 审计行。默认 false：读不该让日志长大。'),
})

/** @param {unknown} value @param {number} fallback @returns {number} */
function num(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Config values with the row's own defaults behind them. The host applies the
 * `Config` schema, but a row that is mounted with a partial config (a test, a
 * hand-written composition, an older host) must still behave — falling through
 * to `undefined` here once produced an empty diagram that looked like an empty
 * store.
 * @param {any} config
 * @returns {{ color: string, width: number, lang: string, events: number, salience: number, diagramNodes: number, timeline: number }}
 */
function resolved(config) {
  return {
    color: String(config.color ?? 'never'),
    width: num(config.width, 96),
    lang: String(config.lang ?? 'zh') === 'en' ? 'en' : 'zh',
    events: num(config.events, 8),
    salience: num(config.salience, 5),
    diagramNodes: num(config.diagramNodes, 40),
    timeline: Math.max(4, num(config.events, 8) * 2),
  }
}

/**
 * Derive the salience scope from the calling agent, exactly like the tools row
 * does: `registry.stack(scope)` falls back to the global stack for an unknown
 * scope, so an older host degrades instead of failing.
 * @param {any} exec
 * @returns {string}
 */
function agentScope(exec) {
  const agent = exec?.agent
  const id = agent?.id ?? agent?.sessionId ?? agent?.name
  return typeof id === 'string' && id !== '' ? `agent:${id}` : 'global'
}

/**
 * Shared output contract: a flat, explicitly closed object plus a text renderer.
 * Deliberately the same shape as `src/tools/index.js` — the host validates this
 * schema (`assertSupportedJsonSchema`) and a flat closed object is the subset
 * every surface understands.
 * @param {Record<string, any>} properties
 */
function output(properties) {
  return {
    schema: { type: 'object', additionalProperties: false, properties },
    render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value ?? null, null, 2) }],
  }
}

const ok = { type: 'boolean', required: true, description: '是否真的产出了这次渲染。' }
const warnings = { type: 'array', items: { type: 'string' }, description: '渲染器想让你知道的一切（上限、脱敏、镜像模式）。' }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger
  const service = () => {
    const found = ctx.get('anagenesis')
    if (found === undefined) throw new Error('anagenesis-viz: the anagenesis service is not available in this scope')
    return found
  }
  const redaction = REDACTION_LEVELS.includes(String(config.redaction)) ? String(config.redaction) : DEFAULT_REDACTION
  const limits = resolved(config)
  const stats = { renders: 0, diagrams: 0, lastAt: /** @type {number|null} */ (null), errors: 0 }

  /** A read-only view of the live service. Nothing here is cached beyond one call. */
  const liveSource = (exec) => {
    const svc = service()
    return {
      state: svc.store.state,
      events: svc.store.recentEvents({ limit: 500 }),
      journal: svc.store.journalStats(),
      engine: { active: svc.engine.describe(), health: svc.engine.health() },
      tuning: svc.tuner.report(),
      // Scope and gear are facts about *this caller*, not about the store, so
      // they can only come from the service. Both are pure reads.
      scope: svc.scopeReport(exec),
      permissions: svc.permissionReport(exec),
      selfStatus: { renders: stats.renders, diagrams: stats.diagrams, lastAt: stats.lastAt, errors: stats.errors, mode: 'tool' },
      origin: 'live',
    }
  }

  /**
   * Where this call stands, as the model wants it.
   *
   * The default is the *honest* view: what this agent could actually recall
   * (current project + global + current session). `allProjects: true` is the
   * operator's explicit widening to the whole store, and it is loud about it —
   * the model adds a warning line saying the agent itself would not see these.
   * The session comes from `context.sessionId`, **not** `context.scope.session`.
   * `scopeFor()` returns both on purpose and they are not the same value: the
   * scope tag carries a session only when the write tier *is* the session
   * (`tier: 'session'`), so for the ordinary project-tier caller
   * `scope.session` is `null`. Handing that to the filter makes `scopeRelation`
   * call every `session:<id>` record `other-session` — an agent blind to the
   * working notes of the session it is sitting in, which is precisely the half
   * of "current project + global + current session" this default promises.
   * @param {any} exec
   * @param {any} args
   * @returns {{ projectId: string, sessionId: string|null, allProjects: boolean }}
   */
  const callScope = (exec, args) => {
    const context = service().scopeFor(exec)
    return {
      projectId: context.identity.id,
      sessionId: context.sessionId ?? null,
      allProjects: args?.allProjects === true,
    }
  }

  /**
   * Optional audit trail for renders. Off by default: a read should not grow the
   * journal. When on, the row is honest about what it is — an audit-only event
   * has no inverse, so the tool reports its seq instead of implying revertibility.
   * @param {string} what
   * @param {any} model
   * @returns {Promise<number>}
   */
  const auditRender = async (what, model) => {
    if (config.auditRenders !== true) return 0
    try {
      const result = await service().store.audit('viz.render', {
        what,
        kind: String(model?.kind ?? 'unknown'),
        storeVersion: Number(model?.store?.version ?? 0),
        redaction,
      }, { by: 'agent' })
      return Number(result?.seq ?? 0)
    } catch (error) {
      stats.errors += 1
      logger?.warn?.(`anagenesis-viz: could not audit the render: ${error instanceof Error ? error.message : String(error)}`)
      return 0
    }
  }

  ctx.tools.register(defineTool({
    name: 'ana_dashboard',
    description: '打开一个终端原生仪表盘，俯视你自己的记忆：作用域（当前项目、各命名空间的条数、默认写入档位、预设档位 gear）、'
      + '生命周期与类型分布、策略栈、偏离 envelope 默认值的那些调参旋钮、日志尾部、最显著的那些信念，以及这个渲染器自身的健康状况。'
      + '默认只显示你**召得回**的那些记录（当前项目 + 全局 + 当前会话），并在作用域分区里写明这一点；'
      + '传 allProjects: true 才是运维视角（整份存储，含其它项目的记忆），此时帧里会多一条告警说明 Agent 自己看不到它们。'
      + '只读 —— 除非本行配置了 auditRenders，否则绝不写入存储。'
      + '要看持续重绘的实时视图，请在终端里运行 `node tools/viz-watch.mjs --watch`。',
    parameters: {
      sections: { type: 'array', items: { type: 'string' }, description: `要渲染的分区子集：${DASHBOARD_SECTIONS.join(', ')}。` },
      width: { type: 'integer', description: '文本帧宽度（终端格数，48–200）。' },
      events: { type: 'integer', description: '显示多少条日志事件。' },
      salience: { type: 'integer', description: '显示多少条最高显著度的记录。' },
      allProjects: { type: 'boolean', description: '默认 false：只显示当前项目 + 全局 + 当前会话（模型真正召得回的那些）。true 时放宽到整份存储（运维视角，会加一条告警）。' },
      scope: { type: 'json', description: '{"session","workspace","preset"}（旧形状），在作用域过滤之上再收窄一层；新调用请用 allProjects。' },
      redaction: { type: 'string', enum: [...REDACTION_LEVELS], description: '产出文本的脱敏策略。默认 secrets。' },
      includeBodies: { type: 'boolean', description: '在每条最高显著度记录下面附一段截断的正文预览（脱敏开启时会被擦洗）。' },
    },
    output: output({
      ok,
      text: { type: 'string', required: true, description: '渲染好的文本帧，可直接印在任何等宽界面里。' },
      width: { type: 'integer', description: '实际使用的帧宽度。' },
      sections: { type: 'array', items: { type: 'string' }, description: '已渲染的分区，按顺序。' },
      storeVersion: { type: 'integer', description: '这一帧投影自哪一版存储 —— 交给 ana_audit 的句柄。' },
      origin: { type: 'string', description: 'live（服务）还是 mirror（文件）。' },
      redaction: { type: 'string', description: '实际应用的脱敏策略。' },
      warnings,
      auditSeq: { type: 'integer', description: 'viz.render 审计行的日志 seq；auditRenders 关闭时为 0。' },
    }),
    execute: async (args, exec) => {
      try {
        // Count before projecting: the frame is supposed to report the render
        // that is being produced, not the one before it.
        stats.renders += 1
        stats.lastAt = Date.now()
        const model = buildDashboardModel(liveSource(exec), {
          sections: args.sections,
          width: num(args.width, limits.width),
          color: limits.color,
          lang: limits.lang,
          limit: { events: num(args.events, limits.events), salience: num(args.salience, limits.salience) },
          scopeContext: callScope(exec, args),
          scope: args.scope ?? null,
          salienceScope: agentScope(exec),
          redaction: REDACTION_LEVELS.includes(String(args.redaction)) ? String(args.redaction) : redaction,
          includeBody: args.includeBodies ?? config.includeBodies === true,
        })
        const text = renderFrame(model, { width: model.render.width, color: model.render.color, sections: args.sections, isTty: false })
        return {
          ok: true,
          text,
          width: model.render.width,
          sections: model.sections.map((section) => String(section.id)),
          storeVersion: model.store.version,
          origin: String(model.origin),
          redaction: String(model.redaction.level),
          warnings: model.warnings,
          auditSeq: await auditRender('dashboard', model),
        }
      } catch (error) {
        stats.errors += 1
        logger?.warn?.(`anagenesis-viz: dashboard render failed: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ana_diagram',
    description: '把你的记忆渲染成可以直接粘进 Markdown 的文本图表：带连线的信念图（kind=memory-graph）、'
      + 'stack/tune/revert 事件构成的治理时间线（kind=strategy-timeline），或观测到的生命周期迁移（kind=lifecycle）。'
      + 'memory-graph 的每个节点都带 scope（作用域短标签，如 project:ab12cd / global / session:xxxx）与 relation'
      + '（current-project / other-project / global / current-session / other-session / unscoped），跨项目与未标注的节点会被标成 warn 并着色。'
      + '默认只画你**召得回**的那些记录；传 allProjects: true 才画整份存储，此时会多一条告警。'
      + '默认 mermaid，也可用 D2 与纯 ASCII。产物自带版本化表头（kind、store 版本、脱敏策略），'
      + '所以一张旧图仍然可读。',
    parameters: {
      kind: { type: 'string', enum: [...DIAGRAM_KINDS], description: 'memory-graph | strategy-timeline | lifecycle。' },
      format: { type: 'string', enum: [...DIAGRAM_FORMATS], description: 'mermaid（默认）| d2 | ascii。' },
      ids: { type: 'array', items: { type: 'string' }, description: 'memory-graph 的显式节点集合；默认取最显著的记录。' },
      nodes: { type: 'integer', description: 'memory-graph 的节点上限。' },
      timeline: { type: 'integer', description: 'strategy-timeline / lifecycle 的事件上限。' },
      embed: { type: 'boolean', description: '包进带 provenance 表头的代码块（默认 true）。' },
      allProjects: { type: 'boolean', description: '默认 false：只画当前项目 + 全局 + 当前会话。true 时画整份存储（其它项目的节点会被标为 other-project 并加告警）。' },
      scope: { type: 'json', description: '{"session","workspace","preset"}（旧形状），在作用域过滤之上再收窄一层；新调用请用 allProjects。' },
      redaction: { type: 'string', enum: [...REDACTION_LEVELS], description: '产出文本的脱敏策略。默认 secrets。' },
    },
    output: output({
      ok,
      text: { type: 'string', required: true, description: '可直接粘贴的产物：provenance 表头 + 代码块里的图表。' },
      source: { type: 'string', description: '不含表头与代码块的原始图表正文。' },
      kind: { type: 'string', description: '渲染的图表种类。' },
      format: { type: 'string', description: '使用的序列化格式。' },
      artifactVersion: { type: 'integer', description: '产物信封（artifact envelope）的版本。' },
      storeVersion: { type: 'integer', description: '这张图投影自哪一版存储。' },
      nodes: { type: 'integer', description: '模型里的节点数。' },
      edges: { type: 'integer', description: '模型里的连线数。' },
      origin: { type: 'string', description: 'live（服务）还是 mirror（文件）。' },
      redaction: { type: 'string', description: '实际应用的脱敏策略。' },
      warnings,
      auditSeq: { type: 'integer', description: 'viz.render 审计行的日志 seq；auditRenders 关闭时为 0。' },
    }),
    execute: async (args, exec) => {
      try {
        stats.diagrams += 1
        stats.lastAt = Date.now()
        const model = buildDiagramModel(liveSource(exec), {
          kind: args.kind,
          ids: args.ids,
          limit: {
            nodes: num(args.nodes, limits.diagramNodes),
            timeline: num(args.timeline, limits.timeline),
          },
          scopeContext: callScope(exec, args),
          scope: args.scope ?? null,
          redaction: REDACTION_LEVELS.includes(String(args.redaction)) ? String(args.redaction) : redaction,
          lang: limits.lang,
        })
        const rendered = renderDiagram(model, { format: args.format, embed: args.embed !== false })
        return {
          ok: true,
          text: rendered.text,
          source: rendered.source,
          kind: rendered.kind,
          format: rendered.format,
          artifactVersion: rendered.version,
          storeVersion: model.store.version,
          nodes: model.nodes.length,
          edges: model.edges.length,
          origin: String(model.origin),
          redaction: String(model.redaction.level),
          warnings: model.warnings,
          auditSeq: await auditRender('diagram', model),
        }
      } catch (error) {
        stats.errors += 1
        logger?.warn?.(`anagenesis-viz: diagram render failed: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    },
  }))

  logger?.info?.('anagenesis-viz: dashboard + diagram tools registered (read-only projections)')
}