/**
 * The permission registry — the runtime half of "the preset is a permission
 * layer, not a suggestion".
 *
 * 报告里的原始故障是：不启用预设时，模型仍然能调用写入类工具并污染记忆库。
 * 原因是结构性的 —— 全局 bundle 行无条件注册了全部 14 个工具，预设只切换了
 * 策略栈。所以修复也必须分两层，缺一层就漏：
 *
 *   1. **注册层（结构性）：** 写入类工具**只**由 `dsh-anagenesis/tools-gated`
 *      这一行注册，而那一行只存在于预设组合里。没有预设 = 那些工具在模型眼里
 *      根本不存在 —— 这是"看不见"，不是"被劝阻"。
 *   2. **执行层（不可绕过）：** 即便某个宿主把 gated 行挂到了别处、或旧配置里
 *      残留了注册，`ctx.tools.guard()` 与每个 gated 工具自己的 `assertGrant()`
 *      仍然会在**调用时**拒绝：没有活跃授权就没有写入。这一层是 `tools.register`
 *      做不到的（宿主没有 readOnly/permission 字段），必须由插件自己拥有。
 *
 * 授权（grant）是有主的对象：`grant()` 返回一个带 `token` 的句柄与一个逆函数，
 * 预设卸载时逆函数被调用，句柄立刻失效 —— 于是"档位切换/预设注销后精确回滚"
 * 与"执行期拦截"用的是同一份状态，不可能出现"工具已经注销但权限还开着"。
 * @module dsh-anagenesis/permission/registry
 */

import { GEARS, GEAR_IDS, GEAR_NONE, GEAR_ORDER, adminCapabilities, requiredTier, toolsForGear, gearCovers } from './tiers.js'

/**
 * @typedef {object} Grant
 * @property {symbol} token
 * @property {string} scopeKey 谁拿到的（`preset:anagenesis`、`agent:<id>`…），只用于展示与审计
 * @property {string} gear 这份授权声明自己用哪个档位
 * @property {string} by grant 的发起者（plugin / agent / operator）
 * @property {string} reason 为什么
 * @property {number} at
 * @property {boolean} live 逆函数是否还没被调用
 */

export class PermissionRegistry {
  /** @type {Map<symbol, Grant>} */
  #grants = new Map()
  /** @type {Set<(snapshot: any) => void>} */
  #listeners = new Set()
  /** @type {'passive'|'assisted'|'autonomous'|null} */
  #gearOverride = null
  /** @type {any} */
  #logger

  /**
   * @param {{ logger?: any, onChange?: (snapshot: any) => void }} [deps]
   */
  constructor(deps = {}) {
    this.#logger = deps.logger ?? { info: () => {}, warn: () => {} }
    if (typeof deps.onChange === 'function') this.#listeners.add(deps.onChange)
  }

  /**
   * Register a live authorization. Returns the handle the caller passes to
   * `assertGrant`, plus `dispose()` — the inverse, which is what a preset's
   * unload calls.
   *
   * @param {{ scopeKey?: string, gear?: string, by?: string, reason?: string, at?: number }} [opts]
   * @returns {{ token: symbol, scopeKey: string, gear: string, dispose: () => boolean, live: () => boolean }}
   */
  grant(opts = {}) {
    const gear = GEAR_IDS.includes(String(opts.gear)) ? String(opts.gear) : 'assisted'
    const token = Symbol(`anagenesis-grant:${opts.scopeKey ?? 'unknown'}`)
    /** @type {Grant} */
    const grant = {
      token,
      scopeKey: String(opts.scopeKey ?? 'unknown'),
      gear,
      by: String(opts.by ?? 'plugin'),
      reason: String(opts.reason ?? ''),
      at: Number(opts.at ?? Date.now()),
      live: true,
    }
    this.#grants.set(token, grant)
    this.#logger.info?.(`anagenesis-permission: grant ${grant.gear} for "${grant.scopeKey}" (${this.activeCount()} live)`)
    this.#emit()
    return {
      token,
      scopeKey: grant.scopeKey,
      gear: grant.gear,
      live: () => grant.live,
      dispose: () => this.revoke(token),
    }
  }

  /**
   * The inverse of `grant()`. Idempotent, like every other disposer in this
   * codebase: unloading a preset twice must not corrupt the count.
   * @param {symbol} token
   * @returns {boolean} true when this call is what removed the grant
   */
  revoke(token) {
    const grant = this.#grants.get(token)
    if (grant === undefined || grant.live !== true) return false
    grant.live = false
    this.#grants.delete(token)
    this.#logger.info?.(`anagenesis-permission: grant for "${grant.scopeKey}" revoked (${this.activeCount()} live)`)
    this.#emit()
    return true
  }

  /** @returns {Grant[]} the grants that are still live */
  active() {
    return [...this.#grants.values()].filter((grant) => grant.live)
  }

  /** @returns {number} */
  activeCount() {
    return this.active().length
  }

  /**
   * The gear in force.
   *
   * With several live grants the **most permissive** one wins, and that is a
   * deliberate simplification with a stated limit: the host does not tell a
   * preset-scoped row which agent it is binding, so a grant cannot be keyed to
   * an agent id at bind time. What keeps that from becoming a hole is the
   * registration layer — a non-preset agent never receives the write tools at
   * all, so "who wins when two sessions disagree" is a question with no
   * observable consequence. Documented rather than hidden.
   * @returns {string} a gear id, or `none` when nothing is granted
   */
  gear() {
    if (this.#gearOverride !== null) return this.#gearOverride
    const grants = this.active()
    if (grants.length === 0) return GEAR_NONE
    let best = 'passive'
    for (const grant of grants) {
      if ((GEAR_ORDER[grant.gear] ?? 0) > (GEAR_ORDER[best] ?? 0)) best = grant.gear
    }
    return best
  }

  /** @returns {string[]} tool names this gear exposes */
  allowedTools() {
    return toolsForGear(this.gear())
  }

  /**
   * Is this call permitted right now?
   * @param {string} name
   * @param {any} [args]
   * @returns {{ ok: boolean, tier: string, gear: string, reason: string }}
   */
  check(name, args) {
    const tier = requiredTier(name, args)
    const gear = this.gear()
    if (tier === 'read') return { ok: true, tier, gear, reason: 'read tier is always available' }
    if (gear === GEAR_NONE) {
      return {
        ok: false,
        tier,
        gear,
        reason: `the anagenesis preset is not active, so ${name} (${tier} tier) is not available: without an active grant the plugin is read-only`,
      }
    }
    if (!gearCovers(gear, tier)) {
      return {
        ok: false,
        tier,
        gear,
        reason: `gear "${gear}" does not include the ${tier} tier, so ${name} is not available in this session`,
      }
    }
    return { ok: true, tier, gear, reason: `${tier} tier allowed by gear "${gear}"` }
  }

  /**
   * `check()` as an exception. Throwing (rather than returning a string) is what
   * makes this usable *inside* a tool body, where the host turns a throw into an
   * error result the model sees.
   * @param {string} name
   * @param {any} [args]
   * @returns {{ tier: string, gear: string }}
   */
  assert(name, args) {
    const verdict = this.check(name, args)
    if (!verdict.ok) {
      const error = new Error(`anagenesis: refused — ${verdict.reason}`)
      error.name = 'PermissionDenied'
      // @ts-expect-error extra field on an Error is intentional and consumed by the guard
      error.tier = verdict.tier
      throw error
    }
    return { tier: verdict.tier, gear: verdict.gear }
  }

  /**
   * Verify that a *specific* grant is still live before running a gated tool.
   *
   * This is stronger than `check()`: it proves that the tool instance which is
   * about to run was registered under a grant that has not been revoked since.
   * A tool left over from an unloaded preset therefore cannot execute even if the
   * registry has meanwhile acquired a different grant.
   * @param {{ live?: () => boolean }|null|undefined} handle
   * @param {string} name
   * @param {any} [args]
   * @returns {{ tier: string, gear: string }}
   */
  assertGrant(handle, name, args) {
    if (handle === null || handle === undefined || typeof handle.live !== 'function' || handle.live() !== true) {
      const error = new Error(`anagenesis: refused — the grant this ${name} registration belongs to is no longer live (the preset was unloaded or its gear changed); nothing was written`)
      error.name = 'PermissionDenied'
      throw error
    }
    return this.assert(name, args)
  }

  /**
   * Change the gear without touching the grants. Returns the inverse, so a
   * gear switch is undoable exactly like the tool registrations it implies.
   * @param {string} gear
   * @param {{ scopeKey?: string, by?: string, reason?: string, force?: boolean }} [opts]
   * @returns {{ applied: string, previous: string, dispose: () => string }}
   */
  setGear(gear, opts = {}) {
    if (!GEAR_IDS.includes(String(gear))) throw new Error(`anagenesis: unknown gear "${gear}" (allowed: ${GEAR_IDS.join(', ')})`)
    const previous = this.gear()
    // Escalation guard: only a host-level call (`force`) or an already-admin gear
    // may *raise* the gear. Downgrading is always allowed — a system that cannot
    // take away its own privileges is not a safe system.
    if ((GEAR_ORDER[gear] ?? 0) > (GEAR_ORDER[previous] ?? -1) && opts.force !== true) {
      throw new Error(`anagenesis: refusing to raise the gear from "${previous}" to "${gear}" without an explicit host authorization (force: true)`)
    }
    this.#gearOverride = gear
    this.#logger.info?.(`anagenesis-permission: gear ${previous} -> ${gear} (${opts.reason ?? 'no reason given'})`)
    this.#emit()
    return {
      applied: gear,
      previous,
      dispose: () => {
        this.#gearOverride = null
        this.#emit()
        return this.gear()
      },
    }
  }

  /**
   * @param {(snapshot: any) => void} listener
   * @returns {() => void} disposer
   */
  onChange(listener) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /**
   * Everything the pulse, the dashboard and the tests need — one shape, so none
   * of them can tell a different story about the current permissions.
   * @param {{ scopeKey?: string }} [opts]
   * @returns {{ gear: string, presetActive: boolean, grants: number, allowed: string[],
   *   admin: string[], scopeKeys: string[] }}
   */
  describe(opts = {}) {
    const gear = this.gear()
    const grants = this.active()
    const filtered = opts.scopeKey === undefined ? grants : grants.filter((grant) => grant.scopeKey === opts.scopeKey)
    return {
      gear,
      presetActive: grants.length > 0,
      grants: filtered.length,
      allowed: gear === GEAR_NONE ? toolsForGear('passive') : toolsForGear(gear),
      admin: gearCovers(gear, 'admin') ? adminCapabilities() : [],
      scopeKeys: grants.map((grant) => grant.scopeKey),
    }
  }

  /** @param {any} snapshot */
  #emit() {
    const snapshot = this.describe()
    for (const listener of this.#listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        this.#logger.warn?.(`anagenesis-permission: change listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

/**
 * @param {{ logger?: any, onChange?: (snapshot: any) => void }} [deps]
 * @returns {PermissionRegistry}
 */
export function createPermissions(deps = {}) {
  return new PermissionRegistry(deps)
}
