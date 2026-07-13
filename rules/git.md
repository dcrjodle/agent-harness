# Git
- Never work on the default branch. Every task gets its own worktree + branch:
  `git worktree add ~/.agent-worktrees/<repo>/<slug> -b <type>/<slug>` (type: feat | fix | chore).
  `<repo>` = `basename "$(git rev-parse --show-toplevel)"`; `<slug>` = kebab-case task summary; taken → append `-2`, `-3`, …
  All edits, builds, and tests happen inside the worktree.
- Default branch = `git symbolic-ref --short refs/remotes/origin/HEAD` (unset → `git remote set-head origin -a`; no remote → `main`). Never hardcode `main`.
- Conventional commits: `type: summary` (feat, fix, chore, refactor, docs, test). Commit your work — review diffs commits, not intentions.
- Never commit: `.env`, `MACHINE.md`, secrets, build output.
- PR: push the branch, `gh pr create --fill`. Put the issue ref (`#123`) in the commit body so the PR links it.
- Merged PR → remove its worktree: `git worktree remove <path>`, `git branch -D <branch>`, `git worktree prune`. `/cleanup` sweeps all merged ones.
- Never force-push. Never push to the default branch.
