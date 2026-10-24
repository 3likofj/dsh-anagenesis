/**
 * Facility model — the structured projection behind the operations dashboard.
 *
 * The dashboard the window draws (icon rail / floorplan / zone detail / status
 * bars) is a *building*: the store is the building, a namespace is a floor, a
 * memory kind is a zone on that floor, and a record is a sensor reading inside a
 * zone. That metaphor is not decoration — it is the only arrangement in which
 * every number on screen has one owner:
 *
 *   floor     = namespace (`project:<fingerprint>` / `global` / `session:<id>`)
 *   zone      = memory kind (fact / preference / … / failure)
 *   sensor    = one live record, positioned by kind, coloured by lifecycle state
 *   reading   = salience (how loud) · confidence (how sure) · freshness (how old)
 *   baseline  = the store-wide mean energy per live record: "is this zone louder
 *               than the building average?", never an invented target
 *
 * Like every other model in this directory this module **renders nothing** and
 * **writes nothing**: it is a pure function of a read-only mirror. Everything it
 * emits is plain JSON with no `undefined` (the host rejects a payload that does
 * not survive a JSON round trip), so the client can be a total renderer of it.
 * @module dsh-anagenesis/viz/facility
 */

import { KINDS, LIVE_STATES, effectiveSalience } from '../store/schema.js'
import { namespaceCounts, namespaceOf, parseNamespace, projectLabel } from '../scope/index.js'
import { DEFAULT_REDACTION, redactRecord, redactionNote } from './redact.js'

/** Bumped when the shape changes in a way a renderer must notice. */
export const FACILITY_VERSION = 1

/** Floor order: the project you are standing in first, then shared, then sessions. */
const TIER_RANK = Object.freeze({ project: 0, global: 1, session: 2 })

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** States that can be injected — the ones a floor plan should count as members. */
const LIVE = new Set(LIVE_STATES)

/** A record's live flag, tolerant of a pre-v7 record that never got a scope. */
function isLive(record) {
  return LIVE.has(String(record?.state ?? ''))
}

/**
 * 版本更新状态。来源是 `service.updateStatus()` —— 这里**只做形状归一化**：
 * 没有服务、只读镜像、老宿主都变成"没检查过"，而不是编一个版本号出来。
 * @param {any} raw
 * @returns {{ enabled: boolean, mode: string, current: string, latest: string, available: boolean, checkedAt: number, error: string }}
 */
function normalizeUpdate(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: value.enabled === true,
    mode: String(value.mode ?? 'off'),
    current: String(value.current ?? ''),
    latest: String(value.latest ?? ''),
    available: value.available === true,
    checkedAt: num(value.checkedAt ?? 0),
    error: String(value.error ?? ''),
  }
}

/** @param {unknown} value @returns {number} */
function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** @param {number} value @param {number} digits @returns {number} */
function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(num(value) * factor) / factor
}

/** @param {number} a @param {number} b @returns {number} */
function mean(values) {
  if (values.length === 0) return 0
  let sum = 0
  for (const value of values) sum += num(value)
  return sum / values.length
}

/**
 * The floor label a namespace gets on the plan.
 * @param {any} state @param {string} namespace @returns {{ id: string, label: string, detail: string, tier: string }}
 */
function floorIdentity(state, namespace) {
  const parsed = parseNamespace(namespace)
  const tier = String(parsed?.tier ?? 'global')
  if (tier === 'project') {
    const key = String(parsed?.key ?? '')
    const label = projectLabel(state, key)
    return { id: namespace, label: label === '' ? key : label, detail: key, tier }
  }
  if (tier === 'session') {
    const key = String(parsed?.key ?? '')
    return { id: namespace, label: key === '' ? namespace : key, detail: namespace, tier }
  }
  return { id: namespace, label: 'global', detail: namespace, tier: 'global' }
}

/**
 * One zone on one floor.
 * @param {string} floor
 * @param {string} kind
 * @param {any[]} records
 * @param {number} now
 * @returns {any}
 */
function zoneOf(floor, kind, records, now) {
  const live = records.filter(isLive)
  const salience = live.map((record) => effectiveSalience(record, floor))
  const confidence = live.map((record) => num(record?.confidence))
  const ages = live.map((record) => Math.max(0, now - num(record?.updatedAt ?? record?.createdAt)))
  // Energy: a record is "loud" when it is both salient and believed. Summing the
  // product (not the average) is what makes a crowded, loud zone read as loud —
  // which is the comparison the bars are for.
  let energy = 0
  for (let index = 0; index < live.length; index += 1) energy += salience[index] * confidence[index]
  const states = {}
  for (const record of records) {
    const key = String(record?.state ?? 'unknown')
    states[key] = (states[key] ?? 0) + 1
  }
  let topState = 'unknown'
  let topCount = -1
  for (const key of Object.keys(states)) {
    if (states[key] > topCount) {
      topCount = states[key]
      topState = key
    }
  }
  return {
    id: floor + '/' + kind,
    floor: floor,
    kind: kind,
    count: records.length,
    live: live.length,
    states: states,
    topState: topState,
    share: 0,
    salience: round(mean(salience)),
    confidence: round(mean(confidence)),
    freshnessHours: round(ages.length === 0 ? 0 : mean(ages) / HOUR, 1),
    energy: round(energy),
    energyRatio: 0,
    sensorIds: live
      .map((record) => ({ id: String(record?.id ?? ''), weight: effectiveSalience(record, floor) * num(record?.confidence) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 6)
      .map((entry) => entry.id),
  }
}

/**
 * Build the facility model.
 *
 * @param {{ state?: any, events?: any[], permissions?: any, scope?: any, origin?: string }} source
 *   a read-only mirror (`readStoreMirror()`) — never a live store handle
 * @param {{ now?: number, redaction?: string, includeBody?: boolean,
 *   limit?: { sensors?: number, events?: number, anomalies?: number, floors?: number } }} [opts]
 * @returns {any} plain JSON
 */
export function buildFacilityModel(source, opts = {}) {
  const now = num(opts.now ?? Date.now())
  const redaction = typeof opts.redaction === 'string' ? opts.redaction : DEFAULT_REDACTION
  const includeBody = opts.includeBody === true
  const limit = {
    sensors: Math.max(1, Math.min(200, Math.round(num(opts.limit?.sensors ?? 24)))),
    events: Math.max(1, Math.min(200, Math.round(num(opts.limit?.events ?? 10)))),
    anomalies: Math.max(1, Math.min(50, Math.round(num(opts.limit?.anomalies ?? 8)))),
    floors: Math.max(1, Math.min(20, Math.round(num(opts.limit?.floors ?? 6)))),
  }
  const state = source?.state ?? {}
  const records = Object.values(state.memories ?? {})
  const events = Array.isArray(source?.events) ? source.events : []

  // ── floors & zones ────────────────────────────────────────────────────────
  /** @type {Map<string, any[]>} */
  const byFloor = new Map()
  for (const record of records) {
    const namespace = /** @type {any} */ (record)?.scope?.tier === undefined
      ? 'global'
      : namespaceOf(/** @type {any} */ (record).scope)
    const bucket = byFloor.get(namespace)
    if (bucket === undefined) byFloor.set(namespace, [record])
    else bucket.push(record)
  }

  const floors = []
  let totalEnergy = 0
  let totalLive = 0
  for (const [namespace, list] of byFloor.entries()) {
    const identity = floorIdentity(state, namespace)
    const zones = []
    for (const kind of KINDS) {
      const inZone = list.filter((record) => String(record?.kind ?? '') === kind)
      if (inZone.length === 0) continue
      const zone = zoneOf(namespace, kind, inZone, now)
      totalEnergy += zone.energy
      totalLive += zone.live
      zones.push(zone)
    }
    zones.sort((a, b) => b.live - a.live || b.count - a.count || a.kind.localeCompare(b.kind))
    const floorStates = {}
    for (const record of list) {
      const key = String(record?.state ?? 'unknown')
      floorStates[key] = (floorStates[key] ?? 0) + 1
    }
    floors.push({
      id: namespace,
      label: identity.label,
      detail: identity.detail,
      tier: identity.tier,
      count: list.length,
      live: list.filter(isLive).length,
      states: floorStates,
      share: 0,
      zones: zones,
      lastAt: Math.max(0, ...list.map((record) => num(record?.updatedAt ?? record?.createdAt))),
    })
  }
  floors.sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || b.count - a.count)
  const floorsShown = floors.slice(0, limit.floors)
  const totalRecords = records.length
  for (const floor of floorsShown) floor.share = totalRecords === 0 ? 0 : round(floor.count / totalRecords)
  for (const floor of floorsShown) {
    for (const zone of floor.zones) {
      zone.share = floor.count === 0 ? 0 : round(zone.count / floor.count)
    }
  }

  // ── the baseline the energy bars are compared against ─────────────────────
  const energyPerRecord = totalLive === 0 ? 0 : totalEnergy / totalLive
  for (const floor of floorsShown) {
    for (const zone of floor.zones) {
      const perRecord = zone.live === 0 ? 0 : zone.energy / zone.live
      zone.energyRatio = energyPerRecord === 0 ? 0 : round(perRecord / energyPerRecord, 2)
    }
  }

  // ── sensors (individual records, loudest first) ───────────────────────────
  const liveRecords = records.filter(isLive)
  const ranked = liveRecords
    .map((record) => ({ record, weight: effectiveSalience(record, 'global') * num(record?.confidence) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit.sensors)
  const sensors = ranked.map(({ record }) => {
    const projected = redactRecord(record, { level: redaction, includeBody: includeBody })
    const expiresAt = record?.expiresAt === null || record?.expiresAt === undefined ? null : num(record.expiresAt)
    return {
      id: String(record?.id ?? ''),
      label: String(projected.label ?? ''),
      gist: String(projected.gist ?? ''),
      bodyPreview: String(projected.bodyPreview ?? ''),
      kind: String(record?.kind ?? 'unknown'),
      state: String(record?.state ?? 'unknown'),
      tier: String(record?.scope?.tier ?? 'global'),
      namespace: record?.scope?.tier === undefined ? 'global' : namespaceOf(record?.scope),
      salience: round(num(effectiveSalience(record, 'global'))),
      confidence: round(num(record?.confidence)),
      accessCount: num(record?.access?.count),
      ageHours: round(Math.max(0, now - num(record?.updatedAt ?? record?.createdAt)) / HOUR, 1),
      expiresInHours: expiresAt === null ? null : round((expiresAt - now) / HOUR, 1),
      links: Array.isArray(record?.links) ? record.links.length : 0,
      tags: Array.isArray(record?.tags) ? record.tags.slice(0, 6).map((tag) => String(tag)) : [],
      redacted: projected.redacted === true,
    }
  })

  // ── anomalies: things an operator would want to know right now ────────────
  const known = new Set(records.map((record) => String(record?.id ?? '')))
  let orphanLinks = 0
  let conflicts = 0
  for (const record of records) {
    for (const link of Array.isArray(record?.links) ? record.links : []) {
      if (!known.has(String(link?.to ?? ''))) orphanLinks += 1
      if (String(link?.rel ?? '') === 'contradicts') conflicts += 1
    }
  }
  const expiringSoon = liveRecords.filter((record) => {
    const expiresAt = record?.expiresAt
    return expiresAt !== null && expiresAt !== undefined && num(expiresAt) - now <= DAY
  })
  const staleHot = liveRecords.filter((record) => (
    effectiveSalience(record, 'global') >= 0.7
    && now - num(record?.updatedAt ?? record?.createdAt) > 30 * DAY
  ))
  const locked = records.filter((record) => String(record?.state ?? '') === 'locked')

  const update = normalizeUpdate(source?.update)

  const anomalies = []
  // 更新是**运维层**的事：它不改变任何一条记忆，所以放在告警列表最前面，
  // 而且要人能一眼看到"这条不是存储出问题了"。
  if (update.available) {
    anomalies.push({
      code: 'update-available',
      level: 'warn',
      count: 1,
      title: 'update available: v' + update.latest,
      detail: 'a newer dsh-anagenesis is published; this plugin never installs anything by itself',
      ref: update.latest,
      ageHours: 0,
    })
  }
  if (state.safeMode === true) {
    anomalies.push({
      code: 'safe-mode',
      level: 'alert',
      count: 1,
      title: 'safety brake engaged',
      detail: 'strategy switching and self-tuning are frozen; memories still work',
      ref: '',
      ageHours: 0,
    })
  }
  if (conflicts > 0) {
    anomalies.push({
      code: 'contradiction',
      level: 'alert',
      count: conflicts,
      title: conflicts + ' contradicting link(s)',
      detail: 'two records disagree and both are live — resolve before trusting either',
      ref: '',
      ageHours: 0,
    })
  }
  if (expiringSoon.length > 0) {
    const soonest = expiringSoon.reduce((best, record) => (num(record.expiresAt) < num(best.expiresAt) ? record : best), expiringSoon[0])
    anomalies.push({
      code: 'expiring',
      level: 'warn',
      count: expiringSoon.length,
      title: expiringSoon.length + ' record(s) expire within 24h',
      detail: 'soonest: ' + String(soonest?.subject ?? soonest?.id ?? ''),
      ref: String(soonest?.id ?? ''),
      ageHours: round(((num(soonest?.expiresAt) - now) / HOUR), 1),
    })
  }
  if (staleHot.length > 0) {
    anomalies.push({
      code: 'stale-hot',
      level: 'warn',
      count: staleHot.length,
      title: staleHot.length + ' loud but stale record(s)',
      detail: 'high salience, untouched for over 30 days — verify before relying on it',
      ref: String(staleHot[0]?.id ?? ''),
      ageHours: round((now - num(staleHot[0]?.updatedAt)) / HOUR, 1),
    })
  }
  if (orphanLinks > 0) {
    anomalies.push({
      code: 'orphan-link',
      level: 'warn',
      count: orphanLinks,
      title: orphanLinks + ' link(s) point at missing records',
      detail: 'the target was forgotten or never existed; the graph will show a dangling edge',
      ref: '',
      ageHours: 0,
    })
  }
  if (locked.length > 0) {
    anomalies.push({
      code: 'locked',
      level: 'info',
      count: locked.length,
      title: locked.length + ' pinned record(s)',
      detail: 'locked records never decay and need a reason plus force to leave their state',
      ref: String(locked[0]?.id ?? ''),
      ageHours: 0,
    })
  }
  if (source?.permissions?.gear === 'none' && source?.permissions?.mirror !== true) {
    anomalies.push({
      code: 'read-only',
      level: 'info',
      count: 1,
      title: 'read-only tier',
      detail: 'no preset grant is active, so the write tools do not exist for the model',
      ref: '',
      ageHours: 0,
    })
  }
  if (redaction === 'none') {
    anomalies.push({
      code: 'unredacted',
      level: 'alert',
      count: 1,
      title: 'redaction is off',
      detail: 'this screen may contain credentials — do not screenshot it',
      ref: '',
      ageHours: 0,
    })
  }
  if (records.length === 0) {
    anomalies.push({
      code: 'empty',
      level: 'info',
      count: 0,
      title: 'no memories yet',
      detail: 'the store is healthy but empty — the first write creates the first floor',
      ref: '',
      ageHours: 0,
    })
  }

  // ── ticker: the newest journal events, as a live wire ─────────────────────
  const ticker = events.slice(0, limit.events).map((event) => ({
    seq: num(event?.seq),
    type: String(event?.type ?? 'unknown'),
    ageMs: Math.max(0, now - num(event?.ts ?? now)),
  }))

  const states = {}
  for (const record of records) {
    const key = String(record?.state ?? 'unknown')
    states[key] = (states[key] ?? 0) + 1
  }
  const kinds = {}
  for (const record of records) {
    const key = String(record?.kind ?? 'unknown')
    kinds[key] = (kinds[key] ?? 0) + 1
  }
  const namespaces = namespaceCounts(state)
  const stacks = []
  for (const scope of Object.keys(state.stacks ?? {}).sort()) {
    stacks.push({ scope: scope, stack: (state.stacks[scope] ?? []).map((name) => String(name)) })
  }

  return {
    kind: 'facility',
    version: FACILITY_VERSION,
    generatedAt: now,
    origin: String(source?.origin ?? 'mirror'),
    redaction: { level: redaction, note: redactionNote(redaction, { includeBody: includeBody }) },
    building: {
      // 版本更新：窗口顶条据此显示"有新版本"的牌子。它属于"这栋楼现在跑的软件"，
      // 不属于楼里的任何一层，所以住在 building 上。
      update: update,
      storeVersion: num(state.version),
      schemaVersion: num(state.schemaVersion),
      safeMode: state.safeMode === true,
      records: totalRecords,
      live: liveRecords.length,
      namespaces: Object.keys(namespaces.byNamespace ?? {}).length,
      projects: Object.keys(state.projects ?? {}).length,
      floors: floors.length,
      floorsShown: floorsShown.length,
      stacks: stacks,
      gear: String(source?.permissions?.gear ?? 'unknown'),
      mirror: source?.permissions?.mirror !== false,
    },
    metrics: {
      records: totalRecords,
      live: liveRecords.length,
      states: states,
      kinds: kinds,
      salience: round(mean(liveRecords.map((record) => effectiveSalience(record, 'global')))),
      confidence: round(mean(liveRecords.map((record) => num(record?.confidence)))),
      links: records.reduce((sum, record) => sum + (Array.isArray(record?.links) ? record.links.length : 0), 0),
      orphanLinks: orphanLinks,
      expiringSoon: expiringSoon.length,
      staleHot: staleHot.length,
      conflicts: conflicts,
      locked: locked.length,
      retired: num(states.retired),
      events: events.length,
    },
    baseline: { energyPerRecord: round(energyPerRecord), liveRecords: totalLive },
    floors: floorsShown,
    sensors: sensors,
    anomalies: anomalies.slice(0, limit.anomalies),
    anomaliesTotal: anomalies.length,
    ticker: ticker,
    limit: limit,
  }
}
