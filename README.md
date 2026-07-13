# Agent Harness

One harness for Claude Code, Cursor CLI and Codex CLI: shared rules, model-tiered sub-agents, a solve loop, and a recipe cache.

## Install
Copy the repo contents into your project root, then:

```sh
./setup.sh
```

## How it hooks in
| CLI | Entry |
|---|---|
| Claude Code | `CLAUDE.md` → `AGENTS.md`, `.claude/agents/` + `.claude/commands/` |
| Cursor | `AGENTS.md` + `.cursor/rules/harness.mdc`, `.cursor/commands/` |
| Codex | `AGENTS.md`; prompts symlinked to `~/.codex/prompts/` by setup.sh |

## Use
`/loop min|med|max <task>` — min: straight to PR · med: + review · max: + plan + tests.
Standalone: `/plan` `/review` `/test` `/ship` `/search`.

## Layout
- `AGENTS.md` — the contract
- `rules/` — per-stack best practices
- `skills/` — sub-agent specs, one model tier per task
- `cache/` — saved recipes for repeated tasks
- `MACHINE.md` — personal rules (gitignored)
- `.env` — API keys (gitignored)
