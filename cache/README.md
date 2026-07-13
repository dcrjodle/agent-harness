# Cache
Recipes make repeated tasks one-shot: exact steps saved from past discovery.

- `INDEX.md` — `- [name](recipes/<name>.md) — when to use`, one line each.
- `recipes/<name>.md` — exact commands/paths only, no prose.

Rules
- INDEX match → follow the recipe verbatim, skip discovery.
- Task took >2 discovery steps → save/update the recipe (small-tier sub-agent).
- Recipe failed → fix or delete it.
