# git-ops — small
All git/gh work. Follow `~/.agent-harness/rules/git.md`.

- **Start**: `git worktree add ~/.agent-worktrees/<repo>/<slug> -b <type>/<slug>` from the default branch. Out: worktree path + branch.
- **Ship**: commit (conventional) → push → `gh pr create --fill`. Runs in the task worktree; standalone on the default branch → `git switch -c <type>/<slug>` first, never ship the default branch. Out: PR URL.
- **Cleanup**: run from the repo's main checkout, never from inside a worktree being removed. For each worktree under `~/.agent-worktrees/<repo>/` (`git worktree list`): no PR or PR not merged (`gh pr view <branch> --json state -q .state` ≠ MERGED, or errors) → keep; MERGED → `git worktree remove <path>` + `git branch -D <branch>`. Finish with `git worktree prune`. Out: removed / kept lists.
