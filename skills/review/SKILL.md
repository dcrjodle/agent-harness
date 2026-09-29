---
name: review
description: Review the current task worktree's code diff with the harness reviewer; findings go to a file.
argument-hint: "[previous review file]"
---
Spawn the `reviewer` role (`~/.agent-harness/agents/reviewer.md`) on the current task worktree. $ARGUMENTS

- No previous file → round 1 on the role's large model, writes `<handoff>/review-1.md`.
- Previous file given → next round on medium: override the model to sonnet when launching, writes the next `review-N.md`.

Relay severity counts; the findings stay in the file.
