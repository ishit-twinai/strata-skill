# strata

**Answers "where do I start?" — the question you have *before* a code change.**

Describe a task in plain language. Get back the files to read, what breaks if you change them,
what historically changes alongside them that no dependency explains, and who owns each one —
including whether that person is still around.

```bash
node scripts/brief.mjs "change how invoice totals are rounded"
```

```
── ANCHORS (PROVISIONAL — you decide)
*  16.0  billing/totals.py
         path contains "total" · 94 term mention(s) · defines a symbol named after the task

── READ SET (4) — understand these before changing anything
  billing/totals.py          the change target itself
  billing/rounding.py        the target depends on this (depth 1)
  tests/test_totals.py       test covering billing/totals.py — extend this

── IMPACT SET (6) — what breaks
  d=1  WILL BREAK        billing/invoice.py
  d=2  LIKELY AFFECTED   api/invoices.py

── SURPRISE SET (1) — co-changes the graph does not explain
  reports/monthly.py
      9 joint commits with billing/totals.py · confidence 0.75 · p=3.1e-6

── OWNERSHIP IN SCOPE
  LIVE%  OWNER                 MINOR  COMMITS  FILE
      0  A. Rivera (departed)      3       41  billing/totals.py
  ⚠ primary owner departed: billing/totals.py (A. Rivera)
```

A skill for Claude Code and compatible agents. **Zero dependencies** — git, a POSIX shell, and
Node's standard library. No npm packages, no network, nothing to install, nothing phones home.

---

## Why this exists

Every comparable tool is **anchor-scoped**: you hand it a file path, a symbol, or a diff that
already exists. That means they answer *"I am making this change — what now?"*

None of them answers *"I need to make this change — where do I start?"*, because that requires
bridging a task description to the right anchors, and that step needs judgement about what the
task means. A skill has a reasoning model in the loop; a static indexer does not.

So strata splits the work deliberately: **scripts score, the model decides.** The anchor step
prints its evidence and marks itself `provisional`; you review it and re-run with `--anchor` to
confirm. Nothing pretends a ranking is a judgement.

### Two things it keeps separate that others merge

| | |
|---|---|
| **read set** | what to read to make the change safely — upstream deps, the canonical example, the test to extend |
| **impact set** | what breaks — downstream dependents, by depth |

Different questions, different answers. Most tools return one undifferentiated list of "related
files"; the closest prior art ships each half as a *separate command that never calls the other*.

---

## The research metrics

Five metrics with precise published definitions and — verified against the serious tools in this
space in Nov 2026 — **no open-source implementation anywhere**.

```bash
sh  scripts/blame-cache.sh HEAD . > blame.tsv    # once; the expensive step
node scripts/ownership-metrics.mjs --blame blame.tsv --map ids.tsv
node scripts/knowledge-at-risk.mjs --blame blame.tsv
```

**Bird ownership suite** — [Bird et al., ESEC/FSE 2011](https://www.microsoft.com/en-us/research/uploads/prod/2016/02/bird2011dtm.pdf)
`Minor` / `Major` / `Ownership` at a 5% commit-share threshold. On Windows Vista and 7, `Minor`
predicted defects **more strongly than size, churn, or complexity**. No library implements it.

**Decay-weighted knowledge** — [Jabrayilzade et al., ICSE-SEIP 2022](https://arxiv.org/pdf/2202.01523)
A **5-month half-life** on contribution knowledge, validated against 13 JetBrains projects. Every
other tool models knowledge loss as a step function — a binary "ex-developer" flag or a hard
90-day window. This is continuous, so a file last touched 18 months ago by someone who left reads
as nearly unknown rather than owned.

**Orphaned code** — [Izquierdo-Cortázar et al., HICSS 2009](https://ieeexplore.ieee.org/document/4755398),
corrected per [Nassif & Robillard, ICSME 2017](https://www.cs.mcgill.ca/~martin/papers/icsme2017.pdf)
Lines held by inactive contributors. Reports **persistent** abandonment measured at the analysis
ref — the original model overestimates loss by ignoring what happens after departure. The
actionable figure is `orphan × churn-rate × fan-in`: orphaned *and* still changing *and* depended
upon.

**Knowledge at Risk + Expected Shortfall** — [Rigby et al., ICSE 2016](https://dl.acm.org/doi/10.1145/2884781.2884851)
Value-at-Risk for knowledge loss. Monte-Carlo departures, then the α-percentile loss (KaR) and the
mean of the tail beyond it (ES). **ES is the point**: KaR bounds the tail, ES weighs it, so a repo
can carry a modest KaR and a severe ES. The authors published **pseudocode only**; a
[2019 survey](https://homepages.dcc.ufmg.br/~mtov/pub/2019-sqj.pdf) confirms no public
implementation, and that was still true on re-verification. Small sample spaces are enumerated
exactly rather than sampled; larger ones use a seeded PRNG, so results are reproducible.

**Propagation Cost + core-periphery** — [MacCormack, Rusnak & Baldwin, Management Science 2006](https://www.hbs.edu/ris/Publication%20Files/08-039_1861e507-1dc1-4602-85b8-90d71559d85b.pdf);
[Baldwin, MacCormack & Rusnak, *Hidden Structure*, 2014](https://dash.harvard.edu/bitstream/handle/1/10646422/baldwin,maccormack,rusnak_hidden-structure.pdf)
The average fraction of the system a random change can reach, plus the largest dependency cycle,
**trended across history**. Static-analysis tools compute the graph without history; history tools
compute churn without a graph — both halves are needed and neither ships this as a time series.
Deliberately omitted: Decoupling Level (Mo et al., ICSE 2016) is
[patent-encumbered](https://patents.google.com/patent/WO2017106863A1/en).

```bash
node scripts/propagation-cost.mjs --at monthly --no-tests
```

Every figure ships with its caveats attached. `references/metrics.md` carries the formulas,
citations, and what each paper did and did not show.

---

## Honest positioning

**The category is not novel.** It is called behavioural code analysis, it dates to
[code-maat](https://github.com/adamtornhill/code-maat) (2013) and *Your Code as a Crime Scene*, and
[CodeScene](https://codescene.com) is a whole company built on it.

**What strata deliberately does NOT reimplement**, because mature tools already do it well:
ownership maps, bus/truck factor (5+ OSS implementations), offboarding simulation, hotspots, plain
temporal coupling, identity consolidation as a *feature*, stranded-branch detection, and
stale-doc detection — [repowise](https://github.com/repowise-dev/repowise)'s `doc-drift` proves a
symbol was once defined via blame, which is better than anything worth building here.

**How it actually compares:**

| | strata | [repowise](https://github.com/repowise-dev/repowise) | [CodeLore](https://github.com/emrecdr/codelore) | [CodeScene](https://codescene.com) |
|---|---|---|---|---|
| Task description → brief | **yes** | no | no | no |
| read set ≠ impact set | **yes** | no | no | no |
| Hidden coupling (repo-wide) | — | yes | **yes** (Fisher) | no |
| Bird ownership suite | **yes** | no | no | no |
| Knowledge at Risk / ES | **yes** | no | no | no |
| Continuous knowledge decay | **yes** | no (90-day step) | no | no (by design) |
| Bus factor, hotspots, coupling | — | yes | yes | yes |
| Install footprint | zero deps | pip | binary | SaaS |

**The gap is narrow and could close.** repowise has both endpoints — `ask` for natural language,
`context` for fusion — and is one entrypoint away from bridging them. That is exactly why the
metric layer exists alongside the brief: it does not depend on the wedge holding.

**Credit where due.** [aider's chat-seeded PageRank](https://aider.chat/docs/repomap.html) is the
only precedent for task-biased ranking. CodeLore's Fisher-exact gating is the right statistical
choice and this adopts it. [GitNexus](https://claudemarketplaces.com/skills/abhigyanpatwari/gitnexus/gitnexus-impact-analysis)
states impact depth more usefully than most. OpenAI's
[security-ownership-map](https://github.com/openai/skills/tree/main/skills/.curated/security-ownership-map)
has the co-change hygiene spec worth copying rather than rediscovering. `references/prior-art.md`
records what verification found, tool by tool.

---

## Does it actually help? Measured, not asserted

The skill ships an A/B eval suite that runs each case **with and without** the skill loaded, so
its contribution is measurable rather than assumed. Here is the most recent run in full, including
the parts that do not flatter it.

| Case | With | Without | Δ |
|---|---:|---:|---:|
| detects-stale-local-refs | **1.00** | 0.67 | +0.33 |
| consolidates-split-identities | 0.89 | 0.56 | +0.33 |
| separates-read-set-from-impact-set | 0.75 | 0.67 | +0.08 |
| quantifies-knowledge-loss-risk | 1.00 | 1.00 | **0.00** |
| finds-work-stranded-off-mainline | 1.00 | 1.00 | **0.00** |

*5 cases · 30 runs · mean Δ +0.15*

**What this honestly shows.** One instruction is clearly load-bearing: making the model establish
its git ref before describing a codebase took that case from 0.67 to a clean 1.00. Beyond that,
the picture is thinner than the mean suggests.

**Two cases show no lift at all.** Both were written specifically to test things a plain agent
should not manage — quantifying knowledge loss with an abandonment threshold, and finding work
stranded on an unmerged branch invisible from the working tree. An unaided agent with shell access
scored 1.00 on both, across all six runs. The hypothesis about where the baseline fails was simply
wrong.

**The numbers are noisy.** On one case the *baseline* swung from 1.00 to 0.56 between runs with no
change to anything. At three runs per arm, a ±0.33 movement sits inside that variance, so none of
the deltas above — favourable ones included — should be read as settled. A real verdict needs
roughly ten runs per arm.

**The strongest evidence is qualitative, not aggregate.** In one run, the baseline asserted a
dependency between two files that have no import relationship, inferring causation from the fact
they change together. That is exactly the error the surprise set exists to prevent, and the skill
prevented it. A single observed failure of that kind is more informative about what this is for
than the mean delta is.

Reproduce it: `claude plugin eval . --allow-tools Write,Edit,Bash --scaffold`

---

## What it will not tell you

Stated plainly, because a tool that hides its limits is worse than one that lacks features:

- **"Owner" means wrote the most commits, not is responsible for.** Git cannot see who reviewed
  the code, who was on call for it, or who understands it best.
- **The dependency graph is not type-resolved.** Regex import extraction catches lazy imports at
  any indentation, but dynamic imports, DI containers and reflection are invisible. Every impact
  figure is a **floor**, never a ceiling.
- **The surprise set is correlation.** The Fisher test filters coincidence, not confounding — a
  shared release cadence produces co-change with no hidden dependency behind it.
- **Anchor scoring is name- and term-based.** A task phrased in domain language absent from the
  identifiers will score poorly. The evidence lines exist so you can see that happening.
- **Two metrics are deliberately absent because the literature says so.** Socio-technical
  congruence has a [null result against defects](https://arxiv.org/pdf/2105.08198) across 25
  projects; Conway's-law alignment
  [barely holds in open source](https://www.researchgate.net/publication/331872728_How_to_Verify_Conway's_Law_for_Open_Source_Projects),
  so weak alignment is the baseline rather than a finding. Shipping either as a predictor would
  contradict the papers it cites. Decoupling Level is omitted for a different reason: it is
  [patent-encumbered](https://patents.google.com/patent/WO2017106863A1/en).

---

## Install

```bash
git clone https://github.com/<you>/strata-skill ~/.claude/skills/strata
```

**The destination directory must be named `strata`**, not `strata-skill` — a skill is
loaded by its directory name, which has to match the `name:` field in `SKILL.md`. The
repository is called `strata-skill` only so it is findable on GitHub.

Or copy into a project at `.claude/skills/strata/` to share it with a team. Works with Claude Code
skills; the methodology and every script are agent-agnostic, and the scripts run standalone from
any shell with no agent at all.

## Tests

```bash
node tests/run.mjs
```

**68 known-answer assertions** against two synthetic fixtures that are the specification. The
fixtures plant each condition deliberately — a contributor just under the 5% minority threshold, a
departed sole author, a co-change pair with no import edge, a control pair with both signals.

The suite exists because four arithmetic bugs shipped in first drafts of these metrics, and every
one was caught by hand-checking a fixture against a figure computed on paper rather than by
anything noticing at runtime. The worst returned the **best** case as a 95th-percentile risk. It
has been mutation-tested to confirm it actually fails when those bugs are reintroduced.
`references/pitfalls.md` documents all nine failure modes, each reproducible from a fixture.

## Layout

```
SKILL.md                      the workflow an agent follows
scripts/brief.mjs             task → read set / impact set / surprise set / ownership
scripts/dep-graph.mjs         the authoritative dependency graph (JSON)
scripts/ownership-metrics.mjs Bird suite · decay · orphan
scripts/knowledge-at-risk.mjs KaR + Expected Shortfall
scripts/{pick-ref,repo-shape,identities,contributors,file-origins,blame-cache,dep-edges}.sh
scripts/lib/strata.mjs        shared primitives (graph, co-change, Fisher, ownership)
assets/force-graph.html       interactive graph template
references/                   metrics · pitfalls · prior-art · methodology
tests/run.mjs                 68 known-answer assertions
evals/                        5 cases in `claude plugin eval` format
```

## License

MIT. See `LICENSE`.
