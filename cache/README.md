# Cache
Recipes make repeated tasks one-shot: exact steps saved from past discovery. They are private and gitignored, because they hold machine paths and project internals.

- `recipes/<repo>/<name>.md` — line 1 is `# <repo>/<name> — <when to use>`, then exact commands, paths and gotchas (≤ 60 lines).
- The session-start hook prints line 1 of every recipe for the current repo, so there is no index to maintain.

Rules
- Match → follow the recipe verbatim, skip discovery, still verify its output.
- Task needed more than 2 discovery steps → `/recipe` to save or update one.
- Recipe failed → fix or delete it.
