# Agent Harness

One global harness for Claude Code, Codex CLI and Cursor: a short contract, per-stack rules, model-tiered roles, one solve loop, scripted git plumbing, safety hooks and a private recipe cache.

It is built to keep the expensive model doing only orchestration. Planning goes to the large model once. Code, tests and re-reviews go to the medium model. Lookups go to the small one. Stages hand work over through files, so nothing large passes through the main context.

## Install
Requires `git`, `gh` and `jq`.

```sh
./setup.sh
```

The clone is symlinked to `~/.agent-harness`. Each CLI's user config then points into it, so every agent on the machine follows the harness in any repo. Re-run after `git pull`. Links and files the installer did not create are left alone. Hook config is merged, never replaced, and the first run backs it up to `*.pre-harness`.

| CLI | What setup wires |
|---|---|
| Claude Code | `@~/.agent-harness/AGENTS.md` in `~/.claude/CLAUDE.md`; roles → `~/.claude/agents/`; skills → `~/.claude/skills/`; hooks → `~/.claude/settings.json` |
| Codex | pointer in `~/.codex/AGENTS.md`; skills → `~/.codex/skills/`; hooks → `~/.codex/hooks.json` (approve them when Codex asks to trust hooks) |
| Cursor | add a User Rule: `Read ~/.agent-harness/AGENTS.md and follow it exactly.` Per repo: `./setup.sh --project <path>` links the rule and the skills as commands |

## Use
- `/loop [min|med|max] <task>` solves a change end to end. min: implement → PR. med: implement → test → review → PR. max: plan → parallel implement lanes → test → review → PR. Without a degree the orchestrator picks one from the task size.
- `/plan` `/test` `/review` `/ship` `/search` run one stage. `/recipe` saves what a session learned. `/cleanup` removes merged worktrees.
- `bin/stage-times` shows how long each sub-agent stage took.

## Layout
| Path | What |
|---|---|
| `AGENTS.md` | the contract; the only file loaded every session |
| `rules/` | per-stack rules, read on demand |
| `agents/` | roles: planner, implementer, tester, reviewer, searcher (Claude subagents; other CLIs run them inline) |
| `skills/` | entry points: loop, plan, test, review, ship, search, recipe, cleanup |
| `bin/` | `task-start`, `task-ship`, `task-cleanup`, `stage-times` |
| `hooks/` | `session-context.sh` lists this repo's recipes at session start; `guard.sh` blocks force-pushes, pushes and commits on the default branch, `.env` reads, and sub-agents spawning sub-agents; `stage-log.sh` records stage timings |
| `cache/recipes/` | private per-repo recipes (gitignored) |
| `MACHINE.md`, `.env` | personal rules and keys (gitignored) |

## How the loop stays cheap and quick
- **Plan once, on the large model.** Decisions that are binding stop reviewers from redesigning the work in later rounds.
- **Parallel lanes.** Issues whose files don't overlap are implemented at the same time.
- **Evidence before review.** The tester runs the plan's acceptance checks, so the reviewer reads proof instead of claims.
- **Scoped re-reviews.** Round 2 only checks the fixes. Nits go to the PR body, not another round. At most 2 fix rounds.
- **Files, not context.** Plans, findings and PR bodies live in `~/.agent-worktrees/<repo>/<slug>.handoff/`.
- **No nested agents.** Roles can't spawn sub-agents; the guard hook backs this up.

## License
[MIT](LICENSE)
