---
name: review
description: Review the current task worktree diff with the harness reviewer on the large model; findings go to a file.
argument-hint: "[round-2 findings file]"
---
Spawn the `reviewer` role (`~/.agent-harness/agents/reviewer.md`) on the current task worktree. $ARGUMENTS

- No findings file given → round 1, large tier, writes `<handoff>/review-1.md`.
- Findings file given → round 2 scope, medium tier, writes the next `review-N.md`.
Relay severity counts and the verdict; the findings stay in the file.
