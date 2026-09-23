# @osuki-dev/opencode-osuki-agent

## 0.2.5

### Patch Changes

- [#18](https://github.com/osuki-dev/opencode-osuki-agent/pull/18) [`9a4c0dc`](https://github.com/osuki-dev/opencode-osuki-agent/commit/9a4c0dc4ad60dc2c48357351668b05cd09447d05) Thanks [@ryuhzk](https://github.com/ryuhzk)! - Reduce unnecessary planning and reviewer escalation for bounded edits, delegate confidently routed implementation work, and preserve request routing through OpenCode transport recovery.

## 0.2.4

### Patch Changes

- [#16](https://github.com/osuki-dev/opencode-osuki-agent/pull/16) [`5742476`](https://github.com/osuki-dev/opencode-osuki-agent/commit/57424762993174082e0cd8bb5ed24b0856091320) Thanks [@ryuhzk](https://github.com/ryuhzk)! - Support OpenCode 2.0.12 skill registration and interruption controls. Validate plugin skills against the official SDK schema and require OpenCode 2.0.12 or newer.

## 0.2.3

### Patch Changes

- [#14](https://github.com/osuki-dev/opencode-osuki-agent/pull/14) [`ff01fa3`](https://github.com/osuki-dev/opencode-osuki-agent/commit/ff01fa37026b7768898c3ef2f577ba429fabf805) Thanks [@ryuhzk](https://github.com/ryuhzk)! - Keep small tasks on a proportionate workflow: reuse confident routing decisions, skip ineffective tool ranking, and avoid persistent bookkeeping for one-off foreground workers.
  
  Validate resolved and resumed subagents, preserve parallel dispatch, and reject stale review evidence during concurrent edits. Track overlapping CodeMode writes through native completion and interruption. Keep native tool catalogs and packaged skill paths usable.
  
  Allow a configurable 10-second Jev deadline, recover from isolated timeouts without a minute-long cooldown, and distinguish unavailable review from missing code evidence. Expose action-specific work schemas to prevent invalid state transitions.

## 0.2.2

### Patch Changes

- [#12](https://github.com/osuki-dev/opencode-osuki-agent/pull/12) [`42b02dc`](https://github.com/osuki-dev/opencode-osuki-agent/commit/42b02dc81b47b9e079274cbf1cabcb5f1a765725) Thanks [@ryuhzk](https://github.com/ryuhzk)! - Register bundled agent prompts and worker modes automatically when the npm plugin loads. Preserve configured models and custom prompts, enable native planner delegation, and remove manual agent installation from the quickstart.

## 0.2.1

### Patch Changes

- [#9](https://github.com/osuki-dev/opencode-osuki-agent/pull/9) [`8848dea`](https://github.com/osuki-dev/opencode-osuki-agent/commit/8848dea136f07353a86c09bb9233968eb47afc31) Thanks [@ryuhzk](https://github.com/ryuhzk)! - Separate Jev model routing from planning so clear, bounded requests can proceed directly without inheriting earlier task complexity. Require evidence-backed reassessment when Jev is uncertain, avoid unnecessary reviewer escalation, and expose bounded routing diagnostics. Refine workflow and tool prompts for native planning, continuity, and lightweight diff review.

## 0.2.0

### Minor Changes

- [#7](https://github.com/osuki-dev/opencode-osuki-agent/pull/7) [`35eecad`](https://github.com/osuki-dev/opencode-osuki-agent/commit/35eecad10d93287cc62977bd2c5b43769851f2c7) Thanks [@ryuhzk](https://github.com/ryuhzk)! - Preserve active objectives across follow-up messages with Jev intent classification and native OpenCode worker coordination. Add revision-checked work checkpoints, explicit pause and cancellation controls, and focused continuity guidance loaded on demand. Display the coordinator as Osuki while retaining its configurable models and stable agent ID.

## 0.1.3

### Patch Changes

- [#5](https://github.com/osuki-dev/opencode-osuki-agent/pull/5) [`1d73da2`](https://github.com/osuki-dev/opencode-osuki-agent/commit/1d73da28202b9ed7a95a6e75b2fd753802969f4c) Thanks [@ryuhzk](https://github.com/ryuhzk)! - Separate validation blockers and local review findings from genuine risk escalation. Use proportional validation prompts and prevent quick edits from invoking the independent reviewer solely because evidence is incomplete, while preserving explicit project gates and goal review requirements.

## 0.1.2

### Patch Changes

- [#4](https://github.com/osuki-dev/opencode-osuki-agent/pull/4) [`61dbfa6`](https://github.com/osuki-dev/opencode-osuki-agent/commit/61dbfa6de3dce2671ee7abb59dcd9ebec724f7f8) Thanks [@ryuhzk](https://github.com/ryuhzk)! - Use JSON-only tool schemas across the OpenCode Code Mode boundary and retain local Effect validation for routing, review and status inputs.

- [#2](https://github.com/osuki-dev/opencode-osuki-agent/pull/2) [`aac83b7`](https://github.com/osuki-dev/opencode-osuki-agent/commit/aac83b7a27129e95dda451927cf1503471466e0a) Thanks [@ryuhzk](https://github.com/ryuhzk)! - Add focused Jev review for validated quick edits, with conservative escalation to the configured reviewer. Preserve goal review receipts and refresh cached workflows after risk reassessment.

- [#2](https://github.com/osuki-dev/opencode-osuki-agent/pull/2) [`aac83b7`](https://github.com/osuki-dev/opencode-osuki-agent/commit/aac83b7a27129e95dda451927cf1503471466e0a) Thanks [@ryuhzk](https://github.com/ryuhzk)! - Let confident Jev quick-task decisions skip the planner for bounded cosmetic and mechanical edits. Preserve planning for uncertain or risky work and explicit goals. Validate both paths, using lightweight Jev review for eligible quick edits and independent review otherwise.

- [#2](https://github.com/osuki-dev/opencode-osuki-agent/pull/2) [`aac83b7`](https://github.com/osuki-dev/opencode-osuki-agent/commit/aac83b7a27129e95dda451927cf1503471466e0a) Thanks [@ryuhzk](https://github.com/ryuhzk)! - Add an explicit TypeSafe Jev provider using the server environment through Effect Config.redacted. Preserve OpenCode-native credentials for Zen, isolate providers, retain recent routing context, and classify HTTP failures while respecting Retry-After.

## 0.1.1

### Patch Changes

- [`7f22e1b`](https://github.com/osuki-dev/opencode-osuki-agent/commit/7f22e1b8ac20538cb76ff2e03e764ed48a54e3fd) Thanks [@ryuhzk](https://github.com/ryuhzk)! - Publish the built Osuki plugin with its agent prompts, workflow skill and MIT license. Automate version pull requests and npm releases with Changesets.
