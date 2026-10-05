// H-A: settings.json and settings.schema.json (plan D1).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { DECIDE, REPO, SCHEMA_FILE, SETTINGS_FILE, canonical, clone, pathString, readJson, run, scratch, validateSchema } from "./helpers.mjs";

const s = scratch("harness-settings-");
const schema = readJson(SCHEMA_FILE);
const base = readJson(SETTINGS_FILE);

const checkFile = (file) => run(DECIDE, ["check", file], { env: s.env({ HARNESS_DIR: s.root }) });
const firstLine = (r) => `${r.stdout}${r.stderr}`.split("\n").find(Boolean) || "";

let docs = 0;
function writeDoc(doc) {
  const file = path.join(s.root, `doc-${++docs}.json`);
  fs.writeFileSync(file, canonical(doc));
  return file;
}

// ---------- mutations of the default document ----------

const mutations = [];
const parentOf = (doc, p) => p.slice(0, -1).reduce((o, k) => o[k], doc);
const set = (p, value) => (doc) => void (parentOf(doc, p)[p[p.length - 1]] = value);
const drop = (p) => (doc) => void delete parentOf(doc, p)[p[p.length - 1]];
const mutate = (p, label, fn, expectAt = p) => mutations.push({ name: `${pathString(p)}: ${label}`, at: expectAt, fn });
const setting = (p, value) => mutate(p, `set to ${JSON.stringify(value).slice(0, 40)}`, set(p, value));
const removed = (p) => mutate(p, "removed", drop(p));
const longText = (n) => "x".repeat(n);

for (const i of [0, 1, 2]) {
  for (const key of ["implement", "verify", "design"]) setting(["levels", i, "stages", key], "x");
  for (const value of [4, -1]) setting(["levels", i, "stages", "fixRounds"], value);
}
setting(["levels", 1, "stages", "fixRounds"], 1.5);
setting(["levels", 1, "stages", "fixRounds"], "1");
setting(["levels", 0, "stages", "plan"], "yes");
setting(["levels", 1, "stages", "test"], 1);
setting(["levels", 2, "stages", "review"], null);

for (const id of ["loop", "inline", "none", "Small", "1x", longText(25), ""]) setting(["levels", 1, "id"], id);
setting(["levels", 1, "id"], "small");
setting(["levels", 2, "id"], "medium");
for (const value of ["", longText(25)]) setting(["levels", 1, "label"], value);
for (const value of ["", longText(1001)]) setting(["levels", 1, "description"], value);
setting(["levels"], []);
setting(["levels"], {});
mutate(["levels"], "six levels", (doc) => {
  doc.levels = ["a", "b", "c", "d", "e", "f"].map((id) => ({ ...clone(doc.levels[0]), id }));
});

setting(["version"], 2);
setting(["version"], "1");
setting(["$schema"], "x");
setting(["extra"], true);

for (const value of ["jev-latest", "jev-1.13", "JEV-1.13.0", "jev-1.13.0-beta"]) setting(["decisions", "model"], value);
for (const value of [100, 499, 20001, 1000.5, "4000"]) setting(["decisions", "timeoutMs"], value);
setting(["decisions", "extra"], true);
setting(["decisions", "points", "extra"], true);

for (const point of ["level", "recipe", "ui"]) {
  const p = ["decisions", "points", point];
  for (const value of [1.5, -0.1, "0.5"]) setting([...p, "minConfidence"], value);
  for (const value of ["yes", 1]) setting([...p, "enabled"], value);
  for (const value of ["", longText(501), 5]) setting([...p, "question"], value);
  setting([...p, "extra"], true);
}
for (const value of ["", longText(501)]) setting(["decisions", "points", "recipe", "none"], value);
for (const key of ["yes", "no"]) setting(["decisions", "points", "ui", key], "");
setting(["levels", 1, "extra"], true);
setting(["levels", 1, "stages", "extra"], true);

for (const key of ["version", "levels", "decisions"]) removed([key]);
for (const key of ["id", "label", "description", "stages"]) removed(["levels", 1, key]);
for (const key of ["plan", "implement", "test", "verify", "design", "review", "fixRounds"]) removed(["levels", 1, "stages", key]);
for (const key of ["model", "timeoutMs", "points"]) removed(["decisions", key]);
for (const key of ["level", "recipe", "ui"]) removed(["decisions", "points", key]);
for (const key of ["enabled", "minConfidence", "question"]) removed(["decisions", "points", "level", key]);
for (const key of ["enabled", "minConfidence", "question", "none"]) removed(["decisions", "points", "recipe", key]);
for (const key of ["enabled", "minConfidence", "question", "yes", "no"]) removed(["decisions", "points", "ui", key]);

// Cross-field rules: implement agents needs plan; design ui needs verify.
mutate(
  ["levels", 1, "stages", "implement"],
  'medium implement "agents" with plan false',
  (doc) => void (doc.levels[1].stages.implement = "agents"),
  ["levels", 1, "stages", "plan"],
);
mutate(
  ["levels", 0, "stages", "implement"],
  'small implement "agents" with plan false',
  (doc) => void (doc.levels[0].stages.implement = "agents"),
  ["levels", 0, "stages", "plan"],
);
mutate(["levels", 2, "stages", "plan"], "large plan false with implement agents", set(["levels", 2, "stages", "plan"], false));
mutate(["levels", 1, "stages", "verify"], 'medium verify "off" with design "ui"', set(["levels", 1, "stages", "verify"], "off"), ["levels", 1, "stages"]);
mutate(["levels", 2, "stages", "verify"], 'large verify "off" with design "ui"', set(["levels", 2, "stages", "verify"], "off"), ["levels", 2, "stages"]);

// The printed path and the expected place are the same spot, or one contains the other.
const related = (a, b) => a === b || a.startsWith(`${b}.`) || a.startsWith(`${b}[`) || b.startsWith(`${a}.`) || b.startsWith(`${a}[`);

const accepted = [
  ["no $schema key", (doc) => void delete doc.$schema],
  ["a single level", (doc) => void (doc.levels = [doc.levels[0]])],
  ["five levels", (doc) => void (doc.levels = ["a", "b", "c", "d", "e"].map((id) => ({ ...clone(doc.levels[0]), id })))],
  ["fixRounds 0", (doc) => void (doc.levels[1].stages.fixRounds = 0)],
  ["fixRounds 3", (doc) => void (doc.levels[1].stages.fixRounds = 3)],
  ["minConfidence 0 and 1", (doc) => void ((doc.decisions.points.level.minConfidence = 0), (doc.decisions.points.ui.minConfidence = 1))],
  ["timeoutMs 500", (doc) => void (doc.decisions.timeoutMs = 500)],
  ["timeoutMs 20000", (doc) => void (doc.decisions.timeoutMs = 20000)],
  ["verify always with design ui", (doc) => void (doc.levels[1].stages.verify = "always")],
  ["verify off with design off", (doc) => void ((doc.levels[1].stages.verify = "off"), (doc.levels[1].stages.design = "off"))],
  ["a 24-character label and an id with a hyphen and a digit", (doc) => void ((doc.levels[1].label = longText(24)), (doc.levels[1].id = "fast-2"))],
  ["a 1000-character description and 500-character wording", (doc) => void ((doc.levels[1].description = longText(1000)), (doc.decisions.points.level.question = longText(500)))],
  ["model jev-2.0.10", (doc) => void (doc.decisions.model = "jev-2.0.10")],
  ["a point disabled", (doc) => void (doc.decisions.points.recipe.enabled = false)],
];

describe("H-A settings.json and settings.schema.json", () => {
  after(() => s.remove());

  describe("A1 the shipped settings.json", () => {
    it("is canonical JSON: 2-space indent and a final newline", () => {
      const text = fs.readFileSync(SETTINGS_FILE, "utf8");
      assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    });

    it("keeps the documented key order, so a rewrite changes only the edited line", () => {
      assert.deepEqual(Object.keys(base), ["$schema", "version", "levels", "decisions"]);
      for (const level of base.levels) {
        assert.deepEqual(Object.keys(level), ["id", "label", "description", "stages"]);
        assert.deepEqual(Object.keys(level.stages), ["plan", "implement", "test", "verify", "design", "review", "fixRounds"]);
      }
      assert.deepEqual(Object.keys(base.decisions), ["model", "timeoutMs", "points"]);
      assert.deepEqual(Object.keys(base.decisions.points), ["level", "recipe", "ui"]);
      assert.deepEqual(Object.keys(base.decisions.points.level), ["enabled", "minConfidence", "question"]);
      assert.deepEqual(Object.keys(base.decisions.points.recipe), ["enabled", "minConfidence", "question", "none"]);
      assert.deepEqual(Object.keys(base.decisions.points.ui), ["enabled", "minConfidence", "question", "yes", "no"]);
    });

    it("validates against settings.schema.json", () => {
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
      assert.deepEqual(validateSchema(schema, base), []);
    });

    it("is accepted by bin/decide check, which prints ok", async () => {
      const r = await run(DECIDE, ["check"], { env: s.env({ HARNESS_DIR: REPO }) });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "ok\n");
    });

    // Pinned to the defaults of plan D1; a deliberate change to the shipped defaults updates this test.
    it("has the default levels and stages: small, medium, large", () => {
      assert.deepEqual(
        base.levels.map((l) => l.id),
        ["small", "medium", "large"],
      );
      const stages = Object.fromEntries(base.levels.map((l) => [l.id, l.stages]));
      assert.deepEqual(stages.small, { plan: false, implement: "self", test: false, verify: "ui", design: "off", review: false, fixRounds: 1 });
      assert.deepEqual(stages.medium, { plan: false, implement: "self", test: true, verify: "ui", design: "ui", review: true, fixRounds: 1 });
      assert.deepEqual(stages.large, { plan: true, implement: "agents", test: true, verify: "ui", design: "ui", review: true, fixRounds: 2 });
      for (const level of base.levels) {
        assert.ok(level.label.length >= 1 && level.label.length <= 24, `${level.id} label`);
        assert.ok(level.description.length >= 1 && level.description.length <= 1000, `${level.id} description`);
      }
    });

    it("has the default decisions: jev-1.13.0, 4000 ms, min confidence 0.4 / 0.5 / 0.5", () => {
      const { decisions } = base;
      assert.equal(decisions.model, "jev-1.13.0");
      assert.equal(decisions.timeoutMs, 4000);
      assert.deepEqual(Object.keys(decisions.points), ["level", "recipe", "ui"]);
      assert.equal(decisions.points.level.minConfidence, 0.4);
      assert.equal(decisions.points.recipe.minConfidence, 0.5);
      assert.equal(decisions.points.ui.minConfidence, 0.5);
      for (const [name, point] of Object.entries(decisions.points)) {
        assert.equal(point.enabled, true, `${name} enabled`);
        assert.ok(point.question.length >= 1 && point.question.length <= 500, `${name} question`);
      }
      assert.ok(decisions.points.recipe.none.length >= 1);
      assert.ok(decisions.points.ui.yes.length >= 1 && decisions.points.ui.no.length >= 1);
    });
  });

  describe("A2 mutations of the default document", { concurrency: 8 }, () => {
    it("has at least 20 mutations", () => {
      assert.ok(mutations.length >= 20, `${mutations.length} mutations`);
    });

    it("the unmutated document passes the schema and bin/decide check", async () => {
      assert.deepEqual(validateSchema(schema, base), []);
      const r = await checkFile(writeDoc(base));
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.equal(r.stdout, "ok\n");
    });

    for (const m of mutations) {
      it(`rejects ${m.name}`, async () => {
        const doc = clone(base);
        m.fn(doc);
        assert.ok(validateSchema(schema, doc).length > 0, "the JSON Schema accepted the mutation");
        const r = await checkFile(writeDoc(doc));
        assert.equal(r.code, 2, `bin/decide check exit ${r.code}: ${r.stdout}${r.stderr}`);
        const line = firstLine(r);
        const printed = /^(\S+): /.exec(line);
        assert.ok(printed, `no "<json path>: <problem>" line: ${JSON.stringify(line)}`);
        assert.ok(related(printed[1], pathString(m.at)), `printed path ${printed[1]} is not at ${pathString(m.at)}: ${line}`);
      });
    }

    it('reports medium implement "agents" with plan false at levels[1].stages.plan', async () => {
      const doc = clone(base);
      doc.levels[1].stages.implement = "agents";
      assert.match(firstLine(await checkFile(writeDoc(doc))), /^levels\[1\]\.stages\.plan: /);
    });
  });

  describe("A2 documents on the boundary are accepted", { concurrency: 8 }, () => {
    for (const [name, fn] of accepted) {
      it(`accepts ${name}`, async () => {
        const doc = clone(base);
        fn(doc);
        assert.deepEqual(validateSchema(schema, doc), []);
        const r = await checkFile(writeDoc(doc));
        assert.equal(r.code, 0, r.stdout + r.stderr);
        assert.equal(r.stdout, "ok\n");
      });
    }
  });
});
