# Agent Harness

One global harness for Claude Code, Codex CLI and Cursor: a short contract, per-stack rules, roles with one job each, one solve skill whose stages follow the task's level, decisions by Jev at fixed points, scripted git plumbing, safety hooks and a private recipe cache.

It is built around three goals: fewer tokens, accuracy through verification (including a design check of screenshots), and parallel work on long jobs. Simplicity serves all three: small work runs in one session, agents join as the level grows, and the full multi-agent loop is reserved for complex, broad work. Every sub-agent has one job and a short prompt, and stages hand work over through files.

## Install
Requires `git`, `gh`, `jq` and Node 20.12 or later (for `bin/decide`).

```sh
./setup.sh
```

The clone is symlinked to `~/.agent-harness`. Each CLI's user config then points into it, so every agent on the machine follows the harness in any repo. Re-run after `git pull`: new hooks, roles and skills are wired only then. Links and files the installer did not create are left alone. Hook config is merged, never replaced, and the first run backs it up to `*.pre-harness`.

Decisions ask Jev only with a TypeSafe AI key: add `TYPESAFE_API_KEY=<key>` to `~/.agent-harness/.env` (setup creates it from `.env.example`). Without a key every decision takes its fallback, and work goes on.

| CLI | What setup wires |
|---|---|
| Claude Code | `@~/.agent-harness/AGENTS.md` in `~/.claude/CLAUDE.md`; roles → `~/.claude/agents/`; skills → `~/.claude/skills/`; hooks, including the decision hook → `~/.claude/settings.json` |
| Codex | pointer in `~/.codex/AGENTS.md`; skills → `~/.codex/skills/`; hooks → `~/.codex/hooks.json` (approve them when Codex asks to trust hooks) |
| Cursor | add a User Rule: `Read ~/.agent-harness/AGENTS.md and follow it exactly.` Per repo: `./setup.sh --project <path>` links the rule and the skills as commands |

## Use
- `/solve [level] <task>` solves a change end to end; its level sets the stages. Defaults: **small** (the session implements, tests and ships itself; a UI change gets one verifier, whose screenshots the session judges), **medium** (the session implements; a tester and the reviewer check it, and for a UI change the verifier and the designer), **large** (plan → parallel lanes in forks → test ∥ verify → design check ∥ review → fix → PR; the session orchestrates and never reads source). Jev picks the level unless the task's first word names one (`inline` = small, `loop` = large).
- `/plan` `/test` `/verify` `/review` `/ship` `/search` run one stage. `/verify` runs the verifier and, when checks name a design reference, the designer. `/recipe` saves what a session learned. `/cleanup` removes merged worktrees.
- `bin/stage-times [N|--roles]` shows active minutes and tokens (cache read, cache write, output) per agent or per role.
- Invocation differs by CLI: Claude Code uses `/solve ...` (slash command). Codex invokes the same file as a prompt, e.g. `$solve ...` (no `/`, and `$ARGUMENTS` is not expanded — the skill text stands on its own without it). Cursor runs it as a linked command from `.cursor/commands/` after `./setup.sh --project <path>`.

## Settings
`settings.json` is tracked and follows `settings.schema.json` (`bin/decide check` validates it). The next solve uses an edit.
- `levels`, least to most thorough: `id`, `label`, `description` (which tasks belong here; Jev picks the level against these texts) and `stages`:
  - `plan`: the planner writes plan and checks; off, the session writes the checks.
  - `implement`: `self`, the session writes the code; `agents`, it orchestrates lane 0 and then parallel lane forks (needs `plan`).
  - `test`: the tester writes and runs the tests; off, the session does.
  - `verify`: `off`, `ui` (when the UI decision says yes) or `always`.
  - `design`: `ui`, the designer judges the screenshots when the UI decision says yes and a check names a design reference; `off`, the session judges them. `ui` needs `verify`.
  - `review`: the reviewer reviews the diff.
  - `fixRounds`: the most fix rounds, 0 to 3.
- `decisions`: the pinned Jev model, the time budget, and per decision point `enabled`, `minConfidence` and its fixed wording.

| Level | plan | implement | test | verify | design | review | fix rounds |
|---|---|---|---|---|---|---|---|
| small | off | self | off | ui | off | off | 1 |
| medium | off | self | on | ui | ui | on | 1 |
| large | on | agents | on | ui | ui | on | 2 |

A role's model is the `model:` line of its file in `agents/` (`inherit`, `haiku`, `sonnet`, `opus` or `fable`); a new session picks up a change, and no skill overrides it. Codex and Cursor map it: haiku → cheapest, sonnet → default, opus and fable → strongest, inherit → the session's model.

## Decisions
`bin/decide` is the harness's only Jev client (TypeSafe AI, `POST /v1/systemone`), and only three points call it:

| Point | When | Question | Fallback |
|---|---|---|---|
| `level` | once when a solve starts | task text → a level | the more thorough of the top two |
| `recipe` | once when a solve starts, if the repo has recipes | task text and recipe titles → a recipe or none | none |
| `ui` | once after implementation, when verify or design is `ui` | changed paths and commit subjects since base → yes or no | yes |

In Claude Code, `hooks/decide-context.sh` runs `bin/decide start` when a solve starts, typed as `/solve` or through the Skill tool, and adds the level, its stages and the recipe to the context; elsewhere solve's first step runs it once. Decisions are as deterministic as possible: fixed wording from `settings.json`, a pinned model, argmax with ties to the earlier option, fixed thresholds and fixed fallbacks. Answers are cached in `logs/decisions/`, so the same question never calls the API twice, and every decision (Jev, cache, fallback or override) is appended to `logs/decisions.jsonl`. Nothing blocks work: no key, a network error, a timeout or an error status gives the fallback and exit 0. The guard keeps decisions with the orchestrator and the harness key with `bin/decide`; a project's own Jev use is left alone.

```sh
bin/decide start  [--repo DIR] [--json] [--] TASK...   # level, then recipe: the context block
bin/decide level|recipe [--repo DIR] [--json] [--] TASK...
bin/decide ui     [--base REV] [--json] WORKTREE         # base: <WORKTREE>.handoff/base
bin/decide stages [--json] LEVEL                         # a level's stages, without Jev
bin/decide check  [FILE]                                 # validate settings.json
```

## Layout
| Path | What |
|---|---|
| `AGENTS.md` | the contract; the only file loaded every session |
| `settings.json`, `settings.schema.json` | levels with their stages, decision settings, and their spec |
| `rules/` | per-stack rules, read on demand |
| `agents/` | roles, one job each, with their model: planner, implementer, tester, verifier, designer, reviewer, searcher (Claude subagents; other CLIs run them inline) |
| `skills/` | entry points: solve, plan, test, verify, review, ship, search, recipe, cleanup |
| `bin/` | `decide` (Jev decisions), `task-start`, `task-fork`/`task-join` (lanes and snapshots), `task-status` (open findings), `task-ship`, `task-cleanup`, `stage-times` |
| `hooks/` | `session-context.sh` lists this repo's recipes at session start; `decide-context.sh` adds a solve's level and recipe to its context; `guard.sh` blocks force-pushes, pushes and commits on the default branch, `.env` reads (Bash and Claude's Read/Grep tools), sub-agents spawning sub-agents, implementers running apps or writing tests, `bin/decide` decisions outside the orchestrator, and the harness Jev key outside `bin/decide`; `stage-log.sh` records stage timings and tokens |
| `cursor/` | `harness.mdc` — the Cursor User Rule content, linked in per repo by `--project` |
| `cache/recipes/` | private per-repo recipes (gitignored) |
| `logs/` | stage timings, `decisions.jsonl` and the decision cache (gitignored) |
| `MACHINE.md`, `.env` | personal rules and keys (gitignored) |

## How it stays cheap, accurate and quick
- **A level per task.** One session with its context already loaded is cheaper than briefing agents that each re-read rules, recipes and code. Small work stays in that session; agents join as the level grows, and parallel lanes are reserved for large work.
- **Short agents, one job each.** Cost grows with turns × context, so a long agent costs far more than two short ones. Prompts are a few lines; briefs pass file paths; every round starts a fresh agent instead of resuming a large context.
- **Strong model for code.** In this harness's own logs, sonnet implementers averaged about 3× the turns and tokens of opus ones, so the implementer's role file sets opus.
- **Checks before code.** `checks.md` is written from the request before implementation; the tester writes tests from it, not from the diff.
- **Design verification.** The verifier saves screenshots to files at the widths and themes each check names, without viewing them; the designer compares them with the reference (image, Figma/Pencil node or URL) and records concrete differences as findings.
- **Real parallelism.** Lanes and the verifier run in their own worktrees (`task-fork`, with `node_modules` cloned copy-on-write), so no build output or git index is shared; `task-join` merges lanes back.
- **Mechanical gates.** Every stage file uses one checkbox line per finding; `task-status` counts the open blockers and majors, and `task-ship` refuses while any are open unless the PR lists them under "Open items". Fix rounds are capped per level.
- **Files, not context.** Plans, checks, findings, screenshots and PR bodies live in `~/.agent-worktrees/<repo>/<slug>.handoff/`.

## License
[MIT](LICENSE)
