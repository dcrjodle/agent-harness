#!/usr/bin/env bash
harness_repo_root() {
  local common
  common="$(git -C "${1:-$PWD}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  dirname "$common"
}

harness_repo_name() {
  local root
  root="$(harness_repo_root "${1:-$PWD}")" || return 1
  basename "$root"
}

harness_default_branch() {
  local dir="${1:-$PWD}" ref
  ref="$(git -C "$dir" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)" || {
    git -C "$dir" remote get-url origin >/dev/null 2>&1 && git -C "$dir" remote set-head origin -a >/dev/null 2>&1
    ref="$(git -C "$dir" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)" || ref="main"
  }
  echo "${ref#origin/}"
}
