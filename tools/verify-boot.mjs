#!/usr/bin/env node
/**
 * verify:boot — replay the real-host boot contract, repeatably.
 *
 * The one-time reproduction ("21 checks, ALL CHECKS PASSED") that validated the
 * `TypeError: Invalid effect` fix was a throwaway script. This is that script,
 * hardened into a repeatable command. It answers one question:
 *
 *   does the code in `src/` survive a real Cordis boot, against the REAL host
 *   libraries shipped inside the running application's asar?
 *
 * Why the asar and not a stub: the fatal defect this guards against was *not*
 * visible under stubs. Cordis collects an `apply` result as an effect, and a
 * plain object tears the whole fibre down — including every `ctx.provide` and
 * every `ctx.tools.register` the body already performed. The symptom is "nothing
 * happened", not an exception. Only the real `Fiber._execute` / `safeCollect`
 * and the real `defineTool` schema compiler can catch that.
 *
 * What it does, in order:
 *   1. reads the asar index and extracts the transitive dependency closure of
 *      `@deepseek-ai/{cordis,dsh-tools,schemastery}` into a scratch sandbox;
 *   2. writes a resolution hook into that sandbox and registers it with
 *      `module.register`, so the plugin's bare host imports resolve there;
 *   3. imports the REAL `src/**` modules and drives five rows through a full
 *      mount -> observe -> unload cycle;
 *   4. prints one PASS/FAIL line per contract check and exits non-zero on any
 *      failure, keeping the sandbox for inspection.
 *
 * Hard constraints this script is built around (see HANDOFF.md §10.7):
 *   - it NEVER writes under `D:\cj\anagenesis\node_modules`; a package-local copy
 *     of a host library would shadow the host's own instance and produce two
 *     copies of `Service`/`defineTool`. Everything goes to `%TEMP%`.
 *   - it NEVER touches the user's real `$DSH_HOME\anagenesis` store. `DSH_HOME`
 *     is redirected into the sandbox *before* any `src/` module is imported, the
 *     store gets an explicit `rootDir` inside the sandbox, and the real store's
 *     tree is fingerprinted before and after to prove nothing moved.
 *
 * On the last point: the real store belongs to the *live* DSH host, which may be
 * appending to it while this script runs (a restarted host writing journal
 * entries is normal, not a failure). "The directory did not change" is therefore
 * not a sound assertion, and the script does not make it. Non-interference is
 * proven instead by three things that a concurrent writer cannot confuse:
 *   1. redirection: `DSH_HOME` and `defaultRootDir()` both resolve inside the
 *      sandbox before any plugin module is loaded;
 *   2. structure: the mounted store's `rootDir` is asserted to be inside the
 *      sandbox and outside the real store;
 *   3. disjointness: every `(ts, type)` pair this run wrote to the sandbox
 *      journal must be absent from the real store's journal. If this process had
 *      opened the real store, its transactions would be there verbatim.
 *
 * env:
 *   DSH_ASAR      override the asar path (default: the installed Desktop app)
 *   ANA_KEEP_TMP  1/true to keep the sandbox even on success
 * @module dsh-anagenesis/tools/verify-boot
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { register } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ── fixed inputs ─────────────────────────────────────────────────────────────

/** Resolved from this file so the script never depends on the cwd. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

const DEFAULT_ASAR = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'

/** The three host packages the plugin's adapter rows import (plus their closure). */
const ROOT_PACKAGES = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', 'js-yaml']

/**
 * The tools `anagenesis-tools` (the always-on row) must compile with the real
 * `defineTool`. It is the **read tier only** — every one of these can be called
 * without a preset, and none of them writes a memory. The write tier is separate
 * on purpose (`GATED_TOOLS` below): it is registered by `tools/gated.js` inside a
 * live preset grant, which is the fix for "memories were written with no preset
 * enabled".
 */
const EXPECTED_TOOLS = [
  'ana_recall', 'ana_list', 'ana_audit', 'ana_scope', 'ana_preset', 'ana_strategy', 'ana_tune',
]

/**
 * The write tier, registered only by `dsh-anagenesis/tools-gated`. This list is
 * asserted to be *absent* before the preset mounts and *present* after — the
 * boot-time version of the permission test.
 */
const GATED_TOOLS = [
  'ana_remember', 'ana_promote', 'ana_demote', 'ana_lock', 'ana_expire', 'ana_split',
  'ana_rethink', 'ana_forget', 'ana_feedback', 'ana_link',
]

/**
 * The visualization row's two tools. They are counted separately on purpose: the
 * fourteen are the memory surface, these two are optional projections of it.
 */
const VIZ_TOOLS = ['ana_dashboard', 'ana_diagram']

/** In the asar, all runtime packages live under this prefix. */
const ASAR_NODE_MODULES = 'dsh/node_modules/'

const KEEP_TMP = ['1', 'true', 'yes', 'on'].includes(String(process.env.ANA_KEEP_TMP ?? '').trim().toLowerCase())

// ── reporting ────────────────────────────────────────────────────────────────

let checkCount = 0
let failureCount = 0
/** Everything written to stdout while the rows are mounted, for log assertions. */
const hostLog = []

/** @param {string} line */
function say(line) {
  hostLog.push(line)
  process.stdout.write(`${line}\n`)
}

/**
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(label, ok, detail = '') {
  checkCount++
  if (!ok) failureCount++
  say(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

/** A fatal environment problem: not a contract failure, so it exits 2. */
class FatalError extends Error {}

/**
 * @param {string} message
 * @returns {never}
 */
function fatal(message) {
  throw new FatalError(message)
}

// ── small helpers ────────────────────────────────────────────────────────────

const TIMEOUT = Symbol('timeout')
/** @param {number} ms */
const sleep = (ms) => new Promise((done) => setTimeout(() => done(TIMEOUT), ms))

/**
 * Await a fibre's activation, bounded. A row that never settles because an
 * `inject` never arrives is exactly the first-boot symptom, so "did not settle"
 * must be a reported outcome rather than a hang.
 * @param {any} fiber
 * @param {number} [ms]
 */
async function settle(fiber, ms = 3000) {
  try {
    const result = await Promise.race([fiber.await(), sleep(ms)])
    return result === TIMEOUT ? { settled: false, error: undefined } : { settled: true, error: undefined }
  } catch (error) {
    return { settled: true, error }
  }
}

/**
 * @param {() => boolean} predicate
 * @param {number} [ms]
 */
async function waitFor(predicate, ms = 4000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(25)
  }
}

/** Cordis fibre states that matter here (see HANDOFF §4.1 item 7). */
const ACTIVE = 2

/**
 * True when `child` is `parent` or lives under it.
 * @param {string} child
 * @param {string} parent
 */
function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Refuse to write anywhere inside the plugin package. The whole point of the
 * sandbox is that it lives outside; a package-local `node_modules` would shadow
 * the host's module instances (HANDOFF §10.7).
 * @param {string} target
 */
function assertOutsidePackage(target) {
  if (isInside(target, PACKAGE_ROOT)) {
    fatal(`refusing to write inside the plugin package: ${target}\n         (a package-local node_modules shadows the host's module instances — HANDOFF §10.7)`)
  }
}

/**
 * 旧包名用的存储目录名。
 *
 * 这里**故意重复**一份字面量，而不是从 `src/index.js` 导入：本脚本的不变量是
 * "任何 src 模块都在 DSH_HOME 被重定向进沙箱之后才加载"，而指纹必须在重定向
 * **之前**取。为了不让副本漂移，`runChecks` 里有一条断言把它和插件导出的
 * `LEGACY_ROOT_DIR_NAME` 比一次（那时已经可以安全 import 了）。
 * @type {string}
 */
const LEGACY_STORE_DIR_NAME = 'evolution'

/**
 * Stable textual fingerprint of a directory tree: entry names, sizes, mtimes.
 * Used to prove the user's real memory store was not touched.
 * @param {string} root
 * @returns {string}
 */
function fingerprintTree(root) {
  if (!existsSync(root)) return 'ABSENT'
  const lines = [`${root}`]
  try {
    lines.push(`self ${statSync(root).mtimeMs}`)
  } catch {
    lines.push('self ?')
  }
  const walk = (dir, rel) => {
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, item.name)
      const path = rel === '' ? item.name : `${rel}/${item.name}`
      if (item.isDirectory()) {
        lines.push(`d ${path}`)
        walk(full, path)
      } else {
        try {
          const st = statSync(full)
          lines.push(`f ${path} ${st.size} ${st.mtimeMs}`)
        } catch {
          lines.push(`f ${path} ?`)
        }
      }
    }
  }
  walk(root, '')
  return lines.join('\n')
}

/**
 * Every transaction in a journal directory, parsed leniently: a concurrent
 * writer can leave a half-flushed last line, which is not our problem to fix.
 * @param {string} journalDir
 * @returns {{ ts: number, type: string, seq: number }[]}
 */
function readJournalEvents(journalDir) {
  if (!existsSync(journalDir)) return []
  /** @type {{ ts: number, type: string, seq: number }[]} */
  const events = []
  for (const name of readdirSync(journalDir).sort()) {
    if (!name.endsWith('.jsonl')) continue
    let text
    try {
      text = readFileSync(join(journalDir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const event = JSON.parse(line)
        if (typeof event?.ts === 'number' && typeof event?.type === 'string') {
          events.push({ ts: event.ts, type: event.type, seq: event.seq })
        }
      } catch {
        // truncated tail from a concurrent append
      }
    }
  }
  return events
}

// ── asar reading ─────────────────────────────────────────────────────────────

/**
 * The asar header is a pair of nested pickles:
 *   [u32 4][u32 headerSize][u32 strSize + 4][u32 strSize][json...]
 * so the JSON starts at byte 16 and every file offset is relative to
 * `8 + headerSize`.
 * @param {string} archive
 * @returns {{ entries: { path: string, offset: number, size: number }[], buffer: Buffer, baseOffset: number }}
 */
function readAsar(archive) {
  const buffer = readFileSync(archive)
  const headerSize = buffer.readUInt32LE(4)
  const stringSize = buffer.readUInt32LE(12)
  let header
  try {
    header = JSON.parse(buffer.subarray(16, 16 + stringSize).toString('utf8').replace(/\0+$/, ''))
  } catch (error) {
    fatal(`${archive} is not an asar archive (the header is not JSON: ${error?.message}).\n`
      + '         DSH_ASAR must point at resources/app.asar itself, not at a directory, a package.json or an unpacked tree.')
  }
  if (header?.files === undefined) fatal(`${archive} has an asar header but no file table — refusing to guess.`)
  /** @type {{ path: string, offset: number, size: number }[]} */
  const entries = []
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (entry.files) walk(entry, path)
      else entries.push({ path, offset: Number(entry.offset), size: entry.size })
    }
  }
  walk(header, '')
  return { entries, buffer, baseOffset: 8 + headerSize }
}

/**
 * Index every `node_modules/<name>/` directory in the archive, keeping the
 * shallowest occurrence of a name (a hoisted copy beats a nested one).
 *
 * Scoped strictly to `dsh/node_modules/`: this asar ships TWO package trees — the
 * Electron shell has its own root-level `node_modules`, and the harness server
 * runs out of `dsh/`. Mixing them would extract one tree's files under the
 * other's paths (and silently pick up a different copy of a host library, which
 * is the two-instances hazard of HANDOFF §10.7 in a different costume).
 *
 * @param {{ path: string }[]} entries
 * @returns {{ packages: Map<string, string>, skipped: number }} name -> asar directory
 */
function indexPackages(entries) {
  /** @type {Map<string, { dir: string, depth: number }>} */
  const found = new Map()
  let skipped = 0
  const pattern = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//g
  for (const entry of entries) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(entry.path)) !== null) {
      const name = match[1]
      const at = match.index + (match[0].startsWith('/') ? 1 : 0)
      const dir = `${entry.path.slice(0, at)}node_modules/${name}/`
      if (!dir.startsWith(ASAR_NODE_MODULES)) {
        skipped++
        continue
      }
      const depth = dir.split('/').length
      const previous = found.get(name)
      if (previous === undefined || depth < previous.depth) found.set(name, { dir, depth })
    }
  }
  /** @type {Map<string, string>} */
  const packages = new Map()
  for (const [name, hit] of found) packages.set(name, hit.dir)
  return { packages, skipped }
}

/** Bare specifiers that could be a package import (not a path, not a builtin). */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\brequire(?:\.resolve)?\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
]

/** @param {string} specifier */
function isBareSpecifier(specifier) {
  if (specifier === '') return false
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return false
  if (specifier.startsWith('node:')) return false
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)
}

/** @param {string} specifier */
function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * Extract the transitive closure of `roots` into `<sandbox>/node_modules`.
 *
 * Members come from two sources, both grounded in the archive: a package's
 * declared `dependencies`, and the bare specifiers its own JS actually mentions.
 * Peer dependencies are deliberately NOT followed blindly — `dsh-tools` peer-
 * depends on half the harness, and following that would drag in a large tree
 * that its `lib/index.js` never imports. If it does import one, the source scan
 * finds it.
 *
 * @param {{ entries: any[], buffer: Buffer, baseOffset: number }} archive
 * @param {Map<string, string>} index
 * @param {string} sandbox
 * @returns {{ extracted: string[], files: number, missing: string[] }}
 */
function extractClosure(archive, index, sandbox) {
  const { entries, buffer, baseOffset } = archive
  // Longest directory first, so a nested `node_modules` claims its own files
  // before the hoisted package it sits inside can.
  const dirs = [...index.entries()].sort((a, b) => b[1].length - a[1].length)
  const byDir = new Map()
  for (const entry of entries) {
    for (const [name, dir] of dirs) {
      if (entry.path.startsWith(dir)) {
        if (!byDir.has(name)) byDir.set(name, [])
        byDir.get(name).push(entry)
        break
      }
    }
  }

  const readEntry = (entry) => buffer.subarray(baseOffset + entry.offset, baseOffset + entry.offset + entry.size)

  /** @type {Set<string>} */
  const done = new Set()
  /** @type {string[]} */
  const missing = []
  const queue = [...ROOT_PACKAGES]
  let files = 0

  while (queue.length > 0) {
    const name = /** @type {string} */ (queue.shift())
    if (done.has(name)) continue
    const members = byDir.get(name)
    const root = index.get(name)
    if (members === undefined || root === undefined) {
      missing.push(name)
      continue
    }
    done.add(name)

    for (const entry of members) {
      const target = join(sandbox, 'node_modules', name, entry.path.slice(root.length))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, readEntry(entry))
      files++
    }

    const wanted = new Set()
    const manifest = members.find((entry) => entry.path === `${root}package.json`)
    if (manifest !== undefined) {
      try {
        const json = JSON.parse(readEntry(manifest).toString('utf8'))
        for (const dep of Object.keys(json.dependencies ?? {})) wanted.add(dep)
      } catch {
        // A malformed manifest cannot be a source of truth; the source scan below still runs.
      }
    }
    for (const entry of members) {
      if (!/\.(?:js|mjs|cjs)$/.test(entry.path)) continue
      const text = readEntry(entry).toString('utf8')
      for (const pattern of SPECIFIER_PATTERNS) {
        pattern.lastIndex = 0
        let match
        while ((match = pattern.exec(text)) !== null) {
          const specifier = match[1]
          if (isBareSpecifier(specifier)) wanted.add(packageNameOf(specifier))
        }
      }
    }
    for (const dep of wanted) {
      if (!done.has(dep) && index.has(dep)) queue.push(dep)
    }
  }

  return { extracted: [...done].sort(), files, missing }
}

/**
 * The resolution hook, written INTO the sandbox: it captures the sandbox path by
 * value, so no environment plumbing is needed and a stale copy is impossible.
 *
 * The trick is one line: for a bare specifier we own, re-resolve with the parent
 * URL pointed at an anchor file inside the sandbox. Node then applies its full
 * native package resolution — `exports`, conditions, nested `node_modules` —
 * from there, which is exactly what we want and what a hand-rolled resolver
 * would get subtly wrong.
 * @param {string} sandbox
 * @param {string[]} packages
 * @returns {string}
 */
function renderHooks(sandbox, packages) {
  return `/**
 * Generated by tools/verify-boot.mjs — do not edit; it is rewritten on every run.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ANCHOR = pathToFileURL(join(${JSON.stringify(sandbox)}, 'node_modules', '__verify_anchor__.mjs')).href
const OWNED = new Set(${JSON.stringify(packages)})

function isBare(specifier) {
  if (specifier === '') return false
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return false
  if (specifier.startsWith('node:')) return false
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)
}

function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

export async function resolve(specifier, context, next) {
  if (isBare(specifier) && OWNED.has(packageNameOf(specifier))) {
    return next(specifier, { ...context, parentURL: ANCHOR })
  }
  return next(specifier, context)
}
`
}

// ── the boot contract ────────────────────────────────────────────────────────

/**
 * Mirror of Cordis's own effect rules (`Fiber._execute` -> `safeCollect`), so a
 * failure names the rule instead of just "the fibre died". Verified against the
 * real library by the contrast checks below.
 * @param {unknown} value
 * @returns {{ legal: boolean, kind: string }}
 */
function classifyEffect(value) {
  if (value === null || value === undefined) return { legal: true, kind: 'void' }
  if (typeof value === 'function') return { legal: true, kind: 'disposer function' }
  if (typeof value === 'object') {
    if (typeof (/** @type {any} */ (value).then) === 'function') return { legal: true, kind: 'thenable' }
    if (typeof (/** @type {any} */ (value)[Symbol.iterator]) === 'function') return { legal: true, kind: 'sync iterable' }
    if (typeof (/** @type {any} */ (value)[Symbol.asyncIterator]) === 'function') return { legal: true, kind: 'async iterable' }
    return { legal: false, kind: `plain object ${Object.prototype.toString.call(value)}` }
  }
  return { legal: false, kind: typeof value }
}

/** @param {string} needle */
const logged = (needle) => hostLog.some((line) => line.includes(needle))

/**
 * @param {{ storeDir: string, sandbox: string, sandboxHome: string, realStore: string }} paths
 */
async function runChecks(paths) {
  const { sandbox, storeDir } = paths
  const runStartedAt = Date.now()

  // ── the real host libraries ────────────────────────────────────────────────
  const { Context } = await import('@deepseek-ai/cordis')
  const coreRow = await import(new URL('../src/index.js', import.meta.url).href)
  const toolsRow = await import(new URL('../src/tools/index.js', import.meta.url).href)
  const guardRow = await import(new URL('../src/guard/index.js', import.meta.url).href)
  const bindRow = await import(new URL('../src/preset/bind.js', import.meta.url).href)
  const presetRow = await import(new URL('../src/preset/index.js', import.meta.url).href)
  const { MemoryStore } = await import(new URL('../src/store/store.js', import.meta.url).href)

  const ctx = new Context()

  // Cordis's LoggerService buffers into an exporter chain instead of stdout, so
  // the rows' startup lines are invisible unless we tap the instance. These are
  // the exact lines the real restart is judged on (HANDOFF §7), which makes them
  // worth asserting rather than eyeballing in the host's log.
  /** @type {string[]} */
  const warnings = []
  for (const level of ['info', 'warn', 'debug', 'error']) {
    const base = ctx.logger?.[level]?.bind(ctx.logger)
    if (typeof base !== 'function') continue
    ctx.logger[level] = (...args) => {
      const line = `${level}: ${String(args[0])}`
      hostLog.push(line)
      if (level === 'warn' || level === 'error') warnings.push(line)
      return base(...args)
    }
  }

  // Stand-in for the DSH `tools` service. Only the *service surface* is
  // substituted — the definitions flowing through it are compiled by the REAL
  // `defineTool` from the real `@deepseek-ai/dsh-tools`, which is what the check
  // is about. The real service cannot be used here: it injects dsh-agent,
  // dsh-session and the approval stack, i.e. a whole running harness.
  /** @type {{ name: string, definition: any }[]} */
  const registered = []
  /** @type {((exec: any) => any)[]} */
  const guards = []
  ctx.provide('tools', {
    register(definition) {
      registered.push({ name: definition.name, definition })
      return () => {
        const at = registered.findIndex((row) => row.definition === definition)
        if (at >= 0) registered.splice(at, 1)
      }
    },
    guard(guard) {
      guards.push(guard)
      return () => {
        const at = guards.indexOf(guard)
        if (at >= 0) guards.splice(at, 1)
      }
    },
    restrict() {
      throw new Error('tools.restrict() requires a scoped context')
    },
  })

  // ── 0. the bundle patch the host reads before any of these rows exist ──────
  // `cordis.patch.yml` is parsed at boot. A YAML error there, or a config key a
  // row's own schema refuses, takes the whole plugin off the next load (HANDOFF
  // §10.15 is the preset-shaped version of exactly that). So: parse it with the
  // host's own js-yaml, out of the same asar, and validate every row config
  // against the real `Config` schema of the row it names.
  {
    const yamlModule = await import('js-yaml')
    const yaml = yamlModule.default ?? yamlModule
    const patchPath = join(PACKAGE_ROOT, 'cordis.patch.yml')
    let patch = null
    let parseError = null
    try {
      patch = yaml.load(readFileSync(patchPath, 'utf8'))
    } catch (error) {
      parseError = error
    }
    check('bundle: cordis.patch.yml parses under the host\'s own js-yaml',
      parseError === null && Array.isArray(patch),
      parseError === null ? `${Array.isArray(patch) ? patch.length : 0} top-level entr(ies)` : `${parseError?.name}: ${parseError?.message}`)
    const rows = (patch ?? []).find((entry) => entry?.insert !== undefined)?.insert ?? []
    const rowIds = rows.map((row) => row.id)
    check('bundle: the patch inserts the five rows, each with a unique id',
      rowIds.length === 5 && new Set(rowIds).size === 5
      && ['anagenesis-core', 'anagenesis-tools', 'anagenesis-guard', 'anagenesis-preset', 'anagenesis-viz'].every((id) => rowIds.includes(id)),
      `ids=${rowIds.join(', ')}`)

    // The row modules this package actually exports, by id.
    const rowsById = {
      'anagenesis-core': { module: await import(new URL('../src/index.js', import.meta.url).href), expected: 'dsh-anagenesis' },
      'anagenesis-tools': { module: await import(new URL('../src/tools/index.js', import.meta.url).href), expected: 'dsh-anagenesis/tools' },
      'anagenesis-guard': { module: await import(new URL('../src/guard/index.js', import.meta.url).href), expected: 'dsh-anagenesis/guard' },
      'anagenesis-preset': { module: await import(new URL('../src/preset/index.js', import.meta.url).href), expected: 'dsh-anagenesis/preset' },
      'anagenesis-viz': { module: await import(new URL('../src/viz/index.js', import.meta.url).href), expected: 'dsh-anagenesis/viz' },
    }
    const nameMismatch = []
    const configProblems = []
    for (const row of rows) {
      const target = rowsById[row.id]
      if (target === undefined) {
        configProblems.push(`${row.id}: not a row this package exports`)
        continue
      }
      if (row.name !== target.expected) nameMismatch.push(`${row.id} → ${row.name} (expected ${target.expected})`)
      if (row.config === undefined) continue
      /** @type {Set<string>} */
      let declared
      try {
        // Resolving the schema is what the host does with the row's config, and
        // the resolved defaults are the schema's own key list — a key that is not
        // in it is a key the row will never read.
        declared = new Set(Object.keys(target.module.Config({}) ?? {}))
        target.module.Config(row.config)
      } catch (error) {
        configProblems.push(`${row.id}: ${error?.message ?? String(error)}`)
        continue
      }
      const unknown = Object.keys(row.config).filter((key) => !declared.has(key))
      if (unknown.length > 0) {
        configProblems.push(`${row.id}: unknown key(s) ${unknown.join(', ')} — schemastery tolerates them, so the row would silently ignore the value and use its default`)
      }
    }
    check('bundle: every patch row names the module that implements it', nameMismatch.length === 0,
      nameMismatch.join(' | ') || 'core/tools/guard/preset/viz all match their row ids')
    check('bundle: every row config key is one that row\'s Config schema declares', configProblems.length === 0,
      configProblems.join(' | ') || `all configs resolve and declare every key (${rows.filter((row) => row.config !== undefined).length} row(s) with config)`)
    // This is why the check above compares key sets instead of relying on a
    // throw: measured against the real schemastery in the sandbox, not assumed.
    // It also settles the open question left in HANDOFF §10.15.
    let lenient = false
    try {
      lenient = rowsById['anagenesis-viz'].module.Config({ bogusKeyProbe: true })?.bogusKeyProbe === true
    } catch {
      lenient = false
    }
    check('bundle: schemastery really does tolerate unknown config keys (the gate above is not a throw in disguise)',
      lenient === true,
      lenient ? 'unknown keys survive resolution — HANDOFF §10.15 resolved: they never threw' : 'unknown keys now throw: the key-set check still holds, but the §10.15 note needs updating')
    check('bundle: only anagenesis-viz declares config keys nothing else reads',
      (rows.find((row) => row.id === 'anagenesis-viz')?.config?.auditRenders) === false,
      'auditRenders defaults to false: a render must not grow the journal')
  }

  // ── 1. anagenesis-core ──────────────────────────────────────────────────────
  /** @type {unknown[]} */
  const coreReturns = []
  const core = ctx.plugin({
    name: coreRow.name,
    inject: coreRow.inject,
    apply: async (inner, config) => {
      const value = await coreRow.apply(inner, config)
      coreReturns.push(value)
      return /** @type {any} */ (value)
    },
  }, { rootDir: storeDir, safeMode: false, autoSweepExpired: false })

  const coreResult = await settle(core)
  check('anagenesis-core: apply completed without error', coreResult.error === undefined,
    coreResult.error === undefined ? '' : `${coreResult.error?.name}: ${coreResult.error?.message}`)
  check('anagenesis-core: fibre is active (state=2)', core.state === ACTIVE, `state=${core.state}`)

  const effect = classifyEffect(coreReturns[0])
  check('anagenesis-core: apply resolved to an effect-legal value', effect.legal,
    `returned ${effect.kind}${effect.legal ? '' : ' — Cordis would throw TypeError and roll the whole body back'}`)

  const service = ctx.get('anagenesis', false)
  check('anagenesis-core: ctx.anagenesis is published', Boolean(service))
  if (service === undefined) {
    fatal('anagenesis-core published no service; every later check would be meaningless')
  }

  // ── 1b. two *concurrent* mounts of this same row ───────────────────────────
  // This is the live preset failure, reproduced with the real Cordis. The
  // bundle row mounts `anagenesis-core` globally while the `anagenesis` preset
  // mounts it again; when the two overlap, both used to pass the idempotence
  // check while the other was still awaiting its store, and the loser's
  // `ctx.provide` threw
  //   service "anagenesis" has been registered at <anagenesis-core>
  // which the preset registry reports as the whole preset being broken.
  {
    const raceCtx = new Context()
    const mount = () => raceCtx.plugin({
      name: coreRow.name,
      inject: coreRow.inject,
      apply: coreRow.apply,
    }, { rootDir: join(sandbox, 'race-store'), safeMode: false, autoSweepExpired: false })
    // Both fibers are created in the same tick on purpose: that is what makes
    // the two `MemoryStore.acquire()` calls interleave.
    const raceResults = await Promise.all([settle(mount()), settle(mount())])
    const failures = raceResults.filter((result) => result.error !== undefined || result.settled === false)
    check('anagenesis-core: two concurrent mounts settle without a duplicate-service error',
      failures.length === 0,
      failures.length === 0
        ? 'both mounts completed'
        : failures.map((result) => (result.error === undefined ? 'did not settle' : `${result.error?.name}: ${result.error?.message}`)).join(' | '))
    check('anagenesis-core: the concurrent mounts published exactly one service',
      raceCtx.get('anagenesis', false) !== undefined, 'ctx.get("anagenesis", false) resolves after both mounts')
  }

  check('anagenesis-core: store rootDir is the sandbox store', resolve(service.rootDir) === resolve(storeDir),
    `rootDir=${service.rootDir}`)
  check('anagenesis-core: store rootDir is inside the temp sandbox', isInside(service.rootDir, sandbox))
  check('anagenesis-core: store rootDir is NOT the real $DSH_HOME store', !isInside(service.rootDir, paths.realStore))
  check('anagenesis-core: service surface is complete',
    ['store', 'registry', 'engine', 'tuner', 'ops'].every((key) => service[key] !== undefined)
    && typeof service.recall === 'function' && typeof service.status === 'function')
  check('anagenesis-core: store opened its own journal inside the sandbox',
    resolve(service.store.rootDir) === resolve(storeDir) && existsSync(join(storeDir, 'journal')))
  const status = service.status()
  check('anagenesis-core: status() reports the live store', status.schemaVersion === 7 && status.rootDir === service.rootDir,
    `schemaVersion=${status.schemaVersion} stacks=${JSON.stringify(status.stacks?.global)}`)
  check('anagenesis-core: status() exposes the journal layout across the adapter boundary',
    typeof status.journal?.live === 'number' && typeof status.journal?.archives === 'number'
    && typeof status.journal?.checkpoints === 'number' && status.journal?.pruned?.throughSeq === 0,
    `journal=${JSON.stringify(status.journal)}`)
  check('anagenesis-core: logged the store-ready line the restart will be judged on',
    logged('anagenesis: store ready at'), `expected: "anagenesis: store ready at ${storeDir} ..."`)

  // ── 1b. the real store is out of reach, by construction ────────────────────
  check('safety: DSH_HOME was redirected into the sandbox before any src module loaded',
    process.env.DSH_HOME === paths.sandboxHome && isInside(paths.sandboxHome, sandbox),
    `DSH_HOME=${process.env.DSH_HOME}`)
  check('safety: src/index.js defaultRootDir() resolves inside the sandbox',
    isInside(coreRow.defaultRootDir(), sandbox),
    `defaultRootDir()=${coreRow.defaultRootDir()} — resolves from DSH_HOME, so the plugin's own fallback cannot reach the real store`)
  check('safety: the preset directory-form target resolves inside the sandbox',
    isInside(join(paths.sandboxHome, '.agent-presets', 'anagenesis'), sandbox))
  check('safety: the real store was not on the path this run opened',
    !isInside(storeDir, paths.realStore) && !isInside(paths.realStore, storeDir), `realStore=${paths.realStore}`)
  // 本脚本为了在重定向之前取指纹而自带了一份旧目录名字面量；这里把它和插件导出的
  // 那一份比一次，副本漂移会当场变红。
  check('safety: the legacy store name this script witnesses matches the plugin constant',
    coreRow.LEGACY_ROOT_DIR_NAME === LEGACY_STORE_DIR_NAME,
    `script=${LEGACY_STORE_DIR_NAME} plugin=${coreRow.LEGACY_ROOT_DIR_NAME}`)
  // 回退链本身也要有证据：三种输入各走一条分支。
  check('safety: resolveRootDir() adopts a legacy store, never an empty new one', (() => {
    const legacy = join(paths.sandboxHome, LEGACY_STORE_DIR_NAME)
    const current = join(paths.sandboxHome, 'anagenesis')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'snapshot.json'), '{"state":{"version":1,"memories":{}}}\n', 'utf8')
    rmSync(current, { recursive: true, force: true })
    const adopted = coreRow.resolveRootDir('')
    const explicit = coreRow.resolveRootDir(join(paths.sandboxHome, 'explicit'))
    // 全新安装：两个目录都不存在 → 用新目录。
    rmSync(legacy, { recursive: true, force: true })
    const fresh = coreRow.resolveRootDir('')
    return adopted.rootDir === legacy && adopted.source === 'legacy'
      && explicit.source === 'config' && explicit.rootDir.endsWith('explicit')
      && fresh.source === 'new' && fresh.rootDir === current
  })(), 'legacy → 沿用旧目录；显式配置 → 听配置；都没有 → 用新目录')

  // ⚠️ 真机翻车过的那一条：`Config.rootDir` 有 `.default(defaultRootDir())`，行加载时
  // 就已经被填好了，于是 `apply()` 永远看到非空 rootDir → 回退链在生产里根本走不到。
  // 当时那条单元断言只调了 `resolveRootDir('')`，**测的是函数不是接线**，所以全绿而
  // 真机显示"0 条记忆"。这里把真实形状补上：把 schema 默认值原样当入参传进去。
  check('safety: the schema-default rootDir still falls back to a richer legacy store', (() => {
    const legacy = join(paths.sandboxHome, LEGACY_STORE_DIR_NAME)
    const current = join(paths.sandboxHome, 'anagenesis')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'snapshot.json'), '{"state":{"version":9,"memories":{"a":{},"b":{}}}}\n', 'utf8')
    // 新目录也存在、也有存储，但是**空的** —— 正是插件自己建出来的那一个。
    mkdirSync(current, { recursive: true })
    writeFileSync(join(current, 'snapshot.json'), '{"state":{"version":2,"memories":{}}}\n', 'utf8')
    const viaSchemaDefault = coreRow.resolveRootDir(coreRow.defaultRootDir())
    const blank = coreRow.resolveRootDir('')
    rmSync(legacy, { recursive: true, force: true })
    rmSync(current, { recursive: true, force: true })
    return viaSchemaDefault.rootDir === legacy && viaSchemaDefault.source === 'legacy'
      && blank.rootDir === legacy && blank.source === 'legacy'
  })(), 'schema 默认值必须当作"没配"；旧存储更丰富时必须胜出 —— 否则用户会看到一个 0 条记忆的空存储')

  // ── 2. anagenesis-guard ─────────────────────────────────────────────────────
  // How many guards exist before this row mounts: the core row installs a tier
  // guard of its own as a fallback, so a profile that disables the guard row still
  // refuses writes with no grant. This row adds exactly two more.
  const guardsBeforeGuardRow = guards.length
  const guard = ctx.plugin({ name: guardRow.name, inject: guardRow.inject, apply: guardRow.apply }, {})
  const guardResult = await settle(guard)
  check('anagenesis-guard: starts with tools+anagenesis injected',
    guardResult.error === undefined && guard.state === ACTIVE,
    guardResult.error === undefined ? `state=${guard.state}` : `${guardResult.error?.name}: ${guardResult.error?.message}`)
  check('anagenesis-guard: installed exactly two guards (arguments + tier)', guards.length === guardsBeforeGuardRow + 2,
    `guards=${guards.length} (${guardsBeforeGuardRow} before the row)`)
  check('anagenesis-guard: logged its install line', logged('anagenesis-guard: monotonic tool guard + tier permission guard installed'))

  // Identify the guards by behaviour rather than by index: the core row's fallback
  // tier guard is registered before this row's, so slot 0 is not the argument
  // guard. A guard that *admits* a well-formed write and *denies* the same call
  // without a reason is the argument guard; a guard that denies a write with no
  // preset grant is the tier guard. Naming them by what they do keeps this check
  // honest even if the registration order changes again.
  const wellFormedForget = { name: 'ana_forget', args: { ids: [], reason: 'because it is stale' } }
  const argumentGuard = guards.find((installed) => installed(wellFormedForget) === undefined)
  const tierGuard = guards.find((installed) => typeof installed({ name: 'ana_remember', arguments: { subject: 'x', body: 'y' } }) === 'string')

  if (argumentGuard !== undefined) {
    const installed = argumentGuard
    const allow = installed({ name: 'ana_recall', args: { intent: 'orient' } })
    const deny = installed({ name: 'ana_forget', args: { ids: [], reason: 'x' } })
    const allow2 = installed(wellFormedForget)
    const unrelated = installed({ name: 'some_other_plugin_tool', args: { ids: new Array(999).fill('x') } })
    check('anagenesis-guard: the guard admits a legal ana_* call', allow === undefined, `returned ${JSON.stringify(allow)}`)
    check('anagenesis-guard: the guard denies an illegal ana_* call',
      typeof deny === 'string' && deny.length > 0, `returned ${JSON.stringify(deny)?.slice(0, 110)}`)
    check('anagenesis-guard: the same call is admitted once it is well-formed', allow2 === undefined,
      `returned ${JSON.stringify(allow2)}`)
    check('anagenesis-guard: the guard never touches another plugin\'s tools', unrelated === undefined,
      `returned ${JSON.stringify(unrelated)}`)
  } else {
    check('anagenesis-guard: an argument guard is installed', false, 'no guard admitted a well-formed ana_forget')
  }

  // The tier guard is the second, independent layer: with no preset grant in this
  // sandbox it refuses a write-tier call and admits a read-tier one, whatever the
  // argument guard thinks.
  if (tierGuard !== undefined) {
    const write = tierGuard({ name: 'ana_remember', arguments: { subject: 'x', body: 'y' } })
    const read = tierGuard({ name: 'ana_recall', arguments: { intent: 'orient' } })
    const admin = tierGuard({ name: 'ana_strategy', arguments: { action: 'switch', id: 'debug' } })
    const inspect = tierGuard({ name: 'ana_strategy', arguments: { action: 'list' } })
    check('anagenesis-guard: the tier guard refuses a write while no preset grant exists',
      typeof write === 'string' && /preset is not active/.test(write), `returned ${JSON.stringify(write)?.slice(0, 110)}`)
    check('anagenesis-guard: the tier guard refuses an admin action while no preset grant exists',
      typeof admin === 'string' && admin.length > 0, `returned ${JSON.stringify(admin)?.slice(0, 110)}`)
    check('anagenesis-guard: the tier guard always admits the read tier', read === undefined && inspect === undefined,
      `read=${JSON.stringify(read)} inspect=${JSON.stringify(inspect)}`)
  } else {
    check('anagenesis-guard: a tier guard is installed', false, 'no guard refused a write-tier call without a grant')
  }

  // ── 3. anagenesis-tools (REAL defineTool) ───────────────────────────────────
  const tools = ctx.plugin({ name: toolsRow.name, inject: toolsRow.inject, apply: toolsRow.apply }, {})
  const toolsResult = await settle(tools)
  check('anagenesis-tools: starts with tools+anagenesis injected',
    toolsResult.error === undefined && tools.state === ACTIVE,
    toolsResult.error === undefined ? `state=${tools.state}` : `${toolsResult.error?.name}: ${toolsResult.error?.message}`)

  const names = registered.map((row) => row.name)
  const missingTools = EXPECTED_TOOLS.filter((name) => !names.includes(name))
  const extraTools = names.filter((name) => !EXPECTED_TOOLS.includes(name))
  check('anagenesis-tools: the read tier compiles through the real defineTool, and nothing else does',
    missingTools.length === 0 && extraTools.length === 0 && names.length === EXPECTED_TOOLS.length,
    `registered=${names.length}${missingTools.length ? ` missing=${missingTools.join(',')}` : ''}${extraTools.length ? ` unexpected=${extraTools.join(',')}` : ''}`)
  check('anagenesis-tools: the write tier is NOT registered without the preset',
    GATED_TOOLS.every((name) => !names.includes(name)),
    `leaked=${GATED_TOOLS.filter((name) => names.includes(name)).join(',') || 'none'}`)
  check('anagenesis-tools: every definition carries a compiled object schema',
    registered.every((row) => row.definition?.parameters?.type === 'object'
      && Object.keys(row.definition.parameters.properties ?? {}).length > 0),
    'the real compiler throws on a malformed parameter spec, so a surviving schema is a compiled one')
  check('anagenesis-tools: the compiler really lowered the enums (not a passthrough)',
    JSON.stringify(registered.find((row) => row.name === 'ana_recall')?.definition?.parameters?.properties?.intent?.enum)
      === JSON.stringify(['orient', 'recall_fact', 'recall_precedent', 'avoid_mistake', 'reuse_procedure', 'verify', 'contrast']),
    'ana_recall.parameters.properties.intent.enum must be the 7 recall intents')
  check('anagenesis-tools: every output schema is a flat closed object',
    registered.every((row) => row.definition?.output?.schema?.type === 'object'
      && row.definition?.output?.schema?.additionalProperties === false),
    `closed=${registered.filter((row) => row.definition?.output?.schema?.additionalProperties === false).length}/${registered.length}`)
  check('anagenesis-tools: every definition exposes an executable handler',
    registered.every((row) => typeof row.definition?.execute === 'function'))
  check('anagenesis-tools: logged its registration line', logged('anagenesis-tools: registered'))

  // ── 3a. the preset path: the gated write row + the grant that authorizes it ─
  //
  // The write tier exists only here. Mounting these two rows is exactly what
  // enabling the `anagenesis` preset does on a real host, and the two checks
  // around it are the boot-time form of the permission suite: absent before,
  // present after, withdrawn again when the preset unloads.
  const gatedModule = await import(new URL('../src/tools/gated.js', import.meta.url).href)
  const gated = ctx.plugin({ name: gatedModule.name, inject: gatedModule.inject, apply: gatedModule.apply }, { gear: 'autonomous', scopeKey: 'preset:anagenesis' })
  const gatedResult = await settle(gated)
  check('anagenesis-tools-gated: starts with tools+anagenesis injected',
    gatedResult.error === undefined && gated.state === ACTIVE,
    gatedResult.error === undefined ? `state=${gated.state}` : `${gatedResult.error?.name}: ${gatedResult.error?.message}`)
  {
    const afterPreset = registered.map((row) => row.name)
    const missingGated = GATED_TOOLS.filter((name) => !afterPreset.includes(name))
    check('anagenesis-tools-gated: the write tier exists inside the preset',
      missingGated.length === 0 && afterPreset.length === EXPECTED_TOOLS.length + GATED_TOOLS.length,
      `registered=${afterPreset.length} missing=${missingGated.join(',') || 'none'}`)
    check('anagenesis-tools-gated: logged its grant line', logged('anagenesis-tools-gated: grant'))
  }
  // The gear comes from the gated row's grant, so the service already reports it
  // before the bind row runs. The bind row's own checks live further down, where
  // it is mounted for real.
  check('anagenesis-tools-gated: the service reports the granted gear and write availability',
    service.permissionReport({}).gear === 'autonomous' && service.permissionReport({}).writeToolsAvailable === true,
    `gear=${service.permissionReport({}).gear}`)
  check('anagenesis-tools-gated: the status pulse names the project, the gear and the tools',
    (() => {
      const pulse = service.pulse({})
      return /<anagenesis-pulse/.test(pulse.text) && /gear="autonomous"/.test(pulse.text)
        && /tools="read\+write"/.test(pulse.text) && /project/.test(pulse.text)
    })(), 'the pulse is what makes "check the scope first" executable')

  // ── 3b. host boundary: every tool answer must survive a JSON round trip ─────
  // The stub host in `test/` does not validate tool output; the real host does,
  // and rejects the entire call with `value is not lossless JSON`. That is how
  // `ana_audit view=memory` shipped broken: `{ ...record, embedding: undefined }`
  // keeps the key, JSON.stringify drops it, and the host sees a different object
  // than the tool returned. So: call every registered tool here, in the sandbox,
  // and check every real return value.
  {
    const { losslessProblem } = await import(new URL('../test/lossless.mjs', import.meta.url).href)
    const callTool = (name, args) => registered.find((row) => row.name === name).definition.execute(args, {})
    const called = []
    const losses = []
    const step = async (name, args) => {
      let value
      try {
        value = await callTool(name, args)
      } catch (error) {
        throw new Error(`boundary sweep: ${name}(${JSON.stringify(args)}) threw ${error instanceof Error ? error.message : String(error)}`)
      }
      called.push(name)
      const problem = losslessProblem(value, `${name} output`)
      if (problem !== null) losses.push(problem)
      return value
    }

    const one = await step('ana_remember', { kind: 'fact', subject: 'boundary sweep one', body: 'body one', evidence: ['verify:boot'] })
    const two = await step('ana_remember', { kind: 'fact', subject: 'boundary sweep two', body: 'body two' })
    const three = await step('ana_remember', { kind: 'fact', subject: 'boundary sweep three', body: 'body three' })
    await step('ana_link', { from: one.id, to: two.id, rel: 'related' })
    await step('ana_recall', { intent: 'orient', query: 'boundary sweep' })
    await step('ana_list', { limit: 10 })
    for (const view of ['status', 'journal', 'audit', 'strategies', 'health', 'scope']) await step('ana_audit', { view })
    await step('ana_scope', { action: 'status' })
    await step('ana_preset', { action: 'status' })
    // The regression itself, and the only view that shows resolved links +
    // provenance — the eye a rollback check needs.
    const memoryView = await step('ana_audit', { view: 'memory', id: one.id })
    await step('ana_promote', { ids: [one.id], to: 'verified', reason: 'verify:boot sweep', evidence: ['boundary check'] })
    await step('ana_demote', { ids: [one.id], to: 'deprecated', reason: 'verify:boot sweep' })
    await step('ana_promote', { ids: [one.id], to: 'active', reason: 'verify:boot sweep restores it' })
    await step('ana_lock', { ids: [one.id], reason: 'verify:boot sweep' })
    await step('ana_expire', { ids: [three.id], reason: 'verify:boot sweep', graceMs: 60000 })
    await step('ana_rethink', { premise: 'the boundary sweep completed', counterfactual: 'if any tool returned undefined it did not', ids: [one.id] })
    await step('ana_split', { id: two.id, reason: 'verify:boot sweep', into: [{ subject: 'sweep child', body: 'child body', kind: 'fact' }] })
    await step('ana_feedback', { usedIds: [one.id], ignoredIds: [], success: true, tokenCost: 0 })
    await step('ana_strategy', { action: 'list' })
    await step('ana_tune', { action: 'report' })
    await step('ana_forget', { ids: [three.id], reason: 'verify:boot sweep cleanup' })

    const covered = new Set(called)
    const sweepTargets = EXPECTED_TOOLS.length + GATED_TOOLS.length
    check(`tools boundary: all ${sweepTargets} registered tools answered inside the sandbox`, covered.size === sweepTargets,
      `covered=${covered.size}/${sweepTargets}${covered.size === sweepTargets ? '' : ` — missing ${[...EXPECTED_TOOLS, ...GATED_TOOLS].filter((name) => !covered.has(name)).join(', ')}`}`)
    check('tools boundary: every real return value is lossless JSON', losses.length === 0,
      losses.length === 0 ? `${called.length} calls round-tripped through JSON` : losses.join(' | '))
    check('tools boundary: ana_audit view=memory resolves links and keeps provenance',
      memoryView.memory?.id === one.id
      && Array.isArray(memoryView.memory?.linksResolved)
      && memoryView.memory.linksResolved.some((link) => link.to === two.id && link.exists === true)
      && typeof memoryView.memory?.provenance?.source === 'string'
      && typeof memoryView.memory?.createdAt === 'number',
      `links=${JSON.stringify(memoryView.memory?.linksResolved)} source=${memoryView.memory?.provenance?.source}`)
    check('tools boundary: the embedding key is absent in the memory view, never present-and-undefined',
      memoryView.memory !== undefined && !Object.hasOwn(memoryView.memory, 'embedding'))
    // D4 at the boundary: the tuner's learning state is state, so the agent-facing
    // report and the persisted store must agree.
    const afterFeedback = service.status()
    check('tools boundary: the tuner learning state is state (status agrees with the store)',
      afterFeedback.tuning.samples === service.store.state.tuning.samples.length
      && afterFeedback.tuning.samples >= 1,
      `status=${afterFeedback.tuning.samples} state=${service.store.state.tuning.samples.length}`)
  }

  // ── 3c. anagenesis-viz: read-only projections that come and go with the row ─
  // Visualization is the one part of the plugin allowed to be absent, so the
  // properties checked here are: it mounts on its own, it answers losslessly, it
  // never transacts, and withdrawing it leaves the fourteen tools untouched.
  const vizRow = await import(new URL('../src/viz/index.js', import.meta.url).href)
  const versionBeforeViz = service.store.version
  // The sandbox's `tools` service is a stub. It returns the exact disposer the
  // way the real one does (asar-verified: `register()` returns
  // `this.layers.effect(ctx, layer => layer.tools.insert(name, definition))`),
  // but nothing here collects that disposer into the calling fibre — that
  // ownership belongs to the real registry, which this sandbox does not have.
  // So the sandbox plays that role explicitly, and what is checked is the row's
  // own contribution: exactly two registrations, each removable, and a removal
  // that leaves the fourteen core tools standing.
  const vizDisposers = []
  const toolsService = ctx.get('tools')
  const registerBeforeViz = toolsService.register
  const guardsBeforeViz = guards.length
  toolsService.register = (definition) => {
    const dispose = registerBeforeViz(definition)
    if (VIZ_TOOLS.includes(definition.name)) vizDisposers.push(dispose)
    return dispose
  }
  const viz = ctx.plugin({ name: vizRow.name, inject: vizRow.inject, apply: vizRow.apply }, { color: 'never', width: 80 })
  const vizResult = await settle(viz)
  check('anagenesis-viz: starts with tools+anagenesis injected',
    vizResult.error === undefined && viz.state === ACTIVE,
    vizResult.error === undefined ? `state=${viz.state}` : `${vizResult.error?.name}: ${vizResult.error?.message}`)
  const vizRegistered = registered.filter((row) => VIZ_TOOLS.includes(row.name))
  check('anagenesis-viz: both tools compiled through the real defineTool',
    vizRegistered.length === 2 && VIZ_TOOLS.every((name) => vizRegistered.some((row) => row.name === name)),
    `viz tools=${vizRegistered.map((row) => row.name).join(', ') || '(none)'}`)
  check('anagenesis-viz: every output schema is a flat closed object',
    vizRegistered.every((row) => row.definition?.output?.schema?.type === 'object'
      && row.definition?.output?.schema?.additionalProperties === false
      && typeof row.definition?.output?.render === 'function'))
  check('anagenesis-viz: provides no service (the preset mounts this row a second time)',
    ctx.get('anagenesis-viz', false) === undefined,
    'ctx.provide would collide inside the preset scope — HANDOFF §10.16')
  check('anagenesis-viz: installed no guard and no timer', guards.length === guardsBeforeViz,
    `guards=${guards.length} (${guardsBeforeViz} before the row) — the viz row is a projection, not a safety layer`)
  check('anagenesis-viz: logged its registration line', logged('anagenesis-viz: dashboard + diagram tools registered'))

  {
    const { losslessProblem } = await import(new URL('../test/lossless.mjs', import.meta.url).href)
    const callViz = (name, args) => registered.find((row) => row.name === name).definition.execute(args, {})
    const dashboard = await callViz('ana_dashboard', { width: 80 })
    const diagram = await callViz('ana_diagram', { kind: 'memory-graph', format: 'mermaid' })
    const losses = [losslessProblem(dashboard, 'ana_dashboard output'), losslessProblem(diagram, 'ana_diagram output')].filter(Boolean)
    check('tools boundary: the viz answers are lossless JSON', losses.length === 0,
      losses.length === 0 ? 'dashboard + diagram round-tripped' : losses.join(' | '))
    check('anagenesis-viz: a render is not a transaction',
      service.store.version === versionBeforeViz,
      `version ${versionBeforeViz} → ${service.store.version}`)
    check('anagenesis-viz: the dashboard is a real frame over the sandbox store',
      String(dashboard.text ?? '').startsWith('╭') && dashboard.storeVersion === versionBeforeViz
      && String(dashboard.text ?? '').includes('anagenesis 仪表盘'),
      `width=${dashboard.width} sections=${(dashboard.sections ?? []).join(',')}`)
    check('anagenesis-viz: the diagram carries its own provenance header',
      diagram.artifactVersion === 1 && /anagenesis-viz v1/.test(String(diagram.text ?? ''))
      && /graph LR/.test(String(diagram.source ?? '')),
      `kind=${diagram.kind} format=${diagram.format} nodes=${diagram.nodes} edges=${diagram.edges}`)
    check('anagenesis-viz: the graph sees the records this run created',
      Number(diagram.nodes ?? 0) >= 1 && String(diagram.text ?? '').includes('ana_'),
      `nodes=${diagram.nodes}`)
  }

  await viz.dispose()
  check('unload: viz row is no longer active', await waitFor(() => viz.state !== ACTIVE), `state=${viz.state}`)
  check('anagenesis-viz: the row registered exactly two removable tools', vizDisposers.length === 2,
    `disposers=${vizDisposers.length}`)
  for (const dispose of [...vizDisposers].reverse()) dispose()
  check('unload: withdrawing viz leaves the read tier and the preset\'s write tier, and nothing else',
    registered.filter((row) => VIZ_TOOLS.includes(row.name)).length === 0
    && EXPECTED_TOOLS.every((name) => registered.some((row) => row.name === name))
    && GATED_TOOLS.every((name) => registered.some((row) => row.name === name))
    && registered.length === EXPECTED_TOOLS.length + GATED_TOOLS.length,
    `registered=${registered.length} (${EXPECTED_TOOLS.length + GATED_TOOLS.length} expected) — a viz row that outlives its fibre would leak tools`)

  // ── 4. anagenesis-preset-bind ───────────────────────────────────────────────
  // Instrument the one write the row performs, so the row's own catch-and-warn
  // cannot hide a silent failure.
  const trace = []
  let setStackCalls = 0
  const realSetStack = service.registry.setStack.bind(service.registry)
  service.registry.setStack = async (...args) => {
    setStackCalls++
    try {
      const out = await realSetStack(...args)
      trace.push(`setStack(${JSON.stringify(args[0])}) -> ${JSON.stringify(out.stack)}`)
      return out
    } catch (error) {
      trace.push(`setStack THREW ${error?.name}: ${error?.message}`)
      throw error
    }
  }

  const stackBefore = [...service.registry.stack('global')]
  const warnsBeforeBind = warnings.length
  const bind = ctx.plugin(
    { name: bindRow.name, inject: bindRow.inject, apply: bindRow.apply },
    { stack: ['guard', 'debug'], tokenBudget: 1234, scope: 'global' },
  )
  const bindResult = await settle(bind)
  check('anagenesis-preset-bind: starts with anagenesis injected',
    bindResult.error === undefined && bind.state === ACTIVE,
    bindResult.error === undefined ? `state=${bind.state}` : `${bindResult.error?.name}: ${bindResult.error?.message}`)
  check('anagenesis-preset-bind: called registry.setStack', setStackCalls > 0, `calls=${setStackCalls}`)
  check('anagenesis-preset-bind: the preset stack is live',
    JSON.stringify(service.registry.stack('global')) === JSON.stringify(['guard', 'debug']),
    `stack=${JSON.stringify(service.registry.stack('global'))} (was ${JSON.stringify(stackBefore)})`)
  check('anagenesis-preset-bind: the preset token budget reached the store',
    service.store.state.params.global?.['recall.orient.tokenBudget'] === 1234,
    JSON.stringify(service.store.state.params.global ?? {}))
  check('anagenesis-preset-bind: bound before returning (awaited, not fire-and-forget)',
    logged('anagenesis-preset-bind: preset stack') && warnings.length === warnsBeforeBind,
    warnings.length === warnsBeforeBind ? '' : `warnings=${JSON.stringify(warnings.slice(warnsBeforeBind))}`)

  // ── 5. anagenesis-preset with a LATE agentPresets service ───────────────────
  /** @type {string[]} */
  const presetRegistrations = []
  /** @type {any[]} */
  const presetDefinitions = []
  const preset = ctx.plugin(
    { name: presetRow.name, inject: presetRow.inject, apply: presetRow.apply },
    { presetIds: ['anagenesis'], autoInstallDirectoryForm: false },
  )
  const presetResult = await settle(preset, 700)
  check('anagenesis-preset: starts even though agentPresets does not exist yet',
    presetResult.error === undefined && preset.state === ACTIVE,
    presetResult.error === undefined ? `state=${preset.state}` : `${presetResult.error?.name}: ${presetResult.error?.message}`)
  check('anagenesis-preset: registers nothing while the service is absent', presetRegistrations.length === 0,
    `registered=${JSON.stringify(presetRegistrations)}`)
  check('anagenesis-preset: wrote no directory preset (autoInstallDirectoryForm=false)',
    !existsSync(join(paths.sandboxHome, '.agent-presets', 'anagenesis')))

  ctx.provide('agentPresets', {
    async register(definition) {
      presetRegistrations.push(definition.id)
      presetDefinitions.push(definition)
      return async () => {}
    },
  })
  const reacted = await waitFor(() => presetRegistrations.length === 1, 4000)
  check('anagenesis-preset: registers reactively once the service appears', reacted,
    `registered=${JSON.stringify(presetRegistrations)}`)
  check('anagenesis-preset: registered exactly the "anagenesis" preset',
    presetRegistrations.length === 1 && presetRegistrations[0] === 'anagenesis')
  const definition = presetDefinitions[0]
  check('anagenesis-preset: the definition is a valid entry list',
    definition !== undefined && definition.id === 'anagenesis' && typeof definition.name === 'string'
    && typeof definition.description === 'string' && Array.isArray(definition.plugins) && definition.plugins.length > 0
    && definition.plugins.every((row) => typeof row?.name === 'string'),
    definition === undefined ? 'nothing registered' : `rows=${definition.plugins.length}`)
  check('anagenesis-preset: logged its registration line', logged('anagenesis-preset: registered agent preset "anagenesis"'))

  // ── 5b. every row of the preset composition accepts its own config ─────────
  // This is the check that would have caught the defect that made the whole
  // preset show up as *broken* in the live roster while every host-side test
  // stayed green (HANDOFF §10.15): a row carrying a config key its own schema
  // does not declare fails config validation at mount time, and the failure
  // takes the entire preset with it. The bundle patch is validated above; the
  // preset composition had no such gate until now — and 0.2.0 added a *new* row
  // to that composition (`anagenesis-tools-gated`), i.e. exactly the risk.
  {
    const localRows = {
      'dsh-anagenesis': await import(new URL('../src/index.js', import.meta.url).href),
      'dsh-anagenesis/tools': await import(new URL('../src/tools/index.js', import.meta.url).href),
      'dsh-anagenesis/tools-gated': await import(new URL('../src/tools/gated.js', import.meta.url).href),
      'dsh-anagenesis/guard': await import(new URL('../src/guard/index.js', import.meta.url).href),
      'dsh-anagenesis/viz': await import(new URL('../src/viz/index.js', import.meta.url).href),
      'dsh-anagenesis/preset-bind': await import(new URL('../src/preset/bind.js', import.meta.url).href),
    }
    const problems = []
    let checkedRows = 0
    for (const row of definition?.plugins ?? []) {
      const module = localRows[row.name]
      if (module === undefined) continue // a host package; its schema is not ours to read
      checkedRows += 1
      if (row.config === undefined) continue
      const declared = new Set(Object.keys(module.Config({}) ?? {}))
      for (const key of Object.keys(row.config)) {
        if (!declared.has(key)) problems.push(`${row.id}: "${key}" is not a key of its Config schema (${[...declared].join(', ')})`)
      }
    }
    check('anagenesis-preset: every local row accepts the config the composition gives it',
      problems.length === 0,
      problems.length === 0 ? `${checkedRows} local row(s) validated against their real Config schemas` : problems.join(' | '))
    check('anagenesis-preset: the composition mounts the gated write row (the permission layer)',
      (definition?.plugins ?? []).some((row) => row.name === 'dsh-anagenesis/tools-gated'),
      `rows=${(definition?.plugins ?? []).map((row) => row.name).filter((n) => String(n).startsWith('dsh-anagenesis')).join(', ')}`)
  }

  // ── 6. contrast: prove the effect contract is really enforced ──────────────
  // Without this, "apply resolved to an effect-legal value" could be a tautology.
  const contrastObject = ctx.plugin({ name: 'contrast-plain-object', apply: () => ({ dispose() {} }) })
  const contrastObjectResult = await settle(contrastObject, 1200)
  check('contrast: Cordis really tears down a row whose apply returns a plain object',
    contrastObject.state !== ACTIVE,
    `state=${contrastObject.state} error=${contrastObjectResult.error?.message ?? '(none surfaced)'}`)
  const contrastScalar = ctx.plugin({ name: 'contrast-scalar', apply: () => 42 })
  const contrastScalarResult = await settle(contrastScalar, 1200)
  check('contrast: Cordis really throws "Invalid effect" for a non-object apply result',
    contrastScalar.state !== ACTIVE && /Invalid effect/.test(String(contrastScalarResult.error?.message ?? '')),
    `state=${contrastScalar.state} error=${contrastScalarResult.error?.message ?? '(none surfaced)'}`)

  // ── 7. reversibility: every row undoes itself on unload ────────────────────
  await Promise.all([preset.dispose(), bind.dispose()])
  await tools.dispose()
  await guard.dispose()
  check('unload: tools row is no longer active', await waitFor(() => tools.state !== ACTIVE), `state=${tools.state}`)
  check('unload: guard row is no longer active', await waitFor(() => guard.state !== ACTIVE), `state=${guard.state}`)
  check('unload: guard cleanup ran (the guard row\'s guards are gone)', guards.length === guardsBeforeGuardRow,
    `remaining=${guards.length} (${guardsBeforeGuardRow} came from the core row's own fallback tier guard) — the guard row must leave nothing behind`)
  check('unload: preset row is no longer active', preset.state !== ACTIVE, `state=${preset.state}`)
  check('unload: preset-bind restored the previous stack',
    JSON.stringify(service.registry.stack('global')) === JSON.stringify(stackBefore),
    `stack=${JSON.stringify(service.registry.stack('global'))} expected ${JSON.stringify(stackBefore)}`)

  const stillPublished = ctx.get('anagenesis', false)
  check('unload: the anagenesis service is still published while core lives', stillPublished !== undefined)
  await core.dispose()
  check('unload: anagenesis service withdrawn with the core fibre',
    await waitFor(() => ctx.get('anagenesis', false) === undefined))

  // Read the sandbox journal before the directory is torn down below: these are
  // the transactions this run actually caused, and their exact (ts, type) pairs
  // are the fingerprint used against the real store further down.
  const ourEvents = readJournalEvents(join(storeDir, 'journal'))

  const reopened = await MemoryStore.acquire({ rootDir: storeDir })
  check('unload: core dispose released the store (single-writer pool emptied)', reopened.shared === false,
    `shared=${reopened.shared} — true would mean the first handle is still held`)
  await reopened.store.release()
  check('unload: the store directory can be deleted (journal handle really closed)',
    await waitFor(() => {
      try {
        rmSync(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 })
        return true
      } catch {
        return false
      }
    }, 3000), `path=${storeDir}`)

  // ── 8. the real store: disjointness, not immutability ──────────────────────
  // The live DSH host owns that directory and may append to it at any moment, so
  // "it did not change" would be an unsound assertion. This one is sound: the
  // host cannot produce an event with the exact (ts, type) of a transaction this
  // run caused inside its own sandbox. If this process had opened the real
  // store, its own events would be sitting there verbatim.
  check('safety: the run really did transact (the disjointness check is not vacuous)', ourEvents.length > 0,
    `sandbox journal holds ${ourEvents.length} event(s): ${ourEvents.map((event) => `${event.seq}:${event.type}`).join(', ')}`)
  const realEvents = readJournalEvents(join(paths.realStore, 'journal'))
  const ours = new Set(ourEvents.map((event) => `${event.ts}|${event.type}`))
  const leaked = realEvents.filter((event) => ours.has(`${event.ts}|${event.type}`))
  check('safety: none of this run\'s transactions appear in the real store journal', leaked.length === 0,
    leaked.length === 0
      ? `${realEvents.length} event(s) in ${paths.realStore}\\journal, none matching this run (started ${new Date(runStartedAt).toISOString()})`
      : `LEAKED: ${JSON.stringify(leaked)}`)

  return { sandbox, ourEvents }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const asarPath = resolve((process.env.DSH_ASAR ?? '').trim() === '' ? DEFAULT_ASAR : process.env.DSH_ASAR.trim())

  say('verify:boot — real-host boot contract (real Cordis + real defineTool + real schemastery)')
  say(`  plugin      ${PACKAGE_ROOT}`)
  say(`  asar        ${asarPath}`)
  say(`  node        ${process.version}`)
  say('')

  if (!existsSync(asarPath)) {
    fatal(`asar not found: ${asarPath}\n`
      + '         Point DSH_ASAR at the installed application\'s app.asar, e.g.\n'
      + `         DSH_ASAR="C:\\path\\to\\DeepSeek Harness\\resources\\app.asar" npm run verify:boot`)
  }
  if (!statSync(asarPath).isFile()) fatal(`asar path is not a file: ${asarPath}`)

  // The user's real store, fingerprinted before anything else runs. DSH_HOME is
  // redirected into the sandbox below, so nothing this script imports can reach it.
  //
  // **两个目录都要见证。** 改名之后默认存储根从 `.dsh/evolution` 变成
  // `.dsh/anagenesis`；只指纹新目录的话，新目录不存在 ⇒ 指纹是空的 ⇒ "逐字节一致"
  // 是**真空通过**，而用户真正装着 100 多条事件的那个目录反而没人看着。
  // 安全见证必须覆盖插件**可能读到或写到**的每一个目录，而不是当前默认值。
  const realHome = (process.env.DSH_HOME ?? '').trim() === '' ? join(homedir(), '.dsh') : process.env.DSH_HOME.trim()
  const realStore = join(realHome, 'anagenesis')
  const realLegacyStore = join(realHome, LEGACY_STORE_DIR_NAME)
  const realPresets = join(realHome, '.agent-presets')
  const fingerprintBefore = fingerprintTree(realStore)
  const legacyBefore = fingerprintTree(realLegacyStore)
  const presetsBefore = fingerprintTree(realPresets)

  const sandboxRoot = join(tmpdir(), 'ana-verify')
  mkdirSync(sandboxRoot, { recursive: true })
  const sandbox = await mkdtemp(join(sandboxRoot, 'boot-'))
  assertOutsidePackage(sandbox)
  const storeDir = join(sandbox, 'store')
  const sandboxHome = join(sandbox, 'dsh-home')
  mkdirSync(storeDir, { recursive: true })
  mkdirSync(sandboxHome, { recursive: true })
  process.env.DSH_HOME = sandboxHome

  say(`  sandbox     ${sandbox}`)
  say('')

  let keep = KEEP_TMP
  try {
    const archive = readAsar(asarPath)
    const { packages: index, skipped } = indexPackages(archive.entries)
    say(`asar: ${archive.entries.length} entries, ${index.size} packages under ${ASAR_NODE_MODULES}`
      + `${skipped > 0 ? ` (ignored ${skipped} entries in the shell's own node_modules tree)` : ''}`)
    for (const name of ROOT_PACKAGES) {
      if (!index.has(name)) fatal(`the asar contains no ${ASAR_NODE_MODULES}${name}/ — is this the right asar?`)
    }

    const closure = extractClosure(archive, index, sandbox)
    say(`sandbox: extracted ${closure.extracted.length} packages (${closure.files} files)`)
    for (const name of closure.extracted) say(`  + ${name}`)
    if (closure.missing.length > 0) say(`  ! referenced but absent from the asar: ${closure.missing.join(', ')}`)
    say('')

    const hooksPath = join(sandbox, 'node_modules', '__verify_hooks.mjs')
    writeFileSync(hooksPath, renderHooks(sandbox, closure.extracted), 'utf8')
    writeFileSync(join(sandbox, 'node_modules', '__verify_anchor__.mjs'),
      '// resolution anchor: bare host specifiers resolve from here into this sandbox\nexport {}\n', 'utf8')
    register(pathToFileURL(hooksPath).href)

    await runChecks({ sandbox, storeDir, sandboxHome, realStore })

    check('safety: no node_modules was created inside the plugin package',
      !existsSync(join(PACKAGE_ROOT, 'node_modules')), `${join(PACKAGE_ROOT, 'node_modules')} does not exist`)

    // Tripwire for a defect this package actually hit (2026-10-06, live): a
    // package that declares `dsh.client` may own exactly ONE active Loader row.
    // `@deepseek-ai/dsh-client-modules` resolves a client source *per row* and
    // throws when several rows land on one package:
    //   "client-modules: package X resolves from multiple active Loader sources:
    //    …; remove one entry"
    // With four rows plus a preset that mounts them again, the client entry never
    // materialises (no settings panel) and preset composition stops activating.
    // Keeping four independently disableable rows is the better trade, so the
    // client half stays out until it can ship as its own single-row package.
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    const rows = readFileSync(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
      .split('\n').filter((line) => /^\s*name:\s*dsh-anagenesis\b/.test(line))
    const clientHalf = manifest.dsh?.client?.platform === 'web'
    check('safety: a client half is only declared by a single-row package',
      !(clientHalf && rows.length > 1),
      clientHalf
        ? `dsh.client is declared while the bundle patch inserts ${rows.length} rows`
        : `no dsh.client — the ${rows.length} rows stay legal`)

    // Unscored witnesses for the two directories that belong to the user. The
    // live host may write them at any moment, so a change here is evidence about
    // *the host*, not about this script; the scored guarantees are the
    // redirection, structure and journal-disjointness checks above.
    say('')
    for (const [label, dir, before] of [
      ['store', realStore, fingerprintBefore],
      ['legacy store', realLegacyStore, legacyBefore],
      ['presets', realPresets, presetsBefore],
    ]) {
      const after = fingerprintTree(dir)
      if (after === before) {
        say(`witness  ${label}: ${dir} is byte-identical to its pre-run fingerprint`)
      } else {
        const beforeLines = new Set(before.split('\n'))
        const added = after.split('\n').filter((line) => !beforeLines.has(line))
        say(`witness  ${label}: ${dir} changed while this run was in flight (${added.length} line(s)).`)
        say('         That directory is owned by the running DSH host, which was appending to it concurrently;')
        say('         this process redirected DSH_HOME into the sandbox before loading any plugin module, and')
        say('         none of its transactions appear in the real store journal (checked above).')
        for (const line of added.slice(0, 6)) say(`         + ${line}`)
      }
    }
  } catch (error) {
    if (error instanceof FatalError) throw error
    keep = true
    say('')
    say(`FAIL  the boot sequence threw before finishing — ${error?.name}: ${error?.message}`)
    say(String(error?.stack ?? '').split('\n').slice(1, 6).join('\n'))
    failureCount++
    checkCount++
  }

  say('')
  say(`${checkCount - failureCount}/${checkCount} checks passed`)
  if (failureCount === 0 && !keep) {
    say('ALL CHECKS PASSED')
    if (removeSandbox(sandbox)) say(`sandbox removed: ${sandbox}`)
    else say(`sandbox could not be fully removed (left for inspection): ${sandbox}`)
  } else {
    say(`${failureCount} CHECK(S) FAILED`)
    say(`sandbox kept for inspection: ${sandbox}`)
    say('re-run with the same sandbox contents removed by hand, or set ANA_KEEP_TMP=1 to always keep it')
  }
  return failureCount === 0 ? 0 : 1
}

/**
 * Windows keeps a directory busy for a moment after the last handle closes, so
 * cleanup retries instead of failing the run over a transient EPERM.
 * @param {string} dir
 */
function removeSandbox(dir) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 })
      return true
    } catch {
      // retry
    }
  }
  return false
}

try {
  process.exitCode = await main()
} catch (error) {
  if (error instanceof FatalError) {
    process.stderr.write(`\nverify:boot: ${error.message}\n`)
    process.exitCode = 2
  } else {
    process.stderr.write(`\nverify:boot: unexpected failure — ${error?.stack ?? error}\n`)
    process.exitCode = 3
  }
}
