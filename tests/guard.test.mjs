// H-D: hooks/guard.sh and bin/decide (plan D5). Each case pipes a PreToolUse payload to the guard; a deny is
// exit 2 with the reason on stderr, an allow is exit 0. cwd is a scratch repo on a task branch, so commit
// probes do not hit the default-branch deny.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GUARD, makeRepo, run, scratch } from "./helpers.mjs";

describe("H-D hooks/guard.sh", () => {
  const s = scratch("harness-guard-");
  let task;
  let main;

  before(() => {
    task = makeRepo(s, "proj", { branch: "feat/x" });
    main = makeRepo(s, "projmain", { branch: "main" });
  });
  after(() => s.remove());

  const guard = (command, { agent = false, role = "tester", tool = "Bash", cwd, input } = {}) => {
    const payload = { tool_name: tool, cwd: cwd ?? task, tool_input: input ?? { command } };
    if (agent) Object.assign(payload, { agent_id: "agent-1", agent_type: role });
    return run("bash", [GUARD], { input: JSON.stringify(payload), env: s.env(), cwd: s.root });
  };
  const allowed = (r, command) => {
    assert.equal(r.code, 0, `denied: ${command}\n${r.stderr}`);
  };
  const denied = (r, command, reason) => {
    assert.equal(r.code, 2, `not denied (exit ${r.code}): ${command}\n${r.stderr}`);
    assert.ok(r.stderr.startsWith("harness guard: "), r.stderr);
    if (reason) assert.match(r.stderr, reason, command);
  };

  // [name, command, allowed or the reason pattern of the deny]
  const table = (rows, opts) => {
    for (const [name, command, expected] of rows) {
      it(`${expected === true ? "allows" : "denies"}: ${name}`, async () => {
        const r = await guard(command, opts);
        if (expected === true) allowed(r, command);
        else denied(r, command, expected);
      });
    }
  };

  describe("D1 who may run bin/decide", { concurrency: 8 }, () => {
    describe("the main agent", { concurrency: 8 }, () => {
      table([
        ["bin/decide level", '~/.agent-harness/bin/decide level -- "x"', true],
        ["bin/decide start, recipe and ui", "~/.agent-harness/bin/decide start -- x && bin/decide recipe -- x && bin/decide ui .", true],
        ["a variable in front", 'FOO=1 bin/decide level -- "x"', true],
        ["node in front", "node ~/.agent-harness/bin/decide ui .", true],
        ["after cd", "cd /repo && ~/.agent-harness/bin/decide start -- x", true],
        ["stages and check", "bin/decide stages large; bin/decide check", true],
        ["an unknown decision point", "bin/decide size x", /unknown decision point/],
        ["an unknown decision point after a good one", "bin/decide level -- x; bin/decide size y", /unknown decision point/],
      ]);
    });

    describe("a sub-agent", { concurrency: 8 }, () => {
      table(
        [
          ["start", "~/.agent-harness/bin/decide start -- x", /orchestrator/],
          ["level", 'bin/decide level -- "x"', /orchestrator/],
          ["recipe", "bin/decide recipe -- x", /orchestrator/],
          ["ui", "bin/decide ui .", /orchestrator/],
          ["a variable in front", "FOO=1 ~/.agent-harness/bin/decide level -- x", /orchestrator/],
          ["node in front", "node ~/.agent-harness/bin/decide level -- x", /orchestrator/],
          ["after cd and &&", "cd /repo && bin/decide start -- x", /orchestrator/],
          ["after a semicolon", "echo hi; bin/decide ui .", /orchestrator/],
          ["inside a subshell", "(bin/decide level -- x)", /orchestrator/],
          ["only HARNESS_DIR set", "HARNESS_DIR=/tmp/h bin/decide level -- x", /orchestrator/],
          ["only a loopback TYPESAFE_BASE_URL set", "TYPESAFE_BASE_URL=http://127.0.0.1:9999 bin/decide level -- x", /orchestrator/],
          ["a scratch HARNESS_DIR with the real API URL", "HARNESS_DIR=/tmp/h TYPESAFE_BASE_URL=https://api.typesafe.ai bin/decide level -- x", /orchestrator/],
          ["a scratch HARNESS_DIR with a remote URL", "HARNESS_DIR=/tmp/h TYPESAFE_BASE_URL=http://example.com:9999 bin/decide level -- x", /orchestrator/],
          ["the scratch variables set for another command", "HARNESS_DIR=/tmp/h TYPESAFE_BASE_URL=http://127.0.0.1:9 true && bin/decide level -- x", /orchestrator/],
          ["an unknown decision point, even against a scratch harness", "HARNESS_DIR=/tmp/h TYPESAFE_BASE_URL=http://127.0.0.1:9 bin/decide size x", /unknown decision point/],
          ["HARNESS_DIR and a loopback TYPESAFE_BASE_URL set for decide itself", "HARNESS_DIR=/tmp/h TYPESAFE_BASE_URL=http://127.0.0.1:9999 bin/decide level -- x", true],
          ["a scratch harness with localhost", "HARNESS_DIR=/tmp/h TYPESAFE_BASE_URL=http://localhost:8080 bin/decide start -- x", true],
          ["a scratch harness with node in front", "HARNESS_DIR=/tmp/h TYPESAFE_BASE_URL=http://127.0.0.1:9 node bin/decide ui /tmp/wt", true],
          ["stages", "bin/decide stages large", true],
          ["stages --json", "~/.agent-harness/bin/decide stages --json small", true],
          ["check", "bin/decide check", true],
          ["check of a file", "bin/decide check /tmp/mut.json", true],
          ["bin/decide with no point", "bin/decide", true],
          ["bin/decide --help", "bin/decide --help", true],
          ["bin/decide -h", "bin/decide -h", true],
          ["a syntax check of the script", "node --check bin/decide", true],
        ],
        { agent: true },
      );
    });
  });

  describe("D2 no false positives", { concurrency: 8 }, () => {
    const mentions = [
      ["a commit message", 'git commit -m "feat: add bin/decide level points"', true],
      ["an echo", 'echo "run bin/decide later"', true],
      ["a grep", 'grep -rn "bin/decide" skills/', true],
      ["a pipe into grep", "cat README.md | grep bin/decide", true],
      ["ls", "ls ~/.agent-harness/bin/decide", true],
      ["chmod", "chmod +x bin/decide", true],
      ["a heredoc commit message", "git commit -m \"$(cat <<'EOF'\ntest: cover bin/decide\n\nbin/decide ui runs once per task\nEOF\n)\"", true],
      ["a heredoc into a file", "cat > notes.md <<'EOF'\nrun bin/decide level -- x first\nEOF", true],
    ];
    describe("the main agent", { concurrency: 8 }, () => table(mentions));
    describe("a sub-agent", { concurrency: 8 }, () => table(mentions, { agent: true }));
  });

  describe("D3 the harness key and a project's own Jev use", { concurrency: 8 }, () => {
    const rows = [
      ["sourcing the harness .env for a Jev call", "source ~/.agent-harness/.env && curl -s https://api.typesafe.ai/v1/systemone", /only for bin\/decide/],
      ["echoing the harness key", "source ~/.agent-harness/.env && echo $TYPESAFE_API_KEY", /only for bin\/decide/],
      ["a project tuning script with its own .env", "node --env-file=.env scripts/jev-tune.ts", true],
      ["a call with a key from the environment", 'curl https://api.typesafe.ai/v1/systemone -H "Authorization: Bearer $TYPESAFE_API_KEY"', true],
      ["the harness .env sourced for something else", "source ~/.agent-harness/.env && node scripts/tune.mjs", true],
      ["the key's name in .env.example", "grep TYPESAFE_API_KEY ~/.agent-harness/.env.example", true],
    ];
    describe("the main agent", { concurrency: 8 }, () => table(rows));
    describe("a sub-agent", { concurrency: 8 }, () => table(rows, { agent: true }));
  });

  describe("the rules that were there before still hold", { concurrency: 8 }, () => {
    it("denies a force-push", async () => {
      denied(await guard("git push --force origin feat/x"), "git push --force", /force-push/);
    });
    it("denies a push to the default branch", async () => {
      denied(await guard("git push origin main"), "git push origin main", /default branch/);
    });
    it("denies a commit on the default branch", async () => {
      denied(await guard('git commit -m "x"', { cwd: main }), "git commit on main", /you're on 'main'/);
    });
    it("allows a commit on a task branch", async () => {
      allowed(await guard('git commit -m "feat: x"'), "git commit on feat/x");
    });
    it("denies reading .env with a shell reader", async () => {
      denied(await guard("cat .env"), "cat .env", /don't read \.env/);
    });
    it("denies reading .env with the Read tool", async () => {
      denied(await guard("", { tool: "Read", input: { file_path: "/home/u/.agent-harness/.env" } }), "Read .env", /don't read \.env/);
    });
    it("denies a sub-agent spawning a sub-agent", async () => {
      denied(await guard("", { tool: "Agent", agent: true, input: { prompt: "x" } }), "Agent from a sub-agent", /sub-agents must not spawn/);
    });
    it("denies an implementer writing a test file", async () => {
      denied(await guard("", { tool: "Write", agent: true, role: "implementer", input: { file_path: "/w/src/page.test.ts" } }), "implementer Write test", /implementers don't write tests/);
    });
  });
});
