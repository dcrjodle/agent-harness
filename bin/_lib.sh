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
  local dir="${1:-$PWD}" ref b
  # 1. Already-resolved origin/HEAD.
  ref="$(git -C "$dir" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)" || ref=""
  # 2. If origin exists, try to resolve it (network call) and retry.
  if [ -z "$ref" ] && git -C "$dir" remote get-url origin >/dev/null 2>&1; then
    git -C "$dir" remote set-head origin -a >/dev/null 2>&1
    ref="$(git -C "$dir" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)" || ref=""
  fi
  if [ -n "$ref" ]; then
    echo "${ref#origin/}"
    return 0
  fi
  # 3. First of main/master that exists as a local or origin ref.
  for b in main master; do
    if git -C "$dir" show-ref --verify --quiet "refs/heads/$b" || git -C "$dir" show-ref --verify --quiet "refs/remotes/origin/$b"; then
      echo "$b"
      return 0
    fi
  done
  # 4. Static config fallback. Never the currently checked-out branch.
  ref="$(git -C "$dir" config --get init.defaultBranch 2>/dev/null)" || ref=""
  echo "${ref:-main}"
}
