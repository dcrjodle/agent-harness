// A fake Supabase (PostgREST) server for the harness tests: the session log's writes on a loopback port.
// It records every request and answers 201 to a POST and 204 to a PATCH, or fails in a chosen mode.
// Importing this file has no side effects; tests start and stop their own instance.
//
//   const fake = await startFakeSupabase();
//   fake.url;                       // http://127.0.0.1:<port>: what COCKPIT_SUPABASE_URL points at
//   fake.mode("500");               // see the modes below
//   fake.queue(["500", "ok"]);      // one mode per upcoming request, then the standing mode
//   fake.requests;                  // every request that arrived (see below)
//   fake.clear();                   // forget the recorded requests, keep the mode
//   fake.reset();                   // forget them and go back to `ok`
//   await fake.close();
//
// Modes:
//   ok                 201 for a POST, 204 for a PATCH (and any other write), 200 [] for a GET
//   down               the connection is destroyed without an answer
//   <status>           every request answers <status> (401, 404, 500, 503, ...) with a JSON error body
//   <status>:<regex>   requests whose path (with query) matches the regex answer <status>, the others are ok
//   plain<status>:<regex>  the same with a body that is not JSON
//   delay:<ms>         the answer comes after <ms>, as ok
//   redirect:<url>     every request answers 307 with Location: <url>
//
// Every request is recorded as { method, path, apikey, authorization, prefer, contentType, headers, raw,
// body, answered }, `path` being the URL with its query and `answered` the status sent (null when the
// connection was destroyed). A path outside /rest/v1/ answers 404 like PostgREST does.
import http from "node:http";

const ERRORS = {
  400: { code: "23514", message: 'new row for relation "cockpit_agents" violates check constraint "cockpit_agents_role_check"' },
  409: { code: "23503", message: 'insert or update on table "cockpit_agents" violates foreign key constraint "cockpit_agents_session_id_fkey"' },
};

export async function startFakeSupabase({ host = "127.0.0.1" } = {}) {
  const requests = [];
  const timers = new Set();
  let standing = "ok";
  let queued = [];

  const reply = (res, entry, status, text) => {
    entry.answered = status;
    if (res.destroyed || res.writableEnded) return;
    if (text === undefined) {
      res.writeHead(status);
      res.end();
    } else {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(text);
    }
  };

  const okAnswer = (req) => {
    if (req.method === "POST") return [201, undefined];
    if (req.method === "GET") return [200, "[]"];
    return [204, undefined];
  };

  const failure = (res, entry, status, plain) =>
    reply(res, entry, status, plain ? "this is not json" : JSON.stringify(ERRORS[status] || { code: null, message: `fake-supabase: status ${status}`, details: null, hint: null }));

  function respond(req, res, raw) {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    const entry = {
      method: req.method,
      path: req.url,
      apikey: req.headers.apikey ?? null,
      authorization: req.headers.authorization ?? null,
      prefer: req.headers.prefer ?? null,
      contentType: req.headers["content-type"] ?? null,
      headers: req.headers,
      raw,
      body,
      answered: null,
    };
    requests.push(entry);

    if (!req.url.startsWith("/rest/v1/")) return failure(res, entry, 404, false);

    const spec = queued.length ? queued.shift() : standing;
    const sep = spec.indexOf(":");
    const name = sep === -1 ? spec : spec.slice(0, sep);
    const arg = sep === -1 ? "" : spec.slice(sep + 1);
    const [okStatus, okBody] = okAnswer(req);

    if (name === "ok") return reply(res, entry, okStatus, okBody);
    if (name === "redirect") {
      entry.answered = 307;
      res.writeHead(307, { location: arg });
      res.end();
      return;
    }
    if (name === "down") {
      req.socket.destroy();
      return;
    }
    if (name === "delay") {
      const timer = setTimeout(() => {
        timers.delete(timer);
        reply(res, entry, okStatus, okBody);
      }, Number(arg));
      timers.add(timer);
      res.on("close", () => {
        clearTimeout(timer);
        timers.delete(timer);
      });
      return;
    }
    const plain = name.startsWith("plain");
    const status = Number(plain ? name.slice(5) : name);
    if (!Number.isInteger(status) || status < 100) return failure(res, entry, 500, false);
    if (sep !== -1 && !new RegExp(arg).test(req.url)) return reply(res, entry, okStatus, okBody);
    return failure(res, entry, status, plain);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => respond(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address();

  return {
    url: `http://${host}:${port}`,
    port,
    requests,
    mode(spec) {
      standing = spec;
    },
    queue(specs) {
      queued = [...specs];
    },
    clear() {
      requests.length = 0;
    },
    reset() {
      requests.length = 0;
      standing = "ok";
      queued = [];
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
