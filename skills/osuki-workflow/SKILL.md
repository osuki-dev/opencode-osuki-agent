---
name: osuki-workflow
description: Coordinate development or analysis with Osuki's Jev routing, native OpenCode subagents, project skills and persistent goal checkpoints.
---

Use this workflow within the Osuki agent family. The user's requested scope and repository AGENTS.md remain authoritative.

For development, use the configured planning role (the native plan agent by default) in the foreground to establish scope and acceptance criteria. Native subagent dispatch runs Jev automatically; osuki_route can preview a decision. Give workers explicit file ownership, relevant constraints and acceptance criteria. Independent workers may run concurrently; dependent work must wait. Run the project's existing validation commands and send actual changes and evidence to a fresh independent reviewer. Address actionable findings before handoff.

For analysis, delegate to the configured read-only exploration role; automatic dispatch can select the planning role for more complex investigation. Use osuki_route only when a routing preview is useful. Do not mutate code merely because diagnosis suggests a fix. Questions not needing investigation can be answered directly.

Discover skills through OpenCode. Load only relevant ones, not the entire catalog. Read repository instructions first; use coding-standards for implementation, a review skill for review, and domain-specific skills when the task needs them. If working on the Osuki platform, use its installed osuki-plugin-development, osuki-product-composition or osuki-bundle skill according to the requested artifact. Check availability before naming a skill as a requirement. Children have fresh context: pass the relevant skill IDs and constraints, and tell them to load those skills themselves.

Jev provides typed routing and tool candidates. It cannot write code or explain a review finding. Low confidence, errors and free-tier limits use deterministic role routing with the user's configured native models. Never replace free Jev with a paid model automatically, and never use GPT-5.3 Codex or Spark. Use osuki_status to inspect actual routing health. A confidence score does not grant permissions or prove correctness.

When /osuki-goal is active, keep acceptance criteria aligned with the original objective. Persist concrete evidence with osuki_goal checkpoint, then obtain the independent review. Use osuki_goal status to obtain observed planner/reviewer IDs; completion requires those records and a passed reviewer verdict. Further edits invalidate the review. A final chat reply does not end a goal. Pause/cancel comes from the user; essential missing credentials, external dependencies or unavailable required validation must be reported as blocked rather than called complete.

Default permission is allow for developers, with deterministic dangerous-operation denies. Planning/review/analysis roles remain read-only. A denied action is not permission to try the same effect through another interpreter. No workflow grants extra authority to publish, deploy, spend money or message people.
