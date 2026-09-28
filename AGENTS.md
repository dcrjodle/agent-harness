# Agent Harness

Global contract for coding agents on this machine (Claude Code, Codex, Cursor), installed at `~/.agent-harness`. Follow exactly. Everything linked here is read on demand.

## Setup
- Secrets: `~/.agent-harness/.env` (gitignored). Pass keys by reference (`source`, `--env-file`); never read, print or commit values.
- Personal rules: `~/.agent-harness/MACHINE.md` (gitignored) overrides this file.

## Rules
Read the rules file for each stack before editing it: `rules/git.md` (every task), `rules/react.md`, `rules/typescript.md`, `rules/dotnet.md`, `rules/python.md`.

## Work
Solve every code change with `/loop [min|med|max] <task>` (`skills/loop/SKILL.md`). Roles are in `agents/`:

| Role | Tier | Job |
|---|---|---|
| planner | large | decisions, parallel lanes, acceptance checks |
| implementer | medium | code + unit tests, commit per issue, fixes |
| tester | medium | gates + acceptance checks with evidence |
| reviewer | large, re-review medium | findings file |
| searcher | small | lookups |

Tiers — Claude Code: haiku / sonnet / opus. Codex, Cursor: cheapest / default / strongest. No sub-agents → run the role file inline and keep only its output.

Git plumbing is scripted, no agent needed: `bin/task-start`, `bin/task-ship`, `bin/task-cleanup`.

## Cost
The main session runs the most expensive model, so it only orchestrates: no code exploration, no reading source, no copying findings into briefs. Discovery belongs to the planner or searcher; details go through handoff files.

## Cache
Private recipes in `cache/recipes/<repo>/` are listed at session start by a hook (Cursor: `ls` that folder). A match → follow it verbatim, still verify. Discovery-heavy task → `/recipe`.
