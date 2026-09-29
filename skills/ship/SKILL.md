---
name: ship
description: Push the current task branch and open its PR with the harness ship script.
argument-hint: "[pr-body-file] [title]"
disable-model-invocation: true
---
Run `~/.agent-harness/bin/task-ship <worktree> $ARGUMENTS`. Commit anything pending first, by file path as in `~/.agent-harness/rules/git.md`. If it refuses over open findings, fix them or list them under an "Open items" heading in the PR body. Report the PR URL. Don't merge unless asked.
