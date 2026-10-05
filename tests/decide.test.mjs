// H-B: bin/decide against a fake Jev (plan D2, D3) and its session log events (sessions plan S6). Every case
// gets a fresh scratch HARNESS_DIR, because the decide cache key ignores the fake's answer; nothing here
// reaches the real API, the real Supabase, ~/.agent-harness or its logs. bin/decide keeps no decision log:
// `--json` prints the decision (the D3 object), and `start` and `ui` queue session events when they know
// the Claude Code session.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { startFakeJev } from "./fake-jev.mjs";
import { startFakeSupabase } from "./fake-supabase.mjs";
import {
  DECIDE,
  DECISION_KEYS,
  SCHEMA_FILE,
  SESSION_LOG,
  SETTINGS_FILE,
  clone,
  deadUrl,
  decide,
  drained,
  makeHarness,
  makeRepo,
  makeUiRepo,
  readJson,
  run,
  scratch,
  supabaseEnv,
  until,
} from "./helpers.mjs";

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BLOCK = "Harness decision for this solve (bin/decide):";
const STAGE_LINE = {
  small: "plan off, implement self, test off, verify ui, design off, review off, fix rounds 1",
  medium: "plan off, implement self, test on, verify ui, design ui, review on, fix rounds 1",
  large: "plan on, implement agents, test on, verify ui, design ui, review on, fix rounds 2",
};
const LEVEL_ANSWER = { small: 0.1, medium: 0.8, large: 0.1 };
const base = readJson(SETTINGS_FILE);

function assertShape(entry) {
  assert.deepEqual(Object.keys(entry), DECISION_KEYS, "the D3 keys, in order");
  assert.equal(entry.v, 1);
  assert.match(entry.time, TIME_RE);
  assert.match(entry.inputHash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(entry.ms) && entry.ms >= 0, `ms ${entry.ms}`);
  assert.ok(["level", "recipe", "ui"].includes(entry.point), `point ${entry.point}`);
  assert.ok(["jev", "cache", "fallback", "override"].includes(entry.source), `source ${entry.source}`);
}

function assertEntry(entry, expected) {
  assertShape(entry);
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(entry[key], value, `decision ${key}`);
}

// The line `decide` prints for a decision, from the decision --json prints: "<point>: <value> (<tag>)".
const lineOf = (e) => `${e.point}: ${e.value} (${e.source}, ${e.source === "jev" || e.source === "cache" ? e.confidence.toFixed(2) : e.reason})`;

const NO_ANSWER = { confidence: null, probabilities: null, model: null };

describe("H-B bin/decide", () => {
  const s = scratch("harness-decide-");
  let fake;
  let acme;
  let closedUrl;

  before(async () => {
    fake = await startFakeJev();
    acme = makeUiRepo(s, "acme", { origin: "git@github.com:o/acme.git" });
    closedUrl = await deadUrl();
  });
  after(async () => {
    await fake.close();
    s.remove();
  });

  const fresh = (opts) => {
    fake.reset();
    return makeHarness(s, opts);
  };
  const d = (h, args, opts = {}) => decide(s, h, args, { url: fake.url, ...opts });
  const level = (h, task, opts) => d(h, ["level", "--repo", acme, "--", task], opts);
  const levelJson = (h, task, opts) => d(h, ["level", "--json", "--repo", acme, "--", task], opts);
  const recipe = (h, task, opts) => d(h, ["recipe", "--repo", acme, "--", task], opts);
  const recipeJson = (h, task, opts) => d(h, ["recipe", "--json", "--repo", acme, "--", task], opts);
  const ui = (h, opts) => d(h, ["ui", acme], opts);
  const uiJson = (h, opts) => d(h, ["ui", "--json", acme], opts);
  const alphaBeta = (h) => {
    const alpha = h.recipe("acme", "alpha", "# acme/alpha — deploys");
    h.recipe("acme", "beta", "# acme/beta — migrations");
    return alpha;
  };
  const expectOut = (r, text) => {
    assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
    assert.equal(r.stdout, `${text}\n`);
  };
  // The decision a --json run printed: one line holding the D3 object.
  const decision = (r) => {
    assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
    assert.equal(r.stdout.trimEnd().split("\n").length, 1, `one line: ${r.stdout}`);
    return JSON.parse(r.stdout);
  };
  const nothingQueued = (h, why) => {
    assert.deepEqual(h.events(), [], `${why}: events queued`);
    assert.equal(fs.existsSync(h.logFile), false, `${why}: logs/decisions.jsonl was written`);
  };

  describe("B1 a Jev decision", () => {
    it("asks Jev once, with the fixed question and the level descriptions, and prints the decision", async () => {
      const h = fresh();
      fake.answer("level", LEVEL_ANSWER);
      expectOut(await level(h, "add a settings page"), "level: medium (jev, 0.70)");

      assert.equal(fake.requests.length, 1);
      const req = fake.requests[0];
      const settings = h.settings();
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/systemone");
      assert.equal(req.headers.authorization, "Bearer test-key");
      assert.equal(req.body.model, "jev-1.13.0");
      assert.equal(req.body.state, "add a settings page");
      assert.deepEqual(Object.keys(req.body.questions), ["level"]);
      const question = req.body.questions.level;
      assert.equal(question.type, "choice");
      assert.equal(question.instructions, settings.decisions.points.level.question);
      assert.deepEqual(Object.keys(question.criteria), ["small", "medium", "large"]);
      for (const l of settings.levels) assert.equal(question.criteria[l.id], l.description, `criteria ${l.id}`);
      nothingQueued(h, "level");
    });

    it("--json prints the D3 object, keys in D3 order", async () => {
      const h = fresh();
      fake.answer("level", LEVEL_ANSWER);
      const e = decision(await levelJson(h, "add a settings page"));
      assertEntry(e, {
        v: 1,
        point: "level",
        value: "medium",
        confidence: 0.7,
        probabilities: LEVEL_ANSWER,
        source: "jev",
        reason: "argmax",
        model: "jev-1.13.0",
        repo: "acme",
      });
      assert.equal(lineOf(e), "level: medium (jev, 0.70)");
      nothingQueued(h, "level --json");
    });
  });

  describe("B2 the same question is answered from the cache", () => {
    it("normalises the task, sends nothing and says it is a cache decision", async () => {
      const h = fresh();
      fake.answer("level", LEVEL_ANSWER);
      const first = decision(await levelJson(h, "add a settings page"));
      assert.equal(lineOf(first), "level: medium (jev, 0.70)");
      expectOut(await level(h, "  add   a settings page  "), "level: medium (cache, 0.70)");
      const second = decision(await levelJson(h, "  add   a settings page  "));

      assert.equal(fake.requests.length, 1);
      assertEntry(second, { source: "cache", reason: "argmax", ms: 0, inputHash: first.inputHash, value: "medium", confidence: 0.7, model: "jev-1.13.0" });
      assert.equal(h.cacheFiles().filter((f) => /^level-.*\.json$/.test(f)).length, 1);
    });

    it("keys the cache by the normalised task: spaces and tabs and CRLF are the same, another task asks again", async () => {
      const h = fresh();
      fake.answer("level", LEVEL_ANSWER);
      const hashes = [];
      const ask = async (task, line, requests) => {
        const e = decision(await levelJson(h, task));
        assert.equal(lineOf(e), line);
        assert.equal(fake.requests.length, requests, `requests after ${JSON.stringify(task)}`);
        hashes.push(e.inputHash);
      };
      await ask("add a settings page", "level: medium (jev, 0.70)", 1);
      await ask("add\ta   settings\t page", "level: medium (cache, 0.70)", 1);
      await ask("add a\r\nsettings page", "level: medium (jev, 0.70)", 2);
      await ask("add a\nsettings page", "level: medium (cache, 0.70)", 2);
      await ask("add a billing page", "level: medium (jev, 0.70)", 3);
      assert.equal(hashes[0], hashes[1]);
      assert.equal(hashes[2], hashes[3]);
      assert.notEqual(hashes[0], hashes[2]);
      assert.notEqual(hashes[0], hashes[4]);
    });

    it("keys the cache by model, level descriptions, wording and task, not by the answer or the threshold", async () => {
      const h = fresh();
      fake.answer("level", LEVEL_ANSWER);
      const original = clone(h.settings());
      await level(h, "add a settings page");
      assert.equal(fake.requests.length, 1);

      h.edit((doc) => void (doc.decisions.model = "jev-1.14.0"));
      await level(h, "add a settings page");
      assert.equal(fake.requests.length, 2, "a new pinned model asks again");
      assert.equal(fake.requests[1].body.model, "jev-1.14.0");

      h.edit((doc) => void (doc.levels[0].description = `${doc.levels[0].description} Also renames.`));
      await level(h, "add a settings page");
      assert.equal(fake.requests.length, 3, "a changed level description asks again");

      h.edit((doc) => void (doc.decisions.points.level.question = `${doc.decisions.points.level.question} Be brief.`));
      await level(h, "add a settings page");
      assert.equal(fake.requests.length, 4, "changed wording asks again");

      await level(h, "add a settings page and a billing page");
      assert.equal(fake.requests.length, 5, "another task asks again");

      h.edit((doc) => void Object.assign(doc, clone(original)));
      const r = await level(h, "add a settings page");
      expectOut(r, "level: medium (cache, 0.70)");
      assert.equal(fake.requests.length, 5, "the original question is still cached");

      h.edit((doc) => {
        doc.decisions.points.level.minConfidence = 0.2;
        doc.decisions.timeoutMs = 9000;
      });
      expectOut(await level(h, "add a settings page"), "level: medium (cache, 0.70)");
      assert.equal(fake.requests.length, 5, "threshold and timeout are not part of the key");
    });

    it("re-applies the threshold to a cached answer without asking again", async () => {
      const h = fresh();
      fake.answer("level", { small: 0.4, medium: 0.4, large: 0.2 });
      h.edit((doc) => void (doc.decisions.points.level.minConfidence = 0));
      expectOut(await level(h, "tune the build"), "level: small (jev, 0.10)");
      h.edit((doc) => void (doc.decisions.points.level.minConfidence = 0.4));
      const second = decision(await levelJson(h, "tune the build"));
      assert.equal(lineOf(second), "level: medium (fallback, low-confidence)");
      assert.equal(fake.requests.length, 1);
      assert.deepEqual(second.probabilities, { small: 0.4, medium: 0.4, large: 0.2 });
    });

    it("caches Jev answers only, so a failed call is asked again next time", async () => {
      const h = fresh();
      fake.answer("level", LEVEL_ANSWER);
      fake.mode("401");
      expectOut(await level(h, "add a settings page"), "level: medium (fallback, http-401)");
      assert.deepEqual(h.cacheFiles(), []);
      fake.mode("ok");
      expectOut(await level(h, "add a settings page"), "level: medium (jev, 0.70)");
      assert.equal(fake.requests.length, 2);
      assert.equal(h.cacheFiles().length, 1);
    });

    it("reports the answering model, also from the cache", async () => {
      const h = fresh();
      fake.answer("level", LEVEL_ANSWER);
      fake.setModel("jev-1.13.1");
      const first = decision(await levelJson(h, "add a settings page"));
      const second = decision(await levelJson(h, "add a settings page"));
      assert.equal(first.model, "jev-1.13.1");
      assert.equal(second.source, "cache");
      assert.equal(second.model, "jev-1.13.1");
    });
  });

  describe("B3 thresholds and ties", () => {
    it("breaks a tie toward the earlier option", async () => {
      const h = fresh();
      fake.answer("level", { small: 0.4, medium: 0.4, large: 0.2 });
      h.edit((doc) => void (doc.decisions.points.level.minConfidence = 0));
      const e = decision(await levelJson(h, "tune the build"));
      assert.equal(lineOf(e), "level: small (jev, 0.10)");
      assertEntry(e, { value: "small", confidence: 0.1, source: "jev", reason: "argmax" });
    });

    it("below minConfidence falls back to the more thorough of the top two: medium and large", async () => {
      const h = fresh();
      fake.answer("level", { small: 0.2, medium: 0.45, large: 0.35 });
      const e = decision(await levelJson(h, "tune the build"));
      assert.equal(lineOf(e), "level: large (fallback, low-confidence)");
      assertEntry(e, { value: "large", source: "fallback", reason: "low-confidence", probabilities: { small: 0.2, medium: 0.45, large: 0.35 } });
    });

    it("below minConfidence falls back to the more thorough of the top two: small and medium", async () => {
      const h = fresh();
      fake.answer("level", { small: 0.45, medium: 0.35, large: 0.2 });
      const e = decision(await levelJson(h, "tune the build"));
      assert.equal(lineOf(e), "level: medium (fallback, low-confidence)");
      assertEntry(e, { value: "medium", source: "fallback", reason: "low-confidence", probabilities: { small: 0.45, medium: 0.35, large: 0.2 } });
    });

    it("accepts a confidence exactly at the threshold", async () => {
      const h = fresh();
      fake.answer("level", { small: 0.2, medium: 0.6, large: 0.2 });
      h.edit((doc) => void (doc.decisions.points.level.minConfidence = 0.4));
      expectOut(await level(h, "tune the build"), "level: medium (jev, 0.40)");
    });
  });

  describe("B4 no key", () => {
    const missing = [
      ["no .env file", { env: null }],
      [".env without the key", { env: "GITHUB_TOKEN=abc\n# TYPESAFE_API_KEY=commented\n" }],
      [".env with an empty key", { env: "TYPESAFE_API_KEY=\n" }],
    ];
    for (const [name, opts] of missing) {
      it(`falls back for every point and sends nothing: ${name}`, async () => {
        const h = fresh(opts);
        alphaBeta(h);
        expectOut(await level(h, "add a settings page"), "level: medium (fallback, no-key)");
        expectOut(await recipe(h, "deploy the api"), "recipe: none (fallback, no-key)");
        expectOut(await ui(h), "ui: yes (fallback, no-key)");
        const entries = [decision(await levelJson(h, "add a settings page")), decision(await recipeJson(h, "deploy the api")), decision(await uiJson(h))];
        assert.equal(fake.requests.length, 0);
        assert.deepEqual(entries.map((e) => e.point), ["level", "recipe", "ui"]);
        for (const entry of entries) assertEntry(entry, { source: "fallback", reason: "no-key", ms: 0, ...NO_ANSWER });
      });
    }

    it("ignores a key in the process environment: only the harness .env counts", async () => {
      const h = fresh({ env: "GITHUB_TOKEN=abc\n" });
      expectOut(await level(h, "add a settings page", { env: { TYPESAFE_API_KEY: "from-the-process-env" } }), "level: medium (fallback, no-key)");
      assert.equal(fake.requests.length, 0);
    });

    it("reads the key from a .env with other keys, comments and quotes", async () => {
      const h = fresh({ env: '# keys\nGITHUB_TOKEN=gh\nTYPESAFE_API_KEY="quoted-key-1"\nOPENAI_API_KEY=oa\n' });
      fake.answer("level", LEVEL_ANSWER);
      expectOut(await level(h, "add a settings page"), "level: medium (jev, 0.70)");
      assert.equal(fake.requests[0].headers.authorization, "Bearer quoted-key-1");
    });

    it("never prints the key or the task text: not to stdout, stderr, the outbox or the cache", async () => {
      const key = "unit-test-key-9f3a7c1e5b";
      const task = "migrate the ledger tables";
      const h = fresh({ key });
      fake.answer("level", LEVEL_ANSWER);
      const results = [await level(h, task)];
      fake.mode("401");
      results.push(await level(h, `${task} again`));
      fake.mode("closed");
      results.push(await level(h, `${task} once more`));
      results.push(await d(h, ["start", "--session", "s1", "--repo", acme, "--", `${task} for the last time`]));
      assert.equal(fake.requests[0].headers.authorization, `Bearer ${key}`);
      const seen = [...results.flatMap((r) => [r.stdout, r.stderr])];
      for (const file of h.cacheFiles()) seen.push(fs.readFileSync(path.join(h.dir, "logs", "decisions", file), "utf8"));
      for (const text of seen) {
        assert.ok(!text.includes(key), "the key leaked");
        assert.ok(!text.includes("ledger"), "the task text leaked");
      }
      for (const name of h.eventFiles()) assert.ok(!fs.readFileSync(path.join(h.outboxDir, name), "utf8").includes(key), `the key leaked into ${name}`);
      assert.equal(fs.existsSync(h.logFile), false);
    });
  });

  describe("B5 failures fall back, exit 0 and never block", () => {
    const failures = [
      ["a 503 answer", "503", "http-503", 2],
      ["a 500 answer", "500", "http-500", 2],
      ["a 429 answer", "429", "http-429", 2],
      ["a 401 answer", "401", "http-401", 1],
      ["a 400 answer", "400", "http-400", 1],
      ["a body that is not JSON", "bad", "bad-response", 1],
      ["probabilities missing an option", "bad-probabilities", "bad-response", 1],
      ["a connection closed without an answer", "closed", "network", 2],
    ];
    for (const [name, mode, reason, requests] of failures) {
      it(`${name}: (fallback, ${reason}) after ${requests} request${requests === 1 ? "" : "s"}`, async () => {
        const h = fresh();
        fake.mode(mode);
        expectOut(await level(h, "add a settings page"), `level: medium (fallback, ${reason})`);
        assert.equal(fake.requests.length, requests);
        const e = decision(await levelJson(h, "add a settings page"));
        assertEntry(e, { value: "medium", source: "fallback", reason, ...NO_ANSWER });
      });
    }

    it("a connection refused: (fallback, network)", async () => {
      const h = fresh();
      expectOut(await level(h, "add a settings page", { url: closedUrl }), "level: medium (fallback, network)");
      assertEntry(decision(await levelJson(h, "add a settings page", { url: closedUrl })), { source: "fallback", reason: "network" });
    });

    it("an answer slower than timeoutMs: (fallback, timeout), back within 3 s", async () => {
      const h = fresh();
      h.edit((doc) => void (doc.decisions.timeoutMs = 1000));
      fake.mode("delay:10000");
      const r = await level(h, "add a settings page");
      expectOut(r, "level: medium (fallback, timeout)");
      assert.ok(r.ms < 3000, `took ${r.ms} ms`);
      assert.equal(fake.requests.length, 1);
      assertEntry(decision(await levelJson(h, "add a settings page")), { source: "fallback", reason: "timeout", ...NO_ANSWER });
    });

    it("retries once after a 503 and uses the second answer", async () => {
      const h = fresh();
      fake.answer("level", LEVEL_ANSWER);
      fake.queue(["503"]);
      expectOut(await level(h, "add a settings page"), "level: medium (jev, 0.70)");
      assert.equal(fake.requests.length, 2);
    });

    it("does not retry when less than a second of the time budget would be left", async () => {
      const h = fresh();
      h.edit((doc) => void (doc.decisions.timeoutMs = 1000));
      fake.mode("503");
      expectOut(await level(h, "add a settings page"), "level: medium (fallback, http-503)");
      assert.equal(fake.requests.length, 1);
    });

    it("every point falls back on an error: recipe none, ui yes", async () => {
      const h = fresh();
      alphaBeta(h);
      fake.mode("503");
      expectOut(await recipe(h, "deploy the api"), "recipe: none (fallback, http-503)");
      expectOut(await ui(h), "ui: yes (fallback, http-503)");
    });
  });

  describe("B6 a level word in front of the task overrides Jev", () => {
    const overrides = [
      ["large: rewrite the store", "large"],
      ["inline fix the typo", "small"],
      ["loop add billing", "large"],
      ["Medium, tidy the docs", "medium"],
      ["LARGE: rewrite the store", "large"],
      ["small", "small"],
    ];
    for (const [task, value] of overrides) {
      it(`"${task}" is level ${value} without asking Jev`, async () => {
        const h = fresh();
        expectOut(await level(h, task), `level: ${value} (override, first-word)`);
        assert.equal(fake.requests.length, 0);
        assertEntry(decision(await levelJson(h, task)), { value, source: "override", reason: "first-word", ms: 0, ...NO_ANSWER });
        assert.equal(fake.requests.length, 0);
      });
    }

    it("a first word that merely starts like a level is the task, not an override", async () => {
      const h = fresh();
      fake.answer("level", LEVEL_ANSWER);
      expectOut(await level(h, "larger refactor of the store"), "level: medium (jev, 0.70)");
      assert.equal(fake.requests.length, 1);
      assert.equal(fake.requests[0].body.state, "larger refactor of the store");
    });

    it("an override needs no key", async () => {
      const h = fresh({ env: null });
      expectOut(await level(h, "large rewrite the store"), "level: large (override, first-word)");
    });
  });

  describe("B7 a disabled point", () => {
    it("level: medium (fallback, disabled) and no request", async () => {
      const h = fresh();
      h.edit((doc) => void (doc.decisions.points.level.enabled = false));
      expectOut(await level(h, "add a settings page"), "level: medium (fallback, disabled)");
      assert.equal(fake.requests.length, 0);
      assertEntry(decision(await levelJson(h, "add a settings page")), { source: "fallback", reason: "disabled", ...NO_ANSWER });
    });

    it("recipe and ui have their own switches and fallbacks", async () => {
      const h = fresh();
      alphaBeta(h);
      h.edit((doc) => {
        doc.decisions.points.recipe.enabled = false;
        doc.decisions.points.ui.enabled = false;
      });
      expectOut(await recipe(h, "deploy the api"), "recipe: none (fallback, disabled)");
      expectOut(await ui(h), "ui: yes (fallback, disabled)");
      assert.equal(fake.requests.length, 0);
    });
  });

  describe("B8 the recipe decision", () => {
    it("picks one of the repo's recipes by title", async () => {
      const h = fresh();
      alphaBeta(h);
      fake.answer("recipe", { none: 0.1, alpha: 0.8, beta: 0.1 });
      const e = decision(await recipeJson(h, "deploy the api"));
      assert.equal(lineOf(e), "recipe: alpha (jev, 0.70)");

      assert.equal(fake.requests.length, 1);
      const settings = h.settings();
      const body = fake.requests[0].body;
      assert.equal(body.state, "deploy the api");
      assert.deepEqual(Object.keys(body.questions), ["recipe"]);
      const question = body.questions.recipe;
      assert.equal(question.type, "choice");
      assert.equal(question.instructions, settings.decisions.points.recipe.question);
      assert.deepEqual(Object.keys(question.criteria), ["none", "alpha", "beta"]);
      assert.equal(question.criteria.none, settings.decisions.points.recipe.none);
      assert.equal(question.criteria.alpha, "acme/alpha — deploys");
      assert.equal(question.criteria.beta, "acme/beta — migrations");
      assertEntry(e, { point: "recipe", value: "alpha", confidence: 0.7, source: "jev", repo: "acme" });
      assert.deepEqual(Object.keys(e.probabilities), ["none", "alpha", "beta"], "probabilities follow the option order: none first");
    });

    it("lists recipes by file name, whatever order they were created in", async () => {
      const h = fresh();
      h.recipe("acme", "zeta", "# acme/zeta — last");
      h.recipe("acme", "alpha", "# acme/alpha — first");
      h.recipe("acme", "mid", "# acme/mid — middle");
      await recipe(h, "do something");
      assert.deepEqual(Object.keys(fake.requests[0].body.questions.recipe.criteria), ["none", "alpha", "mid", "zeta"]);
    });

    it("can answer none, with its own wording", async () => {
      const h = fresh();
      alphaBeta(h);
      fake.answer("recipe", { none: 0.8, alpha: 0.1, beta: 0.1 });
      expectOut(await recipe(h, "rename a variable"), "recipe: none (jev, 0.70)");
    });

    it("breaks a tie toward none, the first option", async () => {
      const h = fresh();
      alphaBeta(h);
      h.edit((doc) => void (doc.decisions.points.recipe.minConfidence = 0));
      fake.answer("recipe", { none: 0.4, alpha: 0.4, beta: 0.2 });
      expectOut(await recipe(h, "deploy the api"), "recipe: none (jev, 0.10)");
    });

    it("below minConfidence takes no recipe", async () => {
      const h = fresh();
      alphaBeta(h);
      fake.answer("recipe", { none: 0.1, alpha: 0.5, beta: 0.4 });
      expectOut(await recipe(h, "deploy the api"), "recipe: none (fallback, low-confidence)");
    });

    it("a repo without recipes: none (fallback, no-recipes), nothing sent", async () => {
      const h = fresh();
      h.recipe("other-repo", "gamma", "# other-repo/gamma — unrelated");
      expectOut(await recipe(h, "deploy the api"), "recipe: none (fallback, no-recipes)");
      assert.equal(fake.requests.length, 0);
      assertEntry(decision(await recipeJson(h, "deploy the api")), { point: "recipe", value: "none", source: "fallback", reason: "no-recipes", ...NO_ANSWER });
    });

    it("a level word in front is not part of the question", async () => {
      const h = fresh();
      alphaBeta(h);
      await recipe(h, "medium deploy the api");
      assert.equal(fake.requests[0].body.state, "deploy the api");
    });
  });

  describe("B9 the ui decision", () => {
    const stateOf = "paths:\nREADME.md\nsrc/app/page.tsx\ncommits:\nfeat: page\ndocs: readme";
    const cases = [
      [0.9, "ui: yes (jev, 0.80)"],
      [0.1, "ui: no (jev, 0.80)"],
      [0.6, "ui: yes (fallback, low-confidence)"],
      [0.4, "ui: yes (fallback, low-confidence)"],
    ];
    for (const [noul, line] of cases) {
      it(`noul ${noul} prints ${line}`, async () => {
        const h = fresh();
        fake.answer("ui", noul);
        const e = decision(await uiJson(h));
        assert.equal(lineOf(e), line);
        assert.equal(fake.requests.length, 1);
        const body = fake.requests[0].body;
        assert.equal(body.state, stateOf);
        assert.deepEqual(Object.keys(body.questions), ["ui"]);
        assert.equal(body.questions.ui.type, "noul");
        const settings = h.settings();
        assert.equal(body.questions.ui.instructions, settings.decisions.points.ui.question);
        assert.deepEqual(body.questions.ui.criteria, { true: settings.decisions.points.ui.yes, false: settings.decisions.points.ui.no });
        assert.equal(e.point, "ui");
        assert.equal(e.repo, "acme");
      });
    }

    it("--base limits the changes to the commits after it", async () => {
      const h = fresh();
      fake.answer("ui", 0.9);
      expectOut(await d(h, ["ui", "--base", "HEAD~1", acme]), "ui: yes (jev, 0.80)");
      assert.equal(fake.requests[0].body.state, "paths:\nREADME.md\ncommits:\ndocs: readme");
    });

    it("exits 2 without a base, and queues nothing", async () => {
      const h = fresh();
      const repo = makeRepo(s, "nobase");
      const r = await d(h, ["ui", "--session", "s1", repo]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /base/);
      assert.equal(fake.requests.length, 0);
      nothingQueued(h, "ui without a base");
    });

    it("works in a linked worktree and reports the main checkout folder as the repo", async () => {
      const h = fresh();
      fake.answer("ui", 0.9);
      const wt = path.join(s.root, "acme-task");
      s.git(acme, "worktree", "add", "-q", "-b", "feat/task", wt);
      fs.mkdirSync(`${wt}.handoff`, { recursive: true });
      fs.writeFileSync(`${wt}.handoff/base`, `${s.git(wt, "rev-parse", "HEAD~2")}\n`);
      const e = decision(await d(h, ["ui", "--json", wt]));
      assert.equal(lineOf(e), "ui: yes (jev, 0.80)");
      assert.equal(e.repo, "acme");
      assert.equal(fake.requests[0].body.state, "paths:\nREADME.md\nsrc/app/page.tsx\ncommits:\nfeat: page\ndocs: readme");

      const other = fresh();
      const l = decision(await d(other, ["level", "--json", "--repo", wt, "--", "small tidy"]));
      assert.equal(lineOf(l), "level: small (override, first-word)");
      assert.equal(l.repo, "acme");
    });
  });

  describe("B10 bad usage exits 2 and queues nothing", () => {
    it("an unknown decision point names the known ones", async () => {
      const h = fresh();
      const r = await d(h, ["size", "x"]);
      assert.equal(r.code, 2);
      for (const word of ["level", "recipe", "ui", "start", "stages", "check"]) assert.ok(r.stderr.includes(word), `stderr names ${word}`);
      nothingQueued(h, "unknown point");
      assert.equal(fake.requests.length, 0);
    });

    it("bare bin/decide prints the usage and exits 2", async () => {
      const r = await d(fresh(), []);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /level/);
    });

    it("--help prints the usage and exits 0", async () => {
      const r = await d(fresh(), ["--help"]);
      assert.equal(r.code, 0);
      for (const word of ["level", "recipe", "ui", "start", "stages", "check"]) assert.ok(r.stdout.includes(word), `usage names ${word}`);
    });

    for (const [name, args] of [
      ["level without a task", ["level"]],
      ["level with a blank task", ["level", "--", "   "]],
      ["start without a task", ["start", "--session", "s1"]],
      ["start with a blank task", ["start", "--session", "s1", "--", "   "]],
      ["recipe without a task", ["recipe"]],
      ["an unknown option", ["level", "--bogus", "--", "x"]],
      ["--repo without a value", ["level", "--repo"]],
      ["--session without a value", ["start", "--session"]],
      ["ui without a worktree", ["ui", "--session", "s1"]],
      ["stages without a level", ["stages"]],
    ]) {
      it(`${name} exits 2`, async () => {
        const h = fresh();
        const r = await d(h, args);
        assert.equal(r.code, 2, `${r.stdout}${r.stderr}`);
        nothingQueued(h, name);
        assert.equal(fake.requests.length, 0);
      });
    }

    it("level and recipe take no --session: exit 2, nothing queued", async () => {
      const h = fresh();
      for (const point of ["level", "recipe"]) {
        for (const args of [["--session", "s1"], ["--session=s1"]]) {
          const r = await d(h, [point, ...args, "--repo", acme, "--", "small x"]);
          assert.equal(r.code, 2, `${point} ${args.join(" ")}: ${r.stdout}${r.stderr}`);
          assert.equal(r.stdout, "");
        }
      }
      nothingQueued(h, "level and recipe with --session");
      assert.equal(fake.requests.length, 0);
    });

    it("a missing settings.json exits 2 for every command", async () => {
      const h = fresh();
      fs.rmSync(h.settingsPath);
      for (const args of [["level", "--", "x"], ["start", "--session", "s1", "--", "x"], ["recipe", "--", "x"], ["ui", "--session", "s1", acme], ["stages", "small"], ["check"]]) {
        const r = await d(h, args);
        assert.equal(r.code, 2, `${args[0]}: ${r.stdout}${r.stderr}`);
      }
      nothingQueued(h, "no settings.json");
      assert.equal(fake.requests.length, 0);
    });

    it("an invalid settings.json exits 2 and names the problem", async () => {
      const h = fresh();
      h.edit((doc) => void (doc.decisions.timeoutMs = 100));
      for (const args of [["level", "--repo", acme, "--", "add a settings page"], ["start", "--session", "s1", "--repo", acme, "--", "add a settings page"]]) {
        const r = await d(h, args);
        assert.equal(r.code, 2);
        assert.match(r.stderr, /decisions\.timeoutMs/);
      }
      nothingQueued(h, "invalid settings");
      assert.equal(fake.requests.length, 0);
    });

    it("a settings.json that is not JSON exits 2", async () => {
      const h = fresh();
      fs.writeFileSync(h.settingsPath, "{ not json");
      const r = await level(h, "add a settings page");
      assert.equal(r.code, 2);
      assert.equal(fake.requests.length, 0);
    });
  });

  describe("B11 stages, without Jev", () => {
    for (const id of ["small", "medium", "large"]) {
      it(`stages ${id} prints its stage line`, async () => {
        const h = fresh();
        const r = await d(h, ["stages", id]);
        expectOut(r, `${id}: ${STAGE_LINE[id]}`);
        assert.equal(fake.requests.length, 0);
        nothingQueued(h, `stages ${id}`);
      });
    }

    it("stages --json prints the stages as one JSON line", async () => {
      const r = await d(fresh(), ["stages", "--json", "large"]);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '{"plan":true,"implement":"agents","test":true,"verify":"ui","design":"ui","review":true,"fixRounds":2}\n');
    });

    it("stages huge exits 2", async () => {
      const r = await d(fresh(), ["stages", "huge"]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /huge/);
    });

    it("follows an edit of settings.json", async () => {
      const h = fresh();
      h.edit((doc) => void Object.assign(doc.levels[1].stages, { review: false, fixRounds: 3 }));
      expectOut(await d(h, ["stages", "medium"]), "medium: plan off, implement self, test on, verify ui, design ui, review off, fix rounds 3");
    });
  });

  describe("B12 JSON output", () => {
    it("level --json prints one line: the D3 object, keys in D3 order", async () => {
      const h = fresh();
      fake.answer("level", LEVEL_ANSWER);
      const r = await d(h, ["level", "--json", "--repo", acme, "--", "add a settings page"]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.trim().split("\n").length, 1);
      assertEntry(JSON.parse(r.stdout), { point: "level", value: "medium", source: "jev", repo: "acme" });
      assert.equal(fs.existsSync(h.logFile), false, "logs/decisions.jsonl is not written");
    });

    it("recipe --json and ui --json print the D3 object too", async () => {
      const h = fresh();
      alphaBeta(h);
      fake.answer("recipe", { none: 0.1, alpha: 0.8, beta: 0.1 });
      fake.answer("ui", 0.9);
      const a = decision(await d(h, ["recipe", "--json", "--repo", acme, "--", "deploy the api"]));
      const b = decision(await d(h, ["ui", "--json", acme]));
      assertEntry(a, { point: "recipe", value: "alpha", source: "jev" });
      assertEntry(b, { point: "ui", value: "yes", source: "jev" });
    });

    it("a fallback and an override print the D3 object as JSON as well", async () => {
      const h = fresh({ env: null });
      const a = decision(await d(h, ["level", "--json", "--repo", acme, "--", "add a page"]));
      const b = decision(await d(h, ["level", "--json", "--repo", acme, "--", "large add a page"]));
      assert.equal(a.reason, "no-key");
      assert.equal(b.source, "override");
      assertShape(a);
      assertShape(b);
    });

    it("the line printed without --json says what the object says", async () => {
      const cases = [
        { name: "jev", opts: {}, answer: LEVEL_ANSWER, task: "add a settings page" },
        { name: "fallback", opts: { env: null }, answer: null, task: "add a settings page" },
        { name: "override", opts: {}, answer: null, task: "large add a settings page" },
      ];
      for (const c of cases) {
        const plain = fresh(c.opts);
        const json = makeHarness(s, c.opts);
        if (c.answer) fake.answer("level", c.answer);
        const line = (await level(plain, c.task)).stdout;
        const object = decision(await levelJson(json, c.task));
        assert.equal(line, `${lineOf(object)}\n`, c.name);
      }
    });

    it("start --json prints level, recipe and stages, and queues the session events", async () => {
      const h = fresh();
      alphaBeta(h);
      fake.answer("level", LEVEL_ANSWER);
      fake.answer("recipe", { none: 0.1, alpha: 0.8, beta: 0.1 });
      const r = await d(h, ["start", "--json", "--session", "s1", "--repo", acme, "--", "add a settings page"]);
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(Object.keys(out), ["level", "recipe", "stages"]);
      assertShape(out.level);
      assertShape(out.recipe);
      assert.equal(out.level.value, "medium");
      assert.equal(out.recipe.value, "alpha");
      assert.deepEqual(out.stages, { plan: false, implement: "self", test: true, verify: "ui", design: "ui", review: true, fixRounds: 1 });
      assert.deepEqual(h.events().map((e) => e.kind), ["session", "decision", "decision"]);
      assert.equal(fs.existsSync(h.logFile), false);
    });

    it("start --json without recipes has recipe null", async () => {
      const h = fresh();
      fake.answer("level", LEVEL_ANSWER);
      const r = await d(h, ["start", "--json", "--session", "s1", "--repo", acme, "--", "add a settings page"]);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(Object.keys(out), ["level", "recipe", "stages"]);
      assert.equal(out.recipe, null);
      assert.deepEqual(h.events().map((e) => e.kind), ["session", "decision"]);
    });
  });

  describe("B13 start prints the context block", () => {
    it("with recipes: exactly three lines, the recipe line ends with the recipe's path", async () => {
      const h = fresh();
      const alpha = alphaBeta(h);
      fake.answer("level", LEVEL_ANSWER);
      fake.answer("recipe", { none: 0.1, alpha: 0.8, beta: 0.1 });
      const r = await d(h, ["start", "--session", "s1", "--repo", acme, "--", "add a settings page"]);
      expectOut(r, [BLOCK, `- Level: medium (jev, 0.70). Stages: ${STAGE_LINE.medium}.`, `- Recipe: alpha (jev, 0.70): ${alpha}`].join("\n"));
      assert.equal(alpha, path.join(h.dir, "cache", "recipes", "acme", "alpha.md"));
      assert.equal(fake.requests.length, 2);
      assert.deepEqual(h.events().filter((e) => e.kind === "decision").map((e) => e.point).sort(), ["level", "recipe"]);
    });

    it("without recipes: the two-line block, and one request", async () => {
      const h = fresh();
      fake.answer("level", LEVEL_ANSWER);
      const r = await d(h, ["start", "--repo", acme, "--", "add a settings page"]);
      expectOut(r, [BLOCK, `- Level: medium (jev, 0.70). Stages: ${STAGE_LINE.medium}.`].join("\n"));
      assert.equal(fake.requests.length, 1);
    });

    it("a level word overrides the level but the recipe is still decided on the rest of the task", async () => {
      const h = fresh();
      const alpha = alphaBeta(h);
      fake.answer("recipe", { none: 0.1, alpha: 0.8, beta: 0.1 });
      const r = await d(h, ["start", "--repo", acme, "--", "large deploy the api"]);
      expectOut(r, [BLOCK, `- Level: large (override, first-word). Stages: ${STAGE_LINE.large}.`, `- Recipe: alpha (jev, 0.70): ${alpha}`].join("\n"));
      assert.equal(fake.requests.length, 1);
      assert.equal(fake.requests[0].body.state, "deploy the api");
    });

    it("a recipe decision of none still has its line", async () => {
      const h = fresh();
      alphaBeta(h);
      fake.answer("level", LEVEL_ANSWER);
      fake.answer("recipe", { none: 0.8, alpha: 0.1, beta: 0.1 });
      const r = await d(h, ["start", "--repo", acme, "--", "rename a variable"]);
      const lines = r.stdout.trimEnd().split("\n");
      assert.equal(lines.length, 3);
      assert.match(lines[2], /^- Recipe: none \(jev, 0\.70\)/);
    });

    it("works without a key: fallbacks, still exit 0", async () => {
      const h = fresh({ env: null });
      alphaBeta(h);
      const r = await d(h, ["start", "--repo", acme, "--", "add a settings page"]);
      assert.equal(r.code, 0);
      const lines = r.stdout.trimEnd().split("\n");
      assert.equal(lines[0], BLOCK);
      assert.equal(lines[1], `- Level: medium (fallback, no-key). Stages: ${STAGE_LINE.medium}.`);
      assert.match(lines[2], /^- Recipe: none \(fallback, no-key\)/);
      assert.equal(fake.requests.length, 0);
    });

    it("asks level and recipe at the same time", async () => {
      const h = fresh();
      alphaBeta(h);
      fake.mode("delay:400");
      const r = await d(h, ["start", "--repo", acme, "--", "add a settings page"]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(fake.requests.length, 2);
      assert.equal(fake.maxInFlight, 2, "both requests were in flight together");
    });

    it("the block does not mention a decision log", async () => {
      const r = await d(fresh(), ["start", "--repo", acme, "--", "small fix"]);
      assert.ok(!/decisions\.jsonl|logged in/.test(r.stdout), r.stdout);
    });
  });

  describe("how a task and a harness are given", () => {
    it("takes the task as several words", async () => {
      const h = fresh();
      fake.answer("level", LEVEL_ANSWER);
      expectOut(await d(h, ["level", "--repo", acme, "--", "add", "a", "settings", "page"]), "level: medium (jev, 0.70)");
      assert.equal(fake.requests[0].body.state, "add a settings page");
    });

    it("treats composed and decomposed accents as the same task", async () => {
      const h = fresh();
      fake.answer("level", LEVEL_ANSWER);
      await level(h, "fix the café menu");
      assert.equal(fake.requests[0].body.state, "fix the café menu");
      expectOut(await level(h, "fix the café menu"), "level: medium (cache, 0.70)");
      assert.equal(fake.requests.length, 1);
    });

    it("accepts a relative HARNESS_DIR and prints absolute recipe paths", async () => {
      const h = fresh();
      const alpha = alphaBeta(h);
      fake.answer("level", LEVEL_ANSWER);
      fake.answer("recipe", { none: 0.1, alpha: 0.8, beta: 0.1 });
      const r = await run(DECIDE, ["start", "--repo", acme, "--", "add a settings page"], {
        env: s.env({ HARNESS_DIR: path.basename(h.dir), TYPESAFE_BASE_URL: fake.url }),
        cwd: path.dirname(h.dir),
      });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.stdout.trimEnd().endsWith(`: ${alpha}`), r.stdout);
    });

    it("uses the harness the script lives in when HARNESS_DIR is not set, also through a symlink", async () => {
      fake.reset();
      const installed = s.dir("installed");
      fs.mkdirSync(path.join(installed, "bin"));
      for (const script of [DECIDE, SESSION_LOG]) {
        const target = path.join(installed, "bin", path.basename(script));
        fs.copyFileSync(script, target);
        fs.chmodSync(target, 0o755);
      }
      fs.copyFileSync(SETTINGS_FILE, path.join(installed, "settings.json"));
      fs.copyFileSync(SCHEMA_FILE, path.join(installed, "settings.schema.json"));
      const link = path.join(s.root, "agent-harness-link");
      fs.symlinkSync(installed, link);
      const r = await run(path.join(link, "bin", "decide"), ["start", "--session", "s5", "--repo", acme, "--", "small tidy the docs"], {
        env: s.env({ TYPESAFE_BASE_URL: closedUrl }),
        cwd: s.root,
      });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.stdout.includes("Level: small (override, first-word)"), r.stdout);
      assert.equal(fs.existsSync(path.join(installed, "logs", "decisions.jsonl")), false);
      const outbox = path.join(installed, "logs", "session-outbox");
      const events = fs.readdirSync(outbox).filter((name) => name.endsWith(".json"));
      assert.equal(events.length, 2, "the session and the level decision are queued in the harness the script lives in");
    });

    it("an unwritable logs folder does not stop a decision", async () => {
      const h = fresh();
      fs.writeFileSync(path.join(h.dir, "logs"), "this is a file, not a directory");
      const r = await level(h, "large rewrite the store");
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "level: large (override, first-word)\n");
      const started = await d(h, ["start", "--session", "s1", "--repo", acme, "--", "large rewrite the store"]);
      assert.equal(started.code, 0, started.stderr);
      assert.equal(started.stdout.split("\n")[0], BLOCK);
    });
  });

  describe("the ui decision's input", () => {
    it("is cached by the changes: the same changes hit, a new commit asks again", async () => {
      const h = fresh();
      const repo = makeUiRepo(s, "cachedui");
      fake.answer("ui", 0.9);
      expectOut(await d(h, ["ui", repo]), "ui: yes (jev, 0.80)");
      expectOut(await d(h, ["ui", repo]), "ui: yes (cache, 0.80)");
      assert.equal(fake.requests.length, 1);
      s.git(repo, "commit", "-q", "--allow-empty", "-m", "chore: more");
      expectOut(await d(h, ["ui", repo]), "ui: yes (jev, 0.80)");
      assert.equal(fake.requests.length, 2);
      assert.ok(fake.requests[1].body.state.endsWith("commits:\nfeat: page\ndocs: readme\nchore: more"));
    });

    it("caps the state at 300 paths and 100 commit subjects, oldest commits first", async () => {
      const h = fresh();
      const big = makeRepo(s, "bigrepo");
      fs.mkdirSync(`${big}.handoff`, { recursive: true });
      fs.writeFileSync(`${big}.handoff/base`, `${s.git(big, "rev-parse", "HEAD")}\n`);
      for (let i = 0; i < 320; i++) fs.writeFileSync(path.join(big, `file-${String(i).padStart(3, "0")}.txt`), `${i}\n`);
      s.git(big, "add", "--", ".");
      s.git(big, "commit", "-q", "-m", "feat: many files");
      for (let i = 0; i < 104; i++) s.git(big, "commit", "-q", "--allow-empty", "-m", `chore: step ${i}`);
      fake.answer("ui", 0.9);
      expectOut(await d(h, ["ui", big]), "ui: yes (jev, 0.80)");
      const [paths, commits] = fake.requests[0].body.state.split("\ncommits:\n");
      const pathLines = paths.split("\n").slice(1);
      const commitLines = commits.split("\n");
      assert.equal(pathLines.length, 300);
      assert.deepEqual(pathLines, [...pathLines].sort());
      assert.equal(pathLines[0], "file-000.txt");
      assert.equal(pathLines[299], "file-299.txt");
      assert.equal(commitLines.length, 100);
      assert.equal(commitLines[0], "feat: many files");
    });
  });

  describe("custom levels: the levels come from settings.json", () => {
    const custom = () => {
      const doc = clone(base);
      doc.levels = ["tiny", "small", "medium", "huge"].map((id, i) => ({
        ...clone(base.levels[Math.min(i, 2)]),
        id,
        label: id,
        description: `${id} tasks`,
      }));
      return doc;
    };

    it("asks over the configured level ids and falls back to the more thorough of the top two", async () => {
      const h = fresh({ settings: custom() });
      fake.answer("level", { tiny: 0.1, small: 0.2, medium: 0.3, huge: 0.4 });
      expectOut(await level(h, "tune the build"), "level: huge (fallback, low-confidence)");
      assert.deepEqual(Object.keys(fake.requests[0].body.questions.level.criteria), ["tiny", "small", "medium", "huge"]);
      assert.equal(fake.requests[0].body.questions.level.criteria.huge, "huge tasks");
    });

    it("inline is the first level and loop the last", async () => {
      const h = fresh({ settings: custom() });
      expectOut(await level(h, "inline fix a typo"), "level: tiny (override, first-word)");
      expectOut(await level(h, "loop rewrite everything"), "level: huge (override, first-word)");
      expectOut(await level(h, "medium tidy up"), "level: medium (override, first-word)");
    });

    it("without an answer the fallback is the second level", async () => {
      const h = fresh({ settings: custom(), env: null });
      expectOut(await level(h, "tune the build"), "level: small (fallback, no-key)");
    });

    it("start queues the custom level in the session event", async () => {
      const h = fresh({ settings: custom(), env: null });
      await d(h, ["start", "--session", "s1", "--repo", acme, "--", "huge rewrite everything"]);
      assert.equal(h.events()[0].level, "huge");
    });
  });

  // ---------- the session log (sessions plan S6, checks B1 to B5) ----------
  // B4 is the earlier B1 to B13 above, with the two changes: the decision a run printed with --json is the D3
  // object (keys in D3 order), and the block text no longer says where decisions are logged.

  describe("SB1 start queues the session and its decisions for the session log", () => {
    const bare = (event) => {
      const { at, ...rest } = event;
      assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "at");
      return rest;
    };

    it("a level word: the block on stdout, a session and the level decision in the outbox, no decisions.jsonl", async () => {
      const h = fresh();
      const r = await d(h, ["start", "--session", "s9", "--repo", acme, "--", "small fix the readme typo"]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.split("\n")[0], BLOCK);
      assert.equal(h.events().length, 2);
      assert.deepEqual(h.events().map(bare), [
        { v: 1, kind: "session", session_id: "s9", repo: "o/acme", title: "fix the readme typo", level: "small" },
        { v: 1, kind: "decision", session_id: "s9", repo: "o/acme", point: "level", value: "small", confidence: null, source: "override" },
      ]);
      const times = h.events().map((e) => Date.parse(e.at));
      assert.deepEqual(times, [...times].sort((a, b) => a - b));
      assert.equal(fs.existsSync(h.logFile), false, "logs/decisions.jsonl does not exist");
    });

    it("with recipes and a Jev key, a third event follows: the recipe decision", async () => {
      const h = fresh();
      const alpha = alphaBeta(h);
      fake.answer("recipe", { none: 0.1, alpha: 0.8, beta: 0.1 });
      const r = await d(h, ["start", "--session", "s9", "--repo", acme, "--", "small deploy the api"]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.stdout.includes(alpha), r.stdout);
      const events = h.events().map(bare);
      assert.equal(events.length, 3);
      assert.deepEqual(events.slice(0, 2).map((e) => e.kind), ["session", "decision"]);
      assert.deepEqual(events[2], { v: 1, kind: "decision", session_id: "s9", repo: "o/acme", point: "recipe", value: "alpha", confidence: 0.7, source: "jev" });
    });

    it("a task without a level word: the whole task is the title and the decided level is the level", async () => {
      const h = fresh();
      fake.answer("level", LEVEL_ANSWER);
      await d(h, ["start", "--session", "s9", "--repo", acme, "--", "add a settings page"]);
      const [session, decided] = h.events();
      assert.equal(session.title, "add a settings page");
      assert.equal(session.level, "medium");
      assert.equal(decided.source, "jev");
      assert.equal(decided.confidence, 0.7);
    });

    it("a task that is only a level word has no title", async () => {
      const h = fresh();
      await d(h, ["start", "--session", "s9", "--repo", acme, "--", "small"]);
      assert.equal(h.events()[0].title, null);
      assert.equal(h.events()[0].level, "small");
    });

    it("a fallback decision is queued as a fallback", async () => {
      const h = fresh({ env: null });
      await d(h, ["start", "--session", "s9", "--repo", acme, "--", "add a settings page"]);
      const decided = h.events()[1];
      assert.equal(decided.source, "fallback");
      assert.equal(decided.value, "medium");
      assert.equal(decided.confidence, null);
    });

    it("an invalid session id queues nothing, and the block still prints", async () => {
      const h = fresh();
      for (const id of ["../x", "a b", "x".repeat(129)]) {
        const r = await d(h, ["start", "--session", id, "--repo", acme, "--", "small fix"]);
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.stdout.split("\n")[0], BLOCK);
      }
      nothingQueued(h, "invalid session ids");
    });

    it("--json with --session prints the object and queues the events", async () => {
      const h = fresh();
      const r = await d(h, ["start", "--json", "--session", "s9", "--repo", acme, "--", "small fix"]);
      assert.equal(JSON.parse(r.stdout).level.value, "small");
      assert.equal(h.events().length, 2);
    });
  });

  describe("SB2 the session id", () => {
    it("CLAUDE_CODE_SESSION_ID is used without --session", async () => {
      const h = fresh();
      await d(h, ["start", "--repo", acme, "--", "small fix the readme typo"], { env: { CLAUDE_CODE_SESSION_ID: "s10" } });
      assert.deepEqual(h.events().map((e) => [e.kind, e.session_id]), [["session", "s10"], ["decision", "s10"]]);
    });

    it("--session wins over CLAUDE_CODE_SESSION_ID", async () => {
      const h = fresh();
      await d(h, ["start", "--session", "s9", "--repo", acme, "--", "small fix"], { env: { CLAUDE_CODE_SESSION_ID: "s10" } });
      assert.deepEqual([...new Set(h.events().map((e) => e.session_id))], ["s9"]);
    });

    it("with neither, no file is written", async () => {
      const h = fresh();
      const r = await d(h, ["start", "--repo", acme, "--", "small fix the readme typo"]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(fs.existsSync(h.outboxDir), false, "no outbox");
      assert.equal(fs.existsSync(h.logFile), false);
    });

    it("level writes no file, with a session id from the environment too", async () => {
      const h = fresh({ env: null });
      expectOut(await d(h, ["level", "--", "x"], { env: { CLAUDE_CODE_SESSION_ID: "s10" } }), "level: medium (fallback, no-key)");
      assert.equal(fs.existsSync(h.outboxDir), false);
      assert.equal(fs.existsSync(h.logFile), false);
    });

    it("recipe writes no file either", async () => {
      const h = fresh();
      alphaBeta(h);
      const r = await d(h, ["recipe", "--repo", acme, "--", "deploy"], { env: { CLAUDE_CODE_SESSION_ID: "s10" } });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(fs.existsSync(h.outboxDir), false);
    });
  });

  describe("SB3 the ui decision", () => {
    it("with CLAUDE_CODE_SESSION_ID, it queues one decision event", async () => {
      const h = fresh();
      fake.answer("ui", 0.9);
      const r = await d(h, ["ui", acme], { env: { CLAUDE_CODE_SESSION_ID: "s9" } });
      expectOut(r, "ui: yes (jev, 0.80)");
      const events = h.events();
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, "decision");
      assert.equal(events[0].session_id, "s9");
      assert.equal(events[0].point, "ui");
      assert.equal(events[0].value, "yes");
      assert.equal(events[0].confidence, 0.8);
      assert.equal(events[0].source, "jev");
      assert.equal(events[0].repo, "o/acme");
      assert.equal(fs.existsSync(h.logFile), false);
    });

    it("--session may come before or after the worktree", async () => {
      const h = fresh();
      await d(h, ["ui", "--session", "s1", acme]);
      await d(h, ["ui", acme, "--session", "s2"]);
      assert.deepEqual(h.events().map((e) => e.session_id), ["s1", "s2"]);
    });

    it("without a session id, nothing is queued", async () => {
      const h = fresh();
      const r = await ui(h);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(fs.existsSync(h.outboxDir), false);
    });
  });

  describe("SB5 the title is clipped", () => {
    it("a 300-character task gives a title of 200 code points ending in an ellipsis", async () => {
      const h = fresh();
      await d(h, ["start", "--session", "s9", "--repo", acme, "--", `small ${"x".repeat(300)}`]);
      const title = h.events()[0].title;
      assert.equal([...title].length, 200);
      assert.equal(title, `${"x".repeat(199)}…`);
    });

    it("counts code points, and collapses whitespace", async () => {
      const h = fresh();
      await d(h, ["start", "--session", "s9", "--repo", acme, "--", `small ${"😀".repeat(250)}`]);
      assert.equal(h.events()[0].title, `${"😀".repeat(199)}…`);
      await d(h, ["start", "--session", "s8", "--repo", acme, "--", "small   fix \t the\n\nreadme"]);
      assert.equal(h.events().at(-2).title, "fix the readme");
    });

    it("a task of exactly 200 characters keeps its text", async () => {
      const h = fresh();
      await d(h, ["start", "--session", "s9", "--repo", acme, "--", `small ${"y".repeat(200)}`]);
      assert.equal(h.events()[0].title, "y".repeat(200));
    });
  });

  describe("the session log never blocks a decision, and a key turns it on", () => {
    it("with Supabase slow, start returns at once and the outbox keeps the events", async (t) => {
      const supabase = await startFakeSupabase();
      t.after(() => supabase.close());
      supabase.mode("delay:6000");
      const h = fresh({ env: supabaseEnv(supabase.url) });
      const r = await d(h, ["start", "--session", "s9", "--repo", acme, "--", "small fix"]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.split("\n")[0], BLOCK);
      assert.ok(r.ms < 2500, `took ${r.ms} ms`);
      await until(() => supabase.requests.length >= 1, { ms: 5000, what: "the background flush's first request" });
      assert.equal(h.events().length, 2, "the events stay until they are written");
    });

    it("with the keys set, the background flusher writes the session, its level and the decision", async (t) => {
      const supabase = await startFakeSupabase();
      t.after(() => supabase.close());
      const h = fresh({ env: `TYPESAFE_API_KEY=test-key\n${supabaseEnv(supabase.url)}` });
      const r = await d(h, ["start", "--session", "s9", "--repo", acme, "--", "small fix the readme typo"]);
      assert.equal(r.code, 0, r.stderr);
      await drained(h);
      const posts = supabase.requests.filter((q) => q.method === "POST").map((q) => q.path);
      assert.deepEqual(posts, ["/rest/v1/cockpit_sessions?on_conflict=id", "/rest/v1/cockpit_decisions?on_conflict=session_id,point,at"]);
      assert.equal(supabase.requests[0].body.title, "fix the readme typo");
      assert.equal(supabase.requests[0].body.level, "small");
      for (const q of supabase.requests) assert.equal(q.apikey, "sb_secret_test");
      assert.equal(fs.existsSync(h.logFile), false);
    });

    it("without the keys the events wait and nothing is sent", async () => {
      const h = fresh();
      await d(h, ["start", "--session", "s9", "--repo", acme, "--", "small fix"]);
      assert.equal(h.events().length, 2);
      assert.equal(fs.existsSync(path.join(h.outboxDir, ".lock")), false);
    });
  });
});
