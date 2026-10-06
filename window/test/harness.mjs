/**
 * Offline harness for the client half.
 *
 * What this is: a faithful-enough stand-in for the three things the browser half
 * actually touches — a Cordis **client Context** (`get` / `inject` / `effect` /
 * `provide`), the **slot service** (`register` / `inject`), and the two optional
 * collaborators (`ctx.betterSidebar`, `ctx.sidebarRightTabs`) — plus a ~90-line
 * React runtime, so the components are *executed* rather than pattern-matched.
 *
 * What this is not: a browser. There is no layout, no pointer input and no real
 * renderer, so nothing here proves the window *looks* right. The claims it does
 * support are the ones the task actually grades: which seats arm in which
 * environment, that a seat arms once and only once, that a dependency appearing or
 * disappearing flips a seat, and that teardown leaves the registries, the DOM and
 * the timers exactly as it found them.
 *
 * The extension contracts modelled here were read off the shipped implementations
 * of the plugins that own them, not invented:
 *   - `ctx.inject(deps, cb)` re-running on appear/disappear —
 *     `dsh-better-sidebar/src/client/native/index.ts` (real-profile comment).
 *   - `slots.register(spec, Component)` / `slots.inject(key, cb)` —
 *     `dsh-my-guardian/lib/client.js:1219-1232`.
 *   - `ctx.betterSidebar.registerTab(descriptor)` returning a disposer —
 *     `dsh-better-sidebar/lib/types/client/service.d.ts:462`.
 *   - `ctx.sidebarRightTabs.register({ id, kind, title, guide })` —
 *     `dsh-my-guardian/lib/client.js:1207-1217`.
 *
 * @module dsh-anagenesis-window/test/harness
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = resolve(here, '..', 'client.js')

/** @param {() => void} fn */
function once(fn) {
  let done = false
  return () => {
    if (done) return
    done = true
    fn()
  }
}

// ── a tiny React ─────────────────────────────────────────────────────────────

/**
 * Enough React to mount a function component, re-render it, and run effects.
 * Hook slots are index-based, which is exactly React's own rule (hook order is
 * fixed per component), so the shim fails the same way real React would if a part
 * ever broke that rule.
 */
export function createFakeReact() {
  const slots = []
  const subscriptions = new Set()
  let cursor = 0
  let pendingEffects = []
  let mounted = false
  let runner = null

  const schedule = () => {
    if (runner !== null) runner()
  }

  const api = {
    createElement(type, props, ...children) {
      return { $$el: true, type: type, props: props === null || props === undefined ? {} : props, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (slots[index] === undefined) slots[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(slots[index]) : next
        if (Object.is(value, slots[index])) return
        slots[index] = value
        schedule()
      }
      return [slots[index], set]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (slots[index] === undefined) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(effect, deps) {
      const index = cursor
      cursor += 1
      pendingEffects.push({ index: index, effect: effect, deps: deps })
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const index = cursor
      cursor += 1
      if (slots[index] === undefined) {
        const unsubscribe = subscribe(schedule)
        slots[index] = { unsubscribe: unsubscribe }
        subscriptions.add(unsubscribe)
      }
      return getSnapshot()
    },
  }

  const same = (a, b) => {
    if (a === undefined || b === undefined) return false
    if (a === null || b === null) return a === b
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
    return true
  }

  /**
   * Resolve function components into host elements, the way React does.
   *
   * A slot registration hands the shell a component whose body is
   * `() => createElement(RealComponent, { … })` (better-sidebar's own pattern), so
   * without this step a test would only ever see the wrapper's element and never
   * the window inside it.
   *
   * LIMITATION, stated so nobody over-reads these tests: hook slots are shared by
   * the whole tree rather than keyed per component instance. That is sound here
   * because every tree in this package has one function component at a fixed
   * position — hook ORDER is stable, which is the property React actually requires.
   * A tree with two sibling stateful components would not be modelled correctly.
   */
  const expand = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (node.$$el !== true) return node
    if (typeof node.type === 'function') return expand(node.type(node.props))
    if (node.children.length === 0) return node
    return { $$el: true, type: node.type, props: node.props, children: node.children.map(expand) }
  }

  /**
   * Mount one component. Returns the element tree plus the two controls a test
   * needs: `rerender()` and `unmount()`.
   * @param {(props: any) => any} Component
   * @param {any} props
   */
  function mount(Component, props) {
    mounted = true
    /** @type {{ index: number, effect: () => any, deps: any[]|undefined, cleanup: any }[]} */
    const committed = []
    let tree = null

    const renderOnce = () => {
      cursor = 0
      pendingEffects = []
      tree = expand(Component(props === undefined ? {} : props))
      /** @type {any[]} */
      const next = []
      for (const entry of pendingEffects) {
        const previous = committed[entry.index]
        if (previous !== undefined && same(previous.deps, entry.deps)) {
          next[entry.index] = previous
          continue
        }
        if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
        const cleanup = entry.effect()
        next[entry.index] = { index: entry.index, effect: entry.effect, deps: entry.deps, cleanup: cleanup }
      }
      for (const previous of committed) {
        if (previous === undefined) continue
        if (next[previous.index] === previous) continue
        if (typeof previous.cleanup === 'function') previous.cleanup()
      }
      committed.length = 0
      for (const entry of next) {
        if (entry === undefined) continue
        committed[entry.index] = entry
      }
      return tree
    }

    runner = () => {
      if (mounted) renderOnce()
    }

    renderOnce()

    return {
      get tree() {
        return tree
      },
      rerender: () => renderOnce(),
      unmount() {
        mounted = false
        runner = null
        for (const entry of committed) {
          if (entry !== undefined && typeof entry.cleanup === 'function') entry.cleanup()
        }
        committed.length = 0
        for (const unsubscribe of Array.from(subscriptions)) unsubscribe()
        subscriptions.clear()
      },
    }
  }

  return { api: api, mount: mount, elementCount: () => slots.length }
}

/** Depth-first search of the element tree for the first node satisfying `pick`. */
export function findElement(tree, pick) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return null
  if (tree.$$el === true && pick(tree)) return tree
  if (tree.$$el === true) {
    for (const child of tree.children) {
      const hit = findElement(child, pick)
      if (hit !== null) return hit
    }
  }
  return null
}

/** Every node in the tree, depth first. */
export function walk(tree, out = []) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return out
  if (tree.$$el === true) {
    out.push(tree)
    for (const child of tree.children) walk(child, out)
  }
  return out
}

// ── the client Context ───────────────────────────────────────────────────────

/**
 * A service ledger that behaves like the Cordis service store for the two things
 * the client half relies on: `get(name, strict)` and reactive `inject(deps, cb)`.
 */
export function createLedger() {
  /** @type {Map<string, any>} */
  const services = new Map()
  /** @type {{ deps: string[], cb: any, active: boolean, dispose: any }[]} */
  const watchers = []
  /** @type {Map<string, Set<(name: string, value: any) => void>>} */
  const eventListeners = new Map()

  const emit = (name, ...args) => {
    const set = eventListeners.get(name)
    if (set === undefined) return
    for (const listener of Array.from(set)) {
      try {
        listener(...args)
      } catch (error) {
        console.error('harness: event listener failed', error)
      }
    }
  }

  const scopeFor = (deps) => ({
    get(name, strict) {
      if (services.has(name)) return services.get(name)
      if (strict !== false) throw new Error(`cannot resolve "${name}" without inject`)
      return undefined
    },
    get injectedDeps() {
      return deps.slice()
    },
  })

  const settle = () => {
    // Looped, because arming one seat can publish a service another seat waits for.
    for (let pass = 0; pass < 4; pass += 1) {
      let changed = false
      for (const watcher of watchers) {
        const satisfied = watcher.deps.every((name) => services.has(name))
        if (satisfied && !watcher.active) {
          watcher.active = true
          watcher.dispose = watcher.cb(scopeFor(watcher.deps))
          changed = true
        } else if (!satisfied && watcher.active) {
          watcher.active = false
          const dispose = watcher.dispose
          watcher.dispose = null
          if (typeof dispose === 'function') dispose()
          changed = true
        }
      }
      if (!changed) break
    }
  }

  return {
    services: services,
    /** Re-evaluate every reactive injection. `set`/`remove` already call it. */
    settle: settle,
    /** `ctx.on('internal/service', …)`, the event cordis raises on every provide/dispose. */
    on(name, listener) {
      if (!eventListeners.has(name)) eventListeners.set(name, new Set())
      eventListeners.get(name).add(listener)
      return once(() => {
        const set = eventListeners.get(name)
        if (set !== undefined) set.delete(listener)
      })
    },
    set(name, value) {
      services.set(name, value)
      settle()
      // Cordis order: the store changes, then `internal/service` fires, then
      // `settle()` re-runs the injections that were waiting on it.
      emit('internal/service', name, value)
      settle()
    },
    remove(name) {
      services.delete(name)
      settle()
      emit('internal/service', name, undefined)
      settle()
    },
    inject(deps, cb) {
      const watcher = { deps: deps.slice(), cb: cb, active: false, dispose: null }
      watchers.push(watcher)
      settle()
      return once(() => {
        const index = watchers.indexOf(watcher)
        if (index >= 0) watchers.splice(index, 1)
        if (watcher.active) {
          watcher.active = false
          const dispose = watcher.dispose
          watcher.dispose = null
          if (typeof dispose === 'function') dispose()
        }
      })
    },
    /** How many injections are currently active — a leak detector. */
    activeInjections() {
      return watchers.filter((watcher) => watcher.active).length
    },
    totalInjections() {
      return watchers.length
    },
  }
}

/** The slot service: list and keyed registrations, declaration lifecycle included. */
export function createSlotsService() {
  /** @type {Map<string, { declared: boolean, occupants: Map<string, any> }>} */
  const table = new Map()
  let counter = 0
  const entryFor = (name) => {
    if (!table.has(name)) table.set(name, { declared: false, occupants: new Map() })
    return table.get(name)
  }

  const keyOf = (spec) => String(spec.key !== undefined ? spec.key : spec.id)

  return {
    register(spec, component) {
      const entry = entryFor(spec.name)
      if (!entry.declared) throw new Error(`slots: "${spec.name}" is not declared`)
      const key = keyOf(spec)
      if (entry.occupants.has(key)) throw new Error(`slots: duplicate registration for "${spec.name}" key "${key}"`)
      counter += 1
      const token = `occ-${counter}`
      entry.occupants.set(key, { token: token, spec: spec, component: component })
      return once(() => {
        const live = table.get(spec.name)
        if (live !== undefined) live.occupants.delete(key)
      })
    },
    inject(name, cb) {
      const watcher = { dispose: null, running: false }
      const run = () => {
        const entry = table.get(name)
        if (entry === undefined || entry.declared !== true) {
          if (watcher.running) {
            watcher.running = false
            const dispose = watcher.dispose
            watcher.dispose = null
            if (typeof dispose === 'function') dispose()
          }
          return
        }
        if (watcher.running) return
        watcher.running = true
        watcher.dispose = cb()
      }
      // `declare` re-runs every waiter, which is the whole point of `slots.inject`:
      // a callback that ran before the declaration existed must get a second chance
      // when the owner declares it (and a rollback when the declaration collapses).
      const entry = entryFor(name)
      if (entry.waiters === undefined) entry.waiters = new Set()
      entry.waiters.add(run)
      run()
      return once(() => {
        const live = table.get(name)
        if (live !== undefined && live.waiters !== undefined) live.waiters.delete(run)
        if (watcher.running) {
          watcher.running = false
          const dispose = watcher.dispose
          watcher.dispose = null
          if (typeof dispose === 'function') dispose()
        }
      })
    },
    /** The whole declared surface this harness models, declared up front by default. */
    declare(name, declared = true) {
      const entry = entryFor(name)
      entry.declared = declared
      if (entry.waiters !== undefined) for (const run of Array.from(entry.waiters)) run()
      return () => this.declare(name, false)
    },
    occupants(name) {
      const entry = table.get(name)
      if (entry === undefined) return []
      return Array.from(entry.occupants.values())
    },
    /** Every occupancy across every slot — the residue check reads this. */
    allOccupants() {
      const out = []
      for (const [name, entry] of table.entries()) {
        for (const occupancy of entry.occupants.values()) out.push({ slot: name, key: String(occupancy.spec.key !== undefined ? occupancy.spec.key : occupancy.spec.id), token: occupancy.token })
      }
      return out
    },
    /** Keys ordered by the registration `order` field, for ordering assertions. */
    orders(name) {
      return this.occupants(name).map((occupancy) => Number(occupancy.spec.order ?? 0))
    },
  }
}

/** `ctx.betterSidebar`, shaped like dsh-better-sidebar 0.24.1. */
export function createBetterSidebarFake(options = {}) {
  /** @type {Map<string, any>} */
  const tabs = new Map()
  const opened = []
  const lifecycle = options.lifecycle !== false
  return {
    version: options.version ?? '0.24.1',
    features: lifecycle
      ? ['badge', 'tabLifecycle', 'updateTab', 'openFile', 'targetedOpen', 'stateSubscription', 'tabMeta', 'pluginSettings', 'urlTarget', 'settingSelect', 'fileIcons']
      : ['badge', 'updateTab', 'pluginSettings'],
    registerTab(descriptor) {
      const id = String(descriptor.id)
      if (tabs.has(id)) throw new Error(`betterSidebar: duplicate tab id "${id}"`)
      tabs.set(id, descriptor)
      return once(() => {
        tabs.delete(id)
      })
    },
    registerFileViewer() {
      return () => {}
    },
    getTabs() {
      return Array.from(tabs.values())
    },
    getTab(id) {
      return tabs.get(id)
    },
    isTabEnabled() {
      return true
    },
    openTab(seed, scope) {
      opened.push({ seed: seed, scope: scope === undefined ? null : scope })
    },
    closeTab() {},
    activateTab() {},
    updateTab() {},
    subscribe() {
      return () => {}
    },
    getSnapshot() {
      return { sessionId: 'session-1', state: { tabs: [] }, prefs: {} }
    },
    /** test views */
    tabsById() {
      return Array.from(tabs.keys())
    },
    openedSeeds() {
      return opened.slice()
    },
  }
}

/** `ctx.sidebarRightTabs`, shaped like the official right-sidebar registry. */
export function createSidebarRightTabsFake() {
  /** @type {Map<string, any>} */
  const types = new Map()
  return {
    register(spec) {
      const id = String(spec.id)
      if (types.has(id)) throw new Error(`sidebarRight: duplicate tab type "${id}"`)
      types.set(id, spec)
      return once(() => {
        types.delete(id)
      })
    },
    get(id) {
      return types.get(id)
    },
    ids() {
      return Array.from(types.keys())
    },
    specs() {
      return Array.from(types.values())
    },
  }
}

/** `ctx.layout` — used only to raise the official column after an entry click. */
export function createLayoutFake() {
  const calls = []
  return {
    selectPanel() {},
    toggleSidebar() {},
    openRightbar(track, fullscreen) {
      calls.push({ track: track, fullscreen: fullscreen })
    },
    closeRightbar() {
      calls.push({ closed: true })
    },
    calls: calls,
  }
}

/** A DOM just rich enough: `<style>` insertion, `head`, `document.hidden`. */
export function createFakeDom(options = {}) {
  const head = {
    children: [],
    appendChild(node) {
      node.parentNode = head
      head.children.push(node)
      return node
    },
    removeChild(node) {
      const index = head.children.indexOf(node)
      if (index >= 0) head.children.splice(index, 1)
      node.parentNode = null
      return node
    },
  }
  const document = {
    head: head,
    hidden: options.hidden === true,
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        attributes: {},
        textContent: '',
        parentNode: null,
        setAttribute(name, value) {
          this.attributes[name] = String(value)
        },
        getAttribute(name) {
          return this.attributes[name] === undefined ? null : this.attributes[name]
        },
      }
    },
  }
  const listeners = new Map()
  const win = {
    location: { search: options.search ?? '' },
    innerWidth: options.innerWidth ?? 1280,
    innerHeight: options.innerHeight ?? 800,
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
    },
    removeEventListener(name, fn) {
      const set = listeners.get(name)
      if (set !== undefined) set.delete(fn)
    },
    __DSH_DESKTOP_FILE_PATH__: options.desktopFilePath,
    listenerCount() {
      let total = 0
      for (const set of listeners.values()) total += set.size
      return total
    },
  }
  if (options.desktopFilePath === undefined) delete win.__DSH_DESKTOP_FILE_PATH__
  return { window: win, document: document, head: head, listenerCount: () => win.listenerCount() }
}

// ── loading the built bundle ─────────────────────────────────────────────────

/**
 * Evaluate `client.js` as the browser would: a classic script whose first
 * statement registers a factory with `window.__ModuleLoader__`.
 *
 * `new Function` rather than a `vm` context on purpose: a fresh realm makes every
 * value the bundle hands back a foreign-realm object, so `assert.deepEqual`
 * compares prototypes and fails on arrays that are equal by every other measure.
 * Same-realm evaluation keeps the tests about the plugin instead of about the
 * harness's realm boundary.
 * @param {{ react: any, dom: any, fetchImpl?: any, timers?: boolean }} options
 */
export function evaluateClient(options) {
  const registered = []
  const win = options.dom.window
  win.__ModuleLoader__ = {
    load(definition) {
      registered.push(definition)
    },
  }
  const fetchImpl = options.fetchImpl !== undefined
    ? options.fetchImpl
    : async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: 'harness: no host route' }) })
  const setIntervalImpl = options.timers === false ? () => 0 : setInterval
  const clearIntervalImpl = options.timers === false ? () => {} : clearInterval
  const requireImpl = (spec) => {
    if (spec === 'react') return options.react
    throw new Error(`harness: unexpected require("${spec}") — the platform seed table has no such module`)
  }

  const source = readFileSync(CLIENT_PATH, 'utf8')
  const run = new Function('window', 'document', 'require', 'fetch', 'console', 'setInterval', 'clearInterval', source)
  run(win, options.dom.document, requireImpl, fetchImpl, console, setIntervalImpl, clearIntervalImpl)

  if (registered.length !== 1) {
    throw new Error(`harness: client.js registered ${registered.length} definitions, expected exactly 1`)
  }
  const definition = registered[0]
  if (definition.id !== 'dsh-anagenesis-window') {
    throw new Error(`harness: client.js registered id "${definition.id}" — it must equal the package name`)
  }
  const exports = definition.factory(requireImpl)
  return { exports: exports, definition: definition }
}

// ── mounting the whole plugin ────────────────────────────────────────────────

/**
 * Mount the client half against one environment.
 *
 * @param {{ betterSidebar?: boolean, sidebarRightTabs?: boolean, layout?: boolean, desktop?: boolean,
 *   fetchImpl?: any, slots?: boolean, dom?: any, config?: any }} [options]
 * @returns {any}
 */
export function mountClient(options = {}) {
  const react = createFakeReact()
  const ledger = createLedger()
  const slots = options.slots === false ? null : createSlotsService()
  const betterSidebar = options.betterSidebar === true ? createBetterSidebarFake(options.betterSidebarOptions ?? {}) : null
  const sidebarRightTabs = options.sidebarRightTabs === false ? null : createSidebarRightTabsFake()
  const layout = options.layout === false ? null : createLayoutFake()

  if (slots !== null && options.declareSlots !== false) {
    for (const name of ['shell.overlay', 'conversation.session.header.utilities', 'sidebar.footer.action', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) {
      slots.declare(name, true)
    }
  }
  const dom = options.dom ?? createFakeDom({
    search: options.search ?? (options.desktop === true ? '?dsh-desktop-mode=advanced&dsh-desktop-platform=win32' : ''),
    desktopFilePath: options.desktopFilePath,
  })

  ledger.set('slots', slots)
  if (sidebarRightTabs !== null) ledger.set('sidebarRightTabs', sidebarRightTabs)
  if (betterSidebar !== null) ledger.set('betterSidebar', betterSidebar)
  if (layout !== null) ledger.set('layout', layout)

  /** @type {any[]} */
  const effects = []
  /** @type {Map<string, any>} */
  const provided = new Map()
  let disposed = false

  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const ctx = {
    get(name, strict) {
      return ledger.services.has(name) ? ledger.services.get(name) : strict === false ? undefined : undefined
    },
    provide(name, value) {
      if (provided.has(name)) throw new Error(`provide: "${name}" is already provided in this scope`)
      provided.set(name, value)
    },
    effect(fn, label) {
      const result = fn()
      const dispose = once(() => {
        if (typeof result === 'function') result()
      })
      effects.push({ label: label, dispose: dispose })
      return dispose
    },
    inject(deps, cb) {
      return ledger.inject(deps, cb)
    },
    on(name, listener) {
      return ledger.on(name, listener)
    },
    logger: logger,
  }

  const loaded = evaluateClient({ react: react.api, dom: dom, fetchImpl: options.fetchImpl, timers: options.timers === true })
  loaded.exports.apply(ctx)

  return {
    exports: loaded.exports,
    ctx: ctx,
    ledger: ledger,
    slots: slots,
    betterSidebar: betterSidebar,
    sidebarRightTabs: sidebarRightTabs,
    layout: layout,
    dom: dom,
    react: react,
    /** `ctx.anagenesisWindow` — the published read face. */
    service: provided.get('anagenesisWindow'),
    provided: provided,
    effects: effects,
    logger: logger,
    activeInjections: () => ledger.activeInjections(),
    styleNodes: () => dom.head.children.filter((node) => node.tagName === 'STYLE').length,
    /** 插进 `<head>` 的样式表正文 —— 用来断言"装进去的确实是渲染层那一份"。 */
    styleText: () => dom.head.children.filter((node) => node.tagName === 'STYLE').map((node) => node.textContent).join('\n'),
    listenerCount: () => dom.listenerCount(),
    dispose() {
      if (disposed) return
      disposed = true
      for (let index = effects.length - 1; index >= 0; index -= 1) effects[index].dispose()
    },
  }
}

export { join }