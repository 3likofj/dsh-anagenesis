/**
 * anagenesis-preset-bind — the runtime half of the preset↔plugin binding.
 *
 * Mounted *inside* the preset composition, so its `apply` runs in the preset's
 * scope. It does not register tools (the composition decides the tool set); it
 * makes the preset behave like a **permission-bearing** anagenesis agent:
 *
 *   - activates the preset's default strategy stack for this scope;
 *   - adopts the preset's recall token budget as a scope parameter;
 *   - **declares the gear** (passive / assisted / autonomous) and thereby drives
 *     `dsh-anagenesis/tools-gated`, which registers or withdraws the write tools
 *     in step with it;
 *   - registers the preset's presence as a grant, so a host that cannot mount the
 *     gated row still reports "preset active, gear passive" instead of nothing;
 *   - publishes the **status pulse** every step through `systemPrompt.context()`
 *     when the host has that service — the pulse is where the agent sees the
 *     project fingerprint, the gear and the tool set it actually holds;
 *   - on `autonomous`, lets the autonomy policies schedule the stack and
 *     crystallize cited drafts.
 *
 * Every one of those is an effect with a disposer: unloading the preset restores
 * the previous stack, releases the budget, drops the gear and stops the autonomy
 * — so switching presets mid-session cannot leave the agent in a half-configured
 * cognitive mode, and cannot leave a permission behind.
 * @module dsh-anagenesis/preset/bind
 */

import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_PRESET_STACK } from './definition.js'
import { gearCovers } from '../permission/tiers.js'
import { startAutonomy } from '../permission/autonomy.js'

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
  gear: Schema.string().default('assisted')
    .description('预设档位：passive=只读（不注册写入工具）| assisted=可写（关键操作需显式调用）| autonomous=可写且策略可自动调度、技能可自动结晶。'),
  autonomy: Schema.boolean().default(true)
    .description('是否允许 autonomous 档位下的自动行为（策略调度 + 技能结晶）。非 autonomous 档位下本项无效果。'),
  pulse: Schema.boolean().default(true)
    .description('是否每步注入状态脉冲（当前项目 / 档位 / 权限）。宿主没有 systemPrompt.context() 时自动跳过。'),
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
  const gear = String(config.gear ?? 'assisted')

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
        detail: { preset: 'anagenesis', scope, stack: activated.stack, previous, tokenBudget, gear },
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

  // ── permission: the preset's presence and its gear ────────────────────────
  //
  // Two separate things, deliberately:
  //   - the **presence grant** (always `passive`, so it never widens anything)
  //     makes `permissions.gear() !== 'none'` and the pulse able to say "preset
  //     active"; it is also what a host without the gated row still gets;
  //   - the **gear** is an override that the gated row reacts to. Raising it is
  //     a host-level act (`force: true`) — which is what this row is: the
  //     composition the user chose to enable.
  const presence = service.permissions.grant({
    scopeKey: 'preset:anagenesis',
    gear: 'passive',
    by: 'preset',
    reason: 'the anagenesis preset is mounted in this scope',
  })
  let gearChange = null
  try {
    gearChange = await service.setGear(gear, { reason: 'preset bind declares its gear', by: 'plugin', force: true })
  } catch (error) {
    logger?.warn?.(`anagenesis-preset-bind: could not set gear "${gear}" (${error instanceof Error ? error.message : String(error)})`)
  }
  ctx.effect(() => () => {
    presence.dispose()
  })
  if (gearChange !== null) {
    ctx.effect(() => () => {
      void gearChange.revert().catch(() => {})
    })
  }

  // ── autonomy: only under `autonomous`, and only for as long as it holds ────
  /** @type {{ handle: any }} */
  const state = { handle: null }
  const autonomyDeps = {
    store: service.store,
    ops: service.ops,
    registry: service.registry,
    logger,
    onEvent: (type, detail) => {
      void service.store.audit(`autonomy.${type}`, detail, { by: 'autonomy' }).catch(() => {})
    },
    currentNamespace: () => service.scopeFor(undefined).namespace,
  }
  const reconcileAutonomy = () => {
    const wanted = config.autonomy !== false && gearCovers(service.permissions.gear(), 'admin')
    if (wanted && state.handle === null) {
      state.handle = startAutonomy(autonomyDeps)
      logger?.info?.('anagenesis-preset-bind: autonomous gear — strategy scheduling and skill crystallization are live')
      return
    }
    if (!wanted && state.handle !== null) {
      state.handle.dispose()
      state.handle = null
      logger?.info?.('anagenesis-preset-bind: gear is no longer autonomous — autonomy stopped')
    }
  }
  ctx.effect(() => {
    const off = service.permissions.onChange(reconcileAutonomy)
    reconcileAutonomy()
    return () => {
      off()
      if (state.handle !== null) state.handle.dispose()
      state.handle = null
    }
  })

  // ── the status pulse ─────────────────────────────────────────────────────
  //
  // `systemPrompt.context()` is the host's real per-step dynamic-context hook:
  // whatever it contributes is rendered into the "Current runtime context"
  // snapshot at the head of every step. That is the only mechanism that makes
  // "check the scope before you trust a memory" an executable rule, because the
  // project fingerprint changes when the user switches workspace — a static
  // prompt sentence cannot know it.
  //
  // `ctx.inject` keeps it honest: the child fiber runs only while the service
  // exists, and its disposer is unwound when it does not.
  if (config.pulse !== false && typeof ctx.inject === 'function') {
    try {
      // NOT wrapped in `ctx.effect`: `ctx.inject()` returns a *fiber*, and an
      // effect body must return a disposer (cordis `_execute` → `safeCollect`
      // throws `TypeError('Invalid effect')` for anything else). The child fiber
      // is owned by this row, so it is unwound with the row — which is the
      // reversibility we need, without the invalid effect.
      ctx.inject(['systemPrompt'], (scoped) => {
        const prompt = scoped.systemPrompt ?? scoped.get?.('systemPrompt', false)
        if (prompt === undefined || typeof prompt.context !== 'function') {
          logger?.info?.('anagenesis-preset-bind: systemPrompt.context() is not available on this host; the pulse stays inside the recall block')
          return
        }
        const order = typeof prompt.getContextOrder === 'function'
          ? prompt.getContextOrder('RUNTIME_CONTEXT')
          : undefined
        return prompt.context({
          name: 'anagenesis:scope-pulse',
          order: typeof order === 'number' ? order + 1 : 100,
          text: (context) => {
            try {
              const pulse = service.pulse(context?.agent === undefined ? undefined : { agent: context.agent })
              return pulse.text
            } catch (error) {
              logger?.warn?.(`anagenesis-preset-bind: pulse failed (${error instanceof Error ? error.message : String(error)})`)
              return ''
            }
          },
        })
      })
    } catch (error) {
      logger?.warn?.(`anagenesis-preset-bind: pulse not installed (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  // Optional tool mask. `tools.restrict` requires a scoped context (agent.ctx);
  // in a plain preset scope Cordis throws, which we translate into a warning so
  // the same preset definition works on both host shapes.
  const allow = config.toolAllow ?? []
  if (allow.length > 0 && typeof ctx.tools?.restrict === 'function') {
    ctx.effect(() => {
      try {
        const disposer = ctx.tools.restrict({ allow: allow })
        return () => { if (typeof disposer === 'function') disposer() }
      } catch (error) {
        logger?.warn?.(`anagenesis-preset-bind: tool mask not applied (${error instanceof Error ? error.message : String(error)})`)
        return () => {}
      }
    })
  }
}
