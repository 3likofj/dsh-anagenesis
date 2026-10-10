/**
 * anagenesis-guard — the safety row.
 *
 * Split from `anagenesis-tools` on purpose: the guardrail must be loadable while
 * the meta layer is disabled, and disableable without touching the store. It
 * provides two independent layers:
 *
 *   1. a monotonic tool guard via `ctx.tools.guard()`. Guards run AFTER the
 *      extensible `tools/pre-execute` waterfall and no guard can force-allow a
 *      call another guard denied, so this is a real ceiling rather than advice.
 *      It sees tool arguments, which the store-level valve cannot.
 *   2. `ana_audit`-visible anti-oscillation: if the engine quarantines a
 *      strategy, the row records it and refuses further meta changes until the
 *      strategy is explicitly revived.
 * @module dsh-anagenesis/guard
 */

import Schema from '@deepseek-ai/schemastery'
import { createToolGuard } from './invariants.js'
import { createPermissionGuard } from '../permission/guard.js'

export const name = 'anagenesis-guard'

/** Needs the tool registry and the store; both must exist before a guard can judge. */
export const inject = ['tools', 'anagenesis']

export const Config = Schema.object({
  maxIdsPerCall: Schema.number().default(50)
    .description('一次调用里允许传入的 id 数量上限；超出的调用被拒，要求分批并逐个说明理由。'),
  blockMetaOnQuarantine: Schema.boolean().default(true)
    .description('当某个策略 hook 处于熔断/隔离状态时，冻结 ana_tune 与 ana_strategy（防振荡刹车）；设为 false 解除这层保护。'),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 */
export function apply(ctx, config = {}) {
  const service = () => ctx.get('anagenesis')
  const logger = ctx.logger

  const guard = createToolGuard({
    get store() {
      return service().store
    },
    safeMode: () => service().safeMode === true,
    maxIdsPerCall: config.maxIdsPerCall ?? 50,
  })

  // Monotonic: registered once, applies to every ana_* call in this context,
  // and withdrawn automatically when this row unloads (effect disposer).
  const guardDisposer = /** @type {any} */ (ctx.tools.guard((exec) => {
    try {
      const reason = guard(exec)
      if (reason !== undefined) {
        void service().store.audit('guard.denied', { tool: exec?.name, reason }, { by: 'guard' }).catch(() => {})
        return reason
      }
      if (config.blockMetaOnQuarantine !== false && typeof exec?.name === 'string' && exec.name.startsWith('ana_')) {
        const quarantined = service().engine.health().filter((row) => row.quarantined)
        if (quarantined.length > 0 && ['ana_tune', 'ana_strategy'].includes(exec.name)) {
          const ids = quarantined.map((row) => row.strategy).join(', ')
          return `anagenesis: strategy/quarantine tripped (${ids}); meta changes are frozen until ana_strategy action=health then revive. This is the anti-oscillation brake.`
        }
      }
      return undefined
    } catch (error) {
      // A guard that throws would be worse than no guard: fail closed on ana_*
      // tools only, and never block unrelated tools.
      if (typeof exec?.name === 'string' && exec.name.startsWith('ana_')) {
        return `anagenesis: guard failed to evaluate this call (${error instanceof Error ? error.message : String(error)}); refusing rather than running unchecked`
      }
      return undefined
    }
  }))

  // The second, independent layer: **tier permission**. The first guard sees
  // arguments and refuses dangerous *shapes*; this one refuses whole classes of
  // action when no preset grant is live, which is the enforcement half of "the
  // preset is a permission layer, not a suggestion".
  //
  // It is registered through a proxy rather than by capturing the registry, so a
  // service replacement (a remount, a host that re-settles this row) cannot leave
  // the guard holding a dead reference — the very failure mode this row exists to
  // prevent.
  const permissionDisposer = /** @type {any} */ (ctx.tools.guard(createPermissionGuard({
    permissions: {
      check: (name, args) => service().permissions.check(name, args),
      gear: () => service().permissions.gear(),
    },
    onDenied: (detail) => {
      void service().store.audit('guard.denied', {
        tool: detail.tool,
        tier: detail.tier,
        gear: detail.gear,
        reason: detail.reason,
      }, { by: 'guard' }).catch(() => {})
    },
  })))

  ctx.effect(() => {
    logger?.info?.('anagenesis-guard: monotonic tool guard + tier permission guard installed')
    return () => {
      if (typeof guardDisposer === 'function') guardDisposer()
      if (typeof permissionDisposer === 'function') permissionDisposer()
    }
  })
}
