// H-D: hooks/guard.sh, bin/decide and bin/session-log (plan D5, sessions plan S7). Each case pipes a PreToolUse
// payload to the guard under /bin/bash (3.2 on a Mac, which the hooks use); a deny is exit 2 with the reason
// on stderr, an allow is exit 0. cwd is a scratch repo on a task branch, so commit probes do not hit the
// default-branch deny. $HOME is the scratch HOME: the guard never sees the real ~/.agent-harness.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { GUARD, REPO, makeRepo, run, scratch } from "./helpers.mjs";

describe("H-D hooks/guard.sh", () => {
  const s = scratch("harness-guard-");
  let task;
  let main;

  before(() => {
    task = makeRepo(s, "proj", { branch: "feat/x" });
    main = makeRepo(s, "projmain", { branch: "main" });
  });
  after(() => s.remove());

  const guard = (command, { agent = false, role = "tester", tool = "Bash", cwd, input, home } = {}) => {
    const payload = { tool_name: tool, cwd: cwd ?? task, tool_input: input ?? { command } };
    if (agent) Object.assign(payload, { agent_id: "agent-1", agent_type: role });
    return run("/bin/bash", [GUARD], { input: JSON.stringify(payload), env: s.env(home ? { HOME: home } : {}), cwd: s.root });
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

  // ---------- sessions round: the splitter's speed, the review cases, bin/session-log ----------

  describe("E1 a long command is read in time (/bin/bash 3.2)", () => {
    const BUDGET_MS = 2000;
    // Lines from templates until the text holds `bytes` bytes.
    const fill = (templates, bytes) => {
      const lines = [];
      let size = 0;
      for (let i = 0; size < bytes; i++) {
        const line = templates[i % templates.length](i);
        lines.push(line);
        size += line.length + 1;
      }
      return lines;
    };
    const timed = async (t, command, opts, expected = 0) => {
      const r = await guard(command, opts);
      t.diagnostic(`${Math.round(command.length / 1000)} KB took ${r.ms} ms`);
      assert.equal(r.code, expected, `exit ${r.code}: ${r.stderr}`);
      assert.ok(r.ms <= BUDGET_MS, `took ${r.ms} ms, the budget is ${BUDGET_MS} ms`);
    };

    it("(a) 6,000 ; segments of `echo N .env`", async (t) => {
      await timed(t, Array.from({ length: 6000 }, (_, i) => `echo ${i} .env`).join("; "));
    });

    it("(b) a 500 KB quoted heredoc full of quotes, substitutions, separators and bin/decide, from a sub-agent", async (t) => {
      const body = fill(
        [
          (i) => `echo "line ${i}: a double-quoted $(printf %s nested) string"; echo 'single ${i}' && ls | wc -l`,
          (i) => `bin/decide level x # ${i}`,
          (i) => `result=\`date +%s\`; echo "$result" | tr ';&|' '   ' # ${i}`,
          (i) => `if [ -n "$HOME" ]; then bin/decide start -- "task ${i}"; fi & wait`,
          (i) => `printf '%s\\n' "it's ${i}" 'say "hi"' | cat`,
          (i) => `run \`bin/decide ui .\` then "bin/decide recipe z" and 'bin/decide start y' ${i}`,
        ],
        500_000,
      );
      await timed(t, `cat > notes.md <<'EOF'\n${body.join("\n")}\nEOF\n`, { agent: true });
    });

    it("(c) a 100 KB double-quoted git commit -m with 2,000 $HOME and escaped backticks, on a feature branch", async (t) => {
      const lines = Array.from({ length: 2000 }, (_, i) => `note ${i}: $HOME is set; see \\\`ls\\\` and \\\`pwd\\\` output here`);
      const message = `feat: a long message\n${lines.join("\n")}`;
      assert.ok(message.length >= 100_000, `only ${message.length} bytes`);
      await timed(t, `git commit -m "${message}"`);
    });

    it("(d) a 335 KB plain heredoc naming bin/decide on every line", async (t) => {
      const body = fill([(i) => `line ${i}: run bin/decide level -- x first`], 335_000);
      await timed(t, `cat > notes.md <<EOF\n${body.join("\n")}\nEOF\n`);
    });

    it("a long command that really calls bin/decide is still denied for a sub-agent, in time", async (t) => {
      const filler = Array.from({ length: 4000 }, (_, i) => `echo ${i} .env`).join("; ");
      await timed(t, `${filler}; bin/decide level -- x`, { agent: true }, 2);
    });
  });

  describe("E2 the review cases", () => {
    describe("the main agent", { concurrency: 8 }, () => {
      table([
        ["a commit message with bin/decide at the start of a later line", 'git commit -m "feat: x\nbin/decide prints one line"', true],
        ["a PR body with bin/decide at the start of a later line", 'gh pr create --body "what changed\nbin/decide start is documented"', true],
        ["a heredoc README naming the harness .env and the key", "cat > README.md <<'EOF'\nKeys live in ~/.agent-harness/.env, for example TYPESAFE_API_KEY.\nEOF", true],
        ["a commit message naming the harness .env and the key", 'git commit -m "docs: ~/.agent-harness/.env holds TYPESAFE_API_KEY"', true],
        ["loading the harness .env and calling Jev", "cd ~/.agent-harness && source .env && curl https://api.typesafe.ai/v1/systemone", /only for bin\/decide and bin\/session-log/],
      ]);
    });

    describe("a sub-agent", { concurrency: 8 }, () => {
      table(
        [
          ["a commit message with bin/decide start at the start of a later line", 'git commit -m "x\nbin/decide start soon"', true],
          ["a multi-line double-quoted string with bin/decide level on a later line", 'echo "first line\nbin/decide level x"', true],
          ["timeout in front", "timeout 10 bin/decide level x", /orchestrator/],
          ["bash -c", "bash -c 'bin/decide level x'", /orchestrator/],
          ["sh -c with double quotes", 'sh -c "bin/decide start -- x"', /orchestrator/],
          ["eval", "eval 'bin/decide ui .'", /orchestrator/],
          ["a << inside quotes does not open a heredoc", 'echo "a<<b"; bin/decide level x', /orchestrator/],
          ["the real harness as HARNESS_DIR", "HARNESS_DIR=~/.agent-harness TYPESAFE_BASE_URL=http://127.0.0.1:9 bin/decide level x", /scratch harness/],
          ["backticks", "echo `bin/decide level x`", /orchestrator/],
          ["a heredoc README naming the harness .env and the key", "cat > README.md <<'EOF'\nKeys live in ~/.agent-harness/.env, for example TYPESAFE_API_KEY.\nEOF", true],
          ["loading the harness .env and calling Jev", "cd ~/.agent-harness && source .env && curl https://api.typesafe.ai/v1/systemone", /only for bin\/decide and bin\/session-log/],
        ],
        { agent: true },
      );
    });
  });

  describe("E3 bin/session-log and the Supabase keys", () => {
    describe("a sub-agent", { concurrency: 8 }, () => {
      table(
        [
          ["flush against the live harness", "~/.agent-harness/bin/session-log flush", /scratch HARNESS_DIR/],
          ["flush with no HARNESS_DIR", "bin/session-log flush", /scratch HARNESS_DIR/],
          ["flush against a scratch HARNESS_DIR", "HARNESS_DIR=/tmp/h bin/session-log flush", true],
          ["hook against a scratch HARNESS_DIR, with node in front", "HARNESS_DIR=/tmp/h node bin/session-log hook", true],
          ["--help", "bin/session-log --help", true],
          ["-h", "~/.agent-harness/bin/session-log -h", true],
          ["bin/session-log with no command", "bin/session-log", true],
          ["timeout in front", "timeout 5 bin/session-log flush", /scratch HARNESS_DIR/],
          ["bash -c", "bash -c 'bin/session-log flush'", /scratch HARNESS_DIR/],
          ["the live harness as HARNESS_DIR", "HARNESS_DIR=~/.agent-harness bin/session-log flush", /scratch HARNESS_DIR/],
          ["a relative HARNESS_DIR", "HARNESS_DIR=h bin/session-log flush", /scratch HARNESS_DIR/],
          ["a mention in an echo", 'echo "run bin/session-log flush later"', true],
          ["a mention in a grep", 'grep -rn "bin/session-log" skills/', true],
          ["a mention in a heredoc", "cat > notes.md <<'EOF'\nbin/session-log flush sends the events\nEOF", true],
          ["a mention in a commit message", 'git commit -m "docs: bin/session-log status shows the queue"', true],
          ["sourcing the harness .env and calling Supabase", 'source ~/.agent-harness/.env && curl "$COCKPIT_SUPABASE_URL/rest/v1/cockpit_sessions"', /only for bin\/decide and bin\/session-log/],
        ],
        { agent: true },
      );
    });

    describe("the main agent", { concurrency: 8 }, () => {
      table([
        ["status against the live harness", "~/.agent-harness/bin/session-log status", true],
        ["flush against the live harness", "~/.agent-harness/bin/session-log flush", true],
        ["sourcing the harness .env and calling Supabase", 'source ~/.agent-harness/.env && curl "$COCKPIT_SUPABASE_URL/rest/v1/cockpit_sessions"', /only for bin\/decide and bin\/session-log/],
        ["--env-file of the harness .env and a Supabase call", 'node --env-file=~/.agent-harness/.env -e "fetch(process.env.COCKPIT_SUPABASE_URL + \'/rest/v1/x\')"', /only for bin\/decide and bin\/session-log/],
        ["a project's own .env", "node --env-file=.env scripts/x.ts", true],
        ["a project's own .env with a Supabase call", 'node --env-file=.env -e "fetch(process.env.SUPABASE_URL + \'/rest/v1/x\')"', true],
      ]);
    });
  });

  describe("the splitter's pins", () => {
    describe("exports count only before the call", { concurrency: 8 }, () => {
      table(
        [
          ["decide, with both exported before it", "export HARNESS_DIR=/tmp/h TYPESAFE_BASE_URL=http://127.0.0.1:9999 && bin/decide level x", true],
          ["decide, with both exported on separate lines before it", "export HARNESS_DIR=/tmp/h\nexport TYPESAFE_BASE_URL=http://127.0.0.1:9999\nbin/decide level x", true],
          ["decide, with both exported only after it", "bin/decide level x; export HARNESS_DIR=/tmp/h TYPESAFE_BASE_URL=http://127.0.0.1:9999", /orchestrator/],
          ["decide, with only the harness exported before it", "export HARNESS_DIR=/tmp/h; bin/decide level x", /orchestrator/],
          ["session-log, with the harness exported before it", "export HARNESS_DIR=/tmp/h; bin/session-log flush", true],
          ["session-log, with the harness exported only after it", "bin/session-log flush; export HARNESS_DIR=/tmp/h", /scratch HARNESS_DIR/],
        ],
        { agent: true },
      );
    });

    describe("a ) that closes nothing starts a new command", { concurrency: 8 }, () => {
      table(
        [
          ["a case branch", "case x in x) bin/decide level x ;; esac", /orchestrator/],
          ["a case branch with session-log", "case x in x) bin/session-log flush ;; esac", /scratch HARNESS_DIR/],
          ["after a closed $( ... ) the rest continues a command", "echo $(date) bin/decide level x", true],
          ["after a closed ( ... ) subshell the next word starts a command", "(cd /tmp) && bin/decide level x", /orchestrator/],
        ],
        { agent: true },
      );
    });

    describe("a sub-agent's HARNESS_DIR", { concurrency: 8 }, () => {
      const decideWith = (dir) => `HARNESS_DIR=${dir} TYPESAFE_BASE_URL=http://127.0.0.1:9 bin/decide level x`;
      const logWith = (dir) => `HARNESS_DIR=${dir} bin/session-log flush`;
      const scratchReason = /scratch (harness|HARNESS_DIR)/;
      const parts = ["/tmp/h/.", "/tmp/h/..", "/tmp/./h", "/tmp/h/../h", "/tmp/../tmp/h"];
      table(
        [
          ...parts.map((dir) => [`${dir} for decide (a . or .. part)`, decideWith(dir), scratchReason]),
          ...parts.map((dir) => [`${dir} for session-log (a . or .. part)`, logWith(dir), scratchReason]),
          ["an absolute scratch dir with a similar name for decide", decideWith("/tmp/h.old"), true],
          ["an absolute scratch dir with a similar name for session-log", logWith("/tmp/h-2"), true],
          ["an absolute dir under a dotted folder", logWith("/tmp/.scratch/h"), true],
        ],
        { agent: true },
      );

      it("the worktree itself is denied, written plainly, with a slash or through a symlink", async () => {
        const link = path.join(s.root, "harness-link");
        fs.symlinkSync(REPO, link);
        for (const dir of [REPO, `${REPO}/`, link, `${link}/`]) {
          denied(await guard(logWith(dir), { agent: true }), logWith(dir), scratchReason);
          denied(await guard(decideWith(dir), { agent: true }), decideWith(dir), scratchReason);
        }
      });

      it("$HOME/.agent-harness is denied, whether or not it exists, and a symlink to it is too", async () => {
        const empty = s.dir("home-without");
        const installed = s.dir("home-with");
        fs.symlinkSync(REPO, path.join(installed, ".agent-harness"));
        const aliased = path.join(s.root, "alias-of-installed");
        fs.symlinkSync(path.join(installed, ".agent-harness"), aliased);
        for (const home of [empty, installed]) {
          for (const dir of ["~/.agent-harness", "$HOME/.agent-harness", "${HOME}/.agent-harness", `${home}/.agent-harness`, `${home}/.agent-harness/`]) {
            denied(await guard(logWith(dir), { agent: true, home }), `${home}: ${logWith(dir)}`, scratchReason);
            denied(await guard(decideWith(dir), { agent: true, home }), `${home}: ${decideWith(dir)}`, scratchReason);
          }
        }
        denied(await guard(logWith(aliased), { agent: true, home: installed }), logWith(aliased), scratchReason);
      });

      it("a scratch dir is allowed even when the scratch HOME has an installed harness", async () => {
        const installed = s.dir("home-with");
        fs.symlinkSync(REPO, path.join(installed, ".agent-harness"));
        allowed(await guard(logWith("/tmp/h"), { agent: true, home: installed }), logWith("/tmp/h"));
        allowed(await guard(decideWith("/tmp/h"), { agent: true, home: installed }), decideWith("/tmp/h"));
      });
    });
  });
});
