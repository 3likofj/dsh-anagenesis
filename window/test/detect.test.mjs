/**
 * Detection, config migration and artifact integrity.
 *
 * These cover the claims that are easy to get subtly wrong: that a collaborator is
 * recognised by SHAPE and not merely by name, that the desktop-shell signal follows
 * the documented contract, that an older config key is migrated by name rather than
 * silently reinterpreted, and that the committed `client.js` is the artifact the
 * parts actually describe.
 * @module dsh-anagenesis-window/test/detect.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { mountClient } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const SOURCE = readFileSync(join(root, 'client.js'), 'utf8')

test('detect: the bundle honours the dsh.client classic-script contract', () => {
  assert.match(SOURCE, /window\.__ModuleLoader__\.load\(\{/)
  assert.ok(SOURCE.includes("id: 'dsh-anagenesis-window'"), 'the ModuleLoader id must be the package name')
  assert.equal(/^import\s/m.test(SOURCE), false, 'a classic script may not use a top-level import')
  assert.equal(/^export\s/m.test(SOURCE), false, 'a classic script may not use a top-level export')
  assert.equal((SOURCE.match(/^window\.__ModuleLoader__\.load\(/gm) ?? []).length, 1, 'exactly one registration statement per bundle')
  const head = SOURCE.split('\n').find((line) => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('/*') && !trimmed.startsWith('*')
  })
  assert.ok(head !== undefined && head.startsWith('window.__ModuleLoader__.load('), 'registration must be the first statement of the script')
})

test('detect: the route literal is identical in both halves', () => {
  const host = readFileSync(join(root, 'src', 'host', 'rpc.js'), 'utf8')
  const match = host.match(/ROUTE_PATH = '([^']+)'/)
  assert.ok(match !== null, 'the host half must declare ROUTE_PATH')
  assert.ok(SOURCE.includes(`const API_PATH = '${match[1]}'`), `the client half must use the same path as the host (${match[1]})`)
})

test('detect: the committed client.js is not stale with respect to its parts', () => {
  const output = execFileSync(process.execPath, [join(root, 'tools', 'build-client.mjs'), '--check'], { encoding: 'utf8' })
  assert.match(output, /up to date/)
})

test('window: the window opts back into pointer events inside the click-through overlay', () => {
  // Regression guard for a defect the offline suite could not see and the real host
  // exposed: the live `shell.overlay` catalog states "The layer itself is
  // click-through — entries opt back into pointer events". Without this the window
  // renders perfectly and is undraggable, unclickable and unscrollable.
  const at = SOURCE.indexOf('[data-dsh-anagenesis-window="window"]{')
  assert.ok(at > 0, 'the window root rule must exist')
  const body = SOURCE.slice(at, SOURCE.indexOf('}', at))
  assert.ok(body.includes('pointer-events:auto'), 'the overlay is click-through; the window must opt back in')
  assert.ok(body.includes('position:fixed'), 'and it is positioned by the frame, not by the layer')
})

test('packaging: dsh.client is declared here and the row count stays legal', () => {
  // The invariant that forced this whole package into existence: a package
  // declaring `dsh.client` may own exactly ONE active Loader row. Checked from both
  // sides, because the failure mode is a boot error in a composition nobody ran in
  // a unit test.
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.external, undefined, 'no non-baseline module requests: only React is needed')
  assert.ok(manifest.exports['./client'] !== undefined, 'dsh.client requires the ./client export')

  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const insertedIds = patch.split('\n').filter((line) => /^\s*- id:\s/.test(line))
  assert.equal(insertedIds.length, 1, `exactly one Loader row, found ${insertedIds.length}`)
  assert.match(insertedIds[0], /anagenesis-window/)

  // And the sibling that must NOT have a client half still does not.
  const parent = JSON.parse(readFileSync(join(root, '..', 'package.json'), 'utf8'))
  assert.equal(parent.dsh.client, undefined, 'dsh-anagenesis must never declare dsh.client — it owns five rows')
  assert.equal(parent.exports['./client'], undefined)
})

test('detect: presence alone is not enough — a look-alike service is refused', () => {
  // Right NAME, wrong SHAPE. A presence-only check would arm entry 1 here and
  // then call `registerTab` on a string inside a slot registration.
  const mounted = mountClient({ betterSidebar: false, sidebarRightTabs: false, layout: false })
  mounted.ledger.set('betterSidebar', { registerTab: 'not a function', openTab: () => {}, getTabs: () => [] })
  const rows = mounted.service.status().entries
  const row = rows.find((entry) => entry.seat === 'better-sidebar-row')
  assert.equal(row.state, 'degraded', 'a look-alike must not arm the seat')
  assert.match(row.reason, /lacks|not published/, 'the refusal must name what was wrong')
  assert.ok(mounted.betterSidebar === null, 'nothing was registered into the look-alike')
  mounted.dispose()
})

test('detect: a real DSH-better-sidebar service is accepted by shape', () => {
  const mounted = mountClient({ betterSidebar: true })
  const probe = mounted.service.environment().services.betterSidebar
  assert.equal(probe.present, true)
  assert.deepEqual(probe.missing, [])
  assert.equal(mounted.service.environment().betterSidebar.version, '0.24.1')
  assert.equal(mounted.service.environment().betterSidebar.canLifecycle, true)
  mounted.dispose()
})

test('detect: capability gating follows features[], not a version comparison', () => {
  const mounted = mountClient({ betterSidebar: true, betterSidebarOptions: { lifecycle: false } })
  const env = mounted.service.environment()
  assert.equal(env.betterSidebar.present, true)
  assert.equal(env.betterSidebar.canLifecycle, false, 'tabLifecycle is absent from features[]')
  const descriptor = mounted.betterSidebar.getTab('dsh-anagenesis-window:panel')
  assert.equal(descriptor.onOpen, undefined, 'no lifecycle callback when the feature is not advertised')
  assert.equal(descriptor.onActivate, undefined)
  mounted.dispose()
})

test('detect: the desktop shell is read from the documented URL stamp', () => {
  for (const [search, expected] of [
    ['', false],
    ['?dsh-desktop-mode=advanced&dsh-desktop-platform=win32', true],
    ['?dsh-desktop-mode=compatibility', true],
    ['?dsh-desktop-mode=nonsense', false],
  ]) {
    const mounted = mountClient({ betterSidebar: false, dom: undefined, desktop: false, search: search })
    const desktop = mounted.service.environment().desktop
    assert.equal(desktop.desktop, expected, `desktop detection for "${search}"`)
    if (expected) assert.equal(desktop.signal, 'url-stamp')
    mounted.dispose()
  }
})

test('detect: the preload marker is accepted when no URL stamp is present', () => {
  const mounted = mountClient({ betterSidebar: false, desktopFilePath: 'C:/tmp/x.txt' })
  const desktop = mounted.service.environment().desktop
  assert.equal(desktop.desktop, true)
  assert.equal(desktop.signal, 'preload-marker')
  mounted.dispose()
})

test('detect: the desktop signal is reported, never required — seats arm in a plain page', () => {
  const mounted = mountClient({ betterSidebar: true })
  assert.equal(mounted.service.environment().desktop.desktop, false)
  assert.equal(mounted.service.entries().find((row) => row.seat === 'conversation-header').state, 'registered')
  mounted.dispose()
})

test('detect: policy keys survive an unrecognised service as defaults', () => {
  const mounted = mountClient({ betterSidebar: false, sidebarRightTabs: false, layout: false })
  const config = mounted.service.status().config
  assert.equal(config.officialEntry, 'auto')
  assert.equal(config.leftColumnFallback, 'off')
  assert.equal(config.configVersion, 2)
  mounted.dispose()
})

test('config: v0 keys are migrated by name, and unknown keys are reported not merged', () => {
  const mounted = mountClient({ betterSidebar: false })
  const status = mounted.service.configure({ officialSidebar: true, bottomEntry: false, somethingElse: 7 })
  assert.equal(status.config.officialEntry, 'always', 'officialSidebar: true → officialEntry: always')
  assert.equal('officialSidebar' in status.config, false, 'the old key must not survive into the new shape')
  assert.equal('bottomEntry' in status.config, false, 'the dropped key must not survive')
  assert.ok(status.migration.migrated.some((entry) => entry.includes('officialSidebar')), 'the rename must be reported')
  assert.deepEqual(status.migration.unknown, ['somethingElse'], 'unknown keys are reported, not merged in and forgotten')
  assert.equal(status.migration.to, 2)
  mounted.dispose()
})

test('config: the v1 "hidden" spelling migrates to the tri-state "off"', () => {
  const mounted = mountClient({ betterSidebar: false })
  const status = mounted.service.configure({ configVersion: 1, officialEntry: 'hidden' })
  assert.equal(status.config.officialEntry, 'off')
  assert.ok(status.migration.migrated.some((entry) => entry.includes('hidden')))
  mounted.dispose()
})

test('config: out-of-range numbers are clamped, not trusted', () => {
  const mounted = mountClient({ betterSidebar: false })
  const status = mounted.service.configure({ width: 4000, events: -3, refreshMs: 1, officialEntry: 'nonsense' })
  assert.equal(status.config.width, 200)
  assert.equal(status.config.events, 1)
  assert.equal(status.config.refreshMs, 500)
  assert.equal(status.config.officialEntry, 'auto', 'an unknown mode falls back to the default, not to off')
  mounted.dispose()
})