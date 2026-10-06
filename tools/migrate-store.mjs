#!/usr/bin/env node
/**
 * 存储目录搬迁： `$DSH_HOME/evolution` → `$DSH_HOME/anagenesis`。
 *
 * 改名的一个直接后果是**数据的位置变了**。插件本身**不会**自动搬（见
 * `resolveRootDir()` 的注释：移动用户数据是不可逆动作，必须由用户显式触发），
 * 它只会在沿用旧目录时记一条日志。真正动手的是这个脚本。
 *
 * 三条设计原则：
 *   1. **复制，不移动。** 源目录一个字节都不动，所以"回滚"永远只是删掉副本。
 *   2. **逐文件校验。** 复制完对每个文件比 sha256；任何一个不一致就整体失败，
 *      并且**不写完成标记**，目标目录会被标成"未完成"而不是"已完成"。
 *   3. **回滚有守卫。** `--revert` 只有在目标目录里存在本脚本写的 `migration.json`
 *      且目标自迁移以来没有被改动过时才删除 —— 否则用户的新记忆会被一起删掉。
 *
 *   node tools/migrate-store.mjs                 # 预演：报告规模，不写任何文件
 *   node tools/migrate-store.mjs --apply         # 复制 + 校验 + 写标记
 *   node tools/migrate-store.mjs --verify        # 只比对源与目标
 *   node tools/migrate-store.mjs --revert        # 删除目标（有守卫）
 * @module dsh-anagenesis/tools/migrate-store
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LEGACY_ROOT_DIR_NAME, dshHome } from '../src/paths.js'

const here = dirname(fileURLToPath(import.meta.url))
const MARKER = 'migration.json'
const CURRENT_DIR_NAME = 'anagenesis'

/** 递归列出目录下所有文件的相对路径（排序，保证可复现）。 */
function listFiles(root) {
  if (!existsSync(root)) return []
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === MARKER) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(relative(root, full).split('\\').join('/'))
    }
  }
  walk(root)
  return out
}

/** @param {string} file */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 目录的清单指纹：路径 → 大小 + 哈希。 */
function manifest(root) {
  const files = {}
  for (const rel of listFiles(root)) {
    const full = join(root, rel)
    files[rel] = { bytes: statSync(full).size, sha256: sha256(full) }
  }
  return files
}

function parseArg(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const argv = process.argv.slice(2)
const home = parseArg(argv, '--home', dshHome())
const source = resolve(parseArg(argv, '--from', join(home, LEGACY_ROOT_DIR_NAME)))
const target = resolve(parseArg(argv, '--to', join(home, CURRENT_DIR_NAME)))
const mode = argv.includes('--apply') ? 'apply' : argv.includes('--revert') ? 'revert' : argv.includes('--verify') ? 'verify' : 'dry-run'

const report = { mode, source, target, at: new Date().toISOString() }

function refuse(message) {
  console.error(`migrate-store: ${message}`)
  process.exit(1)
}

if (mode === 'revert') {
  const markerPath = join(target, MARKER)
  if (!existsSync(markerPath)) {
    refuse(`目标目录 ${target} 里没有 ${MARKER} —— 这不是本脚本创建的目录，拒绝删除。`
      + '如果它确实是要删的，请手工确认后删除。')
  }
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  const now = manifest(target)
  const drifted = Object.keys(now).filter((rel) => marker.files[rel] === undefined || marker.files[rel].sha256 !== now[rel].sha256)
  if (drifted.length > 0) {
    refuse(`目标目录在迁移之后被改动过（${drifted.length} 个文件，例如 ${drifted.slice(0, 3).join(', ')}）。`
      + '删除会把新产生的记忆一起删掉，所以拒绝执行。请先备份再手工处理。')
  }
  rmSync(target, { recursive: true, force: true })
  console.log(`migrate-store: 已删除副本 ${target}；源目录 ${source} 未受影响`)
  process.exit(0)
}

if (!existsSync(source)) {
  console.log(`migrate-store: 源目录不存在 ${source} —— 已经是新布局，无需迁移`)
  process.exit(0)
}

const sourceFiles = listFiles(source)
let bytes = 0
for (const rel of sourceFiles) bytes += statSync(join(source, rel)).size
report.sourceFiles = sourceFiles.length
report.sourceBytes = bytes

if (mode === 'dry-run') {
  console.log(`migrate-store: 预演（未写任何文件）`)
  console.log(`  源    ${source}  ${sourceFiles.length} 个文件 / ${bytes} 字节`)
  console.log(`  目标  ${target}${existsSync(target) ? '  （已存在，--apply 会报冲突）' : '  （不存在）'}`)
  console.log(`\n  运行 \`node tools/migrate-store.mjs --apply\` 执行复制。源目录不会被删除。`)
  process.exit(0)
}

if (mode === 'verify') {
  if (!existsSync(target)) refuse(`目标目录不存在 ${target}`)
  const sourceManifest = manifest(source)
  const targetManifest = manifest(target)
  const missing = Object.keys(sourceManifest).filter((rel) => targetManifest[rel] === undefined)
  const differing = Object.keys(sourceManifest).filter((rel) => targetManifest[rel] !== undefined && targetManifest[rel].sha256 !== sourceManifest[rel].sha256)
  const extra = Object.keys(targetManifest).filter((rel) => sourceManifest[rel] === undefined)
  console.log(`migrate-store: 校验 ${source} ↔ ${target}`)
  console.log(`  源文件 ${Object.keys(sourceManifest).length} / 目标文件 ${Object.keys(targetManifest).length}`)
  console.log(`  缺失 ${missing.length}，内容不同 ${differing.length}，目标多出 ${extra.length}`)
  const ok = missing.length === 0 && differing.length === 0
  console.log(ok ? '  一致 ✓' : `  不一致：缺失 ${missing.slice(0, 3).join(', ')} 不同 ${differing.slice(0, 3).join(', ')}`)
  process.exit(ok ? 0 : 1)
}

if (existsSync(target) && listFiles(target).length > 0) {
  refuse(`目标目录 ${target} 已存在且非空。先手工确认，或用 --to 指定别的位置。`)
}

mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })

// 逐文件校验：任何一处不同就让整体失败，并且**不写完成标记**。
const sourceManifest = manifest(source)
const targetManifest = manifest(target)
const bad = Object.keys(sourceManifest).filter((rel) => targetManifest[rel] === undefined || targetManifest[rel].sha256 !== sourceManifest[rel].sha256)
report.files = sourceManifest
report.verified = bad.length === 0

if (bad.length > 0) {
  console.error(`migrate-store: 复制校验失败，${bad.length} 个文件不一致：${bad.slice(0, 5).join(', ')}`)
  console.error('  目标目录被保留以便排查，但**没有**写完成标记 —— 插件不会把它当成迁移完成的存储。')
  process.exit(1)
}

writeFileSync(join(target, MARKER), JSON.stringify(report, null, 2), 'utf8')
console.log(`migrate-store: 已复制并逐文件校验 ${Object.keys(sourceManifest).length} 个文件（${bytes} 字节）`)
console.log(`  源    ${source}   ← 一个字节都没动`)
console.log(`  目标  ${target}   标记 ${MARKER}`)
console.log(`  回滚  node tools/migrate-store.mjs --revert`)
console.log(`\n  提示：插件下次启动会优先使用新目录。确认无误后，源目录可以自行删除 —— 本脚本不会替你删。`)