/**
 * 版本更新检查 —— 这个插件唯一的网络出口。
 *
 * 这一组测试守的是"它到底会不会偷偷做事"：
 *   1. 版本比较是纯函数，预发布版本的优先级按 semver 来（`0.3.1-rc.1 < 0.3.1`）；
 *   2. `off` 模式下**一次网络都不发**（不是"发了但忽略"）；
 *   3. 缓存按间隔走、并发调用只打一次；`force` 才有权越线；
 *   4. 失败是一种状态（`error` 里有原因），不是异常，也不会把插件拖下水；
 *   5. `status()` 永远同步、永远无损 JSON（宿主会拒绝带 `undefined` 的载荷）；
 *   6. 模型层把这块如实投影：没检查过就说没检查过，不编版本号。
 * @module dsh-anagenesis/test/update
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DEFAULT_INTERVAL_MS, UPDATE_MODES, compareVersions, createUpdateChecker, isNewer, parseVersion, readOwnVersion,
} from '../src/update/check.js'
import { buildDashboardModel } from '../src/viz/model.js'
import { buildFacilityModel } from '../src/viz/facility.js'
import { emptyState } from '../src/store/schema.js'

/** 一份最小、可复现的 registry 应答。 */
function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  impl.calls = calls
  return impl
}

const okResponse = (version) => ({
  ok: true,
  status: 200,
  json: async () => ({ name: 'dsh-anagenesis', version }),
})

test('update: semver precedence, including prereleases and build metadata', () => {
  assert.deepEqual(parseVersion('0.3.1'), { major: 0, minor: 3, patch: 1, pre: [] })
  assert.deepEqual(parseVersion('1.2.3-rc.2'), { major: 1, minor: 2, patch: 3, pre: ['rc', 2] })
  assert.equal(parseVersion('not-a-version'), null)
  assert.equal(parseVersion(''), null)
  assert.equal(parseVersion(undefined), null)

  assert.equal(compareVersions('0.3.0', '0.3.0'), 0)
  assert.equal(compareVersions('0.3.1', '0.3.0'), 1)
  assert.equal(compareVersions('0.4.0', '0.10.0'), -1, 'numeric, not lexicographic')
  // 预发布低于同号正式版
  assert.equal(compareVersions('0.3.1', '0.3.1-rc.1'), 1)
  assert.equal(compareVersions('0.3.1-rc.2', '0.3.1-rc.1'), 1)
  assert.equal(compareVersions('0.3.1-rc.1', '0.3.1-rc.2'), -1)
  assert.equal(compareVersions('0.3.1-rc.10', '0.3.1-rc.9'), 1, 'numeric identifiers compare as numbers')
  assert.equal(compareVersions('0.3.1-alpha', '0.3.1-beta'), -1, 'alphanumeric identifiers compare lexically')
  // 构建元数据不参与比较
  assert.equal(compareVersions('0.3.1+build.9', '0.3.1'), 0)

  assert.equal(isNewer('0.3.2', '0.3.1'), true)
  assert.equal(isNewer('0.3.1', '0.3.1'), false)
  assert.equal(isNewer('0.3.0', '0.3.1'), false)
  // 预发布只输在**同一个**基线版本上：0.3.2-rc.1 仍然比 0.3.1 新（patch 更大）。
  assert.equal(isNewer('0.3.1', '0.3.2-rc.1'), false)
  assert.equal(isNewer('0.3.2-rc.1', '0.3.1'), true)
  assert.equal(isNewer('0.3.2-rc.1', '0.3.1'), true)
  assert.equal(isNewer('0.3.1-rc.1', '0.3.1'), false, 'a prerelease of the same version is not an update')
  assert.equal(isNewer('garbage', '0.3.1'), false, 'an unparseable version never nags')
})

test('update: off means zero network — not networked-but-ignored', async () => {
  const fetchImpl = fakeFetch(async () => okResponse('9.9.9'))
  const checker = createUpdateChecker({ mode: 'off', current: '0.3.1', fetchImpl })
  const status = await checker.check({ force: true })
  assert.equal(fetchImpl.calls.length, 0, 'off must not call fetch at all')
  assert.equal(status.enabled, false)
  assert.equal(status.available, false)
  assert.equal(status.latest, '')
  const dispose = checker.start()
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(fetchImpl.calls.length, 0, 'start() must not schedule anything when off')
})

test('update: one GET to the registry, and it says a newer version is available', async () => {
  const fetchImpl = fakeFetch(async () => okResponse('0.4.0'))
  const checker = createUpdateChecker({ mode: 'npm', current: '0.3.1', fetchImpl, now: () => 1_000 })
  const status = await checker.check()
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].url, 'https://registry.npmjs.org/dsh-anagenesis/latest')
  assert.equal(fetchImpl.calls[0].init.method, 'GET')
  assert.equal(fetchImpl.calls[0].init.headers.accept, 'application/json')
  assert.equal(status.available, true)
  assert.equal(status.latest, '0.4.0')
  assert.equal(status.current, '0.3.1')
  assert.equal(status.checkedAt, 1_000)
  assert.equal(status.error, '')
  assert.equal(status.nextCheckAt, 1_000 + DEFAULT_INTERVAL_MS)
})

test('update: the cache is the interval — a second call inside it does not hit the network', async () => {
  let clock = 1_000
  const fetchImpl = fakeFetch(async () => okResponse('0.4.0'))
  const checker = createUpdateChecker({ mode: 'npm', current: '0.3.1', fetchImpl, intervalMs: 60_000, now: () => clock })
  await checker.check()
  clock += 30_000
  await checker.check()
  assert.equal(fetchImpl.calls.length, 1, 'inside the interval the answer is served from the cache')
  clock += 40_000
  await checker.check()
  assert.equal(fetchImpl.calls.length, 2, 'past the interval it asks again')
  await checker.check({ force: true })
  assert.equal(fetchImpl.calls.length, 3, 'force overrides the cache')
})

test('update: concurrent checks share one request', async () => {
  let resolve
  const gate = new Promise((done) => { resolve = done })
  const fetchImpl = fakeFetch(async () => { await gate; return okResponse('0.4.0') })
  const checker = createUpdateChecker({ mode: 'npm', current: '0.3.1', fetchImpl })
  const first = checker.check()
  const second = checker.check()
  const third = checker.check({ force: true })
  resolve()
  await Promise.all([first, second, third])
  assert.equal(fetchImpl.calls.length, 1, 'in-flight calls join, they do not stack')
})

test('update: a failing registry is a state, not a crash', async () => {
  const failing = fakeFetch(async () => ({ ok: false, status: 429, json: async () => ({}) }))
  const checker = createUpdateChecker({ mode: 'npm', current: '0.3.1', fetchImpl: failing, now: () => 5_000 })
  const status = await checker.check()
  assert.equal(status.available, false)
  assert.match(status.error, /429/)
  assert.equal(status.checkedAt, 5_000, 'a failure still counts as "checked", so it is not retried in a loop')

  const garbage = fakeFetch(async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }))
  const second = await createUpdateChecker({ mode: 'npm', current: '0.3.1', fetchImpl: garbage }).check()
  assert.match(second.error, /usable version/)

  const throwing = fakeFetch(async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org') })
  const third = await createUpdateChecker({ mode: 'npm', current: '0.3.1', fetchImpl: throwing }).check()
  assert.match(third.error, /ENOTFOUND/)
})

test('update: the status payload is synchronous and lossless (no undefined across the host seam)', async () => {
  const checker = createUpdateChecker({ mode: 'npm', current: '0.3.1', fetchImpl: fakeFetch(async () => okResponse('0.4.0')) })
  const before = checker.status()
  assert.equal(before.checked, false)
  assert.equal(before.latest, '')
  assert.equal(typeof before.nextCheckAt, 'number')
  await checker.check()
  for (const payload of [before, checker.status()]) {
    assert.equal(JSON.stringify(payload).includes('undefined'), false)
    for (const key of ['kind', 'version', 'mode', 'enabled', 'package', 'registry', 'current', 'latest',
      'available', 'checked', 'checkedAt', 'error', 'nextCheckAt']) {
      assert.ok(key in payload, `status() must always carry "${key}"`)
    }
  }
})

test('update: readOwnVersion is package.json — one source of truth', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(readOwnVersion(), manifest.version)
  assert.ok(UPDATE_MODES.includes('off') && UPDATE_MODES.includes('npm'))
})

// ── the projections ─────────────────────────────────────────────────────────

const updateStatus = (over) => ({
  kind: 'update', version: 1, mode: 'npm', enabled: true, package: 'dsh-anagenesis',
  registry: 'https://registry.npmjs.org', current: '0.3.1', latest: '0.4.0',
  available: true, checked: true, checkedAt: 1_700_000_000_000, error: '', nextCheckAt: 1_700_021_600_000,
  ...over,
})

test('update: the dashboard projection has a row for every state, in both languages', () => {
  const base = { state: emptyState(), events: [] }
  const ids = (model) => model.sections.map((section) => section.id)
  const rows = (model) => model.sections[0].rows.map((row) => `${row.label}=${row.value}`).join(' | ')

  const available = buildDashboardModel({ ...base, update: updateStatus() }, { sections: ['update'], now: 1_700_000_000_000 })
  assert.deepEqual(ids(available), ['update'])
  assert.equal(available.sections[0].title, 'update')
  assert.match(rows(available), /current version=0\.3\.1/)
  assert.match(rows(available), /latest version=0\.4\.0/)
  assert.match(rows(available), /update=v0\.4\.0 is available/)
  assert.equal(available.sections[0].rows[2].tone, 'warn')

  const zh = buildDashboardModel({ ...base, update: updateStatus() }, { sections: ['update'], lang: 'zh' })
  assert.equal(zh.sections[0].title, '版本更新')
  assert.match(rows(zh), /有新版本 v0\.4\.0/)

  const off = buildDashboardModel({ ...base, update: updateStatus({ enabled: false, mode: 'off', available: false, latest: '', checked: false, checkedAt: 0 }) }, { sections: ['update'] })
  assert.match(rows(off), /check disabled \(offline\)/)
  assert.equal(off.sections[0].rows[2].tone, 'dim')

  const failed = buildDashboardModel({ ...base, update: updateStatus({ available: false, error: 'HTTP 503' }) }, { sections: ['update'] })
  assert.match(rows(failed), /check failed: HTTP 503/)
  assert.equal(failed.sections[0].rows[2].tone, 'bad')

  // 默认分区表**不含** update：`ana_dashboard` 的文本帧必须与窗口 /frame 逐字节相同。
  const normal = buildDashboardModel(base, {})
  assert.equal(ids(normal).includes('update'), false, 'update is opt-in, never in the default frame')
})

test('update: the facility projection carries it on the building, and only nags when there is news', () => {
  const state = emptyState()
  const withNews = buildFacilityModel({ state: state, events: [], update: updateStatus() }, { now: 1_700_000_000_000 })
  assert.equal(withNews.building.update.available, true)
  assert.equal(withNews.building.update.latest, '0.4.0')
  assert.equal(withNews.building.update.current, '0.3.1')
  const codes = withNews.anomalies.map((item) => item.code)
  assert.equal(codes.includes('update-available'), true, 'the operator must see it in the anomaly desk')
  assert.equal(withNews.anomalies.find((item) => item.code === 'update-available').ref, '0.4.0')

  const upToDate = buildFacilityModel({ state, events: [], update: updateStatus({ available: false, latest: '0.3.1' }) }, {})
  assert.equal(upToDate.building.update.available, false)
  assert.equal(upToDate.anomalies.some((item) => item.code === 'update-available'), false, 'no nagging when up to date')

  // 没有服务（只读镜像 / 独立预览 / 老部署）：形状仍是完整的，值说"没有"。
  const noService = buildFacilityModel({ state, events: [] }, {})
  assert.deepEqual(noService.building.update, { enabled: false, mode: 'off', current: '', latest: '', available: false, checkedAt: 0, error: '' })
  for (const payload of [withNews, upToDate, noService]) {
    assert.equal(JSON.stringify(payload).includes('undefined'), false)
  }
})
