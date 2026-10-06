/**
 * `ana_window` — the agent-reachable door to the desktop window.
 *
 * Every other entrance in this package is a click. An Agent has no mouse, so the
 * tool writes one request into the in-memory pending slot and the window in the
 * GUI drains it on its next poll. That indirection is deliberate and is stated as
 * a limit rather than dressed up: DSH publishes no host→client push for a
 * package's own client half, so the transport is a ≤`refreshMs` poll, and when no
 * GUI is attached the request simply stays pending (a headless run must not
 * fail). `action: "status"` is the honest read: it reports the profile's
 * installed-plugin facts, the store projection's health, and whether a request is
 * still waiting to be drained.
 * @module dsh-anagenesis-window/host/tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { jsonSafe } from './viz.js'

/**
 * @param {any} value
 * @param {string[]} allowed
 * @param {string} fallback
 * @returns {string}
 */
function pick(value, allowed, fallback) {
  const text = String(value ?? '')
  return allowed.includes(text) ? text : fallback
}

/**
 * @param {Record<string, any>} properties
 * @returns {any}
 */
function output(properties) {
  return {
    schema: { type: 'object', additionalProperties: false, properties },
    render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value ?? null, null, 2) }],
  }
}

/**
 * Register `ana_window` on the tools registry.
 *
 * The registry is passed in rather than read off `ctx.tools`: this package only
 * ever talks to a collaborator it has probed for, and passing the value that was
 * probed is the shortest way to keep that true.
 * @param {any} tools the `tools` service
 * @param {{ pending: any, renderer: any, config: any, profile: () => any, log: any }} deps
 * @returns {() => void} the unregister disposer
 */
export function registerWindowTool(tools, deps) {
  const { pending, renderer, config, profile, log } = deps
  void log

  return tools.register(defineTool({
    name: 'ana_window',
    description: '打开、关闭或查看 anagenesis 桌面可视化窗口 —— 那个自己画出仪表盘与图表（中文卡片、彩色条、'
      + '真实内联 SVG 关系图）并持续刷新的原生窗口。窗口属于可选的 dsh-anagenesis-window 行；没有装这一行时'
      + '本工具不存在，此时 ana_dashboard / ana_diagram 依然是在终端里看存储的方式。只读：窗口绝不写入存储，'
      + '打开窗口也不是一笔记忆事务。',
    parameters: {
      action: { type: 'string', enum: ['open', 'close', 'toggle', 'status'], description: 'open / close / toggle 窗口，或只报告状态而不改变它。' },
      view: { type: 'string', enum: ['dashboard', 'graph'], description: '打开时抬起哪一面（默认 dashboard）。' },
      kind: { type: 'string', description: 'view=graph 时的图表种类：memory-graph | strategy-timeline | lifecycle。' },
      direction: { type: 'string', enum: ['LR', 'TB'], description: 'view=graph 时的布局方向：LR（从左到右，默认）或 TB（从上到下）。' },
    },
    output: output({
      ok: { type: 'boolean', required: true, description: '请求是否被接受（或状态读取是否成功）。' },
      action: { type: 'string', required: true, description: '实际执行的动作。' },
      delivered: { type: 'string', required: true, description: 'drained（窗口已取走）、pending（还在等 GUI 轮询）或 none。' },
      text: { type: 'string', required: true, description: '人类可读的摘要：发生了什么、接下来预期什么。' },
      windowInstalled: { type: 'boolean', description: '本 profile 里是否装载了 dsh-anagenesis-window 行。' },
      betterSidebarMounted: { type: 'boolean', description: '本 profile 是否装载 DSH-better-sidebar（运行时探测的宿主侧事实）。' },
      expectedEntries: { type: 'array', items: { type: 'string' }, description: '在 betterSidebarMounted 的前提下，本 profile 预测的入口座位。' },
      storeFound: { type: 'boolean', description: 'anagenesis 存储是否已经存在。' },
      storeVersion: { type: 'integer', description: '最近一次投影读到的存储版本。' },
      pending: { type: 'boolean', description: '是否还有一条请求在等待被取走。' },
    }),
    execute: async (args) => {
      const action = pick(args.action, ['open', 'close', 'toggle', 'status'], 'status')
      const facts = profile()
      const expected = facts.betterSidebarMounted
        ? ['better-sidebar-row', 'conversation-header']
        : ['official-right-sidebar', 'conversation-header']
      const base = {
        ok: true,
        action,
        windowInstalled: true,
        betterSidebarMounted: facts.betterSidebarMounted === true,
        expectedEntries: expected,
        storeFound: false,
        storeVersion: 0,
        pending: pending.status().pending,
      }

      if (action === 'status') {
        const status = await renderer.status()
        const waiting = pending.status()
        const entries = expected.join(', ')
        return jsonSafe({
          ...base,
          delivered: waiting.pending ? 'pending' : 'none',
          storeFound: status.storeFound === true,
          storeVersion: Number(status.storeVersion ?? 0),
          pending: waiting.pending,
          text: [
            `anagenesis 可视化窗口：已装载（dsh-anagenesis-window）。`,
            `本 profile ${facts.betterSidebarMounted ? '已装' : '未装'} DSH-better-sidebar，据此预测的入口：${entries}。`,
            `存储：${status.storeFound ? `${status.root}（version ${status.storeVersion}）` : `${status.root} — 尚未创建`}。`,
            waiting.pending ? '有一条打开请求仍在等待 GUI 轮询取走。' : '当前没有等待中的打开请求。',
          ].join('\n'),
        })
      }

      if (action === 'close') {
        const request = pending.put('close', {})
        return jsonSafe({
          ...base,
          delivered: 'pending',
          pending: true,
          text: `已投递「关闭窗口」请求（seq ${request.seq}）。窗口会在下一次轮询（≤${Number(config.refreshMs ?? 2000)}ms）取走；`
            + '若当前没有 GUI 页面附着，请求会一直停留到窗口出现为止。',
        })
      }

      const view = pick(args.view, ['dashboard', 'graph'], 'dashboard')
      const request = pending.put(action === 'toggle' ? 'toggle' : 'open', {
        view,
        kind: String(args.kind ?? ''),
        direction: pick(args.direction, ['LR', 'TB'], 'LR'),
      })
      return jsonSafe({
        ...base,
        delivered: 'pending',
        pending: true,
        text: `已投递「${action === 'toggle' ? '切换' : '打开'}窗口」请求（seq ${request.seq}，视图=${view === 'graph' ? '图表' : '仪表盘'}）。`
          + `GUI 中的窗口会在 ≤${Number(config.refreshMs ?? 2000)}ms 内取走；轮询取走后该请求即被消费。`
          + `若当前没有 GUI 页面附着，请求会一直停留 —— Agent 不应当依赖窗口已经出现。`
          + `要在这条回答里直接看到内容，仍请用 ana_dashboard / ana_diagram（终端文本）。`,
      })
    },
  }))
}

/**
 * The Host's own view of the profile: which optional collaborators are mounted.
 * It is a Loader fact, not a client-side guess, so comparing it with the client's
 * service probe is a real cross-check (a mismatch means the client half is
 * running against a different composition than the row that loaded it).
 * @param {any} ctx
 * @returns {{ betterSidebarMounted: boolean, loaderVisible: boolean, entryIds: string[] }}
 */
export function probeProfile(ctx) {
  const loader = ctx?.loader
  if (loader === undefined || typeof loader.entries !== 'function') {
    return { betterSidebarMounted: false, loaderVisible: false, entryIds: [] }
  }
  try {
    const rows = [...loader.entries()]
    const entryIds = []
    let betterSidebarMounted = false
    let windowRows = 0
    for (const entry of rows) {
      const options = entry?.options ?? {}
      if (options.disabled === true) continue
      const entryId = String(options.id ?? '')
      const name = String(options.name ?? '')
      if (entryId !== '') entryIds.push(entryId)
      if (name === 'dsh-better-sidebar') betterSidebarMounted = true
      if (name === 'dsh-anagenesis-window') windowRows += 1
    }
    return { betterSidebarMounted, loaderVisible: true, entryIds, windowRows }
  } catch {
    return { betterSidebarMounted: false, loaderVisible: false, entryIds: [] }
  }
}