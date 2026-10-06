/**
 * dsh-anagenesis-window — the Host half.
 *
 * One Loader row, and the row is *only* this: a read-only projection of the
 * anagenesis store over one HTTP route, plus the `ana_window` tool. The window
 * itself, its chrome and its four entrance seats live in the client half
 * (`./client.js`), because only the browser half can register a slot, a native
 * right-Sidebar tab type or a `dsh-better-sidebar` tab.
 *
 * Why this is a separate package from `dsh-anagenesis` (and must stay one):
 * `dsh-client-modules` allows a package that declares `dsh.client` exactly ONE
 * active Loader row, and `dsh-anagenesis` is five rows that the `anagenesis` preset
 * mounts a second time. Adding `dsh.client` there cannot boot — that failure mode
 * was hit and reverted once already (HANDOFF §10.14). So the window is a
 * single-row sibling, and the preset is *aware* of it without mounting it.
 *
 * Failure isolation: nothing here is required by the memory layer. A missing
 * webserver, a missing tools service, a missing/broken sibling package or an
 * absent store all degrade to a logged observation plus an answer that says so —
 * this module never throws into the Loader and never touches another plugin's
 * state or storage.
 * @module dsh-anagenesis-window
 */

import Schema from '@deepseek-ai/schemastery'

import { createRenderer, defaultRoot } from './host/viz.js'
import { ROUTE_PATH, createPendingChannel, createRouteHandler } from './host/rpc.js'
import { probeProfile, registerWindowTool } from './host/tool.js'

export const name = 'anagenesis-window'

/**
 * Deliberately empty. `webServer` and `tools` are optional collaborators: a
 * headless composition has no webserver and still deserves a working tool, and a
 * composition without `tools` still deserves a working route. Both are wired
 * through `ctx.inject` inside `apply`, which is also what makes the effect
 * *reactive* — the seat appears when the collaborator does and is released when it
 * goes.
 */
export const inject = []

export const Config = Schema.object({
  /** One-line kill switch; `disabled: true` on the row is the other one. */
  enabled: Schema.boolean().default(true)
    .description('总开关；行上的 `disabled: true` 是另一个开关。关闭后没有路由、没有工具、没有入口。'),
  /** Store directory. Empty = `$DSH_HOME/anagenesis`, the core row's own default. */
  rootDir: Schema.string().default('')
    .description('存储目录。留空 = $DSH_HOME/anagenesis，即核心行自己的默认值；窗口只读它，从不写入。'),
  title: Schema.string().default('anagenesis · 可视化')
    .description('窗口标题。'),
  redaction: Schema.string().default('secrets')
    .description('脱敏策略：none | secrets | strict。与 ana_dashboard / ana_diagram 用同一套词汇，所以窗口永远不会比工具显示得更多。'),
  color: Schema.string().default('never')
    .description('文本着色策略：auto | always | never。'),
  width: Schema.number().default(96)
    .description('文本帧宽度（终端格数；中文按显示宽度计算）。'),
  events: Schema.number().default(8)
    .description('显示多少条日志事件。'),
  salience: Schema.number().default(5)
    .description('显示多少条最高显著度的记录。'),
  diagramNodes: Schema.number().default(40)
    .description('关系图的节点上限。'),
  includeBodies: Schema.boolean().default(false)
    .description('是否在记录下面附一段截断的正文预览（脱敏开启时会被擦洗）。'),
  /** The window's poll period. Also the upper bound on `ana_window` latency. */
  refreshMs: Schema.number().default(2000)
    .description('窗口的轮询周期（毫秒）；它同时是 ana_window 延迟的上界。'),
  /** 'auto' | 'always' | 'off' — the official right-sidebar seat's policy. */
  officialEntry: Schema.string().default('auto')
    .description('官方右侧边栏座位的策略：auto | always | off。auto = better-sidebar 在场时让位给同一列。'),
  /** 'official-footer' | 'off' — arm the left-column foot seat instead when better-sidebar is absent. */
  leftColumnFallback: Schema.string().default('off')
    .description('better-sidebar 缺席时，是否改用左栏底部座位：official-footer | off。'),
  exposeWindowTool: Schema.boolean().default(true)
    .description('是否注册 Agent 可达的 ana_window 工具（它只投递打开/关闭请求，不做别的事）。'),
  /** Non-loopback authorities this deployment also serves. */
  trustedHosts: Schema.array(Schema.string()).default([])
    .description('本部署额外服务的非回环主机名（Host 头白名单）；空 = 只接受回环。'),
})

/** @param {unknown} value @param {number} fallback @returns {number} */
function num(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Every config value with this row's own defaults behind it. The host applies the
 * `Config` schema, but a row mounted with a partial config (a test, a hand-written
 * composition, an older host) must still behave.
 * @param {any} config
 * @returns {Record<string, any>}
 */
export function resolveConfig(config = {}) {
  const one = (value, allowed, fallback) => (allowed.includes(String(value)) ? String(value) : fallback)
  return {
    enabled: config.enabled !== false,
    rootDir: String(config.rootDir ?? ''),
    title: String(config.title ?? 'anagenesis · 可视化'),
    redaction: one(config.redaction, ['none', 'secrets', 'strict'], 'secrets'),
    color: one(config.color, ['auto', 'always', 'never'], 'never'),
    width: num(config.width, 96),
    events: num(config.events, 8),
    salience: num(config.salience, 5),
    diagramNodes: num(config.diagramNodes, 40),
    includeBodies: config.includeBodies === true,
    refreshMs: Math.max(500, num(config.refreshMs, 2000)),
    officialEntry: one(config.officialEntry, ['auto', 'always', 'off'], 'auto'),
    leftColumnFallback: one(config.leftColumnFallback, ['official-footer', 'off'], 'off'),
    exposeWindowTool: config.exposeWindowTool !== false,
    trustedHosts: Array.isArray(config.trustedHosts) ? config.trustedHosts.map((item) => String(item)) : [],
  }
}

/**
 * Wrap a disposer so a second call is a no-op that logs instead of throwing.
 *
 * Disposers are held by two owners at once here — the Cordis effect and the
 * package's own bookkeeping — so "exactly once, and never twice" is a property of
 * the design, not a hope. Uninstalling must leave nothing behind and must not
 * explode while doing it.
 * @param {() => void} fn
 * @param {(error: unknown) => void} [onError]
 * @returns {() => void}
 */
export function once(fn, onError) {
  let done = false
  return () => {
    if (done) return
    done = true
    try {
      fn()
    } catch (error) {
      if (onError !== undefined) onError(error)
    }
  }
}

/**
 * @param {any} ctx
 * @param {any} [config]
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const log = ctx.logger
  if (!resolved.enabled) {
    log?.info?.('anagenesis-window: row disabled by config; no route, no tool, no entries')
    return
  }

  const pending = createPendingChannel()
  const renderer = createRenderer({
    rootDir: resolved.rootDir,
    redaction: resolved.redaction,
    color: resolved.color,
    width: resolved.width,
    events: resolved.events,
    salience: resolved.salience,
    diagramNodes: resolved.diagramNodes,
    includeBodies: resolved.includeBodies,
    logger: log,
  })
  const profile = () => probeProfile(ctx)
  const onError = (error) => log?.warn?.(`anagenesis-window: disposer failed: ${error instanceof Error ? error.message : String(error)}`)

  log?.info?.(`anagenesis-window: root=${resolved.rootDir !== '' ? resolved.rootDir : defaultRoot()} `
    + `officialEntry=${resolved.officialEntry} tool=${resolved.exposeWindowTool}`)

  // ── the read-only route ────────────────────────────────────────────────────
  // Reactive by construction: registered when a webserver exists, released when
  // it disappears. A duplicate path registration throws in the webserver, so the
  // handler is built per injection rather than shared.
  ctx.effect(
    () => ctx.inject(['webServer'], (injected) => {
      const web = injected.get('webServer', false)
      if (web === undefined || web === null || typeof web.register !== 'function') {
        log?.warn?.('anagenesis-window: no webserver in this composition — the window route is not served; the tool still works')
        return () => {}
      }
      const handler = createRouteHandler({ renderer, config: resolved, pending, log, trustedHosts: resolved.trustedHosts })
      const dispose = web.register({ kind: 'prefix', path: ROUTE_PATH, handler })
      log?.info?.(`anagenesis-window: route ${ROUTE_PATH} registered (read-only: ${['ping', 'config', 'status', 'dashboard', 'graph', 'frame', 'diagram', 'takeOpen'].join(', ')})`)
      return once(() => {
        dispose()
        log?.info?.(`anagenesis-window: route ${ROUTE_PATH} disposed`)
      }, onError)
    }),
    'anagenesis-window: read-only render route',
  )

  // ── the agent-reachable door ───────────────────────────────────────────────
  if (resolved.exposeWindowTool) {
    ctx.effect(
      () => ctx.inject(['tools'], (injected) => {
        const tools = injected.get('tools', false)
        if (tools === undefined || tools === null || typeof tools.register !== 'function') {
          log?.warn?.('anagenesis-window: no tools service in this composition — ana_window is not registered')
          return () => {}
        }
        const dispose = registerWindowTool(tools, { pending, renderer, config: resolved, profile, log })
        log?.info?.('anagenesis-window: ana_window registered (agent-reachable window door)')
        return once(() => {
          dispose()
          log?.info?.('anagenesis-window: ana_window disposed')
        }, onError)
      }),
      'anagenesis-window: ana_window tool',
    )
  }

  // ── boot-time capability probe ─────────────────────────────────────────────
  // A reactive injection never runs while its collaborator is absent — which would
  // make "no webserver in this composition" indistinguishable from "worked". So the
  // absence is reported here, at activation, and the injection below still arms the
  // seat the moment the collaborator appears.
  const optional = [
    ['webServer', 'register', 'anagenesis-window: no webserver in this composition — the window route is not served; the tool still works'],
    ['tools', 'register', 'anagenesis-window: no tools service in this composition — ana_window is not registered'],
  ]
  for (const [name, method, message] of optional) {
    const service = ctx.get(name, false)
    const usable = service !== undefined && service !== null && typeof service[method] === 'function'
    if (!usable) log?.warn?.(message)
  }

  // A broken sibling package must surface as a warning at boot, not as a failed
  // first click. Fire-and-forget on purpose: the row's activation must not depend
  // on disk I/O, and the promise is fully handled here.
  const probe = profile()
  log?.info?.(`anagenesis-window: profile probe — betterSidebar=${probe.betterSidebarMounted ? 'mounted' : 'absent'} `
    + `loaderVisible=${probe.loaderVisible ? 'yes' : 'no'} windowRows=${num(probe.windowRows, 1)}`)
  void renderer.status()
    .then((status) => {
      log?.info?.(`anagenesis-window: store ${status.storeFound ? 'ready' : 'not created yet'} at ${status.root} `
        + `(version ${status.storeVersion})`)
    })
    .catch((error) => {
      log?.warn?.(`anagenesis-window: the visualization layer could not be resolved: ${error instanceof Error ? error.message : String(error)}`)
    })
}