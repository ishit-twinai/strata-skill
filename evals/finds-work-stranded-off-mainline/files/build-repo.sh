#!/bin/sh
# Builds a deterministic fixture repo exercising the traps strata exists to catch:
#   - 3 people behind 6 git identities
#   - local main 2 commits behind origin/main (a stale checkout)
#   - an unmerged branch carrying work absent from main
#   - one file dominating the source, so per-file attribution is useless
#
# Resulting ground truth:
#   all refs  : 14 commits   Ada 5 · Grace 5 · Alan 4
#   origin/main: 12 commits  (local main sits 2 behind)
#   unmerged   : 2 commits by Alan on feature/pending
set -eu

REPO=fixture-repo
rm -rf "$REPO" "$REPO.git"
mkdir -p "$REPO"
cd "$REPO"

git init -q -b main .
git config user.name  "placeholder"
git config user.email "placeholder@test"
git config commit.gpgsign false

c() { # c <name> <email> <file> <lines> <message>
  n="$4"; i=1
  : > "$3"
  while [ "$i" -le "$n" ]; do echo "// $3 line $i" >> "$3"; i=$((i+1)); done
  git add -A
  GIT_AUTHOR_NAME="$1" GIT_AUTHOR_EMAIL="$2" \
  GIT_COMMITTER_NAME="$1" GIT_COMMITTER_EMAIL="$2" \
  GIT_AUTHOR_DATE="2026-0$5-01T10:00:00" GIT_COMMITTER_DATE="2026-0$5-01T10:00:00" \
  git commit -q -m "$6"
}

# --- Ada: platform foundation (3 work + 2 personal identity = 5) ---
c "Ada Lovelace" "ada@work.test"     server.py  40 1 "Add server entry point"
c "Ada Lovelace" "ada@work.test"     db.py      25 1 "Add database handle"
c "Ada Lovelace" "ada@work.test"     auth.py    30 2 "Add auth routes"
c "ada"          "ada@personal.test" db.py      35 2 "Extend database handle"
c "ada"          "ada@personal.test" config.py  15 2 "Add config loading"

# --- Grace: the dominant frontend file (4 work + 1 other identity = 5) ---
c "Grace Hopper" "grace@work.test"        app.js      320 3 "Add single-page app"
c "Grace Hopper" "grace@work.test"        app.js      480 3 "Grow app: routing and views"
c "Grace Hopper" "grace@work.test"        app.js      620 4 "Grow app: charts"
c "Grace Hopper" "grace@work.test"        charts.py    60 4 "Add chart service"
c "ghopper"      "grace.hopper@other.test" app.js     700 5 "Grow app: data table"

# --- Alan: analysis services (2 on main) ---
c "Alan Turing" "alan@work.test" analytics.py 55 5 "Add analytics service"
c "Alan Turing" "alan@work.test" report.py    45 6 "Add report service"

# --- publish to a bare 'origin', then rewind local main so it looks stale ---
cd ..
git init -q --bare "$REPO.git"
cd "$REPO"
git remote add origin "../$REPO.git"
git push -q origin main
git branch --set-upstream-to=origin/main main >/dev/null 2>&1 || true

# --- unmerged branch: work that exists nowhere in main ---
git checkout -q -b feature/pending
c "Alan Turing" "alan@work.test" significance.py 70 7 "Add significance testing"
c "Alan Turing" "alan@work.test" NOTES.md        30 7 "Document significance approach"
git push -q origin feature/pending
git checkout -q main

# local main falls 2 behind origin/main
git reset -q --hard HEAD~2

# make the fetch look old, so a staleness check has something to find
if command -v touch >/dev/null 2>&1; then
  touch -t 202609010900 .git/FETCH_HEAD 2>/dev/null || true
fi

echo "fixture ready at $(pwd)"
echo "  local main:  $(git rev-parse --short HEAD)  ($(git rev-list --count main..origin/main) behind origin/main)"
echo "  all refs:    $(git log --all --oneline | wc -l | tr -d ' ') commits"
