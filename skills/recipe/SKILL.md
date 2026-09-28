---
name: recipe
description: Save or update a private harness cache recipe for the current repo so the next session skips discovery. Use after a task that needed more than two discovery steps, or when a recipe proved wrong.
argument-hint: "[name] [what it covers]"
---
Recipes live in `~/.agent-harness/cache/recipes/<repo>/<name>.md` (gitignored, private). `<repo>` is the main checkout's folder name.

Format:
- Line 1: `# <repo>/<name> — <when to use>`. The session-start hook lists this line.
- Then exact commands, paths and gotchas only. At most 60 lines. No narrative, no work log.

Update the recipe that covers the same area instead of adding one. Delete lines that proved wrong. Write it yourself when you hold the facts; otherwise brief a small-tier sub-agent with the facts. $ARGUMENTS
