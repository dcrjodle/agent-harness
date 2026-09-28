---
name: test
description: Run gates and acceptance checks for the current task worktree with the harness tester (medium model) and record evidence.
argument-hint: "[acceptance checks or plan path]"
---
Spawn the `tester` role (`~/.agent-harness/agents/tester.md`, medium tier) on the current task worktree. Checks: $ARGUMENTS (default: the acceptance checks in `<handoff>/plan.md`). It writes `<handoff>/test.md`; relay pass/fail counts and failing checks.
