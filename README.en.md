# dsh-anagenesis

[中文](README.md) · [Changelog](CHANGELOG.md) · MIT

[![npm](https://img.shields.io/npm/v/dsh-anagenesis?label=npm&color=cb3837)](https://www.npmjs.com/package/dsh-anagenesis)
[![npm (window)](https://img.shields.io/npm/v/dsh-anagenesis-window?label=window&color=cb3837)](https://www.npmjs.com/package/dsh-anagenesis-window)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](package.json)

> **Memory your agent actually owns — and you can actually see.**
>
> Not another "automatic memory black box". Memory operations are tools the agent calls on purpose,
> the injection strategy is switchable at runtime, every change comes with its inverse, self-tuning is
> bounded, audited and revertible — and the whole store is self-contained, offline and dependency-free.

![The anagenesis desktop window — dashboard](assets/dashboard.png)

## What it is, in three lines

- **A self-contained store**: an append-only `journal/*.jsonl` plus atomic snapshots. It never calls, bridges or proxies an external memory service — no database, no cloud, no model calls.
- **Memory as tools the agent drives** (17 `ana_*` tools): recall is shaped by **intent** (`orient`, `recall_precedent`, `avoid_mistake`, `reuse_procedure`, …), not by background extraction.
- **It governs its own behaviour, too**: switchable injection stacks, bounded meta-level self-tuning, a monotonic guard, and a revertible history for all of it — with a trail you can audit.

## How it differs from a typical "automatic memory" plugin

| Dimension | Typical automatic memory | anagenesis |
|---|---|---|
| Who decides what is stored | Background extraction; the agent is not involved | **The agent decides, with tools**: `ana_remember`, `ana_promote`, `ana_split`, `ana_rethink`, `ana_forget` |
| How recall works | Keyword or vector similarity | **Intent-driven**: 7 intents expand into kinds, states, confidence floor, weights, granularity, token budget, diversity |
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

## Capability map (17 tools)

| Group | Tools | What they do |
|---|---|---|
| Recall & feedback | `ana_recall` · `ana_feedback` | Retrieve by intent; tell the system whether what it injected was actually useful |
| Writing & lifecycle | `ana_remember` · `ana_promote` · `ana_demote` · `ana_lock` · `ana_expire` · `ana_forget` | `draft → active → verified → locked`, plus demote / expire / delete (deletion leaves an auditable tombstone) |
| Structure | `ana_link` · `ana_split` · `ana_rethink` | Link beliefs; split an overloaded memory into narrower ones; **counterfactual rethink** (what follows if the premise is false) |
| Governance | `ana_strategy` · `ana_tune` · `ana_audit` | Switch or derive strategies; meta-level tuning and rollback; inspect state, journal, audit trail and health |
| Visualization | `ana_dashboard` · `ana_diagram` · `ana_window` | Dashboard, text diagrams, desktop window (each of the last two belongs to its own row — no row, no tool) |

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
  journal/journal-000001.jsonl     append-only event log (seq / type / patch / undo)
  journal/archive-<seq>.jsonl      folded archives (the `undo` is kept)
  journal/checkpoint-<seq>.json    frozen state at a boundary
  snapshot.json                    atomic startup cache
```

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

MIT
