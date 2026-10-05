#!/bin/sh
# Claude Code hook: decide a solve's level and recipe once, when it starts, and add the result to the
# context. UserPromptExpansion covers a typed /solve (task in command_args), PreToolUse the Skill tool
# (task in tool_input.args). Runs bin/decide start. Always exits 0 and prints nothing for any other
# payload, for sub-agents, without jq or node, or when decide fails. Never decides permissions.
input="$(cat)"
command -v jq >/dev/null 2>&1 || exit 0
command -v node >/dev/null 2>&1 || exit 0

task="$(printf '%s' "$input" | jq -r '
  def text: if type == "string" then . elif type == "array" then map(tostring) | join(" ") else empty end;
  if (.agent_id // "") != "" then empty
  elif .hook_event_name == "UserPromptExpansion" and ((.command_name // "") | ltrimstr("/")) == "solve" then .command_args | text
  elif .hook_event_name == "PreToolUse" and .tool_name == "Skill" and .tool_input.skill == "solve" then .tool_input.args | text
  else empty end' 2>/dev/null)"
[ -n "$task" ] || exit 0
event="$(printf '%s' "$input" | jq -r '.hook_event_name' 2>/dev/null)"
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
[ -n "$cwd" ] && [ -d "$cwd" ] || cwd="$PWD"

out="$(node "$(dirname "$0")/../bin/decide" start --repo "$cwd" -- "$task" 2>/dev/null)" || exit 0
[ -n "$out" ] || exit 0
jq -cn --arg event "$event" --arg context "$out" \
  '{hookSpecificOutput: {hookEventName: $event, additionalContext: $context}}' 2>/dev/null
exit 0
