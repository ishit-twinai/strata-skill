#!/bin/sh
# strata/file-origins.sh — who CREATED each file, and who last touched it.
#
# Usage: file-origins.sh [ref] [path-filter-regex] [repo-dir]
#        ref defaults to HEAD. path filter is an ERE applied to paths (default: source only).
#
# Creation is a better ownership signal than churn: a refactor moves thousands of
# lines without conferring authorship, while whoever created a module usually
# designed it. The gap between "built by" and "ask" is the actionable column.

set -eu
REF="${1:-HEAD}"
FILTER="${2:-}"
cd "${3:-.}"

ASSET_RE='\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|otf|mp[34]|wav|mov|webm|pdf|zip|gz|jar|so|dylib|dll|wasm|lock|min\.js|min\.css|bundle\.js)$'

files=$(git ls-tree -r --name-only "$REF" | grep -Ev "$ASSET_RE" || true)
if [ -n "$FILTER" ]; then
  files=$(printf '%s\n' "$files" | grep -E "$FILTER" || true)
fi

echo "=== ref: $REF ==="
printf '%-52s %-14s %-11s %-14s %s\n' "FILE" "BUILT BY" "CREATED" "ASK" "LAST"
printf '%-52s %-14s %-11s %-14s %s\n' "----" "--------" "-------" "---" "----"

printf '%s\n' "$files" | while read -r f; do
  [ -n "$f" ] || continue
  created=$(git log "$REF" --diff-filter=A --format='%an|%ad' --date=short -- "$f" 2>/dev/null | tail -1)
  touched=$(git log "$REF" -1 --format='%an|%ad' --date=short -- "$f" 2>/dev/null)
  ca=$(printf '%s' "$created" | cut -d'|' -f1)
  cd_=$(printf '%s' "$created" | cut -d'|' -f2)
  ta=$(printf '%s' "$touched" | cut -d'|' -f1)
  td=$(printf '%s' "$touched" | cut -d'|' -f2)
  printf '%-52s %-14s %-11s %-14s %s\n' \
    "$(printf '%s' "$f" | cut -c1-52)" \
    "$(printf '%s' "${ca:-?}" | cut -c1-14)" "${cd_:-?}" \
    "$(printf '%s' "${ta:-?}" | cut -c1-14)" "${td:-?}"
done

echo
echo "=== files created, per person ==="
printf '%s\n' "$files" | while read -r f; do
  [ -n "$f" ] || continue
  git log "$REF" --diff-filter=A --format='%an' -- "$f" 2>/dev/null | tail -1
done | sort | uniq -c | sort -rn | awk '{ c=$1; $1=""; sub(/^ /,""); printf "  %5d  %s\n", c, $0 }'

echo
echo "Report 'built by' (creator) and 'ask' (last toucher, if still active) as separate"
echo "columns. Where they differ, the creator is history and the last toucher is who can"
echo "actually answer. A subsystem whose creator is gone and whose last toucher is also"
echo "inactive has no owner at all — say so explicitly."
