---
name: verify
description: Run the real app for the current task worktree and check it against the design — the verifier (medium model) captures screenshots, the designer (large model) compares them with the reference.
argument-hint: "[checks, design reference, or checks file]"
---
1. Spawn the `verifier` role (`~/.agent-harness/agents/verifier.md`) on the current task worktree. Checks: $ARGUMENTS (default: the `verify` checks in `<handoff>/checks.md`). It writes `<handoff>/verify-N.md` and `<handoff>/shots/`.
2. When a check names a design reference, spawn the `designer` role (`~/.agent-harness/agents/designer.md`) on those screenshots. It writes `<handoff>/design-N.md`.

Relay pass/fail and design counts, failures and the screenshot folder.
