# dsh-anagenesis

[中文](README.md) · [Changelog](CHANGELOG.md) · Apache-2.0

[![npm](https://img.shields.io/npm/v/dsh-anagenesis?label=npm&color=cb3837)](https://www.npmjs.com/package/dsh-anagenesis)
[![npm (window)](https://img.shields.io/npm/v/dsh-anagenesis-window?label=window&color=cb3837)](https://www.npmjs.com/package/dsh-anagenesis-window)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](package.json)

> **Memory your agent actually owns — and you can actually see.**
>
> Not another "automatic memory black box". Memory operations are tools the agent calls on purpose,
> the injection strategy is switchable at runtime, every change comes with its inverse, self-tuning is
> bounded, audited and revertible — and the whole store is self-contained, offline and dependency-free.

![The anagenesis desktop window — dashboard](assets/dashboard.png)

## New in 0.2.0: memory is isolated per project, and the preset is a permission switch

Two real defects drove this release: **one project's experience was recalled in another**, and **the model could
write memories with no preset enabled**.

| New | In one line | What you see |
|---|---|---|
| **Memory scope** | Every memory carries `global` / `project` (default) / `session`; recall returns the current project + global + the current session only | A new `scope` section in the dashboard: current project in cyan, **other projects in yellow**, global and legacy untagged at a glance |
| **Project fingerprint** | `p1_<hash>` from the git remote (preferred) or the working directory — a pure function, stable across restarts, so two checkouts of one repo are one project | Directory changes, machine changes and new sessions cannot misidentify the project |
| **Crossing needs authorization** | `crossProject: true` admits another project's memories, down-weighted and each one labelled "⚠ experience from another project — do not follow it blindly" | The block itself says what not to trust |
| **Conflicts are downgraded** | When a foreign memory is semantically similar to a local one but opposite in content, its *effective* confidence is halved and the pulse says to trust the current environment | Only that answer's projection changes — **the store is never rewritten by a read** |
| **Physical isolation** | Journal segments are per namespace (`journal-<ns>-*.jsonl`); global memory keeps its own files; a pre-0.2.0 store loads byte-for-byte | `node tools/scope-report.mjs` shows who owns how many records, in which file |
| **The preset is the permission layer** | Write tools are registered **only while the `anagenesis` preset is on**; gears `passive` (read) / `assisted` (write) / `autonomous` (may self-schedule) | `ana_preset action="status"` is the authoritative answer to "what do I actually hold" |
| **Checked at execution time** | `ctx.tools.guard()` plus each tool's own grant check: unregistered means unreachable, and a cached definition refuses once its grant is revoked | Prompt rules are the second line, never the only one |
| **Status pulse** | Every step carries `<anagenesis-pulse>`: the project fingerprint, the gear, the tools in hand | The model can check "may I use this memory" itself |
| **Session memories expire** | Session-tier writes get a 24h TTL by default; `ana_scope action="drop-session"` reclaims them in one revertible transaction | Scratch state cannot quietly become a permanent belief |
| **New tools** | `ana_list` (list by scope), `ana_scope` (status / list / namespaces / retag / adopt / drop-session) | `retag` is revertible; widening a project memory to global needs an **explicit user authorization** |

**Upgrading (breaking)**: the store migrates from schema v6 to v7 automatically. Records that carried a
`workspace` are filed under the right project; the rest are marked `migrated-global` — still recallable, but
down-weighted, and `ana_scope action="adopt"` files them back under the current project. Restart the desktop app
so the new tool layering loads.

## What makes it different

- **Scope is a first-class citizen of the store**, not a filter applied at query time: writes, journal
  partitioning, recall filtering, by-id reads and the visualization all share one namespace decision — so
  "whose experience is this" holds at the **filesystem** level too.
- **The preset is a permission switch, not a prompt bundle**: the gear decides whether a write tool *exists*,
  not whether it *should* be used. The host offers no permission field on a tool definition, so we use the only
  reliable lock there is: registered or not registered.
- **One seq space plus declarative patches**: because the journal is *not* sharded per project, `revert(seq)`,
  the audit trail and every handle a tool returns stay globally unique — isolation lives in the **files**,
  revertibility in the **counter**.
- **Physical isolation without breaking old data**: every namespace owns its live and archive segments, while the
  global namespace keeps the original unprefixed names, so a store written before 0.2.0 loads unchanged.
- **Falsifiable claims**: 95 core tests + 87 window tests + a 96-check boot sandbox that runs the real Cordis,
  the real `defineTool` and the real preset registry — the real row code, not a mock of it.

## What it is, in three lines

- **A self-contained store**: an append-only `journal/*.jsonl` plus atomic snapshots. It never calls, bridges or proxies an external memory service — no database, no cloud, no model calls.
- **Memory as tools the agent drives** (17 `ana_*` tools): recall is shaped by **intent** (`orient`, `recall_precedent`, `avoid_mistake`, `reuse_procedure`, …), not by background extraction.
- **It governs its own behaviour, too**: switchable injection stacks, bounded meta-level self-tuning, a monotonic guard, and a revertible history for all of it — with a trail you can audit.

## Scope: a memory belongs to a project

Every memory carries a scope tag, by default — there is nothing to configure:

| Tier | When | Who can recall it |
|---|---|---|
| `global` | facts that hold everywhere (team conventions, tooling) | every project |
| `project` (**the write default**) | conclusions that hold *here* | only the current project |
| `session` | scratch state for one task; expires after 24h by default | only the session that wrote it |

- The **project fingerprint** (`p1_<hash>`) comes from the git remote (preferred) or the canonicalised
  working directory: a pure function, stable across restarts. Two checkouts of the same repository are
  the *same* project.
- **Recall returns only the current project + global + the current session.** Crossing projects needs
  an explicit `crossProject: true`: those hits are down-weighted and each one is labelled
  “⚠ experience from another project — do not follow it blindly”.
- **Conflicts are called out.** When another project's memory is semantically similar to a local one
  but opposite in content, its *effective* confidence is halved for that answer and both the block and
  the status pulse say “ignore the historical experience; trust the current environment”. Only the
  projection changes — a read never rewrites the record it read.
- **Storage is partitioned as well**: events are written per namespace (`journal-<ns>-*.jsonl`), global
  memory keeps its own unprefixed files, and a pre-isolation store still loads unchanged (those records
  are marked `migrated-global` and down-weighted; `ana_scope action="adopt"` files them back under the
  current project).
- Inspect a store: `node tools/scope-report.mjs` (read-only: namespaces, known projects, files, gears).

## The preset is a permission switch, not a suggestion

Installing the plugin gives the model **eyes only**: what gets registered is the read tier
(`ana_recall`, `ana_list`, `ana_audit`, `ana_dashboard`, `ana_diagram`, `ana_window`, plus the
inspection actions of `ana_scope` / `ana_preset` / `ana_strategy` / `ana_tune`). **The write-tier tools
exist only while the `anagenesis` preset is enabled** — not discouraged, simply never registered, so
the model cannot see them.

| Gear | Write tools | Extra |
|---|---|---|
| `passive` | none registered | read, audit, visualize, inspect |
| `assisted` (preset default) | registered | every write is an explicit tool call by the agent |
| `autonomous` | registered | the plugin may schedule the stack (a reported failure switches to `debug`) and crystallize repeatedly-cited drafts — both audited, both with a seq |

- The gear lives in the preset config (`gear:`); at runtime `ana_preset action="gear"` reports it and can
  lower it. **Raising it needs the host** — an agent cannot widen its own permissions.
- Switching and unloading **roll back exactly**: dropping to `passive` unregisters each write tool;
  unloading the preset returns the tool set to the read tier.
- The permission check runs **at execution time** (`ctx.tools.guard()` plus each gated tool's own
  `assertGrant`), so a cached definition refuses to run once its grant is revoked. Prompt rules are the
  second line of defence, never the only one.
- The agent sees an `<anagenesis-pulse>` every step: current project, gear, and the tools it holds.

## How it differs from a typical "automatic memory" plugin

| Dimension | Typical automatic memory | anagenesis |
|---|---|---|
| Who decides what is stored | Background extraction; the agent is not involved | **The agent decides, with tools**: `ana_remember`, `ana_promote`, `ana_split`, `ana_rethink`, `ana_forget` |
| How recall works | Keyword or vector similarity | **Intent-driven**: 7 intents expand into kinds, states, confidence floor, weights, granularity, token budget, diversity |
| Who can see it | One shared store for every project | **Isolated per project**: writes default to the current project; crossing needs explicit authorization and is labelled |
| Who can write it | Anything installed can write | **The preset is the permission layer**: without it the write tools do not exist; gears `passive` / `assisted` / `autonomous` |
| Injection strategy | Fixed | **Switchable at runtime** (6 named stacks), and **stacks are per scope** — one agent switching does not touch another |
| What a change costs | Usually irreversible | **Every transaction returns an inverse**; inverses are journalled next to the forward patch, so **reverts survive a restart** |
| Self-tuning | None | **The meta layer tunes itself from feedback**: parameter envelope + UCB1 + audit + evaluation + rollback |
| Blast radius | — | **Monotonic guard + circuit breaker + `safeMode`**; only tier-1 is self-modifiable, the outer ring is frozen |
| Dependencies | Often an external service or vector DB | **Zero runtime dependencies, offline, no subprocess, no network** |
| Visibility | A black box | TUI dashboard + mermaid/d2/ascii diagrams + an optional desktop window |

## Install

### Everything at once (recommended: kernel + desktop window)

Both packages are published on npm: [`dsh-anagenesis`](https://www.npmjs.com/package/dsh-anagenesis) · [`dsh-anagenesis-window`](https://www.npmjs.com/package/dsh-anagenesis-window) — `dsh plugin add` pulls the latest from npm.

```bash
dsh plugin add dsh-anagenesis          # kernel: memory + strategies + guard + visualization tools
dsh plugin add dsh-anagenesis-window   # desktop window (optional, but recommended)
```

Then **restart your profile**. Installing registers an agent preset called **`anagenesis`** — pick it in a new session.

> Kernel only? The first command is enough. The window is genuinely optional: the preset knows the
> capability exists but never assumes it is installed.

### From source (if you want to hack on it or track `main`)

```bash
git clone https://github.com/3likofj/dsh-anagenesis.git
cd dsh-anagenesis
dsh plugin --profile desktop add link:<absolute path to this repo>
dsh plugin --profile desktop add link:<absolute path to this repo>/window   # optional
```

## Five minutes in

1. Install, restart the profile, and select the **`anagenesis`** preset in a new session (default stack `guard + exploit`).
2. Just work: the agent calls `ana_recall` and `ana_remember` itself — there is no query language to write.
3. To look at the store, ask the agent for `ana_dashboard` (one TUI frame, right in the answer) or `ana_diagram` (a diagram you can paste into Markdown).
4. For a live view in a real terminal: `node tools/viz-watch.mjs --watch` (read-only, separate process).
5. For the desktop window: install the second package, restart, then call `ana_window` or click an entrance.

## Capability map (19 tools, layered by permission)

**Read tier — installed with the plugin**

| Group | Tools | What they do |
|---|---|---|
| Recall | `ana_recall` · `ana_list` | Retrieve by intent (current project + global + current session by default); list what the store holds, with scope labels |
| Inspection | `ana_audit` · `ana_scope` · `ana_preset` · `ana_strategy` · `ana_tune` | Status / journal / audit / one memory; the scope report; gear and permissions; the strategy roster; tuning metrics |
| Visualization | `ana_dashboard` · `ana_diagram` · `ana_window` | TUI dashboard (with a scope section), text diagrams, desktop window |

**Write tier — only while the `anagenesis` preset is enabled**

| Group | Tools | What they do |
|---|---|---|
| Write & lifecycle | `ana_remember` · `ana_promote` · `ana_demote` · `ana_lock` · `ana_expire` · `ana_forget` | Writes default to the **current project**; `draft → active → verified → locked`, or demote / expire / forget (a forget leaves an auditable tombstone) |
| Structure | `ana_link` · `ana_split` · `ana_rethink` | Links; split an overloaded memory (children inherit the parent's scope); counterfactual re-reasoning |
| Feedback & correction | `ana_feedback` · `ana_scope action="retag"/"adopt"` · the mutating actions of `ana_strategy`/`ana_tune` | Report actual use; re-file a scope (revertible); switch stacks / tune the meta layer (`admin` gear) |

## Injection strategy: which brain for which moment

| Named stack | Composition | Best for |
|---|---|---|
| `explore` | guard + explore | Still mapping the problem: high recall, low bar, writes land as drafts |
| `exploit` | guard + exploit | Executing a known plan: inject only verified/locked beliefs, writes take effect immediately |
| `debug` | guard + debug | The moment things break: failures and open hypotheses first, time decay off |
| `distill` | guard + distill | Long sessions where tokens matter: compression first |
| `recon` | guard + explore + distill | Open up, then tighten |
| `crisis` | guard + debug + exploit | Repeated failure: failures and verified facts injected together |

`guard` is an **invariant**: always at the bottom, injecting nothing itself — it only weights locked
beliefs up, drafts down, and keeps `retired` records out. Strategies are **pure function bundles with
bounded parameters**: an agent may only derive a strategy by naming a built-in implementation plus a
parameter delta. An agent that can persist arbitrary code is an agent that can brick its own harness.

## Every change can be undone

- A change is a **declarative JSON patch**, never a closure. The store serializes all writers: append to the journal first, then swap in a frozen snapshot (readers never lock).
- `transact()` returns `revert(reason)`, which commits the inverse as a *compensating event* **in the same journal** — so reverts still work after a restart.
- `ana_strategy action:"revert"` and `ana_tune action:"rollback"` are thin wrappers over that one primitive.
- The journal has three bounds: segments are merged when there are too many (**merging drops no seq**), only the newest checkpoint is kept, and the single **lossy** retention policy is off by default — and when it ever drops something, the status view says so instead of pretending the seq never existed.

## The boundary on self-direction (why it does not drift)

**It can direct itself — behind a frozen outer ring.**

- **tier 1 (self-modifiable)**: memories, strategy stacks, tunable parameters. The agent can recall its own past failures, derive strategies, and adjust its confidence floor and token budget from feedback it collected.
- **tier 2 (frozen)**: the parameter envelope, the tunable-namespace allow-list, the existence of `guard`, tool schemas, and the plugin code itself. A running agent cannot touch any of it.

The reason is blunt: an agent that can rewrite its own fitness function and its own brakes drifts
towards "scores well" instead of "actually works", with no recoverable state to roll back to. The
boundary is **enforced** (8 monotonic invariants plus the `safeMode` freeze), not a slogan.

## What you can see

![Memory graph (horizontal)](assets/graph-lr.png)

![Lifecycle transitions](assets/lifecycle.png)

![Strategy timeline](assets/timeline.png)

- **TUI dashboard** (`ana_dashboard`): overview, lifecycle distribution, kind distribution, strategy stacks and health, tuning knobs that deviate from their defaults, journal tail, salience ranking, and the renderer's own health. Width-exact, including CJK labels; colour only when asked for.
- **Text diagrams** (`ana_diagram`): Mermaid (default) / D2 / ASCII, three kinds — the belief graph (with `supports` / `contradicts` / `supersedes` edges), the strategy timeline, and observed lifecycle transitions (only what the journal really recorded; `lock` / `expire` style destination-only events are labelled as such instead of inventing a source edge).
- **Desktop window** (optional sibling package): Chinese cards and a hand-rolled inline-SVG directed graph (LR/TB plus zoom) produced by the same pure functions, with three entrance seats (better-sidebar row / official right sidebar / conversation header), reading the store as a read-only mirror.
- Rendering is a **read-only projection**: a render is not a transaction. The only optional write, `auditRenders`, is off by default; `tools/viz-watch.mjs` is an independent read-only process that can redraw continuously in a real terminal.

## Where the data lives, and privacy

```
$DSH_HOME/anagenesis/
  journal/journal-000001.jsonl          append-only event log (the global namespace, original naming)
  journal/journal-<ns>-000001.jsonl     one segment per project/session namespace (physical isolation)
  journal/archive-<ns>-<seq>.jsonl      folded archives, per namespace (the `undo` is kept)
  journal/checkpoint-<seq>.json         frozen state at a boundary (one cache for the whole store)
  snapshot.json                         atomic startup cache
```

- **Memory is partitioned by namespace in the filesystem**, not only filtered at query time:
  `project:<fingerprint>` and `session:<id>` events live in segments named after them, while global
  memory keeps the unprefixed `journal-*.jsonl`.

- **Entirely local**: no network, no model download, no model calls, no subprocesses.
- **Zero runtime dependencies**: retrieval is a built-in BM25 inverted index plus a deterministic hashing embedder (192 dimensions). A real semantic backend can be injected at runtime.
- **Redaction on by default**: tool and window output defaults to `secrets` — credential-shaped text is scrubbed and bodies are omitted. `strict` masks labels too; `none` is an explicit local-debug escape hatch, and the artifact warns about it.
- **Legacy directory compatibility**: the default is `$DSH_HOME/anagenesis`; if the pre-rename `$DSH_HOME/evolution` holds more data, the plugin keeps using it and says so in the log, moving not a single byte. To move it, run `npm run migrate:store` (copy + per-file sha256 verification; the source is untouched).

## Configuration (all optional, all with safe defaults)

Key knobs on the kernel row:

| Key | Default | Effect |
|---|---|---|
| `rootDir` | `$DSH_HOME/anagenesis` | Store root; set explicitly and it is obeyed exactly (no legacy fallback) |
| `safeMode` | `false` | Freezes strategy registration, switching and tuning |
| `recallDefaultTokenBudget` | `1600` | Default token budget for injected recall |
| `hookBudgetMs` | `8` | Time budget for a single strategy hook (a timeout counts as a failure, never stalls recall) |
| `compactAfterEvents` | `2000` | Compact the journal past this many live events; `0` disables |
| `archiveMaxSegments` | `16` | Upper bound on archive segments (oldest are merged, no seq lost); `0` = unbounded |
| `retainEvents` | `0` | The single lossy policy: keep only archives newer than N events; `0` = keep everything |
| `embedProvider` | `hash` | Vector backend to open with; a semantic backend can be installed at runtime |
| `reflectionEnabled` | `true` | Periodic reflection: question established beliefs whose evidence has visibly decayed (filed as draft hypotheses only) |

Also: `exposeAuditTool` / `exposeTuneTool` on the tools row; `lang` / `redaction` / `width` /
`auditRenders` and friends on the visualization row; see `window/README.md` for the window package.

## FAQ

**Does it slow recall down?** Strategy hooks have an 8 ms budget and a timeout counts as a failure; reads use a frozen snapshot and never lock.

**Will the store grow into a mess?** Lifecycle states, confidence, salience decay, expiry sweeps and counterfactual rethink are all explicit tools you can call to tidy up.

**Does uninstalling leave anything behind?** Each row releases the effects it created (tools, services, timers, routes, seats); once unloaded the journal handle is closed and the store directory can be deleted normally.

**Can I use a real semantic retriever?** Yes. Install a backend at runtime with `service.useEmbedder(...)`, then `reembed()` to recompute stored vectors. Until then the status view keeps reporting that stored vectors are stale.

**Why is the desktop window a separate package?** A package that declares `dsh.client` may own exactly **one** active Loader row, and the kernel is five rows (the preset mounts them again). That is a DSH constraint, so the window is a single-row sibling.

## License

[Apache License 2.0](LICENSE) © 2026 dsh-anagenesis contributors
