// H-F: the docs and the role files no longer hard-code model tiers (plan D7), and the diff is clean.
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

const git = (...args) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8", env: baseEnv(REPO) });

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
