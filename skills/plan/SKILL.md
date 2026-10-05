---
name: plan
description: Plan a coding task with the harness planner — binding decisions, parallel lanes, acceptance checks. Solve spawns the planner when the level has plan on.
argument-hint: "<task>"
---
Spawn the `planner` role (`~/.agent-harness/agents/planner.md`) for: $ARGUMENTS

It writes `<handoff>/plan.md` and `<handoff>/checks.md` when a task worktree exists (`~/.agent-worktrees/<repo>/<slug>.handoff/`), else in your scratchpad. Name matching recipes in the brief. Relay the lanes in a few lines, not the file.
