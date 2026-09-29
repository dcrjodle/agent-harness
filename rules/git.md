# Git
- Never work on the default branch. Start every task with `~/.agent-harness/bin/task-start <feat|fix|chore|refactor|docs|test> <slug>`: worktree `~/.agent-worktrees/<repo>/<slug>`, branch `<type>/<slug>`, handoff dir `<slug>.handoff/` beside it. Edits, builds and tests happen in the worktree.
- Conventional commits (`type: summary`), one per issue or finding group. Put the issue ref in the body (`Closes #123`). Commit your work; review reads commits, not intentions.
- Commit only your own files, by path: `git -C <worktree> add -- <paths> && git -C <worktree> commit -m "…" -- <paths>` (`git mv`/`git rm` paths are already staged: list them only in the commit). Agents in one worktree share its git index; the pathspec keeps what others staged out of your commit. Never `git add -A`, `git add .` or `git commit -a`.
- Never commit `.env`, `MACHINE.md`, secrets, build output or handoff files.
- Ship with `~/.agent-harness/bin/task-ship <worktree> [body-file] [title]`. Never force-push, never push the default branch (a hook enforces both).
- After merge: `~/.agent-harness/bin/task-cleanup` removes merged worktrees, branches and handoff dirs.
