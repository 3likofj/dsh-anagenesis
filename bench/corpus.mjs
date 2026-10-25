/**
 * Deterministic offline retrieval corpus.
 *
 * The benchmark exists because every score change in `memory/recall.js` is a
 * behaviour change, and "it feels better" is not a gate. The corpus is
 * synthetic on purpose: it needs no model, no network, no fixture files and no
 * personal data, and it must produce byte-identical numbers on every machine.
 *
 * Shape mirrors real usage rather than a tidy test fixture:
 *   - two projects + global + session records (scope isolation is measured,
 *     not assumed);
 *   - Chinese and English in the same store (the tokenizer is CJK-aware);
 *   - near-duplicates, supersession chains, contradictions, and paraphrases
 *     whose only overlap with the query is the domain word;
 *   - ~180 unrelated distractors so precision is actually tested.
 *
 * Gold grades: 2 = the record the question is about, 1 = useful context,
 * 0/absent = contamination when injected.
 * @module dsh-anagenesis/bench/corpus
 */

import { createMemory } from '../src/store/schema.js'
import { embed } from '../src/memory/embed.js'
import { emptyState } from '../src/store/schema.js'

export const NOW = Date.UTC(2026, 9, 25, 12, 0, 0)
export const DAY = 24 * 3600 * 1000

export const PROJECT_P1 = 'p1_bench_harness'
export const PROJECT_P2 = 'p2_bench_pipeline'
export const SESSION = 'sess_bench_1'

/**
 * @typedef {object} Topic
 * @property {string} key
 * @property {'fact'|'preference'|'procedure'|'heuristic'|'episode'|'hypothesis'|'constraint'|'failure'} kind
 * @property {'draft'|'active'|'verified'|'locked'|'deprecated'} state
 * @property {number} confidence
 * @property {number} salience
 * @property {'p1'|'p2'|'global'|'session'} scope
 * @property {number} ageDays
 * @property {string} subject
 * @property {string} body
 * @property {string} [gist]
 * @property {string[]} tags
 * @property {{rel: string, to: string}[]} [links] `to` is `topic:<key>`
 * @property {{id: string, intent: string, text: string, grade?: number, bucket?: string}[]} queries
 */

/** @type {Topic[]} */
export const TOPICS = [
  {
    key: 'build-cmd',
    kind: 'procedure',
    state: 'verified',
    confidence: 0.86,
    salience: 0.7,
    scope: 'p1',
    ageDays: 18,
    subject: '构建命令用 pnpm build，不要用 npm run build',
    body: '本仓库的 lockfile 是 pnpm-lock.yaml。用 npm run build 会重新解析依赖并生成 package-lock.json，导致 CI 上依赖版本漂移。\n构建顺序：pnpm build:client → pnpm check:window → pnpm test。',
    gist: '构建只用 pnpm build；npm run build 会污染 lockfile',
    tags: ['build', 'pnpm', 'ci'],
    queries: [
      { id: 'q-build-1', intent: 'reuse_procedure', text: '构建命令 用什么 pnpm build', grade: 2, bucket: 'exact' },
      { id: 'q-build-2', intent: 'orient', text: 'CI 里怎么 build 这个项目', grade: 2, bucket: 'paraphrase' },
    ],
  },
  {
    key: 'test-runner',
    kind: 'fact',
    state: 'verified',
    confidence: 0.8,
    salience: 0.5,
    scope: 'p1',
    ageDays: 40,
    subject: '单元测试用 node --test，文件在 test/*.test.js',
    body: '跑测试：npm test（内部是 node --import ./test/host-loader.mjs --test test/*.test.js）。窗口测试在 window/test/*.test.mjs，用 npm run test:window。不要写死单个测试文件名，闸门脚本要能吃通配。',
    gist: 'npm test = node --test test/*.test.js；窗口测试另跑',
    tags: ['test', 'node', 'gate'],
    queries: [
      { id: 'q-test-1', intent: 'recall_fact', text: '单元测试 怎么跑 test 命令', grade: 2, bucket: 'exact' },
      { id: 'q-test-2', intent: 'recall_fact', text: 'window 测试 用哪个脚本', grade: 2, bucket: 'paraphrase' },
    ],
  },
  {
    key: 'no-semicolon',
    kind: 'constraint',
    state: 'locked',
    confidence: 0.95,
    salience: 0.9,
    scope: 'p1',
    ageDays: 120,
    subject: '不写分号；行尾是 {…}/[…] 时下一行不能以 ( 或 [ 开头',
    body: '仓库风格：不加分号。ASI 会把 `const x = foo\\n(bar)` 粘成调用 —— 曾经因此炸掉全部含记录的 v2 文档。行尾是对象或数组字面量时，下一行必须以分号或独立语句开头。',
    gist: '无分号风格 + ASI 陷阱：{…} 换行后不能以 ( [ 开头',
    tags: ['style', 'asi', 'constraint'],
    queries: [
      { id: 'q-semi-1', intent: 'orient', text: '代码风格 分号 ASI 约束', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'gui-port',
    kind: 'fact',
    state: 'verified',
    confidence: 0.75,
    salience: 0.4,
    scope: 'p1',
    ageDays: 9,
    subject: '宿主 GUI 端口每次启动都变，从 profile 读，不要写死',
    body: 'DeepSeek Harness 的 GUI 地址形如 http://127.0.0.1:<端口>，端口每次启动都可能不同（见过 19387 / 57389 / 49933 / 56164）。探针脚本必须从运行时上下文或 profile 里取，写死端口会在下一次启动时静默失败。',
    gist: 'GUI 端口每次启动都变，从 profile 取',
    tags: ['host', 'gui', 'port'],
    queries: [
      { id: 'q-port-1', intent: 'recall_fact', text: '截图脚本 端口 从哪拿 GUI', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'npm-2fa',
    kind: 'failure',
    state: 'verified',
    confidence: 0.9,
    salience: 0.8,
    scope: 'p1',
    ageDays: 60,
    subject: 'npm publish 403：granular token 必须开 Bypass 2FA',
    body: '症状：npm publish 返回 403 Forbidden，但 npm whoami 和 --dry-run 都正常。根因：granular access token 没勾 Bypass 2FA。修复：重新签发 token 并勾选；发布凭据只放仓库外的临时 userconfig，用完即删。',
    gist: 'npm publish 403 而 whoami 正常 → token 没开 Bypass 2FA',
    tags: ['npm', 'publish', 'auth'],
    queries: [
      { id: 'q-2fa-1', intent: 'avoid_mistake', text: 'npm 发布 403 权限 失败', grade: 2, bucket: 'exact' },
      { id: 'q-2fa-2', intent: 'avoid_mistake', text: '发布时 token 被拒绝 怎么处理', grade: 2, bucket: 'paraphrase' },
    ],
  },
  {
    key: 'git-proxy',
    kind: 'procedure',
    state: 'verified',
    confidence: 0.72,
    salience: 0.4,
    scope: 'p1',
    ageDays: 25,
    subject: 'git push 直连常失败，走 127.0.0.1:7897 代理',
    body: '直接 git push 到 github 会超时。设置 http.proxy=http://127.0.0.1:7897（或 SSH over 7897）后可以推。代理只对本机有效，不要把代理写进仓库配置。',
    gist: 'git push 超时 → 用 127.0.0.1:7897 代理',
    tags: ['git', 'push', 'proxy'],
    queries: [
      { id: 'q-proxy-1', intent: 'reuse_procedure', text: 'git push 超时 代理', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'windows-npm',
    kind: 'heuristic',
    state: 'active',
    confidence: 0.6,
    salience: 0.35,
    scope: 'p1',
    ageDays: 33,
    subject: 'Windows 上给 shell 的 npm 命令不要加引号',
    body: 'cmd /c "npm" 会让 npm.cmd 里的 %~dp0 错位，脚本解析到错误的目录。直接写 npm（不带引号）即可。Node 里 "/tmp/x" 在 Windows 上是 D:\\tmp\\x，不是 MSYS 的 tmp。',
    gist: 'Windows: npm 命令别加引号；/tmp 是 D:\\tmp',
    tags: ['windows', 'npm', 'shell'],
    queries: [
      { id: 'q-winnpm-1', intent: 'recall_precedent', text: 'Windows 脚本 npm 引号 路径', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'snapshot-cache',
    kind: 'fact',
    state: 'verified',
    confidence: 0.82,
    salience: 0.5,
    scope: 'p1',
    ageDays: 15,
    subject: 'snapshot.json 只是缓存，删掉能从 journal 重建',
    body: '存储的真相是 journal-*.jsonl（追加日志）。snapshot.json 是加速启动的缓存，损坏或删除后下次启动会重放日志并重建，不会丢数据。compaction 只折叠 live 事件并追加 archive 段，既有段逐字节不改。',
    gist: 'journal 是唯一真相；snapshot.json 可删可重建',
    tags: ['storage', 'journal', 'snapshot'],
    queries: [
      { id: 'q-snap-1', intent: 'recall_fact', text: 'snapshot 删了 数据 还在吗 journal', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'mutex-deadlock',
    kind: 'failure',
    state: 'verified',
    confidence: 0.88,
    salience: 0.75,
    scope: 'p1',
    ageDays: 70,
    subject: '单写 Mutex 持锁区内再调 store.audit/transact 会死锁',
    body: 'compaction 与 transact 共用同一把单写锁。持锁区内调用 store.audit() 会等待自己已经持有的锁，进程挂住且没有任何日志。正确做法：审计行必须在释放单写锁之后再写。',
    gist: '持锁区里不要调 audit/transact（自锁死锁）',
    tags: ['storage', 'mutex', 'deadlock'],
    queries: [
      { id: 'q-dead-1', intent: 'avoid_mistake', text: '死锁 锁 里 调 audit', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'css-owner',
    kind: 'constraint',
    state: 'locked',
    confidence: 0.93,
    salience: 0.85,
    scope: 'p1',
    ageDays: 88,
    subject: '渲染层只有一个样式所有者 ANA_CSS，产出的每个 class 都要有规则',
    body: '样式双所有者曾让仪表盘退化成标签堆叠而 72 个测试全绿。现在 ANA_CSS 是唯一那份样式，styles.test 逐 class 校验：模型里出现的 class 必须有对应规则。改渲染层必须过截图闸门。',
    gist: 'ANA_CSS 唯一；每个 class 必须有规则；改渲染过截图',
    tags: ['render', 'css', 'test'],
    queries: [
      { id: 'q-css-1', intent: 'orient', text: '改样式 渲染层 约束 class', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'pointer-events',
    kind: 'failure',
    state: 'verified',
    confidence: 0.85,
    salience: 0.6,
    scope: 'p1',
    ageDays: 95,
    subject: 'shell.overlay 是 click-through，窗口必须声明 pointer-events:auto',
    body: '窗口挂载在宿主 overlay 上，那层默认 pointer-events:none。不显式给根节点 pointer-events:auto 的话，窗口能看见但拖不动、点不了，而且没有任何报错。',
    gist: 'overlay click-through → 根节点要 pointer-events:auto',
    tags: ['window', 'css', 'overlay'],
    queries: [
      { id: 'q-pe-1', intent: 'avoid_mistake', text: '窗口 拖不动 点击 无效 overlay', grade: 2, bucket: 'paraphrase' },
    ],
  },
  {
    key: 'react-onchange',
    kind: 'heuristic',
    state: 'active',
    confidence: 0.65,
    salience: 0.4,
    scope: 'p1',
    ageDays: 50,
    subject: 'dangerouslySetInnerHTML 注入的控件不触发 React onChange',
    body: '用 innerHTML 注入的表单控件不受 React 合成事件管理，onChange 永远不触发。解法：在根节点做原生事件委托，用 data-ana-action / data-ana-field 标记。',
    gist: 'innerHTML 控件不走 React 事件 → 根节点原生委托',
    tags: ['react', 'events', 'window'],
    queries: [
      { id: 'q-react-1', intent: 'recall_precedent', text: 'React onChange 不触发 注入 控件', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'cjk-width',
    kind: 'procedure',
    state: 'verified',
    confidence: 0.78,
    salience: 0.45,
    scope: 'p1',
    ageDays: 44,
    subject: 'CJK 宽度用 displayWidth，不用 string.length',
    body: '中文按 2 列宽计算，length 会把一行中文算短，导致终端表格错位。上色必须在补白之后做，否则 ANSI 转义序列会被计入宽度。',
    gist: 'CJK 宽度用 displayWidth；上色在补白之后',
    tags: ['terminal', 'width', 'cjk'],
    queries: [
      { id: 'q-cjk-1', intent: 'reuse_procedure', text: '中文 终端 对齐 宽度', grade: 2, bucket: 'paraphrase' },
    ],
  },
  {
    key: 'pack-gate',
    kind: 'fact',
    state: 'active',
    confidence: 0.7,
    salience: 0.3,
    scope: 'p1',
    ageDays: 22,
    subject: 'gate:pack 会真打包真安装，很慢但必须跑',
    body: 'checkout 里 loadVizLayer 的相对回退恰好存在，所以 exports 缺项时本地全绿、装成包才炸。gate:pack 真的 npm pack + 安装到临时目录，是唯一能发现这类问题的闸门。',
    gist: 'gate:pack 真打包真安装；exports 缺项只有它能抓',
    tags: ['build', 'gate', 'pack'],
    queries: [
      { id: 'q-pack-1', intent: 'orient', text: '发布前 打包 检查 exports', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'preset-broken',
    kind: 'failure',
    state: 'verified',
    confidence: 0.87,
    salience: 0.7,
    scope: 'p1',
    ageDays: 16,
    subject: '预设激活失败不抛错，只记 broken + 页面 warn',
    body: 'preset registry 的激活失败不会向上抛，日志里也没有。表现是"工具一个都不在"。排查要看预设状态里的 broken 标记和页面警告，而不是等异常。',
    gist: '预设激活失败静默 → 看 broken + 页面 warn',
    tags: ['preset', 'debug', 'host'],
    queries: [
      { id: 'q-preset-1', intent: 'avoid_mistake', text: '预设 没生效 工具 消失 broken', grade: 2, bucket: 'paraphrase' },
    ],
  },
  {
    key: 'effect-return',
    kind: 'constraint',
    state: 'locked',
    confidence: 0.94,
    salience: 0.8,
    scope: 'p1',
    ageDays: 110,
    subject: 'apply 只能返回 void 或 disposer，返回对象会 TypeError 并回滚整个函数体',
    body: 'cordis 把 apply 的返回值当 effect：函数是 disposer，null/undefined 通过，其它对象直接抛 Invalid effect 并回滚。症状是"什么都没发生"：行永久 pending、工具 0 个、没有日志。',
    gist: 'apply 返回非函数对象 = Invalid effect + 静默回滚',
    tags: ['cordis', 'plugin', 'effect'],
    queries: [
      { id: 'q-effect-1', intent: 'orient', text: '插件 apply 返回 值 effect 约束', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'client-single-source',
    kind: 'constraint',
    state: 'verified',
    confidence: 0.83,
    salience: 0.55,
    scope: 'p1',
    ageDays: 75,
    subject: '同一包名只能有一个活跃 client source',
    body: 'client-modules 按包名去重：同包的子路径 specifier 不算新 source，所以一个包六个 Loader 行合法，但裸包名只能出现一次。任一 client 条目非 ACTIVE 会让整页 boot 失败，因此插件的 client inject 必须为空。',
    gist: '一个包只能有一个 client source；inject 必须为空',
    tags: ['client', 'plugin', 'host'],
    queries: [
      { id: 'q-client-1', intent: 'recall_fact', text: 'client source 包名 只能一个', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'publish-cred',
    kind: 'procedure',
    state: 'verified',
    confidence: 0.8,
    salience: 0.5,
    scope: 'p1',
    ageDays: 28,
    subject: 'npm 凭据只经仓库外的临时 userconfig 传入',
    body: '发布凭据写进 %LOCALAPPDATA%\\Temp 下的临时 .npmrc，chmod 600，用完立即删除。仓库、.npmrc、remote 和 git config 里都不留 token。凭据被拒绝时先查 token 类型，再查 2FA 设置。',
    gist: '发布凭据走仓库外临时 userconfig，用完即删',
    tags: ['npm', 'publish', 'secret'],
    queries: [
      { id: 'q-cred-1', intent: 'reuse_procedure', text: '发布凭据 token 放哪里 userconfig', grade: 2, bucket: 'exact' },
      // Paraphrase with no lexical overlap with the *gold* record: this is the
      // case graph expansion exists for. `publish-cred` is graded 1 (useful
      // context) and links to `npm-2fa` (graded 2) with `related`.
      { id: 'q-cred-2', intent: 'verify', text: '凭据 被拒绝 怎么办', grade: 1, bucket: 'graph', extraGold: { 'mem_npm-2fa': 2 } },
    ],
  },
  {
    key: 'release-flow',
    kind: 'procedure',
    state: 'verified',
    confidence: 0.8,
    salience: 0.5,
    scope: 'p1',
    ageDays: 30,
    subject: '发版流程：升版本 → CHANGELOG → 全闸门 → publish → push + release',
    body: '1) package.json 升版本；2) CHANGELOG 写新增/变更/修复（破坏性标出来）；3) 跑 test / check / verify:boot / gate:window / preflight / gate:pack；4) npm publish（临时 userconfig，用完删）；5) git push 走代理并建 GitHub release。',
    gist: '发版五步：版本、CHANGELOG、闸门、publish、push+release',
    tags: ['release', 'npm', 'process'],
    queries: [
      { id: 'q-release-1', intent: 'reuse_procedure', text: '发版 步骤 publish changelog', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'py-version',
    kind: 'fact',
    state: 'verified',
    confidence: 0.78,
    salience: 0.4,
    scope: 'p2',
    ageDays: 12,
    subject: 'Pipeline 用 Python 3.12 + uv 管理依赖',
    body: '不要用 pip install 直接装；所有依赖写进 pyproject.toml，用 uv sync 生成 uv.lock。CI 镜像固定 3.12。',
    gist: 'Python 3.12 + uv sync（不要 pip install）',
    tags: ['python', 'uv', 'env'],
    queries: [
      { id: 'q-py-1', intent: 'recall_fact', text: 'python 依赖 怎么装 uv', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'avro-schema',
    kind: 'constraint',
    state: 'locked',
    confidence: 0.9,
    salience: 0.7,
    scope: 'p2',
    ageDays: 55,
    subject: 'Avro schema 放 schema/，改字段必须升版本',
    body: 'schema registry 拒绝不兼容变更。新增字段必须带 default；删除字段先标 deprecated 并等两个版本。',
    gist: 'Avro 改字段必须升版本 + default',
    tags: ['avro', 'schema', 'pipeline'],
    queries: [
      { id: 'q-avro-1', intent: 'orient', text: 'Avro schema 改字段 兼容', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'airflow-tz',
    kind: 'procedure',
    state: 'verified',
    confidence: 0.74,
    salience: 0.35,
    scope: 'p2',
    ageDays: 38,
    subject: 'DAG 在 dags/，调度时区统一 UTC',
    body: '所有 DAG 的 schedule 用 UTC，禁止本地时区；需要本地时间时在 SQL 里转换。dag_id 前缀是团队名。',
    gist: 'DAG 调度统一 UTC，dag_id 带团队前缀',
    tags: ['airflow', 'dag', 'timezone'],
    queries: [
      { id: 'q-air-1', intent: 'reuse_procedure', text: 'airflow 调度 时区 dag', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'bigquery-cost',
    kind: 'heuristic',
    state: 'active',
    confidence: 0.62,
    salience: 0.4,
    scope: 'p2',
    ageDays: 20,
    subject: 'BigQuery 按扫描量计费：先加 partition filter 再跑',
    body: '不带 partition filter 的查询会扫全表，单个 DAG 一晚上能烧掉几百美元。先在 EXPLAIN 里看扫描量，再决定是否全量。',
    gist: 'BigQuery 先加 partition filter，否则烧钱',
    tags: ['bigquery', 'cost', 'sql'],
    queries: [
      { id: 'q-bq-1', intent: 'recall_precedent', text: 'BigQuery 查询 费用 很高 分区', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'pref-language',
    kind: 'preference',
    state: 'active',
    confidence: 0.7,
    salience: 0.6,
    scope: 'global',
    ageDays: 140,
    subject: '用户偏好中文回复，技术名词保留英文',
    body: '默认用中文回答；命令、代码、API 名、错误信息保持原文。不要为了"本地化"翻译标识符。',
    gist: '中文回复，术语保留英文',
    tags: ['preference', 'language'],
    queries: [
      { id: 'q-lang-1', intent: 'orient', text: '回复 语言 偏好', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'windows-host',
    kind: 'fact',
    state: 'verified',
    confidence: 0.76,
    salience: 0.5,
    scope: 'global',
    ageDays: 100,
    subject: '宿主是 Windows：路径用反斜杠，/tmp 实际是 D:\\tmp',
    body: 'Node 里 "/tmp/x" 解析到 D:\\tmp\\x。PowerShell 的变量名大小写不敏感，不要用 $home 之类的自动变量名。',
    gist: 'Windows 宿主：/tmp = D:\\tmp，注意自动变量名',
    tags: ['windows', 'path', 'host'],
    queries: [
      { id: 'q-winhost-1', intent: 'recall_fact', text: 'Windows 路径 tmp 反斜杠', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'offline-policy',
    kind: 'constraint',
    state: 'locked',
    confidence: 0.92,
    salience: 0.8,
    scope: 'global',
    ageDays: 130,
    subject: '插件默认离线：唯一网络出口是版本检查（默认 off）',
    body: '不改 cloud 声明、不加遥测、不下载模型。版本检查只 GET registry.npmjs.org 的 latest，不带标识，不自动安装。任何新增网络行为都要同步 disclosure.network 与 README。',
    gist: '默认离线；唯一网络出口是版本检查',
    tags: ['privacy', 'network', 'constraint'],
    queries: [
      { id: 'q-offline-1', intent: 'orient', text: '网络 请求 隐私 离线 约束', grade: 2, bucket: 'exact' },
    ],
  },
  {
    key: 'session-031',
    kind: 'episode',
    state: 'active',
    confidence: 0.6,
    salience: 0.3,
    scope: 'session',
    ageDays: 1,
    subject: '本次会话在排查 0.3.1 更新提示到不了界面的问题',
    body: 'provider 引用闭包变量被吞成 null，仪表盘拿不到更新状态。修复是传函数而不是值，并补一条"从入口到输出"的接线测试。',
    gist: '0.3.1 更新提示断线：provider 闭包变量被吞成 null',
    tags: ['session', 'debug', 'update'],
    queries: [
      { id: 'q-session-1', intent: 'recall_precedent', text: '更新提示 界面 不显示 provider', grade: 2, bucket: 'exact' },
    ],
  },
]

/**
 * Records that exist to be *rejected*: same topic as a gold record, but stale,
 * duplicated or superseded. Grade 0 in every gold map.
 */
export const TRAPS = [
  {
    key: 'dupe-old',
    kind: 'procedure',
    state: 'active',
    confidence: 0.55,
    salience: 0.4,
    scope: 'p1',
    ageDays: 150,
    subject: '构建命令用 npm run build',
    body: '旧的构建说明，已经被 pnpm 方案取代。',
    gist: 'npm run build 构建',
    tags: ['build', 'npm'],
  },
  {
    key: 'supersede-old',
    kind: 'constraint',
    state: 'active',
    confidence: 0.6,
    salience: 0.5,
    scope: 'p1',
    ageDays: 200,
    subject: '发布前只需跑 npm test，不需要门禁',
    body: '旧约定：测试过了就能发。',
    gist: '发布前只跑 npm test',
    tags: ['release', 'gate'],
  },
  {
    key: 'supersede-new',
    kind: 'constraint',
    state: 'verified',
    confidence: 0.9,
    salience: 0.8,
    scope: 'p1',
    ageDays: 20,
    subject: '发布前必须跑全部闸门，单跑 npm test 不算',
    body: '0.3.1 的接线缺陷就是单跑测试漏掉的：118 个测试全绿，真机不工作。现在发布前跑 test / check / verify:boot / gate:window / preflight / gate:pack。',
    gist: '发布前跑全部闸门，不能只跑 npm test',
    tags: ['release', 'gate'],
  },
  {
    key: 'conflict-p2',
    kind: 'constraint',
    state: 'verified',
    confidence: 0.8,
    salience: 0.6,
    scope: 'p2',
    ageDays: 25,
    subject: 'Pipeline 里必须用 pip install 装依赖',
    body: '另一个项目的约定，与本项目相反。',
    gist: 'pipeline 用 pip install',
    tags: ['python', 'pip'],
  },
]

const DISTRACTOR_THEMES = [
  { subject: 'CSS 变量命名统一用 --ana- 前缀', kind: 'constraint', tags: ['css', 'naming'] },
  { subject: '图表缩放用 LANCZOS 而不是 bilinear', kind: 'heuristic', tags: ['image', 'resize'] },
  { subject: '日志轮转保留 7 天', kind: 'fact', tags: ['log', 'ops'] },
  { subject: 'HTTP 缓存头对静态资源设一年', kind: 'fact', tags: ['http', 'cache'] },
  { subject: '数据库连接池上限 20', kind: 'fact', tags: ['database', 'pool'] },
  { subject: '错误信息里不要包含 token', kind: 'constraint', tags: ['security', 'log'] },
  { subject: '前端包体积超过 300KB 要拆分', kind: 'heuristic', tags: ['bundle', 'perf'] },
  { subject: 'SQL 查询必须先 EXPLAIN', kind: 'procedure', tags: ['sql', 'perf'] },
  { subject: '时区统一存 UTC，展示时转换', kind: 'constraint', tags: ['time', 'storage'] },
  { subject: 'API 分页默认 20 条', kind: 'fact', tags: ['api', 'pagination'] },
  { subject: '单元测试不要 sleep，用假时钟', kind: 'heuristic', tags: ['test', 'clock'] },
  { subject: '备份每天凌晨跑一次', kind: 'fact', tags: ['backup', 'ops'] },
  { subject: '配置文件不要提交密钥', kind: 'constraint', tags: ['config', 'secret'] },
  { subject: 'UI 文案要中英双语', kind: 'preference', tags: ['i18n', 'ui'] },
  { subject: '依赖升级一次只升一个', kind: 'heuristic', tags: ['deps', 'upgrade'] },
]

/** Deterministic pseudo-random (mulberry32) — the corpus must not drift. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * @param {number} [now]
 * @returns {{ state: any, now: number }}
 */
export function buildBenchStore(now = NOW) {
  const state = emptyState(now)
  const random = rng(20261025)
  /** @type {Record<string, string>} */
  const ids = {}

  /**
   * @param {any} spec
   * @param {string} id
   * @param {{ projectId?: string|null, scope?: 'p1'|'p2'|'global'|'session' }} where
   */
  const add = (spec, id, where) => {
    const scope = where.scope === 'global'
      ? { tier: 'global' }
      : where.scope === 'session'
        ? { tier: 'session', session: SESSION, projectId: PROJECT_P1 }
        : { tier: 'project', projectId: where.scope === 'p2' ? PROJECT_P2 : PROJECT_P1 }
    const age = (spec.ageDays ?? 10) * DAY
    const record = createMemory({
      ...spec,
      id,
      links: [],
      scope,
      provenance: { source: 'bench', evidence: ['bench://corpus'] },
    }, {
      now,
      embed,
      defaultScope: { tier: 'project', projectId: PROJECT_P1 },
      sessionId: where.scope === 'session' ? SESSION : null,
    })
    record.createdAt = now - age
    record.updatedAt = now - age
    record.confirmedAt = now - age
    state.memories[id] = record
    return record
  }

  for (const topic of TOPICS) {
    add({
      kind: topic.kind,
      state: topic.state,
      confidence: topic.confidence,
      salience: topic.salience,
      subject: topic.subject,
      body: topic.body,
      gist: topic.gist ?? topic.subject,
      tags: topic.tags,
      ageDays: topic.ageDays,
    }, `mem_${topic.key}`, { scope: topic.scope })
    ids[topic.key] = `mem_${topic.key}`
  }

  for (const trap of TRAPS) {
    add(trap, `mem_${trap.key}`, { scope: trap.scope })
    ids[trap.key] = `mem_${trap.key}`
  }

  // Distractors: 180 records across both projects and global. They share
  // ordinary engineering words with the real topics on purpose — precision is
  // only meaningful when the noise is plausible.
  const scopes = /** @type {const} */ (['p1', 'p2', 'global'])
  for (let i = 0; i < 180; i++) {
    const theme = DISTRACTOR_THEMES[i % DISTRACTOR_THEMES.length]
    const where = scopes[Math.floor(random() * scopes.length)]
    const id = `mem_d_${String(i + 1).padStart(3, '0')}`
    add({
      kind: theme.kind,
      state: random() < 0.15 ? 'draft' : random() < 0.7 ? 'active' : 'verified',
      confidence: 0.35 + random() * 0.5,
      salience: 0.2 + random() * 0.5,
      subject: `${theme.subject}（${i + 1}）`,
      body: `这是第 ${i + 1} 条无关记录，主题是 ${theme.subject}。它存在的目的是给检索制造合理的噪声。`,
      gist: `${theme.subject} #${i + 1}`,
      tags: [...theme.tags, `n${i % 7}`],
      ageDays: Math.floor(random() * 180),
    }, id, { scope: where })
  }

  // Structural edges: supersession + two typed bridges that graph expansion is
  // supposed to walk.
  state.memories[ids['supersede-new']].links.push({ rel: 'supersedes', to: ids['supersede-old'] })
  state.memories[ids['supersede-old']].links.push({ rel: 'superseded_by', to: ids['supersede-new'] })
  state.memories[ids['supersede-new']].supersedes = [ids['supersede-old']]
  state.memories[ids['supersede-old']].supersededBy = ids['supersede-new']
  // Credential handling -> why publishing fails. One hop, different wording.
  state.memories[ids['publish-cred']].links.push({ rel: 'related', to: ids['npm-2fa'] })
  state.memories[ids['npm-2fa']].links.push({ rel: 'caused_by', to: ids['publish-cred'] })
  // A constraint that a procedure depends on: retrieving the procedure should
  // surface the constraint it must obey.
  state.memories[ids['release-flow']].links.push({ rel: 'part_of', to: ids['pack-gate'] })

  state.version = 1
  state.stats.recalls = 0
  return { state, now }
}
