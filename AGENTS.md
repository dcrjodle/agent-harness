# Agent Harness

Single source of truth for coding agents (Claude Code, Cursor, Codex). Follow exactly.

## Setup
- Secrets: `.env` (gitignored, copy `.env.example`). Read keys from it. Never commit or print values.
- Personal rules: `MACHINE.md` (gitignored, copy `MACHINE.example.md`). If present, it overrides these docs.

## Rules
Read the rules file for each stack you touch, before editing:
- [rules/react.md](rules/react.md)
- [rules/typescript.md](rules/typescript.md)
- [rules/dotnet.md](rules/dotnet.md)
- [rules/python.md](rules/python.md)
- [rules/git.md](rules/git.md)

## Sub-agents
Keep the main context clean: delegate everything not core to the current task to a sub-agent.

| Task | Skill | Tier |
|---|---|---|
| git/gh: pull, push, PR | [skills/git-ops.md](skills/git-ops.md) | small |
| search: code, docs, web | [skills/search.md](skills/search.md) | small |
| plan | [skills/plan.md](skills/plan.md) | large |
| implement | [skills/implement.md](skills/implement.md) | medium |
| review | [skills/review.md](skills/review.md) | large |
| test | [skills/test.md](skills/test.md) | medium |

Tiers — Claude Code: haiku / sonnet / opus. Cursor, Codex: cheapest / default / strongest available.
No sub-agent support? Run the skill inline, keep only its summary in context.

## Loop
Solve every task with the loop (`/loop [min|med|max] <task>`, default med):
- **min**: implement → ship (no review, no tests)
- **med**: implement → review → fix → ship
- **max**: plan → implement → review → test → fix → ship

One sub-agent per stage, only summaries flow between stages. Details: [skills/loop.md](skills/loop.md).

## Cache
- Before exploring: check [cache/INDEX.md](cache/INDEX.md). Match → follow recipe verbatim.
- After discovery-heavy work: save a recipe. See [cache/README.md](cache/README.md).
