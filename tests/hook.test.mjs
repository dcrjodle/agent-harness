// H-C: hooks/decide-context.sh (plan D4) and hooks/session-log.sh (sessions plan S5). The payloads are the ones
// Claude Code sends for a typed /solve (UserPromptExpansion), for the Skill tool (PreToolUse) and for the
// sub-agent and session events; the hooks run against a scratch HARNESS_DIR, a fake Jev and a fake Supabase.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { startFakeJev } from "./fake-jev.mjs";
import { startFakeSupabase } from "./fake-supabase.mjs";
import { EVENT_NAME, HOOK, SECRET, SESSION_HOOK, drained, makeHarness, makeUiRepo, run, scratch, supabaseEnv } from "./helpers.mjs";

const SMALL_STAGES = "Level: small (override, first-word). Stages: plan off, implement self, test off, verify ui, design off, review off, fix rounds 1.";
const hasKey = (value, key) =>
  value !== null && typeof value === "object" && Object.entries(value).some(([k, v]) => k === key || hasKey(v, key));

describe("H-C hooks/decide-context.sh", () => {
  const s = scratch("harness-hook-");
  let fake;
  let acme;

  before(async () => {
    fake = await startFakeJev();
    acme = makeUiRepo(s, "acme", { origin: "git@github.com:o/acme.git" });
  });
  after(async () => {
    await fake.close();
    s.remove();
  });

  const fresh = (opts) => {
    fake.reset();
    return makeHarness(s, opts);
  };
  const hook = (payload, { h, env } = {}) =>
    run(HOOK, [], {
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      env: s.env({ HARNESS_DIR: h.dir, TYPESAFE_BASE_URL: fake.url, ...env }),
      cwd: s.root,
    });
  const typed = (args, extra = {}) => ({ hook_event_name: "UserPromptExpansion", command_name: "solve", command_args: args, cwd: acme, session_id: "s", ...extra });
  const viaSkill = (args, { skill = "solve", ...extra } = {}) => ({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill, args }, cwd: acme, ...extra });
  const silent = (r, why) => {
    assert.equal(r.code, 0, `${why}: exit ${r.code}, ${r.stderr}`);
    assert.equal(r.stdout, "", `${why}: stdout ${r.stdout}`);
  };

  describe("C1 a typed /solve", () => {
    it("adds the decision to the context as UserPromptExpansion additionalContext", async () => {
      const h = fresh();
      const r = await hook(typed("small fix the readme typo"), { h });
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
      assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptExpansion");
      const context = out.hookSpecificOutput.additionalContext;
      assert.ok(context.startsWith("Harness decision for this solve"), context);
      assert.ok(context.includes(SMALL_STAGES), context);
      assert.equal(fake.requests.length, 0);
      assert.equal(r.stdout.trim().split("\n").length, 1, "one line of JSON");
    });

    it("queues the session and the level decision for the payload's session, and writes no decision log", async () => {
      const h = fresh();
      const r = await hook(typed("small fix the readme typo", { session_id: "s11" }), { h });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.startsWith("Harness decision for this solve"), r.stdout);
      const [session, decided, ...more] = h.events();
      assert.deepEqual(more, []);
      assert.deepEqual([session.kind, decided.kind], ["session", "decision"]);
      assert.equal(session.session_id, "s11");
      assert.equal(session.level, "small");
      assert.equal(session.title, "fix the readme typo");
      assert.equal(session.repo, "o/acme");
      assert.deepEqual([decided.session_id, decided.point, decided.value, decided.source], ["s11", "level", "small", "override"]);
      assert.equal(fs.existsSync(h.logFile), false, "logs/decisions.jsonl is not written");
    });

    it("a payload without a session id still gets its context, and queues nothing", async () => {
      const h = fresh();
      const r = await hook(typed("small fix the readme typo", { session_id: undefined }), { h });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes("Level: small"), r.stdout);
      assert.equal(fs.existsSync(h.outboxDir), false);
    });

    it("with the session log on, the events reach Supabase without the hook waiting for them", async (t) => {
      const supabase = await startFakeSupabase();
      t.after(() => supabase.close());
      const h = fresh({ env: supabaseEnv(supabase.url) });
      const r = await hook(typed("small fix the readme typo", { session_id: "s11" }), { h });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.startsWith("Harness decision for this solve"), r.stdout);
      await drained(h);
      assert.equal(supabase.requests[0].method, "POST");
      assert.equal(supabase.requests[0].path, "/rest/v1/cockpit_sessions?on_conflict=id");
      assert.equal(supabase.requests[0].body.id, "s11");
      assert.equal(supabase.requests[0].body.title, "fix the readme typo");
      assert.equal(supabase.requests[0].body.level, "small");
      assert.ok(supabase.requests.some((q) => q.path.startsWith("/rest/v1/cockpit_decisions")));
      for (const q of supabase.requests) assert.equal(q.apikey, SECRET);
    });

    it("asks Jev for a task without a level word, and says what it got", async () => {
      const h = fresh();
      fake.answer("level", { small: 0.1, medium: 0.8, large: 0.1 });
      const r = await hook(typed("add a settings page"), { h });
      const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
      assert.ok(context.includes("Level: medium (jev, 0.70). Stages: plan off, implement self, test on, verify ui, design ui, review on, fix rounds 1."), context);
      assert.equal(fake.requests.length, 1);
    });

    it("finds the repo's recipes from the payload's cwd and names the recipe file", async () => {
      const h = fresh();
      const alpha = h.recipe("acme", "alpha", "# acme/alpha — deploys");
      h.recipe("acme", "beta", "# acme/beta — migrations");
      fake.answer("level", { small: 0.1, medium: 0.8, large: 0.1 });
      fake.answer("recipe", { none: 0.1, alpha: 0.8, beta: 0.1 });
      const r = await hook(typed("add a settings page"), { h });
      const lines = JSON.parse(r.stdout).hookSpecificOutput.additionalContext.split("\n");
      assert.equal(lines.length, 3);
      assert.equal(lines[2], `- Recipe: alpha (jev, 0.70): ${alpha}`);
    });
  });

  describe("C2 the Skill tool", () => {
    it("adds the decision as PreToolUse additionalContext and never decides a permission", async () => {
      const h = fresh();
      const r = await hook(viaSkill("medium add a page", { session_id: "s12" }), { h });
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.ok(!hasKey(out, "permissionDecision"), r.stdout);
      assert.ok(!r.stdout.includes("permissionDecision"), r.stdout);
      const context = out.hookSpecificOutput.additionalContext;
      assert.ok(context.startsWith("Harness decision for this solve"), context);
      assert.ok(context.includes("Level: medium (override, first-word)"), context);
      assert.equal(fake.requests.length, 0);
      assert.deepEqual(h.events().map((e) => [e.kind, e.session_id, e.level ?? e.point]), [["session", "s12", "medium"], ["decision", "s12", "level"]]);
    });
  });

  describe("C3 anything else stays silent, exit 0", () => {
    it("the Skill tool for another skill", async () => {
      silent(await hook(viaSkill("deploy notes", { skill: "recipe" }), { h: fresh() }), "skill recipe");
    });

    it("another slash command", async () => {
      silent(await hook(typed("small fix", { command_name: "plan" }), { h: fresh() }), "command plan");
    });

    it("another tool", async () => {
      silent(await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, cwd: acme }, { h: fresh() }), "Bash");
    });

    it("a sub-agent's payload, for both events", async () => {
      const h = fresh();
      silent(await hook(typed("small fix the readme typo", { agent_id: "a1", agent_type: "tester" }), { h }), "agent_id on a typed command");
      silent(await hook(viaSkill("small fix the readme typo", { agent_id: "a1", agent_type: "tester", session_id: "s11" }), { h }), "agent_id on a Skill call");
      assert.equal(fs.existsSync(h.outboxDir), false, "a sub-agent's payload queues nothing");
    });

    it("no node on the PATH", async () => {
      const h = fresh();
      const bin = path.join(s.root, "nonode-bin");
      fs.mkdirSync(bin, { recursive: true });
      for (const tool of ["jq", "cat"]) fs.symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), path.join(bin, tool));
      assert.equal(execFileSync("/bin/sh", ["-c", "command -v node || true"], { encoding: "utf8", env: { PATH: bin } }).trim(), "", "node must not be on this PATH");
      silent(await hook(typed("small fix the readme typo"), { h, env: { PATH: bin } }), "no node");
      assert.equal(fs.existsSync(h.outboxDir), false);
    });

    it("no jq on the PATH", async () => {
      const h = fresh();
      const bin = path.join(s.root, "nojq-bin");
      fs.mkdirSync(bin, { recursive: true });
      for (const tool of ["node", "cat"]) fs.symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), path.join(bin, tool));
      silent(await hook(typed("small fix the readme typo"), { h, env: { PATH: bin } }), "no jq");
    });

    it("an invalid settings.json", async () => {
      const h = fresh();
      h.edit((doc) => void (doc.version = 2));
      silent(await hook(typed("small fix the readme typo"), { h }), "invalid settings");
    });

    it("no settings.json at all", async () => {
      const h = fresh();
      fs.rmSync(h.settingsPath);
      silent(await hook(typed("small fix the readme typo"), { h }), "no settings");
    });

    it("an empty or unparsable payload", async () => {
      const h = fresh();
      silent(await hook("", { h }), "empty stdin");
      silent(await hook("this is not json", { h }), "not json");
      silent(await hook("{}", { h }), "empty object");
    });

    it("a /solve without a task", async () => {
      silent(await hook(typed(""), { h: fresh() }), "no task");
    });

    it("with Jev down, the context says the fallback and the hook is back within 6 s", async () => {
      const h = fresh();
      fake.mode("closed");
      const r = await hook(typed("add a settings page"), { h });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.ms < 6000, `took ${r.ms} ms`);
      const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
      assert.ok(context.includes("(fallback, network)"), context);
      assert.ok(context.includes("Level: medium"), context);
    });

    it("without a key, the context says the fallback", async () => {
      const h = fresh({ env: null });
      const r = await hook(typed("add a settings page"), { h });
      const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
      assert.ok(context.includes("(fallback, no-key)"), context);
      assert.equal(fake.requests.length, 0);
    });
  });
});

describe("H-C hooks/session-log.sh", () => {
  const s = scratch("harness-sessionhook-");
  let acme;

  before(() => {
    acme = makeUiRepo(s, "acme", { origin: "git@github.com:o/acme.git" });
  });
  after(() => s.remove());

  const started = () => ({
    hook_event_name: "SubagentStart",
    session_id: "s1",
    agent_id: "a1",
    agent_type: "implementer",
    cwd: acme,
    transcript_path: path.join(s.root, "t", "s1.jsonl"),
  });
  const hook = (payload, { h, env } = {}) =>
    run(SESSION_HOOK, [], { input: typeof payload === "string" ? payload : JSON.stringify(payload), env: s.env({ HARNESS_DIR: h.dir, ...env }), cwd: s.root });
  const silent = (r, why) => {
    assert.equal(r.code, 0, `${why}: exit ${r.code}, ${r.stderr}`);
    assert.equal(r.stdout, "", `${why}: stdout ${r.stdout}`);
    assert.equal(r.stderr, "", `${why}: stderr ${r.stderr}`);
  };

  describe("C3 without node it does nothing", () => {
    it("PATH=/usr/bin:/bin: exit 0, no output and no file", async () => {
      const h = makeHarness(s, { env: "" });
      const found = execFileSync("/bin/sh", ["-c", "command -v node || true"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).trim();
      assert.equal(found, "", "node must not be on /usr/bin:/bin for this check to mean anything");
      silent(await hook(started(), { h, env: { PATH: "/usr/bin:/bin" } }), "no node");
      assert.equal(fs.existsSync(h.outboxDir), false);
      assert.deepEqual(h.eventFiles(), []);
    });
  });

  describe("the hook with node on the PATH", () => {
    it("queues the event of the payload, silently", async () => {
      const h = makeHarness(s, { env: "" });
      const r = await hook(started(), { h });
      silent(r, "SubagentStart");
      assert.equal(h.eventFiles().length, 1);
      assert.match(h.eventFiles()[0], EVENT_NAME);
      const [event] = h.events();
      assert.deepEqual([event.kind, event.session_id, event.agent_id, event.role, event.repo], ["agent_start", "s1", "a1", "implementer", "o/acme"]);
    });

    it("queues nothing for a payload that is no session event, and says nothing", async () => {
      const h = makeHarness(s, { env: "" });
      for (const payload of [{ hook_event_name: "Stop", session_id: "s1", cwd: acme }, "not json", "", "{}"]) silent(await hook(payload, { h }), JSON.stringify(payload));
      assert.deepEqual(h.eventFiles(), []);
    });

    it("exits 0 quietly in a harness whose logs folder cannot be written", async () => {
      const h = makeHarness(s, { env: "" });
      fs.writeFileSync(path.join(h.dir, "logs"), "this is a file, not a directory");
      silent(await hook(started(), { h }), "unwritable logs");
    });
  });
});
