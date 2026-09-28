---
name: verify
description: Run the real app for the current task worktree with the harness verifier (medium model) — execute the verify checks and capture screenshots as evidence.
argument-hint: "[checks, reference images, or plan path]"
---
Spawn the `verifier` role (`~/.agent-harness/agents/verifier.md`, medium tier) on the current task worktree. Checks: $ARGUMENTS (default: the `verify` checks in `<handoff>/plan.md`). It writes `<handoff>/verify.md` and screenshots to `<handoff>/shots/`; relay pass/fail counts, failing checks and the screenshot folder.
