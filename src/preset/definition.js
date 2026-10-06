/**
 * The `anagenesis` agent preset definition — one source of truth, two forms.
 *
 * Hosts differ in how a preset exists:
 *   - current DSH publishes an `agentPresets` service whose `register(definition)`
 *     takes `{ id, name, description, order, plugins: EntryList }` and returns an
 *     unregister disposer (verified against @deepseek-ai/dsh-agent-preset-registry
 *     0.2.0-rc.2);
 *   - older 0.1.5/0.1.6 hosts scan `$DSH_HOME/.agent-presets/<id>/` for
 *     `preset.yml` + a composition file.
 * Both are generated from this module, so the tool set, the persona and the
 * default strategy stack are identical either way.
 *
 * The preset↔tool binding is worth being explicit about, because it is two
 * different mechanisms:
 *   1. **Which tools exist** is compositional: the `plugins` list below mounts
 *      exactly the tool rows this preset gets. There is no runtime mask.
 *   2. **Behaving like an anagenesis agent** is runtime and reversible: the
 *      `anagenesis-preset-bind` row activates the default strategy stack and, on
 *      agent-scoped hosts, may narrow tools via `ctx.tools.restrict()`.
 * @module dsh-anagenesis/preset/definition
 */

import { PERSONA, OPERATING_NOTES } from './persona.js'

export const PRESET_ID = 'anagenesis'

export const META = Object.freeze({
  name: 'Anagenesis 自进化 Agent',
  description: '自进化 Agent：自带可编程记忆库（按意图召回、提交、提升、降级、拆分、锁定、过期淘汰、反事实重思），'
    + '注入策略可在运行时切换（explore / exploit / debug / distill），并能依据自身结果做元策略调参，'
    + '带审计与回滚，外加一道单调收紧的安全护栏。不依赖任何外部记忆插件。',
  order: 7,
})

/** The stack the preset activates on boot. `guard` is invariant and always kept. */
export const DEFAULT_PRESET_STACK = Object.freeze(['guard', 'exploit'])

/**
 * The optional visualization-window capability, as a fact the preset publishes.
 *
 * `mountedByPreset: false` is the load-bearing field and it is not a default that
 * someone may flip: `dsh-anagenesis-window` declares `dsh.client`, and a package
 * with a client half may own exactly ONE active Loader row — while this preset
 * mounts five rows of `dsh-anagenesis` in its own scope. Adding a sixth row for the
 * window would make the whole composition fail to boot (HANDOFF §10.14).
 *
 * So the preset is *aware* and does not *enable*: the capability is described in
 * the persona text as a conditional (see `WINDOW_ENTRY_NOTES`) and the tool it
 * brings (`ana_window`) exists exactly when the profile mounted the row.
 * @type {{ id: string, packageName: string, tool: string, entries: readonly string[], mountedByPreset: false, requiresRow: string }}
 */
export const WINDOW_CAPABILITY = Object.freeze({
  id: 'visualization-window',
  packageName: 'dsh-anagenesis-window',
  tool: 'ana_window',
  // Three seats, not four: the operator asked for the better-sidebar bottom
  // workbench row to be removed. The remaining seats are the better-sidebar row
  // (or the official left column as an opt-in fallback), the official right
  // sidebar, and the conversation/Trajectory header.
  entries: Object.freeze([
    'better-sidebar-row',
    'official-right-sidebar',
    'conversation-header',
  ]),
  mountedByPreset: false,
  requiresRow: 'dsh-anagenesis-window',
})

/**
 * The rows this preset would need to mount the window — exported so a profile that
 * *does* want it can compose the one row explicitly without guessing, and so a test
 * can assert the preset's own composition never contains it.
 * @returns {any[]}
 */
export function windowRow() {
  return [{ id: 'anagenesis-window', name: WINDOW_CAPABILITY.packageName }]
}

/**
 * Tool rows shared with the stock harness presets. Kept deliberately to rows
 * that exist across the 0.1.x–0.2.x line: persona, instructions, shell, fs,
 * search, jobs, skills, goals, todo, ask-user, web.
 * @param {{ platform?: string, webFetch?: boolean }} [opts]
 */
export function baseToolRows(opts = {}) {
  const platform = opts.platform ?? (typeof process !== 'undefined' ? process.platform : 'linux')
  return [
    // `@deepseek-ai/dsh-persona` is scope-only, and its real schema is
    // `{ prefix (required), suffix, complete, includeRuntimeContext }` — read off
    // the running host's implementation, not guessed. There is no `text` key:
    // passing one *and* omitting the required `prefix` made config validation
    // throw, which failed the whole preset's activation (the roster showed
    // `Anagenesis 自进化 Agent` as broken). The preset identity goes in `prefix`
    // and the operating notes in `suffix`, which is exactly the two sections the
    // row owns.
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: PERSONA, suffix: OPERATING_NOTES } },
    // `maxBytes` is the one required key here. `@deepseek-ai/dsh-agent-instructions`
    // discovers instruction *files*; it has no inline-text config, which is why
    // there is no second row feeding it OPERATING_NOTES.
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },

    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: platform === 'win32' },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: platform !== 'win32' },

    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },

    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },

    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: opts.webFetch ?? false, searchTimeoutMs: 60000 } },
  ]
}

/**
 * The anagenesis rows of the preset: service, tools, guard, visualization, and the
 * bind row.
 *
 * The visualization row is part of the composition so a preset session can *call*
 * `ana_dashboard` / `ana_diagram` — but it is not "on" in any stronger sense:
 * the row registers two read-only tools and starts no timers, no watcher and no
 * writes of its own. A host that wants visualization gone disables this single
 * row; the memory layer never notices.
 * @param {{ stack?: string[], tokenBudget?: number }} [opts]
 */
export function anagenesisRows(opts = {}) {
  return [
    // Mounts the core row. Safe to mount here even when the profile bundle
    // already mounts it globally: MemoryStore.acquire() is reference counted per
    // rootDir, so both rows share one writer instead of racing on the journal.
    { id: 'anagenesis-core', name: 'dsh-anagenesis' },
    { id: 'anagenesis-tools', name: 'dsh-anagenesis/tools' },
    { id: 'anagenesis-guard', name: 'dsh-anagenesis/guard' },
    { id: 'anagenesis-viz', name: 'dsh-anagenesis/viz' },
    {
      id: 'anagenesis-preset-bind',
      name: 'dsh-anagenesis/preset-bind',
      config: {
        stack: opts.stack ?? [...DEFAULT_PRESET_STACK],
        tokenBudget: opts.tokenBudget ?? 1600,
      },
    },
  ]
}

/**
 * Build the preset definition handed to `agentPresets.register()`.
 * @param {{ id?: string, platform?: string, stack?: string[], tokenBudget?: number, extraPlugins?: any[] }} [opts]
 * @returns {{ id: string, name: string, description: string, order: number, plugins: any[] }}
 */
export function anagenesisPreset(opts = {}) {
  return {
    id: opts.id ?? PRESET_ID,
    name: META.name,
    description: META.description,
    order: META.order,
    plugins: [
      ...baseToolRows(opts),
      ...anagenesisRows(opts),
      ...(opts.extraPlugins ?? []),
    ],
  }
}

/**
 * Serialize the directory-install form. Hand-rolled YAML (not js-yaml) because
 * this package must stay dependency-free: the subset used here is plain
 * sequences/mappings of scalars, which is exactly what the roster scans.
 * @param {ReturnType<typeof anagenesisPreset>} definition
 * @returns {{ presetYaml: string, compositionYaml: string }}
 */
export function toDirectoryForm(definition) {
  const presetYaml = [
    `name: ${yamlScalar(definition.name)}`,
    `description: ${yamlScalar(definition.description)}`,
    `order: ${definition.order}`,
    '',
  ].join('\n')
  const compositionYaml = [`# Generated by dsh-anagenesis from src/preset/definition.js — do not hand-edit.`]
  for (const row of definition.plugins) {
    compositionYaml.push(`- id: ${yamlScalar(row.id)}`)
    compositionYaml.push(`  name: ${yamlScalar(row.name)}`)
    if (row.disabled === true) compositionYaml.push('  disabled: true')
    if (row.config !== undefined) {
      const config = JSON.stringify(row.config)
      compositionYaml.push(`  config: ${config}`)
    }
  }
  compositionYaml.push('')
  // Join here, not at the write site: `fs.writeFile` accepts an iterable and
  // would otherwise write every line concatenated with no separators.
  return { presetYaml, compositionYaml: compositionYaml.join('\n') }
}

/**
 * @param {string} value
 * @returns {string}
 */
function yamlScalar(value) {
  const text = String(value)
  if (text.includes('\n')) {
    return `|-\n${text.split('\n').map((line) => `  ${line}`).join('\n')}`
  }
  return /^[A-Za-z0-9 .,:/_@-]+$/.test(text) ? text : JSON.stringify(text)
}
