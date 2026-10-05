// Shared helpers for the harness tests: a scratch directory with its own HOME, a scratch HARNESS_DIR,
// process runners, git fixtures and a small JSON Schema validator. Every process the tests start gets
// the scratch HOME and an explicit environment, so nothing reaches the real ~, ~/.agent-harness or
// ~/.claude, and bin/decide and bin/session-log are only ever pointed at a loopback URL (a fake Jev or
// Supabase, or a closed port).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DECIDE = path.join(REPO, "bin", "decide");
export const SESSION_LOG = path.join(REPO, "bin", "session-log");
export const HOOK = path.join(REPO, "hooks", "decide-context.sh");
export const SESSION_HOOK = path.join(REPO, "hooks", "session-log.sh");
export const GUARD = path.join(REPO, "hooks", "guard.sh");
export const SETUP = path.join(REPO, "setup.sh");
export const SETTINGS_FILE = path.join(REPO, "settings.json");
export const SCHEMA_FILE = path.join(REPO, "settings.schema.json");

// The keys of the decision object `bin/decide --json` prints (D3), in order.
export const DECISION_KEYS = ["v", "time", "point", "value", "confidence", "probabilities", "source", "reason", "model", "inputHash", "repo", "ms"];

// The only secret the tests use, and the file names of an outbox event.
export const SECRET = "sb_secret_test";
export const EVENT_NAME = /^\d{13}-\d+-\d{4}\.json$/;

export const canonical = (doc) => `${JSON.stringify(doc, null, 2)}\n`;
export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export const clone = (doc) => JSON.parse(JSON.stringify(doc));

// ---------- processes ----------

// The environment of every process the tests start, built from scratch: nothing of the tester's own
// environment but PATH, so a Claude Code session id or a key in it never reaches a child. `extra` adds to
// it, and is the one place a test sets CLAUDE_CODE_SESSION_ID.
export function baseEnv(home, extra = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    LANG: "en_US.UTF-8",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    CLAUDE_CODE_SESSION_ID: undefined,
    ...extra,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined || env[key] === null) delete env[key];
  return env;
}

// Asynchronous on purpose: a fake Jev in this process must keep answering while the child runs.
export function run(cmd, args, { env, cwd, input, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(cmd, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeoutMs} ms: ${cmd} ${args.join(" ")}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

// A loopback URL nothing listens on: a refused connection, never the real API.
export async function deadUrl() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

// ---------- scratch directories ----------

export function scratch(prefix = "harness-test-") {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  let n = 0;
  return {
    root,
    home,
    dir(name = "d") {
      const dir = path.join(root, `${name}-${++n}`);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    env: (extra = {}) => baseEnv(home, extra),
    git: (dir, ...args) =>
      execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: baseEnv(home), stdio: ["ignore", "pipe", "pipe"] }).trim(),
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// A git repo on a branch with one commit; `name` is its folder name (its "main checkout folder"), `origin`
// the URL of its origin remote (none by default; it is never contacted).
export function makeRepo(s, name, { branch = "main", parent = s.root, origin } = {}) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  s.git(dir, "init", "-q", "-b", branch);
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  s.git(dir, "add", "--", ".gitkeep");
  s.git(dir, "commit", "-q", "-m", "chore: init");
  if (origin) s.git(dir, "remote", "add", "origin", origin);
  return dir;
}

export function commitFile(s, dir, file, content, message) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  s.git(dir, "add", "--", file);
  s.git(dir, "commit", "-q", "-m", message);
}

// S/acme with a base commit recorded in S/acme.handoff/base and two commits after it.
export function makeUiRepo(s, name = "acme", opts = {}) {
  const dir = makeRepo(s, name, opts);
  fs.mkdirSync(`${dir}.handoff`, { recursive: true });
  fs.writeFileSync(path.join(`${dir}.handoff`, "base"), `${s.git(dir, "rev-parse", "HEAD")}\n`);
  commitFile(s, dir, "src/app/page.tsx", "export const Page = () => null;\n", "feat: page");
  commitFile(s, dir, "README.md", "# acme\n", "docs: readme");
  return dir;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls `check` until it returns something truthy, which it returns; throws after `ms`.
export async function until(check, { ms = 15_000, step = 50, what = "a condition" } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= end) throw new Error(`gave up after ${ms} ms waiting for ${what}`);
    await sleep(step);
  }
}

const eventNames = (folder) => {
  try {
    return fs.readdirSync(folder).filter((name) => EVENT_NAME.test(name)).sort();
  } catch {
    return [];
  }
};

// "Drained": the outbox holds no *.json and no .lock (a missing outbox counts); waits up to `ms`.
export async function drained(h, ms = 15_000) {
  const left = () => {
    try {
      return fs.readdirSync(h.outboxDir).filter((name) => name.endsWith(".json") || name === ".lock");
    } catch {
      return [];
    }
  };
  try {
    await until(() => left().length === 0, { ms, what: "the outbox to drain" });
  } catch {
    throw new Error(`the outbox did not drain within ${ms} ms; left: ${left().join(", ")}`);
  }
}

// A scratch HARNESS_DIR: settings.json (the repo's, or `settings`), .env with a key (or the text `env`),
// optional recipes. `events()` are the session-log events that bin/decide and the hooks queued in its
// logs/session-outbox/, oldest first.
export function makeHarness(s, { key = "test-key", env, settings } = {}) {
  const dir = s.dir("h");
  const settingsPath = path.join(dir, "settings.json");
  const outboxDir = path.join(dir, "logs", "session-outbox");
  const h = {
    dir,
    settingsPath,
    // bin/decide writes no decision log any more: tests assert this file stays absent.
    logFile: path.join(dir, "logs", "decisions.jsonl"),
    outboxDir,
    rejectedDir: path.join(outboxDir, "rejected"),
    settings: () => readJson(settingsPath),
    edit(fn) {
      const doc = h.settings();
      const next = fn(doc) ?? doc;
      fs.writeFileSync(settingsPath, canonical(next));
      return next;
    },
    setEnv: (text) => fs.writeFileSync(path.join(dir, ".env"), text),
    eventFiles: () => eventNames(outboxDir),
    events: () => eventNames(outboxDir).map((name) => readJson(path.join(outboxDir, name))),
    rejectedFiles: () => eventNames(path.join(outboxDir, "rejected")),
    cacheFiles() {
      try {
        return fs.readdirSync(path.join(dir, "logs", "decisions")).sort();
      } catch {
        return [];
      }
    },
    recipe(repo, name, firstLine) {
      const folder = path.join(dir, "cache", "recipes", repo);
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, `${name}.md`);
      fs.writeFileSync(file, `${firstLine}\n\n- a step\n`);
      return file;
    },
  };
  fs.writeFileSync(settingsPath, settings ? canonical(settings) : fs.readFileSync(SETTINGS_FILE));
  if (env !== null) fs.writeFileSync(path.join(dir, ".env"), env ?? (key ? `TYPESAFE_API_KEY=${key}\n` : ""));
  return h;
}

// Runs bin/decide against a scratch harness. `url` is required: a fake Jev or a closed port, never the real API.
export function decide(s, h, args, { url, env, cwd, timeoutMs } = {}) {
  if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error("decide(): pass a loopback url (the fake Jev or a closed port)");
  return run(DECIDE, args, { env: s.env({ HARNESS_DIR: h.dir, TYPESAFE_BASE_URL: url, ...env }), cwd: cwd ?? s.root, timeoutMs });
}

// The .env lines that turn the session log on: a loopback URL (a fake Supabase or a closed port), never the real project.
export function supabaseEnv(url, secret = SECRET) {
  if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error("supabaseEnv(): pass a loopback url (the fake Supabase or a closed port)");
  return `COCKPIT_SUPABASE_URL=${url}\nCOCKPIT_SUPABASE_SECRET_KEY=${secret}\n`;
}

// Runs bin/session-log against a scratch harness, with its own HARNESS_DIR and the explicit scratch environment.
export function sessionLog(s, h, args, { env, input, cwd, timeoutMs } = {}) {
  return run(SESSION_LOG, args, { env: s.env({ HARNESS_DIR: h.dir, ...env }), cwd: cwd ?? s.root, input, timeoutMs });
}

// ---------- JSON Schema ----------

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function typeOk(type, v) {
  switch (type) {
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "null":
      return v === null;
    case "array":
      return Array.isArray(v);
    case "object":
      return isObject(v);
    default:
      return typeof v === type;
  }
}

// A small JSON Schema 2020-12 validator for settings.schema.json: type, enum, const, minimum, maximum,
// minLength, maxLength, pattern, minItems, maxItems, items, uniqueItemProperties (ajv-keywords), required,
// properties, additionalProperties and if/then/else. → [{ at: [...path], message }]
export function validateSchema(schema, value) {
  const errors = [];
  walk(schema, value, [], errors);
  return errors;
}

function walk(s, v, at, errors) {
  if (s === true) return;
  if (s === false) return void errors.push({ at, message: "not allowed" });
  if (s.type !== undefined) {
    const types = [].concat(s.type);
    if (!types.some((type) => typeOk(type, v))) return void errors.push({ at, message: `type must be ${types.join(" or ")}` });
  }
  if ("const" in s && !sameValue(v, s.const)) return void errors.push({ at, message: `must equal ${JSON.stringify(s.const)}` });
  if (s.enum && !s.enum.some((e) => sameValue(v, e))) return void errors.push({ at, message: "not in enum" });
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) errors.push({ at, message: `below ${s.minimum}` });
    if (s.maximum !== undefined && v > s.maximum) errors.push({ at, message: `above ${s.maximum}` });
  }
  if (typeof v === "string") {
    const length = [...v].length;
    if (s.minLength !== undefined && length < s.minLength) errors.push({ at, message: `shorter than ${s.minLength}` });
    if (s.maxLength !== undefined && length > s.maxLength) errors.push({ at, message: `longer than ${s.maxLength}` });
    if (s.pattern !== undefined && !new RegExp(s.pattern, "u").test(v)) errors.push({ at, message: `does not match ${s.pattern}` });
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) errors.push({ at, message: `fewer than ${s.minItems} items` });
    if (s.maxItems !== undefined && v.length > s.maxItems) errors.push({ at, message: `more than ${s.maxItems} items` });
    if (s.items !== undefined) v.forEach((item, i) => walk(s.items, item, [...at, i], errors));
    for (const key of s.uniqueItemProperties || []) {
      const seen = new Set();
      v.forEach((item, i) => {
        if (!isObject(item) || !(key in item)) return;
        const id = JSON.stringify(item[key]);
        if (seen.has(id)) errors.push({ at: [...at, i, key], message: `duplicate ${key}` });
        seen.add(id);
      });
    }
  }
  if (isObject(v)) {
    const props = s.properties || {};
    for (const key of s.required || []) if (!(key in v)) errors.push({ at: [...at, key], message: "missing" });
    for (const key of Object.keys(v)) {
      if (key in props) walk(props[key], v[key], [...at, key], errors);
      else if (s.additionalProperties === false) errors.push({ at: [...at, key], message: "unknown key" });
      else if (isObject(s.additionalProperties)) walk(s.additionalProperties, v[key], [...at, key], errors);
    }
  }
  if (s.if !== undefined) {
    const probe = [];
    walk(s.if, v, at, probe);
    if (probe.length === 0) {
      if (s.then !== undefined) walk(s.then, v, at, errors);
    } else if (s.else !== undefined) walk(s.else, v, at, errors);
  }
}

// ["levels", 1, "stages", "plan"] → "levels[1].stages.plan"
export function pathString(at) {
  let out = "";
  for (const seg of at) out += typeof seg === "number" ? `[${seg}]` : out ? `.${seg}` : seg;
  return out || "$";
}
