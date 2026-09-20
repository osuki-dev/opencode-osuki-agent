---
name: osuki-workflow
description: Apply Osuki's implementation, validation, review and persistent-goal workflow using native OpenCode tools.
---

Use the injected role IDs and workflow decision; project instructions and user scope remain authoritative. This workflow does not authorize edits for questions or diagnosis.

## Implementation

With planning=skip, inspect and make the bounded change without a formal planner. With planning=required, obtain a foreground plan specifying affected paths, risks and acceptance checks. Explicit planning requests and active goals retain planning. Use osuki_route only to reassess changed scope or actual implementation risk.

Choose validation by impact. Documentation, cosmetic and mechanical edits usually need focused diff/context inspection; behavior changes need relevant regression checks. Run broad integration/E2E for cross-component risk or explicit project gates, not by default. Report unavailable required checks as blockers; do not silently waive policy or repair unrelated infrastructure.

## Review

For eligible quick edits, supply osuki_review with the original task, complete task diff including new files, relevant context and concrete check results. Identify the baseline and pre-existing changes. Do not omit risk to fit the context limit.

- lightweight-passed: no coding-model reviewer is needed outside goals.
- evidence-required: gather focused evidence or report a validation blocker.
- changes-required: inspect the flagged issue, correct confirmed defects and recheck.
- reviewer-required: use the configured independent foreground reviewer.

Do not retry unchanged evidence, escalate merely because infrastructure is unavailable, or treat a prior pass as covering later edits. Normal implementation and active goals retain independent review.

## Goals

When /osuki-goal is active, retain acceptance criteria, obtain the native planner, implement, validate and checkpoint evidence before a fresh foreground reviewer. Use observed IDs from osuki_goal status; completion requires a matching passed report for the current revision. Later edits invalidate review. Jev results never substitute for receipts. Respect pause/cancel; report concrete blockers.

## Tools and children

Reuse native exploration, planning and worker roles. Give children scope, file ownership, relevant facts, available skills and expected evidence; they do not inherit the full conversation. Parallelize only independent work.

Use targeted reads, reuse unchanged evidence and discover missing native capabilities. Jev narrows top-level tools, not every Code Mode operation. Probe routing health only when needed. No routing decision grants permissions, authorizes publication, or proves correctness.
