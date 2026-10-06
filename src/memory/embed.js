/**
 * Self-contained embedding: a deterministic hashing vectorizer.
 *
 * Chosen over a bundled vector database on purpose — it needs no native
 * dependency, no model download and no network, its output is stable across
 * restarts (so a journal replay reproduces identical scores), and at the store
 * sizes this plugin targets (10^3–10^5 records) an in-memory dot product is
 * faster than a round trip to any external index. The backend is *pluggable*:
 * `registerEmbedProvider` adds one, `resolveEmbedder` turns an id or an inline
 * spec into `{ id, dim, embed }`, and the service can swap it at runtime with
 * `useEmbedder` — after which `reembed()` rebuilds the stored vectors in one
 * revertible transaction and stamps `state.embed` with the backend that
 * produced them, so a half-migrated store is *detectable* rather than silently
 * ranking noise.
 * @module dsh-anagenesis/memory/embed
 */

import { hash32, tokenize } from '../util.js'

export const EMBED_DIM = 192

/**
 * @param {string} text
 * @param {{ dim?: number }} [opts]
 * @returns {number[]} L2-normalized, 4-decimal-quantized dense vector
 */
export function embed(text, opts = {}) {
  const dim = opts.dim ?? EMBED_DIM
  const vector = new Float64Array(dim)
  const tokens = tokenize(text)
  for (const token of tokens) {
    const h = hash32(token)
    // Two signed projections per token keeps collisions from cancelling out.
    vector[h % dim] += 1
    vector[(h >>> 7) % dim] -= 0.5
  }
  let norm = 0
  for (let i = 0; i < dim; i++) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  const out = new Array(dim)
  for (let i = 0; i < dim; i++) {
    const value = norm === 0 ? 0 : vector[i] / norm
    out[i] = Math.round(value * 10000) / 10000
  }
  return out
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} cosine similarity in [-1, 1]
 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/** The built-in backend, described the same way an installed one would be. */
export const HASH_PROVIDER = Object.freeze({
  id: 'hash',
  dim: EMBED_DIM,
  label: 'deterministic hashed bag-of-words (no dependency, no network, stable across restarts)',
})

/** @type {Map<string, { id: string, dim: number, embed: (text: string) => number[] }>} */
const PROVIDERS = new Map()

/**
 * Register a vector backend so configuration (or `service.useEmbedder`) can
 * select it by id.
 *
 * The contract is synchronous on purpose: recall embeds the query inside a
 * scoring pass that has no place to await. A backend that needs I/O should
 * therefore cache its vectors itself and expose a synchronous lookup here —
 * the store's own contract does not change either way.
 * @param {string} id
 * @param {(text: string) => number[]} embedFn
 * @param {{ dim?: number }} [opts] probed from `embedFn('')` when omitted
 * @returns {() => void} disposer that withdraws the provider
 */
export function registerEmbedProvider(id, embedFn, opts = {}) {
  const key = String(id)
  if (key === HASH_PROVIDER.id) throw new Error(`anagenesis: "${key}" is the built-in provider and cannot be replaced`)
  const dim = Number(opts.dim ?? embedFn('').length)
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`anagenesis: embed provider "${key}" returned no usable dimension (got ${dim})`)
  }
  PROVIDERS.set(key, { id: key, dim, embed: (text) => embedFn(String(text)) })
  return () => { PROVIDERS.delete(key) }
}

/** @returns {string[]} every id `resolveEmbedder` accepts */
export function listEmbedProviders() {
  return [HASH_PROVIDER.id, ...PROVIDERS.keys()]
}

/**
 * Turn a provider spec into a usable `{ id, dim, embed }`.
 *
 * Accepts an id (registered, or the built-in `'hash'`) or an inline
 * `{ id?, dim?, embed }`. Unknown ids throw instead of silently falling back:
 * a typo in configuration that quietly vectorised the store with the wrong
 * backend would be worse than a failed boot.
 * @param {string|{ id?: string, dim?: number, embed: (text: string) => number[] }|null|undefined} spec
 * @returns {{ id: string, dim: number, embed: (text: string) => number[] }}
 */
export function resolveEmbedder(spec) {
  if (spec === undefined || spec === null || spec === HASH_PROVIDER.id) {
    return { ...HASH_PROVIDER, embed: (text) => embed(String(text)) }
  }
  if (typeof spec === 'string') {
    const found = PROVIDERS.get(spec)
    if (found === undefined) {
      throw new Error(`anagenesis: unknown embed provider "${spec}" (known: ${listEmbedProviders().join(', ')})`)
    }
    return found
  }
  if (typeof spec === 'object' && typeof spec.embed === 'function') {
    const id = String(spec.id ?? 'inline')
    const dim = Number(spec.dim ?? spec.embed('').length)
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`anagenesis: embed provider "${id}" returned no usable dimension (got ${dim})`)
    }
    return { id, dim, embed: (text) => spec.embed(String(text)) }
  }
  throw new Error('anagenesis: an embed provider must be a registered id, or an object carrying an embed(text) function')
}
