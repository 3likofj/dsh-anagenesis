/**
 * Host-boundary helper: is this value lossless JSON?
 *
 * DSH validates a tool's answer by round-tripping it through JSON, and rejects
 * the whole call with `value is not lossless JSON` when the round trip loses
 * anything. The stub host the unit tests run against does not, which is exactly
 * how `ana_audit view=memory` shipped broken: `{ ...record, embedding: undefined }`
 * keeps the key with an `undefined` value, JSON.stringify drops it, and the host
 * sees a different object than the tool returned.
 *
 * So this walks the value the way JSON.stringify would and reports every spot
 * where the two disagree — undefined/function/symbol/bigint (dropped), NaN and
 * ±Infinity (become null), non-plain objects (Date becomes a string, Map becomes
 * {}), sparse arrays (holes become null) and circular references (throw).
 *
 * It lives outside `src/` on purpose: sanitising a tool's output here would be a
 * consumer patch. The owner of a lossless shape is the tool that returns it.
 * @module dsh-anagenesis/test/lossless
 */

/**
 * @param {unknown} value
 * @param {string} [path]
 * @param {Set<unknown>} [seen]
 * @returns {string[]} one human-readable line per loss, `[]` when the value is safe
 */
export function losslessIssues(value, path = '$', seen = new Set()) {
  const type = typeof value
  if (value === undefined) return [`${path}: undefined is dropped by JSON.stringify`]
  if (type === 'function') return [`${path}: a function is dropped by JSON.stringify`]
  if (type === 'symbol') return [`${path}: a symbol is dropped by JSON.stringify`]
  if (type === 'bigint') return [`${path}: a bigint throws in JSON.stringify`]
  if (type === 'number' && !Number.isFinite(value)) return [`${path}: ${String(value)} is not valid JSON (it becomes null)`]
  if (value === null || type === 'string' || type === 'boolean' || type === 'number') return []

  const issues = []
  const proto = Object.getPrototypeOf(value)
  const isArray = Array.isArray(value)
  if (!isArray && proto !== Object.prototype && proto !== null) {
    const name = proto?.constructor?.name ?? 'exotic object'
    return [`${path}: a ${name} does not survive JSON.stringify as itself`]
  }
  if (seen.has(value)) return [`${path}: circular reference`]
  seen.add(value)

  if (isArray) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) issues.push(`${path}[${index}]: a hole becomes null`)
      else issues.push(...losslessIssues(value[index], `${path}[${index}]`, seen))
    }
  } else {
    for (const key of Object.keys(value)) {
      issues.push(...losslessIssues(/** @type {any} */ (value)[key], `${path}.${key}`, seen))
    }
    if (Object.getOwnPropertySymbols(value).length > 0) issues.push(`${path}: symbol keys are dropped`)
  }
  seen.delete(value)
  return issues
}

/**
 * Assertion-friendly form: `null` when the value is lossless, else one string.
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string|null}
 */
export function losslessProblem(value, label = 'value') {
  const issues = losslessIssues(value)
  return issues.length === 0 ? null : `${label} is not lossless JSON: ${issues.join('; ')}`
}