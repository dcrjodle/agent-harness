# Agent Harness

One global harness for Claude Code: a short contract, per-stack rules, model-tiered roles, one solve loop, scripted git plumbing, safety hooks, a private recipe cache and an observability mod.

It is built around three goals: fewer tokens, accuracy through verification (including a design check of screenshots), and parallel work on long jobs. Simplicity serves all three: most work runs inline in one session, and the full multi-agent loop is reserved for complex, broad work. Every sub-agent has one job and a short prompt, and stages hand work over through files.

## Install
Requires `git`, `gh` and `jq`.

```sh
./setup.sh
```

The clone is symlinked to `~/.agent-harness` and Claude Code's user config points into it, so every session on the machine follows the harness in any repo. Re-run after `git pull`, then restart Claude Code. Links and files the installer did not create are left alone. `~/.claude/settings.json` is merged, never replaced, and the first run backs it up to `settings.json.pre-harness`.

Setup wires:
- the contract: `@~/.agent-harness/AGENTS.md` in `~/.claude/CLAUDE.md`
- roles → `~/.claude/agents/`, skills → `~/.claude/skills/`
- hooks and the Observability mod (`env.CLAUDE_CODE_PLUGIN_DIRS`) → `~/.claude/settings.json`

## Use
- `/solve [inline|loop] <task>` solves a change end to end. **inline** (default): the session implements, tests and ships itself; a UI change gets one verifier for screenshots, which the session judges against the design. **loop** (only when at least two hold: 3+ issues or parallel areas; new state/data/concurrency design; ~15+ files): plan → parallel lanes in forks → test ∥ verify → design check ∥ review → fix → PR.
- `/plan` `/test` `/verify` `/review` `/ship` `/search` run one stage. `/verify` runs the verifier and, when checks name a design reference, the designer. `/recipe` saves what a session learned. `/cleanup` removes merged worktrees.
- `bin/stage-times [N|--roles]` shows active minutes and tokens (cache read, cache write, output) per agent or per role.

## Observability
Every session and every sub-agent reports to one endpoint, `mods/observability/bin/observe`, which appends one JSON event per line to `logs/observability/<session-id>.jsonl`.

- **Forced analytics.** `hooks/observe.sh` runs on session start and end, each prompt and turn end, each sub-agent spawn, start and stop, and each failed tool call, and reads token usage per model from the transcripts. The model cannot skip it.
- **Exact totals.** The mod also pushes what the engine itself counted for each finished turn of each agent, and the session's running cost. Sub-agent transcripts under-report output tokens, so without the mod a child's cost is a lower bound.
- **The pane.** The mod adds an **Observability** pane: beside the conversation in the desktop app, `/observability` anywhere. It lists sessions; a session shows its agents as a graph of who spawned whom; a node shows cost, time, status, model, tokens and tool errors. **Download JSON** saves the session to `~/Downloads`.
- **Free messages.** `observe <suggestion|error|note> "<text>"` records a message on the current session. A sub-agent is handed its own command at start, so its messages land on its node.
- **Structured data.** `observe export <session-id>` prints what Download saves: the session, its nodes and edges, messages, errors and raw events. `observe list` summarises sessions.
- **Cost.** An agent's cost is its tokens times `mods/observability/prices.json` (list prices). The session total is the engine's own figure once the mod has reported it.

The pane is built on Claude Code's function-hook plugin API, which is early access and may change between releases. The hooks, the endpoint and the store do not depend on it.

## Layout
| Path | What |
|---|---|
| `AGENTS.md` | the contract; the only file loaded every session |
| `rules/` | per-stack rules, read on demand |
| `agents/` | roles, one job each: planner, implementer, tester, verifier, designer, reviewer, searcher |
| `skills/` | entry points: solve, plan, test, verify, review, ship, search, recipe, cleanup |
| `bin/` | `task-start`, `task-fork`/`task-join` (lanes and snapshots), `task-status` (open findings), `task-ship`, `task-cleanup`, `stage-times` |
| `hooks/` | `session-context.sh` lists this repo's recipes at session start; `guard.sh` blocks force-pushes, pushes and commits on the default branch, `.env` reads (Bash, Read and Grep), and sub-agents spawning sub-agents, and implementers running apps or writing tests; `stage-log.sh` records stage timings and tokens; `observe.sh` pushes analytics for every session and sub-agent to the observability endpoint |
| `mods/observability/` | the Observability mod: `bin/observe` (endpoint, list, export), `lib/observe.jq` (the session view), `prices.json`, `hooks/` (the pane) |
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

## License
[MIT](LICENSE)
