/**
 * anagenesis-tools-gated — the write tier, mounted **only inside the preset
 * composition**.
 *
 * 这一行的存在本身就是授权：它 grant 一份带逆函数的许可，然后按当前档位注册
 * 写入类工具。三件事因此同时成立，而且用的是同一份状态：
 *
 *   1. **没启用预设 → 模型看不到写入工具**（这一行根本没被挂载）；
 *   2. **档位切换 → 工具注册同步更新**（`passive` 注销全部写入工具，
 *      `assisted`/`autonomous` 注册回来；reconcile 是档位的纯函数）；
 *   3. **预设注销 → 精确回滚**（effect 逆函数先撤销 grant，再逐个调用
 *      `tools.register()` 返回的逆函数；`assertGrant` 让任何仍在飞的旧实例
 *      也拒绝执行）。
 *
 * 这三条都是"可逆效应"的直接应用：`grant()` 返回逆函数，`tools.register()`
 * 返回逆函数，`ctx.effect` 按注册的逆序依次 await 它们。
 * @module dsh-anagenesis/tools/gated
 */

import Schema from '@deepseek-ai/schemastery'

import { buildWriteTools } from './definitions.js'
import { gearCovers } from '../permission/tiers.js'
import { bindGrant } from '../permission/guard.js'

export const name = 'anagenesis-tools-gated'

/** Needs the tool registry, the service, and the permission registry inside it. */
export const inject = ['tools', 'anagenesis']

export const Config = Schema.object({
  gear: Schema.string().default('assisted')
    .description('本行自己的档位声明。preset-bind 若配置了 gear，会以它的 override 为准；两者都取"更宽松者"。'),
  scopeKey: Schema.string().default('preset:anagenesis')
    .description('授权的作用域名，只用于展示与审计（宿主不告诉预设作用域行它绑定的是哪个 agent）。'),
  reason: Schema.string().default('anagenesis preset mounted')
    .description('为什么授予这份权限，写进日志与审计。'),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 */
export function apply(ctx, config = {}) {
  const service = () => {
    const found = ctx.get('anagenesis')
    if (found === undefined) throw new Error('anagenesis-tools-gated: the anagenesis service is not available in this scope')
    return found
  }
  const logger = ctx.logger
  const permissions = service().permissions

  // 1. The grant. Its inverse is the first thing that must run on unload: a
  //    revoked grant is what makes every stale tool instance refuse.
  const grant = permissions.grant({
    scopeKey: String(config.scopeKey ?? 'preset:anagenesis'),
    gear: String(config.gear ?? 'assisted'),
    by: 'preset',
    reason: String(config.reason ?? 'anagenesis preset mounted'),
  })

  /** @type {Map<string, () => void>} */
  const registered = new Map()

  const reconcile = () => {
    const gear = permissions.gear()
    const wanted = gearCovers(gear, 'write')
    if (wanted && registered.size === 0) {
      for (const definition of buildWriteTools({ service, config })) {
        // `bindGrant` makes the *instance* answer for the grant it was born
        // under: a tool that outlives its grant refuses to execute.
        registered.set(definition.name, ctx.tools.register(bindGrant(definition, { grant, permissions })))
      }
      logger?.info?.(`anagenesis-tools-gated: ${registered.size} write-tier tool(s) registered under gear "${gear}"`)
      return
    }
    if (!wanted && registered.size > 0) {
      for (const dispose of registered.values()) dispose()
      registered.clear()
      logger?.info?.(`anagenesis-tools-gated: gear "${gear}" is read-only; every write-tier tool was withdrawn`)
    }
  }

  ctx.effect(() => {
    const off = permissions.onChange(reconcile)
    reconcile()
    return async () => {
      off()
      for (const dispose of registered.values()) dispose()
      registered.clear()
      grant.dispose()
    }
  })

  // The preset's unload is not the only way this row ends: if the row itself
  // fails to settle, Cordis unwinds the effect above and the grant dies with it.
  logger?.info?.(`anagenesis-tools-gated: grant ${grant.gear} for "${grant.scopeKey}" (gear is now "${permissions.gear()}")`)
}

/**
 * Re-exported so a test can assert the gated registration against the catalogue
 * without reaching into the tool builder.
 */
export { buildWriteTools }
