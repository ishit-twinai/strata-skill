---
name: strata
description: Answers "where do I start?" before a code change, and maps repository structure and ownership. Given a task description it returns the files to READ, what will BREAK downstream, what co-changes that no dependency explains, and who owns each file and whether they are still active. Use whenever someone is about to change unfamiliar code and asks where to start, what to read first, what might break, the blast radius, or who to ask; wants to map, audit, document or onboard onto a codebase; needs an architecture doc, module map, dependency graph or call graph; needs code ownership, bus factor, knowledge risk or offboarding analysis; needs contributor or commit-history attribution; or mentions Graphify, repo mapping, codebase visualisation or hidden coupling. Also use before a refactor or handover, when joining an unfamiliar project, or when several contributors work needs untangling. Prefer it over ad-hoc greps when the answer should be grounded in both the dependency graph and git history.
compatibility: Needs git, a POSIX shell, and Node.js (standard library only - no npm packages, no network access, nothing to install).
metadata:
  author: Ishit Arhatia
  version: "2.0.0"
---

# Strata

A repository has two kinds of layers, and most "codebase map" attempts only show one.

**Structural layers** — what calls what, which module owns which responsibility, where the hubs
and the dead paths are. **Historical layers** — who laid each stratum down, in what order, and
who can still answer for it. Read together they answer the question people actually have, which
is rarely "what is the architecture" and almost always "what am I looking at, and who do I ask".

This skill produces both and joins them, so every module in the map carries who built it and who
last touched it.

## One gate, before any claim about a repository

**Know which ref you are describing.** Run `scripts/pick-ref.sh` *before* reading code or counting
anything, and **name the ref and its date in your answer**. A checkout days behind its remote
produces a confident description of a codebase that no longer exists, with every line number
wrong. If the script reports a stale fetch, say so and offer `git fetch --all --tags` rather than
quietly analysing stale refs. Stating the ref costs one sentence; omitting it leaves the reader
unable to tell whether your answer is current.

Running the script is not enough — the answer has to carry the ref, or nobody can tell that it
happened.

> This is the one instruction measured to change behaviour: in an A/B eval it took stale-ref
> detection from 0.67 to a clean 1.00 across every run. A second gate about identity
> reconciliation was tried here and **removed** — it left its own grader unchanged at 0.89 and
> plausibly displaced other work, since the one case it could not help regressed while it was in
> place. The identity instruction lives in Step 2 of the workflow, where it belongs; duplicating
> it at the top bought nothing. Earning a place in this section requires evidence, not plausibility.

## The task-scoped change brief

Reach for this first when someone is about to change code they do not know well — it is the one
thing here that comparable tools cannot do.

```
node scripts/brief.mjs "<task description>"
```

Every tool in this category is **anchor-scoped**: you hand it a file, a symbol, or a diff that
already exists (verified — see `references/prior-art.md`). They answer *"I am making this change,
what now?"*. This answers *"I need to make this change, where do I start?"*, which requires
bridging a task description to the anchors, and that is the step a reasoning model can do and a
static indexer cannot.

It emits four **deliberately distinct** sets:

| Set | Question |
|---|---|
| `anchors` | which files does this task actually mean — scored by evidence, **chosen by you** |
| `read_set` | what to read to make the change safely: upstream deps, the test to extend |
| `impact_set` | what breaks: downstream dependents by depth (`d=1` will break, `d=2` likely, `d=3` worth testing) |
| `surprise_set` | what co-changes with the target that **no dependency path explains** |

Plus ownership and liveness for everything in scope, flagging files whose owner has left and files
where **nobody who touched them is still active**.

`read_set` and `impact_set` are different questions and every other tool conflates them.

**The anchor step is a hybrid and that is the point.** The script scores candidates and prints its
evidence — path matches, term mentions, symbol definitions, graph centrality, maintenance activity.
It marks the result `provisional`. Read the evidence, decide which anchors the task really means,
then re-run authoritatively:

```
node scripts/brief.mjs --anchor path/to/file.py --anchor path/to/other.py
```

Do not skip that second call when the first ranking looks only approximately right. A task phrased
in domain language that does not appear in any identifier will score poorly, and the evidence
lines are there so you can see that happening rather than trusting a number.

## Research metrics

Five metrics with published definitions and no open-source implementation anywhere. Full formulas,
citations and caveats in `references/metrics.md`; cite the paper whenever you report a figure.

```
sh  scripts/blame-cache.sh <ref> <repo> > blame.tsv     # once; the expensive step
node scripts/ownership-metrics.mjs --blame blame.tsv --map ids.tsv
node scripts/knowledge-at-risk.mjs --blame blame.tsv
```

- **Bird ownership suite** (FSE 2011) — `Minor` / `Major` / `Ownership` at a 5% threshold. On
  Windows Vista and 7, `Minor` predicted defects better than size, churn or complexity.
- **Decay-weighted knowledge** (ICSE-SEIP 2022) — a 5-month half-life, so a file last touched 18
  months ago by someone who left reads as nearly unknown rather than owned.
- **Orphaned code** (HICSS 2009 / ICSE 2016, corrected ICSME 2017) — persistent abandonment, plus
  the `orphan × churn-rate × fan-in` combination that is actually worth acting on.
- **Knowledge at Risk + Expected Shortfall** (ICSE 2016) — Value-at-Risk for knowledge loss. The
  authors published pseudocode only; nothing implements it. ES is the point: KaR bounds the tail,
  ES weighs it.
- **Propagation Cost + core-periphery** (Management Science 2006; Hidden Structure 2014) — how far
  a random change can reach through the system, trended across history. Read it beside the file
  count: a repo that doubles in size can show a falling PC while absolute coupling rises.

```
node scripts/propagation-cost.mjs --at monthly --no-tests
```

Report these with their caveats attached, not as scores. Two related metrics are deliberately
**not** implemented because the literature has null results on them, and one is patent-encumbered —
`references/metrics.md` says which and why.

## What you produce

Three deliverables unless the user narrows the scope:

1. **`ARCHITECTURE.md`** — layered module map with per-module responsibility, upstream and
   downstream dependencies, hub analysis, coupling hotspots, and a live/prototype/dead/orphaned
   classification of every source file.
2. **`CONTRIBUTORS.md`** — identity consolidation, era timeline, per-person domain ownership and
   architectural legacy, and an ownership-heat table naming who to ask today.
3. **An interactive artifact** — a published page with a force-directed dependency graph
   (draggable, click-to-isolate) that can recolour by *layer* or by *owner*, plus contributor
   charts. Use `assets/force-graph.html` as the starting template.

Ask which of the three they want before building all of them; a user who only wants to know who
owns the auth code does not need an artifact.

## Workflow

Work in this order. Steps 0 and 1 exist because skipping them silently produces a confident map
of the wrong codebase — see `references/pitfalls.md` for what goes wrong and why.

### Step 0 — Establish the ref before measuring anything

```
scripts/pick-ref.sh
```

Reports: local branch and its date, every remote branch tip, how far behind local `main` is, when
the repo was last fetched, and whether the working tree is dirty.

**If the last fetch is more than a few days old, stop and offer to `git fetch --all --tags`.**
Analysing stale refs is the single most expensive mistake available here — it can hide months of
work by whoever is currently most active, and every line number you record will be wrong.
Fetching only updates remote-tracking refs: it touches no files and moves no branches, so it is
safe to offer, but ask first because it is still a network operation on someone else's repo.

Then pick the ref deliberately. The right one is usually the **active integration branch**
(often `origin/main`), not whatever happens to be checked out. State which ref you chose in every
deliverable, with its date.

Analyse a non-checked-out ref without disturbing the working tree:
`git show <ref>:<path>` and `git ls-tree -r --name-only <ref>`.

### Step 1 — Measure the repo's shape

```
scripts/repo-shape.sh <ref>
```

Separates real source from assets (line counts on binaries are meaningless), lists the largest
source files, counts functions, and flags any file large enough to dominate the repo.

**The shape dictates the unit of analysis.** If one file holds a large share of the source, a
per-file map makes that share a black box, and per-file *attribution* becomes useless because
everyone "owns" it. When you hit that case, map and attribute by **region** inside the file
instead — keyed off its own router or dispatch table where it has one — and say so in the method
note. Ask the user to confirm the granularity; roughly 25–35 nodes is the readable range.

### Step 2 — Consolidate contributor identities

```
scripts/identities.sh <ref>          # list every identity with counts, and suggest groupings
scripts/contributors.sh <ref> map.tsv  # aggregate using a confirmed mapping
```

One person routinely has several identities (work email, personal email, a renamed account, a CI
bot). `identities.sh` proposes groupings from shared email local-parts and name tokens, but
**never let the grouping stand unconfirmed** — the suggestions are heuristic and real names defeat
them. Show the proposal to the user and have them confirm.

`contributors.sh` enforces the check that catches an incomplete mapping: **every identity must
resolve through the confirmed mapping.** An identity you forgot does not vanish — it falls through
to its raw git name and appears as an extra "person", quietly splitting someone's record in two.
The script lists any such identity and exits non-zero; fix the mapping and re-run before reporting
figures to anyone. Run without a mapping and it tells you the rows are raw identities rather than
people, which is a starting point and not a result.

Name bots and CI accounts as such rather than listing them as people.

### Step 3 — Establish ownership

```
scripts/file-origins.sh <ref>
```

Who *created* each file (`git log --diff-filter=A`, last entry). File creation is a far better
ownership signal than churn: a refactor that moves 20,000 lines produces enormous churn without
conferring authorship of anything, while the person who created a module usually designed it.

Report both, and keep them distinct:
- **Built by** — who created it. History.
- **Ask** — who last touched it, and is still active. Who can answer today.

The gap between those two columns is the most actionable thing in the whole analysis.

### Step 4 — Derive dependency edges from source

```
scripts/dep-edges.sh <ref>
```

Extracts Python imports, JS/TS imports and requires, `<script src>` tags, and HTTP endpoint call
sites. Read the output, don't paste it: the point is a curated graph, not every edge.

**Catch lazy imports.** Imports nested inside functions — common for slow or optional
dependencies — are invisible to a `^import` pattern, and the script deliberately matches any
indentation. A top-level-only scan of a Flask app routinely reports that the main module depends
on nothing, which is both obviously false and easy to publish by accident.

Prefer verified edges over plausible ones. Where you include an inferred edge (a page "uses" a
script it loads, say), say in the caption that the graph mixes imports, script tags and call
sites, so nobody reads it as a pure import graph.

### Step 5 — Responsibilities in the module's own words

Pull each module's docstring or header comment rather than inferring purpose from its filename:

```
git show <ref>:<path> | head -12
```

A filename says `risk_engine`; the docstring says *factor extraction, TOPSIS ranking, Monte-Carlo
simulation, tornado and what-if* — which is the sentence worth putting in the map. Where a module
has no docstring, read enough of it to write one honestly, and don't dress up a guess as a quote.

### Step 6 — Hubs, coupling and classification

**Hubs**: rank nodes by in-degree. The interesting hub is rarely the obvious one — a DB handle
with the highest in-degree surprises nobody, whereas a quota or permission gate that three
unrelated features structurally depend on is a genuine finding.

**Coupling hotspots**: in codebases with a shared mutable global (a client-side `App` object, a
module-level singleton, a context), count references per key. That ranking is where
cross-feature breakage comes from and no AST graph shows it.

**Classification**: label every source file **live / prototype / dead / orphaned**, and verify
rather than assume — grep the server or entry point for each candidate. Two cases worth calling
out explicitly because they mislead readers:
- *registered but uncalled* — wired up and reachable, with no caller;
- *orphaned* — exists only on an unmerged branch, so it is absent from the real codebase.

### Step 7 — Build the deliverables

Write the markdown first; it is the source of truth and the artifact is derived from it.

For the artifact, copy `assets/force-graph.html` and replace the `__STRATA_DATA__` marker with
your node and edge arrays. Before publishing, run:

```
node scripts/validate-graph.mjs <your-file>.html
```

It checks for out-of-range indices, self-edges, duplicate edges and orphan nodes, and prints the
in-degree ranking so the numbers in your prose match the data. Quote its in-degree figures rather
than your own recollection.

Read `assets/force-graph.html`'s header comment for the data format and the available knobs.

## Reporting

Lead with what changes the reader's mind, not with method. In practice the headline is usually one
of: a contributor whose share is nothing like expected; work stranded on an unmerged branch; a
restructuring that moved a problem rather than fixing it; or a hub nobody knew was load-bearing.

State the analysis ref and date everywhere. If you corrected your own earlier numbers — which
happens whenever a fetch lands mid-analysis — say so plainly and give the corrected figure; a
quietly revised number is worse than an acknowledged mistake.

Give churn its caveat wherever you cite it: insertions plus deletions counts a refactor as heavily
as new work, so a large number is not automatically a large contribution.

## The dependency graph

`scripts/dep-graph.mjs` is the **single authoritative** graph builder. Everything needing edges
consumes its JSON, so there is one definition rather than several free to drift:

```
node scripts/dep-graph.mjs --format json > graph.json
node scripts/validate-graph.mjs graph.json
node scripts/ownership-metrics.mjs --metric orphan --blame blame.tsv --fanin graph.json
```

`dep-edges.sh` remains for *reading* — it reports lazy imports per file, route declarations and
endpoint call sites, which a shell pass does well. It no longer defines the graph.

Edges come from regex import extraction at any indentation, `<script src>` tags and resolved
relative specifiers. They are **not type-resolved**: dynamic imports, DI containers and reflection
are invisible, so any impact figure derived from this is a floor, never a ceiling. Say so when you
report one.

## Before you change anything here

```
node tests/run.mjs
```

68 known-answer assertions against both fixtures, which are the specification. If one fails, check
the arithmetic before changing the expectation.

The suite exists because four arithmetic bugs shipped in first drafts of these metrics, and every
one was caught by hand-checking a fixture against a figure computed on paper — not by anything
noticing at runtime. The worst returned the **best** case as a 95th-percentile risk.
`references/pitfalls.md` §9 describes all four; the suite asserts against each, and has been
mutation-tested to confirm it genuinely fails when they are reintroduced.

## Reference files

| File | Read it when |
|---|---|
| `references/pitfalls.md` | Before your first run, and whenever a number looks surprising. Nine failure modes, each with the check that catches it, all reproducible from the fixtures. |
| `references/metrics.md` | Before reporting any metric figure — it carries the formula, the citation, and what the paper did and did not show. |
| `references/prior-art.md` | Before claiming anything is novel, and when positioning the work. Verified by running the tools, not reading their marketing. |
| `references/methodology.md` | When you need the exact git invocations, the deliverable templates, or the rationale for a step. |
| `assets/force-graph.html` | Before building the artifact — its header documents the data format. |
