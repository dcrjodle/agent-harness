#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
[ -f MACHINE.md ] || cp MACHINE.example.md MACHINE.md
if command -v codex >/dev/null 2>&1; then
  mkdir -p ~/.codex/prompts
  for f in .codex/prompts/*.md; do ln -sf "$PWD/$f" ~/.codex/prompts/; done
fi
echo "harness ready — edit .env and MACHINE.md"
