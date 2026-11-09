#!/bin/sh
# Deterministic fixture for the research-metric layer. Separate from the v1
# build-repo.sh fixture so the existing eval cases keep their ground truth.
#
# Planted conditions, each needed by a specific metric:
#   B1 Bird suite  - core.py has 21 commits split 20/1, putting the minority
#                    contributor at 1/21 = 0.0476, just under the 0.05 threshold,
#                    so Minor is exercised rather than structurally zero
#   B3 orphan      - legacy.py is 100% authored by Morgan, whose last commit is
#                    2024-06-01 (inactive well beyond any 365-day window)
#   B4 successor   - shared.py is split 3/3 between two active developers
#   surprise set   - alpha.py and beta.py always commit together and never import
#                    each other (co-change with no import edge)
#   control        - gamma.py imports delta.py AND they co-change (both signals)
#   stale edge     - epsilon.py imports zeta.py but they never co-change
#
# GROUND TRUTH (all refs, after identity consolidation):
#   42 commits · Dana 31 · Eli 9 · Morgan 2
#
#   Bird suite at file granularity, threshold 0.05:
#     core.py     total 21  Dana 20 (.9524)  Eli 1 (.0476)  -> Minor 1  Major 1  Own .9524
#     shared.py   total  6  Dana  3 (.5)     Eli 3 (.5)     -> Minor 0  Major 2  Own .5
#     legacy.py   total  2  Morgan 2 (1.0)                  -> Minor 0  Major 1  Own 1.0
#     alpha.py    total  6  Dana  6 (1.0)                   -> Minor 0  Major 1  Own 1.0
#     beta.py     total  6  Dana  6 (1.0)                   -> Minor 0  Major 1  Own 1.0
#     gamma.py    total  5  Eli   5 (1.0)                   -> Minor 0  Major 1  Own 1.0
#     delta.py    total  5  Eli   5 (1.0)                   -> Minor 0  Major 1  Own 1.0
#     epsilon.py  total  1  Dana  1 (1.0)                   -> Minor 0  Major 1  Own 1.0
#     zeta.py     total  1  Dana  1 (1.0)                   -> Minor 0  Major 1  Own 1.0
#
#   core.py is the ONLY component with Minor > 0.
set -eu

REPO=metrics-repo
rm -rf "$REPO"
mkdir -p "$REPO"
cd "$REPO"

git init -q -b main .
git config user.name placeholder
git config user.email placeholder@test
git config commit.gpgsign false

# write <file> <lines> — rewrite a file with a given number of filler lines,
# preserving any import header the file is supposed to carry
hdr_for() {
  case "$1" in
    gamma.py)   echo "import delta" ;;
    epsilon.py) echo "import zeta" ;;
    core.py)    echo "import db" ;;
    *)          echo "" ;;
  esac
}

# NOTE the underscore-prefixed locals. POSIX sh has no scoping: a helper that
# uses a bare `i` as its loop counter silently overwrites the caller's `i` and
# kills the enclosing loop after one pass. That bug produced 14 commits instead
# of 42 the first time this fixture ran.
write() {
  _wf="$1"; _wn="$2"
  _wh=$(hdr_for "$_wf")
  : > "$_wf"
  [ -n "$_wh" ] && echo "$_wh" >> "$_wf" || true
  _wi=1
  while [ "$_wi" -le "$_wn" ]; do
    echo "# $_wf line $_wi" >> "$_wf"
    _wi=$((_wi+1))
  done
}

# commit <name> <email> <date> <message> <file:lines>...
commit() {
  _cname="$1"; _cmail="$2"; _cdate="$3"; _cmsg="$4"
  shift 4
  for _cspec in "$@"; do
    write "${_cspec%%:*}" "${_cspec##*:}"
  done
  git add -A
  GIT_AUTHOR_NAME="$_cname"    GIT_AUTHOR_EMAIL="$_cmail" \
  GIT_COMMITTER_NAME="$_cname" GIT_COMMITTER_EMAIL="$_cmail" \
  GIT_AUTHOR_DATE="${_cdate}T10:00:00" GIT_COMMITTER_DATE="${_cdate}T10:00:00" \
  git commit -q -m "$_cmsg"
}

DANA="Dana Okafor|dana@example.test"
ELI="Eli Varga|eli@example.test"
MORGAN="Morgan Reyes|morgan@example.test"

d_name=${DANA%%|*}; d_mail=${DANA##*|}
e_name=${ELI%%|*};  e_mail=${ELI##*|}
m_name=${MORGAN%%|*}; m_mail=${MORGAN##*|}

# ---- Morgan: departed. Sole author of legacy.py, last active 2024-06-01 ----
commit "$m_name" "$m_mail" 2024-05-01 "Add legacy pricing module"     legacy.py:40
commit "$m_name" "$m_mail" 2024-06-01 "Extend legacy pricing module"  legacy.py:60

# ---- core.py: 20 Dana commits + 1 Eli commit = 21 total ----
i=1
while [ "$i" -le 20 ]; do
  mm=$(printf '%02d' $(( (i % 10) + 1 )))
  commit "$d_name" "$d_mail" "2026-${mm}-05" "Refine core totals ($i)" "core.py:$((100 + i))"
  i=$((i+1))
done
# the single minority contribution: 1/21 = 0.0476 < 0.05
commit "$e_name" "$e_mail" 2026-10-20 "Fix rounding in core totals" core.py:121

# ---- shared.py: 3/3 split between two active developers (successor exists) ----
commit "$d_name" "$d_mail" 2026-03-10 "Add shared helpers"      shared.py:30
commit "$e_name" "$e_mail" 2026-04-10 "Extend shared helpers"   shared.py:45
commit "$d_name" "$d_mail" 2026-05-10 "Tidy shared helpers"     shared.py:50
commit "$e_name" "$e_mail" 2026-06-10 "More shared helpers"     shared.py:62
commit "$d_name" "$d_mail" 2026-07-10 "Refactor shared helpers" shared.py:70
commit "$e_name" "$e_mail" 2026-08-10 "Polish shared helpers"   shared.py:78

# ---- alpha.py + beta.py: always together, never import each other ----
i=1
while [ "$i" -le 6 ]; do
  mm=$(printf '%02d' $(( i + 2 )))
  commit "$d_name" "$d_mail" "2026-${mm}-15" "Keep alpha and beta in step ($i)" \
    "alpha.py:$((20 + i))" "beta.py:$((25 + i))"
  i=$((i+1))
done

# ---- gamma.py + delta.py: import edge AND co-change (the control) ----
i=1
while [ "$i" -le 5 ]; do
  mm=$(printf '%02d' $(( i + 3 )))
  commit "$e_name" "$e_mail" "2026-${mm}-20" "Evolve gamma with delta ($i)" \
    "gamma.py:$((15 + i))" "delta.py:$((18 + i))"
  i=$((i+1))
done

# ---- epsilon.py -> zeta.py: import edge, never co-change (the stale edge) ----
commit "$d_name" "$d_mail" 2026-02-01 "Add zeta"                zeta.py:12
commit "$d_name" "$d_mail" 2026-09-01 "Add epsilon using zeta"  epsilon.py:14

echo "fixture ready at $(pwd)"
echo "  commits: $(git log --oneline | wc -l | tr -d ' ')  (expect 42)"
echo "  authors:"
git log --pretty='%an' | sort | uniq -c | sed 's/^/    /'
