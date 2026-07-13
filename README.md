# Agent Harness

One global harness for Claude Code, Cursor CLI and Codex CLI: shared rules, model-tiered sub-agents, a solve loop, worktree isolation, and a recipe cache.

## Install
Clone anywhere, then:

```sh
./setup.sh
```

The clone is symlinked to `~/.agent-harness` and each CLI's user-level config points into it — every agent on the machine follows the harness, in any repo, with nothing copied per project. Re-run after `git pull` to pick up new commands. Files and symlinks the installer didn't create are left alone (skipped with a warning).

## How it hooks in
| CLI | Global entry |
|---|---|
| Claude Code | `@~/.agent-harness/AGENTS.md` import appended to `~/.claude/CLAUDE.md`; agents + commands symlinked into `~/.claude/agents/` and `~/.claude/commands/` |
| Codex | pointer line appended to `~/.codex/AGENTS.md`; prompts symlinked into `~/.codex/prompts/` |
| Cursor | no file-based global config — add a one-line User Rule in Cursor settings (`Read ~/.agent-harness/AGENTS.md and follow it exactly.`); per repo, `./setup.sh --project <path>` links `.cursor/rules` + `.cursor/commands` |

Why a symlink instead of copying into `~`: the clone stays a normal git repo — `git pull` to update, PR to change — while `~/.agent-harness` is the one stable path every doc and CLI config references, wherever the clone lives.

## Use
- `/loop [min|med|max] <task>` — min: straight to PR · med: + review · max: + plan + tests. Every task runs in its own worktree under `~/.agent-worktrees/<repo>/`, never on the default branch.
- Standalone: `/plan` `/review` `/test` `/ship` `/search` · `/cleanup` after PRs merge (removes worktrees + branches).

## Layout
- `AGENTS.md` — the contract, the only file agents always load
- `rules/` — per-stack best practices, read on demand
- `skills/` — sub-agent specs, one model tier per task
- `cache/` — saved recipes for repeated tasks, namespaced per repo
- `MACHINE.md` — personal rules (gitignored)
- `.env` — API keys (gitignored)

## License
[MIT](LICENSE)
