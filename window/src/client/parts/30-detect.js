/**
 * Client half, part 3/9 — runtime detection.
 *
 * The task's requirement is explicit: **detect, do not assume.** Two independent
 * answers are produced here and both are logged, because they can legitimately
 * disagree and the disagreement is the interesting case:
 *
 *   1. the **service probe** — is `ctx.betterSidebar` published, and does it
 *      actually look like the service (methods present)? A same-named unrelated
 *      service must not be mistaken for it, so presence is never enough.
 *   2. the **Host probe** — the Host half reads the Loader entry list and reports
 *      which bundles are mounted. That is composition truth, whereas the service
 *      probe is runtime truth; a mismatch means the client half runs against a
 *      different composition than the row that loaded it.
 *
 * The desktop-shell test follows the documented DSH Desktop contract
 * (`dsh-desktop-mode` / `dsh-desktop-platform` URL stamps plus the
 * `__DSH_DESKTOP_FILE_PATH__` preload marker), which is the same signal
 * `dsh-better-sidebar/src/client/desktop-env.ts` reads. It is reported, never
 * *required*: all four seats work identically in a plain browser tab, and
 * forcing a desktop-only gate would break the web profile for no benefit.
 */

/** The shape each optional collaborator must have to be used. */
const SERVICE_SHAPES = {
  betterSidebar: {
    label: 'DSH-better-sidebar',
    methods: ['registerTab', 'openTab', 'getTabs'],
    basis: 'dsh-better-sidebar ≥ 0.4.0 publishes ctx.betterSidebar; 0.24.1 additionally has features[] and getSnapshot().',
  },
  sidebarRightTabs: {
    label: 'official right sidebar',
    methods: ['register'],
    basis: 'registered by @deepseek-ai/dsh-client-ui-sidebar-right; consumed by dsh-my-guardian/lib/client.js the same way.',
  },
  slots: {
    label: 'slot system',
    methods: ['register', 'inject'],
    basis: 'ctx.slots, declared by @deepseek-ai/dsh-client-ui-slots.',
  },
  layout: {
    label: 'layout actions',
    methods: ['openRightbar', 'closeRightbar'],
    basis: 'ctx.layout, used only to raise the official right column after an entry click.',
  },
}

/** @param {unknown} error @returns {string} */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Probe one optional service: present AND shaped as expected.
 * `ctx.get(key, false)` is the non-strict form on purpose — a missing optional
 * collaborator is a normal state, not a programming error, and the strict form
 * throws for exactly that case.
 * @param {any} ctx
 * @param {string} key
 * @returns {{ key: string, label: string, present: boolean, service: any, reason: string, missing: string[] }}
 */
function probeService(ctx, key) {
  const shape = SERVICE_SHAPES[key]
  const label = shape === undefined ? key : shape.label
  const expected = shape === undefined ? [] : shape.methods
  let value
  try {
    value = ctx.get(key, false)
  } catch (error) {
    return { key: key, label: label, present: false, service: null, reason: 'ctx.get threw: ' + errorText(error), missing: expected.slice() }
  }
  if (value === undefined || value === null) {
    return { key: key, label: label, present: false, service: null, reason: 'service is not published in this composition', missing: expected.slice() }
  }
  const missing = expected.filter((method) => typeof value[method] !== 'function')
  if (missing.length > 0) {
    return { key: key, label: label, present: false, service: null, reason: 'service is published but lacks ' + missing.join(', '), missing: missing }
  }
  return { key: key, label: label, present: true, service: value, reason: 'ok', missing: [] }
}

/**
 * Whether this page is running inside the DSH Desktop shell.
 * @returns {{ desktop: boolean, mode: string|null, platform: string|null, signal: string }}
 */
function detectDesktopShell() {
  const win = typeof window !== 'undefined' ? window : undefined
  if (win === undefined) return { desktop: false, mode: null, platform: null, signal: 'no-window' }
  let mode = null
  let platform = null
  let signal = 'none'
  try {
    const search = win.location !== undefined && win.location !== null && typeof win.location.search === 'string' ? win.location.search : ''
    const params = new URLSearchParams(search.replace(/^\?/, ''))
    const rawMode = params.get('dsh-desktop-mode')
    if (rawMode === 'compatibility' || rawMode === 'advanced') {
      mode = rawMode
      signal = 'url-stamp'
    }
    const rawPlatform = params.get('dsh-desktop-platform')
    if (rawPlatform !== null && rawPlatform !== '') platform = rawPlatform.toLowerCase()
  } catch (error) {
    signal = 'unreadable-location'
  }
  if (signal === 'none' && win.__DSH_DESKTOP_FILE_PATH__ !== undefined) signal = 'preload-marker'
  return { desktop: signal === 'url-stamp' || signal === 'preload-marker', mode: mode, platform: platform, signal: signal }
}

/**
 * The full environment snapshot: this is what every entry decision reads, so it
 * is produced once per (re)plan and never consulted ad hoc.
 * @param {any} ctx
 * @returns {any}
 */
function detectEnvironment(ctx) {
  const better = probeService(ctx, 'betterSidebar')
  const official = probeService(ctx, 'sidebarRightTabs')
  const slots = probeService(ctx, 'slots')
  const layout = probeService(ctx, 'layout')
  let betterFeatures = []
  let betterVersion = ''
  if (better.present) {
    try {
      betterFeatures = Array.isArray(better.service.features) ? better.service.features.slice() : []
      betterVersion = typeof better.service.version === 'string' ? better.service.version : ''
    } catch (error) {
      betterFeatures = []
    }
  }
  return {
    at: Date.now(),
    desktop: detectDesktopShell(),
    services: {
      betterSidebar: better,
      sidebarRightTabs: official,
      slots: slots,
      layout: layout,
    },
    betterSidebar: {
      present: better.present,
      version: betterVersion,
      features: betterFeatures,
      // Capability-gated, never version-compared: the service publishes a
      // monotonic feature list precisely so consumers stop parsing versions.
      canLifecycle: betterFeatures.indexOf('tabLifecycle') >= 0,
      canTargetedOpen: betterFeatures.indexOf('targetedOpen') >= 0,
      canStateSubscribe: betterFeatures.indexOf('stateSubscription') >= 0,
    },
  }
}

/**
 * One line naming what was found, for the log and the status read.
 * @param {any} env
 * @returns {string}
 */
function describeEnvironment(env) {
  const names = []
  for (const key of ['betterSidebar', 'sidebarRightTabs', 'slots', 'layout']) {
    const probe = env.services[key]
    names.push(probe.label + '=' + (probe.present ? 'yes' : 'no'))
  }
  return names.join(' ') + ' desktop=' + (env.desktop.desktop ? env.desktop.signal : 'no')
}