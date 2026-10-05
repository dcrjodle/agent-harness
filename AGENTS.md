# Agent Harness

Global contract for coding agents on this machine (Claude Code, Codex, Cursor), installed at `~/.agent-harness`. Follow exactly. Everything linked here is read on demand.

## Setup
- Secrets: `~/.agent-harness/.env` (gitignored). Pass keys by reference (`source`, `--env-file`); never read, print or commit values.
- Personal rules: `~/.agent-harness/MACHINE.md` (gitignored) overrides this file.

## Rules
Read the rules file for each stack before editing it: `~/.agent-harness/rules/git.md` (every task), `~/.agent-harness/rules/react.md`, `~/.agent-harness/rules/typescript.md`, `~/.agent-harness/rules/dotnet.md`, `~/.agent-harness/rules/python.md`.

## Work
Every code change goes through `/solve [level] <task>` (`~/.agent-harness/skills/solve/SKILL.md`). The level, `small`, `medium` or `large` by default, sets the stages in `~/.agent-harness/settings.json`: whether a planner plans, whether you implement yourself or orchestrate implementers in parallel lanes (then you never read source), which of tester, verifier, designer and reviewer run, and how many fix rounds. `~/.agent-harness/bin/decide stages <level>` prints them. Don't spawn agents the level doesn't call for.

Decisions come only from `~/.agent-harness/bin/decide`, the harness's only Jev client, at three fixed points: the level and the recipe when a solve starts (a Claude Code hook adds them to the context) and, after implementation, whether the task changed a UI. A task whose first word names a level skips that decision (`inline` = the first level, `loop` = the last). Only the orchestrator runs it, only at those points; the harness keys are for `bin/decide` and `bin/session-log` alone.

In Claude Code, hooks log each session (its title and level, every sub-agent spawned, the decisions) to Supabase for Cockpit through `~/.agent-harness/bin/session-log`; that log is the orchestrator's, so a sub-agent never runs it except against a scratch harness in tests. Codex and Cursor sessions are not logged.

Roles in `~/.agent-harness/agents/`, one job each:

| Role | Job |
|---|---|
| planner | plan and checks, when the level plans |
| implementer | product code for one lane or one findings file |
| tester | writes and runs automated tests |
| verifier | runs the app, performs checks, saves screenshots |
| designer | compares screenshots with the design |
| reviewer | reviews the code diff |
| searcher | lookups |

A role's model is the `model:` line in its file (`inherit`, `haiku`, `sonnet`, `opus` or `fable`); nothing overrides it. Codex, Cursor: haiku → cheapest, sonnet → default, opus and fable → strongest, inherit → the session's model. No sub-agents → run the role file inline and keep only its output.

Git plumbing is scripted in `~/.agent-harness/bin/`: `task-start`, `task-fork`, `task-join`, `task-status`, `task-ship`, `task-cleanup`.

## Cost
Tokens grow with turns × context, so long-running agents dominate cost. Keep each sub-agent short and single-purpose: a brief of a few lines, file paths instead of pasted content. For a new round, start a fresh agent with the findings file instead of resuming one with a large context.

## Cache
Private recipes in `~/.agent-harness/cache/recipes/<repo>/` are listed at session start by a hook (Cursor: `ls` that folder). A solve follows the recipe its decision names; other work, a matching recipe. Follow it verbatim, still verify. Discovery-heavy task → `/recipe`.
