---
name: solve
description: Solve a coding task end to end with the harness loop — task worktree, plan, parallel implementation, tests, app verification with screenshots, review, PR. Use for any change request in a git repo.
argument-hint: "[min|med|max] <task or issue numbers>"
---
Task: the user's request ($ARGUMENTS)

You are the orchestrator, usually on the most expensive model. You never read or edit source files. You run scripts, brief roles, and pass file paths. Details live in handoff files, not in your context.

## 1. Pick the degree
First word `min|med|max` wins. Otherwise choose:
- **min** — one small, obvious change (≤2 files, no design). implement → test → ship.
- **med** — one feature or fix. implement → test + verify → review → fix → ship.
- **max** — more than 2 issues, new state/selection/concurrency/persistence logic, or an unclear design. plan → implement (lanes) → test + verify → review → fix → ship.

Skip verify when nothing user-visible changed (no UI, no rendered output, no runtime behaviour a person would look at).

## 2. Start
- File issues first if the user asked for them (one `gh issue create` each).
- `~/.agent-harness/bin/task-start <feat|fix|chore|refactor|docs|test> <slug>` prints `worktree=`, `branch=` and `handoff=`. All stages work in the worktree; all stage files go in the handoff dir (outside the repo).
- Recipes for this repo were listed at session start. Name the matching recipe paths in every brief.

## 3. Stages
One sub-agent per stage, background, with the role file from `~/.agent-harness/agents/`. A brief is short: task or issue numbers, worktree, handoff paths, recipes, commit trailer. Never paste code, plans or findings into a brief; pass the path.

| Stage | Role (tier) | Writes |
|---|---|---|
| plan (max) | planner (large) | `handoff/plan.md` |
| implement | implementer (large), one per lane, lanes in parallel | commits (product code only) |
| test | tester (medium) | test commits + `handoff/test.md` |
| verify (med, max) | verifier (medium), in parallel with test | `handoff/verify.md` + `handoff/shots/` |
| review | reviewer (large) | `handoff/review-1.md` |
| fix | implementer (large) | `→ fixed/skipped` under each item |
| retest / re-verify | tester / verifier, failed checks only | `handoff/test-N.md`, `handoff/verify-N.md` |
| re-review | reviewer (medium), round 2 scope | `handoff/review-N.md` |

- **Separation of duties.** Implementers write product code and run only static checks (compile, typecheck, lint); a hook blocks them from running tests, apps, browsers or simulators. The tester owns every automated test. The verifier owns running the app and screenshots, so single-instance tools (a simulator, Blender, a game engine) have exactly one user.

- Pass medium/sonnet to an implementer only for mechanical lanes: docs, config, copy, renames, generated assets. Real code stays on large; a cheaper model that redoes work costs more.
- Role files pin a default tier (e.g. reviewer pins large/opus). For re-review, override it down to medium/sonnet explicitly when launching that stage — the role file's pin is only the default, not a floor.
- Lanes run in parallel only when the plan says their files are disjoint; lane 0 finishes first.
- Test failures, verify failures and review findings all go to one fix stage. After a fix, rerun only what failed (retest and/or re-verify) and re-review.
- At most 2 fix rounds. Then ship; whatever is still open goes into the PR body under "Open items" and into your final message.

## 4. Ship
- The last implementer run writes `handoff/pr.md` (ask for it in the brief).
- `~/.agent-harness/bin/task-ship <worktree> <handoff>/pr.md "<title>"` prints the PR URL. Don't merge unless the user asks.

## 5. Finish
- The task needed more than 2 discovery steps → `/recipe`.
- After the PR merges: `~/.agent-harness/bin/task-cleanup` (run from the repo).

## Guardrails
- Sub-agents never spawn sub-agents; one writer per file set.
- Read a report for its verdict and counts; don't re-read the handoff file unless you must decide something.
- A stage that returns without commits or files failed. Resume that same agent with the reason; don't launch a duplicate.
- Implement failed (static checks red, no commits) → stop and report.
- Stage timings: `~/.agent-harness/bin/stage-times`.
