---
name: plan
description: Plan a coding task with the harness planner on the large model — binding design decisions, parallel lanes, acceptance checks. Use before implementing anything non-trivial.
argument-hint: "<task>"
---
Spawn the `planner` role (`~/.agent-harness/agents/planner.md`, large tier) for: $ARGUMENTS

Plan path: `<handoff>/plan.md` when a task worktree exists (`~/.agent-worktrees/<repo>/<slug>.handoff/`), else a file in your scratchpad. Name matching recipes in the brief. Relay the decisions and lanes in a few lines, not the whole file.
