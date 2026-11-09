#!/bin/sh
# strata/pick-ref.sh — establish which ref to analyse, before measuring anything.
#
# Usage: pick-ref.sh [repo-dir]
#
# Prints: checked-out ref and date, every remote tip newest-first, how far local
# branches lag their remotes, last fetch time, and working-tree state.
# Exits 3 if the repo looks stale enough that you should offer a fetch first.

set -eu
cd "${1:-.}"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "not a git repository: $(pwd)" >&2
  exit 1
fi

echo "=== checked out ==="
printf '%-28s ' "$(git rev-parse --abbrev-ref HEAD)"
git log -1 --date=short --pretty='%ad  %h  %an  %s' 2>/dev/null || echo "(no commits)"
dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
if [ "$dirty" = "0" ]; then echo "working tree:                clean"
else echo "working tree:                $dirty uncommitted change(s)"; fi

echo
echo "=== history totals ==="
echo "commits (all refs):          $(git log --all --oneline 2>/dev/null | wc -l | tr -d ' ')"
first=$(git log --all --reverse --date=short --pretty='%ad' 2>/dev/null | head -1)
last=$(git log --all --date=short --pretty='%ad' 2>/dev/null | sort | tail -1)
echo "range:                       ${first:-?} .. ${last:-?}"

echo
echo "=== remote tips (newest first) ==="
if git for-each-ref refs/remotes >/dev/null 2>&1; then
  git for-each-ref --sort=-committerdate \
    --format='%(refname:short)|%(committerdate:short)|%(authorname)' refs/remotes \
  | grep -v '/HEAD$' \
  | awk -F'|' '{ printf "  %-46s %-12s %s\n", $1, $2, $3 }'
else
  echo "  (none)"
fi

echo
echo "=== local vs remote ==="
git for-each-ref --format='%(refname:short)|%(upstream:short)' refs/heads \
| while IFS='|' read -r br up; do
    [ -n "$up" ] || { printf "  %-30s (no upstream)\n" "$br"; continue; }
    behind=$(git rev-list --count "$br..$up" 2>/dev/null || echo '?')
    ahead=$(git rev-list --count "$up..$br" 2>/dev/null || echo '?')
    printf "  %-30s behind %-6s ahead %s\n" "$br" "$behind" "$ahead"
  done

echo
echo "=== last fetch ==="
stale=0
if [ -f .git/FETCH_HEAD ]; then
  when=$(stat -f '%Sm' .git/FETCH_HEAD 2>/dev/null || stat -c '%y' .git/FETCH_HEAD 2>/dev/null || echo unknown)
  echo "  $when"
  # age in days, tolerating either stat flavour
  now=$(date +%s)
  mt=$(stat -f '%m' .git/FETCH_HEAD 2>/dev/null || stat -c '%Y' .git/FETCH_HEAD 2>/dev/null || echo "$now")
  days=$(( (now - mt) / 86400 ))
  echo "  age: ${days} day(s)"
  [ "$days" -gt 3 ] && stale=1
else
  echo "  never fetched in this clone"
  stale=1
fi

echo
echo "=== verdict ==="
if [ "$stale" = "1" ]; then
  cat <<'EOF'
  STALE — offer `git fetch --all --tags` before measuring anything.
  Analysing stale refs hides recent work and invalidates every line number.
  A fetch updates remote-tracking refs only: no files touched, no branches moved.
EOF
  exit 3
fi
echo "  Refs look current. Pick the active integration branch (often origin/main),"
echo "  not necessarily what is checked out, and state it in every deliverable."
