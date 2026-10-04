# Agent Harness

One global harness for Claude Code, Codex CLI and Cursor: a short contract, per-stack rules, model-tiered roles, one solve loop, scripted git plumbing, safety hooks and a private recipe cache.

It is built around three goals: fewer tokens, accuracy through verification (including a design check of screenshots), and parallel work on long jobs. Simplicity serves all three: most work runs inline in one session, and the full multi-agent loop is reserved for complex, broad work. Every sub-agent has one job and a short prompt, and stages hand work over through files.

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
- `/solve [inline|loop] <task>` solves a change end to end. **inline** (default): the session implements, tests and ships itself; a UI change gets one verifier for screenshots, which the session judges against the design. **loop** (only when at least two hold: 3+ issues or parallel areas; new state/data/concurrency design; ~15+ files): plan → parallel lanes in forks → test ∥ verify → design check ∥ review → fix → PR.
- `/plan` `/test` `/verify` `/review` `/ship` `/search` run one stage. `/verify` runs the verifier and, when checks name a design reference, the designer. `/recipe` saves what a session learned. `/cleanup` removes merged worktrees.
- `bin/stage-times [N|--roles]` shows active minutes and tokens (cache read, cache write, output) per agent or per role.
- Invocation differs by CLI: Claude Code uses `/solve ...` (slash command). Codex invokes the same file as a prompt, e.g. `$solve ...` (no `/`, and `$ARGUMENTS` is not expanded — the skill text stands on its own without it). Cursor runs it as a linked command from `.cursor/commands/` after `./setup.sh --project <path>`.

## Layout
| Path | What |
|---|---|
| `AGENTS.md` | the contract; the only file loaded every session |
| `rules/` | per-stack rules, read on demand |
| `agents/` | roles, one job each: planner, implementer, tester, verifier, designer, reviewer, searcher (Claude subagents; other CLIs run them inline) |
| `skills/` | entry points: solve, plan, test, verify, review, ship, search, recipe, cleanup |
| `bin/` | `task-start`, `task-fork`/`task-join` (lanes and snapshots), `task-status` (open findings), `task-ship`, `task-cleanup`, `stage-times` |
| `hooks/` | `session-context.sh` lists this repo's recipes at session start; `guard.sh` blocks force-pushes, pushes and commits on the default branch, `.env` reads (Bash and Claude's Read/Grep tools), and sub-agents spawning sub-agents, and implementers running apps or writing tests; `stage-log.sh` records stage timings and tokens |
| `cursor/` | `harness.mdc` — the Cursor User Rule content, linked in per repo by `--project` |
| `cache/recipes/` | private per-repo recipes (gitignored) |
| `MACHINE.md`, `.env` | personal rules and keys (gitignored) |

## How it stays cheap, accurate and quick
- **Inline by default.** One session with its context already loaded is cheaper than briefing agents that each re-read rules, recipes and code. The loop is reserved for complex, broad work.
- **Short agents, one job each.** Cost grows with turns × context, so a long agent costs far more than two short ones. Prompts are a few lines; briefs pass file paths; every round starts a fresh agent instead of resuming a large context.
- **Large model for code.** In this harness's own logs, sonnet implementers averaged about 3× the turns and tokens of opus ones, so implementers stay on the large tier.
- **Checks before code.** `checks.md` is written from the request before implementation; the tester writes tests from it, not from the diff.
- **Design verification.** The verifier saves screenshots to files at the widths and themes each check names, without viewing them; the designer (large model) compares them with the reference (image, Figma/Pencil node or URL) and records concrete differences as findings.
- **Real parallelism.** Lanes and the loop's verifier run in their own worktrees (`task-fork`, with `node_modules` cloned copy-on-write), so no build output or git index is shared; `task-join` merges lanes back.
- **Mechanical gates.** Every stage file uses one checkbox line per finding; `task-status` counts the open blockers and majors, and `task-ship` refuses while any are open unless the PR lists them under "Open items". At most 2 fix rounds.
- **Files, not context.** Plans, checks, findings, screenshots and PR bodies live in `~/.agent-worktrees/<repo>/<slug>.handoff/`.

## Jobs
`mods/jobs/` is a Claude Code mod: a pane that lists every running session on the machine as jobs and starts more. The desktop app opens it beside the conversation; `/jobs` opens it anywhere. Setup lists every folder under `mods/` in `env.CLAUDE_CODE_PLUGIN_DIRS` of `~/.claude/settings.json`; `claude plugin validate mods/jobs` checks the mod.

- **List.** One centered column, read from `claude agents --json`: plans awaiting approval first, then sessions waiting for you, working and idle.
- **Start.** A prompt on top, the three most used repos as chips above it (the most used one selected) and a searchable menu for the rest. Enter starts the job in plan mode; Enter with cmd or option held, which reaches the field as a line break, starts it without, as does the button beside it. The desktop app starts a session only on the person's click, so there a job is queued as a chip in the chat; in a terminal it runs as a `claude --bg` session.
- **Highlight, menu, merge.** A click on a row's marker, or a shift- or ctrl-click, highlights several jobs; a right click opens the menu of that job or of the highlighted group. Merge hands the other jobs' plans and last messages to one session, then stops and archives the rest (the app asks before it archives).
- **Open.** A click shows the job's own chat in split view, or in the app's main view when the app refuses the split.
- **Plans.** A click on a plan opens it in the pane's sidebar with a reply field at the bottom: Enter closes the sidebar, interrupts the pending approval and sends the changes, and the rewrite runs as that job's next turn.

## License
[MIT](LICENSE)
