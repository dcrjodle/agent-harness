# Agent Harness

Global contract for coding agents (Claude Code, Cursor, Codex) on this machine, installed at `~/.agent-harness`. Follow exactly.
This file is the only always-loaded context. Everything it links is read on demand — open a file only when its trigger hits.

## Setup
- Secrets: `~/.agent-harness/.env` (gitignored). Pass keys by reference (`source`, `--env-file`) — never read, print, or commit values.
- Personal rules: `~/.agent-harness/MACHINE.md` (gitignored). If present, it overrides these docs.

## Rules
Read the rules file for each stack you touch, before editing:
- every task: `~/.agent-harness/rules/git.md` — worktree per task, branches, PRs, cleanup
- `~/.agent-harness/rules/react.md`
- `~/.agent-harness/rules/typescript.md`
- `~/.agent-harness/rules/dotnet.md`
- `~/.agent-harness/rules/python.md`

## Sub-agents
Keep the main context clean: delegate everything not core to the current task to a sub-agent.

| Task | Skill | Tier |
|---|---|---|
| git/gh: worktree, push, PR, cleanup | `~/.agent-harness/skills/git-ops.md` | small |
| search: code, docs, web | `~/.agent-harness/skills/search.md` | small |
| plan | `~/.agent-harness/skills/plan.md` | large |
| implement | `~/.agent-harness/skills/implement.md` | medium |
| review | `~/.agent-harness/skills/review.md` | large |
| test | `~/.agent-harness/skills/test.md` | medium |

Tiers — Claude Code: haiku / sonnet / opus. Cursor, Codex: cheapest / default / strongest available.
No sub-agent support? Run the skill inline, keep only its summary in context.

## Loop
Solve every task with the loop: `/loop [min|med|max] <task>`, default med. Stages, degrees, and fix rounds: `~/.agent-harness/skills/loop.md`.
After a PR merges: `/cleanup` removes its worktree and branch.

## Cache
- Before exploring: check `~/.agent-harness/cache/INDEX.md`. Match → follow the recipe verbatim, but verify its output as usual.
- After discovery-heavy work: save a recipe. See `~/.agent-harness/cache/README.md`.
