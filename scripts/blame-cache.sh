#!/bin/sh
# strata/blame-cache.sh — one blame pass over the repo, cached as TSV.
#
# Usage: blame-cache.sh [ref] [repo-dir] [max-files]
#        ref defaults to HEAD. max-files defaults to 0 (no limit).
#
# Emits to stdout:  path <TAB> author <TAB> lines
#
# Why cache it: `git blame` is the expensive operation in this whole skill, and
# three metrics need the same data (orphan ratio, knowledge-at-risk, line-level
# ownership). Running blame once and reusing the TSV turns an O(metrics x files)
# cost into O(files).
#
#   sh blame-cache.sh origin/main . > blame.tsv
#   node ownership-metrics.mjs --metric orphan --blame blame.tsv
#   node knowledge-at-risk.mjs --blame blame.tsv
#
# Honours .mailmap (git blame does so by default), so a repo that ships one gets
# identity consolidation for free. For repos that do not, map the author column
# afterwards with the identities.sh mapping.

set -eu
REF="${1:-HEAD}"
REPO="${2:-.}"
MAX="${3:-0}"

cd "$REPO"

# Skip anything blame cannot meaningfully attribute: binaries, vendored bundles,
# lockfiles, minified output. Blaming a 2MB lockfile is slow and tells you nothing.
SKIP_RE='\.(png|jpe?g|gif|svg|ico|webp|bmp|tiff?|woff2?|ttf|eot|otf|mp[34]|wav|ogg|mov|avi|webm|pdf|zip|gz|bz2|xz|7z|jar|so|dylib|dll|a|o|wasm|min\.js|min\.css|bundle\.js|map)$|(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|(^|/)(vendor|node_modules|third_party|\.min)/'

files=$(git ls-tree -r --name-only "$REF" | grep -Ev "$SKIP_RE" || true)

if [ "$MAX" -gt 0 ] 2>/dev/null; then
  files=$(printf '%s\n' "$files" | head -n "$MAX")
fi

n=0
printf '%s\n' "$files" | while IFS= read -r f; do
  [ -n "$f" ] || continue
  # --line-porcelain prints "author X" and "author-mail <y>" per source line.
  # BOTH are needed: the identity column must be "Name <email>", the same shape
  # `git log --pretty=%an <%ae>` produces, or an identity mapping keyed on that
  # shape silently matches nothing. Emitting the bare name made every author look
  # unmappable, which in turn made every contributor look departed and every file
  # look orphaned.
  git blame --line-porcelain "$REF" -- "$f" 2>/dev/null \
    | awk -v path="$f" '
        /^author / && !/^author-/ { name = substr($0, 8); next }
        /^author-mail / { mail = substr($0, 13); if (name != "") c[name " " mail]++; name = "" }
        END { for (k in c) printf "%s\t%s\t%d\n", path, k, c[k] }
      ' || true
  n=$((n+1))
done

# Progress goes to stderr so stdout stays a clean TSV.
printf 'blame-cache: %s files scanned at %s\n' \
  "$(printf '%s\n' "$files" | grep -c . || true)" "$REF" >&2
