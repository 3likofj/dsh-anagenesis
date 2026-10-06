/**
 * 存储位置的解析 —— **本模块不导入任何宿主包**。
 *
 * 单独成文件的理由是可执行性：`tools/migrate-store.mjs` 是个给人直接跑的 CLI，
 * 它需要 `LEGACY_ROOT_DIR_NAME` 与 `dshHome()`。如果它从 `src/index.js` 导入，
 * 就会连带把 `@deepseek-ai/schemastery` 拖进来 —— 那个包只在 DSH 宿主里能解析，
 * 于是"一个搬迁脚本"要求用户先装一套宿主加载器才能跑。路径解析是纯计算，
 * 不该有这种依赖。
 *
 * @module dsh-anagenesis/paths
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 当前包名对应的存储目录名。 */
export const CURRENT_ROOT_DIR_NAME = 'anagenesis'

/**
 * 改名前的存储目录名（磁盘上真实存在，仅用于读取兼容）。
 *
 * 只作为**读取兼容**保留，不再是默认值。见 `resolveRootDir()`。
 */
export const LEGACY_ROOT_DIR_NAME = 'evolution'

/** @returns {string} `$DSH_HOME`（未设置时退回 `~/.dsh`） */
export function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

/** @returns {string} 新装的默认自包含存储位置 */
export function defaultRootDir() {
  return join(dshHome(), CURRENT_ROOT_DIR_NAME)
}

/**
 * 解析**实际**要用的存储根，必要时回退到旧目录。
 *
 * 为什么不能只改个名字就完事：目录名就是数据的位置。把 `evolution/` 改成
 * `anagenesis/` 之后，老用户升级上来会看到一个**空的**新目录，界面上写着
 * "0 条记忆" —— 数据没丢，但对用户来说和丢了没区别。所以：
 *
 *   1. 显式配置了 `rootDir`（且**不等于默认值**）→ 听配置的（`source: 'config'`）；
 *   2. 新目录与旧目录**都有存储**时，**内容更多的那一个胜出**：旧存储严格更丰富
 *      → 用旧目录（`source: 'legacy'`），否则用新目录（`source: 'current'`）；
 *   3. 只有一个存在 → 用它；
 *   4. 两者都不存在 → 用新目录，这是全新安装（`source: 'new'`）。
 *
 * 第 2 条为什么不是"新目录存在就用新目录"：改名之后**插件自己**会建出那个新目录，
 * 于是"新目录存在"变成一个恒真条件，回退链永远不会走。真机上就是这么翻车的 ——
 * 用户的 6 条记忆留在旧目录，界面显示"0 条记忆"。判定标准因此从"目录在不在"
 * 换成"哪一边真的有东西"，并且**只要旧目录严格更丰富就一定用它并记日志**：
 * 宁可提示一次"你还在用旧目录"，也不要让用户看见一个空存储。
 *
 * 刻意**不做**自动搬迁：移动用户数据是不可逆动作，必须由用户显式触发
 * （`tools/migrate-store.mjs`）。这条与"可逆效应"是同一件事 —— 插件自己发起的
 * 副作用必须能被插件撤回，而"我已经把你的数据挪走了"撤回不了。
 *
 * @param {string} [configured]
 * @returns {{ rootDir: string, source: 'config'|'current'|'legacy'|'new', legacyDir: string, reason?: string }}
 */
export function resolveRootDir(configured) {
  const home = dshHome()
  const legacyDir = join(home, LEGACY_ROOT_DIR_NAME)
  const current = join(home, CURRENT_ROOT_DIR_NAME)
  const raw = typeof configured === 'string' ? configured.trim() : ''
  // schema 的 `.default(defaultRootDir())` 会在行加载时就把 rootDir 填好，所以
  // "值恰好等于默认值"必须当成"用户没配" —— 否则回退链在真实启动里走不到。
  if (raw !== '' && raw !== defaultRootDir()) {
    return { rootDir: raw, source: 'config', legacyDir }
  }
  const currentWeight = storeWeight(current)
  const legacyWeight = storeWeight(legacyDir)
  if (legacyWeight > currentWeight) {
    return { rootDir: legacyDir, source: 'legacy', legacyDir, reason: `legacy store is richer (${legacyWeight} > ${currentWeight})` }
  }
  if (currentWeight > 0) return { rootDir: current, source: 'current', legacyDir }
  if (legacyWeight > 0) return { rootDir: legacyDir, source: 'legacy', legacyDir, reason: 'only the legacy store has data' }
  if (existsSync(current)) return { rootDir: current, source: 'current', legacyDir }
  if (existsSync(legacyDir)) return { rootDir: legacyDir, source: 'legacy', legacyDir, reason: 'legacy directory exists' }
  return { rootDir: current, source: 'new', legacyDir }
}

/**
 * 一个目录"有多像一个装着东西的存储"：
 *   0 = 没有存储痕迹；1 = 有 snapshot/journal 但一条记忆都没有；2 = 有记忆。
 *
 * 只看 `state.memories` 的条数，不解析任何记录内容 —— 路由决策不该读数据，
 * 但它**必须**知道哪一边是空的，否则就会把用户带到一个空存储前面。
 * @param {string} dir
 * @returns {0|1|2}
 */
export function storeWeight(dir) {
  const snapshot = join(dir, 'snapshot.json')
  if (!existsSync(snapshot) && !existsSync(join(dir, 'journal'))) return 0
  try {
    const parsed = JSON.parse(readFileSync(snapshot, 'utf8'))
    const memories = parsed?.state?.memories
    const count = memories !== null && typeof memories === 'object' ? Object.keys(memories).length : 0
    return count > 0 ? 2 : 1
  } catch {
    return 1
  }
}