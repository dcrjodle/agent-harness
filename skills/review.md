# review — large
In: the task worktree. Base = default branch (see `~/.agent-harness/rules/git.md`).
Diff = `git diff <base>...HEAD` plus `git diff HEAD` for uncommitted work. Both empty → report "nothing to review" as an error, never as approval.
Review only the diff.
Out: findings as `file:line — severity — issue`. No findings on a non-empty diff = approved.
