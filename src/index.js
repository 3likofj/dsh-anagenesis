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
import { SCHEMA_VERSION } from './store/schema.js'
import { createMemoryOps } from './memory/ops.js'
import { recall as runRecall } from './memory/recall.js'
import { resolveEmbedder } from './memory/embed.js'
import { StrategyRegistry, DEFAULT_STACK } from './strategy/registry.js'
import { StrategyEngine } from './strategy/engine.js'
import { Tuner } from './meta/tuner.js'
import { runReflection } from './meta/reflect.js'
import { createInvariantGate, InvariantViolation } from './guard/invariants.js'

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
  const ops = createMemoryOps({ store, embed: embedFn })
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
    defaults: { stack: [...DEFAULT_STACK], tokenBudget: config.recallDefaultTokenBudget ?? 1600 },
    /**
     * @param {object} request
     * @param {{ params?: any, scope?: string }} [opts]
     */
    async recall(request, opts = {}) {
      const scope = opts.scope ?? 'global'
      const params = { ...(store.state.params[scope] ?? {}), ...(opts.params ?? {}) }
      const result = await runRecall(store, request, { params, engine: engine.forScope(scope), scope, embed: embedFn })
      await store.audit('recall', {
        intent: result.intent,
        selected: result.selected.length,
        dropped: result.dropped,
        tokens: result.tokenCost,
        strategy: result.strategy,
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
      return {
        version: state.version,
        schemaVersion: state.schemaVersion,
        rootDir,
        safeMode,
        memories: Object.keys(state.memories).length,
        byState: countBy(state.memories, (record) => record.state),
        byKind: countBy(state.memories, (record) => record.kind),
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
        lastEvents: store.recentEvents({ limit: 5 }).map((event) => ({ seq: event.seq, type: event.type })),
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
    const stateListener = store.on('*', (payload, event) => {
      ctx.emit?.('anagenesis/state', { seq: event.seq, type: event.type, payload })
    })
    return async () => {
      stateListener.dispose()
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
 * @property {{ stack: string[], tokenBudget: number }} defaults
 * @property {(request: object, opts?: object) => Promise<any>} recall
 * @property {() => any} status
 */
