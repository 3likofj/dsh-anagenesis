/**
 * 发布前自检 —— 把"我是不是忘了什么"变成一条命令。
 *
 * 这个脚本存在的理由：发布是**一次性的、错了要撤回**的动作，而漏项往往是
 * 静默的（比如 `package.json` 写着 MIT 却没有 LICENSE 文件、README 的安装命令
 * 指向只有作者本机才有的路径）。逐项检查，任一不过就退出码 1。
 *
 *   node tools/preflight-publish.mjs
 *   node tools/preflight-publish.mjs --json
 * @module dsh-anagenesis/tools/preflight-publish
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')

/** @type {{ id: string, ok: boolean, detail: string }[]} */
const checks = []
const check = (id, ok, detail) => checks.push({ id, ok: ok === true, detail: String(detail) })

const readJson = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'))
const pkg = readJson('package.json')
const winPkg = readJson('window/package.json')

// ── 法律与元数据 ──────────────────────────────────────────────────────────
check('LICENSE 文件存在', existsSync(join(root, 'LICENSE')), 'package.json 声明 MIT，就必须真的带上许可证正文')
check('父包 package.json license 与 LICENSE 一致', pkg.license === 'MIT' && existsSync(join(root, 'LICENSE')), pkg.license ?? '缺失')
check('窗口包 license 与 LICENSE 一致', winPkg.license === 'MIT', winPkg.license ?? '缺失')
check('父包 repository', typeof pkg.repository?.url === 'string', pkg.repository?.url ?? '缺失 —— 市场卡片与 npm 页面都会缺链接')
check('窗口包 repository', typeof winPkg.repository?.url === 'string', winPkg.repository?.url ?? '缺失')
check('父包 homepage', typeof pkg.homepage === 'string', pkg.homepage ?? '缺失')
check('父包 author', typeof pkg.author === 'string', pkg.author ?? '缺失')

// ── 占位符必须被替换 ──────────────────────────────────────────────────────
const PLACEHOLDERS = ['REPLACE-ME', 'REPLACE_ME', 'TODO', 'your-username', '<你的用户名>']
const scanned = ['package.json', 'window/package.json', 'README.md', 'README.en.md']
const leftovers = []
for (const file of scanned) {
  const text = readFileSync(join(root, file), 'utf8')
  for (const token of PLACEHOLDERS) if (text.includes(token)) leftovers.push(`${file}: ${token}`)
}
check('没有未替换的占位符', leftovers.length === 0, leftovers.join(' · ') || '干净')

// ── 双语文档成对存在 ──────────────────────────────────────────────────────
for (const [zh, en] of [['README.md', 'README.en.md'], ['window/README.md', 'window/README.en.md']]) {
  check(`${zh} / ${en} 成对存在`, existsSync(join(root, zh)) && existsSync(join(root, en)), '开源仓库要求中英双语')
}
check('CHANGELOG.md 存在', existsSync(join(root, 'CHANGELOG.md')), '市场会展示版本说明；对不上版本时只能给提交记录')

// ── README 里引用的本地图片必须真的存在 ────────────────────────────────────
// 坏图是"最像没写完"的发布事故，而且静态检查就能抓到：只校验相对路径，外链交给网络。
const imageProblems = []
for (const file of ['README.md', 'README.en.md', 'window/README.md', 'window/README.en.md']) {
  if (!existsSync(join(root, file))) continue
  const text = readFileSync(join(root, file), 'utf8')
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
    const target = match[1]
    if (/^https?:\/\//i.test(target)) continue
    if (!existsSync(join(root, dirname(file), target))) imageProblems.push(`${file} → ${target}`)
  }
}
check('README 里的本地图片引用都存在', imageProblems.length === 0, imageProblems.join(' · ') || '全部命中')

// ── 安装说明不能只有作者本机可用的路径 ────────────────────────────────────
const localPath = /link:D:\/cj\/anagenesis/i
const installDocs = ['README.md', 'README.en.md']
const badInstall = installDocs.filter((file) => localPath.test(readFileSync(join(root, file), 'utf8')))
// 本地路径出现在"开发者/本仓库"上下文里是允许的；出现在第一安装命令里不行。
const npmFirst = installDocs.filter((file) => /dsh plugin add dsh-anagenesis/.test(readFileSync(join(root, file), 'utf8')))
check('README 首条安装命令对他人可用（npm）', npmFirst.length === 2, `npm 优先的文件：${npmFirst.join(', ') || '无'}`)
check('README 没有把本机路径当成唯一安装方式', badInstall.length === 0 || npmFirst.length === 2,
  badInstall.length === 0 ? '无本地路径' : `${badInstall.join(', ')} 里出现本机路径（只要 npm 命令在前即可）`)

// ── 包内容完整 ────────────────────────────────────────────────────────────
const required = ['src/index.js', 'src/paths.js', 'src/viz/model.js', 'src/viz/redact.js', 'src/viz/mirror.js', 'cordis.patch.yml', 'client.js']
const missingWin = required.filter((file) => file.startsWith('client') || file === 'cordis.patch.yml')
  .filter((file) => !existsSync(join(root, 'window', file)))
check('窗口包关键文件在位', missingWin.length === 0, missingWin.join(', ') || 'ok')
check('父包 exports 覆盖窗口要用的 5 个 viz 子路径',
  ['model', 'tui', 'diagram', 'redact', 'mirror'].every((part) => pkg.exports[`./viz/${part}`] !== undefined),
  '窗口在安装态走 bare specifier，缺一个就会整体回退到相对路径而失效')
check('窗口包声明了对父包的依赖', winPkg.peerDependencies?.['dsh-anagenesis'] !== undefined, JSON.stringify(winPkg.peerDependencies?.['dsh-anagenesis'] ?? null))

// ── 交付物里不该有开发残留 ────────────────────────────────────────────────
const shipped = [...(pkg.files ?? [])]
check('files 不含 .rename-backup', !shipped.some((item) => item.includes('rename-backup')), shipped.join(', '))
check('files 不含预览截图', !shipped.some((item) => item.includes('.preview')), '截图体积大且与包功能无关')
for (const entry of ['README.md', 'README.en.md', 'LICENSE']) {
  check(`files 含 ${entry}`, shipped.includes(entry) || entry === 'LICENSE', 'npm 页面会读它们')
}

const failed = checks.filter((item) => item.ok !== true)
if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2))
} else {
  for (const item of checks) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.id}${item.ok ? '' : '  —— ' + item.detail}`)
  console.log(failed.length === 0
    ? `\n发布前自检全部通过（${checks.length} 项）`
    : `\n发布前自检：${failed.length}/${checks.length} 项未通过`)
}
process.exit(failed.length === 0 ? 0 : 1)