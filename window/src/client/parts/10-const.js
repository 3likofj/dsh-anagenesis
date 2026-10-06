/**
 * Client half, part 1/9 — identity, slot keys, config defaults and config
 * migration.
 *
 * Every string in this part is a contract with something outside this package:
 * the Host route path (`src/host/rpc.js` re-exports the same literal), the slot
 * keys the live shell declares (read from the running shell's Slot ledger), and
 * the config keys the Host half sends over `?method=config`. `test/host.test.mjs`
 * asserts the route literal is the same in both halves, because a typo there is a
 * silently dead window rather than an error.
 */

/** The package id — also the ModuleLoader id and the `dsh.client` identity. */
const PKG_ID = 'dsh-anagenesis-window'
/** The Host half's only route. Must equal `ROUTE_PATH` in src/host/rpc.js. */
const API_PATH = '/anagenesis-window/api'
/** Attribute stamped on the one <style> element this package owns. */
const CSS_ATTR = 'data-dsh-anagenesis-window'
/** Current config shape. Bump with `migrateConfig` whenever a key changes meaning. */
const CONFIG_VERSION = 2

/** Slot keys, exactly as the live shell declares them. */
const SLOT = {
  overlay: 'shell.overlay',
  headerUtilities: 'conversation.session.header.utilities',
  sidebarFooterAction: 'sidebar.footer.action',
  nativeTabBody: 'sidebar.right.pane.tab',
  nativeTabTitle: 'sidebar.right.pane.tab.title',
}

/**
 * The entrance seats. The task named four positions; the operator then asked for
 * the better-sidebar **bottom workbench** row to be removed, so entry 2 is gone and
 * what remains is entry 1 (its better-sidebar row, or the official left column as an
 * opt-in fallback), entry 3 and entry 4.
 */
const SEAT = {
  betterRow: 'better-sidebar-row',
  officialRight: 'official-right-sidebar',
  header: 'conversation-header',
  leftFooter: 'official-left-footer',
}

/** Registration order of the seats, used for stable reporting. */
const SEAT_ORDER = [SEAT.betterRow, SEAT.officialRight, SEAT.header, SEAT.leftFooter]

/**
 * The entrances as entrances, each mapped onto the seat(s) that can carry it.
 * Entry 1 has two candidate seats (the better-sidebar row and, only on request, the
 * official left column); at most one is ever armed, so the rollup resolves to `via`
 * the seat that actually carries it.
 *
 * `better-sidebar-bottom` was removed on request: better-sidebar maps it into the
 * same right column as entry 1, so it read as a second row pointing at one window.
 */
const ENTRY_GROUPS = [
  { entry: 1, id: 'sidebar-row', label: '侧栏一行', seats: [SEAT.betterRow, SEAT.leftFooter] },
  { entry: 3, id: 'official-right-sidebar', label: '官方右侧侧边栏', seats: [SEAT.officialRight] },
  { entry: 4, id: 'conversation-header', label: '对话 / 轨迹顶部栏', seats: [SEAT.header] },
]

/** Tab type ids. */
const TAB_TYPE = {
  panel: PKG_ID + ':panel',
  guide: PKG_ID + ':guide',
  /** The official right sidebar's implementation id: it keys the two native seats. */
  nativeKind: PKG_ID + ':native',
}

/** Registry ids for the two non-tab seats. */
const SLOT_ID = {
  overlay: PKG_ID + ':window',
  header: PKG_ID + ':header',
  leftFooter: PKG_ID + ':left-footer',
}

/** Host-side defaults, mirrored so a client that never reaches the Host still behaves. */
const DEFAULT_CONFIG = {
  title: 'anagenesis · 可视化',
  redaction: 'secrets',
  color: 'never',
  width: 96,
  events: 8,
  salience: 5,
  diagramNodes: 40,
  refreshMs: 2000,
  officialEntry: 'auto',
  leftColumnFallback: 'off',
  configVersion: CONFIG_VERSION,
}

/** The policy tri-state for the official right-sidebar seat. */
const OFFICIAL_ENTRY_MODES = ['auto', 'always', 'off']
/** Where entry 1 may land when DSH-better-sidebar is absent. */
const LEFT_COLUMN_MODES = ['off', 'official-footer']

/** @param {unknown} value @param {any[]} allowed @param {any} fallback @returns {any} */
function oneOf(value, allowed, fallback) {
  return allowed.indexOf(value) >= 0 ? value : fallback
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function numberOr(value, fallback) {
  const parsed = Number(value)
  return isFinite(parsed) ? parsed : fallback
}

/**
 * Bring any incoming config up to `CONFIG_VERSION`, then clamp it.
 *
 * The rule this part enforces: **a value written by an older version is never
 * silently reinterpreted as a value of the current version.** Each rename is
 * migrated by name and reported; a key this version does not know is dropped and
 * reported rather than merged in and forgotten.
 *
 * Migration table:
 *   v0 → v1  `officialSidebar: boolean`    → `officialEntry: 'always' | 'off'`
 *   v1 → v2  `officialEntry: 'hidden'`     → `'off'` (the tri-state names the
 *                                            outcome, not the mechanism)
 *   v1 → v2  `bottomEntry: boolean`        → dropped; the bottom seat ships with
 *                                            the better-sidebar pair and is
 *                                            governed by the provider's presence
 * @param {any} raw
 * @returns {{ config: any, migrated: string[], unknown: string[], version: number }}
 */
function migrateConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? Object.assign({}, raw) : {}
  /** @type {string[]} */
  const migrated = []
  /** @type {string[]} */
  const unknown = []
  const from = numberOr(source.configVersion, 0)

  if (typeof source.officialSidebar === 'boolean') {
    source.officialEntry = source.officialSidebar ? 'always' : 'off'
    delete source.officialSidebar
    migrated.push('officialSidebar → officialEntry')
  }
  if (source.officialEntry === 'hidden') {
    source.officialEntry = 'off'
    migrated.push("officialEntry 'hidden' → 'off'")
  }
  if (Object.prototype.hasOwnProperty.call(source, 'bottomEntry')) {
    delete source.bottomEntry
    migrated.push('bottomEntry dropped (the bottom seat follows the provider)')
  }

  const config = Object.assign({}, DEFAULT_CONFIG)
  for (const key of Object.keys(source)) {
    if (key === 'configVersion') continue
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) {
      unknown.push(key)
      continue
    }
    config[key] = source[key]
  }

  config.title = typeof config.title === 'string' && config.title !== '' ? config.title : DEFAULT_CONFIG.title
  config.redaction = oneOf(config.redaction, ['none', 'secrets', 'strict'], DEFAULT_CONFIG.redaction)
  config.color = oneOf(config.color, ['auto', 'always', 'never'], DEFAULT_CONFIG.color)
  config.width = Math.min(200, Math.max(48, numberOr(config.width, DEFAULT_CONFIG.width)))
  config.events = Math.min(200, Math.max(1, numberOr(config.events, DEFAULT_CONFIG.events)))
  config.salience = Math.min(50, Math.max(1, numberOr(config.salience, DEFAULT_CONFIG.salience)))
  config.diagramNodes = Math.min(200, Math.max(1, numberOr(config.diagramNodes, DEFAULT_CONFIG.diagramNodes)))
  config.refreshMs = Math.min(60000, Math.max(500, numberOr(config.refreshMs, DEFAULT_CONFIG.refreshMs)))
  config.officialEntry = oneOf(config.officialEntry, OFFICIAL_ENTRY_MODES, DEFAULT_CONFIG.officialEntry)
  config.leftColumnFallback = oneOf(config.leftColumnFallback, LEFT_COLUMN_MODES, DEFAULT_CONFIG.leftColumnFallback)
  config.configVersion = CONFIG_VERSION
  return { config: config, migrated: migrated, unknown: unknown, version: from }
}