/**
 * Append-only journal: the source of truth.
 *
 * Snapshot files are only a cache; if a snapshot is missing, corrupt or stale,
 * replaying the journal reconstructs the exact state. Segments rotate at
 * `SEGMENT_BYTES` so a long-lived store never rewrites one giant file, and
 * every event carries both its forward `patch` and its derived `undo` patch so
 * a rollback recorded months ago is still executable.
 *
 * Compaction folds the live log into one archive segment plus a checkpoint, and
 * between them they still answer both questions the journal exists for:
 *
 *   - `archive-<seq>.jsonl`  the folded events, slimmed to
 *     `{seq, ts, type, scope, by, payload, touched, schemaVersion, undo}`.
 *     The forward `patch` is dropped because the checkpoint already contains its
 *     effect; `undo` is kept, because that is what `revert(seq)` needs. Each
 *     compaction **appends one segment** covering the live events it folded;
 *     older segments are never rewritten, so a compaction costs O(live) instead
 *     of O(history).
 *   - `checkpoint-<seq>.json`  the frozen state at that boundary. Only the
 *     newest one is kept: an older snapshot is dead weight, because the events
 *     it freezes stay in the archives.
 *
 * So replay = checkpoint + the live segments after it, while `readAll()` merges
 * the archives back in — `ana_audit view=journal` and `revert(seq)` still reach
 * the oldest seq after compaction. Compaction never changes domain state, so it
 * is not itself a journal event.
 *
 * Two bounds stop the layout from growing without limit. They are policies, not
 * accidents:
 *
 *   - `maxSegments` merges the oldest segments once there are too many. Nothing
 *     is dropped: the merged segment still carries every event it covered.
 *   - `retainEvents` (**opt-in**, 0 = keep everything) deletes whole archive
 *     segments that lie outside the retained window. This is the only operation
 *     here that loses something — those seqs stop being revertible — so it is
 *     off unless a host asks for it, and it leaves `pruned.json` behind so the
 *     loss is auditable instead of invisible.
 * @module dsh-anagenesis/store/journal
 */

import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Mutex, atomicWriteFile, readJsonSync } from '../util.js'

const SEGMENT_BYTES = 4 * 1024 * 1024
const FILE_RE = /^journal-(\d{6})\.jsonl$/
const ARCHIVE_RE = /^archive-(\d{6})\.jsonl$/
const CHECKPOINT_RE = /^checkpoint-(\d{6})\.json$/
/** Retention marker: what the pruning policy dropped, kept even when it drops nothing new. */
const PRUNE_FILE = 'pruned.json'

/** @param {{seq?: number}} a @param {{seq?: number}} b */
const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0)

/**
 * One jsonl body. Shared by the archive writer and the segment merger so both
 * produce byte-identical shapes.
 * @param {object[]} rows
 * @returns {string}
 */
function serialize(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
}

export class Journal {
  /** @type {string} */
  #dir
  /** @type {Mutex} */
  #mutex = new Mutex()
  /** @type {number} */
  #segment = 1
  /** @type {number} */
  #bytes = 0
  /** @type {boolean} */
  #closed = false
  /** @type {{ live: number, archives: number, checkpoints: number, prunedThroughSeq: number }} */
  #stats = { live: 0, archives: 0, checkpoints: 0, prunedThroughSeq: 0 }
  /** @type {{ throughSeq: number, at: number|null, droppedSegments: number, droppedEvents: number, retainEvents: number }} */
  #pruned = { throughSeq: 0, at: null, droppedSegments: 0, droppedEvents: 0, retainEvents: 0 }

  /**
   * @param {{ dir: string }} opts
   */
  constructor({ dir }) {
    this.#dir = dir
  }

  /**
   * @param {{ dir: string }} opts
   * @returns {Promise<Journal>}
   */
  static async open({ dir }) {
    const journal = new Journal({ dir })
    await mkdir(dir, { recursive: true })
    const files = await journal.segments()
    if (files.length > 0) {
      const last = files[files.length - 1]
      journal.#segment = last.index
      try {
        journal.#bytes = (await stat(join(dir, last.name))).size
      } catch {
        journal.#bytes = 0
      }
    }
    // The retention marker survives restarts on purpose: after a prune, the
    // missing seqs must still explain themselves instead of looking like a gap.
    const marker = readJsonSync(join(dir, PRUNE_FILE), null)
    journal.#pruned = {
      throughSeq: Number(marker?.throughSeq ?? 0),
      at: marker?.at ?? null,
      droppedSegments: Number(marker?.droppedSegments ?? 0),
      droppedEvents: Number(marker?.droppedEvents ?? 0),
      retainEvents: Number(marker?.retainEvents ?? 0),
    }
    journal.#stats = {
      live: files.length,
      archives: (await journal.archives()).length,
      checkpoints: (await journal.checkpoints()).length,
      prunedThroughSeq: journal.#pruned.throughSeq,
    }
    return journal
  }

  /**
   * @param {RegExp} pattern
   * @returns {Promise<{ index: number, name: string }[]>}
   */
  async #matching(pattern) {
    let names = []
    try {
      names = await readdir(this.#dir)
    } catch {
      return []
    }
    return names
      .map((name) => ({ name, match: pattern.exec(name) }))
      .filter((row) => row.match !== null)
      .map((row) => ({ name: row.name, index: Number(/** @type {RegExpExecArray} */ (row.match)[1]) }))
      .sort((a, b) => a.index - b.index)
  }

  /** Live segments, oldest first. @returns {Promise<{ index: number, name: string }[]>} */
  async segments() {
    return this.#matching(FILE_RE)
  }

  /**
   * Layout counters for `ana_audit view=status`. Cached rather than re-read per
   * call: `status()` is synchronous and a directory listing is not.
   * @returns {{ live: number, archives: number, checkpoints: number, prunedThroughSeq: number }}
   */
  stats() {
    return { ...this.#stats }
  }

  /** The persisted retention marker — what the pruning policy dropped, if ever. @returns {object} */
  pruneMarker() {
    return { ...this.#pruned }
  }

  /** Highest seq the retention policy ever dropped (0 when nothing was). @returns {number} */
  get prunedThroughSeq() {
    return this.#pruned.throughSeq
  }

  /**
   * Keep the cached archive count honest after surgery. Re-reading the directory
   * is the cheap, drift-proof option: this only runs on compaction or pruning.
   * @returns {Promise<void>}
   */
  async #refreshArchiveCount() {
    this.#stats = { ...this.stats(), archives: (await this.archives()).length }
  }

  /** Archived segments, oldest first. @returns {Promise<{ index: number, name: string }[]>} */
  async archives() {
    return this.#matching(ARCHIVE_RE)
  }

  /** Checkpoints, oldest first. @returns {Promise<{ index: number, name: string }[]>} */
  async checkpoints() {
    return this.#matching(CHECKPOINT_RE)
  }

  /**
   * Parse one jsonl file, skipping torn lines: a crash mid-append must not brick
   * the plugin.
   * @param {string} name
   * @returns {Promise<object[]>}
   */
  async #readEvents(name) {
    let text = ''
    try {
      text = await readFile(join(this.#dir, name), 'utf8')
    } catch {
      return []
    }
    const events = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // torn write or manual edit: skip the line, keep the store loadable
      }
    }
    return events
  }

  /** Live events only — the ones that still carry their forward patch. */
  async readLive() {
    const events = []
    for (const { name } of await this.segments()) events.push(...await this.#readEvents(name))
    return events.sort(bySeq)
  }

  /** Archived events: patch-less, but `undo` (and therefore revert) intact. */
  async readArchive() {
    const events = []
    for (const { name } of await this.archives()) events.push(...await this.#readEvents(name))
    return events.sort(bySeq)
  }

  /**
   * Replay every event in order. Malformed lines are skipped rather than fatal:
   * a torn tail line must not brick the plugin.
   * @returns {Promise<object[]>}
   */
  async readAll() {
    /** @type {Map<number, object>} */
    const merged = new Map()
    for (const event of await this.readArchive()) merged.set(event.seq, event)
    for (const event of await this.readLive()) merged.set(event.seq, event)
    return [...merged.values()].sort(bySeq)
  }

  /**
   * The newest valid checkpoint, or null when the log has never been compacted.
   * @returns {Promise<{ seq: number, ts: number, schemaVersion: number, state: any }|null>}
   */
  async loadCheckpoint() {
    let best = null
    for (const { name } of await this.checkpoints()) {
      let raw
      try {
        raw = JSON.parse(await readFile(join(this.#dir, name), 'utf8'))
      } catch {
        continue // an unreadable checkpoint just means "replay from the live log"
      }
      if (typeof raw?.seq !== 'number' || raw.state === undefined) continue
      if (best === null || raw.seq > best.seq) best = raw
    }
    return best
  }

  /**
   * Durably append one event. The event is written before the in-memory state
   * is swapped, so a crash can only lose the tail of an unacknowledged write.
   * @param {object} event
   * @returns {Promise<void>}
   */
  async append(event) {
    if (this.#closed) throw new Error('anagenesis: journal is closed')
    return this.#mutex.runExclusive(async () => {
      const line = `${JSON.stringify(event)}\n`
      const bytes = Buffer.byteLength(line)
      if (this.#bytes > 0 && this.#bytes + bytes > SEGMENT_BYTES) {
        this.#segment += 1
        this.#bytes = 0
        this.#stats = { ...this.#stats, live: this.#stats.live + 1 }
      }
      const file = join(this.#dir, this.segmentName(this.#segment))
      await appendFile(file, line, 'utf8')
      this.#bytes += bytes
    })
  }

  /**
   * @param {number} index
   * @returns {string}
   */
  segmentName(index) {
    return `journal-${String(index).padStart(6, '0')}.jsonl`
  }

  /**
   * @param {number} seq
   * @returns {string}
   */
  archiveName(seq) {
    return `archive-${String(seq).padStart(6, '0')}.jsonl`
  }

  /**
   * @param {number} seq
   * @returns {string}
   */
  checkpointName(seq) {
    return `checkpoint-${String(seq).padStart(6, '0')}.json`
  }

  /**
   * Fold the live events into one new archive segment plus one checkpoint, then
   * start a fresh live segment.
   *
   * Existing archive segments are deliberately left alone. Rewriting them into a
   * single file was the old behaviour, and it made every compaction O(history):
   * the segment count was pinned at one and the whole log was re-serialized each
   * time. Appending instead is what makes the cost O(live).
   *
   * `state` must be the state as of the last live event — the caller holds the
   * single writer, so that invariant is checkable, and refusing on mismatch is
   * what keeps a bogus checkpoint from silently replacing history.
   * @param {{ state: any, ts?: number, minEvents?: number, retain?: { maxSegments?: number, events?: number } }} opts
   * @returns {Promise<object>}
   */
  async compact(opts) {
    if (this.#closed) throw new Error('anagenesis: journal is closed')
    return this.#mutex.runExclusive(async () => {
      const live = await this.readLive()
      const minEvents = opts.minEvents ?? 1
      if (live.length < minEvents) {
        return {
          compacted: false,
          reason: 'below the configured event threshold',
          liveEvents: live.length,
          layout: this.stats(),
        }
      }
      const boundary = live[live.length - 1].seq
      if (opts.state?.version !== boundary) {
        return {
          compacted: false,
          reason: `in-memory state is at v${opts.state?.version} but the last live event is #${boundary}`,
          liveEvents: live.length,
          layout: this.stats(),
        }
      }
      const archive = this.archiveName(boundary)
      const checkpoint = this.checkpointName(boundary)
      const rows = live.map(slim)
      // Write both replacements before deleting anything: a crash in between
      // leaves the old segments in place, and replay ignores events at or below
      // the checkpoint (see MemoryStore#replay), so nothing is applied twice.
      await atomicWriteFile(join(this.#dir, archive), serialize(rows))
      await atomicWriteFile(join(this.#dir, checkpoint), JSON.stringify({
        seq: boundary,
        ts: opts.ts ?? Date.now(),
        schemaVersion: opts.state.schemaVersion,
        state: opts.state,
      }))
      // Older checkpoints are superseded snapshots: the events they freeze stay
      // in the archives, so dropping them loses nothing. The archives stay.
      for (const { name } of await this.checkpoints()) if (name !== checkpoint) await rm(join(this.#dir, name), { force: true })
      for (const { name } of await this.segments()) await rm(join(this.#dir, name), { force: true })
      this.#segment = 1
      this.#bytes = 0
      this.#stats = { ...this.stats(), live: 1, checkpoints: 1 }
      await this.#refreshArchiveCount()

      const merged = await this.#mergeOldest(opts.retain?.maxSegments)
      const pruned = await this.#pruneOldest({ boundary, retainEvents: opts.retain?.events, ts: opts.ts })
      return {
        compacted: true,
        archived: rows.length,
        boundary,
        archive,
        checkpoint,
        folded: live.length,
        merged,
        pruned,
        layout: this.stats(),
      }
    })
  }

  /**
   * Bound the archive *count* without losing anything: once there are more
   * segments than the policy allows, the oldest ones are rewritten as a single
   * segment (LSM-style tiering). The merged body overwrites the newest of its
   * inputs, so no new name has to be invented — and a crash midway can only
   * leave duplicate seqs, which every reader collapses by seq.
   * @param {number|undefined} maxSegments 0/undefined = unbounded
   * @returns {Promise<{ merged: number, segments: number, events: number }>}
   */
  async #mergeOldest(maxSegments) {
    const limit = Number(maxSegments ?? 0)
    const archives = await this.archives()
    if (!(limit > 0) || archives.length <= limit) return { merged: 0, segments: archives.length, events: 0 }
    const inputs = archives.slice(0, archives.length - limit + 1)
    const target = inputs[inputs.length - 1]
    /** @type {Map<number, object>} */
    const merged = new Map()
    for (const { name } of inputs) {
      for (const event of await this.#readEvents(name)) merged.set(event.seq, event)
    }
    const rows = [...merged.values()].sort(bySeq)
    await atomicWriteFile(join(this.#dir, target.name), serialize(rows))
    for (const { name } of inputs) if (name !== target.name) await rm(join(this.#dir, name), { force: true })
    await this.#refreshArchiveCount()
    return { merged: inputs.length, segments: archives.length - inputs.length + 1, events: rows.length }
  }

  /**
   * The one destructive policy. With `retainEvents > 0`, whole archive segments
   * that lie entirely outside the retained window are deleted. Segment
   * granularity means the kept window is never smaller than what was asked for,
   * and the segment just written is never a candidate — so a prune can never
   * discard the events the running compaction folded.
   * @param {{ boundary: number, retainEvents?: number, ts?: number }} opts
   * @returns {Promise<{ enabled: boolean, segments: number, events: number, throughSeq: number, cutoff: number }>}
   */
  async #pruneOldest(opts) {
    const retain = Number(opts.retainEvents ?? 0)
    const cutoff = opts.boundary - retain
    if (!(retain > 0)) {
      return { enabled: false, segments: 0, events: 0, throughSeq: this.#pruned.throughSeq, cutoff }
    }
    const archives = await this.archives()
    const newest = archives[archives.length - 1]
    const doomed = archives.filter((row) => row !== newest && row.index < cutoff)
    if (doomed.length === 0) {
      return { enabled: true, segments: 0, events: 0, throughSeq: this.#pruned.throughSeq, cutoff }
    }
    let dropped = 0
    let throughSeq = this.#pruned.throughSeq
    for (const { name } of doomed) {
      for (const event of await this.#readEvents(name)) {
        dropped += 1
        throughSeq = Math.max(throughSeq, event.seq ?? 0)
      }
      await rm(join(this.#dir, name), { force: true })
    }
    this.#pruned = {
      throughSeq,
      at: opts.ts ?? Date.now(),
      droppedSegments: this.#pruned.droppedSegments + doomed.length,
      droppedEvents: this.#pruned.droppedEvents + dropped,
      retainEvents: retain,
    }
    await atomicWriteFile(join(this.#dir, PRUNE_FILE), JSON.stringify(this.#pruned))
    this.#stats = { ...this.stats(), prunedThroughSeq: throughSeq }
    await this.#refreshArchiveCount()
    return { enabled: true, segments: doomed.length, events: dropped, throughSeq, cutoff }
  }

  /**
   * @param {number} seq
   * @returns {Promise<object|undefined>}
   */
  async find(seq) {
    const events = await this.readAll()
    return events.find((event) => event.seq === seq)
  }

  /** @returns {Promise<void>} */
  async close() {
    this.#closed = true
  }
}

/**
 * The archived shape of an event: everything an audit row shows, plus the
 * inverse patch, minus the forward patch the checkpoint already folded in.
 * @param {any} event
 * @returns {object}
 */
function slim(event) {
  return {
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    scope: event.scope,
    by: event.by,
    payload: event.payload ?? null,
    touched: event.touched ?? [],
    schemaVersion: event.schemaVersion,
    undo: event.undo,
    archived: true,
  }
}
