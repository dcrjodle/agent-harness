# Code quality

A Claude Code mod: a pane that scores your recent repositories every day and turns what it finds into issues or sessions.

- **Tiles.** One per recent GitHub repository, as 2×2 squares: Maintainable, Reliable, Secure, Tested. Each square holds a 0–100 score and a bar.
- **Suggestions.** Press a repository to open its panel. Each suggestion can become a GitHub issue, a new Claude Code session, or both (the session then closes the issue).
- **Daily scans.** One cloud routine per repository. `Schedule daily scan` creates it after you confirm; `Scan now` runs it at once.

Recent means the repositories of your latest Claude Code sessions, read from `~/.claude/projects`.

## Install

Name the folder in the `env` block of `~/.claude/settings.json` (several folders are separated by `:`):

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.agent-harness/mods/code-quality" } }
```

New sessions load it. `/quality` opens the pane; the desktop app opens it beside the conversation by itself.

It needs `git`, a signed-in `gh` for issues, and a claude.ai login for the routines.

## How a scan reaches the pane

Each routine is named `code-quality: <owner>/<repo>`, has that repository as its only source and reads it with `Bash`, `Read`, `Glob` and `Grep`. It writes nothing to the repository. It prints its result into its own run log, one record per line:

```
{"cq":1,"k":"scores","m":78,"r":64,"s":80,"t":41}
{"cq":1,"k":"fix","d":"t","v":"high","t":"Add tests for the ship gate","w":"Nothing covers the refusal path, so a regression ships silently.","p":["bin/task-ship"]}
```

The pane reads the log of each routine's last run and keeps the newest scan. The log shows at most 400 characters of one command's output, which is why the routine prints one record per command and why a suggestion is a 60-character title and a 140-character reason. An issue is that reason plus the paths.

Routines cannot be deleted from here: manage them at claude.ai/code/routines.

## Options

Under `code-quality` in `/config`:

| Option | Default | |
|---|---|---|
| Open in the desktop app | on | Open the pane when the desktop app connects to a session |
| Repositories | 6 | How many recent repositories to show |
| Scan hour (UTC) | 4 | Hour at which new routines run; the minute is spread per repository |
| Scan model | `claude-sonnet-5-5` | Model the routine scans with |
| Cloud environment | empty | Environment id for new routines; empty reuses the one your other routines run in |

## Develop

```bash
claude plugin validate mods/code-quality
claude plugin test mods/code-quality
tsc --noEmit -p mods/code-quality
```

`hooks/register.tsx` holds every call on the engine; the other modules are pure. The engine writes its declarations to `.claude-plugin/types/` the first time it loads the mod.
