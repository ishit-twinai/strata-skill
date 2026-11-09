# Methodology

Exact invocations and deliverable templates. The scripts in `scripts/` wrap most of these; this
file is for when you need to vary them or explain what a number means.

## Contents

- [Choosing the ref](#choosing-the-ref)
- [Reading a non-checked-out ref](#reading-a-non-checked-out-ref)
- [Contributor arithmetic](#contributor-arithmetic)
- [Ownership signals](#ownership-signals)
- [Dependency extraction](#dependency-extraction)
- [Classification](#classification)
- [Deliverable templates](#deliverable-templates)

## Choosing the ref

```sh
git log -1 --date=short --pretty='%ad %h %s' HEAD        # what's checked out
git for-each-ref --sort=-committerdate --format='%(refname:short) %(committerdate:short) %(authorname)' refs/remotes
git rev-list --count main..origin/main                   # how far behind local main is
stat -f '%Sm' .git/FETCH_HEAD                            # macOS: last fetch
stat -c '%y' .git/FETCH_HEAD                             # GNU
git status --porcelain                                   # dirty tree?
```

Pick the **active integration branch** — the one other branches merge into and that has recent
commits. Confirm merged state before assuming a branch's work is included:

```sh
git log --oneline origin/main..<branch> | wc -l   # 0 => fully merged into main
git log --oneline <branch>..origin/main | wc -l
```

## Reading a non-checked-out ref

Never switch branches to analyse one; it disturbs the user's working tree.

```sh
git ls-tree -r --name-only <ref>                 # file inventory
git show <ref>:<path>                            # file contents
git show <ref>:<path> | wc -l                    # line count
git cat-file -e <ref>:<path> 2>/dev/null         # existence test
comm -13 <(git ls-tree -r --name-only A | sort) <(git ls-tree -r --name-only B | sort)
```

## Contributor arithmetic

Totals, range, and identities:

```sh
git log --all --oneline | wc -l
git log --all --pretty='%an <%ae>' | sort | uniq -c | sort -rn
```

Per-identity churn in one pass — mark each commit, then attribute the numstat lines that follow:

```sh
git log --all --numstat --date=short --pretty='@@%an|%ad'
```

Lines beginning `@@` start a commit; subsequent three-field tab-separated lines are
`insertions<TAB>deletions<TAB>path`, with `-` for binary files. `scripts/contributors.sh`
implements the aggregation and the sum check.

**The sum check**: per-person commit counts must equal the repo total. A mismatch means an
unmapped identity.

Restrict to a window with `--since` / `--until` when the user asks what changed over a period.

## Ownership signals

```sh
git log <ref> --diff-filter=A --format='%an|%ad' --date=short -- <path> | tail -1   # creator
git log <ref> -1 --format='%an|%ad' --date=short -- <path>                          # last toucher
git blame <ref> -L <start>,<end> --line-porcelain -- <path> | grep '^author '        # region owner
```

Creation beats churn for ownership: a refactor generates enormous churn without conferring
authorship. Report **built by** (creator) and **ask** (last toucher, if still active) as separate
columns — the gap between them is the actionable part.

For a region inside a large file, aggregate blame authors over the line range and take the
plurality.

## Dependency extraction

```sh
# Python, any indentation — catches lazy imports inside functions
git show <ref>:<path> | grep -nE '^[[:space:]]*(from|import) +<pkg-prefixes>'

# JS/TS
grep -nE "(^|[^a-z])(import .* from|require\()" file

# script tags
grep -oE '<script[^>]*src="[^"]+"' file

# HTTP call sites
grep -oE '/api/[a-z0-9/_-]+' file | sort -u
```

Distinguish edge kinds when you present them — imports, script loads and network calls are not
the same relationship. A caption saying so prevents the graph being read as a pure import graph.

Count in-degree to rank hubs. The notable hub is usually not the DB handle but a gate or shared
service that unrelated features structurally depend on.

## Classification

Verify, don't assume:

```sh
git show <ref>:<entrypoint> | grep -c '<candidate-filename>' || true
```

Four labels:

| Label | Meaning |
|---|---|
| live | reachable and referenced from an entry point |
| prototype | present, never referenced — scratch or design experiment |
| registered-but-uncalled | wired up and reachable, but nothing calls it |
| orphaned | exists only on an unmerged branch; absent from the real codebase |

## Deliverable templates

### ARCHITECTURE.md

```markdown
# <Project> — Architecture & File Map

**Analysis basis:** <ref> @ <sha> (<date>) · history through <date> · <N> commits · generated <date>

> Staleness warning, if the user's working tree differs from the analysed ref.

## 1. System overview
<mermaid flowchart> + request lifecycle prose + hub table (in-degree ranked)

## 2. Module map
| Module | Lines | Responsibility | Dependencies | Origin |

## 3. <Monolith> regions        (only when one file dominates)
| File/region | Lines | Fns | Responsibility |

## 4. Coupling hotspots
| Shared state key | Refs | Blast radius |
+ the two or three critical chains

## 5. Classification
live / prototype / registered-but-uncalled / orphaned

## 6. Test infrastructure
```

### CONTRIBUTORS.md

```markdown
# <Project> — Contributor Attribution & Impact Map

**Basis:** <N> commits · <first> → <last> · generated <date>
**Method:** one line on how attribution was derived

## Identity consolidation
| Person | Git identities |

## Headline numbers
| Person | Commits | % | Files | Insertions | Deletions | Active range |

## Timeline
<mermaid gantt>  — name the collaboration shape: relay, parallel, or single-owner

## Per contributor
### <Name> — <domain> (<range> · <N> commits · <N> files)
Domain ownership · Created · Key work · Architectural legacy · Top files by churn · Status

## Ownership heat — who to ask
| Subsystem | Built by | Ask | Note |
+ a bus-factor reading

## Method note
Why per-file attribution was or wasn't used; the churn caveat.
```

Keep both documents' figures traceable to a command in this file. Where a number in the prose came
from the graph (in-degree, edge counts), take it from `validate-graph.mjs` output.
