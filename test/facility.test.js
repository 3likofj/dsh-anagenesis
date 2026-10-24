/**
 * Facility model suite — the data the operations dashboard draws.
 *
 * The dashboard is a *building* (floors = namespaces, zones = kinds, sensors =
 * records, readings = salience / confidence / freshness, energy vs baseline), so
 * the things worth asserting are the things that would make a floor plan lie:
 * a record counted on the wrong floor, a zone whose share does not add up, an
 * anomaly list that misses the obvious one, a bar compared against a baseline
 * that was invented rather than measured, or a payload the host would reject.
 *
 * This suite tests the model only. Rendering is a total function of it and is
 * covered by the render/style suite in `window/test`.
 * @module dsh-anagenesis/test/facility.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildFacilityModel, FACILITY_VERSION } from '../src/viz/facility.js'
import { losslessIssues } from './lossless.mjs'

const NOW = Date.UTC(2026, 9, 24, 3, 0, 0)
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** @param {Partial<any>} spec */
function record(spec) {
  const scope = spec.scope ?? { tier: 'project', projectId: 'p1_aaa', session: null, preset: null, workspace: 'D:/work/alpha', origin: 'agent', profile: null }
  return {
    id: spec.id ?? 'mem_' + Math.random().toString(36).slice(2, 8),
    kind: spec.kind ?? 'fact',
    state: spec.state ?? 'active',
    subject: spec.subject ?? 'a subject',
    body: 'body',
    gist: spec.subject ?? 'a subject',
    tags: spec.tags ?? [],
    links: spec.links ?? [],
    confidence: spec.confidence ?? 0.6,
    salience: spec.salience ?? 0.5,
    salienceByScope: {},
    scope: scope,
    createdAt: spec.createdAt ?? NOW - 2 * HOUR,
    updatedAt: spec.updatedAt ?? NOW - 2 * HOUR,
    expiresAt: spec.expiresAt ?? null,
    access: { count: spec.accessCount ?? 0, hits: 0, misses: 0, lastAt: null },
    schemaVersion: 7,
  }
}

/** A store with three floors, every lifecycle state and two broken links. */
function fixture() {
  const alpha = { tier: 'project', projectId: 'p1_aaa', session: null, preset: null, workspace: 'D:/work/alpha', origin: 'agent', profile: null }
  const beta = { tier: 'project', projectId: 'p1_bbb', session: null, preset: null, workspace: 'D:/work/beta', origin: 'agent', profile: null }
  const global = { tier: 'global', projectId: null, session: null, preset: null, workspace: null, origin: 'agent', profile: null }
  const session = { tier: 'session', projectId: 'p1_aaa', session: 's1', preset: 'anagenesis', workspace: 'D:/work/alpha', origin: 'agent', profile: null }
  const memories = {}
  const add = (spec) => { const one = record(spec); memories[one.id] = one; return one }
  add({ id: 'mem_a1', kind: 'fact', state: 'active', scope: alpha, salience: 0.8, confidence: 0.9, subject: 'alpha build command' })
  add({ id: 'mem_a2', kind: 'fact', state: 'verified', scope: alpha, salience: 0.6, confidence: 0.8, subject: 'alpha deploy target' })
  add({ id: 'mem_a3', kind: 'constraint', state: 'active', scope: alpha, salience: 0.5, confidence: 0.7, subject: 'never edit generated files' })
  add({ id: 'mem_a4', kind: 'constraint', state: 'expired', scope: alpha, subject: 'old constraint' })
  add({ id: 'mem_b1', kind: 'preference', state: 'active', scope: beta, salience: 0.4, confidence: 0.5, subject: 'beta prefers tabs' })
  add({ id: 'mem_g1', kind: 'procedure', state: 'locked', scope: global, salience: 0.9, confidence: 0.95, subject: 'release checklist' })
  add({ id: 'mem_s1', kind: 'episode', state: 'draft', scope: session, salience: 0.3, confidence: 0.2, subject: 'session note' })
  add({
    id: 'mem_a5',
    kind: 'hypothesis',
    state: 'active',
    scope: alpha,
    salience: 0.85,
    confidence: 0.55,
    subject: 'loud and stale',
    updatedAt: NOW - 40 * DAY,
    links: [{ rel: 'contradicts', to: 'mem_a1' }, { rel: 'supports', to: 'mem_missing' }],
  })
  add({ id: 'mem_a6', kind: 'failure', state: 'active', scope: alpha, subject: 'expires tonight', expiresAt: NOW + 3 * HOUR })
  return {
    state: {
      schemaVersion: 7,
      version: 41,
      memories: memories,
      projects: { p1_aaa: { id: 'p1_aaa', label: 'alpha', kind: 'repo', root: 'D:/work/alpha', remote: 'github:3likofj/alpha' } },
      stacks: { global: ['guard', 'exploit'], 'session:s1': ['guard', 'explore'] },
      params: { global: {} },
      safeMode: false,
    },
    events: [
      { seq: 41, type: 'memory.remember', ts: NOW - 60_000 },
      { seq: 40, type: 'strategy.setStack', ts: NOW - 5 * 60_000 },
      { seq: 39, type: 'memory.promote', ts: NOW - 9 * 60_000 },
    ],
    permissions: { gear: 'assisted', presetActive: true, mirror: false },
    origin: 'mirror',
  }
}

const model = (opts) => buildFacilityModel(fixture(), Object.assign({ now: NOW }, opts))

test('facility: every record lands on exactly one floor, and the floors are ordered', () => {
  const built = model()
  const floors = built.floors
  assert.deepEqual(floors.map((floor) => floor.id), ['project:p1_aaa', 'project:p1_bbb', 'global', 'session:s1'])
  const landed = floors.reduce((sum, floor) => sum + floor.count, 0)
  assert.equal(landed, 9, 'every record is counted once')
  assert.equal(built.building.records, 9)
  assert.equal(built.building.namespaces, 4)
  assert.equal(built.floors[0].label, 'alpha', 'a project floor is labelled by its registered project label')
  assert.equal(built.floors[2].label, 'global')
  assert.equal(built.floors[3].label, 's1', 'a session floor is labelled by its session id')
})

test('facility: zone shares add up inside a floor, and empty zones are not drawn', () => {
  const floor = model().floors[0]
  const share = floor.zones.reduce((sum, zone) => sum + zone.share, 0)
  assert.ok(Math.abs(share - 1) < 1e-9, 'zone shares fill their floor exactly (got ' + share + ')')
  assert.deepEqual(floor.zones.map((zone) => zone.kind).sort(), ['constraint', 'fact', 'failure', 'hypothesis'])
  for (const zone of floor.zones) assert.ok(zone.count > 0, 'no empty zone is drawn')
})

test('facility: live membership drives the readings, not the raw count', () => {
  const alpha = model().floors[0]
  const fact = alpha.zones.find((zone) => zone.kind === 'fact')
  assert.equal(fact.count, 2)
  assert.equal(fact.live, 2)
  const constraint = alpha.zones.find((zone) => zone.kind === 'constraint')
  assert.equal(constraint.count, 2, 'the expired record is still on the floor')
  assert.equal(constraint.live, 1, 'but it is not a live sensor')
  assert.equal(constraint.salience, 0.5, 'readings average live records only')
  assert.equal(built_metric('live'), 8, 'eight records are live across the building (the expired one is not)')
})

/** @param {string} key */
function built_metric(key) {
  return model().metrics[key]
}

test('facility: energy is measured against the building baseline, never invented', () => {
  const built = model()
  const zones = built.floors.flatMap((floor) => floor.zones).filter((zone) => zone.live > 0)
  const ratios = zones.map((zone) => zone.energyRatio)
  assert.ok(ratios.every((ratio) => ratio >= 0), 'a ratio is never negative')
  // The global floor holds one locked, loud record; it must read above the
  // building average, and a quiet zone must read below it.
  const globalZone = built.floors[2].zones[0]
  assert.ok(globalZone.energyRatio > 1, 'the loudest zone reads above baseline (' + globalZone.energyRatio + ')')
  const sessionZone = built.floors[3].zones[0]
  assert.ok(sessionZone.energyRatio < 1, 'the quietest zone reads below baseline (' + sessionZone.energyRatio + ')')
  assert.ok(built.baseline.energyPerRecord > 0)
  assert.equal(built.baseline.liveRecords, built.metrics.live)
})

test('facility: sensors are the loudest live records, capped, and never a retired one', () => {
  const built = model({ limit: { sensors: 3 } })
  assert.equal(built.sensors.length, 3)
  const weights = built.sensors.map((sensor) => sensor.salience * sensor.confidence)
  for (let index = 1; index < weights.length; index += 1) {
    assert.ok(weights[index - 1] >= weights[index], 'sensors are ordered loudest first')
  }
  assert.ok(built.sensors.every((sensor) => sensor.state !== 'expired'), 'an expired record is not a sensor')
  assert.equal(built.sensors[0].id, 'mem_g1', 'the locked, most-believed record is the loudest sensor')
  assert.equal(typeof built.sensors[0].expiresInHours, 'object', 'a missing TTL is null, not undefined')
})

test('facility: the anomaly list names what an operator must know, and nothing else', () => {
  const built = model()
  const codes = built.anomalies.map((item) => item.code)
  assert.ok(codes.includes('contradiction'), 'a contradicting link is an alert')
  assert.ok(codes.includes('expiring'), 'a record that expires tonight is a warning')
  assert.ok(codes.includes('stale-hot'), 'a loud but 40-day-old record is a warning')
  assert.ok(codes.includes('orphan-link'), 'a link to a missing record is a warning')
  assert.ok(codes.includes('locked'), 'a pinned record is reported, at info level')
  assert.ok(!codes.includes('safe-mode'), 'safe mode is off, so it is not reported')
  assert.ok(!codes.includes('empty'), 'a store with records is not "empty"')
  const levels = new Set(built.anomalies.map((item) => item.level))
  for (const level of levels) assert.ok(['alert', 'warn', 'info'].includes(level))
})

test('facility: safe mode and an unredacted screen are the two loudest facts', () => {
  const source = fixture()
  source.state.safeMode = true
  const built = buildFacilityModel(source, { now: NOW, redaction: 'none' })
  const alert = built.anomalies.filter((item) => item.level === 'alert').map((item) => item.code)
  assert.ok(alert.includes('safe-mode'))
  assert.ok(alert.includes('unredacted'))
  assert.equal(built.building.safeMode, true)
})

test('facility: the ticker is the newest journal window, bounded and ordered', () => {
  const built = model({ limit: { events: 2 } })
  assert.equal(built.ticker.length, 2)
  assert.deepEqual(built.ticker.map((item) => item.seq), [41, 40], 'newest first, like the store reports')
  assert.ok(built.ticker[0].ageMs <= built.ticker[1].ageMs, 'ages grow with the sequence')
})

test('facility: redaction happens before transport, and strict masks every label', () => {
  const source = fixture()
  source.state.memories.mem_a1.subject = 'token ghp_' + 'a'.repeat(30)
  const scrubbed = buildFacilityModel(source, { now: NOW, redaction: 'secrets' })
  assert.ok(!JSON.stringify(scrubbed.sensors).includes('ghp_'), 'a credential never reaches the client')
  const strict = buildFacilityModel(source, { now: NOW, redaction: 'strict' })
  assert.ok(strict.sensors.every((sensor) => sensor.label.startsWith('[redacted')), 'strict masks labels')
  assert.equal(strict.redaction.level, 'strict')
})

test('facility: the model is a pure projection — lossless JSON, and the source is untouched', () => {
  const source = fixture()
  const before = JSON.stringify(source)
  const built = buildFacilityModel(source, { now: NOW })
  assert.deepEqual(losslessIssues(built), [], 'the host rejects a payload that does not round-trip')
  assert.equal(JSON.stringify(source), before, 'reading a store never changes it')
  const again = buildFacilityModel(source, { now: NOW })
  assert.deepEqual(again, built, 'the same source and clock produce the same bytes')
  assert.equal(built.version, FACILITY_VERSION)
})

test('facility: an empty store is an ANSWER, not an error', () => {
  const built = buildFacilityModel({ state: { schemaVersion: 7, version: 0, memories: {}, projects: {}, stacks: {} }, events: [] }, { now: NOW })
  assert.deepEqual(built.floors, [])
  assert.deepEqual(built.sensors, [])
  assert.ok(built.anomalies.some((item) => item.code === 'empty'))
  assert.equal(built.baseline.energyPerRecord, 0)
  assert.deepEqual(losslessIssues(built), [])
})

test('facility: a floor cap is declared, so the renderer can say what it hid', () => {
  const built = model({ limit: { floors: 2 } })
  assert.equal(built.floors.length, 2)
  assert.equal(built.building.floors, 4)
  assert.equal(built.building.floorsShown, 2)
})
