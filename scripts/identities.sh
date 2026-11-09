#!/bin/sh
# strata/identities.sh — list every git identity and propose groupings for confirmation.
#
# Usage: identities.sh [repo-dir]
#
# Emits a ready-to-edit mapping file at ./strata-identities.tsv  (identity<TAB>person)
# Groupings are HEURISTIC. Show them to someone who knows the team and have them
# confirm before you aggregate — a wrongly merged or missed identity silently drops
# a contributor out of the analysis.

set -eu

# write the mapping beside the caller, never inside the analysed repo — a stray
# tsv committed into someone's project is a poor thank-you for running an audit
OUT="$(pwd)/strata-identities.tsv"
cd "${1:-.}"

echo "=== identities by commit count ==="
git log --all --pretty='%an <%ae>' | sort | uniq -c | sort -rn \
  | awk '{ c=$1; $1=""; sub(/^ /,""); printf "  %5d  %s\n", c, $0 }'

total=$(git log --all --oneline | wc -l | tr -d ' ')
echo
echo "total commits: $total"

echo
echo "=== likely bots / automation ==="
git log --all --pretty='%an <%ae>' | sort -u \
  | grep -iE 'bot|\[bot\]|ci|action|jenkins|dependabot|renovate|noreply' \
  | sed 's/^/  /' || echo "  (none detected)"

echo
echo "=== grouping signals ==="

echo "-- shared email local-part (before the @) --"
git log --all --pretty='%ae' | sort -u \
  | awk -F@ '{ print $1 "\t" $0 }' \
  | sort | awk -F'\t' '{ k=$1; gsub(/[^a-z0-9]/,"",k); print k "\t" $2 }' \
  | sort | awk -F'\t' '{ if ($1==prev) { if (!shown) print "  " prevline; print "  " $2; shown=1 } else shown=0; prev=$1; prevline=$2 }' \
  || true

echo "-- shared name token (first or last word, normalised) --"
git log --all --pretty='%an|%ae' | sort -u \
  | awk -F'|' '{
      n=tolower($1); gsub(/[^a-z ]/," ",n);
      split(n, w, " ");
      for (i in w) if (length(w[i])>=3) print w[i] "\t" $1 " <" $2 ">"
    }' \
  | sort -u | awk -F'\t' '{ cnt[$1]++; line[$1]=line[$1] "\n    " $2 }
      END { for (k in cnt) if (cnt[k]>1) print "  token \"" k "\":" line[k] }' \
  || true

# ---- emit an editable mapping, pre-filled with the best guess ----
git log --all --pretty='%an|%ae' | sort -u \
| awk -F'|' '
  {
    id = $1 " <" $2 ">"
    # guess: the FIRST name token (given name), title-cased. Deliberately not the
    # longest token — that yields surnames and splits "ada" from "Ada Lovelace",
    # which is the opposite of what a consolidation pass needs.
    n = tolower($1); gsub(/[^a-z ]/, " ", n)
    cnt = split(n, w, " ")
    first = ""
    for (i = 1; i <= cnt; i++) if (length(w[i]) >= 2) { first = w[i]; break }
    if (first == "") first = tolower($1)
    guess = toupper(substr(first,1,1)) substr(first,2)
    printf "%s\t%s\n", id, guess
  }' | sort > "$OUT"

echo
echo "=== wrote $OUT ==="
echo "  identity<TAB>person — one line per identity. Edit the right-hand column so"
echo "  every identity belonging to the same human carries the SAME person name,"
echo "  then run:  contributors.sh <ref> $OUT"
echo
awk -F'\t' '{ printf "  %-46s -> %s\n", $1, $2 }' "$OUT"

echo
echo "=== identities the heuristics could NOT group — check these by hand ==="
awk -F'\t' '{ c[$2]++; line[$2] = line[$2] "\n    " $1 }
  END {
    n = 0
    for (p in c) if (c[p] == 1) { n++; print "  \"" p "\" (only identity):" line[p] }
    if (n == 0) print "  (every guessed person has more than one identity)"
  }' "$OUT"

cat <<'EOF'

  A singleton above is either a person who really does use one identity, or a
  second identity of someone already listed that name and email similarity cannot
  see — a renamed account, an org handle, a machine-generated committer name.
  Those are exactly the ones that go missing from an analysis, so resolve them
  with someone who knows the team before aggregating.
EOF
