/**
 * Public type face of the dsh-anagenesis-window **client half**.
 *
 * This is a hand-written declaration for a hand-written classic script (the
 * `dsh.client` bundle cannot be ESM, so there is no emitted `.d.ts` to ship). It
 * exists so a consumer can write
 *
 * ```ts
 * import type {} from 'dsh-anagenesis-window/client'   // merges ctx.anagenesisWindow
 * export const inject = ['anagenesisWindow']
 * export function apply(ctx: Context) {
 *   ctx.anagenesisWindow.entryStates()   // typed
 * }
 * ```
 *
 * and so this package's own contract is reviewable in one screen. Every shape here
 * is asserted by `test/entries.test.mjs`, `test/window.test.mjs` and
 * `test/host.test.mjs`.
 */

/** Which entrance slot a seat fills. `official-left-footer` is entry 1's alternate seat. */
export type EntrySeat =
  | 'better-sidebar-row'
  | 'official-right-sidebar'
  | 'conversation-header'
  | 'official-left-footer'

/** Closed lifecycle vocabulary for one seat. */
export type EntryState =
  | 'idle'
  | 'registering'
  | 'registered'
  | 'degraded'
  | 'suppressed'
  | 'error'
  | 'released'

/**
 * The entrances the window is reachable from.
 *
 * The task names four positions; the operator then asked for the better-sidebar
 * bottom-workbench row to be removed, so entry 2 no longer exists and the ids are
 * 1, 3 and 4.
 */
export type EntryNumber = 1 | 3 | 4

/** Which face of the window is showing. `graph` is the chart face (SVG). */
export type WindowView = 'dashboard' | 'graph'

/** Diagram kinds the chart face can draw. */
export type DiagramKind = 'memory-graph' | 'strategy-timeline' | 'lifecycle'

/** Layout direction for the chart face. */
export type LayoutDirection = 'LR' | 'TB'

/** Redaction levels, safest first. */
export type RedactionLevel = 'secrets' | 'strict' | 'none'

/** One seat's row in the status read. */
export interface EntrySeatRow {
  seat: EntrySeat
  /** Human label, e.g. `DSH-better-sidebar · 侧栏页签行（入口 1）`. */
  label: string
  /** The seat family, e.g. `better-sidebar tab row`. */
  seatKind: string
  /** The services this seat declares; `ctx.inject` is what makes them reactive. */
  requires: string[]
  state: EntryState
  /** Why the seat is in that state — always populated, including on success. */
  reason: string
  at: number
  /** How many times this seat has been claimed. */
  claims: number
}

/** One entrance, resolved over the seat(s) that can carry it. */
export interface EntryRollupRow {
  entry: EntryNumber
  id: string
  label: string
  state: EntryState
  /** The seat that carries this entrance, or `''` when none does. */
  via: EntrySeat | ''
  reason: string
  seats: EntrySeat[]
  /** Per-seat `seat: state — reason` lines, for a status panel. */
  details: string[]
}

/** The window's observable state. Identity is stable between notifications. */
export interface WindowSnapshot {
  open: boolean
  view: WindowView
  /** Diagram kind for `view: 'graph'`. */
  kind: DiagramKind | string
  /** Layout direction for `view: 'graph'`. */
  direction: LayoutDirection
  /** Chart zoom, 0.4–2.5. Purely local: changing it never re-reads the Host. */
  zoom: number
  /** Node cap for `view: 'graph'`; the Host truncates by salience before sending. */
  maxNodes: number
  /** Frame width in terminal cells, 48–200. Only the dashboard face uses it. */
  width: number
  redaction: RedactionLevel
  x: number | null
  y: number | null
  /**
   * 渲染层产出的 HTML（图表部分是内联 SVG）。空串 = 还没读到数据。
   *
   * It is plain markup built by this package's own render layer, with every store
   * string escaped — not third-party content.
   */
  html: string
  /** One-line Chinese summary of what the current face is showing. */
  summary: string
  /**
   * `''` when the Host answered with a structured model; `'frame'` / `'diagram'`
   * when the Host half is an older build that only knows the text methods and the
   * window fell back to the terminal rendering. See `test/window.test.mjs`.
   */
  degraded: '' | 'frame' | 'diagram'
  warnings: string[]
  error: string
  busy: boolean
  lastAt: number
  origin: string
  storeVersion: number
  status: HostStatus | null
  counters: { opens: number; refreshes: number; failures: number; drained: number }
}

/** Slow facts about the store, as the Host reported them. */
export interface HostStatus {
  ok: boolean
  storeFound: boolean
  root: string
  storeVersion: number
  memories: number
  pendingOpen: boolean
  at: number
  error?: string
}

/** What the client half can see of its environment. Every field is observational. */
export interface EnvironmentSnapshot {
  at: number
  desktop: { desktop: boolean; mode: 'compatibility' | 'advanced' | null; platform: string | null; signal: string }
  services: Record<string, { key: string; label: string; present: boolean; reason: string; missing: string[]; service: unknown }>
  betterSidebar: {
    present: boolean
    version: string
    features: string[]
    canLifecycle: boolean
    canTargetedOpen: boolean
    canStateSubscribe: boolean
  }
}

/** The client-side policy, after migration and clamping. */
export interface WindowConfig {
  title: string
  redaction: 'none' | 'secrets' | 'strict'
  color: string
  width: number
  events: number
  salience: number
  diagramNodes: number
  refreshMs: number
  officialEntry: 'auto' | 'always' | 'off'
  leftColumnFallback: 'off' | 'official-footer'
  configVersion: number
}

/** One observability row. `detail` is never `undefined`. */
export interface WindowLogRow {
  at: number
  type: string
  detail: Record<string, unknown> | null
}

/** Where to raise the window, and which door to use. */
export interface OpenWindowOptions {
  /** A seat id from {@link EntrySeat}. Every seat raises the same window. */
  seat?: EntrySeat | string
  view?: WindowView
  kind?: string
  direction?: LayoutDirection
}

/** The service published as `ctx.anagenesisWindow`. */
export interface AnagenesisWindowService {
  readonly version: string
  /** Raise the window. Idempotent: a second door raises, never duplicates. */
  open(options?: OpenWindowOptions): WindowSnapshot
  close(reason?: string): WindowSnapshot
  toggle(reason?: string): WindowSnapshot
  /** Flip to a face without changing whether the window is open. */
  setView(view: WindowView): WindowSnapshot
  /**
   * 工具栏上一个控件的新值 —— 与窗口里的事件委托走同一条路。
   *
   * Render-only fields (`direction`, `zoom`) re-render locally; data fields
   * (`kind`, `maxNodes`, `width`, `redaction`) re-read the Host.
   */
  setField(field: 'view' | 'kind' | 'direction' | 'zoom' | 'maxNodes' | 'width' | 'redaction' | string, value: string | number): WindowSnapshot
  /** 工具栏按钮（`data-ana-action` 的值）。 */
  dispatch(action: 'view-dashboard' | 'view-graph' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'refresh' | 'close' | string): WindowSnapshot
  /** Geometry and face inputs; `view` is accepted here too. */
  patch(patch: Partial<Pick<WindowSnapshot, 'view' | 'kind' | 'direction' | 'zoom' | 'maxNodes' | 'width' | 'redaction' | 'x' | 'y'>>): WindowSnapshot
  /** Re-read the Host once, now. */
  refresh(): Promise<unknown>
  /** Re-read the slow store facts once, now. */
  refreshStatus(): Promise<HostStatus>
  /** Take the Host's pending-open slot once, now — the agent door, driven by hand. */
  drain(): Promise<unknown>
  /** Everything the entry layer currently believes. */
  status(): {
    package: string
    version: string
    window: WindowSnapshot
    entries: EntrySeatRow[]
    entryStates: EntryRollupRow[]
    environment: EnvironmentSnapshot
    config: WindowConfig
    migration: { migrated: string[]; unknown: string[]; from: number; to: number }
    log: { limit: number; size: number; dropped: number }
  }
  entries(): EntrySeatRow[]
  entryStates(): EntryRollupRow[]
  log(type?: string): WindowLogRow[]
  environment(): EnvironmentSnapshot
  /** Runtime policy change; re-plans exactly the seats the policy governs. */
  configure(patch: Record<string, unknown>): ReturnType<AnagenesisWindowService['status']>
  subscribe(listener: () => void): () => void
  onEntry(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Published by the dsh-anagenesis-window client half. */
    anagenesisWindow: AnagenesisWindowService
  }
}

/** The client half's plugin object, as the `dsh.client` loader expects it. */
export interface AnagenesisWindowClientPlugin {
  name: string
  inject: readonly string[]
  apply(ctx: unknown): void
}