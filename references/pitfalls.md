# Pitfalls

Nine failure modes, each with the check that catches it. The first two invalidate an entire
analysis; the rest corrupt individual findings.

**Every example below is reproducible from the fixtures in `evals/`.** No figure here comes from a
private repository — run the fixture and watch the failure happen rather than taking an anecdote on
trust. The two builders are `evals/consolidates-split-identities/files/build-repo.sh` (the
*history fixture*) and `evals/computes-bird-ownership/files/build-metrics-repo.sh` (the *metrics
fixture*).

## 1. Analysing a stale ref

**What happens.** You measure the checked-out branch. It has not been fetched for weeks. The
conclusions describe a codebase that no longer exists, and every line number you record is wrong.

**Reproduce it.** The history fixture puts local `main` two commits behind `origin/main` and
back-dates `.git/FETCH_HEAD`. From the checkout you see 12 commits; across all refs there are 14,
and the two you cannot see are a contributor's entire body of work. `pick-ref.sh` reports
`behind 2`, an old fetch age, and exits 3.

The damage does not scale linearly with staleness. A refactor landing inside the unseen window can
move every line in the file you are citing, so a map that was merely out of date becomes actively
misleading.

**Check.** `scripts/pick-ref.sh` first, always. If the last fetch is older than a few days, offer
`git fetch --all --tags` before measuring. Then pick the active integration branch rather than
whatever is checked out, and state the ref and its date in every deliverable.

## 2. An unmapped contributor identity

**What happens.** One person has several identities. You aggregate per identity and their record
splits: the same human appears twice at half their real weight, or an unrecognised handle reads as
a separate minor contributor.

**Reproduce it.** The history fixture has **five identities for three people**. Run
`identities.sh` and watch it get one pair right and the other wrong: it groups
`Ada Lovelace <ada@work.test>` with `ada <ada@personal.test>` from the shared email local-part,
but cannot group `Grace Hopper <grace@work.test>` with `ghopper <grace.hopper@other.test>` —
different name token, different local part. It flags both as unresolved singletons, which is the
honest outcome. Feed the ungrouped mapping to `contributors.sh` and it reports four people instead
of three, splitting Grace 4/1, and exits 4.

**Check.** `scripts/contributors.sh` requires every identity to resolve through a confirmed
mapping and exits non-zero otherwise. Note that **totals summing to the repo count proves
nothing**: an unmapped identity is still counted, just under the wrong name. The real check is
"was every identity explicitly mapped", not "do the numbers add up". The singletons
`identities.sh` flags are where the misses hide, and resolving them needs someone who knows the
team.

## 3. Lazy imports read as "no dependencies"

**What happens.** You scan for `^import` / `^from`. Imports nested inside functions — routine for
slow, optional or circular-risk dependencies, and the normal idiom in web frameworks where route
handlers import their services locally — are missed entirely. A large application module appears
to depend on almost nothing.

The tell is implausibility: an entry point wiring up a whole application cannot genuinely have two
dependencies. Treat a suspiciously small dependency list on a central module as a bug in the scan,
not a finding about the code.

**Check.** Match any leading whitespace — `^[[:space:]]*(from|import)`. `scripts/dep-edges.sh`
does, and prints a dedicated **lazy imports only** section counting indented imports per file, so
the discrepancy is visible rather than silent.

## 4. Per-file attribution in a monolith

**What happens.** One file holds most of the source. Churn statistics say every contributor "owns"
it. The ownership table is technically correct and completely useless.

**Reproduce it.** The metrics fixture makes `core.py` 21 of 42 commits. `repo-shape.sh` flags any
component above 25% of total source explicitly, rather than leaving you to notice.

**Check.** Measure the shape first. When one file dominates, attribute by **region** using
`git blame` over its line ranges, or by **file creation** (`--diff-filter=A`), and say which you
used in the method note.

## 5. Churn read as contribution

**What happens.** You rank contributors by lines changed. Whoever last ran a large refactor or
moved a vendored bundle tops the list regardless of what they built.

**Check.** Report insertions and deletions separately — an unusually high deletion count signals
restructuring, not accretion. Weight **file creation** above churn when assigning ownership
(`scripts/file-origins.sh`), and caveat every churn figure you quote. GitClear's Diff Delta is the
only published attempt at scoring moved and copy-pasted lines as near-zero work, and nothing in
open source does it — so the honest move is the caveat, not a silent correction.

## 6. Prototypes presented as architecture

**What happens.** A repo accumulates scratch from past experiments — design pickers, demo pages,
abandoned spikes. They land in the map as if they were production and the reader cannot tell what
actually runs.

**Check.** Grep the entry point for each candidate before classifying it. Keep four labels, not
two: **live**, **prototype**, **registered-but-uncalled** (wired up and reachable, no caller) and
**orphaned** (exists only on an unmerged branch). The last is easiest to miss and most misleading —
a reader naturally assumes a file in their working tree exists in the real codebase, and the
history fixture plants exactly this case on `feature/pending`.

## 7. Trusting a tool's claimed coverage

**What happens.** A mapping tool advertises support for N languages. You run it, accept the graph,
and never notice that the one file that matters was skipped because its language was not among the
*installed* parsers — or that a capability in the marketing is absent from the shipped command
surface.

Both halves bite in practice. A tree-sitter-based grapher can ship dozens of grammars and none for
the markup language holding an application's inline scripts, so the largest file in the repo
produces no nodes at all. Separately, a tool can market "see the ripples across your whole system"
and have no impact computation anywhere in its command set.

**Check.** Before relying on any external tool: list its installed parsers, run it, and confirm
nodes exist for the specific files you care about. Read its actual `--help` rather than its README.
Then say plainly what it does not cover, instead of quietly filling the gap yourself and leaving
the user believing the tool produced it. `references/prior-art.md` records what this verification
turned up for the serious tools in the category.

## 8. Publishing graph data you have not validated

**What happens.** Hand-built node and edge arrays contain an off-by-one index, a duplicate edge or
an orphan node. A force layout makes all of these look plausible, so nothing flags them, and the
in-degree figures quoted in the prose disagree with the graph they describe.

**Check.** `node scripts/validate-graph.mjs <file>` before publishing — it checks range,
self-edges, duplicates, orphans and connectivity, then prints the in-degree ranking. Quote **its**
numbers in your prose rather than your own recollection of the edge list.

## 9. Percentiles and tie-breaks that invent findings

Three arithmetic errors that manufacture signal from nothing. All three shipped in a first draft
here and were caught only because the fixture had known answers.

**Fabricated rankings.** Computing a percentile by indexing a sorted array assigns different
percentiles to identical values. Eight of nine components in the metrics fixture have `Minor = 0`;
index-based percentiles spread them from 0.00 to 0.88 as though they differed. Use a tie-aware
**percentile rank** — the fraction of values strictly below this one — so equal values share a
percentile.

**Silent tie-breaks.** `shared.py` in the metrics fixture is owned exactly 3/3 by two people.
Reporting whichever name hash-map iteration yields first turns arbitrary ordering into a finding
and hides real co-ownership. Break ties deterministically **and** report that it was a tie.

**Tail percentiles on small samples.** For a risk metric this is the worst of the three.
`floor(alpha * (N-1))` collapses to index 0 when N is small and returns the **best** case as the
95th percentile — on a two-scenario distribution it reported 3 where the answer was 6. Use
nearest-rank, `ceil(alpha * N) - 1`, and unit-test it against degenerate inputs: a single value,
all-identical values, and N = 2.

---

## Shell portability

Four environment traps, every one of which bit during development.

- **POSIX sh has no variable scoping.** A helper function using a bare `i` as its loop counter
  overwrites the caller's `i` and kills the enclosing loop after one pass. The metrics fixture
  produced 14 commits instead of 42 for exactly this reason. Prefix helper locals (`_wi`), or
  assume every variable is global — because it is.
- **`read -ra` is bash-only.** zsh wants `read -rA`. Avoid shell arrays entirely; the scripts here
  use POSIX constructs only.
- **macOS has no `timeout`.** Do not reach for it in examples a user might run.
- **`grep -c` exits non-zero when the count is zero**, which silently breaks `cmd && cmd` chains
  and truncates a report mid-way. Terminate with `|| true`, or do not chain on a count.
