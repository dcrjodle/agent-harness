#!/usr/bin/env bash
# Log sub-agent start/stop. A stop also records the model and the agent's cumulative token usage
# (input, cache read, cache write, output), read from its transcript in the background.
input="$(cat)"
command -v jq >/dev/null || exit 0
log="$HOME/.agent-harness/logs/stages.tsv"
mkdir -p "$(dirname "$log")"
(
  row="$(printf '%s' "$input" | jq -r '[(now|todate), .hook_event_name, (.agent_type // "-"), (.agent_id // "-"), (.session_id // "-"), (.cwd // "-")] | @tsv')"
  if [ "$(printf '%s' "$input" | jq -r '.hook_event_name')" = "SubagentStop" ]; then
    t="$(printf '%s' "$input" | jq -r '.agent_transcript_path // empty')"
    if [ ! -f "$t" ]; then
      t="$(printf '%s' "$input" | jq -r '((.transcript_path // "") | sub("\\.jsonl$"; "")) + "/subagents/agent-" + (.agent_id // "") + ".jsonl"')"
    fi
    if [ -f "$t" ]; then
      usage="$(jq -Rrn '[inputs | fromjson? | select(.type == "assistant" and .message.usage)]
        | group_by(.message.id) | map(last) | select(length > 0)
        | [(.[0].message.model), (map(.message.usage.input_tokens // 0) | add), (map(.message.usage.cache_read_input_tokens // 0) | add),
           (map(.message.usage.cache_creation_input_tokens // 0) | add), (map(.message.usage.output_tokens // 0) | add)] | @tsv' "$t" 2>/dev/null)"
      [ -n "$usage" ] && row="$row	$usage"
    fi
  fi
  printf '%s\n' "$row" >> "$log"
) >/dev/null 2>&1 &
exit 0
