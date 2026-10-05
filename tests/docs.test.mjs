// H-F: the docs and the role files no longer hard-code model tiers (plan D7), the session log is documented,
// the superseded stage log is gone, and the public repo holds no machine path, project URL or key (sessions
// plan: briefs 7, 12 and 13), and the diff is clean.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { REPO, baseEnv } from "./helpers.mjs";

const read = (file) => fs.readFileSync(path.join(REPO, file), "utf8");
const skills = fs
  .readdirSync(path.join(REPO, "skills"))
  .filter((name) => fs.existsSync(path.join(REPO, "skills", name, "SKILL.md")))
  .map((name) => `skills/${name}/SKILL.md`);
const docs = ["AGENTS.md", "README.md", "cursor/harness.mdc", ...skills];

// Same pattern as the check: grep -nE '\| *Tier *\||override the model|\((small|medium|large) (tier|model)\)|on the large model|medium model|large tier'
const TIER_TEXT = /\| *Tier *\||override the model|\((small|medium|large) (tier|model)\)|on the large model|medium model|large tier/;

const git = (...args) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8", env: baseEnv(REPO), maxBuffer: 64 * 1024 * 1024 });

// The base of this task: <worktree>.handoff/base beside the worktree, else the merge base with origin/main.
function baseCommit() {
  const beside = path.join(path.dirname(REPO), `${path.basename(REPO)}.handoff`, "base");
  const candidates = [];
  if (process.env.HARNESS_TEST_BASE) candidates.push(process.env.HARNESS_TEST_BASE);
  if (fs.existsSync(beside)) candidates.push(fs.readFileSync(beside, "utf8").trim());
  const mergeBase = git("merge-base", "HEAD", "origin/main");
  if (mergeBase.status === 0) candidates.push(mergeBase.stdout.trim());
  return candidates.find((rev) => rev && git("rev-parse", "--verify", "--quiet", `${rev}^{commit}`).status === 0) || null;
}

// The base of the sessions round: <worktree>.handoff/sessions/base beside the worktree, else the task's base.
function sessionsBase() {
  const beside = path.join(path.dirname(REPO), `${path.basename(REPO)}.handoff`, "sessions", "base");
  const candidates = [];
  if (process.env.HARNESS_TEST_SESSIONS_BASE) candidates.push(process.env.HARNESS_TEST_SESSIONS_BASE);
  if (fs.existsSync(beside)) candidates.push(fs.readFileSync(beside, "utf8").trim());
  const found = candidates.find((rev) => rev && git("rev-parse", "--verify", "--quiet", `${rev}^{commit}`).status === 0);
  return found || baseCommit();
}

// The text of a markdown section: from its heading to the next heading of the same or a higher level.
function section(text, title) {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => new RegExp(`^#{1,6} ${title}\\s*$`).test(line));
  if (at === -1) return null;
  const level = /^#+/.exec(lines[at])[0].length;
  const end = lines.findIndex((line, i) => i > at && /^#+ /.test(line) && /^#+/.exec(line)[0].length <= level);
  return lines.slice(at, end === -1 ? undefined : end).join("\n");
}

describe("H-F docs and role models", () => {
  describe("F1 nothing contradicts the role files", () => {
    it("no doc hard-codes a model tier", () => {
      const found = [];
      for (const file of docs) {
        read(file)
          .split("\n")
          .forEach((line, i) => {
            if (TIER_TEXT.test(line)) found.push(`${file}:${i + 1}:${line.trim()}`);
          });
      }
      assert.deepEqual(found, [], "tier text found in docs");
    });

    it("solve, AGENTS.md, README.md and cursor/harness.mdc all mention bin/decide", () => {
      const missing = ["skills/solve/SKILL.md", "AGENTS.md", "README.md", "cursor/harness.mdc"].filter((file) => !read(file).includes("bin/decide"));
      assert.deepEqual(missing, []);
    });

    it(".env.example has exactly one empty TYPESAFE_API_KEY line", () => {
      assert.equal(read(".env.example").split("\n").filter((line) => line === "TYPESAFE_API_KEY=").length, 1);
    });

    it("the diff against the base has no whitespace errors (git diff --check)", (t) => {
      const base = baseCommit();
      if (!base) return t.skip("no base commit: no <worktree>.handoff/base, no origin/main");
      const r = git("diff", "--check", base);
      assert.equal(r.status, 0, `git diff --check ${base}:\n${r.stdout}${r.stderr}`);
      assert.equal(r.stdout, "");
    });

    it("no role file's model: line changed against the base", (t) => {
      const base = baseCommit();
      if (!base) return t.skip("no base commit: no <worktree>.handoff/base, no origin/main");
      const r = git("diff", "-U0", base, "--", "agents/");
      assert.equal(r.status, 0, r.stderr);
      const changed = r.stdout.split("\n").filter((line) => /^[+-]model:/.test(line));
      assert.deepEqual(changed, []);
    });
  });

  describe("D7 role files own the models", () => {
    const roles = ["designer", "implementer", "planner", "reviewer", "searcher", "tester", "verifier"];

    it("has one role file per role, each with a model: from inherit, haiku, sonnet, opus, fable", () => {
      assert.deepEqual(
        fs
          .readdirSync(path.join(REPO, "agents"))
          .filter((name) => name.endsWith(".md"))
          .map((name) => name.slice(0, -3))
          .sort(),
        roles,
      );
      for (const role of roles) {
        const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(read(`agents/${role}.md`));
        assert.ok(frontmatter, `${role}: no frontmatter`);
        const model = frontmatter[1].split("\n").filter((line) => line.startsWith("model:"));
        assert.equal(model.length, 1, `${role}: model: lines`);
        assert.match(model[0], /^model: (inherit|haiku|sonnet|opus|fable)$/, role);
      }
    });

    it("AGENTS.md lists every role without a tier column", () => {
      const text = read("AGENTS.md");
      for (const role of roles) assert.match(text, new RegExp(`^\\| ${role} \\|`, "m"), role);
      assert.doesNotMatch(text, /\| *Tier *\|/);
    });
  });
});

describe("H-F the session log is documented and the public repo is clean", () => {
  describe("F1 the docs", () => {
    it(".env.example has one empty line for each Supabase key", () => {
      const lines = read(".env.example").split("\n");
      assert.equal(lines.filter((line) => line === "COCKPIT_SUPABASE_URL=").length, 1);
      assert.equal(lines.filter((line) => line === "COCKPIT_SUPABASE_SECRET_KEY=").length, 1);
    });

    it("the README has a Session log section naming the tables, the outbox, the status command, the key and the CLIs that are not logged", () => {
      const text = section(read("README.md"), "Session log");
      assert.ok(text, "README.md has no 'Session log' heading");
      for (const term of [
        "cockpit_sessions",
        "cockpit_agents",
        "cockpit_decisions",
        "logs/session-outbox",
        "bin/session-log status",
        "COCKPIT_SUPABASE_SECRET_KEY",
        "Codex",
        "Cursor",
      ]) {
        assert.ok(text.includes(term), `the Session log section does not name ${term}`);
      }
    });

    it("AGENTS.md and the solve skill both mention session-log", () => {
      for (const file of ["AGENTS.md", "skills/solve/SKILL.md"]) assert.ok(read(file).includes("session-log"), file);
    });

    it("AGENTS.md no longer points at stage-times", () => {
      assert.equal(read("AGENTS.md").split("stage-times").length - 1, 0);
      assert.ok(read("AGENTS.md").includes("## Cost"), "the Cost advice stays");
    });

    it("the Cursor rule says Cursor sessions are not logged", () => {
      assert.match(read("cursor/harness.mdc"), /Cursor sessions are not logged/i);
    });
  });

  describe("D1 the stage log is gone", () => {
    it("bin/stage-times and hooks/stage-log.sh do not exist", () => {
      assert.equal(fs.existsSync(path.join(REPO, "bin", "stage-times")), false);
      assert.equal(fs.existsSync(path.join(REPO, "hooks", "stage-log.sh")), false);
    });

    it("no tracked file outside tests/ names stage-times, stage-log, stages.tsv or decisions.jsonl", () => {
      const r = git("grep", "-n", "-e", "stage-times", "-e", "stage-log", "-e", "stages.tsv", "-e", "decisions.jsonl", "--", ".", ":!tests");
      assert.equal(r.status, 1, `git grep found matches:\n${r.stdout}${r.stderr}`);
      assert.equal(r.stdout, "");
    });
  });

  describe("F2 the public repo", () => {
    // The patterns are written in pieces so that this file does not match itself.
    const forbidden = [
      new RegExp(["supabase", "co"].join("\\.")),
      new RegExp(`${"sb_" + "secret_"}[A-Za-z0-9]{8}`),
      new RegExp(`${"sb_" + "publishable_"}[A-Za-z0-9]{8}`),
      new RegExp(`/${"Us"}${"ers"}/`),
    ];

    it("no added line holds a project URL, a key or a machine path", (t) => {
      const base = sessionsBase();
      if (!base) return t.skip("no base commit");
      const r = git("diff", base, "-U0");
      assert.equal(r.status, 0, r.stderr);
      const found = r.stdout
        .split("\n")
        .filter((line) => line.startsWith("+") && forbidden.some((re) => re.test(line)));
      assert.deepEqual(found, []);
    });

    it("tests use no secret but the fake's", () => {
      const dir = path.join(REPO, "tests");
      for (const name of fs.readdirSync(dir).filter((file) => /\.(mjs|js)$/.test(file))) {
        for (const m of fs.readFileSync(path.join(dir, name), "utf8").matchAll(/sb_secret_([A-Za-z0-9_]+)/g)) {
          assert.equal(m[1], "test", `${name}: ${m[0]}`);
        }
      }
    });

    it("the diff against the sessions base has no whitespace errors (git diff --check)", (t) => {
      const base = sessionsBase();
      if (!base) return t.skip("no base commit");
      for (const args of [["diff", "--check"], ["diff", "--check", base]]) {
        const r = git(...args);
        assert.equal(r.status, 0, `git ${args.join(" ")}:\n${r.stdout}${r.stderr}`);
        assert.equal(r.stdout, "");
      }
    });
  });

  describe("F3 the review nits", () => {
    const lines = (file) => read(file).split("\n");

    it("rules/git.md line 2 says parallel lanes and the verifier work in forks", () => {
      assert.ok(lines("rules/git.md")[1].includes("Parallel lanes and the verifier work in forks"), lines("rules/git.md")[1]);
    });

    it("the plan skill says solve spawns the planner when the level has plan on", () => {
      const description = lines("skills/plan/SKILL.md").find((line) => line.startsWith("description:"));
      assert.ok(description && description.includes("Solve spawns the planner when the level has plan on"), description);
    });

    it("solve step 5 spawns the verifier only with at least one verify check", () => {
      const step = section(read("skills/solve/SKILL.md"), "5\\. Check");
      assert.ok(step, "no step 5");
      const line = step.split("\n").find((l) => l.includes("verifier"));
      assert.ok(line, "step 5 does not mention the verifier");
      assert.match(line, /only with[^;]*at least one `verify` check/);
    });

    it("solve says a non-zero decide ui exit counts as ui: yes", () => {
      assert.match(read("skills/solve/SKILL.md"), /non-zero exit[^.]*counts as `ui: yes`/);
    });

    it("the README says that without a key the level falls back to medium", () => {
      assert.match(read("README.md"), /Without a key[^.]*\.[^.]*level[^.]*falls back to `medium`/);
    });
  });
});
