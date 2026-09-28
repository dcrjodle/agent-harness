#!/usr/bin/env bash
input="$(cat)"
command -v jq >/dev/null || exit 0
mkdir -p "$HOME/.agent-harness/logs"
printf '%s' "$input" | jq -r '[now|todate, .hook_event_name, (.agent_type // "-"), (.agent_id // "-"), (.session_id // "-"), (.cwd // "-")] | @tsv' \
  >> "$HOME/.agent-harness/logs/stages.tsv" 2>/dev/null
exit 0
