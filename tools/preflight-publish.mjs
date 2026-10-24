/**
 * 发布前自检 —— 把"我是不是忘了什么"变成一条命令。
 *
 * 这个脚本存在的理由：发布是**一次性的、错了要撤回**的动作，而漏项往往是
 * 静默的（比如 `package.json` 声明的许可证和 `LICENSE` 正文对不上、README 的安装命令
 * 指向只有作者本机才有的路径、合并后 `window/package.json` 又冒出来把包身份拆成两半）。
 * 逐项检查，任一不过就退出码 1。
 *
 * 0.3.0 起只有一个包：所有"窗口包"的检查都换成了"这个包的窗口部分"。
 *
 *   node tools/preflight-publish.mjs
 *   node tools/preflight-publish.mjs --json
 * @module dsh-anagenesis/tools/preflight-publish
 */

import { existsSync, readFileSync, openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')

/** @type {{ id: string, ok: boolean, detail: string }[]} */
const checks = []
const check = (id, ok, detail) => checks.push({ id, ok: ok === true, detail: String(detail) })

const readJson = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'))
const readText = (file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '')
const pkg = readJson('package.json')

// ── 法律与元数据 ──────────────────────────────────────────────────────────
const EXPECTED_LICENSE = 'Apache-2.0'
const LICENSE_MARKERS = ['Apache License', 'Version 2.0, January 2004']
const licenseBody = readText('LICENSE')
const licenseIsExpected = LICENSE_MARKERS.every((marker) => licenseBody.includes(marker))
check('LICENSE 正文就是声明的许可证', licenseBody.length > 0 && licenseIsExpected,
  licenseBody.length === 0 ? 'LICENSE 缺失' : `正文里找不到 ${LICENSE_MARKERS.join(' / ')}`)
check(`package.json license 与 LICENSE 一致（${EXPECTED_LICENSE}）`,
  pkg.license === EXPECTED_LICENSE && licenseIsExpected, pkg.license ?? '缺失')
check('repository', typeof pkg.repository?.url === 'string', pkg.repository?.url ?? '缺失 —— 市场卡片与 npm 页面都会缺链接')
check('homepage', typeof pkg.homepage === 'string', pkg.homepage ?? '缺失')
check('author', typeof pkg.author === 'string', pkg.author ?? '缺失')

// ── 合并后的包身份 ────────────────────────────────────────────────────────
check('包名仍是 dsh-anagenesis', pkg.name === 'dsh-anagenesis', pkg.name)
check('孪生包身份已删除（window/package.json 不存在）', !existsSync(join(root, 'window', 'package.json')),
  '留着它，window/ 会自成一个包名，行与 client id 全乱（HANDOFF §25.3 约束 C）')
check('孪生 patch 已删除（window/cordis.patch.yml 不存在）', !existsSync(join(root, 'window', 'cordis.patch.yml')),
  '窗口行现在住在根 cordis.patch.yml 里')
check('dsh.client 声明在根包上', pkg.dsh?.client?.platform === 'web', JSON.stringify(pkg.dsh?.client ?? null))
check('exports 的 ./client 指向 window/client.js',
  String(pkg.exports?.['./client'] ?? '').includes('window/client.js'), String(pkg.exports?.['./client'] ?? 'ABSENT'))
check('exports 的 ./window 指向窗口 Host 半',
  String(pkg.exports?.['./window'] ?? '').includes('window/src/index.js'), String(pkg.exports?.['./window'] ?? 'ABSENT'))
check('exports 的 ./core 指向核心行（预设用子路径挂它）',
  String(pkg.exports?.['./core'] ?? '').includes('src/index.js'), String(pkg.exports?.['./core'] ?? 'ABSENT'))

const patch = readText('cordis.patch.yml')
const rowNames = patch.split('\n')
  .filter((line) => /^\s*name:\s*dsh-anagenesis/.test(line))
  .map((line) => line.replace(/^\s*name:\s*/, '').trim())
check('bundle patch 插入六行', rowNames.length === 6, rowNames.join(', '))
check('裸包名只出现一次（client-modules 的真实约束）',
  rowNames.filter((name) => name === 'dsh-anagenesis').length === 1, `bare=${rowNames.filter((name) => name === 'dsh-anagenesis').length}`)
check('窗口行用子路径挂载', rowNames.includes('dsh-anagenesis/window'), rowNames.find((name) => name.endsWith('/window')) ?? '缺失')

// ── 占位符必须被替换 ──────────────────────────────────────────────────────
const PLACEHOLDERS = ['REPLACE-ME', 'REPLACE_ME', 'TODO', 'your-username', '<你的用户名>']
const leftovers = []
for (const file of ['package.json', 'README.md', 'README.en.md']) {
  const text = readText(file)
  for (const token of PLACEHOLDERS) if (text.includes(token)) leftovers.push(`${file}: ${token}`)
}
check('没有未替换的占位符', leftovers.length === 0, leftovers.join(' · ') || '干净')

// ── 文档成对存在 ──────────────────────────────────────────────────────────
check('README.md / README.en.md 成对存在', existsSync(join(root, 'README.md')) && existsSync(join(root, 'README.en.md')),
  '开源仓库要求中英双语')
check('窗口说明 README 仍在包内（window/README.md）', existsSync(join(root, 'window', 'README.md')), '窗口是可选行，说明跟着包走')
check('CHANGELOG.md 存在', existsSync(join(root, 'CHANGELOG.md')), '市场会展示版本说明；对不上版本时只能给提交记录')
const changelog = readText('CHANGELOG.md')
check(`CHANGELOG 有 ${pkg.version} 一段`, changelog.includes(pkg.version), `找不到 ${pkg.version}`)

// ── README 里引用的本地图片必须真的存在 ────────────────────────────────────
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

// ── 安装说明：一条命令，且只有一条 ────────────────────────────────────────
const installDocs = ['README.md', 'README.en.md']
const npmFirst = installDocs.filter((file) => /dsh plugin add dsh-anagenesis\b/.test(readText(file)))
check('README 首条安装命令对他人可用（npm）', npmFirst.length === 2, `npm 优先的文件：${npmFirst.join(', ') || '无'}`)
const secondPackage = installDocs.filter((file) => /dsh plugin add dsh-anagenesis-window/.test(readText(file)))
check('README 不再让用户装第二个包（合并后一个包）', secondPackage.length === 0,
  secondPackage.join(', ') || '只有一条安装命令')
const localPath = /link:D:\/cj\/anagenesis/i
const badInstall = installDocs.filter((file) => localPath.test(readText(file)))
check('README 没有把本机路径当成安装方式', badInstall.length === 0, badInstall.join(', ') || '无本地路径')

// ── 新特性必须被写到文档里（否则发布说明在说谎） ──────────────────────────
check('README 提到设施视图（新的默认面）', readText('README.md').includes('设施'), '中文 README 没写')
check('README.en 提到 facility view', /facilit/i.test(readText('README.en.md')), 'English README 没写')

// ── 包内容完整 ────────────────────────────────────────────────────────────
const windowFiles = ['window/client.js', 'window/client.d.ts', 'window/src/index.js', 'window/src/host/viz.js']
const missingWindow = windowFiles.filter((file) => !existsSync(join(root, file)))
check('窗口部分的关键文件在位', missingWindow.length === 0, missingWindow.join(', ') || `ox ${windowFiles.length} 项`)
const vizParts = ['model', 'tui', 'diagram', 'redact', 'mirror', 'facility']
const missingParts = vizParts.filter((part) => pkg.exports?.[`./viz/${part}`] === undefined)
check('exports 覆盖窗口要用的 6 个 viz 子路径', missingParts.length === 0,
  missingParts.join(', ') || '窗口在安装态走 bare specifier，缺一个就会整体回退到包内相对路径')

const shipped = [...(pkg.files ?? [])]
check('files 含窗口部分（window/src + window/client.js）',
  shipped.includes('window/src') && shipped.includes('window/client.js'),
  shipped.join(', '))
check('files 含 cordis.patch.yml 与双语 README',
  ['cordis.patch.yml', 'README.md', 'README.en.md', 'CHANGELOG.md'].every((entry) => shipped.includes(entry)),
  shipped.join(', '))
check('files 不含 .rename-backup', !shipped.some((item) => item.includes('rename-backup')), shipped.join(', '))
check('files 不含预览截图/测试', !shipped.some((item) => item.includes('.preview') || item.includes('test')), '截图体积大且与包功能无关')

// ── peer 版本必须覆盖宿主（预发布版本的比较器只在三段相同时才接受） ────────
/**
 * 读安装态宿主自己的版本。asar 不是目录，所以按格式读 16 字节头 + JSON 索引。
 * 找不到宿主时这条不判红：这台机器没有桌面端不代表包有问题。
 */
function hostVersion() {
  const candidates = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar') : '',
  ].filter((value) => value !== '' && existsSync(value))
  for (const asar of candidates) {
    let fd = -1
    try {
      fd = openSync(asar, 'r')
      const head = Buffer.alloc(16)
      readSync(fd, head, 0, 16, 0)
      const headerSize = head.readUInt32LE(12)
      const json = Buffer.alloc(headerSize)
      readSync(fd, json, 0, headerSize, 16)
      const header = JSON.parse(json.toString('utf8'))
      const entry = header.files?.dsh?.files?.['package.json']
      if (entry === undefined) continue
      const body = Buffer.alloc(entry.size)
      readSync(fd, body, 0, entry.size, 16 + headerSize + Number(entry.offset))
      return JSON.parse(body.toString('utf8')).version
    } catch {
      /* try the next candidate */
    } finally {
      if (fd !== -1) closeSync(fd)
    }
  }
  return ''
}
const host = hostVersion()
const peer = String(pkg.peerDependencies?.['@deepseek-ai/dsh-tools'] ?? '')
if (host === '') {
  check('peerDependencies 覆盖宿主版本', peer !== '', `${peer || '缺失'}（本机没找到宿主，版本比对跳过）`)
} else {
  const wanted = '^' + host
  check('peerDependencies 覆盖宿主版本', peer === wanted, `peer=${peer || '缺失'} · host=${host}（期望 ${wanted}）`)
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
