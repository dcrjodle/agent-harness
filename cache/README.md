# Cache
Recipes make repeated tasks one-shot: exact steps saved from past discovery. The cache is global — namespace every recipe by repo.

- `INDEX.md` — `- [<repo>/<name>](recipes/<repo>/<name>.md) — when to use`, one line each.
- `recipes/<repo>/<name>.md` — exact commands/paths only, no prose.

Rules
- INDEX match → follow the recipe verbatim, skip discovery — but verify its output as usual.
- Task took >2 discovery steps → save/update the recipe (small-tier sub-agent).
- Recipe failed → fix or delete it.
