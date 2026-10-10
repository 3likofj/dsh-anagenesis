/**
 * anagenesis-preset — auto-registers the `anagenesis` agent preset.
 *
 * Two host shapes, one definition:
 *   - DSH 0.1.7+ (verified on 0.2.0-rc.2): the `agentPresets` service exposes
 *     `register(definition)` and returns an unregister disposer. That promise
 *     *is* the effect body, so `ctx.effect(() => registry.register(def))` gives
 *     the preset exactly the plugin fiber's lifetime — "the preset itself is
 *     revertible" is not a promise here, it is the primitive.
 *   - older hosts: the roster scans `$DSH_HOME/.agent-presets/<id>/`, so the row
 *     writes the generated `preset.yml` + composition there and removes exactly
 *     the two files it created on unload (local edits are never overwritten).
 *
 * The capability probe is `typeof registry.register === 'function'`, not "the
 * service exists": the older line also publishes an `agentPresets` service with
 * a different surface, so existence answers the wrong question.
 * @module dsh-anagenesis/preset
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

import { PRESET_ID, anagenesisPreset, toDirectoryForm } from './definition.js'

export const name = 'anagenesis-preset'

/**
 * Soft dependency: `agentPresets` is not guaranteed on every DSH line, and a
 * preset installer must never hold up the boot waiting for an optional service.
 * The row therefore uses a non-strict read and falls back to the directory form.
 */
export const inject = []

export const Config = Schema.object({
  presetIds: Schema.array(Schema.string()).default([PRESET_ID])
    .description('要注册的预设 id；本包只定义 anagenesis 这一个，其它 id 会被跳过并记一条 warning。'),
  autoInstallDirectoryForm: Schema.boolean().default(true)
    .description('是否同时写 $DSH_HOME/.agent-presets/ 的目录形式。只对仍从目录发现预设的旧宿主有意义；卸载时会删掉自己写的那些文件。'),
  stack: Schema.array(Schema.string()).default(['guard', 'exploit'])
    .description('预设绑定的策略栈。'),
  tokenBudget: Schema.number().default(1600)
    .description('预设的召回 token 预算，会写进 store 的对应参数。'),
  gear: Schema.string().default('assisted')
    .description('预设的权限档位：passive=只读（不注册写入工具）| assisted=可写 | autonomous=可写且可自动调度。'),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 *
 * Returns nothing on purpose. Cordis collects an `apply` result as an effect and
 * rejects a plain object with `TypeError: Invalid effect` (see the note in
 * src/index.js); an async row that returns a status object tears its own fibre
 * down after the body ran. Outcomes are observable through the logger, the
 * preset roster and the filesystem instead.
 */
export async function apply(ctx, config = {}) {
  const logger = ctx.logger
  const wanted = (config.presetIds ?? [PRESET_ID]).filter((id) => {
    if (id === PRESET_ID) return true
    logger?.warn?.(`anagenesis-preset: only the "${PRESET_ID}" preset is defined by this package; skipping "${id}"`)
    return false
  })

  const declared = definePresets(wanted, config, logger)
  const registry = readRegistry(ctx)
  if (hasPresetRegistry(registry)) {
    registerThroughService(ctx, registry, declared, logger)
    return
  }

  // The service can publish *after* this row applies (the registry row is
  // mounted late on some DSH lines and initialises asynchronously). A one-shot
  // probe would then silently drop the preset, so bind reactively instead:
  // `ctx.inject` starts a child plugin the moment `agentPresets` appears, and
  // the registration still inherits this plugin's fibre lifetime.
  const reactive = bindReactive(ctx, config, wanted, logger)
  const installed = config.autoInstallDirectoryForm === false
    ? []
    : await installDirectories(wanted, config, logger)
  if (reactive && installed.length === 0) {
    logger?.info?.('anagenesis-preset: agentPresets not present yet; waiting for it to appear (reactive bind)')
  }
}

/**
 * @param {string[]} ids
 * @param {any} config
 * @param {any} logger
 * @returns {{ definition: any }[]}
 */
function definePresets(ids, config, logger) {
  return ids.map((id) => ({
    definition: anagenesisPreset({
      stack: config.stack,
      tokenBudget: config.tokenBudget,
      gear: config.gear,
      extraPlugins: config.extraPlugins,
      id,
    }),
  }))
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} registry
 * @param {{ definition: any }[]} declared
 * @param {any} logger
 */
function registerThroughService(ctx, registry, declared, logger) {
  for (const { definition } of declared) {
    // `register()` returns the unregister disposer, which is exactly what an
    // effect body may return — the preset lives and dies with this fibre.
    ctx.effect(() => registry.register(definition))
    logger?.info?.(`anagenesis-preset: registered agent preset "${definition.id}" (${definition.plugins.length} rows)`)
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 * @param {string[]} ids
 * @param {any} logger
 * @returns {boolean} whether a reactive bind was installed
 */
function bindReactive(ctx, config, ids, logger) {
  if (typeof ctx.inject !== 'function') return false
  try {
    ctx.inject(['agentPresets'], (scoped) => {
      const registry = typeof scoped.get === 'function' ? scoped.get('agentPresets', false) : undefined
      if (!hasPresetRegistry(registry)) {
        logger?.warn?.('anagenesis-preset: agentPresets appeared without register(); the preset is not installed')
        return
      }
      registerThroughService(scoped, registry, definePresets(ids, config, logger), logger)
    })
    return true
  } catch (error) {
    logger?.warn?.(`anagenesis-preset: reactive bind failed (${error instanceof Error ? error.message : String(error)})`)
    return false
  }
}

/**
 * @param {string[]} ids
 * @param {any} config
 * @param {any} logger
 * @returns {Promise<any[]>}
 */
async function installDirectories(ids, config, logger) {
  const installed = []
  for (const id of ids) {
    installed.push(await installPresetDirectory({
      id,
      definition: anagenesisPreset({ stack: config.stack, tokenBudget: config.tokenBudget, gear: config.gear, id }),
      log: (message) => logger?.info?.(message),
      warn: (message) => logger?.warn?.(message),
    }))
  }
  return installed
}

/**
 * @param {unknown} registry
 * @returns {boolean}
 */
export function hasPresetRegistry(registry) {
  return registry !== null
    && typeof registry === 'object'
    && typeof (/** @type {{ register?: unknown }} */ (registry).register) === 'function'
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {unknown}
 */
function readRegistry(ctx) {
  try {
    return typeof ctx.get === 'function' ? ctx.get('agentPresets', false) : undefined
  } catch {
    return undefined
  }
}

/** The first line of a file this row generated — the marker that makes a refresh safe. */
export const GENERATED_MARKER = '# Generated by dsh-anagenesis'

/**
 * Write the directory form, and return the files this call created.
 *
 * Three cases, and the middle one is new:
 *   1. no composition on disk → write ours (`created: true`);
 *   2. a composition on disk that **this row generated** (it starts with
 *      `GENERATED_MARKER`) and is now stale → rewrite it. Without this, the
 *      `anagenesis-tools-gated` row could never reach an existing installation:
 *      the old file is a valid composition, so "leave an existing file alone"
 *      would silently keep the write tools registered from the global row. A
 *      generated file is the plugin's own artifact, so keeping it current is the
 *      whole point of generating it;
 *   3. a composition on disk that we did **not** generate → never touched. Local
 *      edits outrank an auto-install, always.
 * @param {{ id: string, definition: any, log: (m: string) => void, warn: (m: string) => void }} opts
 * @returns {Promise<{ dir: string, created: boolean, refreshed?: boolean }>}
 */
export async function installPresetDirectory({ id, definition, log, warn }) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const dir = join(home, '.agent-presets', id)
  const compositionPath = join(dir, 'agent.cordis.yml')
  const metaPath = join(dir, 'preset.yml')
  const { presetYaml, compositionYaml } = toDirectoryForm(definition)
  const existing = await readFile(compositionPath, 'utf8').catch(() => undefined)
  if (existing !== undefined && !existing.startsWith(GENERATED_MARKER)) {
    log(`anagenesis-preset: ${compositionPath} already exists and was not generated by this plugin; leaving local composition untouched`)
    return { dir, created: false }
  }
  if (existing === compositionYaml) {
    log(`anagenesis-preset: ${compositionPath} is already current`)
    return { dir, created: false }
  }
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(compositionPath, compositionYaml, 'utf8')
    await writeFile(metaPath, presetYaml, 'utf8')
    if (existing !== undefined) {
      log(`anagenesis-preset: refreshed the generated composition at ${dir} (${definition.plugins.length} rows)`)
      return { dir, created: false, refreshed: true }
    }
    log(`anagenesis-preset: installed directory preset at ${dir}`)
    return { dir, created: true }
  } catch (error) {
    warn(`anagenesis-preset: could not install directory preset at ${dir}: ${error instanceof Error ? error.message : String(error)}`)
    return { dir, created: false }
  }
}

/**
 * Remove the two files the directory install created. Exported so a test (and a
 * future uninstall command) can verify the reversal without a live host.
 * @param {string} dir
 * @returns {Promise<void>}
 */
export async function removePresetDirectory(dir) {
  await rm(join(dir, 'agent.cordis.yml'), { force: true })
  await rm(join(dir, 'preset.yml'), { force: true })
}
