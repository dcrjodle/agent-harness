---
name: solve
description: Solve a coding task end to end — inline by default, the full parallel loop (plan, lanes, test, verify, design check, review) only for complex and broad work. Use for any change request in a git repo.
argument-hint: "[inline|loop] <task or issue numbers>"
---
Task: the user's request ($ARGUMENTS)

## 1. Pick the mode
The first word `inline|loop` wins. Otherwise use **inline**. Use **loop** only when at least two of these hold:
- 3+ issues, or changes across several packages or areas that can run as parallel lanes;
- a new design for state, data model, concurrency or persistence;
- roughly 15+ files or 500+ changed lines.

One area or a long task alone is not enough. When unsure, inline.

## 2. Start
- File issues first if the user asked for them.
- `~/.agent-harness/bin/task-start <feat|fix|chore|refactor|docs|test> <slug>` prints `worktree=`, `branch=` and `handoff=`. Work only in the worktree; stage files go in the handoff dir, and `<handoff>/base` holds the base commit.
- Follow a matching recipe verbatim; name it in every brief.

## 3. Inline
1. Write `<handoff>/checks.md`: 3–8 observable checks from the request, each tagged `test` or `verify`. A visual check names the screen, state, viewport widths, themes and the design reference (image path, Figma/Pencil node or URL).
2. Implement. Run static checks and the tests for what you touched; add tests where behaviour changed. Commit per issue by file path.
3. UI changed → spawn one verifier (brief: worktree, handoff, round 1). Don't edit while it runs. Then look at `<handoff>/shots/` yourself against the design reference, fix what differs, and rerun the verifier for failed checks only.
4. Ship.

## 4. Loop
You orchestrate only: never read source; brief with paths, never pasted content. One background agent per stage, fresh for every round. A brief is: task or issue refs, worktree, handoff, round N, recipes, commit trailer.

1. **Plan** — planner writes `<handoff>/plan.md` and `<handoff>/checks.md`.
2. **Implement** — lane 0 runs in the task worktree. When it has committed, fork every other lane: `task-fork <worktree> lane-N`, one implementer per fork, in parallel. When all return: `task-join <worktree> lane-N` for each. A conflict stops the loop: report it.
3. **Check, in parallel**
   - tester in the task worktree → `test-N.md`;
   - verifier in a snapshot (`task-fork <worktree> verify --detach`) → `verify-N.md` and `shots/`; when checks have a design reference, then designer → `design-N.md`; `task-join <worktree> verify` when both are done;
   - reviewer (round 1 large, later rounds medium) → `review-N.md`.
4. **Status** — `task-status <handoff>` counts open blockers and majors. Zero → ship.
5. **Fix** — one fresh implementer with the files that have open items. Then rerun only those stages as round N+1. At most 2 fix rounds; after that, ship with the rest under "Open items".

## 5. Ship
- Write `<handoff>/pr.md` (loop: ask the last implementer): what changed, verification, open items, PR trailer.
- `~/.agent-harness/bin/task-ship <worktree> <handoff>/pr.md "<title>"` prints the PR URL. It refuses while blockers or majors are open unless pr.md has an "Open items" heading. Don't merge unless asked.
- The task needed more than 2 discovery steps → `/recipe`. After the PR merges → `~/.agent-harness/bin/task-cleanup`.

## Findings
Every stage file lists findings as `- [ ] <blocker|major|minor|nit> — <where> — <observed> — <expected or fix>`. The fixer marks `- [x] … → <sha>` or `- [-] … → skipped: <reason>`. Severity: blocker = crash, data loss, broken core flow · major = requirement not met, real bug, visible deviation from the design · minor = edge case, a11y, small visual drift · nit = style.

## Guardrails
- Sub-agents never spawn sub-agents.
- A stage that returns without its file or commits failed: rerun it fresh with the reason.
- Static checks red after implement → stop and report.
