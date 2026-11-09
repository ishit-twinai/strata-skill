#!/bin/sh
# strata/dep-edges.sh — extract dependency edges from source.
#
# Usage: dep-edges.sh [ref] [internal-prefix-regex] [repo-dir]
#        ref defaults to HEAD.
#        internal-prefix-regex limits Python imports to first-party packages, e.g.
#        'services|auth|billing|datasets|sharing|config|extensions'. Auto-detected
#        from top-level package dirs when omitted.
#
# Matches ANY indentation, so imports nested inside functions are caught. A
# top-level-only scan routinely reports that an application's main module depends
# on nothing, which is both false and easy to publish by accident.
#
# SCOPE: this script is for READING and exploring - it shows you the edges plus
# the things only a shell pass does well (lazy imports per file, route counts,
# endpoint call sites). For a MACHINE-READABLE graph use dep-graph.mjs, which is
# the single authoritative builder:
#
#   node dep-graph.mjs --format json > graph.json
#
# Keeping one authority matters: the edge list was briefly built twice, here and
# in lib/strata.mjs, which is two definitions of the same thing free to drift.
# dep-graph.mjs now owns the graph; this script owns the reports.

set -eu
REF="${1:-HEAD}"
PREFIX="${2:-}"
cd "${3:-.}"

if [ -z "$PREFIX" ]; then
  # first-party = top-level dirs containing __init__.py, plus bare top-level modules
  pkgs=$(git ls-tree -r --name-only "$REF" | awk -F/ '$NF=="__init__.py" && NF==2 {print $1}' | sort -u)
  mods=$(git ls-tree --name-only "$REF" | grep -E '\.py$' | sed 's/\.py$//' | grep -vE '^(setup|conftest)$' || true)
  PREFIX=$(printf '%s\n%s\n' "$pkgs" "$mods" | grep -v '^$' | paste -sd'|' - 2>/dev/null || printf '%s' "$pkgs" | tr '\n' '|')
  PREFIX=${PREFIX%|}
fi
echo "=== ref: $REF ==="
echo "first-party prefixes: ${PREFIX:-<none detected>}"
echo

echo "=== python import edges (any indentation — lazy imports included) ==="
git ls-tree -r --name-only "$REF" | grep -E '\.py$' | grep -v '/migrations/versions/' \
| while read -r f; do
    [ -n "$f" ] || continue
    deps=$(git show "$REF:$f" 2>/dev/null \
      | grep -hoE "^[[:space:]]*(from|import) +(${PREFIX})[A-Za-z0-9_.]*" \
      | sed -E 's/^[[:space:]]*(from|import) +//' | sort -u | paste -sd' ' - 2>/dev/null) || deps=""
    [ -n "$deps" ] && printf '%-46s -> %s\n' "$f" "$deps" || true
  done

echo
echo "=== python LAZY imports only (nested in functions) ==="
echo "    these are invisible to a '^import' scan — the usual cause of a central"
echo "    module appearing to have no dependencies"
git ls-tree -r --name-only "$REF" | grep -E '\.py$' \
| while read -r f; do
    [ -n "$f" ] || continue
    n=$(git show "$REF:$f" 2>/dev/null \
      | grep -cE "^[[:space:]]+(from|import) +(${PREFIX})" || true)
    [ "${n:-0}" -gt 0 ] && printf '  %-46s %s lazy import(s)\n' "$f" "$n" || true
  done

echo
echo "=== js/ts module edges ==="
git ls-tree -r --name-only "$REF" | grep -E '\.(js|mjs|cjs|ts|tsx|jsx)$' | grep -v '/vendor/' \
| while read -r f; do
    [ -n "$f" ] || continue
    deps=$(git show "$REF:$f" 2>/dev/null \
      | grep -hoE "(from|require\() *['\"][./][^'\"]*['\"]" \
      | sed -E "s/.*['\"]//;s/['\"].*//" | sort -u | paste -sd' ' - 2>/dev/null) || deps=""
    [ -n "$deps" ] && printf '%-46s -> %s\n' "$f" "$deps" || true
  done

echo
echo "=== <script src> tags (page -> script, and external CDNs) ==="
git ls-tree -r --name-only "$REF" | grep -E '\.(html|htm)$' \
| while read -r f; do
    [ -n "$f" ] || continue
    srcs=$(git show "$REF:$f" 2>/dev/null \
      | grep -oE '<script[^>]*src="[^"]+"' | sed -E 's/.*src="//;s/"$//' | sort -u) || srcs=""
    if [ -n "$srcs" ]; then
      printf '%s:\n' "$f"
      printf '%s\n' "$srcs" | sed 's|^|    |'
    fi
  done

echo
echo "=== HTTP endpoint call sites (frontend -> backend) ==="
git ls-tree -r --name-only "$REF" | grep -E '\.(js|mjs|ts|tsx|jsx|html|svelte|vue)$' | grep -v '/vendor/' \
| while read -r f; do
    [ -n "$f" ] || continue
    n=$(git show "$REF:$f" 2>/dev/null | grep -coE "['\"\`]/(api|v[0-9]+|graphql)[a-zA-Z0-9/_.:-]*" || true)
    [ "${n:-0}" -gt 0 ] && printf '  %-46s %s call site(s)\n' "$f" "$n" || true
  done

echo
echo "=== distinct endpoints referenced ==="
git ls-tree -r --name-only "$REF" | grep -E '\.(js|mjs|ts|tsx|jsx|html)$' | grep -v '/vendor/' \
| while read -r f; do git show "$REF:$f" 2>/dev/null; done \
| grep -oE "/(api|v[0-9]+|graphql)/[a-zA-Z0-9/_.-]+" | sort | uniq -c | sort -rn | head -40 \
| awk '{ printf "  %4d  %s\n", $1, $2 }'

echo
echo "=== server-side route declarations ==="
git ls-tree -r --name-only "$REF" | grep -E '\.py$' \
| while read -r f; do
    [ -n "$f" ] || continue
    n=$(git show "$REF:$f" 2>/dev/null | grep -coE "@[a-zA-Z_][a-zA-Z0-9_]*\.(route|get|post|put|patch|delete)\(" || true)
    [ "${n:-0}" -gt 0 ] && printf '  %-46s %s route(s)\n' "$f" "$n" || true
  done

echo
echo "Edge kinds above are NOT the same relationship — imports, script loads and"
echo "network calls differ. Say which kinds your graph mixes in its caption, so"
echo "nobody reads it as a pure import graph. Curate; don't paste this wholesale."
