/**
 * Migration v8: `confirmedAt` backfill.
 *
 * The rule from HANDOFF §3.10 is that a storage change is not tested by writing
 * new data — it is tested by taking the *old* shape and forcing the upgrade
 * path. So this suite does both halves:
 *   1. the pure document chain (`migrateState` on a v7 document), and
 *   2. a real journal rewritten to the pre-v8 shape, replayed with no snapshot.
 * @module dsh-anagenesis/test/migration-v8
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryOps } from '../src/memory/ops.js'
import { MemoryStore } from '../src/store/store.js'
import { SCHEMA_VERSION, migrateState } from '../src/store/schema.js'

const quiet = { info() {}, warn() {}, debug() {} }

test('migration v8: a pre-v8 document gets confirmedAt from createdAt', () => {
  const state = migrateState({
    schemaVersion: 7,
    version: 3,
    memories: {
      old: {
        id: 'old',
        kind: 'fact',
        subject: 'written before v8',
        body: 'no confirmedAt here',
        gist: 'written before v8',
        tags: [],
        links: [],
        state: 'active',
        confidence: 0.8,
        salience: 0.5,
        scope: { tier: 'global', global: true },
        provenance: { source: 'agent', evidence: [] },
        createdAt: 111,
        updatedAt: 222,
        expiresAt: null,
        supersedes: [],
        supersededBy: null,
        parentId: null,
        access: { count: 0, hits: 0, misses: 0, lastAt: null },
        salienceByScope: {},
        embedding: [],
        schemaVersion: 7,
      },
    },
  }, 999)

  assert.equal(state.schemaVersion, SCHEMA_VERSION)
  assert.equal(state.memories.old.confirmedAt, 111, 'creation time, not the edit time')
  assert.equal(state.memories.old.updatedAt, 222, 'the old field is preserved, not rewritten')
})

test('migration v8: a journal written before v8 replays with confirmedAt backfilled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-migrate-v8-'))
  try {
    const first = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const ops = createMemoryOps({ store: first })
    const saved = await ops.remember({ kind: 'fact', subject: 'old shape', body: 'written before v8' })
    const createdAt = first.state.memories[saved.id].createdAt
    await first.close()

    // Rewrite the journal into the pre-v8 shape: no `confirmedAt` anywhere.
    const journalDir = join(dir, 'journal')
    const files = (await readdir(journalDir)).filter((name) => name.endsWith('.jsonl'))
    assert.ok(files.length > 0, 'the write produced a journal segment')
    let stripped = 0
    for (const name of files) {
      const path = join(journalDir, name)
      const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.trim() !== '')
      const rewritten = lines.map((line) => {
        const event = JSON.parse(line)
        for (const record of Object.values(event?.patch?.memorySet ?? {})) {
          if (Object.hasOwn(record, 'confirmedAt')) {
            delete record.confirmedAt
            stripped += 1
          }
        }
        for (const record of Object.values(event?.undo?.memorySet ?? {})) {
          if (Object.hasOwn(record, 'confirmedAt')) delete record.confirmedAt
        }
        return JSON.stringify(event)
      })
      await writeFile(path, `${rewritten.join('\n')}\n`, 'utf8')
    }
    assert.ok(stripped > 0, 'the fixture really removed the new field')

    // No snapshot: the store has to rebuild from the old journal alone.
    await rm(join(dir, 'snapshot.json'), { force: true })
    const second = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const record = second.state.memories[saved.id]
    assert.equal(record.confirmedAt, createdAt, 'replay backfills from createdAt')
    assert.equal(record.body, 'written before v8')
    await second.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
