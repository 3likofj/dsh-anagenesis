/**
 * Project identity — the stable fingerprint every memory is filed under.
 *
 * 为什么需要一个**指纹**而不是"把 cwd 存下来当标签"：cwd 会变（同一个项目在
 * Windows 上是 `D:\cj\anagenesis`，在容器里是 `/work/repo`），会话重启、换工作树、
 * 换盘符之后，一个"字符串相等"的标签会把同一条经验判成两个项目 —— 于是隔离变成
 * 了分尸。所以身份必须是**可复现的纯函数**：同样的仓库/路径，任何进程、任何时间
 * 都算出同一个 id。
 *
 * 优先级（先认仓库，再认路径）：
 *   1. git remote（`origin` 或第一个 remote）—— 一份代码的多个检出、多个工作树、
 *      换台机器，仍然是**同一个项目**，经验应当跟着项目走；
 *   2. 仓库根目录的规范化绝对路径 —— 没有 remote 的本地仓库；
 *   3. 当前工作目录的规范化绝对路径 —— 根本不是仓库的目录。
 *
 * 规范化是不可省略的一步：Windows 大小写不敏感、`D:\` 与 `d:/` 是同一个地方，
 * 尾随分隔符、`.`/`..`、正反斜杠混用都会让"同一个目录"变成两个 id。这里把
 * 大小写折叠**限定在 Windows 形态的路径**上（不做无条件小写：POSIX 下
 * `/srv/App` 与 `/srv/app` 真的是两个目录），并在能取到 realpath 时优先用它
 * （符号链接因此收敛到同一个身份）。
 *
 * **刻意不参与指纹的东西**：DSH_HOME、用户名、机器名、profile 名、会话 id、时间。
 * 前四个会让"同一个项目"在不同机器/不同 profile 下碎成多个；后两个会让指纹在
 * 重启后变化 —— 那正是规格里禁止的。
 * @module dsh-anagenesis/scope/project
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { hash32 } from '../util.js'

/** 作用域层级，闭合集合。任何 `tier` 不在其中的记录都被当成"未标注"。 */
export const SCOPE_TIERS = Object.freeze(['global', 'project', 'session'])

/** 全局命名空间的 key；同时也是日志里"没有前缀"的那个段。 */
export const GLOBAL_NAMESPACE = 'global'

/** 指纹算法版本：换算法就换前缀，老 id 因此仍可被识别为"上一代指纹"。 */
export const FINGERPRINT_VERSION = 'p1'

/** 从 cwd 向上找 `.git` 的最大层数：防止在病态路径上走到根目录。 */
const MAX_WALK_UP = 48

/**
 * 规范化一个路径，使其成为**身份**而不是"用户当时写下的字符串"。
 *
 * @param {string} input
 * @returns {string} 正斜杠、去尾随分隔符、Windows 形态折叠大小写
 */
export function canonicalPath(input) {
  let value = String(input ?? '').trim()
  if (value === '') return ''
  // realpath 只在真的存在时用：不存在的路径（还没建出来的工作区）仍然要能算指纹。
  try {
    if (existsSync(value)) value = realpathSync(value)
  } catch {
    // 权限不足、路径过长：保持原样，下面只做纯字符串规范化
  }
  value = value.split(sep).join('/').replace(/\\/g, '/')
  const windows = /^[a-zA-Z]:\//.test(value) || value.startsWith('//')
  if (windows) value = value.toLowerCase()
  // 去尾随斜杠（但保留根 `/`）
  value = value.replace(/\/+$/, '')
  if (value === '') value = '/'
  return value
}

/**
 * 规范化一个 git remote，使同一份代码的不同写法收敛到同一个身份。
 *
 * 覆盖四种真实写法：
 *   `git@github.com:owner/repo.git`、`https://github.com/owner/repo.git`、
 *   `ssh://git@github.com/owner/repo.git`、`git://host/owner/repo`。
 * @param {string} url
 * @returns {string} `host/owner/repo`（全部小写），无法解析时返回规范化后的原文
 */
export function canonicalRemote(url) {
  let value = String(url ?? '').trim()
  if (value === '') return ''
  value = value.replace(/\.git$/i, '')
  // scp 形态：user@host:path
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value)
  if (scp !== null && !value.includes('://')) {
    return `${scp[1].toLowerCase()}/${scp[2]}`.replace(/\/+/g, '/').replace(/^\/+/, '').toLowerCase()
  }
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`
    const parsed = new URL(withScheme)
    const path = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
    return `${parsed.hostname.toLowerCase()}/${path}`.replace(/\/+$/, '').toLowerCase()
  } catch {
    return value.toLowerCase()
  }
}

/**
 * 从 `dir` 向上找到第一个 `.git`（目录或 worktree 的 gitfile 指针）。
 * @param {string} dir
 * @returns {{ root: string, gitDir: string|null }|null}
 */
export function findRepoRoot(dir) {
  let current = resolve(String(dir ?? '.'))
  for (let depth = 0; depth < MAX_WALK_UP; depth++) {
    const marker = join(current, '.git')
    try {
      const stat = statSync(marker)
      if (stat.isDirectory()) return { root: current, gitDir: marker }
      if (stat.isFile()) {
        // worktree / submodule：`.git` 是一行 `gitdir: <path>`
        const text = readFileSync(marker, 'utf8')
        const match = /^gitdir:\s*(.+)$/m.exec(text)
        const target = match === null ? null : resolve(current, match[1].trim())
        return { root: current, gitDir: target }
      }
    } catch {
      // 不存在 / 不可读：继续向上
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/**
 * 读出一个仓库的 remote（优先 `origin`，否则第一个 `[remote "…"]`）。
 *
 * 手写解析 `.git/config` 而不是调用 `git`：本插件声明"不启动子进程"，
 * 而启动一个 git 进程只为读一个 URL，在任何一次工具调用里都不划算。
 * @param {string|null} gitDir
 * @returns {string} remote URL，没有时为空串
 */
export function readGitRemote(gitDir) {
  if (gitDir === null || gitDir === undefined) return ''
  let text = ''
  try {
    text = readFileSync(join(gitDir, 'config'), 'utf8')
  } catch {
    return ''
  }
  /** @type {Map<string, string>} */
  const remotes = new Map()
  let current = ''
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    const header = /^\[remote\s+"(.+)"\]$/.exec(line)
    if (header !== null) {
      current = header[1]
      continue
    }
    if (line.startsWith('[')) {
      current = ''
      continue
    }
    if (current === '') continue
    const url = /^url\s*=\s*(.+)$/.exec(line)
    if (url !== null && !remotes.has(current)) remotes.set(current, url[1].trim())
  }
  return remotes.get('origin') ?? [...remotes.values()][0] ?? ''
}

/**
 * @typedef {object} ProjectIdentity
 * @property {string} id 稳定指纹（`p1_<hash>`），跨会话/跨重启不变
 * @property {'repo'|'path'} kind 身份来自仓库还是普通目录
 * @property {string} root 规范化后的仓库根 / 工作目录
 * @property {string} remote 规范化后的 remote（无则空串）
 * @property {string} label 给人看的短标签
 * @property {'remote'|'path'} basis 指纹究竟按哪一项算出来的（可审计）
 */

/**
 * 计算项目身份。**纯函数**：同样的输入永远给出同样的 id。
 *
 * @param {{ cwd?: string, remote?: string, root?: string }} [input]
 * @returns {ProjectIdentity}
 */
export function fingerprintProject(input = {}) {
  const start = input.cwd !== undefined && input.cwd !== '' ? String(input.cwd) : process.cwd()
  const repo = input.root !== undefined && input.root !== ''
    ? { root: String(input.root), gitDir: null }
    : findRepoRoot(start)
  const root = canonicalPath(repo?.root ?? start)
  const remote = canonicalRemote(input.remote !== undefined && input.remote !== '' ? input.remote : readGitRemote(repo?.gitDir ?? null))

  const basis = remote === '' ? 'path' : 'remote'
  const material = basis === 'remote' ? `remote:${remote}` : `path:${root}`
  // 两个独立的 FNV-1a（不同盐）拼成 64 位量级的 id：单哈希 32 位在几千个项目上
  // 就有可观的碰撞概率，而"两个项目撞成同一个身份"正是这次改造要消灭的故障。
  const h1 = hash32(`${FINGERPRINT_VERSION}|a|${material}`).toString(36)
  const h2 = hash32(`${FINGERPRINT_VERSION}|b|${material}`).toString(36)
  const id = `${FINGERPRINT_VERSION}_${h1}${h2}`

  return {
    id,
    kind: basis === 'remote' ? 'repo' : 'path',
    root,
    remote,
    label: shortLabel(remote, root),
    basis,
  }
}

/**
 * @param {string} remote
 * @param {string} root
 * @returns {string}
 */
function shortLabel(remote, root) {
  if (remote !== '') {
    const parts = remote.split('/')
    return parts.slice(-2).join('/')
  }
  const parts = root.split('/').filter((segment) => segment !== '')
  return parts.slice(-2).join('/') || root
}

/**
 * 一条记录/一个 scope 对象属于哪个命名空间。
 *
 * 这是整个隔离层的**唯一**命名空间判定入口：召回过滤、日志分段、可视化分组
 * 都调它，所以"什么算同一个命名空间"只有一个答案。
 * @param {{ tier?: string, projectId?: string|null, session?: string|null, global?: boolean }} scope
 * @returns {string}
 */
export function namespaceOf(scope) {
  const tier = normalizeTier(scope)
  if (tier === 'global') return GLOBAL_NAMESPACE
  if (tier === 'session') return `session:${String(scope?.session ?? 'unknown')}`
  return `project:${String(scope?.projectId ?? 'unknown')}`
}

/**
 * @param {string} namespace
 * @returns {{ tier: string, key: string }}
 */
export function parseNamespace(namespace) {
  const value = String(namespace ?? '')
  if (value.startsWith('project:')) return { tier: 'project', key: value.slice('project:'.length) }
  if (value.startsWith('session:')) return { tier: 'session', key: value.slice('session:'.length) }
  return { tier: 'global', key: GLOBAL_NAMESPACE }
}

/**
 * 把命名空间变成文件名里安全的一段。段名只允许 `[a-z0-9-]`，其余折叠掉。
 * @param {string} namespace
 * @returns {string}
 */
export function namespaceSlug(namespace) {
  const value = String(namespace ?? GLOBAL_NAMESPACE)
  if (value === GLOBAL_NAMESPACE) return GLOBAL_NAMESPACE
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return slug === '' ? 'unknown' : slug
}

/**
 * 记录的作用域层级，缺失/非法时回落到旧字段推导出来的结果。
 *
 * v6 及更早的记录没有 `tier`：`scope.global === true` 的那些是"当时被当成全局写的"，
 * 迁移会显式把它们标成 `tier: 'global'` + `origin: 'migrated'`；这里只是兜底，
 * 保证一条形状残缺的记录不会被误判成"当前项目"。
 * @param {{ tier?: string, global?: boolean }} scope
 * @returns {'global'|'project'|'session'|'unscoped'}
 */
export function normalizeTier(scope) {
  const tier = String(scope?.tier ?? '')
  if (SCOPE_TIERS.includes(tier)) return /** @type {any} */ (tier)
  if (scope?.global === true) return 'global'
  return 'unscoped'
}

/**
 * 构造一条记录的作用域标签。写入路径**只**通过它生成标签，因此
 * "每条记忆都必须带 scope 与 project_id"是结构性的，不是约定。
 *
 * @param {{ tier?: string, projectId?: string|null, sessionId?: string|null, presetId?: string|null,
 *   workspace?: string|null, origin?: string, profile?: string|null }} input
 * @returns {{ tier: 'global'|'project'|'session', projectId: string|null, session: string|null,
 *   workspace: string|null, preset: string|null, profile: string|null, global: boolean, origin: string }}
 */
export function scopeTag(input = {}) {
  const wanted = SCOPE_TIERS.includes(String(input.tier)) ? String(input.tier) : 'project'
  const projectId = input.projectId === undefined || input.projectId === null || input.projectId === ''
    ? null
    : String(input.projectId)
  const session = input.sessionId === undefined || input.sessionId === null || input.sessionId === ''
    ? null
    : String(input.sessionId)
  // 显式要求 project 却没有 projectId 时**不**静默降级为 global：降级会把
  // 隔离变成一句空话（要求隔离 → 实际写全局 = 最坏的串扰）。宁可退到会话级，
  // 也不要把一条本该隔离的记忆撒进全局。
  /** @type {'global'|'project'|'session'} */
  let tier = /** @type {any} */ (wanted)
  if (tier === 'project' && projectId === null) tier = session === null ? 'global' : 'session'
  if (tier === 'session' && session === null) tier = projectId === null ? 'global' : 'project'
  return {
    tier,
    projectId: tier === 'project' ? projectId : (tier === 'session' ? projectId : null),
    session: tier === 'session' ? session : null,
    workspace: input.workspace === undefined ? null : input.workspace,
    preset: input.presetId === undefined ? null : input.presetId,
    profile: input.profile === undefined ? null : input.profile,
    global: tier === 'global',
    origin: String(input.origin ?? 'default'),
  }
}

/**
 * 给人看的作用域标签。可视化层与工具输出都用它，保证同一件事只有一种说法。
 * @param {{ tier?: string, projectId?: string|null, session?: string|null, global?: boolean }} scope
 * @returns {string}
 */
export function scopeLabel(scope) {
  const tier = normalizeTier(scope)
  if (tier === 'global') return 'global'
  if (tier === 'session') return `session:${String(scope?.session ?? '?').slice(0, 12)}`
  if (tier === 'project') return `project:${String(scope?.projectId ?? '?').slice(0, 12)}`
  return 'unscoped'
}

/**
 * 一条记录（**或者直接一个 scope 对象**）相对"当前上下文"的位置。召回加权、
 * 冲突检测、可视化着色都吃这个判定。
 *
 * 两种输入都接受是刻意的：调用方手上有时是记录、有时是 `record.scope`，而这两者
 * 混用一旦静默失败就会返回 `unscoped` —— 冲突检测因此什么都看不见（这正是它第一
 * 次上线时的故障）。一个能同时吃两种形状、且两种都给出正确答案的函数，比一条
 * "请传记录"的注释可靠。
 * @param {any} target a record, or its `scope` object
 * @param {{ projectId?: string|null, sessionId?: string|null }} context
 * @returns {'global'|'current-project'|'current-session'|'other-project'|'other-session'|'unscoped'}
 */
export function scopeRelation(target, context = {}) {
  const scope = target !== null && typeof target === 'object' && target.scope !== null && typeof target.scope === 'object'
    ? target.scope
    : target
  const tier = normalizeTier(scope)
  if (tier === 'global') return 'global'
  if (tier === 'unscoped') return 'unscoped'
  if (tier === 'session') {
    const wanted = context.sessionId ?? null
    return wanted !== null && scope.session === wanted ? 'current-session' : 'other-session'
  }
  const wanted = context.projectId ?? null
  return wanted !== null && scope.projectId === wanted ? 'current-project' : 'other-project'
}

/**
 * 从任意对象里提取"这次调用发生在哪个项目"。工具层的 `exec` 形状因宿主而异，
 * 所以这里按已知字段逐个尝试，全都没有时落到进程 cwd —— 不抛错、不返回空。
 *
 * 第一候选是**真宿主**的形状：`exec.agent.session.header.cwd`
 * （`@deepseek-ai/dsh-tool-pwsh@0.2.0-rc.2` 就是这么读的，session header 校验它
 * 必须是绝对路径）。其余候选是旧宿主与测试桩的形状，保留是为了不把插件绑死在
 * 一个版本上。
 * @param {any} exec
 * @returns {string} 一个目录
 */
export function cwdFromExec(exec) {
  const candidates = [
    exec?.agent?.session?.header?.cwd,
    exec?.cwd,
    exec?.agent?.cwd,
    exec?.agent?.workspace,
    exec?.session?.cwd,
    exec?.agent?.config?.cwd,
    exec?.workspace,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '' && isAbsolute(value)) return value
  }
  return process.cwd()
}

/**
 * 从任意对象里提取会话 id。
 *
 * `exec.agent.id` 是真宿主的字段（`Agent` 的最小结构就是 `{ readonly id: SessionId }`），
 * 而 `session.header.id` 在部分版本上才存在；两者都试，拿不到就返回 null ——
 * 会话级记忆在拿不到会话 id 时会**退到项目级**而不是"匹配所有会话"。
 * @param {any} exec
 * @returns {string|null}
 */
export function sessionFromExec(exec) {
  const candidates = [
    exec?.agent?.session?.header?.id,
    exec?.agent?.sessionId,
    exec?.sessionId,
    exec?.session?.id,
    exec?.agent?.id,
    exec?.agent?.name,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/**
 * 调用方的 agent id —— 权限层用它把"谁在调用"映射到授权作用域。
 * @param {any} exec
 * @returns {string|null}
 */
export function agentIdFromExec(exec) {
  const candidates = [exec?.agent?.id, exec?.agent?.sessionId, exec?.agent?.name]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}
