#!/usr/bin/env node
/**
 * scope-report — 一台只读的作用域体检器。
 *
 * 为什么需要它：改造之后，"这个存储里到底有几个项目、每个项目占多少条、哪些记忆
 * 还没有归属、日志是不是真的按命名空间分了文件" 这些问题必须能**在宿主之外**
 * 回答。运维（以及出问题时的那个人）不该为了看一眼作用域分布就先把整个 DSH
 * 起起来。
 *
 * 它是**纯读**的：只打开 `snapshot.json` 与 journal 做投影，不取单写者句柄、
 * 不写一个字节、不启动任何子进程。它读的代码与运行时工具读的是同一套
 * （`src/scope/*` + `src/store/journal.js` 的命名空间命名规则），所以它给出的
 * 结论和插件内部一致。
 *
 * 关于 --gear：**档位是宿主进程里的运行期状态**，一个独立进程改不了它 ——
 * 所以这里只做解释（"这个档位会解锁哪些工具"），不做切换。真正的切换入口是
 * 预设组合里的 `gear` 配置、`ana_preset action="gear"`，或宿主调用
 * `service.permissions.setGear()`。假装能改才是真的危险。
 *
 * Usage:
 *   node tools/scope-report.mjs                       # 当前目录的项目指纹 + 命名空间分布
 *   node tools/scope-report.mjs --cwd D:\work\proj    # 指定某个工作目录作为"当前项目"
 *   node tools/scope-report.mjs --root <store> --json # 机器可读
 *   node tools/scope-report.mjs --files               # 连物理日志文件一起列出来
 * @module dsh-anagenesis/tools/scope-report
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

import { defaultRootDir, dshHome, resolveRootDir } from '../src/paths.js'
import { fingerprintProject, namespaceOf, parseNamespace, scopeLabel } from '../src/scope/project.js'
import { namespaceCounts } from '../src/scope/index.js'
import { isLegacyUnscoped, migrateState } from '../src/store/schema.js'
import { GEARS, GEAR_IDS, GEAR_NONE, gearCovers, toolsForGear } from '../src/permission/tiers.js'

const HELP = `anagenesis scope-report — 只读的作用域体检

  --root <dir>      存储根目录（默认 $DSH_HOME/anagenesis，找不到时回退旧目录）
  --cwd <dir>       "当前项目"取哪个工作目录（默认进程 cwd）
  --files           连 journal 的物理分文件一起列出
  --json            输出 JSON（交给别的工具用）
  --gear <id>       只解释某个档位解锁了什么：${[...GEAR_IDS, GEAR_NONE].join(' | ')}
  --help            这段文字

它绝不写存储，也绝不启动进程。档位是宿主进程里的运行期状态，本工具不会改它。`

/**
 * @param {string[]} argv
 * @returns {Record<string, any>}
 */
function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const out = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => {
      index += 1
      return argv[index]
    }
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--json') out.json = true
    else if (arg === '--files') out.files = true
    else if (arg === '--root') out.root = next()
    else if (arg === '--cwd') out.cwd = next()
    else if (arg === '--gear') out.gear = next()
  }
  return out
}

/**
 * 读状态：优先 snapshot.json；没有就退回空状态（**不**重放日志 —— 重放要写
 * 临时文件，而这个工具承诺不写任何东西）。
 * @param {string} root
 * @returns {any}
 */
function loadState(root) {
  const snapshot = join(root, 'snapshot.json')
  if (!existsSync(snapshot)) return migrateState({ schemaVersion: 7, memories: {}, projects: {} }, Date.now())
  try {
    const parsed = JSON.parse(readFileSync(snapshot, 'utf8'))
    return migrateState(parsed?.state ?? {}, Date.now())
  } catch {
    return migrateState({ schemaVersion: 7, memories: {}, projects: {} }, Date.now())
  }
}

/**
 * 日志目录里每个文件的命名空间与大小 —— "物理隔离"到底有没有发生的直接证据。
 * @param {string} root
 * @returns {Promise<{ file: string, namespace: string, bytes: number }[]>}
 */
async function journalFiles(root) {
  const dir = join(root, 'journal')
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const match = /^(journal|archive|checkpoint)-(.+)\.(jsonl|json)$/.exec(name)
    if (match === null) continue
    const body = match[2]
    const prefixed = /^([a-z0-9][a-z0-9-]*)-(\d{6})$/.exec(body)
    const namespace = match[1] === 'checkpoint'
      ? 'shared (one frozen state, caches only)'
      : prefixed === null ? 'global' : `project-or-session:${prefixed[1]}`
    let bytes = 0
    try {
      bytes = (await readFile(join(dir, name))).length
    } catch {
      bytes = 0
    }
    out.push({ file: name, namespace, bytes })
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

/** @param {number} bytes @returns {string} */
function human(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true) {
    console.log(HELP)
    return
  }
  const resolved = resolveRootDir(args.root)
  const root = resolve(resolved.rootDir)
  const cwd = resolve(args.cwd ?? process.cwd())
  const identity = fingerprintProject({ cwd })
  const state = loadState(root)
  const counts = namespaceCounts(state)
  const current = namespaceOf({ tier: 'project', projectId: identity.id })
  const legacy = Object.values(state.memories ?? {}).filter((record) => isLegacyUnscoped(record)).length

  const report = {
    home: dshHome(),
    defaultRoot: defaultRootDir(),
    root,
    rootSource: resolved.source,
    cwd,
    project: { id: identity.id, label: identity.label, kind: identity.kind, basis: identity.basis, root: identity.root, remote: identity.remote },
    currentNamespace: current,
    memories: Object.keys(state.memories ?? {}).length,
    byTier: counts.byTier,
    byNamespace: counts.byNamespace,
    legacyUntagged: legacy,
    knownProjects: Object.values(state.projects ?? {}).map((entry) => ({
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      root: entry.root,
      remote: entry.remote,
      memories: counts.byNamespace[`project:${entry.id}`] ?? 0,
      current: entry.id === identity.id,
    })),
    files: args.files === true ? await journalFiles(root) : undefined,
    gear: args.gear === undefined ? undefined : { id: args.gear, known: GEAR_IDS.includes(args.gear), tools: toolsForGear(args.gear) },
  }

  if (args.json === true) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  const line = (label, value) => console.log(`  ${label.padEnd(16)} ${value}`)
  console.log(`anagenesis 作用域体检 — ${root}（来自 ${resolved.source}）`)
  console.log('')
  line('当前工作目录', cwd)
  line('项目指纹', `${identity.id}  (${identity.basis}: ${identity.remote !== '' ? identity.remote : identity.root})`)
  line('当前命名空间', current)
  line('记忆总数', String(report.memories))
  line('按层级', Object.entries(counts.byTier).map(([tier, n]) => `${tier}=${n}`).join('  ') || '（无）')
  line('迁移遗留', `${legacy} 条（origin=migrated-global：写于作用域隔离之前，召回时被降权）`)
  console.log('')
  console.log('  命名空间分布（物理上各自成文件）：')
  const namespaces = Object.entries(counts.byNamespace).sort((a, b) => b[1] - a[1])
  if (namespaces.length === 0) console.log('    （还没有记忆）')
  for (const [namespace, count] of namespaces) {
    const parsed = parseNamespace(namespace)
    const mark = namespace === current ? '  ← 当前项目' : parsed.tier === 'global' ? '  ← 跨项目通用' : ''
    console.log(`    ${namespace.padEnd(28)} ${String(count).padStart(5)} 条${mark}`)
  }
  console.log('')
  console.log('  已登记的项目：')
  if (report.knownProjects.length === 0) console.log('    （还没有登记过任何项目）')
  for (const project of report.knownProjects) {
    console.log(`    ${project.id.padEnd(16)} ${String(project.memories).padStart(5)} 条  ${project.label}${project.current ? '  ← 当前' : ''}`)
  }
  if (Array.isArray(report.files)) {
    console.log('')
    console.log('  journal 文件：')
    for (const file of report.files) console.log(`    ${file.file.padEnd(42)} ${human(file.bytes).padStart(9)}  ${file.namespace}`)
  }
  if (report.gear !== undefined) {
    console.log('')
    const gear = report.gear
    if (!gear.known) {
      console.log(`  档位 "${gear.id}" 不存在（已知：${[...GEAR_IDS, GEAR_NONE].join(', ')}）`)
    } else {
      console.log(`  档位 ${gear.id}：${GEARS[gear.id]?.description ?? '未激活预设时只有只读工具'}`)
      console.log(`    可写：${gearCovers(gear.id, 'write') ? '是' : '否'}   管理：${gearCovers(gear.id, 'admin') ? '是' : '否'}`)
      console.log(`    工具：${gear.tools.join(', ')}`)
      console.log('    注意：档位是宿主进程里的运行期状态，本工具只解释、不切换。')
    }
  }
  console.log('')
  console.log(`  作用域标签示例：${scopeLabel({ tier: 'project', projectId: identity.id })} / global / session:<id>`)
}

main().catch((error) => {
  console.error(`scope-report 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
