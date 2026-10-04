#!/usr/bin/env bash
# Push analytics for a hook event to the observability mod's endpoint. Settings wire it to the session's own
# events and to every sub-agent's, so each parent and child reports whether or not the model cooperates.
# It never blocks or fails the event: the push runs in the background and every error is swallowed.
# Only the session's end is pushed before returning, since nothing in the background outlives the exit.
input="$(cat)"
endpoint="$HOME/.agent-harness/mods/observability/bin/observe"
command -v jq >/dev/null && [ -x "$endpoint" ] || exit 0
IFS=$'\t' read -r event tool < <(printf '%s' "$input" | jq -r '[.hook_event_name // "", .tool_name // ""] | @tsv' 2>/dev/null)
case "$event:$tool" in
  :*) exit 0 ;;
  PreToolUse:Agent|PreToolUse:Task|PostToolUse:Agent|PostToolUse:Task) ;;
  PreToolUse:*|PostToolUse:*) exit 0 ;; # only spawns are analytics; other tool calls are not recorded
esac

# A child cannot see its own id, so the hook hands it the command that reports under it.
if [ "$event" = "SubagentStart" ]; then
  printf '%s' "$input" | jq -c '{hookSpecificOutput: {hookEventName: "SubagentStart", additionalContext:
    ("Observability: if the harness itself got in your way (a wrong recipe, a missing rule, a failing script), report it once with `~/.agent-harness/mods/observability/bin/observe <suggestion|error|note> --agent " + .agent_id + " \"<text>\"`.")}}' 2>/dev/null
fi

# Token usage per model from a transcript, one API message counted once. `partial` counts the messages
# written before their response ended, whose output count is therefore low.
usage() {
  [ -f "$1" ] || { echo '{}'; return; }
  grep -F '"type":"assistant"' "$1" | jq -Rnc '
    [inputs | fromjson? | select(.type == "assistant" and (.message.usage | type) == "object" and .message.model != "<synthetic>")] as $rows
    | {tool_uses: ([$rows[].message.content[]? | select(.type == "tool_use")] | length),
       usage: ($rows | group_by(.message.id) | map(last.message)
         | group_by([.model, .usage.speed // "standard"]) | map({
             model: .[0].model, speed: (.[0].usage.speed // "standard"), messages: length,
             partial: (map(select(.stop_reason == null)) | length),
             input: (map(.usage.input_tokens // 0) | add),
             cache_read: (map(.usage.cache_read_input_tokens // 0) | add),
             cache_write_5m: (map(.usage | (.cache_creation_input_tokens // 0) - (.cache_creation.ephemeral_1h_input_tokens // 0)) | add),
             cache_write_1h: (map(.usage.cache_creation.ephemeral_1h_input_tokens // 0) | add),
             output: (map(.usage.output_tokens // 0) | add)}))}' 2>/dev/null || echo '{}'
}

push() {
  extra='{}'
  transcript="$(printf '%s' "$input" | jq -r '.transcript_path // empty')"
  agent="$(printf '%s' "$input" | jq -r '.agent_id // empty')"
  # Beside a child's transcript the engine keeps a meta file naming the Agent call that spawned it.
  meta="${transcript%.jsonl}/subagents/agent-$agent.meta.json"
  case "$event" in
    SubagentStart)
      for _ in 1 2 3 4 5 6 7 8 9 10; do [ -f "$meta" ] && break; sleep 0.2; done
      [ -f "$meta" ] && extra="$(jq -c '{tool_use_id: .toolUseId, description}' "$meta")"
      ;;
    SubagentStop)
      t="$(printf '%s' "$input" | jq -r '.agent_transcript_path // empty')"
      [ -f "$t" ] || t="${transcript%.jsonl}/subagents/agent-$agent.jsonl"
      extra="$(usage "$t")"
      [ -f "$meta" ] && extra="$(jq -c --argjson u "$extra" '$u + {stopped_by_user: .stoppedByUser}' "$meta")"
      ;;
    Stop) extra="$(usage "$transcript")" ;;
  esac
  [ -n "$extra" ] || extra='{}'
  printf '%s' "$input" | jq -c --argjson extra "$extra" '
    def clip($n): if type == "string" and length > $n then .[0:$n] + "…" else . end;
    ((.tool_input | objects) // {}) as $in | ((.tool_response | objects) // {}) as $out
    | {session: .session_id, event: .hook_event_name, agent: .agent_id, agent_type, cwd}
    + ({SessionStart: {source, model, title: .session_title, transcript: .transcript_path},
        UserPromptSubmit: {prompt: (.prompt | clip(200)), source, title: .session_title},
        PreToolUse: {tool_use_id, spawn: {type: $in.subagent_type, description: $in.description, model: $in.model, background: $in.run_in_background}},
        PostToolUse: {tool_use_id, child: $out.agentId, status: $out.status, description: $in.description, model: $out.resolvedModel},
        PostToolUseFailure: {tool: .tool_name, error: (.error | clip(300)), interrupted: .is_interrupt},
        SubagentStop: {last_message: (.last_assistant_message | clip(500)), transcript: .agent_transcript_path},
        Stop: {last_message: (.last_assistant_message | clip(500))},
        StopFailure: {error: (.error | if type == "string" then . else tojson end | clip(300)), details: (.error_details | clip(300))},
        SessionEnd: {reason}}[.hook_event_name] // {})
    + $extra
    | with_entries(select(.value != null))' | "$endpoint" push
}

if [ "$event" = "SessionEnd" ]; then push >/dev/null 2>&1; else push >/dev/null 2>&1 & fi
exit 0
