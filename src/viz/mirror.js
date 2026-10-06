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
import { emptyState, migrateState } from '../store/schema.js'

/**
 * @param {string} rootDir the store directory (the one holding `journal/` and `snapshot.json`)
 * @param {{ now?: () => number }} [opts]
 * @returns {Promise<{ rootDir: string, state: any, events: any[], journal: any, origin: 'mirror', readOnly: true }>}
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