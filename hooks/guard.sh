#!/usr/bin/env bash
source "$(dirname "$0")/../bin/_lib.sh"
input="$(cat)"
command -v jq >/dev/null || exit 0

deny() { echo "harness guard: $1" >&2; exit 2; }

tool="$(printf '%s' "$input" | jq -r '.tool_name // empty')"
agent="$(printf '%s' "$input" | jq -r '.agent_id // empty')"
case "$tool" in
  Agent|Task) [ -n "$agent" ] && deny "sub-agents must not spawn sub-agents; do the work yourself or report back to the orchestrator." ; exit 0 ;;
esac

cwd="$(printf '%s' "$input" | jq -r '.cwd // empty')"

# env-file basename check, shared by the Read/Grep path and the Bash path.
is_env_path() {
  case "$(basename -- "$1" 2>/dev/null)" in
    .env) return 0 ;;
    .env.example|.env.sample|.env.template) return 1 ;;
    .env.*) return 0 ;;
  esac
  return 1
}

case "$tool" in
  Read|Grep)
    path="$(printf '%s' "$input" | jq -r '(.tool_input.file_path // .tool_input.path // empty)')"
    if [ -n "$path" ] && is_env_path "$path"; then
      deny "don't read .env files; pass secrets by reference (source / --env-file)."
    fi
    exit 0
    ;;
esac

cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty | if type == "array" then join(" ") else . end')"
[ -n "$cmd" ] || exit 0

# .env reads via shell readers/searchers: match the path token independently of
# what precedes it (flags, other args), excluding .env.example/.sample/.template.
while IFS= read -r seg; do
  printf '%s' "$seg" | grep -Eq '(^|[[:space:]])(cat|less|more|head|tail|bat|strings|base64|xxd|od|grep|egrep|fgrep|sed|awk|jq)([[:space:]]|$)' || continue
  printf '%s' "$seg" | grep -Eq '(^|[/"'\''[:space:]=])\.env(\.[a-zA-Z_]+)?(["'\''[:space:]]|$)' || continue
  printf '%s' "$seg" | grep -Eq '\.env\.(example|sample|template)(["'\''[:space:]]|$)' && continue
  deny "don't read .env files; pass secrets by reference (source / --env-file)."
done <<< "$(printf '%s\n' "$cmd" | tr ';&|' '\n\n\n')"

# Global git options before the subcommand, e.g. `--no-pager`, `-c k=v`, `-C <path>`.
git_opts='(-C[[:space:]]+[^[:space:]]+|-c[[:space:]]+[^[:space:]]+|--no-pager|--paginate|--git-dir=[^[:space:]]+|--work-tree=[^[:space:]]+|--)'
git_re="(^|[;&|[:space:]])git([[:space:]]+${git_opts})*[[:space:]]+(push|commit)([[:space:]]|\$)"
printf '%s' "$cmd" | grep -Eq "$git_re" || exit 0

# Extract the -C path (if any) that applies to the matched git invocation, to run
# the branch check against the right worktree instead of skipping it outright.
resolve_path() {
  local p="${1#[\"\']}"; p="${p%[\"\']}"
  case "$p" in
    "~"*) p="$HOME${p#\~}" ;;
    /*) ;;
    *) p="$2/$p" ;;
  esac
  printf '%s' "$p"
}
git_cwd="$cwd"
cd_path="$(printf '%s' "$cmd" | grep -Eo '(^|[;&|[:space:]])cd[[:space:]]+[^;&|[:space:]]+' | tail -1 | sed -E 's/^.*cd[[:space:]]+//')"
[ -n "$cd_path" ] && git_cwd="$(resolve_path "$cd_path" "$cwd")"
c_path="$(printf '%s' "$cmd" | grep -Eo '(^|[;&|[:space:]])git([[:space:]]+'"$git_opts"')*[[:space:]]+(push|commit)' | grep -Eo -- '-C[[:space:]]+[^[:space:]]+' | tail -1 | sed -E 's/^-C[[:space:]]+//')"
[ -n "$c_path" ] && git_cwd="$(resolve_path "$c_path" "$git_cwd")"

if printf '%s' "$cmd" | grep -Eq "(^|[;&|[:space:]])git([[:space:]]+${git_opts})*[[:space:]]+push"; then
  # Isolate the push segment (up to the next command separator) so unrelated
  # trailing commands (e.g. `git push -u origin x && rm -f a`) aren't scanned.
  push_seg="$(printf '%s\n' "$cmd" | grep -Eo "git([[:space:]]+${git_opts})*[[:space:]]+push[^;&|]*")"
  printf '%s' "$push_seg" | grep -Eq '[[:space:]](-f|--force|--force-with-lease)([[:space:]=]|$)|[[:space:]]\+[^[:space:]]+' && deny "never force-push."

  default="$(harness_default_branch "$git_cwd" 2>/dev/null || echo main)"
  if printf '%s' "$push_seg" | grep -Eq "[[:space:]:](refs/heads/)?(main|master|${default})([[:space:]]|\$)"; then
    deny "never push to the default branch; ship a task branch with bin/task-ship. If you believe this is wrong, ask the user rather than trying to bypass this check."
  fi
fi

# HARNESS_ALLOW_DEFAULT=1 only waives the "you're on the default branch, use
# task-start" nudge for commit; it must never waive the push-to-default deny above.
case "$cmd" in *HARNESS_ALLOW_DEFAULT=1*) exit 0 ;; esac

case "$git_cwd" in *'$'*) exit 0 ;; esac
[ -d "$git_cwd" ] || exit 0
branch="$(git -C "$git_cwd" branch --show-current 2>/dev/null)" || exit 0
default="$(harness_default_branch "$git_cwd" 2>/dev/null || echo main)"
case "$branch" in
  main|master|"$default")
    deny "you're on '$branch'. Start a task branch first: ~/.agent-harness/bin/task-start <feat|fix|chore> <slug>. (Intentional? prefix the command with HARNESS_ALLOW_DEFAULT=1.)"
    ;;
esac
exit 0
