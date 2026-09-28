# Agent Harness

One global harness for Claude Code, Codex CLI and Cursor: a short contract, per-stack rules, model-tiered roles, one solve loop, scripted git plumbing, safety hooks and a private recipe cache.

It is built to keep the expensive model doing only orchestration. The large model does the thinking: the plan, the code and the first review. The medium model does procedural work: tests, running the app, screenshots and re-reviews. The small model does lookups. Stages hand work over through files, so nothing large passes through the main context.

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
- `/solve [min|med|max] <task>` solves a change end to end. min: implement → test → PR. med: implement → test + verify → review → PR. max: plan → parallel implement lanes → test + verify → review → PR. Without a degree the orchestrator picks one from the task size.
- `/plan` `/test` `/verify` `/review` `/ship` `/search` run one stage. `/recipe` saves what a session learned. `/cleanup` removes merged worktrees.
- `bin/stage-times` shows how long each sub-agent stage took.
- Invocation differs by CLI: Claude Code uses `/solve ...` (slash command). Codex invokes the same file as a prompt, e.g. `$solve ...` (no `/`, and `$ARGUMENTS` is not expanded — the skill text stands on its own without it). Cursor runs it as a linked command from `.cursor/commands/` after `./setup.sh --project <path>`.

## Layout
| Path | What |
|---|---|
| `AGENTS.md` | the contract; the only file loaded every session |
| `rules/` | per-stack rules, read on demand |
| `agents/` | roles: planner, implementer, tester, verifier, reviewer, searcher (Claude subagents; other CLIs run them inline) |
| `skills/` | entry points: solve, plan, test, verify, review, ship, search, recipe, cleanup |
| `bin/` | `task-start`, `task-ship`, `task-cleanup`, `stage-times` |
| `hooks/` | `session-context.sh` lists this repo's recipes at session start; `guard.sh` blocks force-pushes, pushes and commits on the default branch, `.env` reads (Bash and Claude's Read/Grep tools), and sub-agents spawning sub-agents; `stage-log.sh` records stage timings |
| `cursor/` | `harness.mdc` — the Cursor User Rule content, linked in per repo by `--project` |
| `cache/recipes/` | private per-repo recipes (gitignored) |
| `MACHINE.md`, `.env` | personal rules and keys (gitignored) |

## How the loop stays cheap and quick
- **Plan once, on the large model.** Decisions that are binding stop reviewers from redesigning the work in later rounds.
- **Parallel lanes.** Issues whose files don't overlap are implemented at the same time.
- **One job per role.** Implementers only write code and run static checks; a hook stops them from running tests or apps. The tester owns automated tests and runs them efficiently. The verifier owns the running app and screenshots, so single-instance tools never collide.
- **Evidence before review.** Test and verify run in parallel before review, so the reviewer reads proof and screenshots instead of claims.
- **Scoped re-reviews.** Round 2 only checks the fixes. Nits go to the PR body, not another round. At most 2 fix rounds.
- **Files, not context.** Plans, findings and PR bodies live in `~/.agent-worktrees/<repo>/<slug>.handoff/`.
- **No nested agents.** Roles can't spawn sub-agents; the guard hook backs this up.

## License
[MIT](LICENSE)
