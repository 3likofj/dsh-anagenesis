/**
 * anagenesis-preset-bind — the runtime half of the preset↔plugin binding.
 *
 * Mounted *inside* the preset composition, so its `apply` runs in the preset's
 * scope. It does not register tools (the composition decides the tool set); it
 * makes the preset behave like an anagenesis agent:
 *
 *   - activates the preset's default strategy stack for this scope;
 *   - adopts the preset's recall token budget as a scope parameter;
 *   - on hosts where the preset scope is an agent scope, narrows the tool mask
 *     with `ctx.tools.restrict()` when `toolAllow` is configured.
 *
 * Every one of those is an effect with a disposer: unloading the preset restores
 * the previous stack and lifts the restriction, so switching presets mid-session
 * cannot leave the agent in a half-configured cognitive mode.
 * @module dsh-anagenesis/preset/bind
 */

import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_PRESET_STACK } from './definition.js'

export const name = 'anagenesis-preset-bind'

/** The service must exist before a preset can bind to it. */
export const inject = ['anagenesis']

export const Config = Schema.object({
  stack: Schema.array(Schema.string()).default([...DEFAULT_PRESET_STACK])
    .description('绑定时要切换到的策略栈。'),
  tokenBudget: Schema.number().default(1600)
    .description('绑定时写进 store 的召回 token 预算。'),
  scope: Schema.string().default('global')
    .description('写进哪个作用域（默认 global）。'),
  toolAllow: Schema.array(Schema.string()).default([])
    .description('可选的工具白名单，走 ctx.tools.restrict() 施加；空数组 = 不施加任何限制。'),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 * @returns {Promise<void>} nothing — see the note about the effect contract
 */
export async function apply(ctx, config = {}) {
  const service = ctx.get('anagenesis')
  const logger = ctx.logger
  const scope = config.scope ?? 'global'
  const stack = config.stack ?? [...DEFAULT_PRESET_STACK]
  const tokenBudget = config.tokenBudget ?? 1600

  let disposed = false
  /** @type {(() => Promise<void>) | undefined} */
  let restore

  // The disposer effect is registered BEFORE the await, so an unload that lands
  // while the bind is still settling is still undone exactly once.
  //
  // `ctx.effect` owns this disposer, so `apply` must NOT return it: Cordis would
  // collect a returned function as a *second* effect, and disposing twice would
  // revert the activated stack twice — putting the old stack back and then the
  // new one on top of it again.
  ctx.effect(() => async () => {
    disposed = true
    if (restore !== undefined) await restore()
  })

  try {
    const previous = service.registry.stack(scope)
    const activated = await service.registry.setStack(stack, {
      scope,
      reason: 'anagenesis preset bind',
    })
    const bound = await service.store.transact({
      paramsSet: { [scope]: { 'recall.orient.tokenBudget': tokenBudget } },
      auditAppend: [{
        id: `bind_${activated.seq}`,
        at: Date.now(),
        type: 'preset.bind',
        detail: { preset: 'anagenesis', scope, stack: activated.stack, previous, tokenBudget },
      }],
    }, { type: 'preset.bind', scope, by: 'plugin', payload: { preset: 'anagenesis', stack: activated.stack } })
    // Unloading must undo *both* writes, newest first. The budget is a tier-1
    // change exactly like the stack, and dropping its compensating transaction
    // pinned `recall.orient.tokenBudget` in the scope forever: the real journal
    // shows three preset unloads in one day, each reverting only the stack while
    // the parameter stayed behind in the snapshot.
    restore = async () => {
      await bound.revert('anagenesis preset token budget released')
      await activated.revert('anagenesis preset unloaded')
    }
    if (disposed) {
      await restore()
      return
    }
    // Awaited on purpose: the preset must be fully bound by the time its mount
    // completes, otherwise the first turn could recall under the default stack.
    logger?.info?.(`anagenesis-preset-bind: preset stack [${activated.stack.join(', ')}] active in scope "${scope}"`)
  } catch (error) {
    // A binding failure must not stop the preset from loading: the agent keeps
    // the default stack and can still switch explicitly.
    logger?.warn?.(`anagenesis-preset-bind: could not bind (${error instanceof Error ? error.message : String(error)})`)
  }

  // Optional tool mask. `tools.restrict` requires a scoped context (agent.ctx);
  // in a plain preset scope Cordis throws, which we translate into a warning so
  // the same preset definition works on both host shapes.
  const allow = config.toolAllow ?? []
  if (allow.length > 0 && typeof ctx.tools?.restrict === 'function') {
    ctx.effect(() => {
      try {
        const disposer = ctx.tools.restrict({ allow })
        return () => { if (typeof disposer === 'function') disposer() }
      } catch (error) {
        logger?.warn?.(`anagenesis-preset-bind: tool mask not applied (${error instanceof Error ? error.message : String(error)})`)
        return () => {}
      }
    })
  }
}
