#!/usr/bin/env bash
input="$(cat)"
command -v jq >/dev/null || exit 0

deny() { echo "harness guard: $1" >&2; exit 2; }

tool="$(printf '%s' "$input" | jq -r '.tool_name // empty')"
agent="$(printf '%s' "$input" | jq -r '.agent_id // empty')"
case "$tool" in
  Agent|Task) [ -n "$agent" ] && deny "sub-agents must not spawn sub-agents; do the work yourself or report back to the orchestrator." ; exit 0 ;;
esac

cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty | if type == "array" then join(" ") else . end')"
[ -n "$cmd" ] || exit 0
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty')"

if printf '%s' "$cmd" | grep -Eq '(^|[;&|[:space:]])(cat|less|more|head|tail|bat|strings|base64|xxd|od)[[:space:]][^;&|]*(^|/|[[:space:]])\.env([[:space:];&|]|$)'; then
  deny "don't read .env files; pass secrets by reference (source / --env-file)."
fi

printf '%s' "$cmd" | grep -Eq '(^|[;&|[:space:]])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+(push|commit)([[:space:]]|$)' || exit 0

if printf '%s' "$cmd" | grep -Eq 'git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+push' ; then
  printf '%s' "$cmd" | grep -Eq '[[:space:]](-f|--force|--force-with-lease)([[:space:]=]|$)|[[:space:]]\+[^[:space:]]+' && deny "never force-push."
  printf '%s' "$cmd" | grep -Eq 'push[^;&|]*[[:space:]:](main|master)([[:space:]]|$)' && deny "never push to the default branch; ship a task branch with bin/task-ship."
fi

case "$cmd" in *HARNESS_ALLOW_DEFAULT=1*) exit 0 ;; esac
printf '%s' "$cmd" | grep -Eq '(^|[;&|[:space:]])cd[[:space:]]|git[[:space:]]+-C[[:space:]]' && exit 0
[ -n "$cwd" ] || exit 0
branch="$(git -C "$cwd" branch --show-current 2>/dev/null)" || exit 0
case "$branch" in
  main|master) deny "you're on '$branch'. Start a task branch first: ~/.agent-harness/bin/task-start <feat|fix|chore> <slug>. (Intentional? prefix the command with HARNESS_ALLOW_DEFAULT=1.)" ;;
esac
exit 0
