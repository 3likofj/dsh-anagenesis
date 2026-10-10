/**
 * The permission catalogue — which anagenesis tool may do what, and which gear
 * unlocks which tier.
 *
 * This lives in its own module because it is the **one** table three different
 * mechanisms read:
 *   1. registration — which tools exist at all (`src/tools/gated.js`);
 *   2. execution — the monotonic `ctx.tools.guard()` and the per-call
 *      `assertGrant()` inside gated tools;
 *   3. the status pulse and the visualization layer, which report the gear and
 *      the tool set the model is actually holding.
 *
 * Why the table is not derived from the tool definitions: `ToolDefinition` in
 * `@deepseek-ai/dsh-tools@0.2.0-rc.2` has **no** `readOnly` / `permission` /
 * `annotations` field (verified against the running host). The host's own idea
 * of a tool is "registered or not registered", so the plugin has to own the
 * classification — and owning it in one table is what keeps "what the model can
 * see" and "what the guard will allow" from drifting apart.
 * @module dsh-anagenesis/permission/tiers
 */

/** The three tiers, lowest first. The index is the comparison. */
export const TIERS = Object.freeze(['read', 'write', 'admin'])

/** @type {Record<string, number>} */
export const TIER_ORDER = Object.freeze({ read: 0, write: 1, admin: 2 })

/**
 * The gears, and the tiers each one exposes.
 *
 *   - `passive`    — read only. No write tool is registered anywhere.
 *   - `assisted`   — the agent may write, but only by calling a tool explicitly.
 *   - `autonomous` — the agent may also change its own strategies/tuning, change
 *                    its gear, re-file memories across scopes, and let the
 *                    autonomy policies schedule work without being asked.
 */
export const GEARS = Object.freeze({
  passive: Object.freeze({ tiers: Object.freeze(['read']), label: '只读', description: '不注册任何写入工具；模型只能读。' }),
  assisted: Object.freeze({ tiers: Object.freeze(['read', 'write']), label: '可写（人工触发）', description: '可写，但关键操作必须由 Agent 显式调用工具。' }),
  autonomous: Object.freeze({ tiers: Object.freeze(['read', 'write', 'admin']), label: '自治', description: '可写，且策略可自动调度、技能可自动结晶。' }),
})

export const GEAR_IDS = Object.freeze(Object.keys(GEARS))

/**
 * Ordering of the gears, for "the most permissive live grant wins" and for the
 * escalation check in `setGear`. It is deliberately a *separate* table from
 * `TIER_ORDER`: gears and tiers are different vocabularies, and indexing one
 * with the other silently reads `undefined` — which compares as "not greater"
 * and made every `assisted` grant report as `passive`.
 */
export const GEAR_ORDER = Object.freeze({ none: -1, passive: 0, assisted: 1, autonomous: 2 })

/** No grant at all — the state a session is in when the preset is not enabled. */
export const GEAR_NONE = 'none'

/**
 * Default tier of a tool. Anything not listed is treated as `write`, i.e.
 * denied unless a grant exists: an unknown tool must fail closed, never open.
 * @type {Record<string, 'read'|'write'|'admin'>}
 */
export const TOOL_TIERS = Object.freeze({
  // read tier — always registered, always allowed
  ana_recall: 'read',
  ana_list: 'read',
  ana_audit: 'read',
  ana_dashboard: 'read',
  ana_diagram: 'read',
  ana_window: 'read',
  ana_scope: 'read',
  ana_preset: 'read',
  ana_strategy: 'read',
  ana_tune: 'read',

  // write tier — registered only while a preset grant is live
  ana_remember: 'write',
  ana_promote: 'write',
  ana_demote: 'write',
  ana_lock: 'write',
  ana_expire: 'write',
  ana_split: 'write',
  ana_rethink: 'write',
  ana_forget: 'write',
  ana_link: 'write',
  ana_feedback: 'write',
})

/**
 * Per-action overrides. One tool can carry actions of different tiers, and
 * collapsing that into a single number would either lock a read out or let a
 * write in: `ana_strategy action="list"` is inspection, `action="switch"` is a
 * governance change.
 *
 * An action that is absent from a tool's map falls back to `TOOL_TIERS`, so
 * adding an action without classifying it fails closed (write), never open.
 * @type {Record<string, Record<string, 'read'|'write'|'admin'>>}
 */
export const ACTION_TIERS = Object.freeze({
  ana_strategy: Object.freeze({
    list: 'read',
    health: 'read',
    switch: 'admin',
    preset: 'admin',
    push: 'admin',
    register: 'admin',
    derive: 'admin',
    deactivate: 'admin',
    revert: 'admin',
  }),
  ana_tune: Object.freeze({
    report: 'read',
    proposal: 'read',
    propose: 'read',
    apply: 'admin',
    rollback: 'admin',
    evaluate: 'read',
  }),
  ana_scope: Object.freeze({
    status: 'read',
    list: 'read',
    namespaces: 'read',
    retag: 'admin',
    adopt: 'admin',
    'drop-session': 'admin',
  }),
  ana_preset: Object.freeze({
    status: 'read',
    tools: 'read',
    gear: 'admin',
  }),
})

/**
 * The tier a call actually needs.
 * @param {string} name
 * @param {any} [args]
 * @returns {'read'|'write'|'admin'}
 */
export function requiredTier(name, args) {
  const action = args?.action
  const map = ACTION_TIERS[name]
  if (map !== undefined && typeof action === 'string' && map[action] !== undefined) return map[action]
  return TOOL_TIERS[name] ?? 'write'
}

/**
 * Is `tier` covered by `gear`?
 * @param {string} gear
 * @param {string} tier
 * @returns {boolean}
 */
export function gearCovers(gear, tier) {
  const spec = GEARS[gear]
  if (spec === undefined) return false
  return spec.tiers.includes(tier)
}

/**
 * The tools a gear exposes, by name. Used by the pulse and the dashboard, so the
 * model and the human see the same list the guard enforces.
 * @param {string} gear
 * @returns {string[]}
 */
export function toolsForGear(gear) {
  if (gear === GEAR_NONE) return Object.keys(TOOL_TIERS).filter((name) => TOOL_TIERS[name] === 'read')
  return Object.keys(TOOL_TIERS).filter((name) => gearCovers(gear, requiredTier(name)))
}

/**
 * Write-tier tool names, in one place: the gated row registers exactly these,
 * and a test asserts that list against the catalogue.
 * @returns {string[]}
 */
export function gatedToolNames() {
  return Object.keys(TOOL_TIERS).filter((name) => TOOL_TIERS[name] === 'write').sort()
}

/**
 * Admin-tier capabilities (tools or single actions) — reported in the pulse so
 * an agent in `assisted` knows what it does not have.
 * @returns {string[]}
 */
export function adminCapabilities() {
  const out = []
  for (const [name, tier] of Object.entries(TOOL_TIERS)) if (tier === 'admin') out.push(name)
  for (const [name, actions] of Object.entries(ACTION_TIERS)) {
    for (const [action, tier] of Object.entries(actions)) if (tier === 'admin') out.push(`${name}:${action}`)
  }
  return out.sort()
}
