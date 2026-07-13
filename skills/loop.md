# loop
Main agent = orchestrator only. One sub-agent per stage; pass summaries, never raw output.

Degrees (`/loop [min|med|max] <task>`, default med):
- **min**: implement → ship (no review, no tests)
- **med**: implement → review → fix → ship
- **max**: plan → implement → review → test → fix → ship

- Stage 0, always: git-ops creates the task worktree + branch (`~/.agent-harness/rules/git.md`). Every later stage runs inside it.
- Stages map to skills: plan, implement, review, test, git-ops (= ship).
- implement failed (no green build, nothing committed) → stop and report the failure; never continue to review or ship.
- fix = implement sub-agent given the findings. After each fix, re-run review (and test at max) — fixes never ship unverified.
- Findings loop max 2 rounds, then ship with open items noted in the PR.
- Check `~/.agent-harness/cache/INDEX.md` before the first stage; save a recipe after.
- After the PR merges (outside the loop): `/cleanup` removes the worktree + branch.
