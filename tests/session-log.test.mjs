// H-A: bin/session-log (sessions plan S2 to S4). Hooks and bin/decide queue events in a scratch HARNESS_DIR's
// logs/session-outbox/, and a flusher sends them to a fake Supabase on loopback. Every test gets its own fake
// and its own harness, so a flusher that is still running when a test ends talks to a closed port. Nothing
// here reaches the real Supabase, ~/.agent-harness or its logs; the only secret is the fake's.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { startFakeSupabase } from "./fake-supabase.mjs";
import { EVENT_NAME, SECRET, SESSION_LOG, decide, deadUrl, drained, makeHarness, makeRepo, makeUiRepo, run, scratch, sessionLog, sleep, supabaseEnv, until } from "./helpers.mjs";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REST = "/rest/v1/";
const points = (text) => [...text].length;

describe("H-A bin/session-log", () => {
  const s = scratch("harness-sessionlog-");
  const transcripts = path.join(s.root, "t");
  const seen = []; // everything any command printed, for the secret check
  const harnesses = [];
  let acme;
  let plain;
  let closedUrl;

  before(async () => {
    acme = makeUiRepo(s, "acme", { origin: "git@github.com:o/acme.git" });
    plain = makeRepo(s, "plain");
    closedUrl = await deadUrl();
  });
  after(() => s.remove());

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

  const meta = (sessionId, agentId, description) => {
    const dir = path.join(transcripts, sessionId, "subagents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ description }));
  };
  const start = (id, extra = {}) => ({
    hook_event_name: "SubagentStart",
    session_id: "s1",
    agent_id: id,
    agent_type: "implementer",
    cwd: acme,
    transcript_path: path.join(transcripts, "s1.jsonl"),
    ...extra,
  });
  const labelled = (extra = {}) => ({
    hook_event_name: "PostToolUse",
    session_id: "s1",
    tool_name: "Agent",
    tool_input: { description: "Lane 1" },
    tool_response: { agentId: "a1" },
    cwd: acme,
    ...extra,
  });
  const stopped = (extra = {}) => ({ hook_event_name: "SubagentStop", session_id: "s1", agent_id: "a1", agent_type: "tester", cwd: acme, ...extra });
  const ended = (extra = {}) => ({ hook_event_name: "SessionEnd", session_id: "s1", cwd: acme, reason: "other", ...extra });

  // An event without its time, which must be an ISO string with milliseconds.
  const bare = (event) => {
    const { at, ...rest } = event;
    assert.match(at, ISO, "at");
    return rest;
  };
  const agentWrites = (fake) => fake.requests.filter((r) => /^\/rest\/v1\/cockpit_(agents|decisions)\?/.test(r.path) && r.method === "POST");
  const reasonOf = (h, name) => fs.readFileSync(path.join(h.rejectedDir, `${name}.reason`), "utf8");

  describe("A1 a SubagentStart payload queues one agent_start", () => {
    it("writes one file with the event, silently and within 1 s", async (t) => {
      const { h } = await setup(t, { secret: false });
      meta("s1", "a1", "Lane 1:   API routes");
      const r = await hook(h, start("a1"));
      quiet(r);
      assert.ok(r.ms < 1000, `took ${r.ms} ms`);
      assert.deepEqual(fs.readdirSync(h.outboxDir), h.eventFiles(), "nothing in the outbox but the event file");
      const [name] = h.eventFiles();
      assert.equal(h.eventFiles().length, 1);
      assert.match(name, EVENT_NAME);
      const event = h.events()[0];
      assert.deepEqual(bare(event), { v: 1, kind: "agent_start", session_id: "s1", repo: "o/acme", agent_id: "a1", role: "implementer", label: "Lane 1: API routes" });
      assert.equal(name.slice(0, 13), String(Date.parse(event.at)), "the file name starts with the event time in ms");
    });

    it("repo is the folder name when the repo has no remote", async (t) => {
      const { h } = await setup(t, { secret: false });
      quiet(await hook(h, start("a1", { cwd: plain })));
      assert.equal(h.events()[0].repo, "plain");
    });

    it("repo is owner/name from the origin URL, however it is written", async (t) => {
      const { h } = await setup(t, { secret: false });
      const cases = [
        ["git@github.com:o/acme.git", "o/acme"],
        ["https://github.com/some-org/some-repo.git", "some-org/some-repo"],
        ["https://github.com/o/no-suffix", "o/no-suffix"],
      ];
      for (const [i, [origin, repo]] of cases.entries()) {
        const dir = makeRepo(s, `remote-${i}`, { origin });
        quiet(await hook(h, start(`r${i}`, { cwd: dir })));
        assert.equal(h.events().at(-1).repo, repo, origin);
      }
    });

    it("repo is the main checkout folder from a linked worktree without a remote", async (t) => {
      const { h } = await setup(t, { secret: false });
      const wt = path.join(s.root, "plain-task");
      s.git(plain, "worktree", "add", "-q", "-b", "feat/task", wt);
      quiet(await hook(h, start("a1", { cwd: wt })));
      assert.equal(h.events()[0].repo, "plain");
    });

    it("repo is the folder name outside a git repo, and null without a cwd", async (t) => {
      const { h } = await setup(t, { secret: false });
      const nogit = s.dir("nogit");
      quiet(await hook(h, start("a1", { cwd: nogit })));
      quiet(await hook(h, start("a2", { cwd: undefined })));
      const [first, second] = h.events();
      assert.equal(first.repo, path.basename(nogit));
      assert.equal(second.repo, null);
    });

    it("label is null without an agent meta file, or when it is not readable JSON", async (t) => {
      const { h } = await setup(t, { secret: false });
      quiet(await hook(h, start("a2")));
      const broken = path.join(transcripts, "s1", "subagents");
      fs.mkdirSync(broken, { recursive: true });
      fs.writeFileSync(path.join(broken, "agent-a3.meta.json"), "{ not json");
      quiet(await hook(h, start("a3")));
      quiet(await hook(h, start("a4", { transcript_path: undefined })));
      assert.deepEqual(h.events().map((e) => e.label), [null, null, null]);
      assert.deepEqual(h.events().map((e) => e.agent_id), ["a2", "a3", "a4"]);
    });
  });

  describe("A2 which payloads queue which event", () => {
    const rows = [
      ["PostToolUse of the Agent tool, in the main session", () => labelled(), { kind: "agent_label", agent_id: "a1", label: "Lane 1" }],
      ["SubagentStop of a typed agent", () => stopped(), { kind: "agent_stop", agent_id: "a1" }],
      ["SessionEnd", () => ended(), { kind: "session_end" }],
    ];
    for (const [name, payload, expected] of rows) {
      it(`${name} queues ${expected.kind}`, async (t) => {
        const { h } = await setup(t, { secret: false });
        quiet(await hook(h, payload()));
        assert.equal(h.eventFiles().length, 1);
        assert.deepEqual(bare(h.events()[0]), { v: 1, session_id: "s1", repo: "o/acme", ...expected });
      });
    }

    const nothing = [
      ["the same PostToolUse with an agent_id (a tool call of a sub-agent)", () => labelled({ agent_id: "a9", agent_type: "tester" })],
      ["SubagentStop with an empty agent_type (an engine side agent)", () => stopped({ agent_type: "" })],
      ["a Stop payload", () => ({ hook_event_name: "Stop", session_id: "s1", cwd: acme })],
      ["a PreToolUse payload of the Bash tool", () => ({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" }, cwd: acme })],
      ["a PostToolUse payload of another tool", () => labelled({ tool_name: "Bash" })],
      ["a SubagentStart with the agent_id ../x", () => start("../x")],
      ["a SubagentStop with the agent_id ../x", () => stopped({ agent_id: "../x" })],
      ["a PostToolUse whose agentId is ../x", () => labelled({ tool_response: { agentId: "../x" } })],
      ["a SessionEnd with the session_id ../x", () => ended({ session_id: "../x" })],
      ["a payload without a session_id", () => ended({ session_id: undefined })],
      ["invalid JSON", () => "{ this is not json"],
      ["an empty stdin", () => ""],
      ["a JSON array", () => "[1, 2]"],
    ];
    for (const [name, payload] of nothing) {
      it(`queues nothing for ${name}, exit 0, no output`, async (t) => {
        const { h } = await setup(t, { secret: false });
        quiet(await hook(h, payload()));
        assert.deepEqual(h.eventFiles(), []);
        assert.deepEqual(fs.existsSync(h.outboxDir) ? fs.readdirSync(h.outboxDir) : [], []);
      });
    }

    it("an unwritable outbox does not make the hook fail", async (t) => {
      const { h } = await setup(t, { secret: false });
      fs.writeFileSync(path.join(h.dir, "logs"), "this is a file, not a directory");
      quiet(await hook(h, start("a1")));
    });
  });

  describe("A3 the flush writes each event as the fixed requests", () => {
    it("sent 4: the nine requests of the agent's life, in order", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      meta("s1", "a1", "Lane 1:   API routes");
      quiet(await hook(h, start("a1")));
      quiet(await hook(h, labelled()));
      quiet(await hook(h, stopped()));
      quiet(await hook(h, ended()));
      assert.equal(h.eventFiles().length, 4);
      assert.equal(fake.requests.length, 0, "no secret key, so nothing is sent");
      const [e1, e2, e3, e4] = h.events();

      full();
      const r = await flush(h);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "sent 4, waiting 0, rejected 0\n");

      const expected = [
        [
          "POST",
          `${REST}cockpit_sessions?on_conflict=id`,
          "resolution=ignore-duplicates, return=minimal",
          { id: "s1", repo: "o/acme", title: null, level: null, started_at: e1.at, last_at: e1.at, ended_at: null },
        ],
        [
          "POST",
          `${REST}cockpit_agents?on_conflict=id`,
          "resolution=merge-duplicates, return=minimal",
          { id: "a1", session_id: "s1", role: "implementer", started_at: e1.at, ended_at: null, status: "running", label: "Lane 1: API routes" },
        ],
        ["PATCH", `${REST}cockpit_sessions?id=eq.s1`, null, { last_at: e1.at, ended_at: null }],
        ["PATCH", `${REST}cockpit_agents?id=eq.a1`, null, { label: "Lane 1" }],
        ["PATCH", `${REST}cockpit_sessions?id=eq.s1`, null, { last_at: e2.at }],
        ["PATCH", `${REST}cockpit_agents?id=eq.a1`, null, { ended_at: e3.at, status: "done" }],
        ["PATCH", `${REST}cockpit_sessions?id=eq.s1`, null, { last_at: e3.at }],
        ["PATCH", `${REST}cockpit_agents?session_id=eq.s1&status=eq.running`, null, { status: "failed", ended_at: e4.at }],
        ["PATCH", `${REST}cockpit_sessions?id=eq.s1`, null, { last_at: e4.at, ended_at: e4.at }],
      ];
      assert.equal(fake.requests.length, expected.length, fake.requests.map((q) => `${q.method} ${q.path}`).join("\n"));
      fake.requests.forEach((q, i) => {
        const [method, requestPath, prefer, body] = expected[i];
        assert.equal(`${q.method} ${q.path}`, `${method} ${requestPath}`, `request ${i + 1}`);
        if (prefer) assert.equal(q.prefer, prefer, `request ${i + 1} Prefer`);
        assert.deepEqual(q.body, body, `request ${i + 1} body`);
        assert.equal(q.apikey, SECRET, `request ${i + 1} apikey`);
        assert.equal(q.authorization, null, `request ${i + 1} authorization`);
        assert.match(q.contentType, /^application\/json/, `request ${i + 1} content-type`);
      });
      assert.deepEqual(Object.keys(fake.requests[0].body).sort(), ["ended_at", "id", "last_at", "level", "repo", "started_at", "title"]);
      assert.deepEqual(h.eventFiles(), []);
      await drained(h, 1000);
    });

    it("a session event and a decision from bin/decide: the session row first, with its title and level", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      const r0 = await decide(s, h, ["start", "--session", "s9", "--repo", acme, "--", "small fix the readme typo"], { url: closedUrl });
      assert.equal(r0.code, 0, r0.stderr);
      const [session, decision] = h.events();
      assert.equal(fake.requests.length, 0);

      full();
      const r = await flush(h);
      assert.equal(r.stdout, "sent 2, waiting 0, rejected 0\n");
      const q = fake.requests.map((x) => [x.method, x.path]);
      assert.deepEqual(q, [
        ["POST", `${REST}cockpit_sessions?on_conflict=id`],
        ["PATCH", `${REST}cockpit_sessions?id=eq.s9`],
        ["POST", `${REST}cockpit_decisions?on_conflict=session_id,point,at`],
        ["PATCH", `${REST}cockpit_sessions?id=eq.s9`],
      ]);
      assert.deepEqual(fake.requests[0].body, { id: "s9", repo: "o/acme", title: "fix the readme typo", level: "small", started_at: session.at, last_at: session.at, ended_at: null });
      assert.equal(fake.requests[0].prefer, "resolution=ignore-duplicates, return=minimal");
      assert.deepEqual(fake.requests[1].body, { last_at: session.at, title: "fix the readme typo", level: "small", ended_at: null });
      assert.equal(fake.requests[2].prefer, "resolution=merge-duplicates, return=minimal");
      assert.deepEqual(fake.requests[2].body, { session_id: "s9", point: "level", value: "small", confidence: null, source: "override", at: decision.at });
      assert.deepEqual(fake.requests[3].body, { last_at: decision.at, ended_at: null });
    });

    it("events that do not create a session row (label, stop, end) are only PATCHes", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      quiet(await hook(h, labelled()));
      quiet(await hook(h, stopped()));
      full();
      assert.equal((await flush(h)).stdout, "sent 2, waiting 0, rejected 0\n");
      assert.deepEqual(
        fake.requests.map((x) => x.method),
        ["PATCH", "PATCH", "PATCH", "PATCH"],
      );
    });

    it("a resumed agent is upserted again with a later start, running and open", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      quiet(await hook(h, start("a1")));
      quiet(await hook(h, stopped()));
      await sleep(20);
      quiet(await hook(h, start("a1")));
      const events = h.events();
      full();
      assert.equal((await flush(h)).stdout, "sent 3, waiting 0, rejected 0\n");
      const upserts = fake.requests.filter((x) => x.method === "POST" && x.path.startsWith(`${REST}cockpit_agents`));
      assert.equal(upserts.length, 2);
      assert.equal(upserts[1].body.started_at, events[2].at);
      assert.ok(Date.parse(upserts[1].body.started_at) > Date.parse(upserts[0].body.started_at));
      assert.equal(upserts[1].body.ended_at, null);
      assert.equal(upserts[1].body.status, "running");
      const sessionRows = fake.requests.filter((x) => x.method === "POST" && x.path.startsWith(`${REST}cockpit_sessions`));
      assert.equal(sessionRows.length, 1, "the session row is ensured once per flush");
    });

    it("a legacy JWT key goes on apikey and also as a Bearer token (an sb_secret_ key never does)", async (t) => {
      const { fake, h } = await setup(t, { secret: false });
      const jwt = "eyJhbGciOiJIUzI1NiJ9.test-claims.test-signature";
      quiet(await hook(h, start("a1")));
      h.setEnv(supabaseEnv(fake.url, jwt));
      assert.equal((await flush(h)).stdout, "sent 1, waiting 0, rejected 0\n");
      assert.ok(fake.requests.length >= 3);
      for (const q of fake.requests) {
        assert.equal(q.apikey, jwt);
        assert.equal(q.authorization, `Bearer ${jwt}`);
      }
    });

    it("a URL with a trailing slash still writes under /rest/v1/", async (t) => {
      const { fake, h } = await setup(t, { secret: false });
      quiet(await hook(h, ended()));
      h.setEnv(`COCKPIT_SUPABASE_URL=${fake.url}/\nCOCKPIT_SUPABASE_SECRET_KEY=${SECRET}\n`);
      assert.equal((await flush(h)).stdout, "sent 1, waiting 0, rejected 0\n");
      assert.ok(fake.requests.length >= 1);
      for (const q of fake.requests) assert.ok(q.path.startsWith(`${REST}cockpit_`), q.path);
    });
  });

  describe("A4 a failure keeps the order", () => {
    it("three events wait while Supabase is down, and go out before a new one, in order", async (t) => {
      const { fake, h } = await setup(t);
      fake.mode("down");
      quiet(await hook(h, start("a1")));
      const decided = await decide(s, h, ["start", "--session", "s1", "--repo", acme, "--", "small fix"], { url: closedUrl });
      assert.equal(decided.code, 0, decided.stderr);
      await sleep(300); // the background flushers of the two commands fail on the first request
      const flushed = await flush(h);
      assert.equal(flushed.code, 0, flushed.stderr);
      assert.ok(flushed.ms < 5000, `took ${flushed.ms} ms`);
      assert.deepEqual(h.events().map((e) => e.kind), ["agent_start", "session", "decision"], "the three events wait");

      fake.mode("ok");
      fake.clear();
      quiet(await hook(h, start("a2")));
      await drained(h);

      const writes = agentWrites(fake);
      assert.deepEqual(
        writes.map((q) => q.body.id ?? `${q.body.point}:${q.body.value}`),
        ["a1", "level:small", "a2"],
        "the old agent and the decision are written before the new agent",
      );
      const times = writes.map((q) => Date.parse(q.body.started_at ?? q.body.at));
      assert.deepEqual(times, [...times].sort((a, b) => a - b));
    });
  });

  describe("A5 failures keep the events and stop the run", () => {
    for (const mode of ["401", "404", "500", "delay:5000"]) {
      it(`mode ${mode}: flush exits 0 within 10 s, keeps every event and sends nothing after the first failed request`, async (t) => {
        const { fake, h, full } = await setup(t, { secret: false });
        quiet(await hook(h, start("a1")));
        quiet(await hook(h, start("a2")));
        quiet(await hook(h, ended()));
        const names = h.eventFiles();
        assert.equal(names.length, 3);
        full();
        fake.mode(mode);
        const r = await flush(h);
        assert.equal(r.code, 0, r.stderr);
        assert.ok(r.ms < 10_000, `took ${r.ms} ms`);
        assert.equal(r.stdout, "sent 0, waiting 3, rejected 0\n");
        assert.deepEqual(h.eventFiles(), names);
        assert.equal(fake.requests.length, 1, "nothing is sent after the first failed request");
        assert.deepEqual(h.rejectedFiles(), []);
        assert.equal(fs.existsSync(path.join(h.outboxDir, ".lock")), false, "the lock is released");
      });
    }

    for (const mode of ["403", "406", "429", "503"]) {
      it(`status ${mode} also keeps the events and stops`, async (t) => {
        const { fake, h, full } = await setup(t, { secret: false });
        quiet(await hook(h, start("a1")));
        quiet(await hook(h, ended()));
        full();
        fake.mode(mode);
        assert.equal((await flush(h)).stdout, "sent 0, waiting 2, rejected 0\n");
        assert.equal(fake.requests.length, 1);
      });
    }

    it("mode 400 on the agent table: that event moves to rejected/ with its reason, the decision is sent", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      quiet(await hook(h, start("a1")));
      const queued = await decide(s, h, ["ui", "--session", "s1", acme], { url: closedUrl });
      assert.equal(queued.code, 0, queued.stderr);
      const [agentFile, decisionFile] = h.eventFiles();
      assert.equal(h.eventFiles().length, 2);
      full();
      fake.mode("400:cockpit_agents");
      const r = await flush(h);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "sent 1, waiting 0, rejected 1\n");
      assert.deepEqual(h.rejectedFiles(), [agentFile]);
      assert.ok(!h.eventFiles().includes(decisionFile));
      assert.match(reasonOf(h, agentFile), /\b400\b/);
      assert.ok(fake.requests.some((q) => q.method === "POST" && q.path.startsWith(`${REST}cockpit_decisions`)), "the decision was sent");
      assert.deepEqual(h.eventFiles(), []);
    });

    it("the reason file reads <status> <code> <message> (<METHOD> /rest/v1/<path>), with - for what the body lacks", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      quiet(await hook(h, start("a1")));
      const [first] = h.eventFiles();
      full();
      fake.mode("400:cockpit_agents");
      await flush(h);
      assert.match(reasonOf(h, first), /^400 23514 \S.* \(POST \/rest\/v1\/cockpit_agents\?on_conflict=id\)\n$/);

      quiet(await hook(h, start("a2")));
      const [second] = h.eventFiles();
      fake.mode("plain400:cockpit_agents");
      await flush(h);
      assert.equal(reasonOf(h, second), "400 - - (POST /rest/v1/cockpit_agents?on_conflict=id)\n");
    });

    for (const code of ["409", "422"]) {
      it(`status ${code} on one event rejects that event and goes on with the next`, async (t) => {
        const { fake, h, full } = await setup(t, { secret: false });
        quiet(await hook(h, start("a1")));
        quiet(await hook(h, ended()));
        const [agentFile] = h.eventFiles();
        full();
        fake.mode(`${code}:cockpit_agents\\?on_conflict`);
        const r = await flush(h);
        assert.equal(r.stdout, "sent 1, waiting 0, rejected 1\n");
        assert.deepEqual(h.rejectedFiles(), [agentFile]);
        assert.match(reasonOf(h, agentFile), new RegExp(`^${code} `));
      });
    }

    it("flush prints this run's rejected count, and status the total", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      quiet(await hook(h, start("a1")));
      full();
      fake.mode("400:cockpit_agents");
      assert.equal((await flush(h)).stdout, "sent 0, waiting 0, rejected 1\n");
      h.setEnv(`COCKPIT_SUPABASE_URL=${fake.url}\n`); // a hook with the secret set would flush by itself
      quiet(await hook(h, start("a2")));
      full();
      assert.equal((await flush(h)).stdout, "sent 0, waiting 0, rejected 1\n");
      fake.mode("ok");
      assert.equal((await flush(h)).stdout, "sent 0, waiting 0, rejected 0\n", "a run with nothing to send rejects nothing");
      assert.equal((await status(h)).stdout, "supabase: set\nwaiting: 0\nrejected: 2\n");
    });

    it("event files that are not valid events move to rejected/ instead of blocking the log", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      fs.mkdirSync(h.outboxDir, { recursive: true });
      const put = (name, text) => fs.writeFileSync(path.join(h.outboxDir, name), text);
      put("1700000000001-1-0000.json", "this is not json\n");
      put("1700000000002-1-0001.json", `${JSON.stringify({ v: 1, kind: "agent_stop", session_id: "../x", at: "2026-10-05T10:00:00.000Z", repo: null, agent_id: "a1" })}\n`);
      put("1700000000003-1-0002.json", `${JSON.stringify({ v: 1, kind: "nope", session_id: "s1", at: "2026-10-05T10:00:00.000Z", repo: null })}\n`);
      put("1700000000004-1-0003.json", "{}\n");
      quiet(await hook(h, ended()));
      full();
      const r = await flush(h);
      assert.equal(r.stdout, "sent 1, waiting 0, rejected 4\n");
      assert.equal(h.rejectedFiles().length, 4);
      for (const name of h.rejectedFiles()) assert.ok(reasonOf(h, name).length > 1, name);
      assert.equal(fake.requests.length, 2, "only the valid session_end was written");
    });

    it("an unreadable event file is rejected too", async (t) => {
      if (typeof process.getuid === "function" && process.getuid() === 0) return t.skip("root can read any file");
      const { h, full } = await setup(t, { secret: false });
      fs.mkdirSync(h.outboxDir, { recursive: true });
      const name = "1700000000001-1-0000.json";
      fs.writeFileSync(path.join(h.outboxDir, name), "{}\n", { mode: 0o000 });
      full();
      assert.equal((await flush(h)).stdout, "sent 0, waiting 0, rejected 1\n");
      assert.deepEqual(h.rejectedFiles(), [name]);
    });
  });

  describe("the lock", () => {
    it("a flusher that waits for the lock exits as soon as nothing waits, and leaves the lock alone", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      quiet(await hook(h, start("a1")));
      full();
      const lock = path.join(h.outboxDir, ".lock");
      fs.mkdirSync(lock);
      let done = false;
      const pending = flush(h).then((r) => ((done = true), r));
      await sleep(800);
      assert.equal(done, false, "it waits while an event waits and the lock is held");
      for (const name of h.eventFiles()) fs.rmSync(path.join(h.outboxDir, name)); // what the holder's sending does
      const r = await Promise.race([pending, sleep(4000).then(() => null)]);
      assert.ok(r, "it did not exit within 4 s of the outbox emptying");
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "sent 0, waiting 0, rejected 0\n");
      assert.equal(fs.existsSync(lock), true, "a flusher that never held the lock does not remove it");
      assert.equal(fake.requests.length, 0);
    });

    it("a lock older than a minute is taken over", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      quiet(await hook(h, start("a1")));
      full();
      const lock = path.join(h.outboxDir, ".lock");
      fs.mkdirSync(lock);
      const old = new Date(Date.now() - 120_000);
      fs.utimesSync(lock, old, old);
      const r = await flush(h);
      assert.equal(r.stdout, "sent 1, waiting 0, rejected 0\n");
      assert.ok(r.ms < 5000, `took ${r.ms} ms`);
      assert.equal(fs.existsSync(lock), false);
      assert.ok(fake.requests.length >= 3);
    });

    it("only one flusher is sending at a time", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      for (const id of ["a1", "a2", "a3", "a4"]) quiet(await hook(h, start(id)));
      full();
      fake.mode("delay:150");
      const runs = await Promise.all([flush(h), flush(h), flush(h)]);
      const sentTotal = runs.map((r) => Number(/^sent (\d+)/.exec(r.stdout)?.[1])).reduce((a, b) => a + b, 0);
      assert.equal(sentTotal, 4, runs.map((r) => r.stdout).join(""));
      const posts = fake.requests.filter((q) => q.method === "POST" && q.path.startsWith(`${REST}cockpit_agents`));
      assert.deepEqual(posts.map((q) => q.body.id).sort(), ["a1", "a2", "a3", "a4"], "every event exactly once");
    });
  });

  describe("A6 no credentials", () => {
    it("the hook queues, the fake gets nothing, and status says what is missing", async (t) => {
      const { fake, h } = await setup(t, { url: false, secret: false });
      quiet(await hook(h, start("a1")));
      await sleep(300);
      assert.equal(h.eventFiles().length, 1);
      assert.equal(fake.requests.length, 0);
      const r = await status(h);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "supabase: missing COCKPIT_SUPABASE_URL, COCKPIT_SUPABASE_SECRET_KEY\nwaiting: 1\nrejected: 0\n");
      assert.equal(r.stderr, "");
    });

    it("flush sends nothing without credentials and keeps the events", async (t) => {
      const { fake, h } = await setup(t, { url: false, secret: false });
      quiet(await hook(h, start("a1")));
      const r = await flush(h);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "sent 0, waiting 1, rejected 0\n");
      assert.equal(fake.requests.length, 0);
      assert.equal(h.eventFiles().length, 1);
    });

    it("status names only the key that is missing, and prints supabase: set with both", async (t) => {
      const { fake, h } = await setup(t, { url: true, secret: false });
      assert.equal((await status(h)).stdout, "supabase: missing COCKPIT_SUPABASE_SECRET_KEY\nwaiting: 0\nrejected: 0\n");
      h.setEnv(`COCKPIT_SUPABASE_SECRET_KEY=${SECRET}\n`);
      assert.equal((await status(h)).stdout, "supabase: missing COCKPIT_SUPABASE_URL\nwaiting: 0\nrejected: 0\n");
      h.setEnv(supabaseEnv(fake.url));
      const r = await status(h);
      assert.equal(r.stdout, "supabase: set\nwaiting: 0\nrejected: 0\n");
      fs.rmSync(path.join(h.dir, ".env"));
      assert.equal((await status(h)).stdout, "supabase: missing COCKPIT_SUPABASE_URL, COCKPIT_SUPABASE_SECRET_KEY\nwaiting: 0\nrejected: 0\n");
    });

    it("an empty value counts as missing", async (t) => {
      const { h } = await setup(t, { url: false, secret: false });
      h.setEnv("COCKPIT_SUPABASE_URL=\nCOCKPIT_SUPABASE_SECRET_KEY=\n");
      assert.match((await status(h)).stdout, /^supabase: missing COCKPIT_SUPABASE_URL, COCKPIT_SUPABASE_SECRET_KEY\n/);
    });
  });

  describe("A7 parallel hooks", () => {
    it("20 parallel runs write 20 distinct agents once each, and leave no lock", async (t) => {
      const { fake, h } = await setup(t);
      const ids = Array.from({ length: 20 }, (_, i) => `a${String(i + 1).padStart(2, "0")}`);
      const runs = await Promise.all(ids.map((id) => hook(h, start(id))));
      for (const r of runs) quiet(r, "parallel hook");
      await drained(h);
      await sleep(300);
      const posts = fake.requests.filter((q) => q.method === "POST" && q.path.startsWith(`${REST}cockpit_agents`));
      assert.equal(posts.length, 20);
      assert.deepEqual(posts.map((q) => q.body.id).sort(), ids, "distinct ids");
      assert.equal(fs.existsSync(path.join(h.outboxDir, ".lock")), false);
      assert.deepEqual(h.rejectedFiles(), []);
    });
  });

  describe("A8 the outbox is capped", () => {
    it("with 10,000 files waiting, one more hook run leaves at most 10,000 and drops the oldest", async (t) => {
      const { h } = await setup(t, { secret: false });
      fs.mkdirSync(h.outboxDir, { recursive: true });
      const old = [];
      for (let i = 0; i < 10_000; i++) {
        const name = `${1_700_000_000_000 + i}-1-${String(i % 10_000).padStart(4, "0")}.json`;
        old.push(name);
        fs.writeFileSync(path.join(h.outboxDir, name), "{}\n");
      }
      quiet(await hook(h, start("a1")));
      const after = h.eventFiles();
      assert.ok(after.length <= 10_000, `${after.length} files remain`);
      assert.ok(!after.includes(old[0]), "the oldest name is gone");
      assert.ok(after.includes(old[old.length - 1]), "the newest of the old ones stays");
      assert.equal(h.events().at(-1).agent_id, "a1", "the new event is kept");
    });
  });

  describe("A9 the keys come from the .env only", () => {
    it("a URL and key in the process environment are ignored", async (t) => {
      const { fake, h } = await setup(t);
      const env = { COCKPIT_SUPABASE_URL: "http://127.0.0.1:9", COCKPIT_SUPABASE_SECRET_KEY: "bogus" };
      quiet(await hook(h, start("a1"), { env }));
      await drained(h);
      assert.ok(fake.requests.length >= 3);
      for (const q of fake.requests) assert.equal(q.apikey, SECRET);
      quiet(await hook(h, start("a2"), { env }));
      await drained(h);
      assert.equal(fake.requests.filter((q) => q.method === "POST" && q.path.startsWith(`${REST}cockpit_agents`)).length, 2);
    });

    it("keys only in the process environment are not keys: the events wait", async (t) => {
      const { fake, h } = await setup(t, { url: false, secret: false });
      const env = { COCKPIT_SUPABASE_URL: fake.url, COCKPIT_SUPABASE_SECRET_KEY: SECRET };
      quiet(await hook(h, start("a1"), { env }));
      await sleep(400);
      assert.equal(fake.requests.length, 0);
      assert.equal(h.eventFiles().length, 1);
      assert.match((await status(h, { env })).stdout, /^supabase: missing COCKPIT_SUPABASE_URL, COCKPIT_SUPABASE_SECRET_KEY\n/);
      assert.equal((await flush(h, { env })).stdout, "sent 0, waiting 1, rejected 0\n");
    });
  });

  describe("A10 clipping", () => {
    const labelOf = async (t, description) => {
      const { h } = await setup(t, { secret: false });
      const id = `c${harnesses.length}`;
      meta("s1", id, description);
      quiet(await hook(h, start(id)));
      return h.events()[0].label;
    };
    const roleOf = async (t, agentType) => {
      const { h } = await setup(t, { secret: false });
      quiet(await hook(h, start("a1", { agent_type: agentType })));
      return h.events()[0].role;
    };

    it("a 300-character description becomes a label of 120 code points ending in an ellipsis", async (t) => {
      const label = await labelOf(t, "x".repeat(300));
      assert.equal(points(label), 120);
      assert.equal(label, `${"x".repeat(119)}…`);
    });

    it("counts code points, not UTF-16 units", async (t) => {
      const label = await labelOf(t, "😀".repeat(300));
      assert.equal(points(label), 120);
      assert.equal(label, `${"😀".repeat(119)}…`);
    });

    it("keeps a description of exactly 120 code points, and clips one of 121", async (t) => {
      assert.equal(await labelOf(t, "y".repeat(120)), "y".repeat(120));
      assert.equal(await labelOf(t, "y".repeat(121)), `${"y".repeat(119)}…`);
    });

    it("collapses runs of whitespace to one space and trims the ends", async (t) => {
      assert.equal(await labelOf(t, "  Lane   1:\t\tAPI\n\n  routes  "), "Lane 1: API routes");
    });

    it("an agent_type of 150 characters becomes a role of 100 code points", async (t) => {
      const role = await roleOf(t, "r".repeat(150));
      assert.equal(points(role), 100);
      assert.ok(role.startsWith("r".repeat(99)));
    });

    it("keeps a role of exactly 100 code points", async (t) => {
      assert.equal(await roleOf(t, "q".repeat(100)), "q".repeat(100));
    });
  });

  describe("the hook never blocks work", () => {
    it("returns at once while Supabase is slow: the flush runs detached", async (t) => {
      const { fake, h } = await setup(t);
      fake.mode("delay:4000");
      const r = await hook(h, start("a1"));
      quiet(r);
      assert.ok(r.ms < 2000, `took ${r.ms} ms`);
      await until(() => fake.requests.length >= 1, { ms: 5000, what: "the background flusher's first request" });
      assert.equal(h.eventFiles().length, 1, "the event stays until its writes succeed");
    });

    it("exits 0 quietly when Supabase is down, and the event waits", async (t) => {
      const { fake, h } = await setup(t);
      fake.mode("down");
      quiet(await hook(h, start("a1")));
      await sleep(400);
      assert.equal(h.eventFiles().length, 1);
      fake.mode("ok");
      quiet(await hook(h, ended()));
      await drained(h);
      assert.equal(agentWrites(fake).length, 1);
    });
  });

  describe("usage", () => {
    it("--help prints the commands and exits 0", async (t) => {
      const { h } = await setup(t);
      for (const flag of ["--help", "-h"]) {
        const r = await log(h, [flag]);
        assert.equal(r.code, 0, r.stderr);
        for (const word of ["hook", "flush", "status"]) assert.ok(r.stdout.includes(word), `${flag} names ${word}`);
      }
    });

    it("no command and an unknown command exit 2 with the usage on stderr", async (t) => {
      const { h } = await setup(t);
      for (const args of [[], ["publish"]]) {
        const r = await log(h, args);
        assert.equal(r.code, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
        assert.ok(r.stderr.includes("flush"), r.stderr);
      }
    });

    it("uses the harness the script lives in when HARNESS_DIR is not set, also through a symlink", async () => {
      const installed = s.dir("installed");
      fs.mkdirSync(path.join(installed, "bin"));
      fs.copyFileSync(SESSION_LOG, path.join(installed, "bin", "session-log"));
      fs.chmodSync(path.join(installed, "bin", "session-log"), 0o755);
      fs.writeFileSync(path.join(installed, ".env"), "TYPESAFE_API_KEY=\n");
      const link = path.join(s.root, "session-log-link");
      fs.symlinkSync(installed, link);
      const r = await run(path.join(link, "bin", "session-log"), ["hook"], { env: s.env(), cwd: s.root, input: JSON.stringify(start("a1")) });
      seen.push(r.stdout, r.stderr);
      quiet(r);
      const outbox = path.join(installed, "logs", "session-outbox");
      assert.equal(fs.readdirSync(outbox).filter((name) => EVENT_NAME.test(name)).length, 1);
      const printed = await run(path.join(link, "bin", "session-log"), ["status"], { env: s.env(), cwd: s.root });
      assert.equal(printed.stdout, "supabase: missing COCKPIT_SUPABASE_URL, COCKPIT_SUPABASE_SECRET_KEY\nwaiting: 1\nrejected: 0\n");
    });
  });

  describe("no secret leaks", () => {
    it("no stdout or stderr of any command above holds the secret, and no file in a scratch outbox does", () => {
      assert.ok(seen.length > 0, "no outputs were recorded");
      for (const text of seen) assert.ok(!text.includes(SECRET), "a command printed the secret");
      const stack = [...harnesses.map((h) => h.outboxDir)];
      let files = 0;
      while (stack.length) {
        const dir = stack.pop();
        let entries = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {}
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else {
            files++;
            let text = "";
            try {
              text = fs.readFileSync(full, "utf8");
            } catch {}
            assert.ok(!text.includes(SECRET), `${full} holds the secret`);
          }
        }
      }
      assert.ok(files > 0);
    });
  });
});
