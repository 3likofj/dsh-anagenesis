/**
 * Client half, part 8/9 — the entrance seats and the generic seat wiring.
 *
 * A seat is data: an id, what it must be able to talk to, a **plan** that decides
 * whether it may arm given the live environment and the policy, and a **register**
 * that returns the exact inverse of what it did. Everything else — mutual
 * exclusion, state recording, single-shot rollback, reactive re-planning — is the
 * generic `wireSeat` below, so a new seat would be twenty lines and could not
 * invent its own lifecycle.
 *
 * Every `requires` list is a real dependency, and `ctx.inject` is what makes it
 * reactive: the body runs when the dependency appears, its disposer runs when the
 * dependency goes away, and it re-runs if it comes back. That is the whole
 * "declared dependency + automatic response" requirement — there is no polling
 * for services and no `setTimeout` retry anywhere in this file.
 *
 * Seat map (see README.md for the compatibility matrix):
 *
 *   better-sidebar-row      DSH-better-sidebar tab row         entry 1
 *   official-right-sidebar  official right column              entry 3
 *   conversation-header     conversation / Trajectory top bar   entry 4
 *   official-left-footer    entry 1's ALTERNATE seat, off by default
 *
 * The better-sidebar bottom workbench (entry 2) was removed on request; see
 * `10-const.js` for why it was a second row pointing at one window.
 */

/** Dispose without letting a broken registration take the teardown down with it. */
function safeDispose(dispose, log, what) {
  if (typeof dispose !== 'function') return
  try {
    dispose()
  } catch (error) {
    log.push('entry.dispose-error', { what: what, error: errorText(error) })
  }
}

/** Fold a list of disposers into one, released in reverse order. */
function collectDisposers(disposers) {
  return onceOnly(() => {
    for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]()
  })
}

/** @param {string} state @param {string} reason */
function decision(state, reason) {
  return { state: state, reason: reason }
}

/**
 * The seat table. `plan` is pure: environment + policy in, decision out. It is
 * re-evaluated on every dependency change, so a policy change or a provider
 * appearing/disappearing flips the seat without any imperative re-wiring.
 */
const ENTRY_SPECS = [
  {
    id: SEAT.betterRow,
    label: 'DSH-better-sidebar · 侧栏页签行（入口 1）',
    seatKind: 'better-sidebar tab row',
    requires: ['betterSidebar'],
    plan(env) {
      const probe = env.services.betterSidebar
      if (probe.present) return decision(ENTRY_STATE.registering, 'ready')
      return decision(ENTRY_STATE.degraded, 'this seat needs ctx.betterSidebar — ' + probe.reason + ' (no seat registered, no error, no residue)')
    },
    register(deps) {
      const service = deps.env.services.betterSidebar.service
      const descriptor = {
        id: TAB_TYPE.panel,
        title: () => deps.config.title,
        description: () => 'anagenesis 可视化：TUI 仪表盘 + 文本图表，在原生窗口里实时刷新（只读）',
        order: 20,
        single: true,
        component: () => createElement(AnagenesisLauncher, {
          engine: deps.engine, title: deps.config.title, reason: SEAT.betterRow, autoOpen: true,
        }),
      }
      // Feature-gated, never version-compared: the service publishes a monotonic
      // capability list precisely so consumers stop parsing versions.
      if (deps.env.betterSidebar.canLifecycle) {
        descriptor.onOpen = () => deps.engine.open({ reason: SEAT.betterRow })
        descriptor.onActivate = () => deps.engine.open({ reason: SEAT.betterRow })
      }
      const dispose = service.registerTab(descriptor)
      return {
        dispose: () => safeDispose(dispose, deps.log, SEAT.betterRow),
        detail: { tabId: TAB_TYPE.panel, lifecycle: deps.env.betterSidebar.canLifecycle === true },
      }
    },
  },
  {
    id: SEAT.officialRight,
    label: '官方右侧边栏 · 原生页签（入口 3）',
    seatKind: 'official right sidebar tab',
    requires: ['sidebarRightTabs', 'slots'],
    plan(env, config) {
      if (config.officialEntry === 'off') return decision(ENTRY_STATE.suppressed, 'policy: officialEntry=off')
      if (config.officialEntry === 'auto' && env.services.betterSidebar.present) {
        return decision(ENTRY_STATE.suppressed,
          'policy: officialEntry=auto and DSH-better-sidebar is installed — better-sidebar maps its own tab types into this same column, '
          + 'so arming both would put two rows for one window in one column (set officialEntry=always to override)')
      }
      if (!env.services.sidebarRightTabs.present) {
        return decision(ENTRY_STATE.degraded, 'the official right sidebar is not published in this composition')
      }
      return decision(ENTRY_STATE.registering, 'ready')
    },
    register(deps) {
      const tabs = deps.env.services.sidebarRightTabs.service
      const slots = deps.env.services.slots.service
      const disposers = []
      try {
        disposers.push(tabs.register({
          id: PKG_ID,
          kind: TAB_TYPE.nativeKind,
          title: () => deps.config.title,
          guide: [{ id: TAB_TYPE.guide, order: 20, title: () => deps.config.title }],
        }))
        // The two keyed seats carry the panel and its chip title. Registering a
        // slot can fail AFTER the type registered, so the partial set is released
        // on the way out — otherwise the column keeps a type with no body.
        disposers.push(slots.inject(SLOT.nativeTabBody, () => slots.register({
          name: SLOT.nativeTabBody, key: PKG_ID,
        }, () => createElement(AnagenesisLauncher, {
          engine: deps.engine, title: deps.config.title, reason: SEAT.officialRight, autoOpen: true,
          hint: '这个页签在 DSH 官方右侧栏里；内容与另外三个入口共用同一个原生窗口。',
        }))))
        disposers.push(slots.inject(SLOT.nativeTabTitle, () => slots.register({
          name: SLOT.nativeTabTitle, key: PKG_ID,
        }, () => createElement('span', null, deps.config.title))))
      } catch (error) {
        for (let index = disposers.length - 1; index >= 0; index -= 1) safeDispose(disposers[index], deps.log, SEAT.officialRight + ':partial')
        throw error
      }
      return {
        dispose: collectDisposers(disposers),
        detail: { kind: TAB_TYPE.nativeKind, guide: TAB_TYPE.guide, seats: [SLOT.nativeTabBody, SLOT.nativeTabTitle] },
      }
    },
  },
  {
    id: SEAT.header,
    label: '对话 / 轨迹顶部栏 · 按钮（入口 4）',
    seatKind: 'conversation header utility',
    requires: ['slots'],
    plan(env) {
      if (!env.services.slots.present) return decision(ENTRY_STATE.degraded, 'the slot system is not published in this composition')
      return decision(ENTRY_STATE.registering, 'ready')
    },
    register(deps) {
      const slots = deps.env.services.slots.service
      // `slots.inject` waits for the conversation package to declare the slot and
      // re-runs if the declaration collapses and is re-declared — the conversation
      // package owns this seat, we only fill it.
      const dispose = slots.inject(SLOT.headerUtilities, () => slots.register({
        name: SLOT.headerUtilities,
        id: SLOT_ID.header,
        order: 12,
      }, () => createElement(AnagenesisHeaderButton, { engine: deps.engine })))
      return {
        dispose: () => safeDispose(dispose, deps.log, SEAT.header),
        detail: { slot: SLOT.headerUtilities, order: 12 },
      }
    },
  },
  {
    id: SEAT.leftFooter,
    label: '官方左侧栏页脚 · 入口 1 的备用席位',
    seatKind: 'official left column footer',
    requires: ['slots'],
    plan(env, config) {
      if (config.leftColumnFallback !== 'official-footer') {
        return decision(ENTRY_STATE.suppressed, 'policy: leftColumnFallback=off (entry 1 uses the better-sidebar seat when present)')
      }
      if (env.services.betterSidebar.present) {
        return decision(ENTRY_STATE.suppressed, 'entry 1 already armed its better-sidebar seat; one seat per entry')
      }
      if (!env.services.slots.present) return decision(ENTRY_STATE.degraded, 'the slot system is not published in this composition')
      return decision(ENTRY_STATE.registering, 'ready')
    },
    register(deps) {
      const slots = deps.env.services.slots.service
      const dispose = slots.inject(SLOT.sidebarFooterAction, () => slots.register({
        name: SLOT.sidebarFooterAction,
        id: SLOT_ID.leftFooter,
        order: 12,
      }, () => createElement(AnagenesisHeaderButton, { engine: deps.engine })))
      return {
        dispose: () => safeDispose(dispose, deps.log, SEAT.leftFooter),
        detail: { slot: SLOT.sidebarFooterAction },
      }
    },
  },
]

/**
 * Record what a seat's plan currently decides **without** arming it.
 *
 * This exists because a reactive `ctx.inject` callback simply never runs while its
 * dependency is absent — which would leave a seat that cannot exist in this
 * environment looking `idle` instead of `degraded`, and "graceful degradation" you
 * cannot observe is indistinguishable from a bug. The inject path stays the only
 * thing that ARMS a seat; this only reports, and it is re-run on every change so a
 * seat that loses its provider stops claiming to be registered.
 * @param {any} spec
 * @param {{ log: any, registry: any, config: any, rootCtx: any }} deps
 * @param {string} [because]
 */
function preflight(spec, deps, because) {
  const env = detectEnvironment(deps.rootCtx)
  const plan = spec.plan(env, deps.config)
  const current = deps.registry.stateOf(spec.id)
  if (current === ENTRY_STATE.registered || current === ENTRY_STATE.registering) return plan
  if (plan.state === ENTRY_STATE.registering) {
    // The dependency is satisfiable but the injection has not settled yet. Say so
    // instead of leaving the row blank — this is the state better-sidebar's own
    // native surface hit on a real profile before it moved to `ctx.inject`.
    deps.registry.settle(spec.id, ENTRY_STATE.idle, 'waiting for the declared dependency to settle: ' + spec.requires.join(', '))
    return plan
  }
  deps.registry.settle(spec.id, plan.state, because === undefined ? plan.reason : plan.reason + ' [' + because + ']')
  return plan
}

/**
 * Arm one seat, or record why it was not armed.
 * @param {any} scope the context the dependencies are satisfied in
 * @param {any} spec
 * @param {{ engine: any, log: any, registry: any, config: any, rootCtx: any }} deps
 * @returns {() => void} the rollback of this arm attempt
 */
function armSeat(scope, spec, deps) {
  const env = detectEnvironment(scope)
  const plan = spec.plan(env, deps.config)
  deps.log.push('entry.planned', {
    seat: spec.id, label: spec.label, decided: plan.state, reason: plan.reason,
    environment: describeEnvironment(env),
  })
  if (plan.state !== ENTRY_STATE.registering) {
    deps.registry.settle(spec.id, plan.state, plan.reason)
    return () => {}
  }
  if (!deps.registry.claim(spec.id)) return () => {}
  let result
  try {
    result = spec.register({ ctx: scope, env: env, services: env.services, engine: deps.engine, config: deps.config, log: deps.log })
  } catch (error) {
    deps.log.push('entry.register-failed', { seat: spec.id, label: spec.label, error: errorText(error) })
    deps.registry.settle(spec.id, ENTRY_STATE.error, errorText(error))
    return () => {}
  }
  const rollback = onceOnly(() => {
    try {
      result.dispose()
    } catch (error) {
      deps.log.push('entry.dispose-error', { seat: spec.id, error: errorText(error) })
    }
  }, (error) => deps.log.push('entry.dispose-error', { seat: spec.id, error: errorText(error) }))
  deps.registry.attach(spec.id, rollback)
  deps.log.push('entry.armed', { seat: spec.id, label: spec.label, detail: result.detail === undefined ? null : result.detail })
  return () => {
    deps.registry.release(spec.id)
    // The dependency went away (or the policy changed): re-report the seat from the
    // CURRENT environment instead of leaving it looking merely 'released'.
    preflight(spec, deps, 'dependency went away')
  }
}

/**
 * Wire one seat reactively.
 *
 * `ctx.inject` is the primary path — it re-runs the body when any declared
 * dependency appears or disappears, which is exactly the reactive-effect
 * requirement. The `ctx.effect` fallback exists for a host whose context is a
 * minimal test double: absence of `inject` must degrade to "arm once against this
 * context", not to "silently register nothing".
 * @param {any} ctx
 * @param {any} spec
 * @param {{ engine: any, log: any, registry: any, config: any }} deps
 * @returns {() => void}
 */
function wireSeat(ctx, spec, deps) {
  const label = PKG_ID + ': entry ' + spec.id
  if (typeof ctx.inject === 'function') {
    return ctx.effect(
      () => ctx.inject(spec.requires, (injected) => armSeat(injected, spec, deps)),
      label,
    )
  }
  deps.log.push('entry.inject-unavailable', { seat: spec.id, reason: 'ctx.inject is not a function; arming once against the plugin context' })
  return ctx.effect(() => armSeat(ctx, spec, deps), label)
}