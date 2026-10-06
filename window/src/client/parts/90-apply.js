/**
 * Client half, part 9/9 — `apply`, the service face, and teardown.
 *
 * The activation is deliberately boring and ordered:
 *
 *   1. one stylesheet in, one stylesheet out;
 *   2. the window's single seat in `shell.overlay`;
 *   3. the three entrance seats, each wired reactively;
 *   4. the Host's policy, fetched once and applied by re-planning the seats that
 *      care about it;
 *   5. `ctx.anagenesisWindow`, the read face other plugins, the Agent preset and
 *      the tests read.
 *
 * Teardown is one statement: every effect above is owned by this fiber, and the
 * explicit release effect registered last therefore runs first. It disposes the
 * seat effects (releasing each arm) and then the registry's own rollbacks —
 * single-shot, so the second pass is a recorded no-op rather than a second
 * removal. Uninstalling leaves no DOM node, no listener, no timer and no service.
 */

/** The package's public read face, published as `ctx.anagenesisWindow`. */
const SERVICE_NAME = 'anagenesisWindow'

/**
 * @param {any} ctx the client Context handed to `apply`
 */
function applyClient(ctx) {
  const log = createObservableLog(LOG_LIMIT)
  const registry = createEntryRegistry(log)
  const request = createHostTransport(log)
  /** Client-side policy. Starts at the defaults so the window works offline. */
  const config = Object.assign({}, DEFAULT_CONFIG)
  const engine = createWindowEngine({ log: log, config: config, request: request })
  const deps = { engine: engine, log: log, registry: registry, config: config, rootCtx: ctx }
  /** @type {Map<string, { spec: any, dispose: () => void }>} */
  const seats = new Map()
  let migration = { migrated: [], unknown: [], version: 0 }

  const environment = () => detectEnvironment(ctx)

  // ── 1. styles ──────────────────────────────────────────────────────────────
  ctx.effect(() => {
    const styles = installStyles(log)
    return styles.dispose
  }, PKG_ID + ': stylesheet')

  // ── 2. the window ──────────────────────────────────────────────────────────
  // Exactly one registration, in the frame-wide overlay. The seat stays for the
  // plugin's whole life and the component renders `null` while closed, so an
  // uninstall removes the seat and every pixel with it, in one step.
  ctx.effect(() => ctx.inject(['slots'], (injected) => {
    const slots = injected.get('slots', false)
    if (slots === undefined || slots === null || typeof slots.inject !== 'function') {
      log.push('window.slot-unavailable', { reason: 'no slot system in this composition' })
      return () => {}
    }
    const dispose = slots.inject(SLOT.overlay, () => slots.register({
      name: SLOT.overlay,
      id: SLOT_ID.overlay,
      order: 60,
    }, () => createElement(AnagenesisWindow, {
      engine: engine, title: config.title, refreshMs: config.refreshMs, redaction: config.redaction,
    })))
    log.push('window.seat-registered', { slot: SLOT.overlay, id: SLOT_ID.overlay })
    return onceOnly(() => safeDispose(dispose, log, SLOT.overlay))
  }), PKG_ID + ': window overlay seat')

  // ── 3. the three entrances ──────────────────────────────────────────────────
  const arm = (spec) => {
    seats.set(spec.id, { spec: spec, dispose: wireSeat(ctx, spec, deps) })
    preflight(spec, deps, 'activation')
  }
  const rearm = (spec) => {
    const current = seats.get(spec.id)
    if (current !== undefined) current.dispose()
    arm(spec)
  }
  /**
   * Would this seat be armed differently right now?
   *
   * The reactive `ctx.inject` inside a seat covers its own declared dependencies
   * appearing and disappearing. It does NOT cover a policy that reads the ABSENCE
   * of an optional service: an injection whose dependencies are still satisfied
   * never re-runs, so entry 3 would stay suppressed for ever after better-sidebar
   * showed up. That is what the service-table watcher below is for.
   */
  const shouldRearm = (spec) => {
    const observed = registry.stateOf(spec.id)
    // Never auto-retry a seat that blew up: an erroring provider must not produce a
    // registration storm. An explicit configure() still retries it.
    if (observed === ENTRY_STATE.error) return false
    const wanted = spec.plan(detectEnvironment(ctx), config).state
    return wanted === ENTRY_STATE.registering ? observed !== ENTRY_STATE.registered : observed !== wanted
  }
  for (const spec of ENTRY_SPECS) {
    registry.declare(spec)
    arm(spec)
  }

  // Re-plan on any change of the service table. `internal/service` is the cordis
  // event every provide/dispose raises (name, value) — confirmed against
  // @deepseek-ai/cordis's own `events.ts` and the running service store.
  if (typeof ctx.on === 'function') {
    ctx.effect(() => {
      const off = ctx.on('internal/service', (name) => {
        for (const spec of ENTRY_SPECS) {
          if (!shouldRearm(spec)) continue
          log.push('entry.replanned', { seat: spec.id, trigger: 'internal/service:' + String(name) })
          rearm(spec)
        }
      })
      return onceOnly(() => safeDispose(off, log, 'service-table watcher'))
    }, PKG_ID + ': service-table watcher')
  } else {
    log.push('replan.unavailable', { reason: 'ctx.on is not a function; absence-driven policies cannot re-plan' })
  }

  // ── 4. the Host's policy ───────────────────────────────────────────────────
  const policyKeys = ['officialEntry', 'leftColumnFallback', 'title', 'redaction', 'width', 'events', 'salience', 'diagramNodes', 'refreshMs']
  const applyConfig = (raw, source) => {
    const outcome = migrateConfig(raw)
    for (const message of outcome.migrated) log.push('config.migrated', { from: outcome.version, to: CONFIG_VERSION, change: message })
    for (const key of outcome.unknown) log.push('config.unknown-key', { key: key })
    const previousPolicy = policyKeys.map((key) => String(config[key])).join('|')
    for (const key of Object.keys(outcome.config)) config[key] = outcome.config[key]
    migration = { migrated: outcome.migrated, unknown: outcome.unknown, version: outcome.version }
    log.push('config.applied', { source: source, version: outcome.version, migrated: outcome.migrated.length, unknown: outcome.unknown.length })
    const nextPolicy = policyKeys.map((key) => String(config[key])).join('|')
    if (previousPolicy !== nextPolicy) {
      // A policy change is a real change of decision, so only the seats whose plan
      // reads policy are re-planned. `shouldRearm` decides whether the decision
      // actually changed, which is what keeps the seat count at one through the
      // transition rather than tearing down a seat that is already correct.
      for (const spec of ENTRY_SPECS) {
        if (spec.id !== SEAT.officialRight && spec.id !== SEAT.leftFooter) continue
        if (!shouldRearm(spec)) continue
        log.push('entry.replanned', { seat: spec.id, trigger: 'config:' + source })
        rearm(spec)
      }
    }
  }

  // The client half receives no Loader config of its own (HANDOFF §10.13), so the
  // Host's copy arrives over its own route. A failure here is not fatal — the
  // defaults are already in `config` — so it is logged, not thrown.
  void request('config', {}).then((payload) => {
    if (payload.ok !== true) {
      log.push('config.unavailable', { reason: String(payload.error === undefined ? 'host refused' : payload.error) })
      return
    }
    const copy = {}
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) copy[key] = payload[key]
    }
    copy.configVersion = numberOr(payload.configVersion, CONFIG_VERSION)
    applyConfig(copy, 'host')
    engine.patch({ redaction: config.redaction, width: config.width })
  }).catch((error) => {
    log.push('config.unavailable', { reason: errorText(error) })
  })

  // ── 5. the service face ────────────────────────────────────────────────────
  const api = {
    version: '0.2.0',
    /** 抬高窗口。所有入口走的是同一个 engine，所以不存在"第二个窗口"。 */
    open(options) {
      const opts = options === undefined || options === null ? {} : options
      const seat = String(opts.seat === undefined ? '' : opts.seat)
      return engine.open({
        reason: seat === '' ? 'service' : seat,
        view: opts.view,
        kind: opts.kind,
      })
    },
    close(reason) {
      return engine.close(reason === undefined ? 'service' : reason)
    },
    toggle(reason) {
      return engine.toggle(reason === undefined ? 'service' : reason)
    },
    patch(patch) {
      return engine.patch(patch)
    },
    /** Switch face without changing whether the window is open. */
    setView(view) {
      return engine.setView(view)
    },
    /** 工具栏某个控件变化（与事件委托走同一条路，便于测试与外部驱动）。 */
    setField(field, value) {
      return engine.setField(field, value)
    },
    /** 工具栏按钮。 */
    dispatch(action) {
      return engine.dispatch(action)
    },
    refresh() {
      return engine.refresh()
    },
    /**
     * Check the Host's pending slot once, now. The window's own timer calls this;
     * exposing it lets an operator (or a test) drive the agent door deterministically
     * instead of waiting for a poll.
     */
    drain() {
      return engine.drain()
    },
    /** Slow facts only: store health, not entry state. */
    refreshStatus() {
      return engine.refreshStatus()
    },
    /** Everything the entry layer currently believes, including why a seat is not armed. */
    status() {
      return {
        package: PKG_ID,
        version: '0.2.0',
        window: engine.getSnapshot(),
        entries: registry.snapshot(),
        entryStates: registry.rollup(),
        environment: environment(),
        config: JSON.parse(JSON.stringify(config)),
        migration: { migrated: migration.migrated.slice(), unknown: migration.unknown.slice(), from: migration.version, to: CONFIG_VERSION },
        log: log.snapshot(),
      }
    },
    entries() {
      return registry.snapshot()
    },
    /** The entrances as entrances: one row each, with the seat that carries it. */
    entryStates() {
      return registry.rollup()
    },
    log(filter) {
      return log.list(filter)
    },
    environment() {
      return environment()
    },
    /** Runtime policy change. Re-plans exactly the seats the policy governs. */
    configure(patch) {
      applyConfig(patch, 'runtime')
      engine.patch({ redaction: config.redaction, width: config.width })
      return api.status()
    },
    subscribe(listener) {
      return engine.subscribe(listener)
    },
    onEntry(listener) {
      return registry.subscribe(listener)
    },
  }

  try {
    ctx.provide(SERVICE_NAME, api)
    log.push('service.provided', { name: SERVICE_NAME })
  } catch (error) {
    // A second activation in the same isolation scope is a composition error, not
    // a reason to fail the page: the window keeps working through the first face.
    log.push('service.provide-failed', { name: SERVICE_NAME, error: errorText(error) })
  }

  // ── teardown ───────────────────────────────────────────────────────────────
  // Registered LAST so it is disposed FIRST: release the seats by name while the
  // registry is still alive, then let the per-seat effects run their (single-shot)
  // rollbacks. Nothing survives this, and running it twice is a recorded no-op.
  ctx.effect(() => () => {
    for (const entry of Array.from(seats.values())) entry.dispose()
    seats.clear()
    registry.releaseAll()
    log.push('teardown', { seats: SEAT_ORDER.length, logSize: log.size() })
  }, PKG_ID + ': teardown')

  const probe = environment()
  log.push('activated', {
    environment: describeEnvironment(probe),
    betterSidebar: probe.betterSidebar.present,
    desktop: probe.desktop.desktop,
    seats: SEAT_ORDER.slice(),
  })
  console.log(PKG_ID + ': activated — ' + describeEnvironment(probe))
}

exports.inject = ['slots']
exports.apply = applyClient
exports.name = PKG_ID