#!/bin/sh
# strata/contributors.sh — per-person commit, file and churn stats with a completeness check.
#
# Usage: contributors.sh [ref] [mapping.tsv] [--since=YYYY-MM-DD] [--until=YYYY-MM-DD]
#        ref defaults to --all (every branch). Pass a single ref to scope to it.
#        mapping.tsv is "identity<TAB>person" from identities.sh (optional but advised).
#
# ENFORCES the check that matters: per-person commit counts must sum to the total.
# A mismatch means an identity is unmapped, i.e. a contributor is silently missing
# from the analysis. Exits 4 on mismatch.

set -eu

REF="${1:---all}"
MAP=""
[ "${2:-}" ] && case "$2" in --*) ;; *) MAP="$2" ;; esac

SINCE=""
UNTIL=""
for a in "$@"; do
  case "$a" in
    --since=*) SINCE="$a" ;;
    --until=*) UNTIL="$a" ;;
  esac
done

case "$REF" in --all|--*) REFARG="--all" ;; *) REFARG="$REF" ;; esac
MAPFILE=""
if [ -n "$MAP" ] && [ -f "$MAP" ]; then MAPFILE="$MAP"; fi

TMP="${TMPDIR:-/tmp}/strata_contrib_$$"
CHANGES="$TMP.changes"
COMMITS="$TMP.commits"
trap 'rm -f "$CHANGES" "$COMMITS"' EXIT HUP INT TERM

echo "=== scope ==="
echo "ref:      $REFARG"
echo "mapping:  ${MAPFILE:-<none: aggregating by raw author name>}"
[ -n "$SINCE" ] && echo "since:    ${SINCE#--since=}" || true
[ -n "$UNTIL" ] && echo "until:    ${UNTIL#--until=}" || true

# shellcheck disable=SC2086
total=$(git log $REFARG $SINCE $UNTIL --oneline | wc -l | tr -d ' ')
echo "commits:  $total"

# ---- normalise once: resolve each commit to a person, emit two flat streams ----
# COMMITS: person <TAB> date
# CHANGES: person <TAB> ins <TAB> del <TAB> path
# shellcheck disable=SC2086
git log $REFARG $SINCE $UNTIL --numstat --date=short --pretty='@@%an|%ae|%ad' \
| awk -v mapfile="$MAPFILE" -v commits="$COMMITS" -v changes="$CHANGES" '
  BEGIN {
    FS = "\t"
    if (mapfile != "") {
      while ((getline line < mapfile) > 0) {
        if (line == "") continue
        t = index(line, "\t"); if (t == 0) continue
        k = substr(line, 1, t-1); v = substr(line, t+1)
        gsub(/^[ \t]+|[ \t]+$/, "", k); gsub(/^[ \t]+|[ \t]+$/, "", v)
        m[k] = v
      }
      close(mapfile)
    }
  }
  /^@@/ {
    rec = substr($0, 3)
    p1 = index(rec, "|"); name = substr(rec, 1, p1-1); rest = substr(rec, p1+1)
    p2 = index(rest, "|"); email = substr(rest, 1, p2-1); d = substr(rest, p2+1)
    id = name " <" email ">"
    if (id in m) { cur = m[id]; mapped = 1 } else { cur = name; mapped = 0 }
    print cur "\t" d "\t" mapped "\t" id >> commits
    next
  }
  NF == 3 {
    i = ($1 == "-") ? 0 : $1
    j = ($2 == "-") ? 0 : $2
    print cur "\t" i "\t" j "\t" $3 >> changes
  }
'

touch "$CHANGES" "$COMMITS"

# ---- per-person aggregates ----
echo
awk -F'\t' -v total="$total" -v hasmap="${MAPFILE:+1}" '
  FILENAME == ARGV[1] {
    commits[$1]++
    if (!($1 in first) || $2 < first[$1]) first[$1] = $2
    if (!($1 in last)  || $2 > last[$1])  last[$1]  = $2
    if ($3 == 0) { unmapped[$4]++ }
    next
  }
  {
    ins[$1] += $2; del[$1] += $3
    k = $1 "\x01" $4
    if (!(k in seen)) { seen[k] = 1; files[$1]++ }
  }
  END {
    n = 0; sum = 0
    for (p in commits) { ord[++n] = p; sum += commits[p] }
    for (a = 1; a <= n; a++)
      for (b = a+1; b <= n; b++)
        if (commits[ord[b]] > commits[ord[a]]) { t = ord[a]; ord[a] = ord[b]; ord[b] = t }

    printf "=== per person (%d) ===\n", n
    printf "%-18s %8s %7s %7s %10s %10s  %s\n", "PERSON", "COMMITS", "PCT", "FILES", "INS", "DEL", "ACTIVE RANGE"
    for (a = 1; a <= n; a++) {
      p = ord[a]
      printf "%-18s %8d %6.1f%% %7d %10d %10d  %s .. %s\n", \
        p, commits[p], (total > 0 ? commits[p]*100/total : 0), \
        files[p]+0, ins[p]+0, del[p]+0, first[p], last[p]
    }
    print ""
    print "=== completeness check ==="
    printf "  commits attributed: %d of %d\n", sum, total

    u = 0
    for (id in unmapped) u++

    if (sum != total) {
      printf "\n  ARITHMETIC MISMATCH: %d commit(s) unaccounted.\n", total - sum
      print  "  Something is wrong with the log parse itself - do not report these numbers."
      exit 4
    }

    if (hasmap == "" ) {
      print "  NO MAPPING SUPPLIED - these rows are raw git identities, not people."
      print "  One person routinely commits under several identities, so treat this as"
      print "  a starting point only. Run identities.sh and pass a mapping before you"
      print "  report per-person figures to anyone."
      exit 0
    }

    if (u > 0) {
      printf "\n  %d IDENTITY/IDENTITIES NOT IN THE MAPPING:\n", u
      for (id in unmapped) printf "    %-46s %d commit(s)\n", id, unmapped[id]
      print  ""
      print  "  Each fell through to its raw git name, so it may be double-counting a"
      print  "  person who is also listed under their mapped name. This is the failure"
      print  "  mode most likely to embarrass whoever presents the analysis: add these"
      print  "  to the mapping and re-run before reporting."
      exit 4
    }

    print "  OK - every commit resolved through the confirmed mapping."
  }' "$COMMITS" "$CHANGES" || rc=$?

rc=${rc:-0}
if [ "$rc" = "4" ]; then exit 4; fi

# ---- top files per person (churn = ins + del) ----
echo
echo "=== top files by churn, per person ==="
cut -f1 "$COMMITS" | sort -u | while read -r person; do
  [ -n "$person" ] || continue
  printf '\n-- %s --\n' "$person"
  awk -F'\t' -v p="$person" '$1 == p { c[$4] += $2 + $3 } END { for (f in c) printf "%9d\t%s\n", c[f], f }' "$CHANGES" \
    | sort -rn | head -8 | awk -F'\t' '{ printf "  %s  %s\n", $1, $2 }'
done

cat <<'EOF'

NOTE: churn = insertions + deletions, so a refactor counts as heavily as new work.
An unusually high deletion count signals restructuring, not accretion. Weight file
creation (file-origins.sh) above churn when assigning ownership, and caveat any
churn figure you quote.
EOF
