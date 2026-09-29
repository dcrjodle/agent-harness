---
name: plan
description: Plan a complex, broad coding task with the harness planner on the large model — binding decisions, parallel lanes, acceptance checks.
argument-hint: "<task>"
---
Spawn the `planner` role (`~/.agent-harness/agents/planner.md`) for: $ARGUMENTS

It writes `<handoff>/plan.md` and `<handoff>/checks.md` when a task worktree exists (`~/.agent-worktrees/<repo>/<slug>.handoff/`), else in your scratchpad. Name matching recipes in the brief. Relay the lanes in a few lines, not the file.
