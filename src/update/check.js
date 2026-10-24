/**
 * 版本更新检查 —— 这个插件**唯一**的网络出口。
 *
 * 语义边界（写在这里，因为这是最容易"顺手多做一点"的地方）：
 *
 *   - 只做一件事：读一次 npm registry 上本包的 `latest` 版本号，与**自己**的版本比大小。
 *   - 只发 **GET**，不带任何标识（没有实例 id、没有项目指纹、没有记忆内容）。
 *   - **不自动安装、不自动重启、不改任何文件**。它只回答"有没有新版本"，然后由人决定。
 *   - 失败是**一种状态**，不是异常：超时/离线/404/限流都会落到 `error` 字段，
 *     界面显示"检查失败"，插件其余部分照常工作。
 *   - 默认 `off`：离线优先是这个插件的身份，bundle 里才把 `updateCheck` 设成 `npm`
 *     （见 `cordis.patch.yml`），而 `updateCheck: off` 是一行关掉的开关。
 *
 * 为什么版本号比较自己写而不是引 semver：零运行时依赖是这个包的硬约束，
 * 而这里需要的只是严格 semver 优先级的一个子集 —— 12 行纯函数 + 一组测试，
 * 比多一个依赖便宜。
 * @module dsh-anagenesis/update/check
 */

import { readFileSync } from 'node:fs'

/** The package this check is about. */
export const UPDATE_PACKAGE = 'dsh-anagenesis'

/** `off` = 从不联网；`npm` = 定时读 npm registry 的 latest。 */
export const UPDATE_MODES = Object.freeze(['off', 'npm'])

/** Bumped when the status shape changes in a way a renderer must notice. */
export const UPDATE_VERSION = 1

/** Where `npm` mode asks. A trailing slash is normalized away. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** Six hours: an update prompt does not need to be fresher than that. */
export const DEFAULT_INTERVAL_MS = 6 * 3600 * 1000

/** A registry answer arrives in milliseconds; five seconds is already generous. */
export const DEFAULT_TIMEOUT_MS = 5_000

/**
 * 解析严格 semver（`MAJOR.MINOR.PATCH[-pre][+build]`）。
 * @param {unknown} text
 * @returns {{ major: number, minor: number, patch: number, pre: (string|number)[] } | null}
 */
export function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text ?? '').trim())
  if (match === null) return null
  const pre = match[4] === undefined ? [] : match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre }
}

/**
 * semver 优先级比较。构建元数据（`+build`）按规范不参与比较。
 * @param {unknown} left
 * @param {unknown} right
 * @returns {number | null} -1 / 0 / 1，任一侧无法解析时返回 null
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  // 有预发布标识的**低于**同号正式版：0.3.1-rc.1 < 0.3.1
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index]
    const y = b.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1
    // 数字标识恒低于字母标识
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x > y ? 1 : -1
  }
  return 0
}

/**
 * `latest` 是否比 `current` 新。无法解析时一律 **false** —— 宁可少提示一次，
 * 也不要在版本号看不懂的时候催人升级。
 * @param {unknown} latest
 * @param {unknown} current
 * @returns {boolean}
 */
export function isNewer(latest, current) {
  const verdict = compareVersions(latest, current)
  return verdict === 1
}

/**
 * 本包自己的版本号，从 `package.json` 读（**唯一**真源，不在代码里再写一份）。
 * 读不到就返回空串：`status()` 会如实说"不知道当前版本"，而不是编一个。
 * @returns {string}
 */
export function readOwnVersion() {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : ''
  } catch {
    return ''
  }
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max @returns {number} */
function clamp(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** @param {unknown} value @returns {string} */
function trimRegistry(value) {
  const text = String(value ?? '').trim()
  if (text === '') return DEFAULT_REGISTRY
  return text.replace(/\/+$/, '')
}

/**
 * 更新检查器。
 *
 * 状态是一个**可渲染的事实**，不是一个 promise：`status()` 永远同步返回同一形状，
 * 所有字段都有值（没有 `undefined` —— 宿主会拒绝不能无损往返 JSON 的载荷）。
 * @param {{
 *   mode?: string, current?: string, packageName?: string, registry?: string,
 *   intervalMs?: number, timeoutMs?: number, now?: () => number,
 *   fetchImpl?: typeof fetch | null, log?: { warn?: (message: string) => void },
 * }} [options]
 * @returns {{
 *   status: () => any, check: (opts?: { force?: boolean }) => Promise<any>,
 *   start: () => () => void, mode: string,
 * }}
 */
export function createUpdateChecker(options = {}) {
  const mode = UPDATE_MODES.includes(String(options.mode ?? 'off')) ? String(options.mode ?? 'off') : 'off'
  const current = String(options.current ?? '')
  const packageName = String(options.packageName ?? UPDATE_PACKAGE)
  const registry = trimRegistry(options.registry)
  const intervalMs = clamp(options.intervalMs, DEFAULT_INTERVAL_MS, 60_000, 7 * 24 * 3600 * 1000)
  const timeoutMs = clamp(options.timeoutMs, DEFAULT_TIMEOUT_MS, 500, 60_000)
  const now = typeof options.now === 'function' ? options.now : Date.now
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl
  const log = options.log

  /** @type {{ latest: string, available: boolean, checkedAt: number, error: string }} */
  const state = { latest: '', available: false, checkedAt: 0, error: '' }
  /** @type {Promise<any> | null} */
  let inFlight = null

  const status = () => ({
    kind: 'update',
    version: UPDATE_VERSION,
    mode,
    enabled: mode !== 'off',
    package: packageName,
    registry: mode === 'off' ? '' : registry,
    current,
    latest: state.latest,
    available: state.available,
    checked: state.checkedAt > 0,
    checkedAt: state.checkedAt,
    error: state.error,
    // 下一次**允许**联网检查的时间；界面用它解释"什么时候会再看一眼"。
    nextCheckAt: mode === 'off' || state.checkedAt === 0 ? 0 : state.checkedAt + intervalMs,
  })

  /**
   * 查一次。缓存、并流与失败都在这里处理：
   * 同一个进程里并发调用只会打一次网络，`force` 才有权越过缓存。
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<any>}
   */
  async function check(opts) {
    const force = opts?.force === true
    if (mode === 'off') return status()
    if (typeof fetchImpl !== 'function') {
      state.error = 'this host has no fetch'
      state.checkedAt = now()
      return status()
    }
    if (inFlight !== null) return inFlight
    if (!force && state.checkedAt > 0 && now() - state.checkedAt < intervalMs) return status()

    const url = `${registry}/${encodeURIComponent(packageName)}/latest`
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs)
    if (timer !== null && typeof timer.unref === 'function') timer.unref()

    inFlight = (async () => {
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: controller === null ? undefined : controller.signal,
          redirect: 'follow',
        })
        if (response === null || typeof response !== 'object' || !response.ok) {
          throw new Error(`registry answered HTTP ${Number(response?.status ?? 0)}`)
        }
        const payload = await response.json()
        const latest = typeof payload?.version === 'string' ? payload.version : ''
        if (parseVersion(latest) === null) throw new Error('registry answered without a usable version')
        state.latest = latest
        state.available = isNewer(latest, current)
        state.checkedAt = now()
        state.error = ''
        if (state.available) log?.info?.(`anagenesis: update available ${current} → ${latest}`)
      } catch (error) {
        // 失败保留上一次成功的结果（如果真有的话），并把它记成一种状态。
        state.checkedAt = now()
        state.error = (error instanceof Error ? error.message : String(error)).slice(0, 160)
        log?.warn?.(`anagenesis: update check failed: ${state.error}`)
      } finally {
        if (timer !== null) clearTimeout(timer)
        inFlight = null
      }
      return status()
    })()
    return inFlight
  }

  /**
   * 后台检查。第一次在启动后几秒再查（不跟开机抢带宽），之后按间隔查。
   * 返回 disposer，由调用方的 effect 持有 —— 行的生命周期就是定时器的生命周期。
   * @returns {() => void}
   */
  function start() {
    if (mode === 'off') return () => {}
    const first = setTimeout(() => { void check() }, clamp(options.firstDelayMs, 3_000, 0, 60_000))
    const timer = setInterval(() => { void check() }, intervalMs)
    if (typeof first.unref === 'function') first.unref()
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }

  return { status, check, start, mode, intervalMs, timeoutMs, packageName, registry }
}
