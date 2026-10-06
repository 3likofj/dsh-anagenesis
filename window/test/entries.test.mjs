/**
 * The entrance suite: the compatibility matrix, mutual exclusion, reactive
 * re-planning, exact rollback and residue.
 *
 * This is the file the task's acceptance criteria map onto. Each test is one
 * clause: which seat arms in which environment (§兼容矩阵), that a seat arms once
 * (§不重复), that a declared dependency appearing or disappearing flips the seat
 * (§反应式余效应), and that teardown leaves no DOM node, no registration, no
 * listener, no timer and no service (§可逆 + §可观测).
 * @module dsh-anagenesis-window/test/entries
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { mountClient, createBetterSidebarFake } from './harness.mjs'

/** @param {any} mounted @param {string} seat */
function entryOf(mounted, seat) {
  const row = mounted.service.entries().find((entry) => entry.seat === seat)
  assert.ok(row !== undefined, `seat ${seat} must be declared`)
  return row
}

/** Every registration the client half could have made, in one list. */
function residue(mounted) {
  return {
    slots: mounted.slots === null ? [] : mounted.slots.allOccupants(),
    betterSidebarTabs: mounted.betterSidebar === null ? [] : mounted.betterSidebar.tabsById(),
    rightSidebarTypes: mounted.sidebarRightTabs === null ? [] : mounted.sidebarRightTabs.ids(),
    styleNodes: mounted.styleNodes(),
    activeInjections: mounted.activeInjections(),
  }
}

function assertNoResidue(mounted, label) {
  const left = residue(mounted)
  assert.deepEqual(left.slots, [], `${label}: slot registrations must be gone`)
  assert.deepEqual(left.betterSidebarTabs, [], `${label}: better-sidebar tab types must be gone`)
  assert.deepEqual(left.rightSidebarTypes, [], `${label}: right-sidebar tab types must be gone`)
  assert.equal(left.styleNodes, 0, `${label}: the stylesheet node must be gone`)
  assert.equal(left.activeInjections, 0, `${label}: no injection may stay active`)
}

// ── the matrix ───────────────────────────────────────────────────────────────

test('matrix: WITH DSH-better-sidebar, entries 1 and 4 arm and entry 3 steps aside', () => {
  const mounted = mountClient({ betterSidebar: true })
  try {
    assert.equal(entryOf(mounted, 'better-sidebar-row').state, 'registered')
    assert.equal(entryOf(mounted, 'conversation-header').state, 'registered')

    const official = entryOf(mounted, 'official-right-sidebar')
    assert.equal(official.state, 'suppressed', 'entry 3 must have a DEFINED behaviour, not an undefined one')
    assert.match(official.reason, /officialEntry=auto/)
    assert.match(official.reason, /better-sidebar/)

    // The decision is visible in the world, not only in the report.
    // One tab type only: the bottom-workbench row was removed on request, and
    // better-sidebar maps a descriptor into the same right column anyway.
    assert.deepEqual(mounted.betterSidebar.tabsById(), ['dsh-anagenesis-window:panel'])
    assert.deepEqual(mounted.sidebarRightTabs.ids(), [], 'nothing may be registered into the official column')
    assert.equal(mounted.slots.occupants('conversation.session.header.utilities').length, 1)
    assert.equal(mounted.slots.occupants('shell.overlay').length, 1)
  } finally {
    mounted.dispose()
  }
})

test('matrix: WITHOUT DSH-better-sidebar, entries 3 and 4 arm and entry 1 degrades', () => {
  const mounted = mountClient({ betterSidebar: false })
  try {
    const row = entryOf(mounted, 'better-sidebar-row')
    assert.equal(row.state, 'degraded', 'entry 1 must degrade, not disappear silently')
    assert.match(row.reason, /betterSidebar/, 'it must name the missing dependency')
    assert.match(row.reason, /no error, no residue/)

    assert.equal(entryOf(mounted, 'official-right-sidebar').state, 'registered')
    assert.equal(entryOf(mounted, 'conversation-header').state, 'registered')

    assert.deepEqual(mounted.sidebarRightTabs.ids(), ['dsh-anagenesis-window'])
    const type = mounted.sidebarRightTabs.specs()[0]
    assert.equal(type.kind, 'dsh-anagenesis-window:native', 'the official implementation id, distinct from the better-sidebar tab ids')
    assert.equal(type.guide.length, 1, 'the guide row is the visible entrance')
    assert.deepEqual(mounted.slots.occupants('sidebar.right.pane.tab').map((occupancy) => occupancy.spec.key), ['dsh-anagenesis-window'])
    assert.deepEqual(mounted.slots.occupants('sidebar.right.pane.tab.title').map((occupancy) => occupancy.spec.key), ['dsh-anagenesis-window'])
  } finally {
    mounted.dispose()
  }
})

test('matrix: every door drives one window, in both environments', () => {
  const withBetter = mountClient({ betterSidebar: true })
  const without = mountClient({ betterSidebar: false })
  try {
    assert.equal(withBetter.slots.occupants('shell.overlay').length, 1)
    assert.equal(without.slots.occupants('shell.overlay').length, 1)
    // Open through different doors; both read back the SAME engine state.
    withBetter.service.open({ seat: 'better-sidebar-row' })
    without.service.open({ seat: 'conversation-header' })
    assert.equal(withBetter.service.status().window.open, true)
    assert.equal(without.service.status().window.open, true)
    assert.equal(withBetter.service.status().window.counters.opens, 1, 'one window, one open')
    withBetter.service.open({ seat: 'conversation-header', view: 'graph' })
    assert.equal(withBetter.service.status().window.counters.opens, 1, 'a second door raises, never duplicates')
    assert.equal(withBetter.service.status().window.view, 'graph')
  } finally {
    withBetter.dispose()
    without.dispose()
  }
})

// ── no duplicates ────────────────────────────────────────────────────────────

test('no duplicates: re-planning the same policy does not arm a seat twice', () => {
  const mounted = mountClient({ betterSidebar: true })
  try {
    mounted.service.configure({ officialEntry: 'auto' })
    mounted.service.configure({ officialEntry: 'auto' })
    mounted.service.configure({ officialEntry: 'auto' })
    assert.equal(mounted.slots.occupants('shell.overlay').length, 1)
    assert.equal(mounted.slots.occupants('conversation.session.header.utilities').length, 1)
    assert.equal(mounted.betterSidebar.tabsById().length, 1, 'one seat, never a second copy')
  } finally {
    mounted.dispose()
  }
})

test('no duplicates: a governed seat is armed exactly once through a policy flip-flop', () => {
  const mounted = mountClient({ betterSidebar: true })
  try {
    mounted.service.configure({ officialEntry: 'always' })
    mounted.service.configure({ officialEntry: 'auto' })
    mounted.service.configure({ officialEntry: 'always' })
    assert.equal(mounted.sidebarRightTabs.ids().length, 1, 'at most one official seat at a time')
    assert.equal(mounted.slots.occupants('sidebar.right.pane.tab').length, 1, 'and exactly one body seat with it')
    const armed = mounted.service.log('entry.armed')
    assert.ok(armed.length >= 2, 're-planning must really re-arm rather than silently no-op')
  } finally {
    mounted.dispose()
  }
})

test('no duplicates: entry 1 has two possible seats and only ever occupies one', () => {
  const both = mountClient({ betterSidebar: true })
  const absent = mountClient({ betterSidebar: false })
  const fallback = mountClient({ betterSidebar: false })
  try {
    // Better-sidebar present: entry 1 uses the better-sidebar seat; the official
    // left-column seat stays suppressed even when the fallback is requested.
    both.service.configure({ leftColumnFallback: 'official-footer' })
    assert.equal(both.slots.occupants('sidebar.footer.action').length, 0, 'never both seats at once')
    assert.equal(both.betterSidebar.tabsById().length, 1)

    // Better-sidebar absent, fallback off (the default): entry 1 degrades.
    assert.equal(entryOf(absent, 'better-sidebar-row').state, 'degraded')
    assert.equal(absent.slots.occupants('sidebar.footer.action').length, 0)

    // Better-sidebar absent, fallback requested: entry 1 lands in the official
    // left column instead of degrading to nothing.
    fallback.service.configure({ leftColumnFallback: 'official-footer' })
    assert.equal(fallback.slots.occupants('sidebar.footer.action').length, 1, 'the alternate seat arms')
    const rolled = fallback.service.entryStates().find((row) => row.entry === 1)
    assert.equal(rolled.state, 'registered', 'entry 1 is armed — through its alternate seat')
    assert.equal(rolled.via, 'official-left-footer', 'and the report names which seat carries it')
    fallback.service.configure({ leftColumnFallback: 'off' })
    assert.equal(fallback.slots.occupants('sidebar.footer.action').length, 0, 'and gives the seat back when the policy reverts')
    assert.equal(fallback.service.entryStates().find((row) => row.entry === 1).state, 'degraded')
  } finally {
    both.dispose()
    absent.dispose()
    fallback.dispose()
  }
})

// ── reactive ─────────────────────────────────────────────────────────────────

test('reactive: DSH-better-sidebar appearing arms entry 1 and rolls entry 3 back', () => {
  const mounted = mountClient({ betterSidebar: false })
  try {
    assert.deepEqual(mounted.sidebarRightTabs.ids(), ['dsh-anagenesis-window'])

    mounted.ledger.set('betterSidebar', createBetterSidebarFake())
    mounted.ledger.settle()

    assert.equal(entryOf(mounted, 'better-sidebar-row').state, 'registered', 'entry 1 arms when its provider appears')
    assert.equal(entryOf(mounted, 'official-right-sidebar').state, 'suppressed', 'entry 3 rolls back the moment its policy flips')
    assert.deepEqual(mounted.sidebarRightTabs.ids(), [], 'and the registration is really gone')
    assert.deepEqual(mounted.slots.occupants('sidebar.right.pane.tab'), [])
    assert.deepEqual(mounted.slots.occupants('sidebar.right.pane.tab.title'), [])
  } finally {
    mounted.dispose()
  }
})

test('reactive: DSH-better-sidebar disappearing rolls entry 1 back and re-arms entry 3', () => {
  const mounted = mountClient({ betterSidebar: true })
  try {
    assert.equal(mounted.betterSidebar.tabsById().length, 1)
    assert.equal(mounted.sidebarRightTabs.ids().length, 0)

    mounted.ledger.remove('betterSidebar')
    mounted.ledger.settle()

    assert.deepEqual(mounted.betterSidebar.tabsById(), [], 'entry 1 rollback removes the tab type')
    assert.equal(mounted.slots.occupants('shell.overlay').length, 1, 'the window seat is untouched by an entry rollback')
    assert.equal(entryOf(mounted, 'better-sidebar-row').state, 'degraded', 'the report follows the environment back')
    assert.equal(entryOf(mounted, 'official-right-sidebar').state, 'registered')
    assert.deepEqual(mounted.sidebarRightTabs.ids(), ['dsh-anagenesis-window'])
  } finally {
    mounted.dispose()
  }
})

test('reactive: an undeclared slot is declared later and the seat fills it, then gives it back', () => {
  const mounted = mountClient({ betterSidebar: false, declareSlots: false })
  try {
    assert.equal(mounted.slots.occupants('shell.overlay').length, 0, 'nothing registers before the owner declares the slot')
    assert.equal(mounted.slots.occupants('conversation.session.header.utilities').length, 0)
    mounted.slots.declare('shell.overlay', true)
    mounted.slots.declare('conversation.session.header.utilities', true)
    assert.equal(mounted.slots.occupants('shell.overlay').length, 1, 'the window fills the seat when it appears')
    assert.equal(mounted.slots.occupants('conversation.session.header.utilities').length, 1)
    mounted.slots.declare('conversation.session.header.utilities', false)
    assert.equal(mounted.slots.occupants('conversation.session.header.utilities').length, 0, 'and gives it back when it collapses')
  } finally {
    mounted.dispose()
  }
})

test('reactive: policy changes re-plan only the seats the policy governs', () => {
  const mounted = mountClient({ betterSidebar: true })
  try {
    const before = mounted.service.log('entry.armed').length
    mounted.service.configure({ officialEntry: 'always' })
    assert.equal(entryOf(mounted, 'official-right-sidebar').state, 'registered')
    assert.deepEqual(mounted.sidebarRightTabs.ids(), ['dsh-anagenesis-window'])
    assert.ok(mounted.service.log('entry.armed').length > before, 'the governed seat re-armed')
    mounted.service.configure({ officialEntry: 'off' })
    assert.equal(entryOf(mounted, 'official-right-sidebar').state, 'suppressed')
    assert.deepEqual(mounted.sidebarRightTabs.ids(), [], 'off really removes it')
  } finally {
    mounted.dispose()
  }
})

// ── reversibility ────────────────────────────────────────────────────────────

test('reversible: teardown with DSH-better-sidebar leaves no residue at all', () => {
  const mounted = mountClient({ betterSidebar: true })
  assert.equal(mounted.styleNodes(), 1)
  assert.ok(mounted.slots.allOccupants().length >= 2)
  mounted.dispose()
  assertNoResidue(mounted, 'with DSH-better-sidebar')
})

test('reversible: teardown without DSH-better-sidebar leaves no residue at all', () => {
  const mounted = mountClient({ betterSidebar: false })
  mounted.dispose()
  assertNoResidue(mounted, 'without DSH-better-sidebar')
})

test('reversible: teardown is idempotent — a second dispose is a no-op, not a second removal', () => {
  const mounted = mountClient({ betterSidebar: true })
  mounted.dispose()
  const afterFirst = residue(mounted)
  mounted.dispose()
  mounted.dispose()
  assert.deepEqual(residue(mounted), afterFirst)
  assert.deepEqual(mounted.service.log('entry.dispose-error'), [], 'no disposer may throw, ever')
})

test('reversible: losing an entrance does not close or remove the window', () => {
  const mounted = mountClient({ betterSidebar: true })
  try {
    mounted.service.open({ seat: 'better-sidebar-row' })
    assert.equal(mounted.service.status().window.open, true)
    mounted.ledger.remove('betterSidebar')
    mounted.ledger.settle()
    assert.equal(mounted.service.status().window.open, true, 'losing an entrance must not close the window')
    assert.equal(mounted.slots.occupants('shell.overlay').length, 1, 'and must not remove the window seat')
  } finally {
    mounted.dispose()
  }
  assert.equal(mounted.slots.occupants('shell.overlay').length, 0, 'the teardown finally does')
})

test('reversible: dispose removes exactly the nodes this package added', () => {
  const mounted = mountClient({ betterSidebar: true })
  const headChildren = mounted.dom.head.children.length
  assert.equal(headChildren, 1)
  mounted.dispose()
  assert.equal(mounted.dom.head.children.length, 0)
})

// ── isolation ────────────────────────────────────────────────────────────────

test('isolation: a throwing collaborator degrades one seat and leaves the rest armed', () => {
  const mounted = mountClient({ betterSidebar: false })
  try {
    const broken = createBetterSidebarFake()
    broken.registerTab = () => {
      throw new Error('provider exploded')
    }
    mounted.ledger.set('betterSidebar', broken)
    mounted.ledger.settle()
    assert.equal(entryOf(mounted, 'better-sidebar-row').state, 'error')
    assert.match(entryOf(mounted, 'better-sidebar-row').reason, /provider exploded/)
    // Seats that never touched the broken provider are untouched.
    assert.equal(entryOf(mounted, 'official-right-sidebar').state, 'suppressed', 'the policy still holds')
    assert.equal(mounted.slots.occupants('shell.overlay').length, 1)
    assert.equal(mounted.slots.occupants('conversation.session.header.utilities').length, 1)
  } finally {
    mounted.dispose()
  }
})

test('isolation: no slots service at all still publishes the service face and reports', () => {
  const mounted = mountClient({ betterSidebar: false, slots: false, sidebarRightTabs: false, layout: false })
  try {
    const status = mounted.service.status()
    assert.equal(status.package, 'dsh-anagenesis-window')
    assert.equal(status.entries.length, 4)
    for (const row of status.entries) {
      assert.ok(['idle', 'degraded', 'suppressed'].includes(row.state), `${row.seat} must report, not throw`)
    }
  } finally {
    mounted.dispose()
  }
})

// ── observability ────────────────────────────────────────────────────────────

test('observability: every registration, degradation and release is in the log', () => {
  const mounted = mountClient({ betterSidebar: true })
  const types = new Set(mounted.service.log().map((row) => row.type))
  for (const required of ['activated', 'styles.inserted', 'window.seat-registered', 'entry.planned', 'entry.armed', 'entry.suppressed']) {
    assert.ok(types.has(required), `the log is missing "${required}"`)
  }
  const planned = mounted.service.log().find((row) => row.type === 'entry.planned' && row.detail.seat === 'official-right-sidebar')
  assert.ok(planned !== undefined, 'the suppressed seat must be planned, not skipped')
  assert.ok(typeof planned.detail.environment === 'string' && planned.detail.environment.length > 0, 'and it must record the environment it decided on')
  mounted.dispose()
  const after = new Set(mounted.service.log().map((row) => row.type))
  assert.ok(after.has('entry.released') || after.has('teardown'), 'teardown must be observable')
  assert.ok(after.has('styles.removed'))
})

test('observability: the log is bounded and never stores undefined', () => {
  const mounted = mountClient({ betterSidebar: true })
  try {
    for (let index = 0; index < 400; index += 1) mounted.service.configure({ officialEntry: index % 2 === 0 ? 'always' : 'auto' })
    const snapshot = mounted.service.log()
    assert.ok(snapshot.length <= 200, `the ring must be bounded, saw ${snapshot.length}`)
    assert.ok(mounted.service.status().log.dropped >= 1, 'drops must be counted, not silent')
    for (const row of snapshot) {
      assert.equal(JSON.stringify(row).includes('undefined'), false, 'no row may carry undefined through the JSON seam')
    }
  } finally {
    mounted.dispose()
  }
})