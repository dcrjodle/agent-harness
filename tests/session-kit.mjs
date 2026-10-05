// What the session-log test files share: a scratch harness with its own fake Supabase on loopback, the
// bin/session-log commands with everything they print recorded (for the secret check), and the payloads of
// the Claude Code hooks the orchestrating session fires. One fake and one scratch harness per test, so a
// flusher that is still running when a test ends talks to a closed port. Nothing here reaches the real
// Supabase, ~/.agent-harness or its logs; the only secret is the fake's.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startFakeSupabase } from "./fake-supabase.mjs";
import { SECRET, SESSION_LOG, makeHarness, sessionLog, supabaseEnv } from "./helpers.mjs";

// `repo` is the directory the hook payloads name as their cwd.
export function sessionKit(s, repo) {
  const seen = []; // everything any command printed, for the secret check
  const harnesses = [];

  // A harness with its own fake Supabase. The .env has the URL and the secret key unless a test leaves one out.
  async function setup(t, { url = true, secret = true } = {}) {
    const fake = await startFakeSupabase();
    t.after(() => fake.close());
    const lines = [url && `COCKPIT_SUPABASE_URL=${fake.url}`, secret && `COCKPIT_SUPABASE_SECRET_KEY=${SECRET}`].filter(Boolean);
    const h = makeHarness(s, { key: null, env: lines.length ? `${lines.join("\n")}\n` : "" });
    harnesses.push(h);
    return { fake, h, full: () => h.setEnv(supabaseEnv(fake.url)) };
  }

  const log = async (h, args, opts) => {
    const r = await sessionLog(s, h, args, opts);
    seen.push(r.stdout, r.stderr);
    return r;
  };
  const hook = (h, payload, opts) => log(h, ["hook"], { input: typeof payload === "string" ? payload : JSON.stringify(payload), ...opts });
  const flush = (h, opts) => log(h, ["flush"], opts);
  const status = (h, opts) => log(h, ["status"], opts);
  const quiet = (r, why = "hook") => {
    assert.equal(r.code, 0, `${why}: exit ${r.code}, ${r.stderr}`);
    assert.equal(r.stdout, "", `${why}: stdout ${r.stdout}`);
    assert.equal(r.stderr, "", `${why}: stderr ${r.stderr}`);
  };

  // `flush` started and not awaited: { child, pid, done: Promise<{ code, signal, stdout, stderr }> }. A flusher
  // that is still running when the test ends is killed.
  function startFlush(t, h, opts = {}) {
    const child = spawn(SESSION_LOG, ["flush"], { env: s.env({ HARNESS_DIR: h.dir, ...opts.env }), cwd: s.root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => {
        seen.push(stdout, stderr);
        resolve({ code, signal, stdout, stderr });
      });
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    return { child, pid: child.pid, done };
  }

  // The hook payloads of the orchestrator's session s1, in the shapes of the real client (verify-1).
  const start = (id, extra = {}) => ({ hook_event_name: "SubagentStart", session_id: "s1", agent_id: id, agent_type: "implementer", cwd: repo, ...extra });
  // PostToolUse of the Agent tool in the main session: a background spawn (async_launched) unless told otherwise.
  const launched = (id, description, subagentType = "implementer", extra = {}) => ({
    hook_event_name: "PostToolUse",
    session_id: "s1",
    tool_name: "Agent",
    tool_input: { description, prompt: "do the lane", subagent_type: subagentType, run_in_background: true },
    tool_response: { isAsync: true, status: "async_launched", agentId: id, description },
    cwd: repo,
    ...extra,
  });
  const stopped = (id, extra = {}) => ({ hook_event_name: "SubagentStop", session_id: "s1", agent_id: id, agent_type: "implementer", cwd: repo, ...extra });
  const ended = (extra = {}) => ({ hook_event_name: "SessionEnd", session_id: "s1", cwd: repo, reason: "other", ...extra });

  return { seen, harnesses, setup, log, hook, flush, status, quiet, startFlush, start, launched, stopped, ended };
}
