# Agent Harness

Global contract for coding agents on this machine (Claude Code, Codex, Cursor), installed at `~/.agent-harness`. Follow exactly. Everything linked here is read on demand.

## Setup
- Secrets: `~/.agent-harness/.env` (gitignored). Pass keys by reference (`source`, `--env-file`); never read, print or commit values.
- Personal rules: `~/.agent-harness/MACHINE.md` (gitignored) overrides this file.

## Rules
Read the rules file for each stack before editing it: `~/.agent-harness/rules/git.md` (every task), `~/.agent-harness/rules/react.md`, `~/.agent-harness/rules/typescript.md`, `~/.agent-harness/rules/dotnet.md`, `~/.agent-harness/rules/python.md`.

## Work
Every code change goes through `/solve [inline|loop] <task>` (`~/.agent-harness/skills/solve/SKILL.md`):
- **inline** (default): you do the work yourself in a task worktree. A UI change gets one verifier for screenshots, which you judge against the design.
- **loop**: only for work that is both complex and broad (criteria in solve). You orchestrate and never read source.

When unsure, inline. Don't split work or spawn agents that inline work doesn't need.

Roles in `~/.agent-harness/agents/`, one job each:

| Role | Tier | Job |
|---|---|---|
| planner | large | plan and checks for a loop |
| implementer | large | product code for one lane or one findings file |
| tester | medium | writes and runs automated tests |
| verifier | medium | runs the app, performs checks, saves screenshots |
| designer | large | compares screenshots with the design |
| reviewer | large | reviews the code diff |
| searcher | small | lookups |

Tiers — Claude Code: haiku / sonnet / opus. Codex, Cursor: cheapest / default / strongest. No sub-agents → run the role file inline and keep only its output.

Git plumbing is scripted in `~/.agent-harness/bin/`: `task-start`, `task-fork`, `task-join`, `task-status`, `task-ship`, `task-cleanup`.

## Cost
Tokens grow with turns × context, so long-running agents dominate cost. Keep each sub-agent short and single-purpose: a brief of a few lines, file paths instead of pasted content. For a new round, start a fresh agent with the findings file instead of resuming one with a large context. `~/.agent-harness/bin/stage-times` shows minutes and tokens per agent (`--roles` per role).

## Cache
Private recipes in `~/.agent-harness/cache/recipes/<repo>/` are listed at session start by a hook (Cursor: `ls` that folder). A match → follow it verbatim, still verify. Discovery-heavy task → `/recipe`.
