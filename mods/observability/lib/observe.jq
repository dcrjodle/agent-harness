# Turns one session's events into the structured view the pane draws and the export saves:
# the session, one node per agent (the parent session is "main"), who spawned whom, messages and errors.

def ms: capture("^(?<d>[^.Z]+)(\\.(?<f>[0-9]+))?Z$") | ((.d + "Z") | fromdate) * 1000 + (((.f // "0") + "00")[0:3] | tonumber);

def sum(f): map(f // 0) | add // 0;

# The price entry with the longest id found in the model id, so dated ids, point releases and gateway
# prefixes (converse/eu.anthropic.claude-opus-5) resolve.
def price($p; $model): [$p.models[] | select(.id as $id | ($model // "") | contains($id))] | sort_by(.id | length) | last;

# One usage row in US dollars, or null when the model has no price.
def usd($p):
  price($p; .model) as $m
  | if $m == null then null
    else (if .speed == "fast" then ($m.fast // 1) else 1 end)
      * ((.input // 0) * $m.input + (.output // 0) * $m.output + (.cache_read // 0) * $m.cache_read
         + ((.cache_write_5m // 0) * $p.cache_write_5m + (.cache_write_1h // 0) * $p.cache_write_1h) * $m.input) / 1e6
    end;

# Usage rows for one node. $rows come from its transcript and carry the cache split; $turns are the engine's
# own totals per turn. A sub-agent's transcript is written before each response ends, so its output count
# runs low: what the engine counted beyond it is added to the row of the model that answered.
def usage($rows; $turns):
  ($turns | map(.usage // empty)) as $exact
  | if ($rows | length) == 0 then
      $exact | group_by(.model) | map({model: .[0].model, speed: "standard", input: sum(.input), cache_read: sum(.cache_read),
        cache_write_5m: sum(.cache_write), cache_write_1h: 0, output: sum(.output)})
    else
      (($exact | sum(.output)) - ($rows | sum(.output))) as $missing
      | if $missing <= 0 then $rows
        else ($exact | last.model) as $model
          | ($rows | map(.model == $model and .speed != "fast") | index(true)) as $i
          | if $i == null then $rows + [{model: $model, speed: "standard", input: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, output: $missing}]
            else $rows | .[$i].output += $missing end
        end
    end;

# What every node reports about its tokens and cost, from its usage rows.
def spend($p; $turns):
  . as $rows
  | {models: ($rows | map(.model) | unique),
     tokens: ({input: ($rows | sum(.input)), cache_read: ($rows | sum(.cache_read)),
               cache_write: ($rows | sum((.cache_write_5m // 0) + (.cache_write_1h // 0))), output: ($rows | sum(.output))}
              | .total = (.input + .cache_read + .cache_write + .output)),
     output_exact: (($turns | map(.usage // empty) | length) > 0 or ($rows | sum(.partial)) == 0),
     cost_usd: ($rows | map(usd($p) // 0) | add // 0),
     unpriced: ($rows | map(select(usd($p) == null) | .model) | unique),
     usage: $rows};

# Milliseconds a node was working: the engine's turn durations when it reported them, else start to stop.
def active($turns; $runs): if ($turns | length) > 0 then ($turns | sum(.duration_ms)) else ($runs | map(select(.stop != null) | .stop - .start) | add // 0) end;

# A tool call that failed by itself; one the person interrupted is not the agent's error.
def failed: .event == "PostToolUseFailure" and .interrupted != true;

def turn_status: {answer: "completed", aborted: "stopped", refusal: "refused", error: "failed"}[.reason // "answer"] // "completed";

def agent($id; $ev; $p):
  ($ev | map(select(.agent == $id))) as $mine
  | ($mine | map(select(.event == "SubagentStart"))) as $starts
  | ($mine | map(select(.event == "SubagentStop"))) as $stops
  | ($mine | map(select(.event == "turn"))) as $turns
  | ($starts | map(.tool_use_id // empty) | first) as $call
  | ($ev | map(select(.event == "PreToolUse" and $call != null and .tool_use_id == $call)) | first) as $asked
  | ($ev | map(select(.event == "PostToolUse" and .child == $id)) | last) as $done
  | (if ($starts | length) > 0 then $starts else $mine[0:1] end) as $begins
  | [range(0; $begins | length) as $i | $begins[$i].t as $a | ($begins[$i + 1].t // infinite) as $b
     | {start: $a, stop: ($stops | map(select(.t >= $a and .t < $b)) | last.t)}] as $runs
  # Still working: no stop after the last start, and no finished turn the engine reported since it.
  | (($runs | last.stop == null) and (($turns | last.t // 0) < ($runs | last.start))) as $running
  | {id: $id, parent: (($asked // $done) | if . then .agent // "main" else "main" end), kind: "agent",
     type: ($starts[0].agent_type // $stops[0].agent_type // $asked.spawn.type // "agent"),
     description: (($starts | map(.description // empty) | first) // $asked.spawn.description // $done.description),
     status: (if $running then "running" elif ($turns | length) > 0 then ($turns | last | turn_status)
              elif ($stops | last.stopped_by_user) then "stopped" else "completed" end),
     started_at: $begins[0].ts, ended_at: (if $running then null else (($stops | last.ts) // ($turns | last.ts)) end),
     runs: ($runs | length), active_ms: active($turns; $runs),
     tool_uses: ($stops | last.tool_uses), tool_errors: ($mine | map(select(failed)) | length),
     last_message: ($stops | last.last_message)}
    + (usage(($stops | map(.usage // empty) | last) // []; $turns) | spend($p; $turns));

def main($ev; $p):
  ($ev | map(select(.agent == null))) as $mine
  | ($mine | map(select(.event == "turn"))) as $turns
  | ($mine | map(select(.event == "UserPromptSubmit"))) as $prompts
  | ($mine | map(select(.event == "Stop" or .event == "StopFailure"))) as $stops
  | [range(0; $stops | length) as $i | (if $i == 0 then 0 else $stops[$i - 1].t end) as $from
     | ($prompts | map(select(.t > $from and .t <= $stops[$i].t)) | first) as $asked
     | select($asked != null) | {start: $asked.t, stop: $stops[$i].t}] as $runs
  | ($mine | map(select(.event | IN("SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd", "turn"))) | last) as $last
  | {id: "main", parent: null, kind: "session",
     type: (($mine | map(select(.event == "SessionStart") | .agent_type // empty) | last) // "main"),
     description: (($mine | map(.title // empty) | last) // ($prompts[0].prompt) // null),
     status: (if $last == null then "idle"
              elif $last.event == "SessionEnd" then "ended"
              elif $last.event == "StopFailure" or ($last.event == "turn" and $last.reason == "error") then "failed"
              elif $last.event == "UserPromptSubmit" then "active" else "idle" end),
     started_at: $ev[0].ts, ended_at: (if $last.event == "SessionEnd" then $last.ts else null end),
     runs: ([($prompts | length), ($turns | length)] | max), active_ms: active($turns; $runs),
     tool_uses: ($mine | map(select(.event == "Stop") | .tool_uses // empty) | last),
     tool_errors: ($mine | map(select(failed)) | length),
     last_message: ($mine | map(select(.event == "Stop") | .last_message // empty) | last)}
    + (usage(($mine | map(select(.event == "Stop") | .usage // empty) | last) // []; $turns) | spend($p; $turns));

def view($p):
  (map(select(type == "object" and (.event | type) == "string" and (.ts | type) == "string" and (.ts | test("^[0-9T:-]+(\\.[0-9]+)?Z$")))
       | . + {t: (.ts | ms)}) | sort_by(.t)) as $ev
  | if ($ev | length) == 0 then error("no events") else . end
  | ([main($ev; $p)] + ($ev | map(select(.event == "SubagentStart" or .event == "SubagentStop" or .event == "turn") | .agent // empty)
       | unique | map(. as $id | agent($id; $ev; $p)) | sort_by(.started_at))) as $found
  | ($found | map(.id)) as $ids
  | ($found | map(if .parent != null and (.parent as $parent | $ids | index($parent)) == null then .parent = "main" else . end)) as $nodes
  | ($ev | map(.session_cost_usd // empty) | last) as $ledger
  | {version: 1,
     session: ($nodes[0] as $main | {
       id: $ev[0].session, title: $main.description, cwd: ($ev | map(.cwd // empty) | first),
       model: (($ev | map(select(.event == "SessionStart") | .model // empty) | last) // ($main.usage | max_by(.output // 0) | .model)),
       status: $main.status, started_at: $main.started_at, ended_at: $main.ended_at, last_at: ($ev | last.ts),
       wall_ms: (($ev | last.t) - $ev[0].t), active_ms: $main.active_ms,
       agents: (($nodes | length) - 1), messages: ($ev | map(select(.event == "message")) | length),
       tool_errors: ($nodes | sum(.tool_errors)),
       tokens: ({input: ($nodes | sum(.tokens.input)), cache_read: ($nodes | sum(.tokens.cache_read)),
                 cache_write: ($nodes | sum(.tokens.cache_write)), output: ($nodes | sum(.tokens.output))}
                | .total = (.input + .cache_read + .cache_write + .output)),
       cost_usd: ($ledger // ($nodes | sum(.cost_usd))), cost_source: (if $ledger != null then "engine" else "estimate" end),
       unpriced: ($nodes | map(.unpriced[]) | unique),
       transcript: ($ev | map(select(.agent == null) | .transcript // empty) | last)}),
     nodes: $nodes,
     edges: ($nodes | map(select(.parent != null) | {from: .parent, to: .id})),
     messages: ($ev | map(select(.event == "message") | {ts, agent: (.agent // "main"), kind, text})),
     errors: ($ev | map(select(failed or .event == "StopFailure")
       | {ts, agent: (.agent // "main"), tool: (.tool // null), error: ([.error, .details] | map(select(. != null)) | join(" — "))}))};
