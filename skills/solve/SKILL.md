---
name: solve
description: Solve a coding task end to end at the level the harness decides (small, medium or large by default) — plan, implement yourself or in parallel lanes, test, verify, design check, review and fix rounds as that level's settings say. Use for any change request in a git repo.
argument-hint: "[level] <task or issue numbers>"
---
Task: the user's request ($ARGUMENTS)

## 1. Level and recipe
- Your context holds a "Harness decision for this solve" block for this task (a hook adds it) → use it.
- No block → run once from the repo: `~/.agent-harness/bin/decide start --repo <repo> -- "<task>"`. It prints the block and exits 0 for every decision, fallbacks included; any other exit means broken settings or usage: stop and report it.
- Never run it again or ask Jev yourself, and keep the decision even where you would pick otherwise. A first word naming a level is the override (`inline` = the first level, `loop` = the last).

The block names the level, its stages from `~/.agent-harness/settings.json` and the recipe; below, `plan on`, `implement self` and the like are those stages. Lost the block (e.g. after compaction) → `~/.agent-harness/bin/decide stages <level>` reprints the stages without Jev.

## 2. Start
- File issues first if the user asked for them.
- `~/.agent-harness/bin/task-start <feat|fix|chore|refactor|docs|test> <slug>` prints `worktree=`, `branch=` and `handoff=`. Work only in the worktree; stage files go in the handoff dir, and `<handoff>/base` holds the base commit.
- Follow the decided recipe, and any the user names, verbatim; name them in every brief.

## 3. Checks
- `plan on` → the planner writes `<handoff>/plan.md` (binding decisions and lanes) and `<handoff>/checks.md`.
- `plan off` → write `<handoff>/checks.md` yourself: 3–8 observable checks from the request, each tagged `test` or `verify`.

A visual check names the screen, state, viewport widths, themes and the design reference (image path, Figma/Pencil node or URL).

## 4. Implement
- `implement self` → write the code in the task worktree, following plan.md when there is one. Run static checks and the tests for what you touched; with `test off`, add tests where behaviour changed. Commit per issue by file path.
- `implement agents` → orchestrate only and never read source. Lane 0 runs in the task worktree. When it has committed, fork every other lane: `task-fork <worktree> lane-N`, one implementer per fork, in parallel. When all return: `task-join <worktree> lane-N` for each. A conflict stops the solve: report it.

## 5. Check
1. **UI decision** — `verify ui` or `design ui` → run once per task, now: `~/.agent-harness/bin/decide ui <worktree>` prints `ui: yes` or `ui: no`. A non-zero exit (no `<handoff>/base`, not a worktree) counts as `ui: yes`: note it in pr.md. Later rounds reuse it.
2. **In parallel**, then wait for all; don't edit the worktree meanwhile:
   - `test on` → tester in the task worktree → `test-N.md`;
   - `verify always`, or `verify ui` with `ui: yes`, and only with at least one `verify` check in checks.md → verifier in a snapshot (`task-fork <worktree> verify --detach`) → `verify-N.md` and `shots/`; then, with `design ui`, `ui: yes` and a check that names a design reference, the designer → `design-N.md`; `task-join <worktree> verify` when both are done;
   - `review on` → reviewer → `review-N.md`.
3. **Screenshots** no designer judged: compare `<handoff>/shots/` with the design reference, or the app's existing screens, yourself; differences go to `design-N.md` as findings.
4. **Status** — `task-status <handoff>` counts open blockers and majors. Zero → ship.
5. **Fix** — at most the level's `fix rounds`. `implement self` → fix them yourself; `implement agents` → one fresh implementer with the files that have open items. Then rerun only those stages as round N+1. No rounds left → ship with the rest under "Open items".

## 6. Ship
- Write `<handoff>/pr.md` (`implement agents`: ask the last implementer): what changed, verification, open items, PR trailer.
- `~/.agent-harness/bin/task-ship <worktree> <handoff>/pr.md "<title>"` prints the PR URL. It refuses while blockers or majors are open unless pr.md has an "Open items" heading. Don't merge unless asked.
- The task needed more than 2 discovery steps → `/recipe`. After the PR merges → `~/.agent-harness/bin/task-cleanup`.

## Findings
Every stage file lists findings as `- [ ] <blocker|major|minor|nit> — <where> — <observed> — <expected or fix>`. The fixer marks `- [x] … → <sha>` or `- [-] … → skipped: <reason>`. Severity: blocker = crash, data loss, broken core flow · major = requirement not met, real bug, visible deviation from the design · minor = edge case, a11y, small visual drift · nit = style.

## Guardrails
- One background agent per stage, fresh for every round. A brief is: task or issue refs, worktree, handoff, round N, recipes, commit trailer; paths, never pasted content.
- Sub-agents never spawn sub-agents.
- Jev only through `bin/decide`, only at steps 1 and 5.1.
- The session log is written by hooks and `bin/decide` through `~/.agent-harness/bin/session-log` (Claude Code only); never write it by hand or from a sub-agent.
- A stage that returns without its file or commits failed: rerun it fresh with the reason.
- Static checks red after implement → stop and report.
