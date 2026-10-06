/**
 * The window's HTTP face: one read-only JSON route, plus the trust fence in
 * front of it.
 *
 * Why a route at all: a plugin that declares `dsh.client` has no package-private
 * host RPC — the classic-script client half gets `React` through `require` and
 * reaches the Host over HTTP of its own package route (the same shape
 * `dsh-better-sidebar`'s `/sidebar/api/*` and `dsh-my-guardian`'s
 * `/guardian/api/*` use). So this is the one seam that carries store data from
 * the Host to the window, and it carries **already-redacted** text only.
 *
 * Security posture, stated rather than implied:
 *   - bound to the same loopback webserver as the rest of the GUI (the host
 *     binds 127.0.0.1 by default);
 *   - the Host header must name loopback (or a configured trusted authority) and
 *     browser markers must be same-origin — a DNS-rebinding / cross-site fence,
 *     behaviourally the `/api` gateway's, not authentication;
 *   - no response sets `Access-Control-Allow-Origin`, so a cross-origin page
 *     cannot read a response even if it can send one;
 *   - every method is a **read**; there is no write path, so there is no
 *     privilege an entry click could escalate to. The only mutation anywhere in
 *     this package is the in-memory pending-open slot that `ana_window` fills and
 *     the window drains — it touches no file and no other plugin's state.
 * @module dsh-anagenesis-window/host/rpc
 */

/** The single route prefix this package owns. */
export const ROUTE_PATH = '/anagenesis-window/api'

/** Methods servable over the route. `takeOpen` is the only one that mutates. */
export const RPC_METHODS = Object.freeze(['ping', 'config', 'status', 'dashboard', 'graph', 'frame', 'diagram', 'takeOpen'])

/** @param {string | string[] | undefined} value @returns {string | undefined} */
function header(value) {
  return typeof value === 'string' ? value : undefined
}

/** @param {string} hostname @returns {boolean} */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * May this request reach the window route?
 * @param {{ headers: Record<string, any> }} request
 * @param {readonly string[]} trustedHosts non-loopback authorities this deployment serves
 * @returns {boolean}
 */
export function isTrustedRequest(request, trustedHosts = []) {
  const host = header(request.headers?.host)
  if (host === undefined) return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const trusted = trustedHosts.some((entry) => {
    try {
      const entryUrl = new URL(`http://${entry}`)
      return entryUrl.hostname === hostUrl.hostname
    } catch {
      return false
    }
  })
  if (!isLoopbackHostname(hostUrl.hostname) && !trusted) return false
  if (header(request.headers?.['sec-fetch-site']) === 'cross-site') return false
  const origin = header(request.headers?.origin)
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** @param {any} res @param {number} status @param {any} payload */
function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * @param {any} value
 * @returns {string[]}
 */
function asList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (typeof value === 'string' && value.trim() !== '') return value.split(',').map((item) => item.trim()).filter((item) => item !== '')
  return []
}

/**
 * Build the route handler.
 * @param {{ renderer: any, config: any, pending: { take(): any, put(value: any): void }, log: any,
 *   trustedHosts?: readonly string[] }} deps
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createRouteHandler(deps) {
  const trustedHosts = deps.trustedHosts ?? []

  return async function handle(req, res) {
    try {
      if (!isTrustedRequest(req, trustedHosts)) {
        deps.log?.warn?.('anagenesis-window: refused an untrusted request to the window route')
        send(res, 403, { ok: false, error: 'anagenesis-window: untrusted request' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const method = url.searchParams.get('method') ?? 'ping'
      if (!RPC_METHODS.includes(method)) {
        send(res, 400, { ok: false, error: `anagenesis-window: unknown method "${method}"`, methods: RPC_METHODS })
        return
      }
      const query = Object.fromEntries(url.searchParams.entries())
      const redaction = query.redaction
      const payload = await serve(method, query, { ...deps, redaction })
      send(res, 200, payload)
    } catch (error) {
      // Never let the webserver answer 400 for us: the client needs a body it can
      // render, and a failing window must not look like a broken route.
      deps.log?.warn?.(`anagenesis-window: route failed: ${error instanceof Error ? error.message : String(error)}`)
      try {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      } catch {
        /* headers already sent — the socket is the webserver's problem now */
      }
    }
  }
}

/**
 * @param {string} method
 * @param {Record<string, string>} query
 * @param {any} deps
 * @returns {Promise<any>}
 */
async function serve(method, query, deps) {
  const { renderer, config, pending } = deps
  switch (method) {
    case 'ping':
      return {
        ok: true,
        package: 'dsh-anagenesis-window',
        api: 1,
        methods: RPC_METHODS,
        now: Date.now(),
      }
    case 'config':
      // The client half receives no Loader config of its own (HANDOFF §10.13),
      // so this is how policy reaches it. Keep it a closed, flat object.
      return {
        ok: true,
        title: String(config.title ?? 'anagenesis · 可视化'),
        redaction: String(config.redaction ?? 'secrets'),
        color: 'never',
        width: Number(config.width ?? 96),
        events: Number(config.events ?? 8),
        salience: Number(config.salience ?? 5),
        diagramNodes: Number(config.diagramNodes ?? 40),
        includeBodies: config.includeBodies === true,
        refreshMs: Number(config.refreshMs ?? 2000),
        officialEntry: String(config.officialEntry ?? 'auto'),
        leftColumnFallback: String(config.leftColumnFallback ?? 'off'),
        configVersion: 2,
      }
    case 'status':
      return { ...(await renderer.status()), pendingOpen: pending.take({ peek: true }) }
    // 结构化模型：窗口自己渲染。文本版本（frame/diagram）留给工具与终端视图。
    case 'dashboard':
      return renderer.dashboard({
        width: query.width,
        events: query.events,
        salience: query.salience,
        redaction: query.redaction,
        sections: asList(query.sections),
      })
    case 'graph':
      return renderer.graph({
        kind: query.kind,
        nodes: query.nodes,
        timeline: query.timeline,
        redaction: query.redaction,
      })
    case 'frame':
      return renderer.frame({
        width: query.width,
        events: query.events,
        salience: query.salience,
        redaction: query.redaction,
        sections: asList(query.sections),
      })
    case 'diagram':
      return renderer.diagram({
        kind: query.kind,
        format: query.format,
        nodes: query.nodes,
        timeline: query.timeline,
        redaction: query.redaction,
      })
    case 'takeOpen':
      return { ok: true, request: pending.take() }
    default:
      return { ok: false, error: `anagenesis-window: unhandled method "${method}"` }
  }
}

/**
 * The one deliberate piece of mutable state in this package: an in-memory
 * channel from the agent-reachable `ana_window` tool to the window in the GUI.
 * It is a slot, not a queue — a request stays until it is taken or superseded by
 * a newer one — and it is dropped the moment the row unloads.
 * @param {{ now?: () => number }} [opts]
 */
export function createPendingChannel(opts = {}) {
  const now = opts.now ?? (() => Date.now())
  let current = null
  let taken = 0
  return {
    /** @param {string} action @param {Record<string, any>} [detail] */
    put(action, detail = {}) {
      current = { action, detail, at: now(), seq: Number(current?.seq ?? 0) + 1 }
      return { ...current }
    },
    /** @param {{ peek?: boolean }} [how] @returns {any} */
    take(how = {}) {
      if (current === null) return null
      if (how.peek === true) return { ...current }
      const value = current
      current = null
      taken += 1
      return { ...value }
    },
    status() {
      return { pending: current !== null, seq: Number(current?.seq ?? 0), taken }
    },
  }
}