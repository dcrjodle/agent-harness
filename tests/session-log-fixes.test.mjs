// H-A round 2: bin/session-log after the sessions review, the verifier's label race and the first test round
// (the label event, the https-only URL, credentials in the remote, the bounded outbox folders, the
// control-character cleaning and the stop reason). The token lock has its own file, session-log-lock.test.mjs.
// A scratch HARNESS_DIR and its own fake Supabase on loopback per test; nothing here reaches the real
// Supabase, ~/.agent-harness or its logs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { SECRET, decide, deadUrl, drained, makeRepo, scratch, sleep, supabaseEnv } from "./helpers.mjs";
import { sessionKit } from "./session-kit.mjs";

const REST = "/rest/v1/";

describe("R2 bin/session-log fixes", () => {
  const s = scratch("harness-sessionlog-r2-");
  const acme = makeRepo(s, "acme", { origin: "git@github.com:o/acme.git" });
  const { seen, harnesses, setup, hook, flush, status, quiet, start, launched, stopped, ended } = sessionKit(s, acme);
  let closedUrl;

  before(async () => {
    closedUrl = await deadUrl();
  });
  after(() => s.remove());

  describe("the label event creates a missing row and never touches an existing one (verify-1 G2)", () => {
    for (const tool of ["Agent", "Task"]) {
      it(`${tool === "Agent" ? "an" : "a"} ${tool} spawn's label alone creates the agent's row from its subagent_type: running, open, labelled`, async (t) => {
        const { fake, h, full } = await setup(t, { secret: false });
        quiet(await hook(h, launched("r1", "Lane 1", "implementer", { tool_name: tool })));
        const [event] = h.events();
        assert.deepEqual([event.kind, event.role, event.label], ["agent_label", "implementer", "Lane 1"]);
        full();
        const r = await flush(h);
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.stdout, "sent 1, waiting 0, rejected 0\n");
        assert.deepEqual(fake.rows("cockpit_agents"), [
          { id: "r1", session_id: "s1", role: "implementer", started_at: event.at, ended_at: null, status: "running", label: "Lane 1" },
        ]);
        assert.deepEqual(fake.rows("cockpit_sessions"), [{ id: "s1", repo: "o/acme", title: null, level: null, started_at: event.at, last_at: event.at, ended_at: null }]);
      });
    }

    it("without a subagent_type the label creates no row: it only labels a row that exists", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      quiet(await hook(h, launched("r1", "Lane 1", "implementer", { tool_input: { description: "Lane 1" } })));
      assert.equal(h.events()[0].kind, "agent_label");
      full();
      assert.equal((await flush(h)).stdout, "sent 1, waiting 0, rejected 0\n");
      assert.deepEqual(fake.rows("cockpit_agents"), []);
    });

    for (const [name, stopFirst] of [
      ["a stopped agent (a foreground spawn's PostToolUse comes after its SubagentStop)", true],
      ["a running agent", false],
    ]) {
      it(`never touches an existing row: ${name} keeps its role, start, status and end`, async (t) => {
        const { fake, h, full } = await setup(t, { secret: false });
        quiet(await hook(h, start("a1")));
        if (stopFirst) quiet(await hook(h, stopped("a1")));
        quiet(await hook(h, launched("a1", "Lane 9", "tester")));
        const [began, finished] = h.events();
        full();
        assert.equal((await flush(h)).stdout, `sent ${stopFirst ? 3 : 2}, waiting 0, rejected 0\n`);
        assert.deepEqual(fake.rows("cockpit_agents"), [
          {
            id: "a1",
            session_id: "s1",
            role: "implementer",
            started_at: began.at,
            ended_at: stopFirst ? finished.at : null,
            status: stopFirst ? "done" : "running",
            label: "Lane 9",
          },
        ]);
      });
    }

    it("a later agent_start never clears a label: a start after the label, and the start of a resumed agent", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      quiet(await hook(h, launched("a1", "Lane 1", "implementer")));
      quiet(await hook(h, start("a1")));
      quiet(await hook(h, start("a2")));
      quiet(await hook(h, launched("a2", "Lane 2", "implementer")));
      quiet(await hook(h, stopped("a2")));
      quiet(await hook(h, start("a2"))); // resumed
      full();
      assert.equal((await flush(h)).stdout, "sent 6, waiting 0, rejected 0\n");
      const rows = fake.rows("cockpit_agents");
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((row) => [row.id, row.label, row.status, row.ended_at]), [
        ["a1", "Lane 1", "running", null],
        ["a2", "Lane 2", "running", null],
      ]);
    });
  });

  describe("20 agents spawned at once: every start and label, in any order, ends on its row (verify-1: 8 of 20 lost the label)", () => {
    const ROLES = ["implementer", "tester", "verifier", "reviewer"];
    const ids = Array.from({ length: 20 }, (_, i) => `b${String(i + 1).padStart(2, "0")}`);
    const events = ids.flatMap((id, i) => [
      { name: `start ${id}`, payload: start(id, { agent_type: ROLES[i % 4] }) },
      { name: `label ${id}`, payload: launched(id, `Lane ${i + 1}`, ROLES[i % 4]) },
    ]);
    const prng = (seed) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const shuffled = (items, seed) => {
      const rand = prng(seed);
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    };
    const expectRows = (fake, why) => {
      const rows = fake.rows("cockpit_agents");
      assert.equal(rows.length, 20, `${rows.length} rows; ${why}`);
      ids.forEach((id, i) => {
        const row = rows.find((r) => r.id === id);
        assert.ok(row, `${id} has no row; ${why}`);
        assert.deepEqual([row.role, row.label, row.status, row.ended_at], [ROLES[i % 4], `Lane ${i + 1}`, "running", null], `${id}; ${why}`);
      });
    };

    describe("hooks run one after the other, in a shuffled order", { concurrency: 3 }, () => {
      // Two fixed seeds and a random one; a failure message names the seed and the order, which replay it.
      for (const seed of [7, 1991, Math.floor(Math.random() * 2 ** 31)]) {
        it(`seed ${seed}`, async (t) => {
          const { fake, h, full } = await setup(t, { secret: false });
          const order = shuffled(events, seed);
          for (const { payload } of order) quiet(await hook(h, payload));
          const queued = h.events().map((e) => `${e.kind === "agent_label" ? "label" : "start"} ${e.agent_id}`);
          assert.deepEqual(queued, order.map((e) => e.name), "the outbox holds the events in the order they were run");
          full();
          const r = await flush(h);
          assert.equal(r.stdout, "sent 40, waiting 0, rejected 0\n");
          expectRows(fake, `seed ${seed}, order: ${queued.join(", ")}`);
          assert.equal(fake.rows("cockpit_sessions").length, 1);
        });
      }
    });

    it("all 40 hooks at once, each with its own detached flusher (the real race)", async (t) => {
      const { fake, h } = await setup(t);
      const runs = await Promise.all(shuffled(events, 3).map(({ payload }) => hook(h, payload)));
      for (const r of runs) quiet(r, "parallel hook");
      await drained(h);
      await sleep(300);
      expectRows(fake, "parallel run");
      assert.deepEqual(h.rejectedFiles(), []);
      assert.equal(fs.existsSync(path.join(h.outboxDir, ".lock")), false);
    });
  });

  describe("the key goes over https only, and over plain http to a loopback host only (review-1 nit)", () => {
    const invalidLine = /^supabase: invalid COCKPIT_SUPABASE_URL\b/;
    const statusOf = async (h, url) => {
      h.setEnv(`COCKPIT_SUPABASE_URL=${url}\nCOCKPIT_SUPABASE_SECRET_KEY=${SECRET}\n`);
      return (await status(h)).stdout.split("\n");
    };

    it("a non-loopback http URL is invalid: status says so, a hook starts no flusher, flush sends nothing and says why", async (t) => {
      const { fake, h } = await setup(t, { secret: false });
      // 0.0.0.0 is not a loopback host to the script, but on this machine it reaches the fake: a request that
      // was wrongly sent would show up there.
      const url = `http://0.0.0.0:${fake.port}`;
      const reachable = await fetch(`${url}${REST}probe`).then((res) => res.status === 200, () => false);
      if (!reachable) return t.skip(`${url} does not reach the loopback fake on this machine`);
      fake.clear();

      const lines = await statusOf(h, url);
      assert.match(lines[0], invalidLine);
      assert.deepEqual(lines.slice(1), ["waiting: 0", "rejected: 0", ""]);
      quiet(await hook(h, start("a1")));
      await sleep(500);
      assert.equal(fake.requests.length, 0, "the hook started a flusher that sent to the URL");
      const r = await flush(h);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "sent 0, waiting 1, rejected 0\n");
      assert.match(r.stderr, /^stopped: invalid COCKPIT_SUPABASE_URL/);
      assert.equal(fake.requests.length, 0, "flush sent to the URL");
      assert.equal(h.eventFiles().length, 1, "the event waits");

      h.setEnv(supabaseEnv(fake.url)); // the same event goes out once the URL is a loopback one
      assert.equal((await flush(h)).stdout, "sent 1, waiting 0, rejected 0\n");
    });

    it("status calls these URLs invalid", async (t) => {
      const { h } = await setup(t, { secret: false });
      for (const url of [
        "http://example.test",
        "http://project.example.test/",
        "http://localhost.example.test",
        "http://127.0.0.1.example.test",
        "http://0.0.0.0:1",
        "http://[::2]:1",
        "ftp://example.test",
        "ws://127.0.0.1:1",
        "example.test",
        "not a url",
        "//127.0.0.1:1",
      ]) {
        assert.match((await statusOf(h, url))[0], invalidLine, url);
      }
    });

    it("status calls these URLs usable: https anywhere, http to localhost, 127.x.x.x and [::1]", async (t) => {
      const { h } = await setup(t, { secret: false });
      for (const url of [
        "https://project.example.test",
        "https://project.example.test/",
        "https://127.0.0.1:1",
        "http://localhost:1",
        "http://127.0.0.1:1",
        "http://127.0.0.9:1",
        "http://[::1]:1",
        "HTTP://LOCALHOST:1",
      ]) {
        assert.equal((await statusOf(h, url))[0], "supabase: set", url);
      }
    });

    it("a missing key is reported before an invalid URL", async (t) => {
      const { h } = await setup(t, { secret: false });
      h.setEnv("COCKPIT_SUPABASE_URL=http://example.test\n");
      assert.equal((await status(h)).stdout.split("\n")[0], "supabase: missing COCKPIT_SUPABASE_SECRET_KEY");
    });
  });

  describe("credentials in the origin URL never reach the repo (review-1 nit)", () => {
    const origins = [
      ["https://user:pass@host.example/repo.git", "host.example/repo", ["user", "pass"]],
      ["https://x-access-token:ghp_exampletoken1@github.com/o/acme.git", "o/acme", ["x-access-token", "ghp_exampletoken1"]],
      ["https://exampletoken2@github.com/o/acme", "o/acme", ["exampletoken2"]],
      ["https://user:pass@host.example:8443/o/acme.git", "o/acme", ["user", "pass"]],
      ["ssh://git:s3cretword@host.example:2222/o/acme.git", "o/acme", ["s3cretword"]],
      ["https://user:p%40ss@host.example/repo.git", "host.example/repo", ["user", "p%40ss"]],
      ["https://user:p@ssword@host.example/repo.git", "host.example/repo", ["user", "ssword", "p@ss"]],
      ["git@github.com:o/acme.git", "o/acme", ["git@"]],
    ];
    for (const [origin, repo, secrets] of origins) {
      it(`${origin} gives repo ${repo}`, async (t) => {
        const { h } = await setup(t, { secret: false });
        const dir = makeRepo(s, `creds-${harnesses.length}`, { origin });
        quiet(await hook(h, start("a1", { cwd: dir })));
        const [event] = h.events();
        assert.equal(event.repo, repo);
        const text = fs.readFileSync(path.join(h.outboxDir, h.eventFiles()[0]), "utf8");
        for (const secret of secrets) assert.ok(!text.includes(secret), `the outbox event holds ${secret}: ${text}`);
      });
    }

    it("a solve in such a repo: the session row Supabase gets, and the decision's event, hold no credentials", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      const dir = makeRepo(s, `creds-${harnesses.length}`, { origin: "https://user:pass@host.example/repo.git" });
      const r0 = await decide(s, h, ["start", "--session", "s9", "--repo", dir, "--", "small fix the readme typo"], { url: closedUrl });
      assert.equal(r0.code, 0, r0.stderr);
      assert.deepEqual(h.events().map((e) => e.repo), ["host.example/repo", "host.example/repo"]);
      full();
      assert.equal((await flush(h)).stdout, "sent 2, waiting 0, rejected 0\n");
      assert.equal(fake.rows("cockpit_sessions")[0].repo, "host.example/repo");
      for (const q of fake.requests) {
        assert.ok(!q.raw.includes("pass") && !q.raw.includes("user:"), `a request body holds the credentials: ${q.raw}`);
      }
    });
  });

  describe("rejected/ keeps the newest 1,000 events (review-1: it was unbounded)", () => {
    // `count` event files with their reason files, named like events from 2023 on (older than any new one).
    const fillRejected = (h, count, from = 1_700_000_000_000) => {
      fs.mkdirSync(h.rejectedDir, { recursive: true });
      return Array.from({ length: count }, (_, i) => {
        const name = `${from + i}-1-${String(i).padStart(4, "0")}.json`;
        fs.writeFileSync(path.join(h.rejectedDir, name), "{}\n");
        fs.writeFileSync(path.join(h.rejectedDir, `${name}.reason`), "400 - - (POST /rest/v1/cockpit_agents?on_conflict=id)\n");
        return name;
      });
    };
    const reasonFiles = (h) => fs.readdirSync(h.rejectedDir).filter((name) => name.endsWith(".reason")).sort();

    it("invalid event files that arrive at 1,000: the oldest rejected ones and their reasons go", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      const old = fillRejected(h, 1000);
      const fresh = Array.from({ length: 5 }, (_, j) => `${1_790_000_000_000 + j}-2-${String(j).padStart(4, "0")}.json`);
      for (const name of fresh) fs.writeFileSync(path.join(h.outboxDir, name), "{}\n");
      full();
      const r = await flush(h);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "sent 0, waiting 0, rejected 5\n");
      assert.deepEqual(h.rejectedFiles(), [...old.slice(5), ...fresh], "the newest 1,000 stay");
      assert.deepEqual(reasonFiles(h), h.rejectedFiles().map((name) => `${name}.reason`), "every kept event has its reason, and no reason is left over");
      assert.equal((await status(h)).stdout, "supabase: set\nwaiting: 0\nrejected: 1000\n");
      assert.equal(fake.requests.length, 0);
    });

    it("events Supabase refuses with a 400 (schema drift): the folder stays at 1,000", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      const old = fillRejected(h, 998);
      for (const id of ["a1", "a2", "a3", "a4"]) quiet(await hook(h, start(id)));
      const fresh = h.eventFiles();
      full();
      fake.mode("400:cockpit_agents");
      assert.equal((await flush(h)).stdout, "sent 0, waiting 0, rejected 4\n");
      assert.deepEqual(h.rejectedFiles(), [...old.slice(2), ...fresh]);
      assert.deepEqual(reasonFiles(h), h.rejectedFiles().map((name) => `${name}.reason`));
      assert.match(fs.readFileSync(path.join(h.rejectedDir, `${fresh[3]}.reason`), "utf8"), /^400 /);
    });

    it("below 1,000 nothing is removed", async (t) => {
      const { h, full } = await setup(t, { secret: false });
      const old = fillRejected(h, 10);
      fs.writeFileSync(path.join(h.outboxDir, "1790000000000-2-0000.json"), "{}\n");
      full();
      assert.equal((await flush(h)).stdout, "sent 0, waiting 0, rejected 1\n");
      assert.deepEqual(h.rejectedFiles(), [...old, "1790000000000-2-0000.json"]);
      assert.deepEqual(reasonFiles(h), h.rejectedFiles().map((name) => `${name}.reason`));
    });
  });

  describe("stray files are removed once they are over a minute old (review-1: .tmp files were never swept)", () => {
    const aged = (file, seconds) => {
      const when = new Date(Date.now() - seconds * 1000);
      fs.lutimesSync(file, when, when);
    };
    const put = (h, name, { seconds, dir = false } = {}) => {
      fs.mkdirSync(h.outboxDir, { recursive: true });
      const file = path.join(h.outboxDir, name);
      if (dir) {
        fs.mkdirSync(file);
        fs.writeFileSync(path.join(file, "inside"), "x");
      } else fs.writeFileSync(file, "x");
      aged(file, seconds);
      return file;
    };

    it("a dot-file a writer left when it died between writing and renaming: the old one goes, a fresh one stays", async (t) => {
      const { h } = await setup(t, { secret: false });
      const old = put(h, ".1700000000000-4242-0000.json.tmp", { seconds: 120 });
      const fresh = put(h, ".1700000000001-4242-0001.json.tmp", { seconds: 5 });
      quiet(await hook(h, start("a1")));
      assert.equal(fs.existsSync(old), false, "the stray .tmp file is still there");
      assert.equal(fs.existsSync(fresh), true, "a writer may still be on its way to renaming this one");
      assert.equal(h.eventFiles().length, 1);
    });

    // A flusher that takes a stale lock over first moves it aside under its own name (.lock.<pid>-<16 hex>), then
    // removes it; one killed in between leaves it behind. The lock is a file now, a folder in the earlier version.
    it("a lock a flusher moved aside and died before removing: the old one goes, a fresh one stays", async (t) => {
      const { h } = await setup(t, { secret: false });
      const old = put(h, ".lock.4242-0123456789abcdef", { seconds: 120 });
      const fresh = put(h, ".lock.4244-0011223344556677", { seconds: 5 });
      quiet(await hook(h, start("a1")));
      assert.equal(fs.existsSync(old), false);
      assert.equal(fs.existsSync(fresh), true);
    });

    it("the same when the lock it moved aside is a folder (the earlier version's lock)", async (t) => {
      const { h } = await setup(t, { secret: false });
      const old = put(h, ".lock.4243-fedcba9876543210", { seconds: 300, dir: true });
      const fresh = put(h, ".lock.4245-8899aabbccddeeff", { seconds: 5, dir: true });
      quiet(await hook(h, start("a1")));
      assert.equal(fs.existsSync(old), false, "the old lock folder is still there");
      assert.equal(fs.existsSync(fresh), true);
    });

    it("nothing else is touched: waiting events however old, other files, the rejected folder", async (t) => {
      const { h } = await setup(t, { secret: false });
      const waiting = put(h, "1700000000000-1-0000.json", { seconds: 86_400 });
      const other = put(h, ".DS_Store", { seconds: 3600 });
      const notes = put(h, "notes.txt", { seconds: 3600 });
      const rejected = put(h, "rejected", { seconds: 3600, dir: true });
      quiet(await hook(h, start("a1")));
      for (const file of [waiting, other, notes, rejected]) assert.equal(fs.existsSync(file), true, file);
    });
  });

  describe("control characters are dropped before spaces collapse, so cleaning twice changes nothing (review-1)", () => {
    // [what, text, what the label comes out as]
    const labels = [
      ["a blank, a bell and a blank", "Lane \u0007 1", "Lane 1"],
      ["several controls between blanks", "Lane \u0007\u0001\u001b 1", "Lane 1"],
      ["a bell inside a word", "La\u0007ne 1", "Lane 1"],
      ["NUL and DEL", "Lane \u0000 \u007f 1", "Lane 1"],
      ["controls at the ends", "\u0007 Lane 1 \u0007", "Lane 1"],
      ["backspace, shift out and unit separator", "Lane \u0008 \u000e \u001f 1", "Lane 1"],
      ["tab, vertical tab, form feed, CR and LF are blanks", "Lane\t\u000b\u000c\r\n1", "Lane 1"],
      ["a control in a wide blank run", "Lane   \u0007   1", "Lane 1"],
      ["controls do not count toward the 120 characters", `${"x".repeat(119)}${"\u0007".repeat(10)}y`, `${"x".repeat(119)}y`],
    ];

    it("every one of these labels is sent, not rejected, as its cleaned text", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      for (const [i, [, text]] of labels.entries()) quiet(await hook(h, launched(`c${i}`, text)));
      assert.equal(h.eventFiles().length, labels.length);
      full();
      const r = await flush(h);
      assert.equal(r.stdout, `sent ${labels.length}, waiting 0, rejected 0\n`);
      assert.deepEqual(h.rejectedFiles(), []);
      for (const [i, [what, , expected]] of labels.entries()) {
        assert.equal(fake.rows("cockpit_agents").find((row) => row.id === `c${i}`)?.label, expected, what);
      }
    });

    it("a description of nothing but controls and blanks queues nothing", async (t) => {
      const { h } = await setup(t, { secret: false });
      quiet(await hook(h, launched("c1", "\u0007 \u0001\t\u001b")));
      assert.deepEqual(h.eventFiles(), []);
    });

    it("a role is cleaned the same way and sent", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      quiet(await hook(h, start("a1", { agent_type: "code \u0007 reviewer" })));
      assert.equal(h.events()[0].role, "code reviewer");
      full();
      assert.equal((await flush(h)).stdout, "sent 1, waiting 0, rejected 0\n");
      assert.equal(fake.rows("cockpit_agents")[0].role, "code reviewer");
    });

    for (const [name, task, title] of [
      ["a bell between blanks", "small fix \u0007 the typo", "fix the typo"],
      ["controls at both ends", "small \u0007fix the typo\u0007", "fix the typo"],
      ["a run of controls between blanks", "small fix \u0001\u0007\u001b the typo", "fix the typo"],
    ]) {
      it(`a solve's title (${name}) is one blank wide, and its session row gets the title and level`, async (t) => {
        const { fake, h, full } = await setup(t, { secret: false });
        const r0 = await decide(s, h, ["start", "--session", "s9", "--repo", acme, "--", task], { url: closedUrl });
        assert.equal(r0.code, 0, r0.stderr);
        const [session] = h.events();
        assert.deepEqual([session.kind, session.title, session.level], ["session", title, "small"]);
        full();
        const r = await flush(h);
        assert.equal(r.stdout, "sent 2, waiting 0, rejected 0\n", "the session event was rejected as invalid");
        assert.deepEqual(h.rejectedFiles(), []);
        assert.deepEqual([fake.rows("cockpit_sessions")[0].title, fake.rows("cockpit_sessions")[0].level], [title, "small"]);
      });
    }
  });

  describe("flush says why events still wait, on stderr (review-1 nit)", () => {
    const failing = [
      ["401", "http-401"],
      ["404", "http-404"],
      ["500", "http-500"],
      ["down", "network"],
    ];
    for (const [mode, why] of failing) {
      it(`mode ${mode}: stdout stays the count, stderr reads "stopped: ${why} (<the event file>)"`, async (t) => {
        const { fake, h, full } = await setup(t, { secret: false });
        quiet(await hook(h, start("a1")));
        quiet(await hook(h, ended()));
        const [first] = h.eventFiles();
        full();
        fake.mode(mode);
        const r = await flush(h);
        assert.equal(r.code, 0);
        assert.equal(r.stdout, "sent 0, waiting 2, rejected 0\n");
        assert.equal(r.stderr, `stopped: ${why} (${first})\n`);
      });
    }

    it("a timeout reads stopped: timeout (<the event file>)", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      quiet(await hook(h, start("a1")));
      const [first] = h.eventFiles();
      full();
      fake.mode("delay:6000");
      const r = await flush(h);
      assert.equal(r.stdout, "sent 0, waiting 1, rejected 0\n");
      assert.equal(r.stderr, `stopped: timeout (${first})\n`);
      assert.ok(r.ms < 10_000, `took ${r.ms} ms`);
    });

    it("it names the event that failed, after the ones before it were sent", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      for (const id of ["a1", "a2", "a3"]) quiet(await hook(h, start(id)));
      const [, second] = h.eventFiles();
      full();
      fake.queue(["ok", "ok", "ok", "401"]); // the first event's three requests, then the second event's first
      const r = await flush(h);
      assert.equal(r.stdout, "sent 1, waiting 2, rejected 0\n");
      assert.equal(r.stderr, `stopped: http-401 (${second})\n`);
    });

    it("missing keys and an unsafe URL say so too", async (t) => {
      const { h } = await setup(t, { url: false, secret: false });
      quiet(await hook(h, start("a1")));
      const missing = await flush(h);
      assert.equal(missing.stdout, "sent 0, waiting 1, rejected 0\n");
      assert.match(missing.stderr, /^stopped: missing COCKPIT_SUPABASE_URL, COCKPIT_SUPABASE_SECRET_KEY\n$/);
      h.setEnv(`COCKPIT_SUPABASE_URL=http://example.test\nCOCKPIT_SUPABASE_SECRET_KEY=${SECRET}\n`);
      const unsafe = await flush(h);
      assert.equal(unsafe.stdout, "sent 0, waiting 1, rejected 0\n");
      assert.match(unsafe.stderr, /^stopped: invalid COCKPIT_SUPABASE_URL/);
    });

    it("nothing on stderr when everything was sent, or when nothing waits", async (t) => {
      const { h, full } = await setup(t, { secret: false });
      assert.equal((await flush(h)).stderr, "", "nothing waits and the keys are not set");
      quiet(await hook(h, start("a1")));
      full();
      const r = await flush(h);
      assert.equal(r.stdout, "sent 1, waiting 0, rejected 0\n");
      assert.equal(r.stderr, "");
      assert.equal((await status(h)).stderr, "");
    });
  });

  describe("no secret leaks", () => {
    it("nothing the commands above printed holds the secret, and no event, reason or lock file does", () => {
      assert.ok(seen.length > 0, "no outputs were recorded");
      for (const text of seen) assert.ok(!text.includes(SECRET), "a command printed the secret");
      const stack = harnesses.map((h) => h.outboxDir);
      let files = 0;
      while (stack.length) {
        const dir = stack.pop();
        let entries = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {}
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else {
            files++;
            let text = "";
            try {
              text = fs.readFileSync(full, "utf8");
            } catch {}
            assert.ok(!text.includes(SECRET), `${full} holds the secret`);
          }
        }
      }
      assert.ok(files > 0);
    });
  });
});
