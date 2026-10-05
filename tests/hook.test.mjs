// H-C: hooks/decide-context.sh (plan D4). The payloads are the ones Claude Code sends for a typed /solve
// (UserPromptExpansion) and for the Skill tool (PreToolUse); the hook runs bin/decide start against a scratch
// HARNESS_DIR and a fake Jev.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { startFakeJev } from "./fake-jev.mjs";
import { HOOK, makeHarness, makeUiRepo, run, scratch } from "./helpers.mjs";

const SMALL_STAGES = "Level: small (override, first-word). Stages: plan off, implement self, test off, verify ui, design off, review off, fix rounds 1.";
const hasKey = (value, key) =>
  value !== null && typeof value === "object" && Object.entries(value).some(([k, v]) => k === key || hasKey(v, key));

describe("H-C hooks/decide-context.sh", () => {
  const s = scratch("harness-hook-");
  let fake;
  let acme;

  before(async () => {
    fake = await startFakeJev();
    acme = makeUiRepo(s, "acme");
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

    it("logs the decision the hook made", async () => {
      const h = fresh();
      await hook(typed("small fix the readme typo"), { h });
      const entries = h.log();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].source, "override");
      assert.equal(entries[0].repo, "acme");
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
      const r = await hook(viaSkill("medium add a page"), { h });
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.ok(!hasKey(out, "permissionDecision"), r.stdout);
      assert.ok(!r.stdout.includes("permissionDecision"), r.stdout);
      const context = out.hookSpecificOutput.additionalContext;
      assert.ok(context.startsWith("Harness decision for this solve"), context);
      assert.ok(context.includes("Level: medium (override, first-word)"), context);
      assert.equal(fake.requests.length, 0);
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
      silent(await hook(viaSkill("small fix the readme typo", { agent_id: "a1", agent_type: "tester" }), { h }), "agent_id on a Skill call");
      assert.deepEqual(h.logLines(), []);
    });

    it("no node on the PATH", async () => {
      const h = fresh();
      const bin = path.join(s.root, "nonode-bin");
      fs.mkdirSync(bin, { recursive: true });
      for (const tool of ["jq", "cat"]) fs.symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), path.join(bin, tool));
      assert.equal(execFileSync("/bin/sh", ["-c", "command -v node || true"], { encoding: "utf8", env: { PATH: bin } }).trim(), "", "node must not be on this PATH");
      silent(await hook(typed("small fix the readme typo"), { h, env: { PATH: bin } }), "no node");
      assert.deepEqual(h.logLines(), []);
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
