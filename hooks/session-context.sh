#!/usr/bin/env bash
source "$(dirname "$0")/../bin/_lib.sh"
input="$(cat)"
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
[ -n "$cwd" ] || cwd="$PWD"
name="$(harness_repo_name "$cwd")" || exit 0
recipes="$HOME/.agent-harness/cache/recipes/$name"

out=""
if [ -d "$recipes" ]; then
  for f in "$recipes"/*.md; do
    [ -e "$f" ] || continue
    title="$(head -1 "$f" | sed 's/^#[[:space:]]*//')"
    out="$out
- $title → $f"
  done
fi
handoff="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null).handoff"
[ -d "$handoff" ] && out="$out
Task handoff dir: $handoff"

[ -n "$out" ] || exit 0
printf 'Harness recipes for %s (match → follow verbatim, still verify):%s\n' "$name" "$out"
