/**
 * Redaction boundary for everything the visualization layer emits.
 *
 * A dashboard drawn in a terminal and a diagram pasted into Markdown both leave
 * the agent's own context, and a memory store can hold credentials the agent was
 * told about. So the policy is explicit, one of three levels, and it is recorded
 * in every artifact header so a reader can see what was applied:
 *
 *   - `none`    raw text — local debugging only;
 *   - `secrets` **(default)** credential-shaped substrings scrubbed, bodies truncated;
 *   - `strict`  labels replaced by a state marker as well: nothing personal leaves.
 *
 * Redaction is a pure text transform. It never mutates a record, never touches
 * the state object, and reads nothing outside the caller's own store (there is
 * no other store to read — this plugin has no external memory dependency).
 * @module dsh-anagenesis/viz/redact
 */

export const REDACTION_LEVELS = Object.freeze(['none', 'secrets', 'strict'])

export const DEFAULT_REDACTION = 'secrets'

/** Bodies are truncated to this many characters unless the caller says otherwise. */
export const DEFAULT_BODY_CHARS = 96

/**
 * Credential-shaped text, not "anything that looks random". Each pattern is
 * narrow on purpose: over-redacting a memory store would quietly destroy the
 * very thing the dashboard exists to show.
 * @type {[RegExp, string][]}
 */
const SECRET_PATTERNS = [
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[redacted:key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted:token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted:token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted:aws-key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted:jwt]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer [redacted]'],
  [/\b(api[_-]?key|apikey|token|secret|password|passwd|pwd|access[_-]?key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[redacted]'],
  [/[A-Za-z0-9+/]{60,}={0,2}/g, '[redacted:blob]'],
]

/**
 * @param {unknown} text
 * @returns {string}
 */
export function scrubSecrets(text) {
  if (typeof text !== 'string' || text === '') return ''
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/**
 * @param {unknown} text
 * @param {string} [level]
 * @returns {string}
 */
export function redactText(text, level = DEFAULT_REDACTION) {
  const value = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text)
  if (level === 'none') return value
  if (level === 'strict') return '[redacted]'
  return scrubSecrets(value)
}

/**
 * @param {string} text
 * @param {number} chars
 * @returns {string}
 */
export function truncateChars(text, chars) {
  const value = String(text ?? '')
  if (chars <= 0) return ''
  return value.length <= chars ? value : `${value.slice(0, Math.max(0, chars - 1))}…`
}

/**
 * Project one record into the shape the renderers use. The return value is
 * plain JSON with no `undefined` anywhere: the host rejects a tool answer that
 * does not survive a JSON round trip (see HANDOFF §10.18).
 * @param {any} record
 * @param {{ level?: string, bodyChars?: number, includeBody?: boolean }} [opts]
 * @returns {{ id: string, kind: string, state: string, label: string, gist: string, bodyPreview: string, redacted: boolean }}
 */
export function redactRecord(record, opts = {}) {
  const level = opts.level ?? DEFAULT_REDACTION
  const includeBody = opts.includeBody === true
  const bodyChars = opts.bodyChars ?? DEFAULT_BODY_CHARS
  const kind = String(record?.kind ?? 'unknown')
  const id = String(record?.id ?? '')
  const state = String(record?.state ?? 'unknown')
  if (level === 'strict') {
    return { id, kind, state, label: `[redacted ${kind}]`, gist: '', bodyPreview: '', redacted: true }
  }
  const label = redactText(record?.subject ?? record?.gist ?? '', level)
  const gist = redactText(record?.gist ?? '', level)
  const body = includeBody ? redactText(record?.body ?? '', level) : ''
  return {
    id,
    kind,
    state,
    label,
    gist,
    bodyPreview: body === '' ? '' : truncateChars(body, bodyChars),
    redacted: level !== 'none',
  }
}

/**
 * One line that says what was applied, for the artifact header and the frame
 * footer. Kept short: it is read next to the data it describes.
 * @param {string} [level]
 * @param {{ bodyChars?: number, includeBody?: boolean }} [opts]
 * @returns {string}
 */
export function redactionNote(level = DEFAULT_REDACTION, opts = {}) {
  const bodyChars = opts.bodyChars ?? DEFAULT_BODY_CHARS
  if (level === 'none') return 'redaction=none (raw — do not paste outside your own terminal)'
  if (level === 'strict') return 'redaction=strict (labels masked)'
  const bodies = opts.includeBody === true ? `bodies ≤ ${bodyChars} chars` : 'bodies omitted'
  return `redaction=secrets (credential-shaped text scrubbed, ${bodies})`
}