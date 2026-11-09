#!/bin/sh
# strata/repo-shape.sh — measure the repo's shape so you can pick the unit of analysis.
#
# Usage: repo-shape.sh [ref] [repo-dir]
#        ref defaults to HEAD. Use origin/main (or whichever ref pick-ref.sh chose).
#
# Separates real source from binary assets, ranks source files, counts functions,
# and flags any file big enough that a per-file map would make it a black box.

set -eu
REF="${1:-HEAD}"
cd "${2:-.}"

ASSET_RE='\.(png|jpe?g|gif|svg|ico|webp|bmp|tiff?|woff2?|ttf|eot|otf|mp[34]|wav|ogg|mov|avi|webm|pdf|zip|gz|bz2|xz|7z|jar|so|dylib|dll|a|o|wasm|lock|min\.js|min\.css|bundle\.js)$'

echo "=== ref: $REF ==="
git log -1 --date=short --pretty='%ad  %h  %an' "$REF"

all=$(git ls-tree -r --name-only "$REF" | wc -l | tr -d ' ')
src_list=$(git ls-tree -r --name-only "$REF" | grep -Ev "$ASSET_RE" || true)
src=$(printf '%s\n' "$src_list" | grep -c . || true)
echo
echo "tracked files:   $all"
echo "source/text:     $src"
echo "assets:          $(( all - src ))"

echo
echo "=== largest source files ==="
printf '%s\n' "$src_list" | while read -r f; do
  [ -n "$f" ] || continue
  n=$(git show "$REF:$f" 2>/dev/null | wc -l | tr -d ' ') || n=0
  printf '%8s  %s\n' "$n" "$f"
done | sort -rn > /tmp/strata_shape_$$ || true

head -30 /tmp/strata_shape_$$
total=$(awk '{s+=$1} END {print s+0}' /tmp/strata_shape_$$)
echo
echo "total source lines: $total"

echo
echo "=== concentration ==="
awk -v tot="$total" 'NR<=5 && tot>0 {
  pct = ($1/tot)*100
  printf "  %-54s %7d  %5.1f%%\n", $2, $1, pct
  if (pct >= 25) flag[++n] = $2 " (" sprintf("%.0f", pct) "% of source)"
}
END {
  if (n) {
    print ""
    print "  DOMINANT FILE(S) — a per-file map makes this a black box, and per-file"
    print "  attribution is useless because every contributor will appear to own it:"
    for (i=1;i<=n;i++) print "    - " flag[i]
    print ""
    print "  Map and attribute by REGION inside it instead (key off its own router or"
    print "  dispatch table if it has one). Aim for 25-35 nodes and confirm with the user."
  }
}' /tmp/strata_shape_$$

echo
echo "=== function counts (top source files) ==="
head -12 /tmp/strata_shape_$$ | while read -r n f; do
  [ -n "$f" ] || continue
  case "$f" in
    *.py)
      c=$(git show "$REF:$f" 2>/dev/null | grep -cE '^[[:space:]]*(def|class) ' || true) ;;
    *.js|*.ts|*.jsx|*.tsx|*.mjs|*.cjs|*.html)
      c=$(git show "$REF:$f" 2>/dev/null | grep -cE '^[[:space:]]*(function |(const|let|var) [A-Za-z_$][A-Za-z0-9_$]* *= *(async )?(function|\())' || true) ;;
    *) c="-" ;;
  esac
  printf '  %-54s %s\n' "$f" "$c"
done

echo
echo "=== language mix ==="
printf '%s\n' "$src_list" | awk -F. 'NF>1 {print "."$NF} NF==1 {print "(none)"}' \
  | sort | uniq -c | sort -rn | head -14 | awk '{printf "  %-10s %s\n", $2, $1}'

echo
echo "=== dispatch tables / routers (region keys for a dominant file) ==="
printf '%s\n' "$src_list" | while read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    *.js|*.ts|*.html|*.mjs)
      git show "$REF:$f" 2>/dev/null \
        | grep -nE '(const|let|var) (pages|routes|views|handlers|screens) *= *\{' \
        | sed "s|^|  $f:|" || true ;;
  esac
done | head -10

rm -f /tmp/strata_shape_$$
