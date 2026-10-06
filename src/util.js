/**
 * Host-agnostic helpers for dsh-anagenesis.
 *
 * Nothing under src/store, src/memory, src/strategy, src/meta or src/guard may
 * import a `@deepseek-ai/*` package: only the three DSH adapter rows
 * (src/index.js, src/tools/index.js, src/preset/index.js) touch the host API.
 * That keeps the whole engine runnable and testable under plain `node --test`.
 * @module dsh-anagenesis/util
 */

import { readFileSync } from 'node:fs'

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/** @returns {number} wall clock in ms */
export function nowMs() {
  return Date.now()
}

/**
 * @param {number} len
 * @param {() => number} [rand]
 * @returns {string}
 */
export function randomBase36(len, rand = Math.random) {
  let out = ''
  for (let i = 0; i < len; i++) out += B36[Math.floor(rand() * 36) % 36]
  return out
}

/**
 * Time-sortable, collision-resistant id: `<prefix>_<time36><rand10>`.
 * @param {string} [prefix]
 * @param {{ time?: number, rand?: () => number }} [opts]
 * @returns {string}
 */
export function ulid(prefix = 'mem', opts = {}) {
  const time = opts.time ?? Date.now()
  return `${prefix}_${Math.floor(time).toString(36).padStart(9, '0')}${randomBase36(10, opts.rand)}`
}

/**
 * FNV-1a, used by the hashing vectorizer and by content fingerprints.
 * @param {string} input
 * @returns {number} uint32
 */
export function hash32(input) {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Tokens for lexical scoring: latin word stems plus CJK unigrams and bigrams.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const lower = String(text ?? '').toLowerCase()
  const out = []
  for (const match of lower.matchAll(/[a-z0-9_]{2,}/g)) out.push(match[0])
  for (const match of lower.matchAll(/[\u3400-\u9fff]+/g)) {
    const run = match[0]
    for (let i = 0; i < run.length; i++) {
      out.push(run[i])
      if (i + 2 <= run.length) out.push(run.slice(i, i + 2))
    }
  }
  return out
}

/**
 * Cheap, deterministic token estimate: CJK counts ~1 token/char, latin ~1/3.6.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const str = String(text ?? '')
  let cjk = 0
  for (const ch of str) if (ch >= '\u3400' && ch <= '\u9fff') cjk++
  const rest = Math.max(0, str.length - cjk)
  return Math.max(str.length === 0 ? 0 : 1, Math.ceil(cjk + rest / 3.6))
}

/**
 * @param {number} value
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function clamp(value, lo, hi) {
  const n = Number(value)
  if (!Number.isFinite(n)) return lo
  return n < lo ? lo : n > hi ? hi : n
}

/**
 * Deterministic stringify (stable key order) for fingerprints and audit rows.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(/** @type {Record<string, unknown>} */ (value)).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(/** @type {any} */ (value)[k])}`).join(',')}}`
}

/**
 * Saturating squashing of an unbounded score into [0, 1).
 * @param {number} value
 * @param {number} [k]
 * @returns {number}
 */
export function saturate(value, k = 1) {
  const n = Math.max(0, Number(value) || 0)
  return n / (n + k)
}

/**
 * Serial async mutex. Every state mutation in the store funnels through one,
 * which is the whole concurrency model: single writer, lock-free readers.
 */
export class Mutex {
  #tail = Promise.resolve()

  /**
   * @template T
   * @param {() => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  runExclusive(fn) {
    const run = this.#tail.then(() => fn())
    this.#tail = run.then(() => undefined, () => undefined)
    return run
  }
}

/**
 * Durability primitive: write a temp sibling, then rename over the target.
 * @param {string} file
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(file, text) {
  const { mkdir, writeFile, rename } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBase36(6)}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

/**
 * Synchronous read used only during boot (snapshot + journal replay).
 * @param {string} file
 * @param {unknown} fallback
 * @returns {any}
 */
export function readJsonSync(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * Coalescing debounce with an explicit flush, used for snapshot persistence.
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {number} ms
 * @returns {{ call: (...args: Parameters<F>) => void, flush: () => void, cancel: () => void }}
 */
export function debounce(fn, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  /** @type {Parameters<F> | undefined} */
  let pending
  const call = (...args) => {
    pending = args
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      const args2 = pending
      pending = undefined
      if (args2 !== undefined) fn(...args2)
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
  }
  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    const args2 = pending
    pending = undefined
    if (args2 !== undefined) fn(...args2)
  }
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    pending = undefined
  }
  return { call, flush, cancel }
}
