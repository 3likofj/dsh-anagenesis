# dsh-anagenesis

A **programmable memory-orchestration layer + self-evolution engine** for DeepSeek Harness.

`anagenesis` is not an automatic memory plugin. It ships its own closed-loop memory store
(no external memory plugin is called, bridged or proxied), exposes memory to the agent as
**intent-shaped tools**, switches its injection strategy **at runtime**, and adjusts its own
policy parameters from observed results — with every write, switch and adjustment returning
an inverse function.

```
$ dsh plugin add dsh-anagenesis     # then restart the profile
```

Installing registers an agent preset named **`anagenesis`**; pick it in a new session.

## Three layers

| Layer | Module | What it owns |
|---|---|---|
| 1 · memory primitives | `src/memory/ops.js`, `src/memory/recall.js`, `src/store/*` | recall by intent, remember, promote/demote, lock, expire, split, counterfactual rethink, forget, link, usage feedback |
| 2 · strategy engine | `src/strategy/builtin.js`, `registry.js`, `engine.js` | runtime-registerable pure-function strategies (`explore`, `exploit`, `debug`, `distill`, invariant `guard`), reversible switching, per-scope stacks, derivation with lineage |
| 3 · meta-policy | `src/meta/tuner.js` | feedback signals → bounded parameter adjustment (UCB1 + envelope) → audit → evaluation → rollback |

Guardrails live in `src/guard/`; the agent preset in `src/preset/`.

## Agent tools

Fourteen `ana_*` tools, all registered through `ctx.tools.register(defineTool(...))`:

`ana_recall` · `ana_remember` · `ana_promote` · `ana_demote` · `ana_lock` · `ana_expire` ·
`ana_split` · `ana_rethink` · `ana_forget` · `ana_link` · `ana_strategy` · `ana_tune` ·
`ana_feedback` · `ana_audit`

`ana_recall` takes an **intent** (`orient`, `recall_fact`, `recall_precedent`, `avoid_mistake`,
`reuse_procedure`, `verify`, `contrast`), not a query language: the intent expands into kinds,
states, confidence floor, weights, granularity, token budget and diversity.

## Every mutation is reversible

A mutation is a **declarative JSON patch** (`src/store/patch.js`), never a closure. The store
serializes all writers through one async mutex, appends the event to an append-only journal,
then swaps in a frozen snapshot (lock-free readers).

`invertPatch(preState, patch)` derives the exact inverse from the pre-state, so:

- `transact()` returns `revert(reason)`, which commits the inverse as a *compensating event*;
- the inverse is journaled beside the forward patch, so a rollback still works after a restart;
- `ana_strategy action:"revert" seq:<n>` and `ana_tune action:"rollback" auditId:<id>` are
  thin wrappers over that same primitive.

Verified by `test/core.test.js`: *"revert() undoes a commit through a compensating journal
event"*, including reverting a revert.

## The self-bootstrapping answer

**Yes, anagenesis bootstraps itself — with a fixed outer loop.**

- **Self-applied (tier 1):** memory, strategy stacks and tunable parameters. The agent recalls
  its own past failures, derives new strategies from built-ins, and tunes its own confidence
  floors, token budgets and half-lives from feedback it collected itself. This is real
  self-modification: the store's own behaviour changes as a result.
- **Frozen (tier 2):** the parameter envelope, the tunable namespace whitelist, the presence of
  the invariant `guard` strategy, the tool schemas, the destruction budget, and the plugin code
  itself. Nothing in the running agent can rewrite these; changing them requires a human edit.

Reason: an agent that can rewrite its own fitness function and its own brakes will drift toward
whatever scores well rather than what works, and there is no recoverable state to roll back to.
Tier-1 self-application gives genuine adaptation; the frozen outer loop keeps the adaptation
auditable and bounded. The boundary is executable, not aspirational — see `INVARIANTS` in
`src/guard/invariants.js` and the `safeMode` freeze.

## Concurrency model

- one `Mutex` serializes every mutation; readers never lock (they read a frozen snapshot);
- durability first: journal append → snapshot swap → listener dispatch;
- snapshots are atomic (temp file + rename) and are only a cache — the journal wins on boot;
- `MemoryStore.acquire()` reference-counts per root directory, so the profile row and the
  preset-scoped row share **one** writer instead of racing on the same journal file.

## Storage

Self-contained under `$DSH_HOME/anagenesis/` (configurable):

```
anagenesis/
  journal/journal-000001.jsonl     append-only event log: { seq, ts, type, patch, undo, touched }
  journal/archive-<seq>.jsonl      folded events: forward patch dropped, `undo` kept
  journal/checkpoint-<seq>.json    the frozen state at that boundary
  journal/pruned.json              only when the retention policy has ever dropped something
  snapshot.json                    atomic boot cache: { savedAt, schemaVersion, state }
```

Compaction runs once the live log passes `compactAfterEvents` (default 2000). Each run **appends
one archive segment** covering the live events it folded — older segments are never rewritten, so
a compaction costs O(live), not O(history) — then writes a fresh checkpoint and starts a new live
segment. Only the newest checkpoint is kept: an older snapshot is dead weight, because the events
it freezes stay in the archives.

Two bounds stop the layout from growing without limit, and neither is on by accident:

- `archiveMaxSegments` (default 16) merges the oldest segments once there are too many.
  **Merging drops nothing** — the merged segment still carries every event it covered, `undo`
  included, so `revert(seq)` still executes the oldest rollback.
- `retainEvents` (**default 0 = keep everything**) is the one lossy policy: whole archive segments
  outside the most recent N events are deleted at compaction time. Those seqs stop being
  revertible, which is why it is off by default — and why the loss is made visible instead of
  silent: `ana_audit view=status` reports the marker under `journal.pruned`, `revert` names the
  policy rather than claiming the seq never existed, and the drop is recorded as a
  `journal.prune` audit row.

Retrieval is a BM25 inverted index plus a deterministic hashing vectorizer
(`src/memory/embed.js`, 192-d, L2-normalized) with MMR-lite diversity packing. No native
dependency, no model download, no network; `embed` is injectable in the core row.

Schema migrations are a pure chain (`migrateState`), so a v1 document from an older build loads
forward; the lenient strategy-parameter read tolerates keys left over from a previous version.
The current version is **v6**, which moved the tuner's learning state into `state.tuning`
(samples, UCB1 arms, tune history) — see *Learning state* below.

### What lives in state, and what that buys

Two things used to be process-local and are now state, because that is what made them
reproducible:

- **the tuner's learning state** (`state.tuning`, v6): the feedback sample window, the arm pulls
  and the applied-tune history. `ana_feedback` and `ana_tune apply` carry it inside the same
  transaction as the audit row that explains it, so a restart resumes from the journal instead of
  zeroing the meta layer, and `revert(seq)` rolls the learning state back with everything else.
  The tuner keeps **no private copy** — it reads `state.tuning`, so a revert is visible to it
  immediately rather than on the next boot.
- **the lifetime counters** (`state.stats`): each is incremented by the operation that owns it,
  inside the transaction it counts, so a counter can never disagree with the journal.
  `commits` = every transaction, `reverts` = every compensating transaction,
  `recalls` = every `service.recall()` call (selected or not), `writes` = every accepted
  `ops.remember()` commit (lifecycle transitions such as promote/lock are recorded by `commits`,
  not by `writes`). Counters added later start counting from the version that introduced them —
  they are not backfilled from history.

### The host boundary

Every tool answer is round-tripped through JSON by the host, which rejects the whole call with
`value is not lossless JSON` when anything is lost. Two consequences are enforced in code and
tested on both layers (`test/lossless.mjs` + the 14-tool sweep in `verify:boot`):

- a key whose value is `undefined` is **lossy** — it exists in the returned object and disappears
  in the JSON (`{...record, embedding: undefined}` is not "drop the field"; destructure instead);
- `auditAppend` has no inverse by design: an audit row records that something *happened*, so
  `revert` refuses an event whose only effect was an audit append instead of reporting a phantom
  rollback. Domain changes keep exact inverses.

## Guardrails

- `ctx.tools.guard()` — a **monotonic** pre-execute guard (registered after the extensible
  waterfall; no guard can force-allow what another denied). It denies locked forgets without
  `force`, missing reasons, over-budget batches, and meta changes while `safeMode` is on.
- pre-commit invariants on the transaction path — a refused change leaves **no** journal trace.
- strategy circuit breaker: 3 hook failures in 5 minutes quarantines that strategy; the engine
  degrades to the rest of the stack, and the guard freezes meta changes until it is revived.
- `safeMode` config flag freezes strategy registration, switching and tuning entirely.

## Configuration (bundle rows, `cordis.patch.yml`)

| Row | Entry | Purpose |
|---|---|---|
| `anagenesis-core` | `dsh-anagenesis` | service (`ctx.anagenesis`): store, registry, engine, tuner, ops |
| `anagenesis-tools` | `dsh-anagenesis/tools` | the fourteen `ana_*` memory tools |
| `anagenesis-guard` | `dsh-anagenesis/guard` | monotonic tool guard + quarantine brake |
| `anagenesis-preset` | `dsh-anagenesis/preset` | registers the `anagenesis` agent preset |
| `anagenesis-viz` | `dsh-anagenesis/viz` | read-only visualization: `ana_dashboard` + `ana_diagram` |

Core config keys: `rootDir`, `safeMode`, `persistDebounceMs`, `recallDefaultTokenBudget`,
`hookBudgetMs`, `sweepIntervalMs`, `autoSweepExpired`.
Visualization config keys: `color`, `width`, `redaction`, `events`, `salience`, `diagramNodes`,
`includeBodies`, `auditRenders` — all optional, all with safe defaults.

## Visualization

Visualization is the one part of anagenesis that is allowed to be absent, and it is built so that
absence costs nothing:

```
              ┌──────────────┐        ┌───────────────────┐        ┌──────────────────┐
  state ─────▶│ viz/model.js │───────▶│ viz/tui.js        │───────▶│ ana_dashboard    │
  journal      │  (projections)│       │  (ANSI frame)     │        │ one frame, chat  │
  ──────────▶  │              │       ├───────────────────┤        ├──────────────────┤
               │              │──────▶│ viz/diagram.js    │───────▶│ ana_diagram      │
               └──────────────┘        │ mermaid/d2/ascii  │        │ paste-ready      │
                                       └───────────────────┘        └──────────────────┘
                    ▲                                                     ▲
                    └──── viz/mirror.js (files, read-only) ──────────────┘
                              tools/viz-watch.mjs — live TUI, own process
```

Two forms, one model:

- **TUI dashboard** — `ana_dashboard` renders one frame (box-drawn, display-width exact including
  CJK labels, ANSI only when asked) into the tool answer; `node tools/viz-watch.mjs --watch` is
  the live, continuously redrawing version in a real terminal. Sections: overview, lifecycle,
  kinds, strategy, tuning knobs that drifted off their defaults, journal tail, top-salience
  beliefs, and the renderer's own health.
- **Text as diagram** — `ana_diagram` emits Mermaid (default), D2 or ASCII for three kinds:
  `memory-graph` (beliefs and their `supports`/`contradicts`/`supersedes` links),
  `strategy-timeline` (stack/tune/revert governance events) and `lifecycle` (the transitions the
  journal actually recorded — `lock`/`expire`/`sweep` record only a destination, and the picture
  says so instead of inventing a source edge).

Properties that are enforced, not promised:

- **read-only**: a render is not a transaction (`verify:boot` asserts the store version does not
  move across a render). The only write is `auditRenders: true`, off by default, which appends a
  `viz.render` row and reports its seq.
- **reversible / independently disableable**: a fifth Loader row — `disabled: true` on
  `anagenesis-viz` removes both tools and nothing else. The row provides no service (the preset
  mounts it a second time; `ctx.provide` would collide — HANDOFF §10.16) and starts no timers.
- **no subprocess, no GUI**: the plugin never spawns anything, and the live watcher is a
  standalone read-only process the operator runs themselves.
- **redaction boundary**: `secrets` by default — credential-shaped substrings scrubbed, bodies
  omitted; `strict` masks labels as well; `none` is an explicit local-debug escape hatch that the
  frame itself warns about.
- **versioned artifacts**: every diagram carries
  `<!-- anagenesis-viz v1 kind=… format=… store=… at=… origin=… redaction=… -->`. `normalizeArtifact`
  accepts the header-less v0 shape and refuses to choke on a newer version (it shows the raw body
  and says it is newer).
- **observable itself**: the viz section of the dashboard reports renders/diagrams/errors/last
  render, and one line is logged when the row registers.

## Preset ↔ tool binding

Two different mechanisms, deliberately:

1. **Which tools exist** is *compositional*: the preset's `plugins` list mounts exactly the tool
   rows the preset gets (`src/preset/definition.js`). There is no runtime mask.
2. **Behaving like an anagenesis agent** is *runtime and reversible*: the
   `anagenesis-preset-bind` row activates the default strategy stack
   (`['guard','exploit']`) and adopts the recall token budget for its scope. Unloading the preset
   restores the previous stack from the journal.
3. On an agent-scoped host, `toolAllow` narrows the mask via `ctx.tools.restrict()`; in a plain
   preset scope that call throws and is downgraded to a warning, so one definition works on both
   host shapes.

The `anagenesis` preset is registered through the `agentPresets` service
(`register(def) → unregister`), so `ctx.effect(() => registry.register(def))` gives the preset
exactly the plugin fiber's lifetime. If the service publishes *after* this row applies — which it
does on this host — the row binds reactively with `ctx.inject(['agentPresets'], …)` and registers
the moment it appears.

The directory form (`$DSH_HOME/.agent-presets/<id>/{preset.yml,agent.cordis.yml}`) is a fallback
for hosts old enough to scan a directory roster. It is **off** in this deployment's
`cordis.patch.yml`, because `@deepseek-ai/dsh-agent-preset-registry` 0.2.0-rc.2 contains no
reference to `.agent-presets`, `preset.yml` or `readdir` at all — it sources presets from the
Loader tree plus `register()`. Set `autoInstallDirectoryForm: true` only for an older line; the
writer never overwrites an existing local composition.

## DSH API assumptions (verified, not guessed)

Read out of the running harness `app.asar/dsh/node_modules/@deepseek-ai/*` (DSH
`0.2.0-rc.2`, Cordis 4.x) before writing this code:

| API | Contract used | Where |
|---|---|---|
| `ctx.effect(fn)` | runs `fn`, collects its returned disposer, disposes in reverse on fiber unload | `src/index.js`, `src/guard/index.js`, `src/preset/bind.js` |
| `ctx.provide(name, value)` | returns a disposer; Cordis unregisters the service when the fiber unloads | `src/index.js` |
| `ctx.inject(deps, apply)` | starts a child plugin once dependencies exist | declared as `export const inject` |
| `internal/service` event | dependency changes refresh dependents | engine/registry cache invalidation |
| `ctx.tools.register(def)` | returns the exact disposer; duplicates in one layer throw | `src/tools/index.js` |
| `defineTool({...})` | compiles the parameter spec, validates **args** only | `src/tools/index.js` |
| `ctx.tools.guard(fn)` | monotonic; a returned string denies the call | `src/guard/index.js` |
| `ctx.tools.restrict({allow,deny})` | scoped context only | `src/preset/bind.js` |
| `agentPresets.register(def)` | `{id,name,description,order,plugins}` → unregister disposer | `src/preset/index.js` |
| `ctx.plugin(cb)` / `apply` result | **collected as an effect**: function = disposer, null/undefined = OK, promise = awaited then collected, **any other object = `TypeError: Invalid effect`** | all five rows |

`inject` is an array of service names for `anagenesis-tools` (`['tools','anagenesis']`) and
`anagenesis-guard`; `anagenesis-preset` deliberately declares **no** hard dependency on
`agentPresets` (it is optional on older lines) and probes `typeof registry.register === 'function'`
instead of "does the service exist".

### The row contract (learned the hard way)

Cordis collects whatever `apply` returns as an **effect**:

```js
const effect = runner.execute.call(this)                   // runs apply(ctx, config)
if (typeof effect === 'function') runner.collect(effect)   // a disposer      — OK
else if (isNullable(effect)) { /* OK */ }                  // undefined/null  — OK
else if (!isObject(effect)) throw new TypeError('Invalid effect')
else if ('then' in effect) return effect.then(safeCollect) // await, then collect the value
// safeCollect(value): non-function, non-null  →  throw new TypeError('Invalid effect')
```

An `async apply` that returns a status object (`{ mode }`, `{ dispose }`) is therefore rejected,
and the resulting fibre teardown **rolls back every effect the body already created**. The first
live install failed exactly this way: `provide('anagenesis')` and all fourteen `tools.register`
calls were undone, so the dependent rows waited forever and no `ana_*` tool ever appeared. Rules:

1. `apply` returns **nothing**, or a disposer function. Never a plain object.
2. If `ctx.effect` already owns a disposer, do **not** also return it — Cordis would collect it
   twice, and a doubly-disposed revert undoes its own undo.
3. Register the effect *before* a long `await` when an unload during the await must still be undone.

`test/adapter.test.js` asserts rule 1 for every row, and the bind test asserts rule 2 as
"exactly one revert".


## Tests

```
npm test        # 47 tests, four suites, stubbed host
npm run check   # node --check over every adapter row and the reflection module
npm run verify:boot
```

`npm test` runs against a stubbed host because the real host packages live in the profile, not
this repository:

- `test/core.test.js` — patch algebra, the migration chain (v1 → v6), journal replay after a
  restart, **journal compaction** (archive + checkpoint: every seq stays traceable, the oldest
  event stays revertible, a snapshot-less replay still rebuilds the state, an older segment comes
  out **byte-identical** after the next compaction, the segment-count guard merges without losing
  a seq, and the opt-in retention prune leaves a marker and refuses the lost reverts), reference
  counting, revert-of-revert, **a stack transaction that
  created a scope** (reversible now; a forward deletion of a live stack is still refused),
  the lifecycle ops (remember/promote/demote/lock/expire/split/rethink/forget/usage/sweep),
  intent planning, budget packing, strategy switching/derivation/quarantine, the tuner loop
  (including that the learning state survives a restart and a revert takes it back out),
  **per-scope salience**, **pluggable vector backends and re-embedding**, invariants and the
  tool guard, and the two reversibility boundaries (audit-only events are refused, not faked).
- `test/adapter.test.js` — the five rows against a host stub: the `apply` effect contract for
  every row, service publication surviving its own apply, 14 tool registrations, a full agent
  round-trip (remember → recall → promote → split → strategy switch → revert → rethink →
  feedback → audit → tune gate → guard denial), caller budget honouring, preset-bind settling and
  single-owner disposal, reactive preset registration, the compaction-policy mapping, and a
  **lossless-JSON check on every tool answer** (`test/lossless.mjs`) plus the counters and the
  deduplicated-write contract.
- `test/preset.test.js` — definition as single source of truth, platform-gated shell rows,
  directory-form rendering, persona contract, idempotent directory install.
- `test/viz.test.js` — the visualization layer: a render is a pure projection (the state object
  and the store version are unchanged), the frame is display-width exact at three widths and
  survives CJK labels and ANSI colour, credentials are scrubbed by default and `strict` masks
  labels, the memory graph marks links whose target is outside the window, lifecycle counts come
  from the journal (and unrecorded sources are not invented), artifacts migrate from v0 and
  degrade on a newer version, and the read-only mirror agrees with `MemoryStore` on the same
  directory while leaving it byte-identical.
- `test/reflect.test.js` — the scheduled sweep: which beliefs qualify as stale, that one run is
  bounded, that a belief already carrying a live challenge is never asked twice, that every
  reflection is an ordinary `memory.rethink` transaction, and that reverting one reopens the
  question.

Bugs these tests found and fixed: a `null` parameter write pinned a knob to its envelope
minimum instead of restoring the default; a pending snapshot write fired after teardown;
`toDirectoryForm` returned an array where `fs.writeFile` expected text; an `async apply`
returning an object, which Cordis rejects with `TypeError: Invalid effect` (see §DSH API
assumptions) and which tore down the row after its body had run; `preset-bind` firing its stack
switch without awaiting it; `preset-bind` dropping the compensating transaction for the token
budget it wrote, so every preset unload leaked the parameter; `createToolGuard` reading
`exec.args` where the host passes `exec.arguments`, which made every argument-dependent
guardrail silently inert; **ASI joining `row.access ??= {…}` with a following `(record)` into a
call of the object literal**, which broke the v2→v5 migration for any document that actually had
records; and the v2→v3 migration dropping `meta.params` because `normalizeState` always
pre-fills `params`, so the `??` fallback could never fire.

`npm run verify:boot` is the same boot contract, packaged: it extracts the harness libraries
(`@deepseek-ai/cordis`, `dsh-tools`, `schemastery` and their closure — 17 packages, 736 files)
out of the installed `app.asar` into a **temp directory outside this package**, registers a
resolution hook there, imports the real `src/**`, and drives five rows through mount → observe →
unload: 55 checks covering the effect contract, service publication, all fourteen tools compiled
by the real `defineTool`, preset-bind settling, reactive preset registration, unload
reversibility, and three concurrency-safe proofs that the user's real store was never touched.
It never writes into this package's `node_modules` — a package-local copy of a host library
would shadow the host's own instance and split `Service`/`defineTool` identities.

## MVP roadmap

- **MVP-1 (done, installed, live-verified):** store + patch algebra + journal, fourteen tools,
  three built-in strategies + guard, tuner with audit/rollback, invariants, `anagenesis` preset,
  and the packaged boot contract.
- **MVP-2 (done):** per-agent strategy scopes verified end to end on the live host (the
  recalling scope really does use its own stack, down to the rendered section); journal
  compaction with `archive-*.jsonl` + `checkpoint-*.json`, transparent to `ana_audit
  view=journal` and to `revert(seq)`; `npm run verify:boot`.
- **MVP-3 (done):** a pluggable vector backend (`registerEmbedProvider` / `resolveEmbedder` /
  `service.useEmbedder`) with a stamped `state.embed` and a one-transaction `reembed()`;
  per-scope salience so a shared store cannot let one agent re-rank another's recall; and a
  scheduled reflection job that files counterfactuals against beliefs whose evidence aged out.
- **MVP-4 (done):** a bounded journal layout — one appended archive segment per compaction
  (`archiveMaxSegments` merges the oldest without dropping a seq), plus an **opt-in** retention
  window (`retainEvents`, default 0) that prunes whole segments and records the loss in
  `pruned.json`, in `status().journal.pruned`, and as a `journal.prune` audit row.
- **MVP-5 (done):** visualization without a GUI — a dependency-free projection layer
  (`src/viz/`), two read-only tools (`ana_dashboard`, `ana_diagram`) on their own kill-switch
  row, a standalone live TUI (`tools/viz-watch.mjs`) that reads the store without becoming a
  writer, redaction by default, and versioned text artifacts. A future GUI consumes
  `viz/model.js`; it does not replace it.
- **Not shipped — a GUI settings panel.** One was written and then withdrawn: a package that
  declares `dsh.client` may own exactly **one** active Loader row, because
  `@deepseek-ai/dsh-client-modules` resolves a client source per row and throws on
  `package X resolves from multiple active Loader sources … remove one entry`. This package
  deliberately ships **four** independently disableable rows (and the `anagenesis` preset mounts
  them again), so a client half cannot live here. The panel would have to ship as its own
  single-row package; `npm run verify:boot` now fails the build if `dsh.client` reappears beside
  more than one row.
- **Still open:** native `tsc` type-checking (there is no `jsconfig`/`typescript` in this
  dependency-free package).
