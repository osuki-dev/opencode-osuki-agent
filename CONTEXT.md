# Architecture

Osuki is an Effect-native OpenCode plugin, not a separate agent runtime.
OpenCode owns sessions, model configuration, native agents, tools, skills,
credentials and persistence. Jev classifies work; it never grants authority or
proves completion.

## Ownership and flow

- `src/index.ts`: registers hooks and tools, enforces managed-session policy,
  classifies the current request, routes native dispatch and records routing audits.
- `src/agents.ts` and `agents/`: bundled role prompts; native user configuration
  can override them. Built-in exploration, planning and general workers are reused.
- `src/jev.ts`: provider credentials, Effect HTTP transport, response validation,
  redaction, serialized calls and cooldown. No automatic provider switching.
- `src/routing.ts`: complexity, planning and tool selection. Uncertainty requests
  assessment rather than automatically planning or escalating.
- `src/session-state.ts` and `src/dispatch.ts`: session-local decisions, review
  freshness and checks against the actual selected or resumed agent.
- `src/review.ts`: evidence-based lightweight review and escalation decisions.
- `src/goal.ts`: persistent goals, revision-bound planner/reviewer receipts,
  continuation, interruption and restart handling.
- `src/continuity.ts`: revisioned work records, pending follow-ups and observed
  child sessions. Goal and ordinary-work state remain separate.
- `src/config.ts`, `src/policy.ts`, `src/tool-schema.ts`: validated options,
  dangerous-operation rules and JSON-only tool schemas at the host boundary.
- `skills/`: on-demand workflow details and continuity guidance.

Each managed model request supplies recent context to Jev as needed. Its decision
guides the coordinator and narrows top-level tools only when optional tools exceed the shortlist budget;
OpenCode still owns Code Mode's inner catalog. Fixed native roles and identical
confident assignments need no additional Jev request. Different implementation
subtasks are assessed separately. Native dispatch uses configured agent models. Reviews and goals
require their own evidence, independently of the selected model tier.

## State and failure handling

OpenCode plugin storage holds work, goals and bounded redacted routing audits.
Partitioned semaphores serialize per-session state changes. Runtime workflow
caches are bounded; persisted goals pause after restart. Event subscriptions use
scoped fibers. Invalid evidence fails closed; unavailable Jev yields an explicit
fallback. `osuki_status` exposes routing and provider diagnostics without credentials.

## Configuration and delivery

Plugin options select providers, role IDs and thresholds. OpenCode agent settings
select models. TypeSafe uses the server environment; OpenCode Jev uses native
credentials. Do not put secrets in committed configuration.

`bun test` runs policy, lifecycle, transport, registration and package tests;
the package test builds in a temporary directory without changing the local `dist`.
Real-model checks use an
isolated server and inspect persisted tool calls rather than model claims.

`bun run build` bundles the plugin for npm; packaged skills remain beside `dist`.
Changesets and GitHub workflows handle releases. README documents installation
and configuration; this file maps implementation ownership. No separate on-call
system or nested architecture document is defined.
