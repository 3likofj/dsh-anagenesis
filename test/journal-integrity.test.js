/**
 * Wave 3: journal integrity is reported, not silently swallowed.
 *
 * The replay path already kept a torn line from bricking the plugin. What it
 * did not do was *say* that it had skipped one, or that a seq was missing from
 * the middle of the log. Those are the two failure modes where "it opened fine"
 * and "the store is complete" differ, so status now reports both.
 * @module dsh-anagenesis/test/journal-integrity
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '../src/store/store.js'
import { createMemoryOps } from '../src/memory/ops.js'

const quiet = { info() {}, warn() {}, debug() {} }

/** @param {string} dir @returns {Promise<string[]>} journal segment paths */
async function segments(dir) {
  const journalDir = join(dir, 'journal')
  return (await readdir(journalDir)).filter((name) => name.endsWith('.jsonl')).map((name) => join(journalDir, name))
}

test('journal integrity: a torn tail line is skipped and reported', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-journal-torn-'))
  try {
    const first = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const ops = createMemoryOps({ store: first })
    await ops.remember({ kind: 'fact', subject: 'one', body: 'one' })
    await ops.remember({ kind: 'fact', subject: 'two', body: 'two' })
    await first.close()

    // Cut the last event in half: exactly what a crash mid-append leaves.
    const files = await segments(dir)
    const last = files[files.length - 1]
    const text = await readFile(last, 'utf8')
    await writeFile(last, text.slice(0, text.length - 20), 'utf8')
    await rm(join(dir, 'snapshot.json'), { force: true })

    const second = await MemoryStore.open({ rootDir: dir, logger: quiet })
    assert.equal(Object.keys(second.state.memories).length, 1, 'the acknowledged write survived')
    assert.ok(second.journalStats().health.tornLines >= 1, 'the skipped line is reported')
    await second.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('journal integrity: a missing middle event shows up as a seq gap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ana-journal-gap-'))
  try {
    const first = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const ops = createMemoryOps({ store: first })
    await ops.remember({ kind: 'fact', subject: 'one', body: 'one' })
    await ops.remember({ kind: 'fact', subject: 'two', body: 'two' })
    await ops.remember({ kind: 'fact', subject: 'three', body: 'three' })
    await first.close()

    // Drop a complete middle event: every remaining line is valid JSON, so the
    // only evidence of loss is the hole in the seq sequence.
    const files = await segments(dir)
    const last = files[files.length - 1]
    const lines = (await readFile(last, 'utf8')).split('\n').filter((line) => line.trim() !== '')
    assert.ok(lines.length >= 3)
    await writeFile(last, `${[lines[0], ...lines.slice(2)].join('\n')}\n`, 'utf8')
    await rm(join(dir, 'snapshot.json'), { force: true })

    const second = await MemoryStore.open({ rootDir: dir, logger: quiet })
    const health = second.journalStats().health
    assert.deepEqual(health.gaps, [{ from: 2, to: 2 }], 'the missing seq is identified')
    assert.equal(second.state.version, 3, 'replay still reaches the last seq it has')
    await second.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
