---
name: loop
description: Solve a coding task end to end with the harness loop — task worktree, plan, parallel implementation, tests, review, PR. Use for any change request in a git repo.
argument-hint: "[min|med|max] <task or issue numbers>"
---
Task: $ARGUMENTS

You are the orchestrator, usually on the most expensive model. You never read or edit source files. You run scripts, brief roles, and pass file paths. Details live in handoff files, not in your context.

## 1. Pick the degree
First word `min|med|max` wins. Otherwise choose:
- **min** — one small, obvious change (≤2 files, no design). implement → ship.
- **med** — one feature or fix. implement → test → review → fix → ship.
- **max** — more than 2 issues, new state/selection/concurrency/persistence logic, or an unclear design. plan → implement (lanes) → test → review → fix → ship.

## 2. Start
- File issues first if the user asked for them (one `gh issue create` each).
- `~/.agent-harness/bin/task-start <feat|fix|chore> <slug>` prints `worktree=`, `branch=` and `handoff=`. All stages work in the worktree; all stage files go in the handoff dir (outside the repo).
- Recipes for this repo were listed at session start. Name the matching recipe paths in every brief.

## 3. Stages
One sub-agent per stage, background, with the role file from `~/.agent-harness/agents/`. A brief is short: task or issue numbers, worktree, handoff paths, recipes, commit trailer. Never paste code, plans or findings into a brief; pass the path.

| Stage | Role (tier) | Writes |
|---|---|---|
| plan (max) | planner (large) | `handoff/plan.md` |
| implement | implementer (medium), one per lane, lanes in parallel | commits |
| test (med, max) | tester (medium) | `handoff/test.md` |
| review | reviewer (large) | `handoff/review-1.md` |
| fix | implementer (medium) | `→ fixed/skipped` under each finding |
| re-review | reviewer (medium), round 2 scope | `handoff/review-N.md` |

- Lanes run in parallel only when the plan says their files are disjoint; lane 0 finishes first.
- Failed tester checks and review findings both go to the fix stage. After a fix, re-run test (if it failed) and re-review.
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
- Implement failed (no green gates, no commits) → stop and report.
- Stage timings: `~/.agent-harness/bin/stage-times`.
