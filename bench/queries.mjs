/**
 * The query set, with gold grades.
 *
 * Grade 2 = the record the question is about, 1 = useful context, 0 = a trap
 * that must not be injected (stale duplicate, superseded rule, other project).
 * A query with an empty gold map is a *no-gold* query: the honest answer is
 * "nothing relevant", so every selected record counts as contamination.
 * @module dsh-anagenesis/bench/queries
 */

import { PROJECT_P1, PROJECT_P2, SESSION, TOPICS } from './corpus.mjs'

/** @typedef {{ [id: string]: number }} GoldMap */

/**
 * @typedef {object} BenchQuery
 * @property {string} id
 * @property {string} intent
 * @property {string} text
 * @property {string} bucket
 * @property {string} projectId
 * @property {string|null} sessionId
 * @property {boolean} crossProject
 * @property {GoldMap} gold
 * @property {string[]} forbidden records that must never appear (scope leaks)
 * @property {number} maxTokens
 */

const DEFAULT_TOKENS = 700

/** Queries derived from the topic table. */
const topicQueries = TOPICS.flatMap((topic) => topic.queries.map((query) => {
  /** @type {GoldMap} */
  const gold = { [`mem_${topic.key}`]: query.grade ?? 2, ...(query.extraGold ?? {}) }
  return {
    id: query.id,
    intent: query.intent,
    text: query.text,
    bucket: query.bucket ?? 'exact',
    projectId: topic.scope === 'p2' ? PROJECT_P2 : PROJECT_P1,
    sessionId: topic.scope === 'session' ? SESSION : null,
    crossProject: false,
    gold,
    forbidden: [],
    maxTokens: DEFAULT_TOKENS,
  }
}))

/** @type {BenchQuery[]} */
const structuralQueries = [
  {
    id: 'q-dedupe-1',
    intent: 'reuse_procedure',
    text: '构建 pnpm build 命令',
    bucket: 'dedupe',
    projectId: PROJECT_P1,
    sessionId: null,
    crossProject: false,
    gold: { 'mem_build-cmd': 2, 'mem_dupe-old': 0 },
    forbidden: [],
    maxTokens: DEFAULT_TOKENS,
  },
  {
    id: 'q-supersede-1',
    intent: 'orient',
    text: '发布前 需要跑哪些 门禁 闸门',
    bucket: 'supersede',
    projectId: PROJECT_P1,
    sessionId: null,
    crossProject: false,
    // release-flow and pack-gate are genuinely useful context here; the old
    // rule (supersede-old) is the trap that must not come back.
    gold: { 'mem_supersede-new': 2, 'mem_release-flow': 1, 'mem_pack-gate': 1, 'mem_supersede-old': 0 },
    forbidden: [],
    maxTokens: DEFAULT_TOKENS,
  },
  {
    // Same words as a record that belongs to *another* project. In p1 the
    // correct answer is nothing: the p2 records must not even be candidates.
    id: 'q-scope-1',
    intent: 'recall_fact',
    text: 'python 依赖 安装 方式 pip uv',
    bucket: 'scope',
    projectId: PROJECT_P1,
    sessionId: null,
    crossProject: false,
    gold: {},
    forbidden: ['mem_py-version', 'mem_conflict-p2'],
    maxTokens: DEFAULT_TOKENS,
  },
  {
    id: 'q-scope-2',
    intent: 'recall_fact',
    text: 'python 依赖 安装 方式 pip uv',
    bucket: 'scope',
    projectId: PROJECT_P2,
    sessionId: null,
    crossProject: false,
    gold: { 'mem_py-version': 2 },
    forbidden: [],
    maxTokens: DEFAULT_TOKENS,
  },
  {
    // The explicit authorization: the other project's records may come in, but
    // only as down-weighted context (grade 1), never as the answer.
    id: 'q-cross-1',
    intent: 'recall_fact',
    text: 'python 依赖 安装 方式 pip uv',
    bucket: 'cross-project',
    projectId: PROJECT_P1,
    sessionId: null,
    crossProject: true,
    gold: { 'mem_py-version': 1, 'mem_conflict-p2': 1 },
    forbidden: [],
    maxTokens: DEFAULT_TOKENS,
  },
  {
    id: 'q-session-2',
    intent: 'recall_precedent',
    text: 'provider 更新提示 断线',
    bucket: 'session',
    projectId: PROJECT_P1,
    sessionId: SESSION,
    crossProject: false,
    gold: { 'mem_session-031': 2 },
    forbidden: [],
    maxTokens: DEFAULT_TOKENS,
  },
  {
    // No-gold queries: every selected record is contamination.
    id: 'q-noise-1',
    intent: 'recall_fact',
    text: 'Kubernetes Ingress 证书 怎么配',
    bucket: 'irrelevant',
    projectId: PROJECT_P1,
    sessionId: null,
    crossProject: false,
    gold: {},
    forbidden: [],
    maxTokens: DEFAULT_TOKENS,
  },
  {
    id: 'q-noise-2',
    intent: 'recall_precedent',
    text: '如何用 Figma 做深色模式 设计稿',
    bucket: 'irrelevant',
    projectId: PROJECT_P1,
    sessionId: null,
    crossProject: false,
    gold: {},
    forbidden: [],
    maxTokens: DEFAULT_TOKENS,
  },
  {
    id: 'q-noise-3',
    intent: 'avoid_mistake',
    text: 'Postgres 主从复制延迟 怎么排查',
    bucket: 'irrelevant',
    projectId: PROJECT_P1,
    sessionId: null,
    crossProject: false,
    gold: {},
    forbidden: [],
    maxTokens: DEFAULT_TOKENS,
  },
  {
    id: 'q-noise-4',
    intent: 'reuse_procedure',
    text: 'Docker 镜像 体积 优化 多阶段构建',
    bucket: 'irrelevant',
    projectId: PROJECT_P1,
    sessionId: null,
    crossProject: false,
    gold: {},
    forbidden: [],
    maxTokens: DEFAULT_TOKENS,
  },
]

/** @type {BenchQuery[]} */
export const QUERIES = [...topicQueries, ...structuralQueries]

/** @returns {string[]} every bucket present in the set */
export function buckets() {
  return [...new Set(QUERIES.map((query) => query.bucket))]
}

/** @returns {string[]} every intent present in the set */
export function intents() {
  return [...new Set(QUERIES.map((query) => query.intent))]
}
