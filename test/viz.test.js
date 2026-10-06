/**
 * Visualization suite: models, the TUI frame, the diagram serializers, artifact
 * versioning, redaction and the read-only mirror.
 *
 * These tests are the reason the visualization layer can be trusted not to
 * disturb the engine: the first thing asserted is that rendering changes
 * nothing, and the mirror test asserts that a second process looking at a store
 * leaves the directory byte-identical.
 * @module dsh-anagenesis/test/viz.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '../src/store/store.js'
import { createMemoryOps } from '../src/memory/ops.js'
import { buildDashboardModel, buildDiagramModel, DASHBOARD_SECTIONS, DIAGRAM_KINDS } from '../src/viz/model.js'
import { displayWidth, renderFrame } from '../src/viz/tui.js'
import { DIAGRAM_FORMATS, renderDiagram } from '../src/viz/diagram.js'
import { ARTIFACT_VERSION, normalizeArtifact, wrapArtifact, artifactMeta } from '../src/viz/artifact.js'
import { readStoreMirror } from '../src/viz/mirror.js'
import { redactText, scrubSecrets } from '../src/viz/redact.js'
import { losslessIssues } from './lossless.mjs'

const quiet = { info() {}, warn() {}, debug() {} }

/** @param {(store: MemoryStore, dir: string) => Promise<void>} fn */
async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'evo-viz-'))
  const store = await MemoryStore.open({ rootDir: dir, logger: quiet })
  try {
    return await fn(store, dir)
  } finally {
    await store.close().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * A small store with links, lifecycle movement and a secret in a body — enough
 * for every projection to have something real to chew on.
 * @param {MemoryStore} store
 */
async function seed(store) {
  const ops = createMemoryOps({ store })
  // `state: 'active'` explicitly: without a strategy engine in the loop the ops
  // layer writes drafts, and the lifecycle diagram should be built from legal
  // transitions (draft→active→verified→locked), not from a forced one.
  const first = await ops.remember({ kind: 'constraint', subject: '记忆库只允许一个写者', body: 'append-only kg', confidence: 0.9, state: 'active' })
  const second = await ops.remember({ kind: 'failure', subject: 'guard read the wrong field', body: 'exec.args is undefined', confidence: 0.8, state: 'active' })
  const secret = await ops.remember({
    kind: 'fact',
    subject: 'deployment credential',
    body: 'Authorization: Bearer sk-live-abcdefghijklmnop and api_key=TOPSECRET12345',
    confidence: 0.5,
    state: 'active',
  })
  await ops.link({ from: first.id, to: second.id, rel: 'supports' })
  await ops.promote({ ids: [first.id], to: 'verified', reason: 'verified against the store implementation' })
  await ops.lock({ ids: [first.id], reason: 'core invariant' })
  return { first, second, secret }
}

/** Every directory entry with its size and mtime — a cheap "did anything write?" fingerprint. */
async function fingerprint(dir) {
  const hash = createHash('sha256')
  const walk = async (current) => {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name)
      const info = await stat(path)
      if (info.isDirectory()) await walk(path)
      else hash.update(`${path}:${info.size}:${await readFile(path, 'utf8')}`)
    }
  }
  await walk(dir)
  return hash.digest('hex')
}

test('viz: rendering is a pure projection — it never touches the store', async () => {
  await withStore(async (store) => {
    const seeded = await seed(store)
    const before = store.state
    const versionBefore = store.version
    const stateKeys = JSON.stringify({ memories: Object.keys(store.state.memories), stacks: store.state.stacks, params: store.state.params })

    const source = {
      state: store.state,
      events: store.recentEvents({ limit: 50 }),
      journal: store.journalStats(),
      engine: { active: store.state.stacks.global, health: [] },
      tuning: { metric: 0, samples: 0, applied: 0 },
    }
    const dashboard = buildDashboardModel(source, { redaction: 'secrets' })
    const frame = renderFrame(dashboard, { width: 88, color: 'never' })
    assert.ok(frame.includes('anagenesis dashboard'))
    for (const kind of DIAGRAM_KINDS) {
      const model = buildDiagramModel({ ...source, kind }, { kind, redaction: 'secrets' })
      for (const format of DIAGRAM_FORMATS) renderDiagram(model, { format })
    }

    assert.equal(store.version, versionBefore, 'a render is not a transaction')
    assert.equal(store.state, before, 'the state object was not replaced either')
    assert.equal(
      JSON.stringify({ memories: Object.keys(store.state.memories), stacks: store.state.stacks, params: store.state.params }),
      stateKeys,
    )
    assert.ok(store.state.memories[seeded.secret.id] !== undefined)
  })
})

test('viz: the frame is width-exact, including CJK labels', async () => {
  await withStore(async (store) => {
    await seed(store)
    const source = { state: store.state, events: store.recentEvents({ limit: 20 }), journal: store.journalStats() }
    for (const width of [60, 88, 120]) {
      const model = buildDashboardModel(source, { redaction: 'secrets', width })
      const frame = renderFrame(model, { width, color: 'never' })
      const lines = frame.split('\n')
      assert.ok(lines.length > 8, 'a frame with sections')
      const bottom = lines.findLastIndex((line) => line.startsWith('╰'))
      assert.ok(bottom > 0, 'the frame has a bottom border')
      for (const line of lines.slice(0, bottom + 1)) {
        assert.equal(displayWidth(line), width, `frame line is not exactly ${width} cells: ${JSON.stringify(line.slice(0, 40))}`)
      }
      // Everything after the border is a caption; it must fit, not fill.
      for (const caption of lines.slice(bottom + 1)) {
        assert.ok(displayWidth(caption) <= width, `caption wider than the frame: ${JSON.stringify(caption)}`)
      }
      assert.equal(lines[0].startsWith('╭'), true)
      assert.equal(lines[bottom].startsWith('╰'), true, 'the frame ends with its border; provenance is a caption below it')
    }
    // A CJK subject must not be cut mid-cell or counted as one cell per char.
    assert.equal(displayWidth('记忆库'), 6, 'three CJK characters occupy six cells')
    assert.equal(displayWidth('ab'), 2)
    const wide = buildDashboardModel(source, { redaction: 'secrets', width: 120 })
    const cjkLine = frameLineWith(wide, '记忆库只允许一个写者')
    assert.ok(cjkLine !== null, 'the CJK subject is rendered')
    assert.equal(displayWidth(cjkLine), 120, 'a line carrying CJK is still exactly the frame width')
  })
})

/**
 * @param {any} model
 * @param {string} needle
 * @returns {string|null}
 */
function frameLineWith(model, needle) {
  const frame = renderFrame(model, { width: 120, color: 'never' })
  return frame.split('\n').find((line) => line.includes(needle)) ?? null
}

test('viz: colour is opt-in, applied after padding, and never counted as width', async () => {
  await withStore(async (store) => {
    await seed(store)
    const source = { state: store.state, events: store.recentEvents({ limit: 10 }), journal: store.journalStats() }
    const model = buildDashboardModel(source, { redaction: 'secrets', width: 80 })
    const plain = renderFrame(model, { width: 80, color: 'never' })
    const coloured = renderFrame(model, { width: 80, color: 'always' })
    assert.ok(!plain.includes('\x1b['), 'no escapes when colour is off')
    assert.ok(coloured.includes('\x1b['), 'escapes when colour is asked for')
    for (const line of coloured.split('\n')) {
      // Strip SGR sequences first: the escapes must not count as width, and the
      // caption is only recognisable once they are gone.
      const bare = line.replace(/\x1b\[[0-9;]*m/g, '')
      assert.ok(displayWidth(bare) <= 80, 'nothing may exceed the frame width')
      if (bare.startsWith('  ')) continue // caption below the frame: fits, does not fill
      assert.equal(displayWidth(bare), 80, 'colour must be applied after padding, never counted as width')
    }
  })
})

test('viz: redaction scrubs credentials by default, masks labels in strict, and says so in the artifact', async () => {
  await withStore(async (store) => {
    const seeded = await seed(store)
    const source = { state: store.state, events: store.recentEvents({ limit: 10 }), journal: store.journalStats() }

    assert.equal(scrubSecrets('key sk-live-abcdefghijklmnop here').includes('sk-live'), false)
    assert.equal(scrubSecrets('Bearer abcdefghijklmnopqrstuvwx').includes('abcdefghijklmnopqrstuvwx'), false)
    assert.equal(scrubSecrets('api_key=TOPSECRET12345').includes('TOPSECRET12345'), false)
    assert.equal(scrubSecrets('memory id mem_0muwqtphgmpytmrmugd').includes('mem_0muwqtphgmpytmrmugd'), true, 'ids are not secrets')

    const dashboard = buildDashboardModel(source, { redaction: 'secrets', includeBody: true, limit: { salience: 10 } })
    const frame = renderFrame(dashboard, { width: 100, color: 'never' })
    assert.equal(frame.includes('sk-live-abcdefghijklmnop'), false, 'the dashboard never prints the raw credential')
    assert.equal(frame.includes('[redacted'), true, 'it prints the marker instead')
    assert.equal(dashboard.redaction.level, 'secrets')

    const strict = buildDashboardModel(source, { redaction: 'strict', limit: { salience: 10 } })
    const strictFrame = renderFrame(strict, { width: 100, color: 'never' })
    assert.equal(strictFrame.includes('记忆库只允许一个写者'), false, 'strict masks labels too')
    assert.equal(strictFrame.includes('[redacted constraint]'), true)

    const graph = buildDiagramModel({ ...source, kind: 'memory-graph' }, { kind: 'memory-graph', redaction: 'secrets', limit: { nodes: 10 } })
    const mermaid = renderDiagram(graph, { format: 'mermaid' })
    assert.equal(mermaid.source.includes('sk-live'), false)
    assert.match(mermaid.text, /redaction=secrets/, 'the artifact header records the policy')
    assert.equal(redactText('plain', 'none'), 'plain', 'none is the explicit escape hatch')
    assert.ok(seeded.secret.id.length > 0)
  })
})

test('viz: the memory graph renders links, marks targets outside the window, and honours the node cap', async () => {
  await withStore(async (store) => {
    const seeded = await seed(store)
    const source = { state: store.state, events: store.recentEvents({ limit: 10 }), journal: store.journalStats() }
    const full = buildDiagramModel({ ...source, kind: 'memory-graph' }, { kind: 'memory-graph', limit: { nodes: 10 } })
    assert.equal(full.nodes.length, 3)
    assert.equal(full.edges.length, 1)
    assert.equal(full.edges[0].rel, 'supports')
    assert.equal(full.edges[0].exists, true)
    const mermaid = renderDiagram(full, { format: 'mermaid' })
    assert.match(mermaid.source, /graph LR/)
    assert.match(mermaid.source, /-->|supports\|/)
    assert.match(mermaid.source, /classDef s_locked/)
    assert.equal((mermaid.source.match(/classDef s_locked/g) ?? []).length, 1, 'no duplicated class definitions')

    // Cap at one node: the link now points outside the window and must be
    // labelled as such rather than silently dropped.
    const capped = buildDiagramModel({ ...source, kind: 'memory-graph' }, { kind: 'memory-graph', limit: { nodes: 1 } })
    assert.equal(capped.nodes.length, 1)
    assert.equal(capped.warnings.length >= 1, true)
    const cappedMermaid = renderDiagram(capped, { format: 'mermaid' }).source
    if (capped.edges.length > 0 && capped.edges.some((edge) => edge.exists === false)) {
      assert.match(cappedMermaid, /\[missing\]/)
      assert.match(cappedMermaid, /dangling/)
    }
    assert.ok(seeded.first.id.length > 0)
  })
})

test('viz: lifecycle transitions come from the journal, and an empty window is not faked', async () => {
  await withStore(async (store) => {
    await seed(store)
    const source = { state: store.state, events: store.recentEvents({ limit: 50 }), journal: store.journalStats() }
    const model = buildDiagramModel({ ...source, kind: 'lifecycle' }, { kind: 'lifecycle' })
    const promoted = model.transitions.find((row) => row.from === 'active' && row.to === 'verified')
    assert.ok(promoted !== undefined, `expected an observed active→verified transition, got ${JSON.stringify(model.transitions)}`)
    assert.equal(promoted.count, 1)
    const locked = model.transitions.find((row) => row.to === 'locked')
    assert.ok(locked !== undefined, 'the lock operation reaches locked')
    assert.equal(locked.from, null, 'lock records only the destination — the diagram must not invent a source edge')
    assert.equal(locked.op, 'memory.lock')
    const mermaid = renderDiagram(model, { format: 'mermaid' }).source
    assert.match(mermaid, /stateDiagram-v2/)
    assert.match(mermaid, /active --> verified : 1/)
    assert.match(mermaid, /\[\*\] --> locked : lock ×1/)
    assert.match(mermaid, /%% current: draft=/)

    // No events at all: the declared machine is drawn and labelled as declared.
    const empty = buildDiagramModel({ state: store.state, events: [] }, { kind: 'lifecycle' })
    assert.equal(empty.transitions.length, 0)
    const declared = renderDiagram(empty, { format: 'mermaid' }).source
    assert.match(declared, /declared machine/)
  })
})

test('viz: artifacts are versioned — old ones migrate, newer ones degrade instead of throwing', async () => {
  const model = {
    kind: 'memory-graph',
    store: { version: 92, schemaVersion: 6 },
    generatedAt: 1_700_000_000_000,
    origin: 'live',
    redaction: { level: 'secrets' },
    nodes: [{ id: 'a' }],
    edges: [],
  }
  const meta = artifactMeta(model, 'mermaid')
  assert.equal(meta.v, ARTIFACT_VERSION)
  const wrapped = wrapArtifact(meta, 'graph LR\n  a["x"]')
  const parsed = normalizeArtifact(wrapped)
  assert.equal(parsed.version, ARTIFACT_VERSION)
  assert.equal(parsed.kind, 'memory-graph')
  assert.equal(parsed.format, 'mermaid')
  assert.equal(parsed.meta.store, '92')
  assert.equal(parsed.body, 'graph LR\n  a["x"]')
  assert.equal(parsed.unsupported, false)
  assert.equal(parsed.migratedFrom, null)

  // v0: an artifact from before there was an envelope — a bare diagram.
  const legacy = normalizeArtifact('graph LR\n  a-->b\n')
  assert.equal(legacy.version, 0)
  assert.equal(legacy.migratedFrom, 'v0')
  assert.equal(legacy.body, 'graph LR\n  a-->b')
  assert.equal(legacy.unsupported, false)

  // A future artifact: show the body, say that you do not understand it.
  const future = normalizeArtifact('<!-- anagenesis-viz v99 kind=memory-graph format=mermaid -->\n```mermaid\ngraph LR\n```\n')
  assert.equal(future.unsupported, true)
  assert.equal(future.migratedFrom, null)
  assert.equal(future.body, 'graph LR')
  assert.match(future.reason, /newer than this renderer/)

  // Garbage must not throw either.
  const empty = normalizeArtifact('')
  assert.equal(empty.unsupported, true)
  assert.equal(normalizeArtifact(null).body, '')
})

test('viz: the mirror agrees with the store it mirrors, and never writes a byte', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'evo-mirror-'))
  try {
    const store = await MemoryStore.open({ rootDir: dir, logger: quiet })
    await seed(store)
    const version = store.version
    const memoryIds = Object.keys(store.state.memories).sort()
    const stacks = JSON.stringify(store.state.stacks)
    const params = JSON.stringify(store.state.params)
    const stats = JSON.stringify(store.state.stats)
    await store.close()

    // Snapshot-less: the mirror must rebuild from the journal alone.
    await rm(join(dir, 'snapshot.json'), { force: true })
    const before = await fingerprint(dir)
    const mirror = await readStoreMirror(dir)
    const after = await fingerprint(dir)

    assert.equal(mirror.readOnly, true)
    assert.equal(mirror.state.version, version, 'same version')
    assert.deepEqual(Object.keys(mirror.state.memories).sort(), memoryIds)
    assert.equal(JSON.stringify(mirror.state.stacks), stacks)
    assert.equal(JSON.stringify(mirror.state.params), params)
    assert.equal(JSON.stringify(mirror.state.stats), stats, 'counters replay too')
    assert.equal(mirror.events.length > 0, true)
    assert.equal(mirror.events[0].seq >= mirror.events[mirror.events.length - 1].seq, true, 'newest first, like recentEvents()')
    assert.equal(after, before, 'reading a store through the mirror must not change the directory')

    // The two open paths must agree, which is what keeps the small duplication
    // in mirror.js honest.
    const reopened = await MemoryStore.open({ rootDir: dir, logger: quiet })
    assert.equal(reopened.state.version, mirror.state.version)
    assert.deepEqual(Object.keys(reopened.state.memories).sort(), Object.keys(mirror.state.memories).sort())
    assert.equal(JSON.stringify(reopened.state.tuning), JSON.stringify(mirror.state.tuning))
    await reopened.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('viz: the mirror replays a compacted store (checkpoint + archive) correctly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'evo-mirror-compact-'))
  try {
    const store = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const ops = createMemoryOps({ store })
    for (let index = 0; index < 4; index++) {
      await ops.remember({ kind: 'fact', subject: `fact ${index}`, body: `body ${index}` })
    }
    await store.compact({ minEvents: 1 })
    const version = store.version
    const ids = Object.keys(store.state.memories).sort()
    await store.close()
    await rm(join(dir, 'snapshot.json'), { force: true })

    const mirror = await readStoreMirror(dir)
    assert.equal(mirror.state.version, version)
    assert.deepEqual(Object.keys(mirror.state.memories).sort(), ids, 'a checkpoint + archive replay rebuilds the same records')
    assert.equal(mirror.journal.archives, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('viz: every model and tool-shaped payload is lossless JSON', async () => {
  await withStore(async (store) => {
    await seed(store)
    const source = {
      state: store.state,
      events: store.recentEvents({ limit: 50 }),
      journal: store.journalStats(),
      engine: { active: ['guard', 'exploit'], health: [] },
      tuning: { metric: 0.5, samples: 3, applied: 1 },
      selfStatus: { renders: 2, diagrams: 1, lastAt: 1_700_000_000_000, errors: 0, mode: 'tool' },
      origin: 'live',
    }
    const models = [
      buildDashboardModel(source, { redaction: 'secrets', includeBody: true }),
      ...DIAGRAM_KINDS.map((kind) => buildDiagramModel({ ...source, kind }, { kind })),
    ]
    for (const model of models) {
      assert.deepEqual(losslessIssues(model), [], `model ${model.kind} must survive a JSON round trip`)
    }
    assert.deepEqual(DASHBOARD_SECTIONS.length, 8)
  })
})