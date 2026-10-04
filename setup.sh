#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
HARNESS="$HOME/.agent-harness"
CLAUDE="$HOME/.claude"
# jq: drop every hook entry that runs a harness hook, then the matchers and events left empty.
STRIP='def strip: map_values(map(.hooks = ((.hooks // []) | map(select((.command // "") | contains(".agent-harness/hooks/") | not)))) | map(select(.hooks | length > 0))) | with_entries(select(.value | length > 0));'

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

rewrite() {
  local file="$1" tmp; shift
  tmp="$(mktemp)"
  if jq "$@" "$file" > "$tmp"; then cat "$tmp" > "$file"; rm -f "$tmp"; else rm -f "$tmp"; echo "could not rewrite $file" >&2; return 1; fi
}

# Hooks and the mod folder are merged into settings.json: entries that are not the harness's stay as they are.
merge_settings() {
  local file="$CLAUDE/settings.json"
  command -v jq >/dev/null || { echo "jq not found: add the hooks to $file by hand (see README)"; return 0; }
  [ -s "$file" ] || echo '{}' > "$file"
  [ -e "$file.pre-harness" ] || cp "$file" "$file.pre-harness"
  rewrite "$file" --arg mod '~/.agent-harness/mods/observability' "$STRIP"'
    def wire(ev; name; matcher): .hooks[ev] += [(if matcher == "" then {} else {matcher: matcher} end)
      + {hooks: [{type: "command", command: ("f=\"$HOME/.agent-harness/hooks/" + name + "\"; [ -x \"$f\" ] || exit 0; exec \"$f\"")}]}];
    def wire(ev; name): wire(ev; name; "");
    .hooks = ((.hooks // {}) | strip)
    | wire("SessionStart"; "session-context.sh")
    | wire("PreToolUse"; "guard.sh"; "Bash|Agent|Task|Read|Grep|Edit|Write|mcp__.*")
    | wire("SubagentStart"; "stage-log.sh") | wire("SubagentStop"; "stage-log.sh")
    | wire("PreToolUse"; "observe.sh"; "Agent|Task") | wire("PostToolUse"; "observe.sh"; "Agent|Task")
    | reduce ("SessionStart", "UserPromptSubmit", "PostToolUseFailure", "SubagentStart", "SubagentStop", "Stop", "StopFailure", "SessionEnd") as $ev (.; wire($ev; "observe.sh"))
    | .env.CLAUDE_CODE_PLUGIN_DIRS = ((((.env.CLAUDE_CODE_PLUGIN_DIRS // "") | split(":") | map(select(. != "" and . != $mod))) + [$mod]) | join(":"))
  ' && echo "hooks and the observability mod merged into $file (backup: $file.pre-harness)"
}

if [ -e "$HARNESS" ] && [ ! -L "$HARNESS" ]; then
  echo "error: $HARNESS exists and is not a symlink" >&2
  exit 1
fi
ln -sfn "$PWD" "$HARNESS"

[ -f .env ] || cp .env.example .env
[ -f MACHINE.md ] || printf '# Machine rules — personal, gitignored. Overrides repo docs. See MACHINE.example.md.\n' > MACHINE.md
mkdir -p cache/recipes logs
chmod +x bin/* hooks/*.sh mods/*/bin/*

# Roles, skills, hooks, the observability mod and the CLAUDE.md import
mkdir -p "$CLAUDE/agents" "$CLAUDE/skills" "$CLAUDE/commands"
for f in agents/*.md; do link "$HARNESS/$f" "$CLAUDE/agents/$(basename "$f")"; done
for d in skills/*/; do n="$(basename "$d")"; link "$HARNESS/skills/$n" "$CLAUDE/skills/$n"; done
prune "$CLAUDE/agents"; prune "$CLAUDE/skills"; prune "$CLAUDE/commands"
touch "$CLAUDE/CLAUDE.md"
grep -qF '@~/.agent-harness/AGENTS.md' "$CLAUDE/CLAUDE.md" || printf '\n@~/.agent-harness/AGENTS.md\n' >> "$CLAUDE/CLAUDE.md"
merge_settings

# Earlier versions also wired Codex. Remove what they installed there; nothing else in ~/.codex is touched.
if [ -d "$HOME/.codex" ]; then
  for l in "$HOME/.codex/skills"/* "$HOME/.codex/prompts"/*; do
    if [ -L "$l" ] && ours "$l"; then rm "$l"; fi
  done
  f="$HOME/.codex/hooks.json"
  if [ -s "$f" ] && command -v jq >/dev/null; then rewrite "$f" "$STRIP"' .hooks = ((.hooks // {}) | strip)'; fi
  f="$HOME/.codex/AGENTS.md"
  pointer='Read ~/.agent-harness/AGENTS.md and follow it exactly.'
  if [ -f "$f" ] && grep -qxF "$pointer" "$f"; then
    tmp="$(mktemp)"; grep -vxF "$pointer" "$f" > "$tmp" || true; cat "$tmp" > "$f"; rm -f "$tmp"
  fi
fi

echo "harness linked at $HARNESS — edit .env and MACHINE.md, then restart Claude Code to load the hooks and the mod"
