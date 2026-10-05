// A fake Jev (TypeSafe AI) server for the harness tests: POST /v1/systemone on a loopback port.
// It records every request and answers each question from configured answers, or fails in a chosen
// mode. Importing this file has no side effects; tests start and stop their own instance.
//
//   const fake = await startFakeJev();
//   fake.answer("level", { small: 0.1, medium: 0.8, large: 0.1 });   // a choice question: probability per label
//   fake.answer("ui", 0.9);                                         // a noul question: probability of yes
//   fake.mode("503");   // ok | 503 | 401 | 429 | status:<code> | delay:<ms> | bad | bad-probabilities | closed
//   fake.queue(["503", "ok"]);                                      // one mode per upcoming request, then the standing mode
//   fake.requests;                                                  // every request: { method, url, headers, raw, body }
//   await fake.close();
//
// An unconfigured choice question gets uniform probabilities, an unconfigured noul question 0.5.
import http from "node:http";

export async function startFakeJev({ host = "127.0.0.1" } = {}) {
  const requests = [];
  const answers = new Map();
  const timers = new Set();
  let standing = "ok";
  let queued = [];
  let model = "jev-1.13.0";
  let inFlight = 0;
  let maxInFlight = 0;

  function answerFor(name, question, { broken = false } = {}) {
    const configured = answers.get(name);
    if (question && question.type === "noul") {
      if (broken) return { type: "noul", noul: "high" };
      return { type: "noul", noul: typeof configured === "number" ? configured : 0.5 };
    }
    const labels = Object.keys((question && question.criteria) || {});
    const probabilities = {};
    for (const label of labels) {
      const given = configured && typeof configured === "object" ? configured[label] : undefined;
      probabilities[label] = typeof given === "number" ? given : 1 / labels.length;
    }
    let choice = labels[0];
    for (const label of labels) if (probabilities[label] > probabilities[choice]) choice = label;
    if (broken && labels.length > 1) delete probabilities[labels[labels.length - 1]];
    return { type: "choice", choice, confidence: probabilities[choice], probabilities };
  }

  function okBody(body, options) {
    const out = { model, answers: {}, usage: { input_tokens: 12, output_tokens: 1 } };
    const questions = body && typeof body.questions === "object" && body.questions ? body.questions : {};
    for (const [name, question] of Object.entries(questions)) out.answers[name] = answerFor(name, question, options);
    return JSON.stringify(out);
  }

  function reply(res, status, text, type = "application/json") {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "content-type": type });
    res.end(text);
  }

  function respond(req, res, raw) {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    requests.push({ method: req.method, url: req.url, headers: req.headers, raw, body });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    let finished = false;
    res.on("close", () => {
      if (!finished) inFlight -= 1;
      finished = true;
    });

    if (req.method !== "POST" || req.url !== "/v1/systemone") return reply(res, 404, JSON.stringify({ error: "not found" }));

    const spec = queued.length ? queued.shift() : standing;
    const sep = spec.indexOf(":");
    const name = sep === -1 ? spec : spec.slice(0, sep);
    const arg = sep === -1 ? "" : spec.slice(sep + 1);
    switch (name) {
      case "ok":
        return reply(res, 200, okBody(body));
      case "bad":
        return reply(res, 200, "this is not json", "text/plain");
      case "bad-probabilities":
        return reply(res, 200, okBody(body, { broken: true }));
      case "closed":
        return void req.socket.destroy();
      case "status":
        return reply(res, Number(arg), JSON.stringify({ error: `status ${arg}` }));
      case "delay": {
        const timer = setTimeout(() => {
          timers.delete(timer);
          reply(res, 200, okBody(body));
        }, Number(arg));
        timers.add(timer);
        res.on("close", () => {
          clearTimeout(timer);
          timers.delete(timer);
        });
        return;
      }
      default:
        if (/^\d{3}$/.test(name)) return reply(res, Number(name), JSON.stringify({ error: `status ${name}` }));
        return reply(res, 500, JSON.stringify({ error: `fake-jev: unknown mode "${spec}"` }));
    }
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
    answer(name, value) {
      answers.set(name, value);
    },
    mode(spec) {
      standing = spec;
    },
    queue(specs) {
      queued = [...specs];
    },
    setModel(name) {
      model = name;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    reset() {
      requests.length = 0;
      answers.clear();
      standing = "ok";
      queued = [];
      model = "jev-1.13.0";
      maxInFlight = 0;
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
