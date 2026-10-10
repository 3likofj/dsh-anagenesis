/**
 * anagenesis-core — the service row.
 *
 * Publishes `ctx.anagenesis` (store + strategy registry + engine + tuner + ops).
 * It owns no tool and no preset: those live in their own rows so a failure in
 * the meta layer cannot take the journal down with it.
 *
 * DSH integration, explicitly:
 *   - SERVICE      `ctx.provide('anagenesis', service)` returns a disposer and
 *                  Cordis withdraws the service automatically when this fiber
 *                  unloads (verified against @deepseek-ai/cordis 4.x
 *                  `ctx.reflect.provide`). Dependents declare `inject`.
 *   - REVERTIBLE   everything this row creates is inside one `ctx.effect`:
 *                  the store handle, the invariant gate, the sweep timer.
 *   - COEFFECT     the engine composes strategies from the store snapshot on
 *                  demand and the registry invalidates its cache per store
 *                  version, so another component's strategy switch is picked up
 *                  by the next recall with no manual wiring. `store.on('*')`
 *                  gives consumers the same reactivity for state changes.
 * @module dsh-anagenesis/index
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'

import { MemoryStore } from './store/store.js'
import { SCHEMA_VERSION, isLegacyUnscoped } from './store/schema.js'
import { createMemoryOps } from './memory/ops.js'
import { recall as runRecall } from './memory/recall.js'
import { resolveEmbedder } from './memory/embed.js'
import { StrategyRegistry, DEFAULT_STACK } from './strategy/registry.js'
import { StrategyEngine } from './strategy/engine.js'
import { Tuner } from './meta/tuner.js'
import { runReflection } from './meta/reflect.js'
import { createInvariantGate, InvariantViolation } from './guard/invariants.js'
import {
  SCOPE_TIERS, buildPulse, createScopeFilter, createScopeResolver, fingerprintProject,
  namespaceCounts, projectLabel, scopeLabel, scopeMatch,
} from './scope/index.js'
import { createPermissions } from './permission/registry.js'
import { GEAR_NONE, gearCovers, toolsForGear } from './permission/tiers.js'
import { createPermissionGuard } from './permission/guard.js'

export const name = 'anagenesis-core'

/** No hard dependencies: the store must be able to open even if tools/agents are absent. */
export const inject = []

// 存储位置的解析住在 `./paths.js`（无宿主依赖），这样 CLI 工具能直接复用而不必
// 先装一套宿主加载器。这里**既 import 又 re-export**：只写 `export … from` 的话
// 本模块内部拿不到本地绑定，而第 50 行的 `defaultRootDir()` 就在本模块里用。
import { CURRENT_ROOT_DIR_NAME, LEGACY_ROOT_DIR_NAME, defaultRootDir, dshHome, resolveRootDir } from './paths.js'

export { CURRENT_ROOT_DIR_NAME, LEGACY_ROOT_DIR_NAME, defaultRootDir, dshHome, resolveRootDir }

export const Config = Schema.object({
  rootDir: Schema.string().default(defaultRootDir())
    .description('存储根目录。默认 $DSH_HOME/anagenesis；若新目录还没有东西、而旧包名的目录里已经有记忆，会自动回退到旧目录读取（数据一条不动）。'),
  safeMode: Schema.boolean().default(false)
    .description('安全模式：冻结调参器与自我反思；只读的观察与召回照常。'),
  persistDebounceMs: Schema.number().default(250)
    .description('写盘去抖（毫秒）：把连续的事务合批落盘，减少 I/O。'),
  recallDefaultTokenBudget: Schema.number().default(1600)
    .description('召回默认的 token 预算；策略栈没有另行指定时使用。'),
  hookBudgetMs: Schema.number().default(8)
    .description('单个策略 hook 的时间预算（毫秒）：超时按失败计，不拖住整次召回。'),
  sweepIntervalMs: Schema.number().default(300_000)
    .description('过期记忆清扫的间隔（毫秒）。'),
  autoSweepExpired: Schema.boolean().default(true)
    .description('是否自动清扫已过期的记忆；清扫同样走正常事务，因此可审计、可回滚。'),
  // Journal compaction: fold the live log into `archive-*.jsonl` +
  // `checkpoint-*.json` once it grows past this many live events. 0 disables it.
  // The archive keeps every seq traceable and every `undo`, so nothing an agent
  // can observe (audit trail, revertibility) changes — only the file layout.
  compactAfterEvents: Schema.number().default(2000)
    .description('活跃日志事件超过这个数，就把日志折叠成 archive-*.jsonl + checkpoint-*.json；0 = 关闭压缩。'),
  compactIntervalMs: Schema.number().default(3_600_000)
    .description('检查是否需要压缩的间隔（毫秒）。'),
  // Archive layout. Each compaction *appends* one archive segment; once the
  // count passes this, the oldest segments are merged into one. Nothing is
  // dropped by merging, so this only trades a bounded rewrite for a bounded
  // directory. 0 = no bound.
  archiveMaxSegments: Schema.number().default(16)
    .description('归档段的数量上限；超过后把最旧的几段合并为一段（合并不丢事件）。0 = 不设上限。'),
  // The one lossy policy, and it is off by default: with `retainEvents > 0`,
  // whole archive segments older than the most recent N events are deleted at
  // compaction time. Those seqs stop being revertible (`ana_audit view=status`
  // reports the prune marker, and `revert` says the policy dropped it, instead
  // of pretending the seq never existed). Leave it at 0 to keep every seq.
  retainEvents: Schema.number().default(0)
    .description('唯一的有损策略，默认关闭：大于 0 时，压缩会删掉比最近 N 条事件更旧的整段归档，那些 seq 不再可回滚（状态视图会报告 prune 标记）。保持 0 则每个 seq 都可回滚。'),
  // Which vector backend to open with. 'hash' is the built-in, dependency-free
  // one; a real semantic backend is installed at runtime through
  // `service.useEmbedder(...)` and then applied to stored vectors with
  // `service.reembed()`. Keeping it in config means a host can pick a
  // code-registered provider without an API call.
  embedProvider: Schema.string().default('hash')
    .description('使用哪个向量后端：hash 是内置的零依赖实现；真正的语义后端可在运行时用 useEmbedder() 装入，再用 reembed() 应用到已存向量。'),
  // Reflection: on a timer, question the established beliefs whose evidence has
  // visibly decayed. It only ever files a draft hypothesis through the same
  // `ops.rethink` path an agent uses, so it stays inside tier-1 — but it does
  // write, which is why it is switchable and why each run is bounded.
  reflectionEnabled: Schema.boolean().default(true)
    .description('是否启用定时反思：质疑那些证据已明显衰减的既有信念，并且只以 draft 假设的形式归档。'),
  reflectIntervalMs: Schema.number().default(6 * 3600 * 1000)
    .description('反思的触发间隔（毫秒）。'),
  reflectionStaleAfterMs: Schema.number().default(30 * 24 * 3600 * 1000)
    .description('证据多久没被引用就算「衰减」（毫秒）；只有超过它的既有信念才会被拿去反思。'),
  maxReflectionsPerRun: Schema.number().default(2)
    .description('每次反思最多归档几条假设。'),
  // ── scope isolation ────────────────────────────────────────────────────────
  // The tier a write lands in when the caller named none. `project` is the
  // default and it is the whole point of the change: "no scope given" used to
  // mean "global", which is how one project's experience ended up being recalled
  // in another. A host that genuinely wants the old behaviour can say so here,
  // explicitly, and the choice is then visible in the config.
  defaultScopeTier: Schema.string().default('project')
    .description('没有显式指定作用域时，记忆落在哪一层：project（默认，当前项目）| global（跨项目通用）| session（临时任务）。'),
  workspace: Schema.string().default('')
    .description('显式指定"当前项目"的工作目录。留空时用工具调用携带的 cwd（真宿主：exec.agent.session.header.cwd），再退回进程 cwd。'),
  sessionTtlMs: Schema.number().default(24 * 3600 * 1000)
    .description('会话级记忆的默认存活时间（毫秒）；0 表示不过期。会话级记忆的任务结束即废弃，靠这个 TTL 自动过期（走普通事务，可回滚）。'),
  recallCrossProjectDefault: Schema.boolean().default(false)
    .description('是否默认把其它项目的记忆纳入召回。默认 false —— 跨项目检索必须显式授权，而且回来时会被降权并逐条标注。'),
  registerPermissionGuard: Schema.boolean().default(true)
    .description('是否在核心行内安装执行期权限护栏（只有 core 被单独挂载、没有 guard 行时的兜底）。guard 行也会安装同一道护栏，重复安装是幂等的。'),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 * @returns {Promise<void>} nothing — Cordis collects an `apply` result as an
 *   effect, and a plain object is rejected with `TypeError: Invalid effect`
 */
export async function apply(ctx, config = {}) {
  const logger = adapterLogger(ctx)

  // Idempotent mount. The bundle row mounts this plugin globally, and the
  // `anagenesis` preset mounts it again inside the preset's own scope. If a
  // service is already visible through the scope chain, adopt it instead of
  // publishing a second one: `ctx.provide` refuses a duplicate name in one
  // isolation scope, and a second registry/engine/tuner over the same store
  // would be pure duplication (the store itself is already reference counted).
  const existing = ctx.get?.('anagenesis', false)
  if (existing !== undefined) {
    logger.info('anagenesis: reusing the already-provided service in this scope')
    return
  }

  // 存储根的解析走 resolveRootDir()：它会在新目录不存在时回退到旧包名用的目录，
// 老用户升级上来才不会看到一个空存储。
  const resolved = resolveRootDir(config.rootDir)
  const rootDir = resolved.rootDir
  const safeMode = config.safeMode === true

  // The active vector backend. Everything that embeds — new records, recall
  // queries, re-embedding — goes through this one indirection, so installing a
  // real backend at runtime cannot leave half the store in the old space.
  let activeEmbedder = resolveEmbedder(config.embedProvider ?? 'hash')
  const embedFn = (text) => activeEmbedder.embed(text)

  const { store, shared } = await MemoryStore.acquire({
    rootDir,
    logger,
    embed: embedFn,
    clock: { now: () => Date.now(), debounceMs: config.persistDebounceMs ?? 250 },
  })
  if (shared) logger.info('anagenesis: attaching to the already-open store for this rootDir (single-writer pool)')
  // 兼容路径必须**可见**：用户需要知道自己的数据还在旧目录里、以及怎么搬。
  if (resolved.source === 'legacy') {
    logger.warn(`anagenesis: 沿用旧包名的存储目录 ${rootDir}（数据一条没动）。`
      + `要改用新目录请运行 \`node tools/migrate-store.mjs --apply\`（复制并校验，不删除源目录），`
      + `或在配置里显式设置 rootDir`)
  }

  const registry = new StrategyRegistry({ store, logger })
  const tuner = new Tuner({ store, registry, logger, safeMode })

  // ── scope isolation + permission layer ────────────────────────────────────
  // `scopeResolver` is the single place a "where am I" question is answered, and
  // `permissions` is the single place a "may I write" question is answered. Both
  // are created before `ops`, because the write path needs them injected:
  //   - `defaultScope` is what "the caller named no scope" means, and it now
  //     means *this project* (configurable, but never silently global);
  //   - `projectRegistry` gives a first-seen project fingerprint a human label
  //     through an ordinary invertible `projectSet` patch.
  const scopeResolver = createScopeResolver({ fallbackCwd: () => config.workspace ?? process.cwd(), logger })
  const permissions = createPermissions({
    logger,
    onChange: (snapshot) => { ctx.emit?.('anagenesis/permissions', snapshot) },
  })
  const defaultTier = ['global', 'project', 'session'].includes(String(config.defaultScopeTier))
    ? String(config.defaultScopeTier)
    : 'project'
  const sessionTtlMs = Math.max(0, Number(config.sessionTtlMs ?? 24 * 3600 * 1000))

  const currentDefaultScope = () => {
    const identity = scopeResolver.current()
    return {
      tier: defaultTier,
      projectId: identity.id,
      workspace: identity.root,
      sessionTtlMs,
      origin: 'default',
    }
  }

  const ops = createMemoryOps({
    store,
    embed: embedFn,
    defaultScope: currentDefaultScope,
    projectRegistry: (state, scope, now) => scopeResolver.registryPatch(state, scope, now),
  })
  const engine = new StrategyEngine({
    registry,
    logger,
    options: {
      hookBudgetMs: config.hookBudgetMs ?? 8,
      safeMode,
      onEvent: (type, detail) => {
        // Observability is best-effort and must never throw into a hook.
        void store.audit(`engine.${type}`, detail).catch(() => {})
      },
    },
  })

  // Observable state for the reflection timer; `status()` reads it so an agent
  // can see whether the engine has been questioning itself.
  const reflection = {
    enabled: config.reflectionEnabled !== false,
    lastRunAt: /** @type {number|null} */ (null),
    lastFiled: 0,
    lastHypotheses: /** @type {string[]} */ ([]),
  }

  /** @type {import('./index.js').AnagenesisService} */
  const service = {
    name: 'anagenesis',
    version: SCHEMA_VERSION,
    rootDir,
    safeMode,
    store,
    registry,
    engine,
    tuner,
    ops,
    permissions,
    defaults: { stack: [...DEFAULT_STACK], tokenBudget: config.recallDefaultTokenBudget ?? 1600 },
    /**
     * Where a call is happening: project identity, scope tag, namespace and the
     * closed-set filter for this caller. Every tool call, every write and the
     * pulse go through it, so "which project am I in" has exactly one answer.
     * @param {any} [exec] the host's tool execution object (or `{}`)
     * @param {{ tier?: string, crossProject?: boolean, reason?: string }} [explicit]
     * @returns {{ identity: any, scope: any, namespace: string, tier: string, filter: any }}
     */
    scopeFor(exec, explicit = {}) {
      return scopeResolver.forCall(exec, {
        ...explicit,
        tier: explicit.tier,
        crossProject: explicit.crossProject === true || config.recallCrossProjectDefault === true,
      })
    },
    /**
     * The scope tag a write lands in. Unlike `scopeFor` (which describes the
     * caller), this resolves the *record's* scope: an explicit request wins,
     * otherwise the configured default tier in the caller's project.
     * @param {any} [exec]
     * @param {any} [explicit] the tool's `scope` argument (new shape, with a
     *   legacy shape `{global, session, workspace, preset}` still accepted)
     * @returns {any} a scope tag for `createMemory`
     */
    writeScope(exec, explicit) {
      const context = scopeResolver.forCall(exec)
      const wanted = normalizeScopeRequest(explicit)
      if (wanted.tier === null) {
        return {
          ...context.scope,
          tier: defaultTier,
          origin: 'default',
          sessionTtlMs,
        }
      }
      // A tier with no id to bind to degrades *narrower*, never wider: asking for
      // a project while the project is unknown lands in the session, and a session
      // without an id lands in the project. The one thing it never does is
      // silently become global.
      return {
        tier: wanted.tier,
        projectId: wanted.projectId ?? context.identity.id,
        sessionId: wanted.sessionId ?? context.sessionId ?? null,
        presetId: wanted.preset ?? null,
        workspace: context.identity.root,
        profile: null,
        origin: 'explicit',
        sessionTtlMs,
      }
    },
    /**
     * May this caller read this record? The same closed-set judgment recall uses,
     * exposed for the by-id read path (`ana_audit view=memory`) so it cannot be
     * used to step around the filter.
     * @param {any} record
     * @param {any} [exec]
     * @param {boolean} [crossProject]
     * @returns {{ ok: boolean, relation: string, reason: string }}
     */
    canRead(record, exec, crossProject = false) {
      const context = scopeResolver.forCall(exec)
      const filter = createScopeFilter({
        projectId: context.identity.id,
        sessionId: context.sessionId,
        crossProject: crossProject === true,
      })
      const verdict = scopeMatch(record, filter)
      return { ok: verdict.ok, relation: verdict.relation, reason: verdict.reason }
    },
    /**
     * @param {{ limit?: number, states?: string[], kinds?: string[], crossProject?: boolean, exec?: any }} [request]
     * @returns {Promise<{ rows: any[], counts: any, project: string, namespace: string }>}
     */
    async listMemories(request = {}) {
      const context = scopeResolver.forCall(request.exec)
      const filter = createScopeFilter({
        projectId: context.identity.id,
        sessionId: context.sessionId,
        crossProject: request.crossProject === true,
      })
      const limit = Math.max(1, Math.min(Number(request.limit ?? 25) || 25, 200))
      const rows = []
      for (const record of Object.values(store.state.memories)) {
        if (record.state === 'retired') continue
        if (Array.isArray(request.states) && request.states.length > 0 && !request.states.includes(record.state)) continue
        if (Array.isArray(request.kinds) && request.kinds.length > 0 && !request.kinds.includes(record.kind)) continue
        const verdict = scopeMatch(record, filter)
        if (!verdict.ok) continue
        rows.push({
          id: record.id,
          scope: scopeLabel(record.scope),
          relation: verdict.relation,
          project: record.scope.projectId === null ? null : projectLabel(store.state, record.scope.projectId),
          kind: record.kind,
          state: record.state,
          confidence: Number(record.confidence.toFixed(3)),
          salience: Number(record.salience.toFixed(3)),
          createdAt: record.createdAt,
          gist: record.gist.slice(0, 160),
        })
      }
      rows.sort((a, b) => b.createdAt - a.createdAt)
      return {
        rows: rows.slice(0, limit),
        counts: {
          matched: rows.length,
          byScope: countBy(rows, (row) => row.scope.split(':')[0]),
          byNamespace: countBy(rows, (row) => row.relation),
          store: namespaceCounts(store.state),
        },
        project: context.identity.id,
        namespace: context.namespace,
      }
    },
    /**
     * The scope report: which projects this store knows, how many memories each
     * namespace physically holds, and where this caller stands. It is what
     * `ana_audit view=scope` and the dashboard print.
     * @param {any} [exec]
     * @returns {any}
     */
    scopeReport(exec) {
      const context = scopeResolver.forCall(exec)
      const counts = namespaceCounts(store.state)
      /** @type {Record<string, any>} */
      const namespaces = {}
      for (const [namespace, count] of Object.entries(counts.byNamespace)) {
        const [kind, ...rest] = namespace.split(':')
        namespaces[namespace] = {
          count,
          tier: kind === 'global' ? 'global' : kind,
          projectId: kind === 'project' ? rest.join(':') : null,
          label: kind === 'project' ? projectLabel(store.state, rest.join(':')) : namespace,
          current: namespace === context.namespace,
        }
      }
      return {
        current: {
          namespace: context.namespace,
          tier: context.tier,
          projectId: context.identity.id,
          projectLabel: context.identity.label,
          basis: context.identity.basis,
          root: context.identity.root,
          remote: context.identity.remote,
          workspace: context.identity.root,
          session: context.sessionId,
        },
        defaultScopeTier: defaultTier,
        sessionTtlMs,
        crossProjectDefault: config.recallCrossProjectDefault === true,
        knownProjects: Object.values(store.state.projects ?? {}).map((entry) => ({
          id: entry.id,
          label: entry.label,
          kind: entry.kind,
          root: entry.root,
          remote: entry.remote,
          firstSeenAt: entry.firstSeenAt,
          lastSeenAt: entry.lastSeenAt,
          current: entry.id === context.identity.id,
          memories: counts.byNamespace[`project:${entry.id}`] ?? 0,
        })),
        namespaces,
        totals: counts.byTier,
        journalNamespaces: store.journalStats().byNamespace ?? {},
      }
    },
    /**
     * The session status pulse: the one line an agent must be able to see to make
     * "check the scope before you trust a memory" an executable rule rather than a
     * slogan. It is emitted (a) inside every recall block and (b) — when the
     * preset row can reach the prompt service — once per step through
     * `systemPrompt.context()`.
     * @param {any} [exec]
     * @param {{ conflicts?: number, crossProject?: boolean, session?: string }} [extra]
     * @returns {{ text: string, data: any }}
     */
    pulse(exec, extra = {}) {
      const context = scopeResolver.forCall(exec)
      return buildPulse({
        projectId: context.identity.id,
        projectLabel: context.identity.label,
        tier: context.tier,
        sessionId: context.sessionId ?? extra.session ?? null,
        gear: permissions.gear(),
        preset: permissions.activeCount() > 0 ? 'anagenesis' : null,
        allowed: permissions.allowedTools(),
        crossProject: extra.crossProject === true,
        conflicts: extra.conflicts ?? 0,
      })
    },
    /**
     * @param {any} [exec]
     * @returns {any} preset + gear + toolset + scope, for `ana_preset`/dashboard
     */
    permissionReport(exec) {
      const context = scopeResolver.forCall(exec)
      const gear = permissions.gear()
      return {
        preset: permissions.activeCount() > 0 ? 'anagenesis' : null,
        presetActive: permissions.activeCount() > 0,
        gear,
        gearLabel: gear === GEAR_NONE ? '未启用预设' : gear,
        grants: permissions.describe().scopeKeys,
        tools: permissions.allowedTools(),
        writeToolsAvailable: gearCovers(gear, 'write'),
        adminAvailable: gearCovers(gear, 'admin'),
        readOnlyTools: toolsForGear('passive'),
        scope: {
          namespace: context.namespace,
          tier: context.tier,
          projectId: context.identity.id,
          projectLabel: context.identity.label,
          session: context.sessionId,
        },
      }
    },
    /**
     * Change the gear. Journaled, and it returns the inverse — switching the gear
     * is as revertible as switching a strategy stack.
     * @param {string} gear
     * @param {{ reason?: string, by?: string, force?: boolean }} [opts]
     * @returns {Promise<{ gear: string, previous: string, seq: number, revert: () => Promise<any> }>}
     */
    async setGear(gear, opts = {}) {
      const change = permissions.setGear(gear, {
        reason: opts.reason ?? '',
        by: opts.by ?? 'agent',
        // Raising the gear is only ever allowed for the host (or when the current
        // gear already covers the target): an agent must not be able to widen its
        // own permissions. Lowering is always allowed.
        force: opts.force === true,
      })
      const result = await store.transact({
        auditAppend: [{
          id: `gear_${Date.now().toString(36)}`,
          at: Date.now(),
          type: 'permission.gear',
          detail: { from: change.previous, to: change.applied, by: opts.by ?? 'agent', reason: opts.reason ?? null },
        }],
      }, { type: 'permission.gear', scope: 'global', by: opts.by ?? 'agent', payload: { from: change.previous, to: change.applied } })
      return {
        gear: change.applied,
        previous: change.previous,
        seq: result.seq,
        /**
         * Put the gear back. Note what is *not* reverted: the audit row. The store
         * refuses to compensate an audit-only event on purpose — an audit entry
         * records that something happened, and a rollback that erased the record
         * of the change it rolled back would be a lie (see `MemoryStore.revert`).
         * The gear itself is runtime state, so dropping the override *is* the
         * inverse; the journal keeps the history of both.
         */
        revert: async () => {
          change.dispose()
          return { gear: permissions.gear(), auditSeq: result.seq }
        },
      }
    },
    /**
     * End a session's temporary memories: everything in `session:<id>` becomes
     * expired in one ordinary transaction, so it is revertible like any other
     * expiry. "任务结束即废弃" is a policy, not a special cleanup path.
     * @param {string} sessionId
     * @param {string} [reason]
     * @returns {Promise<any>}
     */
    async dropSession(sessionId, reason = 'session ended') {
      const prefix = `session:${String(sessionId)}`
      /** @type {string[]} */
      const ids = []
      for (const record of Object.values(store.state.memories)) {
        if (record.state === 'retired' || record.state === 'expired') continue
        if (record.scope?.tier !== 'session' || record.scope.session !== String(sessionId)) continue
        ids.push(record.id)
      }
      if (ids.length === 0) return { ok: true, ids: [], noop: true, namespace: prefix }
      const result = await ops.expire({ ids, reason: `session dropped: ${reason}` })
      return { ok: true, ids, seq: result.seq, namespace: prefix }
    },
    /**
     * @param {object} request
     * @param {{ params?: any, scope?: string, exec?: any, crossProject?: boolean, reason?: string }} [opts]
     */
    async recall(request, opts = {}) {
      const scope = opts.scope ?? 'global'
      const params = { ...(store.state.params[scope] ?? {}), ...(opts.params ?? {}) }
      const context = scopeResolver.forCall(opts.exec, {
        crossProject: opts.crossProject === true || config.recallCrossProjectDefault === true,
        reason: opts.reason ?? '',
      })
      const pulse = buildPulse({
        projectId: context.identity.id,
        projectLabel: context.identity.label,
        tier: context.tier,
        sessionId: context.sessionId,
        gear: permissions.gear(),
        preset: permissions.activeCount() > 0 ? 'anagenesis' : null,
        allowed: permissions.allowedTools(),
        crossProject: context.filter.crossProject,
      })
      const result = await runRecall(store, request, {
        params,
        engine: engine.forScope(scope),
        scope,
        embed: embedFn,
        context: {
          scopeFilter: context.filter,
          pulse,
        },
      })
      await store.audit('recall', {
        intent: result.intent,
        selected: result.selected.length,
        dropped: result.dropped,
        tokens: result.tokenCost,
        strategy: result.strategy,
        scope: {
          projectId: context.identity.id,
          namespace: context.namespace,
          crossProject: context.filter.crossProject,
          admittedCrossProject: result.scope?.admittedCrossProject ?? 0,
          conflicts: result.conflicts?.length ?? 0,
        },
        // The authorization is recorded where it can be reviewed. A cross-project
        // recall is a deliberate act, and the audit trail is where "who decided
        // to trust another project's experience" belongs.
        authorization: context.filter.crossProject ? { by: 'agent', reason: opts.reason ?? '' } : null,
        project: context.identity.id,
      }, {
        scope,
        // One recall call is one observation, whether or not anything was
        // selected; folded into the same transaction as the audit row so
        // `stats.recalls` can never disagree with the journal.
        stats: { recalls: (store.state.stats?.recalls ?? 0) + 1 },
      })
      return result
    },
    /**
     * Install a vector backend at runtime; returns the disposer that restores
     * the previous one.
     *
     * It deliberately does **not** touch stored vectors — that is `reembed()`'s
     * job, and until that runs `status().embed.stale` stays true so nobody has
     * to guess which space the store is in.
     * @param {string|{ id: string, dim?: number, embed: (text: string) => number[] }} spec
     * @returns {() => void}
     */
    useEmbedder(spec) {
      const previous = activeEmbedder
      activeEmbedder = resolveEmbedder(spec)
      logger.info(`anagenesis: embedding backend is now "${activeEmbedder.id}" (${activeEmbedder.dim}d); stored vectors are "${store.state.embed?.id ?? 'unknown'}" until reembed()`)
      return () => { activeEmbedder = previous }
    },
    /** @returns {Promise<any>} recompute every stored vector with the active backend */
    async reembed() {
      return ops.reembed({ id: activeEmbedder.id, dim: activeEmbedder.dim })
    },
    /** @returns {any} a compact health/observability snapshot for `ana_audit` */
    status() {
      const state = store.state
      const scope = scopeResolver.current()
      const counts = namespaceCounts(state)
      const gear = permissions.gear()
      return {
        version: state.version,
        schemaVersion: state.schemaVersion,
        rootDir,
        safeMode,
        memories: Object.keys(state.memories).length,
        byState: countBy(state.memories, (record) => record.state),
        byKind: countBy(state.memories, (record) => record.kind),
        // Scope isolation, in the one place a status view asks for it: which
        // namespaces hold how many memories, which project this process is in, and
        // how many records are still untagged legacy.
        scope: {
          current: {
            projectId: scope.id,
            projectLabel: scope.label,
            namespace: `project:${scope.id}`,
            basis: scope.basis,
            root: scope.root,
          },
          defaultScopeTier: defaultTier,
          sessionTtlMs,
          byTier: counts.byTier,
          byNamespace: counts.byNamespace,
          knownProjects: Object.keys(state.projects ?? {}).length,
          legacyUntagged: Object.values(state.memories).filter((record) => isLegacyUnscoped(record)).length,
        },
        // The permission layer, so "why can't I write" is answerable from state
        // instead of from a guess about which preset is on.
        permissions: {
          gear,
          presetActive: permissions.activeCount() > 0,
          grants: permissions.describe().scopeKeys,
          allowedTools: permissions.allowedTools(),
          writeToolsAvailable: gearCovers(gear, 'write'),
          adminAvailable: gearCovers(gear, 'admin'),
        },
        stacks: state.stacks,
        strategies: Object.keys(state.strategies).length,
        stats: state.stats,
        engine: { active: engine.describe(), health: engine.health() },
        tuning: tuner.report(),
        reflection: { ...reflection },
        // Journal layout and, when the optional retention policy has ever run,
        // what it dropped: a pruned seq must be explainable from status alone.
        journal: store.journalStats(),
        embed: {
          active: activeEmbedder.id,
          dim: activeEmbedder.dim,
          stored: state.embed?.id ?? null,
          storedDim: state.embed?.dim ?? null,
          // True whenever the stored vectors were produced by a different
          // backend than the active one: recall would be comparing spaces.
          stale: (state.embed?.id ?? null) !== activeEmbedder.id || (state.embed?.dim ?? null) !== activeEmbedder.dim,
        },
        lastEvents: store.recentEvents({ limit: 5 }).map((event) => ({ seq: event.seq, type: event.type, ns: event.ns })),
      }
    },
  }

  // Close the race the fast-path check above cannot: everything between that
  // check and `provide` awaits (opening the store, building the layers), so a
  // *concurrent* mount of this same row — the profile bundle mounts
  // `anagenesis-core` globally while the `anagenesis` preset mounts it again —
  // can publish the service in the meantime. The loser then hit
  //   service "anagenesis" has been registered at <anagenesis-core>
  // and the preset registry reported the whole preset as broken. There is no
  // await between this check and the `provide` below, and the fiber cannot be
  // preempted in between, so the window is genuinely closed.
  const publishedWhileOpening = ctx.get?.('anagenesis', false)
  if (publishedWhileOpening !== undefined) {
    // Give back the reference we took; the other mount owns the store now.
    await store.release()
    logger.info('anagenesis: another mount published the service while this one was opening the store; adopting it')
    return
  }

  // One effect owns the whole lifetime: the service, the invariant gate, the
  // sweep timer, the state bridge and the journal handle all disappear together
  // when the plugin unloads.
  //
  // NOTE on the row contract: Cordis collects an `apply` result as an *effect*.
  // A function is collected as a disposer, null/undefined is accepted, a promise
  // is awaited and its resolved value collected — but any other object throws
  // `TypeError: Invalid effect`, and the resulting fibre teardown rolls back
  // every effect the body already created. That is why this `async` apply
  // returns nothing instead of a `{ dispose }` handle.
  ctx.effect(() => {
    const provideDisposer = ctx.provide('anagenesis', service)
    const gateDisposer = store.use(createInvariantGate({ safeMode, logger }))
    const timerDisposer = startSweep(ops, config, logger)
    const compactionDisposer = startCompaction(store, config, logger)
    const reflectionDisposer = startReflection({ store, ops, logger, config, state: reflection })
    // The execution-time permission guard, as a fallback for a host that mounts
    // only the core row. When the guard row is present it installs the same guard;
    // duplicates are harmless (a guard is monotonic — the first refusal wins and
    // no later guard can force-allow), which is exactly why installing it twice is
    // preferable to installing it nowhere.
    const guardDisposer = installPermissionGuard(ctx, permissions, config, logger)
    const stateListener = store.on('*', (payload, event) => {
      ctx.emit?.('anagenesis/state', { seq: event.seq, type: event.type, payload })
    })
    return async () => {
      stateListener.dispose()
      guardDisposer()
      reflectionDisposer()
      compactionDisposer()
      timerDisposer()
      gateDisposer.dispose()
      if (typeof provideDisposer === 'function') provideDisposer()
      await store.release()
    }
  })

  logger.info(`anagenesis: store ready at ${rootDir} (schema v${SCHEMA_VERSION}, ${Object.keys(store.state.memories).length} memories)`)
  ctx.emit?.('anagenesis/ready', { rootDir, version: store.version })
}

/**
 * Normalize the `scope` argument a write tool received into a tier request.
 *
 * Three input shapes are accepted, and the order they are tried in is the order
 * of explicitness:
 *   1. the new shape — `{ tier, projectId?, sessionId? }` (a tier named outright);
 *   2. the legacy shape — `{ global: true }` / `{ session: id }` / `{ workspace: path }`,
 *      which mapped onto today's tiers without changing the meaning;
 *   3. nothing — `{ tier: null }`, and the caller falls back to the configured
 *      default tier in the caller's project.
 *
 * A legacy `workspace` path is *resolved* into the project fingerprint of that
 * path rather than being stored as a string: the path is machine-specific, the
 * fingerprint is the identity, and this is the same function the migration uses.
 * @param {any} explicit
 * @returns {{ tier: string|null, projectId?: string|null, sessionId?: string|null, preset?: string|null }}
 */
export function normalizeScopeRequest(explicit) {
  if (explicit === undefined || explicit === null) return { tier: null }
  if (typeof explicit === 'string') {
    return SCOPE_TIERS.includes(explicit) ? { tier: explicit } : { tier: null }
  }
  if (typeof explicit !== 'object') return { tier: null }
  const tier = SCOPE_TIERS.includes(String(explicit.tier)) ? String(explicit.tier) : null
  if (tier !== null) {
    return {
      tier,
      projectId: explicit.projectId ?? null,
      sessionId: explicit.sessionId ?? explicit.session ?? null,
      preset: explicit.preset ?? null,
    }
  }
  if (explicit.global === true) return { tier: 'global' }
  if (typeof explicit.session === 'string' && explicit.session !== '') {
    return { tier: 'session', sessionId: explicit.session, preset: explicit.preset ?? null }
  }
  if (typeof explicit.workspace === 'string' && explicit.workspace.trim() !== '') {
    return { tier: 'project', projectId: fingerprintProject({ cwd: explicit.workspace }).id, preset: explicit.preset ?? null }
  }
  if (typeof explicit.projectId === 'string' && explicit.projectId !== '') {
    return { tier: 'project', projectId: explicit.projectId, preset: explicit.preset ?? null }
  }
  return { tier: null }
}

/**
 * Install the tier guard through the host's tools service when it is reachable
 * from this scope. The core row declares no `tools` dependency (the store must
 * open even on a host with no tool layer), so this is a non-strict read and a
 * silent no-op when the service is absent.
 * @param {any} ctx
 * @param {import('./permission/registry.js').PermissionRegistry} permissions
 * @param {any} config
 * @param {any} logger
 * @returns {() => void} disposer (always callable)
 */
function installPermissionGuard(ctx, permissions, config, logger) {
  if (config.registerPermissionGuard === false) return () => {}
  const tools = typeof ctx.get === 'function' ? ctx.get('tools', false) : undefined
  if (tools === undefined || tools === null || typeof tools.guard !== 'function') return () => {}
  const disposer = tools.guard(createPermissionGuard({
    permissions,
    onDenied: (detail) => {
      logger.warn?.(`anagenesis: refused ${detail.tool} (${detail.tier} tier, gear ${detail.gear}): ${detail.reason}`)
    },
  }))
  return () => { if (typeof disposer === 'function') disposer() }
}

/**
 * Expired-memory sweep. It runs through a normal transaction, so the sweep is
 * as revertible and auditable as an agent-initiated expiry.
 * @param {ReturnType<typeof createMemoryOps>} ops
 * @param {any} config
 * @param {any} logger
 * @returns {() => void} disposer
 */
function startSweep(ops, config, logger) {
  if (config.autoSweepExpired === false) return () => {}
  const intervalMs = Math.max(30_000, Number(config.sweepIntervalMs ?? 300_000))
  const timer = setInterval(() => {
    void ops.sweepExpired().then((result) => {
      if (result.swept.length > 0) logger.info(`anagenesis: swept ${result.swept.length} expired memor${result.swept.length === 1 ? 'y' : 'ies'}`)
    }).catch((error) => {
      logger.warn(`anagenesis: expiry sweep failed: ${String(error)}`)
    })
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

/**
 * The compaction policy: host config keys → journal options.
 *
 * Pure and exported on purpose. A typo in this mapping would silently turn the
 * retention policy off (or make it unbounded), and the boot sandbox never
 * compacts — so the mapping has to be pinned by a test rather than by reading it.
 * @param {any} config
 * @returns {{ minEvents: number, retain: { maxSegments: number, events: number } }}
 */
export function compactionPolicy(config = {}) {
  return {
    minEvents: Number(config.compactAfterEvents ?? 2000),
    retain: {
      maxSegments: Number(config.archiveMaxSegments ?? 16),
      events: Number(config.retainEvents ?? 0),
    },
  }
}

/**
 * Journal compaction timer. Compaction changes no domain state, so it is not a
 * transaction — but it still runs under the store's single writer, and it only
 * fires once the live log is genuinely large, so a normal session never pays for
 * it. `minEvents` makes the periodic check a no-op between real compactions.
 * @param {import('./store/store.js').MemoryStore} store
 * @param {any} config
 * @param {any} logger
 * @returns {() => void} disposer
 */
function startCompaction(store, config, logger) {
  const policy = compactionPolicy(config)
  if (!Number.isFinite(policy.minEvents) || policy.minEvents <= 0) return () => {}
  const run = () => {
    if (store.version < policy.minEvents) return
    void store.compact({ minEvents: policy.minEvents, retain: policy.retain }).catch((error) => {
      logger.warn(`anagenesis: journal compaction failed: ${String(error)}`)
    })
  }
  run()
  const intervalMs = Math.max(60_000, Number(config.compactIntervalMs ?? 3_600_000))
  const timer = setInterval(run, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

/**
 * Reflection timer. Unlike the sweep, this does **not** run at boot: a restart
 * is not the moment to start questioning beliefs, and a burst of hypotheses
 * right after every restart would be noise. It fires on its own interval, is
 * skipped entirely under `safeMode`, and records what it did for `status()`.
 * @param {{ store: import('./store/store.js').MemoryStore, ops: any, logger: any, config: any, state: any }} deps
 * @returns {() => void} disposer
 */
function startReflection(deps) {
  const { store, ops, logger, config, state } = deps
  if (config.reflectionEnabled === false) return () => {}
  const intervalMs = Math.max(60_000, Number(config.reflectIntervalMs ?? 6 * 3600 * 1000))
  const timer = setInterval(() => {
    if (config.safeMode === true) return
    void runReflection({ store, ops, logger, config, now: () => Date.now() })
      .then((result) => {
        state.lastRunAt = Date.now()
        state.lastFiled = result.filed.length
        state.lastHypotheses = result.filed.map((row) => row.hypothesisId)
      })
      .catch((error) => {
        logger.warn(`anagenesis-reflect: reflection failed: ${String(error)}`)
      })
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {{ info: Function, warn: Function, debug: Function }}
 */
function adapterLogger(ctx) {
  const base = ctx?.logger
  if (base === undefined) {
    return { info: (...a) => console.log(...a), warn: (...a) => console.warn(...a), debug: () => {} }
  }
  return {
    info: (message) => base.info?.(message),
    warn: (message) => base.warn?.(message),
    debug: (message) => base.debug?.(message),
  }
}

/**
 * @template T
 * @param {Record<string, T>} rows
 * @param {(row: T) => string} keyOf
 * @returns {Record<string, number>}
 */
function countBy(rows, keyOf) {
  /** @type {Record<string, number>} */
  const out = {}
  for (const row of Object.values(rows)) {
    const key = keyOf(row)
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

export { InvariantViolation }

/**
 * @typedef {object} AnagenesisService
 * @property {string} name
 * @property {number} version
 * @property {string} rootDir
 * @property {boolean} safeMode
 * @property {MemoryStore} store
 * @property {StrategyRegistry} registry
 * @property {StrategyEngine} engine
 * @property {Tuner} tuner
 * @property {ReturnType<typeof createMemoryOps>} ops
 * @property {import('./permission/registry.js').PermissionRegistry} permissions
 * @property {{ stack: string[], tokenBudget: number }} defaults
 * @property {(exec?: any, explicit?: any) => any} scopeFor
 * @property {(exec?: any, explicit?: any) => any} writeScope
 * @property {(record: any, exec?: any, crossProject?: boolean) => { ok: boolean, relation: string, reason: string }} canRead
 * @property {(request?: any) => Promise<any>} listMemories
 * @property {(exec?: any) => any} scopeReport
 * @property {(exec?: any, extra?: any) => { text: string, data: any }} pulse
 * @property {(exec?: any) => any} permissionReport
 * @property {(gear: string, opts?: any) => Promise<any>} setGear
 * @property {(sessionId: string, reason?: string) => Promise<any>} dropSession
 * @property {(request: object, opts?: object) => Promise<any>} recall
 * @property {() => any} status
 */
