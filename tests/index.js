"use strict";
// Makes `node --test tests/` work: since Node 22 a directory argument is no longer expanded, node runs the
// directory itself, which loads this file, and this file loads every *.test.mjs beside it into that one
// process. `node --test` and `node --test tests/*.test.mjs` run each test file on its own and in parallel,
// and never start this file as the directory; so it does nothing then (and nothing on an older node that
// lists this file among the files it scans, which already runs the others itself).
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

if (path.resolve(process.argv[1] || "") === __dirname) {
  (async () => {
    const files = fs
      .readdirSync(__dirname)
      .filter((name) => name.endsWith(".test.mjs"))
      .sort();
    for (const name of files) await import(pathToFileURL(path.join(__dirname, name)).href);
  })();
}
