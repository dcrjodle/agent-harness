// H-E: setup.sh wires the hooks (plan D6, sessions plan S5). It runs from a copy of the harness under a scratch
// HOME, so the real ~/.claude, ~/.codex and ~/.agent-harness are never touched and this checkout stays clean.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { EVENT_NAME, REPO, canonical, readJson, run, scratch } from "./helpers.mjs";

const GUARD_MATCHER = "Bash|Agent|Task|Read|Grep|Edit|Write|mcp__.*";
const HARNESS_HOOK = ".agent-harness/hooks/";
const HOOK_KEYS = ["type", "command", "timeout"];
const EXECUTABLES = ["bin/decide", "bin/session-log", "hooks/decide-context.sh", "hooks/guard.sh", "hooks/session-log.sh"];

describe("H-E setup.sh", () => {
  const s = scratch("harness-setup-");
  let copy;
  let home;
  let claudeFile;
  let codexFile;
  const initial = {
    theme: "dark",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo foreign-pretool" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo foreign-prompt", timeout: 5 }] }],
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo foreign-post" }] }],
    },
  };

  const setup = () => run("bash", [path.join(copy, "setup.sh")], { env: s.env(), cwd: s.root });
  const hookObjects = (cfg) => Object.values(cfg.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));
  const harnessEntries = (cfg, event, script) =>
    (cfg.hooks[event] || []).filter((g) => g.hooks.some((h) => (h.command || "").includes(HARNESS_HOOK) && (!script || h.command.includes(script))));

  before(() => {
    copy = path.join(s.root, "harness");
    const skip = new Set([".git", "node_modules", "logs", ".env", "MACHINE.md", "tests"].map((name) => path.join(REPO, name)));
    skip.add(path.join(REPO, "cache", "recipes"));
    fs.cpSync(REPO, copy, { recursive: true, filter: (src) => !skip.has(src) });
    for (const file of EXECUTABLES) fs.chmodSync(path.join(copy, file), 0o644);
    home = s.home;
    claudeFile = path.join(home, ".claude", "settings.json");
    codexFile = path.join(home, ".codex", "hooks.json");
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    fs.writeFileSync(claudeFile, canonical(initial));
  });
  after(() => s.remove());

  describe("E1 two runs over a settings.json with a foreign hook", () => {
    let afterFirst;
    let afterSecond;
    let cfg;

    before(async () => {
      const first = await setup();
      assert.equal(first.code, 0, `${first.stdout}${first.stderr}`);
      afterFirst = { claude: fs.readFileSync(claudeFile, "utf8"), codex: fs.readFileSync(codexFile, "utf8") };
      const second = await setup();
      assert.equal(second.code, 0, `${second.stdout}${second.stderr}`);
      afterSecond = { claude: fs.readFileSync(claudeFile, "utf8"), codex: fs.readFileSync(codexFile, "utf8") };
      cfg = JSON.parse(afterSecond.claude);
    });

    it("SessionStart has one harness entry", () => {
      const entries = harnessEntries(cfg, "SessionStart", "session-context.sh");
      assert.equal(entries.length, 1);
      assert.equal(harnessEntries(cfg, "SessionStart").length, 1);
    });

    it("PreToolUse keeps the foreign entry and has one guard and one decide-context entry", () => {
      assert.deepEqual(cfg.hooks.PreToolUse[0], initial.hooks.PreToolUse[0]);
      const guard = harnessEntries(cfg, "PreToolUse", "hooks/guard.sh");
      assert.equal(guard.length, 1);
      assert.equal(guard[0].matcher, GUARD_MATCHER);
      const decide = harnessEntries(cfg, "PreToolUse", "hooks/decide-context.sh");
      assert.equal(decide.length, 1);
      assert.equal(decide[0].matcher, "Skill");
      assert.equal(decide[0].hooks.length, 1);
      assert.equal(decide[0].hooks[0].timeout, 30);
      assert.equal(harnessEntries(cfg, "PreToolUse").length, 2);
    });

    it("UserPromptExpansion has one entry: matcher solve, timeout 30", () => {
      assert.equal(cfg.hooks.UserPromptExpansion.length, 1);
      const [entry] = cfg.hooks.UserPromptExpansion;
      assert.equal(entry.matcher, "solve");
      assert.equal(entry.hooks.length, 1);
      assert.ok(entry.hooks[0].command.includes("hooks/decide-context.sh"));
      assert.equal(entry.hooks[0].timeout, 30);
    });

    it("SubagentStart, SubagentStop and PostToolUse (Agent) each have one session-log entry, timeout 10", () => {
      for (const event of ["SubagentStart", "SubagentStop", "PostToolUse"]) {
        const entries = harnessEntries(cfg, event, "hooks/session-log.sh");
        assert.equal(entries.length, 1, event);
        assert.equal(harnessEntries(cfg, event).length, 1, event);
        assert.equal(entries[0].hooks.length, 1, event);
        assert.equal(entries[0].hooks[0].timeout, 10, event);
      }
      assert.equal(harnessEntries(cfg, "PostToolUse", "hooks/session-log.sh")[0].matcher, "Agent");
      for (const event of ["SubagentStart", "SubagentStop"]) assert.ok(!("matcher" in harnessEntries(cfg, event)[0]), `${event} has no matcher`);
    });

    it("SessionEnd has one session-log entry, timeout 5", () => {
      const entries = harnessEntries(cfg, "SessionEnd", "hooks/session-log.sh");
      assert.equal(entries.length, 1);
      assert.equal(harnessEntries(cfg, "SessionEnd").length, 1);
      assert.equal(entries[0].hooks.length, 1);
      assert.equal(entries[0].hooks[0].timeout, 5);
    });

    it("keeps the foreign PostToolUse entry, in front of the harness's", () => {
      assert.deepEqual(cfg.hooks.PostToolUse[0], initial.hooks.PostToolUse[0]);
      assert.equal(cfg.hooks.PostToolUse.length, 2);
    });

    it("no command mentions stage-log any more", () => {
      for (const hook of hookObjects(cfg)) assert.ok(!hook.command.includes("stage-log"), hook.command);
      assert.ok(!afterSecond.claude.includes("stage-log"));
    });

    it("has no duplicates: eight harness hooks in all", () => {
      const commands = hookObjects(cfg).map((h) => h.command).filter((c) => c.includes(HARNESS_HOOK));
      assert.equal(commands.length, 8, commands.join("\n"));
    });

    it("hook objects carry only type, command and timeout", () => {
      for (const hook of hookObjects(cfg)) {
        assert.ok(Object.keys(hook).every((key) => HOOK_KEYS.includes(key)), JSON.stringify(hook));
        assert.equal(hook.type, "command");
      }
    });

    it("leaves everything that is not the harness's alone", () => {
      assert.equal(cfg.theme, "dark");
      assert.deepEqual(cfg.hooks.UserPromptSubmit, initial.hooks.UserPromptSubmit);
    });

    it("a second run changes nothing", () => {
      assert.equal(afterSecond.claude, afterFirst.claude);
      assert.equal(afterSecond.codex, afterFirst.codex);
    });

    it("backs the original up once, and keeps that backup", () => {
      assert.deepEqual(readJson(`${claudeFile}.pre-harness`), initial);
    });

    it("Codex gets the guard and the session context, and no decide-context, UserPromptExpansion or session-log", () => {
      assert.ok(!afterSecond.codex.includes("decide-context"));
      assert.ok(!afterSecond.codex.includes("session-log"));
      assert.ok(!afterSecond.codex.includes("stage-log"));
      const codex = JSON.parse(afterSecond.codex);
      assert.deepEqual(Object.keys(codex.hooks).sort(), ["PreToolUse", "SessionStart"]);
      assert.equal(codex.hooks.PreToolUse.length, 1);
      assert.ok(!("matcher" in codex.hooks.PreToolUse[0]));
      assert.ok(codex.hooks.PreToolUse[0].hooks[0].command.includes("hooks/guard.sh"));
      for (const hook of hookObjects(codex)) assert.ok(Object.keys(hook).every((key) => HOOK_KEYS.includes(key)), JSON.stringify(hook));
    });

    it("makes the scripts executable (bin/session-log and hooks/session-log.sh too), and they are executable in this checkout too", () => {
      for (const file of EXECUTABLES) {
        assert.ok(fs.statSync(path.join(copy, file)).mode & 0o111, `setup left ${file} not executable`);
        fs.accessSync(path.join(REPO, file), fs.constants.X_OK);
      }
    });

    it("stage-log and stage-times are gone from the copy", () => {
      assert.equal(fs.existsSync(path.join(copy, "hooks", "stage-log.sh")), false);
      assert.equal(fs.existsSync(path.join(copy, "bin", "stage-times")), false);
    });

    it("creates .env from .env.example with one empty line for each of the three keys", () => {
      const lines = fs.readFileSync(path.join(copy, ".env"), "utf8").split("\n");
      for (const key of ["TYPESAFE_API_KEY", "COCKPIT_SUPABASE_URL", "COCKPIT_SUPABASE_SECRET_KEY"]) {
        assert.equal(lines.filter((line) => line === `${key}=`).length, 1, key);
      }
    });

    it("links the harness into the scratch HOME only", () => {
      assert.equal(fs.realpathSync(path.join(home, ".agent-harness")), fs.realpathSync(copy));
    });

    describe("the commands setup registered work from the scratch HOME", () => {
      const commandOf = (entry) => entry.hooks[0].command;
      const runRegistered = (command, payload) => run("sh", ["-c", command], { input: JSON.stringify(payload), env: s.env(), cwd: s.root });

      it("the UserPromptExpansion command adds the decision to the context", async () => {
        const r = await runRegistered(commandOf(cfg.hooks.UserPromptExpansion[0]), {
          hook_event_name: "UserPromptExpansion",
          command_name: "solve",
          command_args: "small fix the readme typo",
          cwd: s.root,
        });
        assert.equal(r.code, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptExpansion");
        assert.ok(out.hookSpecificOutput.additionalContext.includes("Level: small (override, first-word)"));
      });

      it("the Skill command adds the decision to the context", async () => {
        const [entry] = harnessEntries(cfg, "PreToolUse", "decide-context.sh");
        const r = await runRegistered(commandOf(entry), {
          hook_event_name: "PreToolUse",
          tool_name: "Skill",
          tool_input: { skill: "solve", args: "medium add a page" },
          cwd: s.root,
        });
        assert.equal(r.code, 0, r.stderr);
        assert.ok(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes("Level: medium (override, first-word)"));
      });

      it("the guard command still guards", async () => {
        const [entry] = harnessEntries(cfg, "PreToolUse", "hooks/guard.sh");
        const denied = await runRegistered(commandOf(entry), { tool_name: "Bash", cwd: s.root, tool_input: { command: "git push --force origin x" } });
        assert.equal(denied.code, 2, denied.stderr);
        assert.match(denied.stderr, /force-push/);
        const allowed = await runRegistered(commandOf(entry), { tool_name: "Bash", cwd: s.root, tool_input: { command: "ls" } });
        assert.equal(allowed.code, 0, allowed.stderr);
      });

      it("the session-log commands queue the session's events in the harness they live in, silently", async () => {
        const outbox = path.join(copy, "logs", "session-outbox");
        const payloads = {
          SubagentStart: { hook_event_name: "SubagentStart", session_id: "s1", agent_id: "a1", agent_type: "implementer", cwd: s.root },
          PostToolUse: { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Agent", tool_input: { description: "Lane 1" }, tool_response: { agentId: "a1" }, cwd: s.root },
          SubagentStop: { hook_event_name: "SubagentStop", session_id: "s1", agent_id: "a1", agent_type: "implementer", cwd: s.root },
          SessionEnd: { hook_event_name: "SessionEnd", session_id: "s1", cwd: s.root },
        };
        for (const [event, payload] of Object.entries(payloads)) {
          const [entry] = harnessEntries(cfg, event, "hooks/session-log.sh");
          const r = await runRegistered(commandOf(entry), payload);
          assert.equal(r.code, 0, `${event}: ${r.stderr}`);
          assert.equal(r.stdout, "", event);
          assert.equal(r.stderr, "", event);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const files = fs.readdirSync(outbox).filter((name) => EVENT_NAME.test(name)).sort();
        assert.deepEqual(
          files.map((name) => readJson(path.join(outbox, name)).kind),
          ["agent_start", "agent_label", "agent_stop", "session_end"],
        );
      });

      it("a registered command whose script is missing does nothing and exits 0", async () => {
        const r = await run("sh", ["-c", commandOf(cfg.hooks.UserPromptExpansion[0])], {
          input: "{}",
          env: s.env({ HOME: path.join(s.root, "no-such-home") }),
          cwd: s.root,
        });
        assert.equal(r.code, 0);
        assert.equal(r.stdout, "");
      });
    });
  });

  describe("an install from before this change is upgraded in place", () => {
    it("replaces the old harness entries, keeps foreign hooks, even inside a shared group", async () => {
      const upgradeHome = s.dir("home-upgrade");
      const old = (script) => ({ type: "command", command: `f="$HOME/.agent-harness/hooks/${script}"; [ -x "$f" ] || exit 0; exec "$f"` });
      const foreign = { type: "command", command: "echo foreign" };
      const oldInstall = {
        hooks: {
          SessionStart: [{ hooks: [old("session-context.sh")] }],
          PreToolUse: [
            { matcher: "Bash", hooks: [foreign, old("guard.sh")] },
            { matcher: GUARD_MATCHER, hooks: [old("guard.sh")] },
          ],
          SubagentStart: [{ hooks: [old("stage-log.sh")] }],
          SubagentStop: [{ hooks: [old("stage-log.sh")] }],
        },
      };
      fs.mkdirSync(path.join(upgradeHome, ".claude"), { recursive: true });
      const file = path.join(upgradeHome, ".claude", "settings.json");
      fs.writeFileSync(file, canonical(oldInstall));
      const r = await run("bash", [path.join(copy, "setup.sh")], { env: s.env({ HOME: upgradeHome }), cwd: s.root });
      assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
      const cfg = readJson(file);
      assert.deepEqual(cfg.hooks.PreToolUse[0], { matcher: "Bash", hooks: [foreign] });
      assert.equal(harnessEntries(cfg, "PreToolUse", "hooks/guard.sh").length, 1);
      assert.equal(harnessEntries(cfg, "PreToolUse", "hooks/decide-context.sh").length, 1);
      assert.equal(harnessEntries(cfg, "UserPromptExpansion").length, 1);
      assert.equal(harnessEntries(cfg, "SessionStart").length, 1);
      for (const event of ["SubagentStart", "SubagentStop", "SessionEnd"]) {
        assert.equal(harnessEntries(cfg, event).length, 1, event);
        assert.equal(harnessEntries(cfg, event, "hooks/session-log.sh").length, 1, `${event}: the stage-log entry is replaced by a session-log entry`);
      }
      assert.equal(harnessEntries(cfg, "PostToolUse", "hooks/session-log.sh").length, 1);
      assert.ok(!JSON.stringify(cfg).includes("stage-log"), "no stage-log entry is left");
      assert.equal(hookObjects(cfg).filter((h) => h.command.includes(HARNESS_HOOK)).length, 8);
    });
  });
});
