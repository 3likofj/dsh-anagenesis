/**
 * anagenesis-tools — the **read** row, and (by default) the only row the bundle
 * mounts.
 *
 * 这一行是整个权限改造的承重墙：它注册的工具里没有一个是写记忆的。所以
 * "没启用预设就写记忆"这个故障在结构上不可能再发生 —— 不是模型被劝阻，而是
 * 模型根本看不到那些工具（宿主侧没有任何 readOnly/permission 字段可用，
 * 唯一真正的可见性开关就是"注册 / 不注册"）。
 *
 * 写入类工具由 `src/tools/gated.js` 在**预设作用域**里注册，那一行只出现在
 * 预设组合中。管理动作（策略切换、调参、retag）留在这一行，因为它们各自的
 * 只读动作必须永远可用；它们的**变更动作**在执行期由
 * `src/permission/guard.js` 按档位拒绝。
 *
 * Registration is reversible for free: `ctx.tools.register()` returns the exact
 * disposer and Cordis collects it into this plugin fiber, so unloading the row
 * withdraws every tool it added.
 * @module dsh-anagenesis/tools
 */

import Schema from '@deepseek-ai/schemastery'

import { buildReadTools, buildWriteTools } from './definitions.js'

export const name = 'anagenesis-tools'

/**
 * Reactive coeffect: this row starts only once both services exist, and Cordis
 * re-settles it if either is replaced.
 */
export const inject = ['tools', 'anagenesis']

export const Config = Schema.object({
  exposeAuditTool: Schema.boolean().default(true)
    .description('是否注册 ana_audit：查看记忆、日志尾部、审计轨迹、作用域、策略清单与这层自身的健康状况。'),
  exposeTuneTool: Schema.boolean().default(true)
    .description('是否注册 ana_tune：第 3 层元调参（只读的 propose/report/evaluate 永远可用；apply/rollback 需要 admin 档位）。'),
  // Compatibility hatch, OFF by default and deliberately so.
  //
  // A deployment whose preset composition predates the scope/permission change
  // (the directory form on disk, a hand-written composition) would otherwise have
  // no write tools at all. Setting this to true restores the old behaviour of
  // registering them from the global row — and with it the old weakness: while
  // *any* grant is live in the process, a non-preset session would see them too.
  // That is why it is opt-in, documented, and refused by the default path.
  registerGatedWhenGranted: Schema.boolean().default(false)
    .description('兼容开关（默认 false）：为 true 时，本行也会在"存在活跃授权"期间注册写入类工具。只给无法更新预设组合的旧部署用；默认路径把写入工具限制在预设作用域内。'),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 */
export function apply(ctx, config = {}) {
  const service = () => {
    const found = ctx.get('anagenesis')
    if (found === undefined) throw new Error('anagenesis: the anagenesis service is not available in this scope')
    return found
  }
  const logger = ctx.logger
  const deps = { service, config, logger }

  const readTools = buildReadTools(deps)
  for (const definition of readTools) ctx.tools.register(definition)
  logger?.info?.(`anagenesis-tools: registered ${readTools.length} read-tier tool(s); write-tier tools come from dsh-anagenesis/tools-gated`)

  if (config.registerGatedWhenGranted === true) {
    registerGatedOnGrant(ctx, service, config, logger)
  }
}

/**
 * The compatibility path: register the write tools from the global row, but only
 * while a grant is live, and withdraw them the moment it is not.
 *
 * The reconciliation is a pure function of `permissions.gear()`, so a gear switch
 * cannot leave a stale registration behind — which is exactly the property the
 * spec asks to be able to verify.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {() => any} service
 * @param {any} config
 * @param {any} logger
 */
function registerGatedOnGrant(ctx, service, config, logger) {
  /** @type {Map<string, () => void>} */
  const live = new Map()
  const handle = { live: () => service().permissions.gear() !== 'none' }

  const reconcile = () => {
    const wanted = service().permissions.gear() !== 'none'
    if (wanted && live.size === 0) {
      for (const definition of buildWriteTools({ service, config })) {
        live.set(definition.name, ctx.tools.register(definition))
      }
      logger?.warn?.(`anagenesis-tools: registerGatedWhenGranted=true — the write-tier tools are registered from the global row (${live.size} tools). Remove this setting once the preset composition mounts dsh-anagenesis/tools-gated.`)
      return
    }
    if (!wanted && live.size > 0) {
      for (const dispose of live.values()) dispose()
      live.clear()
      logger?.info?.('anagenesis-tools: grant withdrawn; the global write-tier registration was rolled back')
    }
  }

  ctx.effect(() => {
    // `handle` is only used by `assertGrant` inside the gated tools; keeping the
    // reference here documents that this path's authorization is "a grant exists
    // somewhere in this process", which is exactly why it is off by default.
    void handle
    const off = service().permissions.onChange(reconcile)
    reconcile()
    return () => {
      off()
      for (const dispose of live.values()) dispose()
      live.clear()
    }
  })
}
