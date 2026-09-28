#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
HARNESS="$HOME/.agent-harness"
SKILLS=(skills/*/)

ours() { case "$(readlink "$1")" in "$HARNESS"/*|"$PWD"/*) return 0 ;; esac; return 1; }

link() {
  if [ -L "$2" ]; then
    ours "$2" && ln -sfn "$1" "$2" || echo "skip (exists, not ours): $2"
  elif [ -e "$2" ]; then
    echo "skip (exists, not ours): $2"
  else
    ln -sfn "$1" "$2"
  fi
}

prune() {
  for l in "$1"/*; do
    [ -L "$l" ] && ours "$l" && [ ! -e "$l" ] && rm "$l" && echo "removed stale link: $l"
  done
  return 0
}

merge_hooks() {
  local file="$1" guard_matcher="$2"
  command -v jq >/dev/null || { echo "jq not found: add hooks to $file by hand (see README)"; return 0; }
  [ -s "$file" ] || echo '{}' > "$file"
  [ -e "$file.pre-harness" ] || cp "$file" "$file.pre-harness"
  local tmp; tmp="$(mktemp)"
  jq --arg ctx 'f="$HOME/.agent-harness/hooks/session-context.sh"; [ -x "$f" ] || exit 0; exec "$f"' \
     --arg guard 'f="$HOME/.agent-harness/hooks/guard.sh"; [ -x "$f" ] || exit 0; exec "$f"' \
     --arg log 'f="$HOME/.agent-harness/hooks/stage-log.sh"; [ -x "$f" ] || exit 0; exec "$f"' \
     --arg matcher "$guard_matcher" --argjson subagents "$3" '
    def strip: map(.hooks |= map(select((.command // "") | contains(".agent-harness/hooks/") | not))) | map(select(.hooks | length > 0));
    def add(ev; entry): .hooks[ev] = (((.hooks[ev] // []) | strip) + [entry]);
    .hooks = (.hooks // {})
    | add("SessionStart"; {hooks: [{type: "command", command: $ctx}]})
    | add("PreToolUse"; (if $matcher == "" then {} else {matcher: $matcher} end) + {hooks: [{type: "command", command: $guard}]})
    | if $subagents then add("SubagentStart"; {hooks: [{type: "command", command: $log}]}) | add("SubagentStop"; {hooks: [{type: "command", command: $log}]}) else . end
  ' "$file" > "$tmp" && cat "$tmp" > "$file" && rm "$tmp"
  echo "hooks merged into $file (backup: $file.pre-harness)"
}

if [ "${1:-}" = "--project" ]; then
  dest="${2:?usage: ./setup.sh --project <repo-path>}"
  [ -L "$HARNESS" ] || { echo "error: run ./setup.sh first to create $HARNESS" >&2; exit 1; }
  mkdir -p "$dest/.cursor/rules" "$dest/.cursor/commands"
  link "$HARNESS/cursor/harness.mdc" "$dest/.cursor/rules/agent-harness.mdc"
  for d in "${SKILLS[@]}"; do n="$(basename "$d")"; link "$HARNESS/skills/$n/SKILL.md" "$dest/.cursor/commands/$n.md"; done
  prune "$dest/.cursor/commands"
  echo "cursor wired for $dest"
  exit 0
fi

if [ -e "$HARNESS" ] && [ ! -L "$HARNESS" ]; then
  echo "error: $HARNESS exists and is not a symlink" >&2
  exit 1
fi
ln -sfn "$PWD" "$HARNESS"

[ -f .env ] || cp .env.example .env
[ -f MACHINE.md ] || printf '# Machine rules — personal, gitignored. Overrides repo docs. See MACHINE.example.md.\n' > MACHINE.md
mkdir -p cache/recipes logs
chmod +x bin/* hooks/*.sh

# Claude Code — roles, skills, hooks, CLAUDE.md import
mkdir -p "$HOME/.claude/agents" "$HOME/.claude/skills" "$HOME/.claude/commands"
for f in agents/*.md; do link "$HARNESS/$f" "$HOME/.claude/agents/$(basename "$f")"; done
for d in "${SKILLS[@]}"; do n="$(basename "$d")"; link "$HARNESS/skills/$n" "$HOME/.claude/skills/$n"; done
prune "$HOME/.claude/agents"; prune "$HOME/.claude/skills"; prune "$HOME/.claude/commands"
touch "$HOME/.claude/CLAUDE.md"
grep -qF '@~/.agent-harness/AGENTS.md' "$HOME/.claude/CLAUDE.md" || printf '\n@~/.agent-harness/AGENTS.md\n' >> "$HOME/.claude/CLAUDE.md"
merge_hooks "$HOME/.claude/settings.json" "Bash|Agent|Task" true

# Codex — skills, hooks, AGENTS.md pointer
mkdir -p "$HOME/.codex/skills" "$HOME/.codex/prompts"
for d in "${SKILLS[@]}"; do n="$(basename "$d")"; link "$HARNESS/skills/$n" "$HOME/.codex/skills/$n"; done
prune "$HOME/.codex/skills"; prune "$HOME/.codex/prompts"
touch "$HOME/.codex/AGENTS.md"
grep -qF '~/.agent-harness/AGENTS.md' "$HOME/.codex/AGENTS.md" || printf '\nRead ~/.agent-harness/AGENTS.md and follow it exactly.\n' >> "$HOME/.codex/AGENTS.md"
merge_hooks "$HOME/.codex/hooks.json" "" false
echo "codex: approve the new hooks when Codex asks you to trust them."

echo "cursor: add a User Rule in Cursor settings: 'Read ~/.agent-harness/AGENTS.md and follow it exactly.'"
echo "cursor: per repo, run ./setup.sh --project <repo-path> to link the rule + skills as commands."
echo "harness linked at $HARNESS — edit .env and MACHINE.md"
