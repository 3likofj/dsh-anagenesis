/**
 * Versioned artifacts: the wrapper that makes a rendered picture citable later.
 *
 * A diagram pasted into Markdown outlives the process that made it, so it has to
 * say what it is: the artifact version, the diagram kind and format, the store
 * version it was rendered from, when, whether it came from a live service or a
 * read-only mirror, and which redaction policy was applied. `normalizeArtifact`
 * is the other half of that promise — it accepts an artifact with no header at
 * all (the v0 shape: a bare diagram string) and one from a *newer* version,
 * because a viewer that only understands today's format is not versioned, it is
 * brittle.
 * @module dsh-anagenesis/viz/artifact
 */

export const ARTIFACT_VERSION = 1

export const ARTIFACT_MARK = 'anagenesis-viz'

const HEADER_RE = /^<!--\s*anagenesis-viz\s+v(\d+)\s*(.*?)\s*-->$/

/**
 * @param {any} model a diagram/dashboard model
 * @param {string} format
 * @param {{ includeBody?: boolean, bodyChars?: number }} [opts]
 * @returns {Record<string, string|number>}
 */
export function artifactMeta(model, format, opts = {}) {
  return {
    v: ARTIFACT_VERSION,
    kind: String(model?.kind ?? 'unknown'),
    format: String(format),
    store: Number(model?.store?.version ?? 0),
    schema: Number(model?.store?.schemaVersion ?? 0),
    at: new Date(Number(model?.generatedAt ?? Date.now())).toISOString(),
    origin: String(model?.origin ?? 'live'),
    redaction: String(model?.redaction?.level ?? 'secrets'),
    nodes: Array.isArray(model?.nodes) ? model.nodes.length : 0,
    edges: Array.isArray(model?.edges) ? model.edges.length : 0,
  }
}

/**
 * @param {Record<string, string|number>} meta
 * @returns {string}
 */
export function artifactHeader(meta) {
  const body = Object.entries(meta)
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, '_')}`)
    .join(' ')
  return `<!-- ${ARTIFACT_MARK} v${meta.v ?? ARTIFACT_VERSION} ${body} -->`
}

/**
 * Header + fenced body: paste-ready Markdown that carries its own provenance.
 * @param {Record<string, string|number>} meta
 * @param {string} body
 * @param {{ lang?: string }} [opts]
 * @returns {string}
 */
export function wrapArtifact(meta, body, opts = {}) {
  const lang = opts.lang ?? String(meta.format ?? '')
  return `${artifactHeader(meta)}\n\`\`\`${lang}\n${String(body).replace(/\s+$/, '')}\n\`\`\`\n`
}

/**
 * Parse an artifact of any version into `{ version, kind, format, meta, body }`.
 * Never throws: a viewer must be able to show *something* for input it does not
 * understand, and must be able to say that it does not understand it.
 * @param {unknown} raw
 * @returns {{ version: number, kind: string|null, format: string|null, meta: Record<string, string>, body: string, migratedFrom: string|null, unsupported: boolean, reason: string }}
 */
export function normalizeArtifact(raw) {
  const text = typeof raw === 'string'
    ? raw
    : raw !== null && typeof raw === 'object' && typeof (/** @type {any} */ (raw).text) === 'string'
      ? String(/** @type {any} */ (raw).text)
      : ''
  if (text === '') {
    return { version: 0, kind: null, format: null, meta: {}, body: '', migratedFrom: null, unsupported: true, reason: 'empty artifact' }
  }
  const lines = text.split('\n')
  const firstIndex = lines.findIndex((line) => line.trim() !== '')
  const first = firstIndex >= 0 ? lines[firstIndex].trim() : ''
  const match = HEADER_RE.exec(first)
  if (match === null) {
    // v0: a bare diagram body, no envelope at all. Still renderable.
    return { version: 0, kind: null, format: null, meta: {}, body: text.trim(), migratedFrom: 'v0', unsupported: false, reason: 'no header (pre-envelope artifact)' }
  }
  const version = Number(match[1])
  /** @type {Record<string, string>} */
  const meta = {}
  for (const pair of match[2].split(/\s+/)) {
    if (pair === '') continue
    const at = pair.indexOf('=')
    if (at <= 0) continue
    meta[pair.slice(0, at)] = pair.slice(at + 1)
  }
  const rest = lines.slice(firstIndex + 1).join('\n')
  const fenced = /^\s*(?:```|~~~)([A-Za-z0-9_-]*)\s*\n([\s\S]*?)\n?\s*(?:```|~~~)\s*$/.exec(rest)
  const body = (fenced === null ? rest : fenced[2]).replace(/\s+$/, '')
  const format = meta.format ?? (fenced === null ? null : fenced[1] || null)
  return {
    version,
    kind: meta.kind ?? null,
    format,
    meta,
    body,
    migratedFrom: version < ARTIFACT_VERSION ? `v${version}` : null,
    unsupported: version > ARTIFACT_VERSION,
    reason: version > ARTIFACT_VERSION ? `artifact v${version} is newer than this renderer (v${ARTIFACT_VERSION}); showing the raw body` : '',
  }
}