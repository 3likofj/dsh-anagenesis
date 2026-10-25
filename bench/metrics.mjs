/**
 * Ranking metrics for the retrieval benchmark.
 *
 * Deliberately small and explicit — a benchmark whose metric implementation is
 * hard to read is a benchmark nobody will trust when it reports a regression.
 * @module dsh-anagenesis/bench/metrics
 */

/**
 * Discounted cumulative gain over the selected order.
 * @param {string[]} selected
 * @param {Record<string, number>} gold
 * @param {number} k
 * @returns {number}
 */
export function dcg(selected, gold, k) {
  let sum = 0
  const limit = Math.min(selected.length, k)
  for (let i = 0; i < limit; i++) {
    const grade = gold[selected[i]] ?? 0
    sum += (2 ** grade - 1) / Math.log2(i + 2)
  }
  return sum
}

/**
 * nDCG@k. Ideal DCG uses the gold grades sorted descending, so a query with no
 * gold has no ideal and returns null (the caller reports it as `empty`).
 * @param {string[]} selected
 * @param {Record<string, number>} gold
 * @param {number} [k]
 * @returns {number|null}
 */
export function ndcg(selected, gold, k = 10) {
  const grades = Object.values(gold).filter((grade) => grade > 0).sort((a, b) => b - a)
  if (grades.length === 0) return null
  let ideal = 0
  for (let i = 0; i < Math.min(grades.length, k); i++) ideal += (2 ** grades[i] - 1) / Math.log2(i + 2)
  if (ideal === 0) return null
  return dcg(selected, gold, k) / ideal
}

/**
 * Reciprocal rank of the first relevant (grade > 0) hit.
 * @param {string[]} selected
 * @param {Record<string, number>} gold
 * @returns {number}
 */
export function mrr(selected, gold) {
  for (let i = 0; i < selected.length; i++) {
    if ((gold[selected[i]] ?? 0) > 0) return 1 / (i + 1)
  }
  return 0
}

/**
 * Fraction of relevant gold records found in the top k.
 * @param {string[]} selected
 * @param {Record<string, number>} gold
 * @param {number} [k]
 * @returns {number|null}
 */
export function recallAtK(selected, gold, k = 5) {
  const relevant = Object.entries(gold).filter(([, grade]) => grade > 0).map(([id]) => id)
  if (relevant.length === 0) return null
  const top = new Set(selected.slice(0, k))
  return relevant.filter((id) => top.has(id)).length / relevant.length
}

/**
 * Fraction of the top k that is relevant.
 * @param {string[]} selected
 * @param {Record<string, number>} gold
 * @param {number} [k]
 * @returns {number}
 */
export function precisionAtK(selected, gold, k = 5) {
  const top = selected.slice(0, k)
  if (top.length === 0) return 1
  return top.filter((id) => (gold[id] ?? 0) > 0).length / top.length
}

/**
 * Fraction of *all* injected records that are not relevant. For a no-gold query
 * this is 1 whenever anything was injected — the number that makes "recall
 * always fills the budget" visible.
 * @param {string[]} selected
 * @param {Record<string, number>} gold
 * @returns {number}
 */
export function contamination(selected, gold) {
  if (selected.length === 0) return 0
  return selected.filter((id) => (gold[id] ?? 0) <= 0).length / selected.length
}

/**
 * How many forbidden (other-project) ids leaked in.
 * @param {string[]} selected
 * @param {string[]} forbidden
 * @returns {number}
 */
export function leaks(selected, forbidden) {
  if (forbidden.length === 0) return 0
  const blocked = new Set(forbidden)
  return selected.filter((id) => blocked.has(id)).length
}

/**
 * Arithmetic mean that ignores nulls (a missing ideal is not a zero).
 * @param {(number|null)[]} values
 * @returns {number|null}
 */
export function mean(values) {
  const usable = values.filter((value) => value !== null)
  if (usable.length === 0) return null
  return usable.reduce((sum, value) => sum + value, 0) / usable.length
}

/**
 * @param {number|null} value
 * @param {number} [digits]
 * @returns {string}
 */
export function fmt(value, digits = 3) {
  return value === null || value === undefined ? '  -  ' : value.toFixed(digits)
}
