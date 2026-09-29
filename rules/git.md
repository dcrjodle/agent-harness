# Git
- Never work on the default branch. Start every task with `~/.agent-harness/bin/task-start <feat|fix|chore|refactor|docs|test> <slug>`: worktree `~/.agent-worktrees/<repo>/<slug>`, branch `<type>/<slug>`, handoff dir `<slug>.handoff/` beside it. Edits, builds and tests happen in the worktree.
- Conventional commits (`type: summary`), one per issue or finding group. Put the issue ref in the body (`Closes #123`). Commit your work; review reads commits, not intentions.
- Commit only your own files, by file path: `git -C <worktree> add -- <files> && git -C <worktree> commit -m "…" -- <files>`. Agents in one worktree share its git index; file paths keep what others staged out of your commit, while a directory or glob takes it in. `git mv`/`git rm` paths are already staged: list them only in the commit (a pathspec commit undoes `git rm --cached`).
- Never `git add -A`, `git add .`, `git commit -a`, `git stash`, `git reset --hard`, `git checkout .`, `git restore .` or `git clean`: in a shared worktree they sweep up or wipe other agents' work.
- Never commit `.env`, `MACHINE.md`, secrets, build output or handoff files.
- Ship with `~/.agent-harness/bin/task-ship <worktree> [body-file] [title]`. Never force-push, never push the default branch (a hook enforces both).
- After merge: `~/.agent-harness/bin/task-cleanup` removes merged worktrees, branches and handoff dirs.
