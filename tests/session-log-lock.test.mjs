// H-A round 2: the lock of bin/session-log (review-1: a stale lock that could not be removed made the
// flusher spin, and two waiters could both take a stale lock over). Only one flusher sends at a time; a lock
// untouched for a minute is taken over by one taker; the holder checks it still owns the lock before every
// request and stops when it does not; a flusher that waits sleeps. A scratch HARNESS_DIR and its own fake
// Supabase on loopback per test; nothing here reaches the real Supabase, ~/.agent-harness or its logs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { drained, makeRepo, scratch, sleep, supabaseEnv, until } from "./helpers.mjs";
import { sessionKit } from "./session-kit.mjs";

describe("R2 the session-log lock", () => {
  const s = scratch("harness-sessionlock-");
  const acme = makeRepo(s, "acme", { origin: "git@github.com:o/acme.git" });
  const { setup, hook, flush, quiet, startFlush, start } = sessionKit(s, acme);
  after(() => s.remove());

  const lockOf = (h) => path.join(h.outboxDir, ".lock");
  const FOREIGN = "4242-0123456789abcdef"; // the token of some other flusher
  const age = (file, seconds) => {
    const when = new Date(Date.now() - seconds * 1000);
    fs.lutimesSync(file, when, when);
  };
  const queueAgents = async (h, ids) => {
    for (const id of ids) quiet(await hook(h, start(id)));
  };
  const firstRequest = (fake) => until(() => fake.requests.length >= 1, { ms: 5000, step: 5, what: "the holder's first request" });
  const sentIn = (r) => Number(/^sent (\d+),/.exec(r.stdout)?.[1]);
  // CPU seconds a process has used so far, from ps (M:SS.cc on macOS, [[DD-]HH:]MM:SS elsewhere); null without ps.
  const cpuSeconds = (pid) => {
    try {
      const text = execFileSync("ps", ["-o", "cputime=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const [days, clock] = text.includes("-") ? text.split("-") : ["0", text];
      return Number(days) * 86_400 + clock.split(":").reduce((total, part) => total * 60 + Number(part), 0);
    } catch {
      return null;
    }
  };

  describe("a lock untouched for over a minute is taken over, whatever it is", () => {
    const kinds = {
      "a file holding the token of a flusher that died": (lock) => fs.writeFileSync(lock, FOREIGN),
      "an empty file": (lock) => fs.writeFileSync(lock, ""),
      "a folder with something in it (the earlier version's lock)": (lock) => {
        fs.mkdirSync(lock);
        fs.writeFileSync(path.join(lock, "inside"), "x");
      },
      "a link to nowhere": (lock) => fs.symlinkSync(path.join(path.dirname(lock), "nowhere"), lock),
    };
    for (const [name, make] of Object.entries(kinds)) {
      it(name, async (t) => {
        const { fake, h, full } = await setup(t, { secret: false });
        await queueAgents(h, ["a1", "a2"]);
        full();
        make(lockOf(h));
        age(lockOf(h), 120);
        const r = await flush(h);
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.stdout, "sent 2, waiting 0, rejected 0\n");
        assert.equal(r.stderr, "");
        assert.ok(r.ms < 5000, `took ${r.ms} ms`);
        assert.deepEqual(fs.readdirSync(h.outboxDir), [], "no event, no lock and no moved-aside lock is left");
        assert.deepEqual(fake.rows("cockpit_agents").map((row) => row.id), ["a1", "a2"]);
      });
    }
  });

  it("a lock under a minute old is left as it is, and a flusher that waits for it sends nothing", async (t) => {
    const { fake, h, full } = await setup(t, { secret: false });
    await queueAgents(h, ["a1"]);
    full();
    const lock = lockOf(h);
    fs.writeFileSync(lock, FOREIGN);
    age(lock, 30);
    const mtime = fs.statSync(lock).mtimeMs;
    const waiting = startFlush(t, h);
    await sleep(800);
    assert.equal(waiting.child.exitCode, null, "it waits while an event waits and the lock is held");
    for (const name of h.eventFiles()) fs.rmSync(path.join(h.outboxDir, name)); // what the holder's sending does
    const r = await Promise.race([waiting.done, sleep(4000).then(() => null)]);
    assert.ok(r, "it did not exit within 4 s of the outbox emptying");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "sent 0, waiting 0, rejected 0\n");
    assert.equal(fs.readFileSync(lock, "utf8"), FOREIGN, "the lock is not its own and stays");
    assert.equal(fs.statSync(lock).mtimeMs, mtime, "a waiter does not refresh a lock that is not its own");
    assert.equal(fake.requests.length, 0);
  });

  describe("the holder stops when it no longer owns the lock", () => {
    for (const [name, disturb, kept] of [
      ["another flusher's token replaces its own", (lock) => fs.writeFileSync(lock, FOREIGN), FOREIGN],
      ["the lock is removed", (lock) => fs.rmSync(lock), null],
    ]) {
      it(`${name}: no request goes out after that, the events wait, and the lock is left as it was found`, async (t) => {
        const { fake, h, full } = await setup(t, { secret: false });
        await queueAgents(h, ["a1", "a2", "a3", "a4", "a5", "a6"]);
        full();
        fake.mode("delay:800");
        const holder = startFlush(t, h);
        await firstRequest(fake);
        const lock = lockOf(h);
        assert.equal(fs.existsSync(lock), true, "the holder has its lock");
        disturb(lock);
        const r = await holder.done;
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.stdout, "sent 0, waiting 6, rejected 0\n");
        assert.match(r.stderr, /^stopped: .+ \(\d{13}-\d+-\d{4}\.json\)\n$/);
        assert.equal(fake.requests.length, 1, "a request went out after the lock was lost");
        assert.equal(h.eventFiles().length, 6);
        if (kept === null) assert.equal(fs.existsSync(lock), false, "the holder made a lock again");
        else assert.equal(fs.readFileSync(lock, "utf8"), kept, "the holder removed or rewrote a lock that is not its own");
      });
    }

    it("one that slept past the stale age is taken over by the next flusher, stops, and leaves the new holder's lock alone", async (t) => {
      const { fake, h, full } = await setup(t, { secret: false });
      await queueAgents(h, ["a1", "a2", "a3"]);
      full();
      fake.queue(["delay:2200"]); // the sleeper's first request is slow, as if the machine slept in it
      fake.mode("delay:400"); // the new holder's requests take a while too, so it is still sending when the sleeper wakes
      const sleeper = startFlush(t, h);
      await firstRequest(fake);
      const lock = lockOf(h);
      age(lock, 120); // it looks abandoned now
      const taker = startFlush(t, h);

      const woke = await sleeper.done;
      assert.equal(woke.code, 0, woke.stderr);
      assert.match(woke.stdout, /^sent 0, /);
      assert.match(woke.stderr, /^stopped: /);
      assert.equal(taker.child.exitCode, null, "the new holder was done before the sleeper woke; the test did not overlap them");
      assert.equal(fs.existsSync(lock), true, "the sleeper removed the lock of the flusher that took it over");

      const r = await taker.done;
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "sent 3, waiting 0, rejected 0\n");
      assert.equal(r.stderr, "");
      assert.equal(fs.existsSync(lock), false);
      assert.deepEqual(fake.rows("cockpit_agents").map((row) => row.id), ["a1", "a2", "a3"]);
    });
  });

  it("a holder refreshes its lock's time before each request, so a flusher that is alive never looks stale", async (t) => {
    const { fake, h, full } = await setup(t, { secret: false });
    await queueAgents(h, ["a1", "a2"]);
    full();
    fake.queue(["delay:800"]);
    fake.mode("delay:300");
    const holder = startFlush(t, h);
    await firstRequest(fake);
    const lock = lockOf(h);
    age(lock, 120);
    await until(() => fake.requests.length >= 2, { ms: 5000, step: 5, what: "the holder's second request" });
    const idle = Date.now() - fs.statSync(lock).mtimeMs;
    assert.ok(idle < 5000, `the lock's time was ${idle} ms old when the second request went out`);
    assert.equal((await holder.done).stdout, "sent 2, waiting 0, rejected 0\n");
  });

  describe("a flusher that waits for the lock sleeps; it never spins (review-1: a stale lock it could not remove)", () => {
    const WAIT_MS = 2000;
    const cases = [
      ["a lock another flusher holds", { stale: false, readonly: false }],
      ["a stale lock it cannot take over (the outbox folder is read-only)", { stale: true, readonly: true }],
    ];
    for (const [name, { stale, readonly }] of cases) {
      it(`${name}: little CPU in ${WAIT_MS / 1000} s, and it exits once nothing waits`, async (t) => {
        if (readonly && typeof process.getuid === "function" && process.getuid() === 0) return t.skip("root can change a read-only folder");
        const { fake, h, full } = await setup(t, { secret: false });
        await queueAgents(h, ["a1"]);
        full();
        const lock = lockOf(h);
        fs.writeFileSync(lock, FOREIGN);
        if (stale) age(lock, 120);
        if (readonly) {
          fs.chmodSync(h.outboxDir, 0o500);
          t.after(() => fs.chmodSync(h.outboxDir, 0o700));
        }
        const waiting = startFlush(t, h);
        await sleep(WAIT_MS);
        assert.equal(waiting.child.exitCode, null, `it gave up before its time: ${waiting.child.signalCode}`);
        const used = cpuSeconds(waiting.pid);
        if (used === null) t.diagnostic("ps is not available: the CPU time was not checked");
        else {
          t.diagnostic(`${used} s of CPU in ${WAIT_MS / 1000} s`);
          assert.ok(used < 1, `${used} s of CPU in ${WAIT_MS / 1000} s: it spins`);
        }

        fs.chmodSync(h.outboxDir, 0o700); // what lets the holder (or the test) remove the events
        for (const file of h.eventFiles()) fs.rmSync(path.join(h.outboxDir, file));
        const r = await Promise.race([waiting.done, sleep(5000).then(() => null)]);
        assert.ok(r, "it did not exit within 5 s of the outbox emptying");
        assert.equal(r.code, 0, r.stderr);
        assert.ok(fake.requests.length <= 3, "at most the one event it may have taken over for");
      });
    }
  });

  describe("only one flusher sends at a time", () => {
    it("five flushers that find a stale lock at the same moment: every event is completed by exactly one of them", async (t) => {
      // A race this narrow cannot be forced from outside; repeating it makes a double takeover likely to show as
      // a sent total above the number of events (two flushers completing the same event).
      const { fake, h } = await setup(t, { secret: false });
      for (let round = 0; round < 4; round++) {
        h.setEnv("");
        const ids = [1, 2, 3, 4].map((n) => `r${round}a${n}`);
        await queueAgents(h, ids);
        h.setEnv(supabaseEnv(fake.url));
        fake.mode("delay:30");
        const lock = lockOf(h);
        fs.writeFileSync(lock, FOREIGN);
        age(lock, 120);
        const runs = await Promise.all([1, 2, 3, 4, 5].map(() => flush(h)));
        for (const r of runs) assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
        assert.equal(runs.map(sentIn).reduce((a, b) => a + b, 0), ids.length, `round ${round}: ${runs.map((r) => r.stdout.trim()).join(" | ")}`);
        await drained(h, 2000);
        for (const id of ids) assert.ok(fake.rows("cockpit_agents").some((row) => row.id === id), `${id} has no row`);
      }
    });
  });
});
