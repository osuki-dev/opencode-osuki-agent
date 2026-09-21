# @osuki-dev/opencode-osuki-agent

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
