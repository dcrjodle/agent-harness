#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

HARNESS="$HOME/.agent-harness"

link() {
  if [ -L "$2" ]; then
    case "$(readlink "$2")" in
      "$HARNESS"/*) ln -sf "$1" "$2" ;;
      *) echo "skip (exists, not ours): $2" ;;
    esac
  elif [ -e "$2" ]; then
    echo "skip (exists, not ours): $2"
  else
    ln -sf "$1" "$2"
  fi
}

if [ "${1:-}" = "--project" ]; then
  dest="${2:?usage: ./setup.sh --project <repo-path>}"
  [ -L "$HARNESS" ] || { echo "error: run ./setup.sh first to create $HARNESS" >&2; exit 1; }
  mkdir -p "$dest/.cursor/rules" "$dest/.cursor/commands"
  link "$HARNESS/.cursor/rules/harness.mdc" "$dest/.cursor/rules/agent-harness.mdc"
  for f in .cursor/commands/*.md; do link "$HARNESS/$f" "$dest/.cursor/commands/$(basename "$f")"; done
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

# Claude Code — global agents, commands, CLAUDE.md import
mkdir -p "$HOME/.claude/agents" "$HOME/.claude/commands"
for f in .claude/agents/*.md; do link "$HARNESS/$f" "$HOME/.claude/agents/$(basename "$f")"; done
for f in .claude/commands/*.md; do link "$HARNESS/$f" "$HOME/.claude/commands/$(basename "$f")"; done
touch "$HOME/.claude/CLAUDE.md"
grep -qF '@~/.agent-harness/AGENTS.md' "$HOME/.claude/CLAUDE.md" || printf '\n@~/.agent-harness/AGENTS.md\n' >> "$HOME/.claude/CLAUDE.md"

# Codex — global AGENTS.md pointer + prompts
mkdir -p "$HOME/.codex/prompts"
for f in .codex/prompts/*.md; do link "$HARNESS/$f" "$HOME/.codex/prompts/$(basename "$f")"; done
touch "$HOME/.codex/AGENTS.md"
grep -qF '~/.agent-harness/AGENTS.md' "$HOME/.codex/AGENTS.md" || printf '\nRead ~/.agent-harness/AGENTS.md and follow it exactly.\n' >> "$HOME/.codex/AGENTS.md"

# Cursor — no file-based global config; wire it manually + per project
echo "cursor: add a User Rule in Cursor settings: 'Read ~/.agent-harness/AGENTS.md and follow it exactly.'"
echo "cursor: per repo, run ./setup.sh --project <repo-path> to link rules + commands."
echo "harness linked at $HARNESS — edit .env and MACHINE.md"
