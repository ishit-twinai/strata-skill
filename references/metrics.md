# Metrics

Every metric here has a published definition and a citation. Quote the citation alongside the
number — it is what separates this from a dashboard of invented scores, and it tells a reader what
the figure has and has not been shown to predict.

Verified 2026-11 against the serious tools in the category (`prior-art.md`): none of B1–B5 below
is implemented in any open-source tool. Plain temporal coupling, bus factor, hotspots and
ownership maps *are* — those are deliberately not reimplemented here.

## Contents

- [B1 Bird ownership suite](#b1--bird-ownership-suite)
- [B2 Decay-weighted knowledge](#b2--decay-weighted-knowledge)
- [B3 Orphaned code](#b3--orphaned-code)
- [B4 Knowledge at Risk and Expected Shortfall](#b4--knowledge-at-risk-and-expected-shortfall)
- [B5 Propagation Cost and core-periphery](#b5--propagation-cost-and-core-periphery)
- [Co-change and the surprise set](#co-change-and-the-surprise-set)
- [Deliberately not implemented](#deliberately-not-implemented)
- [Arithmetic that goes wrong](#arithmetic-that-goes-wrong)

---

## B1 — Bird ownership suite

**Bird, Nagappan, Murphy, Gall, Devanbu.** *Don't Touch My Code! Examining the Effects of
Ownership on Software Quality.* ESEC/FSE 2011.
<https://www.microsoft.com/en-us/research/uploads/prod/2016/02/bird2011dtm.pdf>

```
ownership(d,c) = commits by d to c / total commits to c        # commits, NOT lines
Minor(c)       = |{ d : ownership(d,c) <  0.05 }|
Major(c)       = |{ d : ownership(d,c) >= 0.05 }|
Ownership(c)   = max_d ownership(d,c)
```

**What the paper found.** On Windows Vista and Windows 7, `Minor` correlated with pre-release
faults and post-release failures **more strongly than size, churn, or complexity**. The suggested
action is operational, not architectural: changes from minor contributors deserve review by a
major contributor.

**Caveat that must travel with it.** Foucault, Falleri & Blanc (EASE 2014 / IST 2015) found these
metrics much weaker in open source, where a long tail of drive-by contributors saturates `Minor`.
`ownership-metrics.mjs` therefore reports `minor_pctile`, a within-repo percentile rank, which
stays usable where the absolute count does not.

Run: `node ownership-metrics.mjs --metric bird --map ids.tsv`

---

## B2 — Decay-weighted knowledge

**Jabrayilzade, Evtikhiev, Tüzün, Kovalenko.** *Bus Factor In Practice.* ICSE-SEIP 2022.
<https://arxiv.org/pdf/2202.01523>

```
knowledge(d,f,t) = SUM over d's commits c to f of   2^( -months_ago(c) / 5 )
lambda = ln2 / 5 months  ~ 0.1386 / month
```

A **5-month half-life**, validated against 13 JetBrains projects. The paper also weights non-commit
sources (code review 0.403, code comments 0.222, meetings 0.214); only the commit term is
implemented here, because the rest is not in git.

**Why it matters.** Every tool in the category models knowledge loss as a *step*: CodeScene marks
an `Ex-Developer`, repowise uses a 90-day `recent_owner` window, CodeLore flags knowledge islands.
CodeScene is explicitly anti-decay by design, holding that the original author retains credit.
A continuous decay function is not shipped anywhere, and it is what makes
`live_knowledge_share` — how much of what is known about a file is still held by someone present —
expressible at all.

Run: `node ownership-metrics.mjs --metric decay --half-life 5`

---

## B3 — Orphaned code

**Izquierdo-Cortázar, Robles, Ortega, González-Barahona.** *Using Software Archaeology to Measure
Knowledge Loss in Software Projects Due to Developer Turnover.* HICSS 2009.
Threshold from **Rigby et al.**, ICSE 2016. Correction from **Nassif & Robillard**, ICSME 2017.
<https://www.cs.mcgill.ca/~martin/papers/icsme2017.pdf>

```
active(d)    = d has >= 1 commit within W days of as-of      (W = 365 default)
orphan(f)    = lines blamed to inactive devs / total lines in f
abandoned(f) = orphan(f) >= 0.90
risk(f)      = orphan(f) * churn_rate(f) * (fan_in(f) + 1)
```

**The Nassif & Robillard correction matters.** The original model counts files abandoned *in a
period* and so overestimates loss: it ignores what happens afterwards, and many abandoned files are
either re-touched (knowledge recovered) or never touched again (the loss is irrelevant). This
implementation measures orphan state **at the analysis ref**, so what it reports is *persistent*
abandonment.

`risk(f)` is the combination worth acting on — orphaned **and** still changing **and** depended
upon. `churn_rate` is commits per month over the component's observed lifespan, not a raw commit
count: a count ranks a long-settled file with much old history above a file being churned now,
which inverts the signal.

Run: `sh blame-cache.sh <ref> <repo> > blame.tsv && node ownership-metrics.mjs --metric orphan --blame blame.tsv`

---

## B4 — Knowledge at Risk and Expected Shortfall

**Rigby, Zhu, Donadelli, Mockus.** *Quantifying and Mitigating Turnover-Induced Knowledge Loss.*
ICSE 2016. <https://dl.acm.org/doi/10.1145/2884781.2884851>

```
for k in 1..K:
    for each scenario (enumerated if few, else `trials` random samples):
        S    = a set of k active developers who depart
        loss = |{ f : orphan(f | S departed) >= 0.90 }|
    KaR_a(k) = nearest-rank a-percentile of the loss distribution
    ES_a(k)  = mean( loss | loss >= KaR_a(k) )
successor(f) = a second developer holding >= 10% of f  ->  f survives one departure
```

A Value-at-Risk analogue for knowledge. Where bus factor gives a single number that says nothing
about consequence, KaR says *how much is lost*, and ES says *how bad the bad case is*. **ES is the
point of the metric**: KaR is the boundary of the tail, not its weight, so a repo can carry a
modest KaR and a severe ES.

The authors released **pseudocode only**, and the 2019 comparative survey
(<https://homepages.dcc.ufmg.br/~mtov/pub/2019-sqj.pdf>) confirms no public implementation. That
remained true on re-verification in 2026-11 against repowise and CodeLore, both of which compute
bus factor and knowledge islands and neither of which computes KaR or ES.

Two implementation notes:
- The sample space is enumerated **exhaustively** when it is small (≤ 2000 combinations), so the
  answer is exact and seed-independent rather than approximate.
- Otherwise a **seeded** PRNG drives the sampling, so results are reproducible and testable.

The `files_without_successor` list is the actionable output: adding a second substantive
contributor to those files is the cheapest mitigation available, and the one Rigby et al. measured
as effective (up to ~15% reduction in expected loss).

Run: `node knowledge-at-risk.mjs --blame blame.tsv --alpha 0.95`

---

## B5 — Propagation Cost and core-periphery

**MacCormack, Rusnak & Baldwin.** *Exploring the Structure of Complex Software Designs.*
Management Science 2006.
<https://www.hbs.edu/ris/Publication%20Files/08-039_1861e507-1dc1-4602-85b8-90d71559d85b.pdf>
**Baldwin, MacCormack & Rusnak.** *Hidden Structure.* 2014.
<https://dash.harvard.edu/bitstream/handle/1/10646422/baldwin,maccormack,rusnak_hidden-structure.pdf>

```
V    = transitive closure of the dependency matrix
PC   = density(V) = reachable pairs / N^2
Core = largest strongly connected component (files that can reach themselves)
VFI(f) = files that can reach f        VFO(f) = files f can reach
quadrants: Hub (high both) · Shared (high VFI) · Control (high VFO) · Periphery (low both)
```

PC answers *"if I change something at random, how much of this system can the change reach?"*
Trended across history it is an erosion curve: a rising PC means the architecture is losing its
ability to contain change.

**Read it next to the file count, always.** PC is scale-sensitive — a repository that doubles in
size can show a *falling* PC while absolute coupling rises. Observed in practice: a codebase went
22 → 73 files with edges rising 27 → 111, and PC fell 0.089 → 0.035. Coupling quadrupled while the
ratio halved; reporting the ratio alone would have been actively misleading.

**Sampling is by position in the first-parent chain, not by date.** Author dates stop tracking
commit order after any rebase or cherry-pick, so date-bucketed snapshots can land at an arbitrary
point in history — on a fixture with deliberately out-of-order dates, date sampling measured a
two-file graph as the latest state of a four-file repo. `--at monthly` buckets by *committer* date
along first-parent, for when evenly spaced positions cluster badly in time.

Neither metric appears as a time series in any tool found: static-analysis tools build the graph
without history, and history tools measure churn without a graph.

Run: `node propagation-cost.mjs --at monthly --no-tests`

## Co-change and the surprise set

**Zimmermann, Weißgerber, Diehl, Zeller.** *Mining Version Histories to Guide Software Changes.*
TSE 2005. **Wong, Cai, Kim, Dalton.** *Detecting Software Modularity Violations.* ICSE 2011 (the
`Clio` tool, never publicly released).
<https://web.cs.ucla.edu/~miryung/Publications/icse11-modularityviolation.pdf>

```
support(f,g)   = |commits touching both f and g|
confidence(f->g) = support(f,g) / support(f)                  # asymmetric
fisher_p       = one-tailed Fisher exact on [[both, aOnly],[bOnly, neither]]

surprise(f,g) <=> support >= min-support
                 AND fisher_p <= max-p
                 AND no path f..g in the import graph within depth 3
```

**The literature's load-bearing finding:** a majority of co-evolving files are *not* structurally
linked, and stronger structural coupling does not imply higher co-change likelihood (Ajienka &
Capiluppi, JSS 2017). Zimmermann put it as mined rules showing coupling "undetectable by program
analysis". So the co-change set and the dependency set genuinely differ, and the difference is the
interesting part.

**Honest scoping.** CodeLore ships the repo-wide form of this as `modularity-violations`, gated on
Fisher significance — so the *idea* is not new, and this implementation adopts its statistical
choice rather than a bare support threshold. What is new here is computing it **relative to a
task's anchors** inside a change brief, rather than as a repo-wide report.

**Hygiene is not optional.** Without it this metric is noise: a lockfile or CI config touched by
every commit couples everything to everything, and one 400-file release commit does the same. The
implementation caps commit group size (`--max-files`, default 25), excludes glue files, and filters
bots — following the spec in OpenAI's `security-ownership-map` skill rather than rediscovering it.

**What it is not.** Correlation. The Fisher test filters coincidence, not confounding — a shared
release cadence produces co-change without any hidden dependency.

---

## Deliberately not implemented

| Metric | Why not |
|---|---|
| Truck / bus factor | Five or more OSS implementations (aserg-ufmg, HelgeCPH, JetBrains bus-factor-explorer, bussybussy, GReMCat). Saturated. |
| Plain temporal coupling | code-maat, CodeScene, CodeLore, repowise, hercules. Table stakes since 2013. |
| Hotspots (churn × complexity) | CodeScene, CodeLore, repowise, GitClear. |
| Stale-doc detection | repowise `doc-drift` blame-proves that a symbol was once defined; Swimm is the commercial incumbent. Better than anything worth building here. |
| Socio-technical congruence | Computable (`CR = TA·TD·TAᵀ`, Cataldo ESEM 2008), but Mauerer et al. (<https://arxiv.org/pdf/2105.08198>, 25 projects) found **no** relationship to bugs or churn. If ever added it ships as a descriptive map with that null result stated, never as a predictor. |
| Conway's-law alignment | Kamola (IEEE Access 2019) found OSS projects hardly obey Conway's law — weak alignment is the *baseline*, not a finding. Same treatment required. |
| **Decoupling Level** | **Patent-encumbered**: [WO2017106863A1](https://patents.google.com/patent/WO2017106863A1/en). Use Propagation Cost (MacCormack 2006) or core-periphery (Baldwin 2014) instead, which are unencumbered. |

---

## Arithmetic that goes wrong

All three of these shipped in a first draft here and were caught only because the fixtures had
known answers. See `pitfalls.md` §9.

- **Percentiles by array index** assign different percentiles to identical values. Use a tie-aware
  percentile *rank* — the fraction of values strictly below.
- **Silent tie-breaks** turn hash-map iteration order into a finding. Break ties deterministically
  and report that it was a tie.
- **`floor(alpha * (N-1))`** collapses to index 0 on small samples and returns the *best* case as
  the 95th percentile. Use nearest-rank `ceil(alpha * N) - 1`, and unit-test N=1, N=2 and
  all-identical inputs.
