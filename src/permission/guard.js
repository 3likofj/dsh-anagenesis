/**
 * The execution-time permission guard.
 *
 * Layering, stated once:
 *   - **registration** decides what the model can *see* (`src/tools/gated.js`),
 *   - **this guard** decides what it can *do*, per call, and it is monotonic —
 *     `ctx.tools.guard()` denies; no later listener can re-allow the call
 *     (verified against `@deepseek-ai/dsh-tools@0.2.0-rc.2`: guards run after the
 *     extensible `tools/pre-execute` waterfall and take a string as a refusal),
 *   - **`assertGrant`** inside each gated tool decides whether the *registration*
 *     that is running still belongs to a live grant.
 *
 * The middle layer is the one the spec asks for by name ("权限检查必须在工具执行
 * 时生效，不能仅靠提示词约束"). A prompt rule cannot stop a model that decides to
 * call `ana_remember`; a guard can, and the refusal comes back as the tool result
 * so the model learns the actual boundary instead of guessing at it.
 * @module dsh-anagenesis/permission/guard
 */

import { requiredTier } from './tiers.js'

/**
 * @param {{ permissions: import('./registry.js').PermissionRegistry, onDenied?: (detail: any) => void }} deps
 * @returns {(exec: any) => string | undefined} a `ctx.tools.guard()` handler
 */
export function createPermissionGuard(deps) {
  const { permissions } = deps
  return (exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || !name.startsWith('ana_')) return undefined
    // `exec.arguments` is the frozen parsed args (the host builds
    // `{ ...base, arguments: deepFreeze(detached) }`); `args` is kept as an alias
    // for older shapes and for the test stub, exactly like `createToolGuard` does.
    const args = exec?.arguments ?? exec?.args ?? {}
    const tier = requiredTier(name, args)
    if (tier === 'read') return undefined
    const verdict = permissions.check(name, args)
    if (verdict.ok) return undefined
    try {
      deps.onDenied?.({ tool: name, tier, gear: verdict.gear, reason: verdict.reason, args })
    } catch {
      // A bookkeeping failure must never turn a denial into an allow.
    }
    return `anagenesis: ${verdict.reason}`
  }
}

/**
 * Wrap a gated tool definition so that its own grant is re-checked at execution
 * time, not only at registration time.
 *
 * This is what makes the rollback exact: when the preset unloads, its grant is
 * revoked and the tools are disposed — but if a call was already in flight (or a
 * host caches a definition), the stale instance still refuses, because the grant
 * handle it closed over reports `live() === false`.
 * @template T
 * @param {T} definition a `defineTool()` result
 * @param {{ grant: { live: () => boolean }, permissions: import('./registry.js').PermissionRegistry, tier?: string }} deps
 * @returns {T}
 */
export function bindGrant(definition, deps) {
  const execute = /** @type {any} */ (definition).execute
  if (typeof execute !== 'function') return definition
  /** @type {any} */
  const wrapped = {
    ...definition,
    async execute(args, exec) {
      deps.permissions.assertGrant(deps.grant, /** @type {any} */ (definition).name, args)
      return execute(args, exec)
    },
  }
  return wrapped
}
