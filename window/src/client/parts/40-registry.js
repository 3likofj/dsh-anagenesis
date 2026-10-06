/**
 * Client half, part 4/9 — the entrance registry.
 *
 * One object owns every entrance's lifecycle, and it is the only place that
 * mutates entrance state. Three properties the task asks for are implemented
 * exactly here:
 *
 *   - **no duplicate registration** — `claim(id)` is the mutual-exclusion gate.
 *     A seat that is already armed cannot be armed again; the second attempt is
 *     recorded as `entry.duplicate-suppressed` instead of quiet.
 *   - **reversibility** — every claim must be followed by `attach(id, disposer)`,
 *     and the disposer is wrapped so it runs at most once no matter how many
 *     owners release it (the Cordis effect and this registry both do).
 *   - **observability** — every transition is pushed into the log, and
 *     `snapshot()` is the status read the service face and the tests share.
 */

/** Entrance lifecycle states. Closed vocabulary — a status read can rely on it. */
const ENTRY_STATE = {
  idle: 'idle',
  registering: 'registering',
  registered: 'registered',
  degraded: 'degraded',
  suppressed: 'suppressed',
  error: 'error',
  released: 'released',
}

/**
 * @param {any} log
 * @returns {any}
 */
function createEntryRegistry(log) {
  /** @type {Map<string, any>} */
  const rows = new Map()
  /** @type {Set<() => void>} */
  const listeners = new Set()

  const notify = () => {
    cachedSnapshot = null
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch (error) {
        console.error(PKG_ID + ': registry listener failed', error)
      }
    }
  }

  // Same reason as the window engine: `useSyncExternalStore` needs a stable
  // identity between notifications, so the rows are built once per change.
  let cachedSnapshot = null

  const transition = (id, state, reason, detail) => {
    const row = rows.get(id)
    if (row === undefined) return null
    row.state = state
    row.reason = reason === undefined || reason === null ? '' : String(reason)
    row.at = Date.now()
    log.push('entry.' + state, Object.assign({ seat: id, label: row.label, seatKind: row.seatKind, reason: row.reason }, detail === undefined ? {} : detail))
    notify()
    return row
  }

  return {
    ENTRY_STATE: ENTRY_STATE,

    /** Declare a seat once, before anything can arm it. */
    declare(spec) {
      rows.set(spec.id, {
        id: spec.id,
        label: spec.label,
        seatKind: spec.seatKind,
        requires: spec.requires.slice(),
        state: ENTRY_STATE.idle,
        reason: 'declared, not planned yet',
        at: Date.now(),
        disposer: null,
        claims: 0,
      })
    },

    stateOf(id) {
      const row = rows.get(id)
      return row === undefined ? null : row.state
    },

    /**
     * Mutual exclusion for one seat. Returns false when the seat is already held.
     * @param {string} id
     * @returns {boolean}
     */
    claim(id) {
      const row = rows.get(id)
      if (row === undefined) return false
      if (row.state === ENTRY_STATE.registering || row.state === ENTRY_STATE.registered) {
        log.push('entry.duplicate-suppressed', { seat: id, label: row.label, state: row.state, reason: 'the seat is already armed' })
        return false
      }
      row.claims += 1
      transition(id, ENTRY_STATE.registering, 'arming')
      return true
    },

    /** Record an outcome that is not a registration (degraded / suppressed / error). */
    settle(id, state, reason, detail) {
      return transition(id, state, reason, detail)
    },

    /** Bind the rollback of a successful registration. Disposers are single-shot. */
    attach(id, disposer) {
      const row = rows.get(id)
      if (row === undefined) return
      row.disposer = disposer
      transition(id, ENTRY_STATE.registered, 'armed')
    },

    /**
     * Release one seat. Idempotent: releasing an unarmed or already-released seat
     * is a no-op logged once, never a throw and never a second rollback.
     * @param {string} id
     */
    release(id) {
      const row = rows.get(id)
      if (row === undefined) return
      const wasArmed = row.state === ENTRY_STATE.registering || row.state === ENTRY_STATE.registered
      const disposer = row.disposer
      row.disposer = null
      if (disposer !== null) {
        try {
          disposer()
        } catch (error) {
          log.push('entry.dispose-error', { seat: id, error: errorText(error) })
        }
      }
      if (wasArmed) transition(id, ENTRY_STATE.released, 'released by request')
      else if (row.state !== ENTRY_STATE.released) transition(id, ENTRY_STATE.released, 'released while not armed')
    },

    /** Release everything, in reverse declaration order. Used on plugin teardown. */
    releaseAll() {
      const ids = Array.from(rows.keys()).reverse()
      for (const id of ids) this.release(id)
      return ids.length
    },

    /** The status read: one closed row per declared seat. */
    snapshot() {
      if (cachedSnapshot !== null) return cachedSnapshot
      const out = []
      for (const id of SEAT_ORDER) {
        const row = rows.get(id)
        if (row === undefined) continue
        out.push({
          seat: id,
          label: row.label,
          seatKind: row.seatKind,
          requires: row.requires.slice(),
          state: row.state,
          reason: row.reason,
          at: row.at,
          claims: row.claims,
        })
      }
      for (const id of rows.keys()) {
        if (SEAT_ORDER.indexOf(id) >= 0) continue
        const row = rows.get(id)
        out.push({
          seat: id, label: row.label, seatKind: row.seatKind, requires: row.requires.slice(),
          state: row.state, reason: row.reason, at: row.at, claims: row.claims,
        })
      }
      cachedSnapshot = out
      return out
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    /**
     * The per-entry view of the same rows: one line per entrance the task names,
     * resolved over the seat(s) that can carry it. Precedence is "armed wins", then
     * the worst observed outcome, so a seat that works is never hidden by a sibling
     * seat that does not.
     */
    rollup() {
      const rank = { registered: 0, error: 1, degraded: 2, suppressed: 3, registering: 4, released: 5, idle: 6 }
      const out = []
      for (const group of ENTRY_GROUPS) {
        /** @type {any} */
        let best = null
        const reasons = []
        for (const seatId of group.seats) {
          const row = rows.get(seatId)
          if (row === undefined) continue
          reasons.push(seatId + ': ' + row.state + (row.reason === '' ? '' : ' — ' + row.reason))
          if (best === null || rank[row.state] < rank[best.state]) best = { state: row.state, seat: seatId, reason: row.reason }
        }
        out.push({
          entry: group.entry,
          id: group.id,
          label: group.label,
          state: best === null ? ENTRY_STATE.idle : best.state,
          via: best === null ? '' : best.seat,
          reason: best === null ? 'no seat declared' : best.reason,
          seats: group.seats.slice(),
          details: reasons,
        })
      }
      return out
    },
  }
}