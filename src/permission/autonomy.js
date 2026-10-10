/**
 * Autonomy — the behaviours that only the `autonomous` gear is allowed to have.
 *
 * 档位不只是"多几个工具"。规格里 `autonomous` 与 `assisted` 的差别是行为性的：
 * "策略可自动调度、技能可自动结晶"。这两件事都必须满足三个条件才配存在：
 *
 *   1. **有界**：每次自动动作都要有上限，不能在一次事件里改完整座库；
 *   2. **可逆**：它们走的是同一条 `store.transact` 路径，所以每一次自动变更都有
 *      seq 与逆函数 —— 自动不等于不可追溯；
 *   3. **可关**：`dispose()` 之后不留任何监听器与计时器，档位降回 assisted 的
 *      下一个 tick 就必须彻底安静。
 *
 * 两个行为：
 *   - **策略调度（autoStack）**：一次失败信号（`ana_feedback success:false`）就切到
 *     `debug`；连续两次成功再回到 `exploit`。这是"崩了就看失败"的自动化版本，
 *     而不是让模型自己记得切。
 *   - **技能结晶（crystallize）**：一条 draft 被反复引用（hits 到阈值）说明它已经
 *     在实践中站住了，于是把它提升为 `active`。结晶只发生在**当前项目与全局**
 *     的记录上，且每次最多几条。
 * @module dsh-anagenesis/permission/autonomy
 */

import { clamp } from '../util.js'

/** 一次失败信号后自动切入的策略栈。 */
export const FAILURE_STACK = Object.freeze(['guard', 'debug'])
/** 连续成功多少次后回到执行态。 */
export const RECOVERY_STREAK = 2
/** 结晶阈值：一条 draft 被引用多少次算"站住了"。 */
export const CRYSTALLIZE_HITS = 3
/** 每轮最多结晶几条 —— 自动动作必须是有界的。 */
export const CRYSTALLIZE_MAX = 2

/**
 * @param {{ store: any, ops: any, registry: any, logger?: any, scopeKey?: string,
 *   currentNamespace: () => string|null, onEvent?: (type: string, detail: any) => void }} deps
 * @returns {{ dispose: () => void, describe: () => any }}
 */
export function startAutonomy(deps) {
  const { store, ops, registry } = deps
  const logger = deps.logger ?? { info: () => {}, warn: () => {} }
  let successes = 0
  let scheduled = 0
  let crystallized = 0
  let disposed = false

  /**
   * @param {'autoStack'|'crystallize'} verb
   * @param {any} detail
   */
  const record = (verb, detail) => {
    deps.onEvent?.(verb, detail)
    void store.audit(`autonomy.${verb}`, detail, { by: 'autonomy' }).catch(() => {})
  }

  /**
   * The feedback signal, read from wherever it is available. The event payload is
   * the interface; the audit row's detail is the fallback, because older rows (and
   * any other writer of the same audit type) carry it there.
   * @param {any} payload
   * @param {any} event
   * @returns {any}
   */
  const signalOf = (payload, event) => {
    if (payload !== null && payload !== undefined && typeof payload === 'object') return payload
    const detail = event?.patch?.auditAppend?.[0]?.detail
    return detail !== null && detail !== undefined && typeof detail === 'object' ? detail : {}
  }

  /** @param {any} payload @param {any} event */
  const onFeedback = async (payload, event) => {
    if (disposed) return
    const success = signalOf(payload, event).success
    if (success === false) {
      successes = 0
      const current = registry.stack('global')
      if (current.includes('debug')) return
      try {
        const result = await registry.setStack([...FAILURE_STACK], { scope: 'global', reason: 'autonomy: a failure was reported; switch to debug' })
        scheduled += 1
        record('autoStack', { to: 'debug', seq: result.seq, from: current })
        logger.info?.(`anagenesis-autonomy: failure reported — stack switched to [${FAILURE_STACK.join(', ')}] (#${result.seq})`)
      } catch (error) {
        logger.warn?.(`anagenesis-autonomy: could not switch to debug: ${String(error)}`)
      }
      return
    }
    if (success !== true) return
    successes += 1
    if (successes < RECOVERY_STREAK) return
    successes = 0
    const current = registry.stack('global')
    if (!current.includes('debug')) return
    try {
      const result = await registry.setStack(['guard', 'exploit'], { scope: 'global', reason: `autonomy: ${RECOVERY_STREAK} consecutive successes; back to exploit` })
      scheduled += 1
      record('autoStack', { to: 'exploit', seq: result.seq, from: current })
    } catch (error) {
      logger.warn?.(`anagenesis-autonomy: could not return to exploit: ${String(error)}`)
    }
  }

  /** @param {any} payload */
  const onUsage = async (payload) => {
    if (disposed) return
    const used = Array.isArray(payload?.usedIds) ? payload.usedIds : []
    if (used.length === 0) return
    const namespace = deps.currentNamespace?.() ?? null
    const candidates = []
    for (const id of used) {
      const record_ = store.state.memories[id]
      if (record_ === undefined) continue
      if (record_.state !== 'draft') continue
      if (record_.access?.hits < CRYSTALLIZE_HITS) continue
      // Scope bound: crystallization is a *promotion*, so it must not strengthen
      // another project's draft on the strength of this session's usage.
      const ns = record_.scope?.tier === 'global' ? 'global'
        : record_.scope?.tier === 'project' ? `project:${record_.scope.projectId}`
          : `session:${record_.scope?.session ?? 'unknown'}`
      if (namespace !== null && ns !== namespace && ns !== 'global') continue
      candidates.push(id)
      if (candidates.length >= CRYSTALLIZE_MAX) break
    }
    if (candidates.length === 0) return
    try {
      const result = await ops.promote({
        ids: candidates,
        to: 'active',
        reason: `autonomy: cited ${CRYSTALLIZE_HITS}+ times, so the draft is treated as established`,
        evidence: ['autonomy.crystallize'],
      })
      crystallized += candidates.length
      record('crystallize', { ids: candidates, seq: result.seq, namespace })
    } catch (error) {
      logger.warn?.(`anagenesis-autonomy: crystallization failed: ${String(error)}`)
    }
  }

  const listener = store.on('*', (payload, event) => {
    if (disposed) return
    if (event.type === 'audit:feedback.report') void onFeedback(payload, event)
    if (event.type === 'memory.usage') void onUsage(payload)
  })

  return {
    dispose() {
      if (disposed) return
      disposed = true
      listener.dispose()
    },
    describe() {
      return { scheduled, crystallized, disabled: disposed, recoveryStreak: clamp(successes, 0, RECOVERY_STREAK) }
    },
  }
}
