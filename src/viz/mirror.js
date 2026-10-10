/**
 * Read-only store mirror for out-of-process viewers.
 *
 * The standalone TUI (`tools/viz-watch.mjs`) must be able to look at a store
 * *without becoming a writer*: `MemoryStore.acquire()` takes a handle in the
 * single-writer pool, and a second writer in a second process would be exactly
 * the race the pool exists to prevent. So the watcher reads what the store
 * already wrote — `snapshot.json`, the journal segments and the newest
 * checkpoint — and replays them with the same pure functions the store uses
 * (`migrateState` + `applyPatch`).
 *
 * This is a deliberate, small duplication of `MemoryStore#replay`. The test
 * `viz: the mirror agrees with the store it mirrors` is what keeps it honest:
 * it opens the same directory both ways and compares version, memories, stacks,
 * params and stats. Nothing here ever writes — the journal directory is checked
 * before `Journal.open`, whose `mkdir` would otherwise create it.
 * @module dsh-anagenesis/viz/mirror
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonSync } from '../util.js'
import { Journal } from '../store/journal.js'
import { applyPatch } from '../store/patch.js'
import { emptyState, isLegacyUnscoped, migrateState } from '../store/schema.js'
import { namespaceCounts, parseNamespace, projectLabel } from '../scope/index.js'

/**
 * @param {string} rootDir the store directory (the one holding `journal/` and `snapshot.json`)
 * @param {{ now?: () => number }} [opts]
 * @returns {Promise<{ rootDir: string, state: any, events: any[], journal: any, origin: 'mirror',
 *   readOnly: true, scope: any, permissions: any }>}
 */
export async function readStoreMirror(rootDir, opts = {}) {
  const now = opts.now ?? (() => Date.now())
  const journalDir = join(rootDir, 'journal')
  if (!existsSync(journalDir)) {
    throw new Error(`anagenesis-viz: no journal directory at ${journalDir} — nothing to mirror yet`)
  }
  const journal = await Journal.open({ dir: journalDir })
  const snapshot = readJsonSync(join(rootDir, 'snapshot.json'), null)
  let state = snapshot?.state !== undefined ? migrateState(snapshot.state, now()) : emptyState(now())

  const checkpoint = await journal.loadCheckpoint()
  if (checkpoint !== null && checkpoint.seq > state.version) {
    state = { ...migrateState(checkpoint.state, now()), version: checkpoint.seq }
  }

  const ordered = await journal.readAll()
  for (const event of ordered) {
    if (typeof event.seq !== 'number' || event.seq <= state.version) continue
    if (event.patch === undefined) continue // archived events carry only `undo`
    state = { ...applyPatch(state, event.patch), version: event.seq, updatedAt: event.ts ?? state.updatedAt }
  }

  const stats = journal.stats()
  await journal.close()
  return {
    rootDir,
    state,
    // Newest first, matching `store.recentEvents()`: one ordering for both sources.
    events: [...ordered].reverse(),
    journal: stats,
    origin: 'mirror',
    readOnly: true,
    // A file mirror has no caller: it cannot know which project it is being read
    // *from*. So it reports what the files do say — the shape of the store —
    // and marks everything caller-specific as unknown instead of inventing a
    // current project (which would silently hide other projects' records).
    scope: mirrorScope(state, stats),
    // Placeholder: `gear: 'none'` is the shape a real report has, and `mirror:
    // true` tells the model to render "unknowable" rather than "no gear".
    permissions: { gear: 'none', presetActive: false, mirror: true },
  }
}

/**
 * The scope report a *file* can produce: every namespace the store holds, with
 * the project labels from `state.projects`, and no opinion about the caller.
 * @param {any} state
 * @param {any} journalStats
 * @returns {any}
 */
function mirrorScope(state, journalStats) {
  const counts = namespaceCounts(state)
  /** @type {Record<string, any>} */
  const namespaces = {}
  for (const [namespace, count] of Object.entries(counts.byNamespace)) {
    const parsed = parseNamespace(namespace)
    namespaces[namespace] = {
      count: Number(count) || 0,
      tier: parsed.tier,
      projectId: parsed.tier === 'project' ? parsed.key : null,
      label: parsed.tier === 'project' ? projectLabel(state, parsed.key) : namespace,
      current: false,
    }
  }
  return {
    current: {
      known: false,
      namespace: null,
      tier: null,
      projectId: null,
      projectLabel: '',
      basis: null,
      root: null,
      remote: null,
      workspace: null,
      session: null,
    },
    defaultScopeTier: null,
    crossProjectDefault: null,
    knownProjects: Object.values(state.projects ?? {}).map((entry) => ({
      id: String(/** @type {any} */ (entry).id ?? ''),
      label: String(/** @type {any} */ (entry).label ?? ''),
      kind: String(/** @type {any} */ (entry).kind ?? ''),
      root: String(/** @type {any} */ (entry).root ?? ''),
      remote: String(/** @type {any} */ (entry).remote ?? ''),
      firstSeenAt: Number(/** @type {any} */ (entry).firstSeenAt ?? 0),
      lastSeenAt: Number(/** @type {any} */ (entry).lastSeenAt ?? 0),
      current: false,
      memories: counts.byNamespace[`project:${String(/** @type {any} */ (entry).id ?? '')}`] ?? 0,
    })),
    namespaces,
    totals: counts.byTier,
    legacy: Object.values(state.memories ?? {}).filter((record) => isLegacyUnscoped(record)).length,
    journalNamespaces: journalStats?.byNamespace ?? {},
    mirror: true,
  }
}

/**
 * Does this directory look like an anagenesis store?
 * @param {string} rootDir
 * @returns {boolean}
 */
export function looksLikeStore(rootDir) {
  return existsSync(join(rootDir, 'journal'))
}