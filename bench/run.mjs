#!/usr/bin/env node
/**
 * Retrieval benchmark entry point.
 *
 *   node bench/run.mjs                 # print the table, compare with the baseline
 *   node bench/run.mjs --save-baseline # rewrite bench/baseline.json (intentional act)
 *   node bench/run.mjs --verbose       # show the first miss of every query
 *   node bench/run.mjs --json          # machine-readable result only
 *
 * The comparison is the gate: a change that lowers nDCG/MRR/Recall or raises
 * contamination beyond tolerance exits non-zero. There is no randomness and no
 * clock input, so two runs on the same commit are identical.
 * @module dsh-anagenesis/bench/run
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { buildBenchStore, NOW } from './corpus.mjs'
import { QUERIES } from './queries.mjs'
import { contamination, fmt, leaks, mean, mrr, ndcg, precisionAtK, recallAtK } from './metrics.mjs'
import { recall } from '../src/memory/recall.js'
import { createScopeFilter } from '../src/scope/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'baseline.json')

const argv = new Set(process.argv.slice(2))
const SAVE = argv.has('--save-baseline')
const JSON_ONLY = argv.has('--json')
const VERBOSE = argv.has('--verbose')

/** Tolerance: a metric may wobble this much without failing the gate. */
const TOLERANCE = { ndcg10: 0.01, mrr: 0.01, recall5: 0.01, precision5: 0.01, contamination: 0.02, leaks: 0, tokensPerRelevant: 0.15 }

/**
 * @param {{ state: any, now: number }} bench
 * @param {import('./queries.mjs').BenchQuery} query
 * @returns {Promise<{ id: string, bucket: string, intent: string, metrics: any, selected: string[], memoryTokens: number, rejected: any }>}
 */
async function runOne(bench, query) {
  const request = {
    intent: query.intent,
    query: query.text,
    maxTokens: query.maxTokens,
  }
  const context = {
    scopeFilter: createScopeFilter({
      projectId: query.projectId,
      sessionId: query.sessionId,
      crossProject: query.crossProject,
      authorized: query.crossProject,
      reason: query.crossProject ? 'bench: explicit cross-project query' : '',
    }),
  }
  const result = await recall({ state: bench.state }, request, {
    params: {},
    context,
    now: () => bench.now,
  })
  const selected = result.selected.map((row) => row.id)
  const relevantSelected = selected.filter((id) => (query.gold[id] ?? 0) > 0).length
  const metrics = {
    ndcg10: ndcg(selected, query.gold, 10),
    mrr: mrr(selected, query.gold),
    recall5: recallAtK(selected, query.gold, 5),
    precision5: precisionAtK(selected, query.gold, 5),
    contamination: contamination(selected, query.gold),
    leaks: leaks(selected, query.forbidden),
    tokensPerRelevant: relevantSelected === 0 ? null : result.memoryTokens / relevantSelected,
    selected: selected.length,
  }
  return {
    id: query.id,
    bucket: query.bucket,
    intent: query.intent,
    selected,
    memoryTokens: result.memoryTokens,
    rejected: result.rejected,
    metrics,
  }
}

/**
 * @param {any[]} rows
 * @returns {Record<string, number|null>}
 */
function aggregate(rows) {
  return {
    ndcg10: mean(rows.map((row) => row.metrics.ndcg10)),
    mrr: mean(rows.map((row) => row.metrics.mrr)),
    recall5: mean(rows.map((row) => row.metrics.recall5)),
    precision5: mean(rows.map((row) => row.metrics.precision5)),
    contamination: mean(rows.map((row) => row.metrics.contamination)),
    leaks: rows.reduce((sum, row) => sum + row.metrics.leaks, 0),
    tokensPerRelevant: mean(rows.map((row) => row.metrics.tokensPerRelevant)),
    selected: mean(rows.map((row) => row.metrics.selected)),
    queries: rows.length,
  }
}

/**
 * @param {string} title
 * @param {Record<string, number|null>} row
 * @param {Record<string, number|null>} [base]
 */
function printRow(title, row, base) {
  const delta = (key) => {
    if (base === undefined || base?.[key] === null || base?.[key] === undefined || row[key] === null) return '     '
    const diff = row[key] - base[key]
    return `${diff >= 0 ? '+' : ''}${diff.toFixed(3)}`
  }
  const pad = (value, width) => String(value).padEnd(width)
  console.log([
    pad(title, 22),
    pad(fmt(row.ndcg10), 7), pad(delta('ndcg10'), 7),
    pad(fmt(row.mrr), 7), pad(delta('mrr'), 7),
    pad(fmt(row.recall5), 8), pad(delta('recall5'), 7),
    pad(fmt(row.precision5), 8),
    pad(fmt(row.contamination), 8), pad(delta('contamination'), 7),
    pad(String(row.leaks), 6),
    pad(row.tokensPerRelevant === null ? '-' : row.tokensPerRelevant.toFixed(0), 8),
    pad(row.selected === null ? '-' : row.selected.toFixed(1), 6),
  ].join(' '))
}

const bench = buildBenchStore(NOW)
const results = []
for (const query of QUERIES) results.push(await runOne(bench, query))

const overall = aggregate(results)
const byBucket = Object.fromEntries(
  [...new Set(results.map((row) => row.bucket))].sort().map((bucket) => [bucket, aggregate(results.filter((row) => row.bucket === bucket))]),
)
const byIntent = Object.fromEntries(
  [...new Set(results.map((row) => row.intent))].sort().map((intent) => [intent, aggregate(results.filter((row) => row.intent === intent))]),
)

/** @type {any} */
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null
const payload = {
  generatedAt: new Date().toISOString(),
  corpus: { records: Object.keys(bench.state.memories).length, queries: QUERIES.length },
  overall,
  buckets: byBucket,
  intents: byIntent,
}

if (SAVE) {
  writeFileSync(BASELINE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  if (!JSON_ONLY) console.log(`bench: baseline written to ${BASELINE}`)
}

const failures = []
if (baseline !== null) {
  for (const key of ['ndcg10', 'mrr', 'recall5', 'precision5']) {
    const before = baseline.overall?.[key]
    const after = overall[key]
    if (typeof before === 'number' && typeof after === 'number' && after < before - TOLERANCE[key]) {
      failures.push(`${key} dropped ${before.toFixed(3)} -> ${after.toFixed(3)}`)
    }
  }
  for (const key of ['contamination']) {
    const before = baseline.overall?.[key]
    const after = overall[key]
    if (typeof before === 'number' && typeof after === 'number' && after > before + TOLERANCE[key]) {
      failures.push(`${key} rose ${before.toFixed(3)} -> ${after.toFixed(3)}`)
    }
  }
  if (overall.leaks > (baseline.overall?.leaks ?? 0) + TOLERANCE.leaks) {
    failures.push(`scope leaks ${baseline.overall?.leaks ?? 0} -> ${overall.leaks}`)
  }
  const beforeTokens = baseline.overall?.tokensPerRelevant
  if (typeof beforeTokens === 'number' && typeof overall.tokensPerRelevant === 'number') {
    if (overall.tokensPerRelevant > beforeTokens * (1 + TOLERANCE.tokensPerRelevant)) {
      failures.push(`tokens/relevant rose ${beforeTokens.toFixed(0)} -> ${overall.tokensPerRelevant.toFixed(0)}`)
    }
  }
}

if (JSON_ONLY) {
  console.log(JSON.stringify({ ...payload, baseline: baseline?.overall ?? null, failures }, null, 2))
} else {
  console.log(`\nretrieval bench · ${payload.corpus.records} records · ${payload.corpus.queries} queries${baseline === null ? ' · no baseline' : ''}\n`)
  console.log([
    'group'.padEnd(22), 'nDCG'.padEnd(7), 'Δ'.padEnd(7), 'MRR'.padEnd(7), 'Δ'.padEnd(7),
    'R@5'.padEnd(8), 'Δ'.padEnd(7), 'P@5'.padEnd(8), 'contam'.padEnd(8), 'Δ'.padEnd(7),
    'leaks'.padEnd(6), 'tok/rel'.padEnd(8), 'sel',
  ].join(' '))
  console.log('-'.repeat(112))
  printRow('overall', overall, baseline?.overall)
  for (const [bucket, row] of Object.entries(byBucket)) printRow(`  ${bucket}`, row, baseline?.buckets?.[bucket])
  console.log('')
  for (const [intent, row] of Object.entries(byIntent)) printRow(`  intent:${intent}`, row, baseline?.intents?.[intent])

  if (VERBOSE) {
    console.log('\nmisses:')
    for (const row of results) {
      const query = QUERIES.find((entry) => entry.id === row.id)
      const relevant = Object.entries(query.gold).filter(([, grade]) => grade > 0).map(([id]) => id)
      const missed = relevant.filter((id) => !row.selected.includes(id))
      const traps = row.selected.filter((id) => (query.gold[id] ?? 0) <= 0)
      if (missed.length === 0 && traps.length === 0) continue
      console.log(`  ${row.id.padEnd(16)} selected=[${row.selected.join(', ')}] missing=${missed.join(',') || '-'} traps=${traps.join(',') || '-'}`)
    }
  }

  if (failures.length > 0) {
    console.log('\nBENCH REGRESSED:')
    for (const failure of failures) console.log(`  - ${failure}`)
    console.log('')
  } else if (baseline !== null) {
    console.log('\nbench: no regression against baseline\n')
  }
}

process.exit(failures.length > 0 ? 1 : 0)
