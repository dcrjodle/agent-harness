# loop
Main agent = orchestrator only. One sub-agent per stage; pass summaries, never raw output.

- **min**: implement → ship
- **med**: implement → review → fix → ship
- **max**: plan → implement → review → test → fix → ship

Stages map to skills: plan, implement, review, test, git-ops (= ship).
- fix = implement sub-agent given the findings.
- Findings loop max 2 rounds, then ship with open items noted in the PR.
- Check cache/INDEX.md before the first stage; save a recipe after.
