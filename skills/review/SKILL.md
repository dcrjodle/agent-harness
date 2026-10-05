---
name: review
description: Review the current task worktree's code diff with the harness reviewer; findings go to a file.
argument-hint: "[previous review file]"
---
Spawn the `reviewer` role (`~/.agent-harness/agents/reviewer.md`) on the current task worktree. $ARGUMENTS

- No previous file → round 1, writes `<handoff>/review-1.md`.
- Previous file given → the next round, which only confirms its items, writes the next `review-N.md`.

Every round runs on the model in the role file. Relay severity counts; the findings stay in the file.
