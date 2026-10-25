/**
 * The recall-quality dashboard section (Wave 4).
 *
 * It reads the audit trail rather than a telemetry buffer: every `recall()`
 * already journals what it selected, dropped, spent and rejected, so the
 * dashboard and the journal can never disagree — and a read-only mirror shows
 * the same numbers as the live service.
 * @module dsh-anagenesis/test/recall-dashboard
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildDashboardModel } from '../src/viz/model.js'
import { emptyState } from '../src/store/schema.js'

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0)

test('recall dashboard: an empty store says there is nothing to show', () => {
  const state = emptyState(NOW)
  const model = buildDashboardModel({ state }, { sections: ['recall'], now: NOW })
  const section = model.sections[0]
  assert.equal(section.id, 'recall')
  assert.equal(section.rows[0].label, 'recalls')
  assert.equal(section.rows[0].value, '(no recalls yet)')
})

test('recall dashboard: it summarises selection, cost and the top blocker', () => {
  const state = emptyState(NOW)
  state.audit = [
    { id: 'aud_9', at: NOW - 1000, type: 'recall', detail: { intent: 'orient', selected: 0, dropped: 9, tokens: 20, rejected: { relevance: 40 } } },
    {
      id: 'aud_10',
      at: NOW,
      type: 'recall',
      detail: {
        intent: 'recall_fact',
        selected: 2,
        dropped: 5,
        tokens: 120,
        rejected: { relevance: 30, scope: 12, superseded: 1 },
        graph: { revived: 1, edges: 2 },
      },
    },
  ]
  const model = buildDashboardModel({ state }, { sections: ['recall'], now: NOW })
  const section = model.sections[0]
  assert.match(section.title, /last 2/)
  const labels = section.rows.map((row) => row.label)
  assert.ok(labels.includes('recalls'))
  assert.ok(labels.includes('tokens'))
  assert.ok(labels.includes('blocked by'))
  const summary = section.rows.find((row) => row.label === 'recalls')
  assert.match(summary.value, /2 · 2 selected \/ 14 dropped/)
  const blocked = section.rows.find((row) => row.label === 'blocked by')
  assert.match(blocked.value, /relevance × 70/, 'the strongest reason across the window wins')
  assert.ok(section.rows.some((row) => /recall_fact · 2 sel · 5 drop · 120 tok/.test(row.value)))
})

test('recall dashboard: the section is translated in the terminal frame', () => {
  const state = emptyState(NOW)
  const model = buildDashboardModel({ state }, { sections: ['recall'], now: NOW, lang: 'zh' })
  assert.match(model.sections[0].title, /召回质量/)
})
