/**
 * Preset-form suite: the definition, the two renderings of it, and the
 * reversible directory install used by older hosts.
 * @module dsh-anagenesis/test/preset.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PRESET_ID,
  META,
  DEFAULT_PRESET_STACK,
  WINDOW_CAPABILITY,
  baseToolRows,
  anagenesisRows,
  anagenesisPreset,
  toDirectoryForm,
  windowRow,
} from '../src/preset/definition.js'
import { installPresetDirectory, removePresetDirectory, GENERATED_MARKER } from '../src/preset/index.js'
import { PERSONA, OPERATING_NOTES } from '../src/preset/persona.js'

test('preset: the definition is the single source for both host forms', () => {
  const definition = anagenesisPreset()
  assert.equal(definition.id, PRESET_ID)
  assert.equal(definition.name, META.name)
  assert.equal(definition.order, META.order)
  const ids = definition.plugins.map((row) => row.id)
  for (const required of ['persona', 'anagenesis-core', 'anagenesis-tools', 'anagenesis-guard', 'anagenesis-viz', 'anagenesis-preset-bind']) {
    assert.ok(ids.includes(required), `composition is missing ${required}`)
  }
  // By id, not by index: inserting a row must not silently retarget this check.
  const bind = anagenesisRows().find((row) => row.id === 'anagenesis-preset-bind')
  assert.deepEqual(bind.config.stack, [...DEFAULT_PRESET_STACK])
})

test('preset: row configs match the target packages\u2019 real schemas, not a guess', () => {
  // Regression for the defect that made the whole preset show up as *broken* in
  // the live roster while every host-side test stayed green: two rows carried a
  // `text` config that the target packages do not accept.
  //   - `@deepseek-ai/dsh-persona` is `{ prefix (required), suffix, complete,
  //     includeRuntimeContext }`; a wrong key plus a missing required one made
  //     config validation throw.
  //   - `@deepseek-ai/dsh-agent-instructions` has no inline-text key at all
  //     (`maxBytes` is its only required one) — it discovers instruction files.
  // These shapes were read off the running host; this test is the tripwire.
  const rows = anagenesisPreset().plugins
  const persona = rows.find((row) => row.id === 'persona')
  assert.deepEqual(Object.keys(persona.config).sort(), ['prefix', 'suffix'])
  assert.equal(persona.config.prefix, PERSONA)
  assert.ok(persona.config.suffix.length > 0, 'the operating notes ride in the row\u2019s suffix section')

  const instructions = rows.find((row) => row.id === 'agent-instructions')
  assert.deepEqual(Object.keys(instructions.config), ['maxBytes'], 'that row\u2019s only required key')

  // Nothing in this composition accepts inline `text`; the persona row above is
  // the one place free text is legal, and it goes in `prefix`/`suffix`.
  assert.equal(rows.filter((row) => row.config !== undefined && 'text' in row.config).length, 0)
})

test('preset: shell rows are platform-gated so the same definition works everywhere', () => {
  const win = baseToolRows({ platform: 'win32' })
  const posix = baseToolRows({ platform: 'linux' })
  assert.equal(win.find((row) => row.id === 'tool-pwsh').disabled, false)
  assert.equal(win.find((row) => row.id === 'tool-bash').disabled, true)
  assert.equal(posix.find((row) => row.id === 'tool-pwsh').disabled, true)
  assert.equal(posix.find((row) => row.id === 'tool-bash').disabled, false)
})

test('preset: the directory form renders parseable YAML-ish rows and keeps the multiline persona intact', () => {
  const { presetYaml, compositionYaml } = toDirectoryForm(anagenesisPreset())
  assert.match(presetYaml, /^name: /m)
  assert.match(presetYaml, /^order: 7$/m)
  assert.match(compositionYaml, /^- id: anagenesis-core$/m)
  assert.match(compositionYaml, /^  name: dsh-anagenesis$/m)

  const lines = compositionYaml.split('\n')
  // One '- id:' per row, and each row is followed by its name line.
  const rowCount = lines.filter((line) => line.startsWith('- id: ')).length
  assert.equal(rowCount, anagenesisPreset().plugins.length)
  assert.match(compositionYaml, /dsh-anagenesis\/preset-bind/)
  // Every row must be a real YAML mapping line, not concatenated text.
  for (const line of lines.filter((line) => line.trim() !== '' && !line.startsWith('#'))) {
    assert.ok(/^(- id: |  (name|config|disabled): )/.test(line), `unexpected composition line: ${line.slice(0, 60)}`)
  }
})

test('preset: the persona states the operating contract the tools rely on', () => {
  for (const token of ['ana_recall', 'ana_remember', 'ana_feedback', 'ana_rethink', 'ana_strategy', 'guard']) {
    assert.ok(PERSONA.includes(token), `persona does not mention ${token}`)
  }
  assert.match(PERSONA, /\{\{cwd\}\}/)
})

test('preset: it is AWARE of the visualization window and does not mount it', () => {
  // The window is a separate single-row package because a `dsh.client` package may
  // own exactly one active Loader row, and this preset already mounts five
  // anagenesis rows in its own scope (HANDOFF §10.14). So "aware, not enabled" is
  // enforced here rather than left to a comment nobody reads.
  assert.equal(WINDOW_CAPABILITY.mountedByPreset, false)
  assert.equal(WINDOW_CAPABILITY.packageName, 'dsh-anagenesis-window')
  assert.equal(WINDOW_CAPABILITY.tool, 'ana_window')
  // Three seats, not four: the operator asked for the better-sidebar bottom
  // workbench row to be removed, and the preset's declared awareness has to
  // follow the actual entry layer or it becomes a lie the agent reads.
  assert.equal(WINDOW_CAPABILITY.entries.length, 3)
  assert.deepEqual(WINDOW_CAPABILITY.entries.slice(), ['better-sidebar-row', 'official-right-sidebar', 'conversation-header'])
  assert.equal(WINDOW_CAPABILITY.entries.includes('better-sidebar-bottom'), false)

  const rows = anagenesisPreset().plugins
  assert.equal(rows.some((row) => row.name === 'dsh-anagenesis-window'), false, 'the preset must never mount the window row')
  assert.equal(anagenesisRows().some((row) => row.name === 'dsh-anagenesis-window'), false)

  // Awareness is textual too: the capability is described as a CONDITIONAL, so an
  // agent without the row does not hallucinate a window (and does not stop looking
  // at its store).
  assert.match(OPERATING_NOTES, /dsh-anagenesis-window/)
  assert.match(OPERATING_NOTES, /ana_window/)
  assert.match(OPERATING_NOTES, /不要假设它存在/)
  assert.match(OPERATING_NOTES, /ana_dashboard/)

  // The row is exported for a profile that does want it, and it is exactly one row.
  assert.deepEqual(windowRow(), [{ id: 'anagenesis-window', name: 'dsh-anagenesis-window' }])
})

test('preset: a generated composition is refreshed, a hand-written one is never touched', async () => {
  // The distinction this test pins is the whole reason the refresh exists: the
  // `anagenesis-tools-gated` row could not otherwise reach an installation that
  // already had a composition on disk, and "leave an existing file alone" would
  // silently keep the write tools coming from the global row. A file *this
  // plugin generated* is its own artifact; a file someone edited is theirs.
  const home = await mkdtemp(join(tmpdir(), 'ana-preset-refresh-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const dir = join(home, '.agent-presets', PRESET_ID)
    await mkdir(dir, { recursive: true })
    const compositionPath = join(dir, 'agent.cordis.yml')

    // Ours, but stale: it carries the generated marker and lacks the new row.
    const stale = `${GENERATED_MARKER} from an older version\n- id: anagenesis-core\n  name: dsh-anagenesis\n`
    await writeFile(compositionPath, stale, 'utf8')
    const refreshed = await installPresetDirectory({
      id: PRESET_ID,
      definition: anagenesisPreset(),
      log: () => {},
      warn: () => {},
    })
    assert.equal(refreshed.refreshed, true, 'a generated file is brought up to date')
    assert.equal(refreshed.created, false, 'and that is a refresh, not a fresh install')
    const updated = await readFile(compositionPath, 'utf8')
    assert.equal(updated, toDirectoryForm(anagenesisPreset()).compositionYaml)
    assert.match(updated, /dsh-anagenesis\/tools-gated/, 'the row that makes the preset a permission layer is in the refreshed composition')

    // Idempotent: a second install of the same definition writes nothing.
    const again = await installPresetDirectory({ id: PRESET_ID, definition: anagenesisPreset(), log: () => {}, warn: () => {} })
    assert.equal(again.created, false)
    assert.equal(again.refreshed, undefined, 'already current: no rewrite is reported')

    // Someone else's file: never touched, marker or not.
    await writeFile(compositionPath, '- id: mine\n  name: my-plugin\n', 'utf8')
    const third = await installPresetDirectory({ id: PRESET_ID, definition: anagenesisPreset(), log: () => {}, warn: () => {} })
    assert.equal(third.created, false)
    assert.equal(third.refreshed, undefined)
    assert.equal(await readFile(compositionPath, 'utf8'), '- id: mine\n  name: my-plugin\n')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('preset: the directory install is idempotent and leaves local edits alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ana-preset-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const dir = join(home, '.agent-presets', PRESET_ID)
    const first = await installPresetDirectory({
      id: PRESET_ID,
      definition: anagenesisPreset(),
      log: () => {},
      warn: () => {},
    })
    assert.equal(first.created, true)
    assert.ok(existsSync(join(dir, 'agent.cordis.yml')))
    assert.ok(existsSync(join(dir, 'preset.yml')))

    // A local edit must win over a second auto-install.
    await writeFile(join(dir, 'agent.cordis.yml'), '# hand edited\n', 'utf8')
    const second = await installPresetDirectory({
      id: PRESET_ID,
      definition: anagenesisPreset(),
      log: () => {},
      warn: () => {},
    })
    assert.equal(second.created, false)
    assert.equal(await readFile(join(dir, 'agent.cordis.yml'), 'utf8'), '# hand edited\n')

    await removePresetDirectory(dir)
    assert.equal(existsSync(join(dir, 'agent.cordis.yml')), false)
    assert.equal(existsSync(join(dir, 'preset.yml')), false)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
