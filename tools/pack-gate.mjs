/**
 * 打包闸门 —— 回答「这个仓库真的能被装成 npm 包并解析吗」。
 *
 * 为什么需要它：`window/src/host/viz.js` 在 bare specifier 解析失败时会回退到
 * `../../../src/viz/*.js`，而 checkout 里那个相对路径**恰好存在**。于是 `exports`
 * 少写一条（例如 `./viz/redact`）时，本机四道闸门全绿，只有真装成 npm 包才会暴露：
 * `loadVizLayer().resolvedBy` 会从 `package` 变成 `relative`。本闸门就是把那次人工
 * 验证固化下来。
 *
 * 0.3.0 起只有一个包（`dsh-anagenesis`），窗口是它的第六行 + `dsh.client` 半。
 * 所以这里多守一条合并特有的不变量：**安装态里必须有 `window/client.js` 与
 * `window/src/index.js`**，且 `exports['./client']` / `exports['./window']` 都能解析
 * —— 有了它们，"一个包"才不是一句口号。
 *
 * 它检查六件事：
 *   1. `npm pack` 真实选择出来的文件清单：必需项在、开发残留不在；
 *   2. 包里声明的**每个** exports 子路径都能从安装态解析（清单直接读 manifest，
 *      不另抄一份，抄一份就会漂移）；
 *   3. 装出来的窗口 Host 半 `loadVizLayer() -> resolvedBy === 'package'`，6 个子路径全部可用；
 *   4. 装出来的 client 半仍是经典脚本，且 ModuleLoader id = 包名；
 *   5. 装出来的包对着一个空存储目录能给出正常回答（不碰真实存储）；
 *   6. `cordis.patch.yml` 的六行里，裸包名只出现一次。
 *
 * ⚠️ 与仓库其余工具不同，本文件会 spawn `npm`。理由是无法不 spawn 就拿到
 * **npm 自己**的文件选择结果（这正是第 1 项要测的东西）；替身实现 npm 的
 * files/ignore 规则只会测到替身。它是 dev 闸门：不进 `files`、不进离线闸门
 * （`npm run gate:pack` 单独跑），也不在插件运行时被任何代码调用 ——
 * `package.json` 的 `subprocess: none` 说的是插件本体，不是开发脚本。
 *
 * 怎么让它红：删掉 `exports` 里任意一条 `./viz/*`（第 3 项红）；
 * 把 `src/viz/facility.js` 从 `files` 里拿掉（第 1/2 项红）；
 * 把 `window/client.js` 从 `files` 里拿掉（第 1/4 项红）。
 *
 *   node tools/pack-gate.mjs [--keep] [--json]
 * @module dsh-anagenesis/tools/pack-gate
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const asJson = argv.includes('--json')

const checks = []
const check = (id, ok, detail) => checks.push({ id, ok: ok === true, detail: String(detail) })
const temp = join(tmpdir(), `anagenesis-pack-gate-${process.pid}`)

/**
 * npm 的 pack 结果。唯一必须 spawn 的一步：要的就是 npm 自己的文件选择。
 *
 * 优先直接跑 `node <npm-cli.js>`（`npm run` 会设 `npm_execpath`，否则按 node 的安装
 * 位置推），而不是把 `npm` 交给 shell —— Windows 上 `cmd /c "npm" …` 会给命令名加引号，
 * 使 npm.cmd 里的 `%~dp0` 解析错位（实测会变成当前目录，然后报
 * `Cannot find module <cwd>\node_modules\npm\bin\npm-prefix.js`）。
 * 直接指定 CLI 还顺带摆脱了对 PATH 的依赖。
 */
function runNpm(args, cwd) {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  const cli = candidates.find((value) => typeof value === 'string' && /\.(cjs|mjs|js)$/.test(value) && existsSync(value))
  const options = { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
  let result
  if (cli !== undefined) {
    result = spawnSync(process.execPath, [cli, ...args], options)
  } else {
    // 兜底：交给 shell，但**只给参数加引号，命令名不加**（原因见上）。
    const quoteArg = (value) => (/[\s"^&|<>]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)
    result = spawnSync(['npm', ...args.map(quoteArg)].join(' '), { ...options, shell: true })
  }
  if (result.error !== undefined) throw new Error(`could not run npm: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} exited ${result.status}: ${String(result.stderr).slice(0, 400)}`)
  return String(result.stdout ?? '')
}

/** `npm pack --json` 会顺手打印 notice；只取第一段 JSON 数组。 */
function parsePackJson(text) {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) throw new Error(`npm pack --json did not print JSON: ${text.slice(0, 300)}`)
  return JSON.parse(text.slice(start, end + 1))
}

const cstring = (buffer) => buffer.toString('utf8').replace(/\0[\s\S]*$/, '')

/**
 * 最小 ustar 读取器（只读 entries，不处理权限/时间）。
 *
 * 不用系统 `tar` 的原因：那会把「解析 tarball」外包给一个本机可能没有、且各平台
 * 行为不同的外部程序；这里只需要 512 字节头 + 八进制长度，几十行就够，而且能和
 * npm 自报的文件清单互为交叉校验。
 * @param {string} file
 * @returns {{ path: string, body: Buffer }[]}
 */
function readTarGz(file) {
  const buffer = gunzipSync(readFileSync(file))
  /** @type {{ path: string, body: Buffer }[]} */
  const entries = []
  let offset = 0
  let paxPath = null
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = cstring(header.subarray(0, 100))
    const size = Number.parseInt(cstring(header.subarray(124, 136)).trim(), 8) || 0
    const typeFlag = String.fromCharCode(header[156])
    const prefix = cstring(header.subarray(345, 500))
    const body = buffer.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (typeFlag === 'x') {
      // pax 扩展头：长路径写在这里，作用于下一个真实 entry。
      const match = /(?:^|\n)\d+ path=([^\n]+)/.exec(body.toString('utf8'))
      if (match !== null) paxPath = match[1]
      continue
    }
    if (typeFlag === 'g') continue
    const path = paxPath ?? (prefix === '' ? name : `${prefix}/${name}`)
    paxPath = null
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') entries.push({ path, body })
  }
  return entries
}

/**
 * 把 tarball 解到 `dest`（去掉 npm 的 `package/` 前缀），并拒绝越界路径。
 * @param {string} tarball
 * @param {string} dest
 * @param {string[]} expectedFiles npm 自报的清单，用作交叉校验
 */
function extractInto(tarball, dest, expectedFiles) {
  const destRoot = resolve(dest)
  const stripped = readTarGz(tarball).map((entry) => ({
    path: entry.path.startsWith('package/') ? entry.path.slice('package/'.length) : entry.path,
    body: entry.body,
  }))
  const names = stripped.map((entry) => entry.path).sort()
  const listed = [...expectedFiles].sort()
  const mismatch = names.length !== listed.length || names.some((name, index) => name !== listed[index])
  check('tarball 内容与 npm 自报清单一致', !mismatch,
    mismatch ? `tarball ${names.length} 项 / npm 报 ${listed.length} 项` : `${names.length} 项`)
  for (const entry of stripped) {
    const target = resolve(destRoot, entry.path)
    if (!target.startsWith(destRoot + sep)) throw new Error(`tarball entry escapes the destination: ${entry.path}`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.body)
  }
}

try {
  mkdirSync(join(temp, 'packs'), { recursive: true })
  const consumer = join(temp, 'consumer')
  mkdirSync(consumer, { recursive: true })
  writeFileSync(join(consumer, 'package.json'),
    JSON.stringify({ name: 'anagenesis-pack-gate-consumer', private: true, type: 'module' }, null, 2))

  // ── 1. 真打包（一个包） ───────────────────────────────────────────────────
  const stdout = runNpm(['pack', '--json', '--pack-destination', join(temp, 'packs')], ROOT)
  const [info] = parsePackJson(stdout)
  if (info === undefined || typeof info.filename !== 'string') throw new Error('npm pack gave no filename')
  const packed = {
    name: info.name,
    file: join(temp, 'packs', info.filename),
    files: (info.files ?? []).map((row) => row.path),
    version: info.version,
  }
  check(`打包成功（${packed.name}@${packed.version}，${packed.files.length} 个文件）`,
    packed.name === 'dsh-anagenesis', `${info.name} → ${info.filename}`)

  // ── 2. 内容闸门：必需项在、开发残留不在 ───────────────────────────────────
  const REQUIRED = [
    'package.json', 'README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md', 'cordis.patch.yml',
    'src/index.js', 'src/paths.js', 'src/viz/model.js', 'src/viz/tui.js', 'src/viz/diagram.js',
    'src/viz/redact.js', 'src/viz/mirror.js', 'src/viz/facility.js',
    'tools/migrate-store.mjs', 'tools/viz-watch.mjs', 'tools/preflight-publish.mjs',
    // 第六行与 client 半必须在安装态里 —— 这就是"两个包合一"的可验证形态。
    'window/src/index.js', 'window/src/host/viz.js', 'window/src/host/rpc.js', 'window/src/host/tool.js',
    'window/client.js', 'window/client.d.ts', 'window/README.md', 'window/README.en.md',
  ]
  const FORBIDDEN = ['test/', 'node_modules/', '.preview', 'HANDOFF.md', 'PROJECT-STATE.md', '.tgz',
    'pack-gate.mjs', 'rename-backup', '%SystemDrive%', 'window/package.json', 'window/cordis.patch.yml']
  const missing = REQUIRED.filter((file) => !packed.files.includes(file))
  const leaked = packed.files.filter((file) => FORBIDDEN.some((bad) => file.includes(bad)))
  check('tarball 必需文件齐全', missing.length === 0, missing.join(', ') || `${REQUIRED.length} 项都在`)
  check('tarball 没有开发残留', leaked.length === 0, leaked.join(', ') || `无 ${FORBIDDEN.join(' / ')}`)

  // ── 3. 解出「安装态」 ─────────────────────────────────────────────────────
  const installed = join(consumer, 'node_modules', packed.name)
  mkdirSync(installed, { recursive: true })
  extractInto(packed.file, installed, packed.files)
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  check('解出来的 package.json 名/版本正确',
    manifest.name === packed.name && manifest.version === packed.version,
    `${manifest.name}@${manifest.version}`)
  check("安装态的 dsh.client 仍在，且 ./client 指向 window/client.js",
    manifest.dsh?.client?.platform === 'web' && String(manifest.exports?.['./client'] ?? '').includes('window/client.js'),
    `dsh.client=${JSON.stringify(manifest.dsh?.client ?? null)} · ./client=${String(manifest.exports?.['./client'] ?? 'ABSENT')}`)

  // ── 4. 每个声明的 exports 子路径都要能解析（清单直接来自 manifest） ────────
  const requireFromConsumer = createRequire(join(consumer, 'package.json'))
  const subpaths = Object.keys(manifest.exports ?? {}).filter((key) => key !== './package.json')
  const unresolved = []
  for (const subpath of subpaths) {
    const specifier = subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`
    try {
      requireFromConsumer.resolve(specifier)
    } catch (error) {
      unresolved.push(`${specifier} → ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  check('声明的每个 exports 子路径在安装态都能解析', unresolved.length === 0,
    unresolved.length === 0 ? `${subpaths.length} 条` : unresolved.join(' · '))
  const mustExport = ['./core', './window', './client', './viz/facility', './viz/model', './viz/mirror']
  const absent = mustExport.filter((key) => manifest.exports?.[key] === undefined)
  check('合并必需的四类 exports 都在（core / window / client / viz）', absent.length === 0,
    absent.join(', ') || mustExport.join(', '))

  // ── 5. loadVizLayer 必须走 package，且六个子路径全部可用 ───────────────────
  let hostViz = null
  let layer = null
  try {
    hostViz = await import(pathToFileURL(join(installed, 'window', 'src', 'host', 'viz.js')).href)
    layer = await hostViz.loadVizLayer()
  } catch (error) {
    check('loadVizLayer 能把 viz 层解析出来', false,
      `${error instanceof Error ? error.message : String(error)} —— bare specifier 与包内相对回退都没成功；对症查 exports 的 ./viz/* 与 files`)
  }
  if (layer !== null) {
    const members = ['DASHBOARD_SECTIONS', 'DIAGRAM_KINDS', 'buildDashboardModel', 'buildDiagramModel', 'buildFacilityModel',
      'FACILITY_VERSION', 'renderFrame', 'DIAGRAM_FORMATS', 'renderDiagram', 'REDACTION_LEVELS', 'DEFAULT_REDACTION',
      'looksLikeStore', 'readStoreMirror']
    const missingMembers = members.filter((key) => layer[key] === undefined)
    check("loadVizLayer 走安装形态（resolvedBy === 'package'）", layer.resolvedBy === 'package',
      layer.resolvedBy === 'package'
        ? 'resolvedBy=package'
        : `resolvedBy=${layer.resolvedBy} —— bare specifier 解析失败时会回退到包内相对路径，exports 缺项正是这种形状`)
    check('loadVizLayer 的 6 个子路径全部解析出函数/常量', missingMembers.length === 0,
      missingMembers.join(', ') || `parts=6 members=${members.length}`)
  }

  // ── 6. 装出来的 client 半仍是经典脚本，且 id 就是包名 ─────────────────────
  const clientSource = existsSync(join(installed, 'window', 'client.js'))
    ? readFileSync(join(installed, 'window', 'client.js'), 'utf8')
    : ''
  check('安装态的 client.js 以 ModuleLoader.load 开头，且 id 等于包名',
    clientSource.startsWith('/*') && clientSource.includes("window.__ModuleLoader__.load({")
    && clientSource.includes("id: 'dsh-anagenesis'"),
    clientSource === '' ? 'window/client.js 不在 tarball 里' : `bytes=${clientSource.length}`)

  // ── 7. 装出来的包对着空存储要给出正常回答（绝不碰真实存储） ───────────────
  if (hostViz === null || layer === null) {
    check('装出来的包对着空存储给出正常回答', false, 'loadVizLayer 没解析成功，无法构造 renderer（先修上面那条）')
  } else {
    const emptyRoot = join(temp, 'empty-store')
    mkdirSync(emptyRoot, { recursive: true })
    const renderer = hostViz.createRenderer({ rootDir: emptyRoot })
    const status = await renderer.status()
    check('空存储目录得到的是正常回答，不是抛错', status?.ok === true && status?.storeFound === false,
      `ok=${status?.ok} storeFound=${status?.storeFound} root=${status?.root}`)
    check('空存储回答里的 root 就是我们给的那个目录', resolve(String(status?.root ?? '')) === resolve(emptyRoot), String(status?.root))
    const facility = await renderer.facility({})
    check('安装态的 facility 方法给出空模型而不是抛错',
      facility?.ok === true && facility?.model?.kind === 'facility' && Array.isArray(facility.model.floors),
      `ok=${facility?.ok} kind=${facility?.model?.kind} floors=${facility?.model?.floors?.length}`)
  }
} catch (error) {
  check('gate 自身跑完', false, error instanceof Error ? error.message : String(error))
} finally {
  if (keep) console.log(`\n临时目录保留在 ${temp}`)
  else rmSync(temp, { recursive: true, force: true })
}

const failed = checks.filter((item) => item.ok !== true)
if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2))
} else {
  for (const item of checks) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.id}${item.ok ? '' : '  —— ' + item.detail}`)
  console.log(failed.length === 0
    ? `\n打包闸门：${checks.length}/${checks.length} 项通过（安装态加载与 exports 解析均已实测）`
    : `\n打包闸门：${failed.length}/${checks.length} 项未通过`)
}
process.exit(failed.length === 0 ? 0 : 1)
