---
description: Solve a task with the harness loop
argument-hint: "[min|med|max] <task>"
---
Task: $ARGUMENTS
Degree = first word if min|med|max, else med.
Run ~/.agent-harness/skills/loop.md: one sub-agent per stage (tier table in ~/.agent-harness/AGENTS.md), only summaries in main context.
