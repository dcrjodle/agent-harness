---
name: test
description: Write and run the automated tests for the current task worktree with the harness tester (medium model); failures go to a file.
argument-hint: "[acceptance checks or plan path]"
---
Spawn the `tester` role (`~/.agent-harness/agents/tester.md`, medium tier) on the current task worktree. Checks: $ARGUMENTS (default: the `test` checks in `<handoff>/plan.md`). It writes `<handoff>/test.md`; relay pass/fail counts and failing checks.
