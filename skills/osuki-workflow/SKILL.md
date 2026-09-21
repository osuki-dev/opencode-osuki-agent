---
name: osuki-workflow
description: Apply Osuki's development, proportional review, follow-up coordination and goal workflow using native OpenCode tools.
---

Use the injected role IDs and workflow decision; project instructions and user scope remain authoritative. This workflow does not authorize edits for questions or diagnosis.

## Implementation

Resolve the latest request against recent conversation, keeping prior objectives without inheriting their complexity. Model tier does not prescribe a workflow. With planning=skip, answer, inspect or implement directly within user authority. With planning=required, delegate a read-only foreground pass to the configured native planner for the unresolved design choices, dependencies or risks. Explicit planning requests and active goals retain planning.

With planning=assess, inspect briefly or clarify the target; do not automatically delegate. If Jev remains unavailable or uncertain, use osuki_route with an assessment containing tier, planning and concrete evidence. Do not invent certainty or assume edit authority. Reassess a confident decision only when new scope/risk evidence or an explicit planning requirement changes it. A rejected planner call is not a reason to rename the task or delegate planning to a worker. osuki_status exposes recent request hashes, classifications, provider health and dispatch decisions for diagnosis.

Choose validation by impact. Documentation, cosmetic and mechanical edits usually need focused diff/context inspection; behavior changes need relevant regression checks. Run broad integration/E2E for cross-component risk or explicit project gates, not by default. Report unavailable required checks as blockers; do not silently waive policy or repair unrelated infrastructure.

## Review

For eligible quick edits, supply osuki_review with the original task, complete task diff including new files, relevant context and concrete check results. Obtain the unified diff from git diff or diff -u, not a handwritten summary. Identify the baseline and pre-existing changes. Do not omit risk to fit the context limit.

- lightweight-passed: no coding-model reviewer is needed outside goals.
- evidence-required: gather focused evidence or report a validation blocker.
- changes-required: inspect the flagged issue, correct confirmed defects and recheck.
- reviewer-required: use the configured independent foreground reviewer.

Do not retry unchanged evidence, escalate merely because infrastructure is unavailable, or treat a prior pass as covering later edits. Normal implementation and active goals retain independent review.

## Goals

When /osuki-goal is active, retain acceptance criteria, obtain the native planner, implement, validate and checkpoint evidence before a fresh foreground reviewer. Use observed IDs from osuki_goal status; completion requires a matching passed report for the current revision. Later edits invalidate review. Jev results never substitute for receipts. Respect pause/cancel; report concrete blockers.

## Tools and children

Reuse native exploration, planning and worker roles. Give children scope, file ownership, relevant facts, available skills and expected evidence; they do not inherit the full conversation. Parallelize only independent work.

Outside goal mode, record substantial work with osuki_work start; tiny single-step edits need no task record. Use native background workers when the coordinator should remain available; required planner/reviewer receipts remain foreground. For follow-ups or resuming unfinished work, read [references/continuity.md](references/continuity.md). Complete the record after integrating results and resolving pending requests. Active goals use their existing checkpoints instead.

Use targeted reads, reuse unchanged evidence and discover missing native capabilities. Jev narrows top-level tools, not every Code Mode operation. Probe routing health only when needed. No routing decision grants permissions, authorizes publication, or proves correctness.
