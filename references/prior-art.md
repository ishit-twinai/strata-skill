# Prior art — verified, not assumed

Every claim here was checked by installing and running the tool or reading its source, not taken
from its marketing. Verified 2026-11-05. Re-verify before trusting it: this category is moving
fast, and two of the three serious entrants appeared within the last twelve months.

**Why this file exists.** Anyone evaluating a codebase-analysis tool will recognise the category
immediately. Naming the prior art honestly costs less than overclaiming and being corrected.

## Contents

- [The category is not novel](#the-category-is-not-novel)
- [What is commoditised](#what-is-commoditised)
- [repowise — verified](#repowise--verified)
- [CodeLore — verified](#codelore--verified)
- [The agent-skill cohort](#the-agent-skill-cohort)
- [What strata does differently](#what-strata-does-differently)
- [Licensing](#licensing)

## The category is not novel

It has a name — **behavioural code analysis** — and a canonical origin: Adam Tornhill's
[code-maat](https://github.com/adamtornhill/code-maat) (2013) and *Your Code as a Crime Scene*,
commercialised as [CodeScene](https://codescene.com). Mining git history for ownership, hotspots
and coupling has been table stakes for over a decade.

## What is commoditised

Do not build these. Each has multiple mature implementations:

| Capability | Where it already lives |
|---|---|
| Ownership / knowledge maps | CodeScene, CodeLore, repowise, code-maat, Sourcegraph |
| Bus / truck factor | 5+ OSS tools (aserg-ufmg/Truck-Factor, HelgeCPH/truckfactor, JetBrains bus-factor-explorer, …) |
| Offboarding simulation | CodeScene, CodeLore, JetBrains bus-factor-explorer |
| Hotspots (churn × complexity) | CodeScene, CodeLore, repowise, GitClear |
| Temporal / change coupling | code-maat, CodeScene, CodeLore, repowise, hercules |
| Identity consolidation | CodeScene, CodeLore, repowise, hercules — it is plumbing, never a feature |
| Stranded branch work | CodeScene Branch Analyses, repowise `overlap` |
| Stale-doc detection | repowise `doc-drift` (blame-proves a symbol was once defined), Swimm |
| Refactor-aware churn | GitClear Diff Delta (closed SaaS) — the only real implementation |

## repowise — verified

[repowise-dev/repowise](https://github.com/repowise-dev/repowise) · AGPL-3.0 · ~8k stars ·
`uv tool install repowise`

Installed and inspected. **Far larger than its docs suggest: ~50 subcommands**, plus an MCP
server, a Claude Code plugin, and a VS Code extension. Genuinely agent-facing by design. This is
the most serious prior art in the space.

Relevant commands: `ask`, `context`, `risk`, `overlap`, `impacted-tests`, `next`, `doc-drift`,
`dead-code`, `health`, `events`, `suspects`, `security`, `components`, `decision`, `coverage`,
`mcp`, `generate-claude-md`.

**What every input accepts — this is the decisive finding:**

| Command | Input | Returns |
|---|---|---|
| `context TARGETS...` | **file paths, module paths, or `file.py::Symbol`** | Triage card. `--include ownership,callers,callees,references,metrics,suspects,doc_drift,changes,provenance` |
| `ask QUESTION` | natural language | LLM-synthesised prose **answer with citations**. Costs an LLM call |
| `risk [REVSPEC]` | a commit, a `base..head` range, or uncommitted work | change score by size and spread |
| `risk --target PATH` | **file paths** | what history says about those files |
| `risk --target X --changed-file Y` | file paths | PR-mode directive: review candidates, **missing co-changes**, tests to run |
| `overlap` | a branch | other branches editing the same files |
| `impacted-tests [REVSPEC]` | a diff | tests whose coverage intersects it |
| `context --symptom TEXT` | free text | ranks **suspect commits** for that error or stack trace |

**Conclusion: every change-oriented command needs the change to already exist** (a diff, a branch,
a commit) **or needs you to name the files yourself.** The one command taking natural language
(`ask`) returns prose, not a structured brief. `--symptom` takes free text but answers a debugging
question — which commit caused this error — not a change-planning one.

Put plainly: **repowise answers "I am making this change, what now?" It cannot answer "I need to
make this change, where do I start?"**

Its ownership model is the strongest in the field and should be treated as the bar: `primary_owner`,
`owner_pct`, `owner_line_pct`, `bus_factor`, and `recent_owner` / `recent_owner_pct` over a 90-day
window, surfaced *only when it differs from the primary owner* — i.e. it explicitly flags handover.
Plus a `knowledge_loss` detector (file still changing + bus factor 1 + primary ≠ recent owner) that
correctly suppresses on stable files, and typed contributor `kind` (human / bot / agent).

It is also admirably honest in its own docs, and strata should match the standard: *"'owner' means
'wrote the most commits or lines', not 'is responsible for'."*

## CodeLore — verified

[emrecdr/codelore](https://github.com/emrecdr/codelore) · **GPL-3.0-only** · 5 stars, 1 fork —
but 966 commits, full test suite, SLSA Build L3 provenance, Homebrew + binstall + container
distribution. **Judge it by the engineering, not the star count.** A credible production tool with
almost no third-party validation yet.

40+ analyses via `codelore analyze --analysis NAME`. Builds a **real static import graph**
(Rust, Python, Java, JS, TS via a vendored `rust-code-analysis` fork).

Two findings that directly affect strata's scope:

1. **`modularity-violations` ships exactly the "surprise set".** Co-change pairs that are
   **Fisher-exact significant with no import edge** between them. Its dependency matrix also has a
   structure×history fusion mode covering the inverse case (imports that never co-change). So
   *repo-wide* hidden coupling is **not** a gap, and CodeLore's Fisher-exact test is more rigorous
   than naive support/confidence thresholds. Adopt the statistics, not the code.
2. **No natural-language input.** Requires `--analysis NAME`, `--target <path>`,
   `--expression-to-match REGEX`. Its `--llm` flag goes **evidence → narrative**, never narrative →
   evidence. The same one-way direction as repowise's `ask`.

Also computes: ownership as Fractal Value (1 − HHI) plus main-author, per-module bus factor
(Filatov 2010), auto-detected knowledge islands where the primary author departed, and
`code-familiarity` / `team-composition` with tenure buckets.

**Does not compute** (confirmed): the Bird et al. `Minor`/`Major` suite, the Rigby Knowledge-at-Risk
Monte Carlo, or a continuous knowledge-decay half-life.

## The agent-skill cohort

| Tool | What it does | Input |
|---|---|---|
| [act101](https://github.com/act101-ai/act101) | `onboarding-map` gives an ordered reading list **with owners and risk flags**; `change-impact` gives dependents + risk verdict. **Two separate skills that never talk.** The cleanest demonstration of the gap. | repo-scoped / file or `file::symbol` |
| [SourceAtlas](https://github.com/lis186/SourceAtlas) | `impact` is **pure static analysis, zero git**; `history` shells out to code-maat. The two never merge — `impact` only *suggests* running `history` afterwards. | a file path |
| [Graphify](https://github.com/Graphify-Labs/graphify) | AST knowledge graph, `query` / `path` / `explain`. **No git history, no ownership, no blast-radius computation** despite the marketing. | a node or a query |
| [OpenAI security-ownership-map](https://github.com/openai/skills/tree/main/skills/.curated/security-ownership-map) | The most rigorous ownership skill: bipartite people↔files graph, co-change via Jaccard, bus factor, orphaned sensitive code. Ships `query_ownership.py` to return bounded JSON slices — the right agent-facing pattern. **No dependency graph; never parses code.** | anchor-scoped queries |
| [aider repo map](https://aider.chat/docs/repomap.html) | **The only precedent for task-biased ranking**: PageRank personalised by the files and identifiers currently in the chat. But it emits symbols for context stuffing under a token budget, never a justified read-set, and has no ownership or impact dimension. | implicit, from chat state |
| [Serena](https://github.com/oraios/serena) | LSP-exact `find_referencing_symbols` — the right primitive for a read-set, but selection is deliberately left to the agent. No git, no ownership. | a symbol |
| [GitNexus](https://claudemarketplaces.com/skills/abhigyanpatwari/gitnexus/gitnexus-impact-analysis) | Best blast-radius framing found: `d=1 WILL BREAK`, `d=2 LIKELY AFFECTED`, `d=3 MAY NEED TESTING`, and flags `UNKNOWN` when callers cannot be resolved. Worth adopting openly. | a symbol or staged diff |

**Dead or receding — do not benchmark against these:** Sourcegraph Cody (discontinued July 2025;
Amp spun out as a separate company Dec 2025), Continue's `@Codebase` (deprecated Oct 2026),
CodeSee (acquired by GitKraken 2024, sunset).

## What strata does differently

After verification, three things survive — stated narrowly, because the honest version is narrow:

1. **Task-first rather than anchor-first.** Every tool above requires an anchor (a path, a symbol,
   a diff, a branch) or returns prose. The bridge from a task description to the anchor set is
   unbuilt, and it is where a *skill* structurally beats an indexer — a skill has a reasoning model
   in the loop. aider's chat-seeded PageRank is the only precedent, and it was never exposed as an
   answer.
2. **Read-set and impact-set as distinct outputs.** "What should I read to do this safely" (upstream
   deps, the canonical example, the test to extend) is a different set from "what will break"
   (downstream dependents). Every tool conflates them; act101 ships each in a different skill.
3. **Research metrics with no implementation anywhere** — the Bird et al. ownership suite, Rigby's
   Knowledge-at-Risk with Expected Shortfall, and the Jabrayilzade 5-month decay half-life. See
   `metrics.md`. This is the hedge: it does not depend on the wedge holding.

**What is explicitly *not* a differentiator**, so nobody is misled:
repo-wide hidden coupling (CodeLore ships it, with better statistics), owner liveness as a
computation (repowise ships it — strata's contribution is surfacing it *inside a change brief*),
and every row in the commoditised table above.

**The wedge is narrow and could close.** repowise has both endpoints — `ask` for natural language,
`context` for fusion — and is one entrypoint away from bridging them. That is precisely why the
research-metric layer exists alongside it.

## Licensing

strata is MIT. **repowise is AGPL-3.0 and CodeLore is GPL-3.0-only.** Never copy code from either.
Reading their documentation to learn *what* to compute is fine — and the metrics themselves come
from published papers, not from these tools — but no code, no vendored files, no derived
translations.
