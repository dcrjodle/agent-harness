---
name: ship
description: Push the current task branch and open its PR with the harness ship script.
argument-hint: "[pr-body-file] [title]"
disable-model-invocation: true
---
Run `~/.agent-harness/bin/task-ship <worktree> $ARGUMENTS` from the task worktree. Commit anything pending first, by file path as in `~/.agent-harness/rules/git.md` (conventional commit + attribution trailer). Report the PR URL. Don't merge unless asked.
