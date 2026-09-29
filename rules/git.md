# Git
- Never work on the default branch. Start every task with `~/.agent-harness/bin/task-start <feat|fix|chore|refactor|docs|test> <slug>`: worktree `~/.agent-worktrees/<repo>/<slug>`, branch `<type>/<slug>`, handoff dir `<slug>.handoff/` beside it with the base commit in `base`. Parallel lanes and the loop's verifier work in forks (`task-fork`, `task-join`).
- Conventional commits (`type: summary`), one per issue or finding group, issue ref in the body (`Closes #123`).
- Commit by file path: `git -C <worktree> add -- <files> && git -C <worktree> commit -m "…" -- <files>`. `git mv`/`git rm` paths are already staged: list them only in the commit.
- Never `git add -A`, `git add .`, `git commit -a`, `git stash`, `git reset --hard`, `git checkout .`, `git restore .` or `git clean`.
- Never commit `.env`, `MACHINE.md`, secrets, build output or handoff files.
- Ship with `~/.agent-harness/bin/task-ship`; never force-push or push the default branch (a hook enforces both). After merge: `~/.agent-harness/bin/task-cleanup`.
