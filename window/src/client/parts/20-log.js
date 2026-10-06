/**
 * Client half, part 2/9 — the observable log.
 *
 * Requirement 7 of the task ("entry registration, deregistration and degradation
 * must be observable") is satisfied here rather than by console noise: every
 * state change of every entrance goes into a bounded ring buffer that the
 * `ctx.anagenesisWindow.log()` face returns verbatim. `console` is used only as a
 * mirror, so a host that silences it loses nothing.
 *
 * Shapes are closed and lossless: no `undefined` is ever stored, because the same
 * rows are handed back through `hostRequest()` and the Host validates JSON
 * (HANDOFF §10.18).
 */

/** Bounded ring of entry/window events. Newest last. */
const LOG_LIMIT = 200

/**
 * Single-shot wrapper for every disposer this half hands out.
 *
 * Disposers have two owners by design here — the Cordis effect that created the
 * seat and the entrance registry that can release it by name — so "the rollback
 * happens exactly once, and never twice" cannot be left to discipline. It is also
 * what makes teardown safe to run twice, which is exactly what happens during an
 * HMR reload.
 * @param {() => void} fn
 * @param {(error: unknown) => void} [onError]
 * @returns {() => void}
 */
function onceOnly(fn, onError) {
  let done = false
  return () => {
    if (done) return
    done = true
    try {
      fn()
    } catch (error) {
      if (onError !== undefined) onError(error)
    }
  }
}

/**
 * @param {number} [limit]
 * @returns {{ push(type: string, detail?: any): any, list(type?: string): any[], subscribe(fn: () => void): () => void, size(): number, snapshot(): any }}
 */
function createObservableLog(limit) {
  const cap = numberOr(limit, LOG_LIMIT)
  /** @type {any[]} */
  const rows = []
  /** @type {Set<() => void>} */
  const listeners = new Set()
  let dropped = 0

  const notify = () => {
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch (error) {
        // A broken observer must never break an entry registration.
        console.error(PKG_ID + ': log listener failed', error)
      }
    }
  }

  return {
    push(type, detail) {
      const row = {
        at: Date.now(),
        type: String(type),
        detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail, (_key, value) => (value === undefined ? null : value))),
      }
      rows.push(row)
      if (rows.length > cap) {
        rows.splice(0, rows.length - cap)
        dropped += 1
      }
      notify()
      return row
    },
    list(type) {
      return type === undefined ? rows.slice() : rows.filter((row) => row.type === type)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    size() {
      return rows.length
    },
    snapshot() {
      return { limit: cap, size: rows.length, dropped: dropped }
    },
  }
}