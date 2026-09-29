---
name: test
description: Write and run the automated tests for the current task worktree with the harness tester (medium model); failures go to a file.
argument-hint: "[checks or checks file]"
---
Spawn the `tester` role (`~/.agent-harness/agents/tester.md`) on the current task worktree. Checks: $ARGUMENTS (default: the `test` checks in `<handoff>/checks.md`). It writes `<handoff>/test-N.md`; relay pass/fail counts and failures.
