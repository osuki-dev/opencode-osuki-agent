# Osuki for OpenCode

An Effect-native coordinator with Jev routing, native subagents, project skills, and persistent goals.

## Install in OpenCode

Requires OpenCode 2.0.1 and Bun 1.4.2+.

```sh
opencode plugin add @osuki-dev/opencode-osuki-agent@latest
```

Select **Osuki** in a new session and choose your coding model. The plugin registers its agents, workflow skill and goal commands automatically—no file copying or source build.

Connect OpenCode Zen for default Jev routing, or configure [the official TypeSafe API](#models-and-routing). Ask Osuki to run `osuki_status` with `probe: true` to verify Jev; TypeSafe probes may incur charges.

Models remain configurable through OpenCode's native `agents.<id>.model` settings. Workers inherit the session model unless configured otherwise. Existing agent files and model overrides still take precedence; remove only unmodified old Osuki prompt copies if you want package updates to supply their prompts.

To update:

```sh
opencode plugin update @osuki-dev/opencode-osuki-agent
```

See [OpenCode's plugin documentation](https://opencode.ai/v2/docs/plugins/) for configuration and reload behavior.

## Models and routing

Configure models exclusively through native `agents.<id>.model` entries in `opencode.json(c)`. The included subscription-model assignments are editable examples, not runtime constants. Built-in `explore`, `plan` and `general` are reused; `plan` needs `mode: "all"` for delegation. Custom agents supply the coordinator, quick/deep workers and independent reviewer.

Jev evaluates each new request in conversation context, batching model-tier and planning decisions with next-tool selection when eligible. Model tier does not prescribe planning: clear requests proceed directly; unresolved design choices, significant risk or explicit planning requests warrant a planner. Uncertain or unavailable Jev results request brief inspection or clarification, not automatic planning. `osuki_route` accepts evidence-backed coordinator assessments when Jev cannot decide and reassesses new scope or risk. Native planner dispatch enforces the current decision; active goals retain their planner receipts. `osuki_status` reports models, Jev health and the latest 24 persisted classification, reassessment and dispatch records, identified by request hash without storing request text.

Quick edits outside goal mode use `osuki_review` with the actual diff, surrounding context and focused validation evidence. Jev classifies scope, correctness and validation coverage. `lightweight-passed` avoids a coding-model reviewer; `evidence-required` requests focused inspection/checks or a validation-blocker report; `changes-required` requests investigation and correction of local findings. Only `reviewer-required` escalates to the configured independent reviewer. Missing evidence, an uncertain answer or an unavailable test environment never by themselves trigger that reviewer, and quick-workflow dispatch enforces this distinction. Complex or oversized work and active goals retain independent review. Choose checks by change impact rather than running full E2E for every edit; explicit repository gates still apply. Jev evaluates supplied evidence, does not execute tests, and never creates goal completion receipts.

Jev is a structured decision model, not a chat model. The Effect HTTP client supports two explicit providers. No TypeSafe SDK, `.env` loader or separate credential store is used. Failures, low confidence and rate limits use deterministic routing fallbacks, never an automatic switch to another provider.

- `opencode` (default): calls OpenCode Zen using the active native OpenCode integration credential. Its default model is `jev-1.13-free`.
- `typesafe`: calls `https://api.typesafe.ai/v1/systemone` using `TYPESAFE_API_KEY` from the OpenCode server process environment. Its default model is `jev-latest`; API calls use your TypeSafe account and may incur charges.

To select TypeSafe, replace the existing Osuki plugin entry with the following object; do not append a second registration:

```json
{
  "plugins": [
    {
      "package": "@osuki-dev/opencode-osuki-agent@latest",
      "options": { "jev": { "provider": "typesafe", "model": "jev-latest" } }
    }
  ]
}
```

Inject `TYPESAFE_API_KEY` through your system or service environment before starting the OpenCode server. Reading it follows OpenCode's documented Effect `Config.redacted` pattern. A terminal export does not change an already-running background server; ensure its launch environment contains the variable and restart it after changes. Do not put the key in plugin options. Missing or empty keys produce `missing-typesafe-credential` in `osuki_status` and deterministic routing, not a request to another provider. Status probes also use the selected provider. Both modes allow a configurable model; endpoints are restricted to the matching service to prevent credential forwarding.

Do not select Jev as the session's conversation model. Select `osuki` as the agent and a coding model such as the configured Sol coordinator model. Existing sessions retain their previously selected model; changing the default configuration does not switch them.

Plugin options use OpenCode's native object-form registration:

```json
{
  "plugins": [
    {
      "package": "@osuki-dev/opencode-osuki-agent@latest",
      "options": {
        "coordinator": "osuki",
        "agents": {
          "explore": "explore",
          "plan": "plan",
          "review": "osuki-reviewer",
          "quick": "osuki-worker-quick",
          "standard": "general",
          "deep": "osuki-worker-deep"
        },
        "jev": { "model": "jev-1.13-free", "timeoutMs": 10000, "cooldownMs": 60000 },
        "routing": { "confidence": 0.75, "toolConfidence": 0.8, "topK": 3 },
        "excludedModels": ["openai/gpt-5.3-codex", "openai/gpt-5.3-codex-spark"]
      }
    }
  ]
}
```

Jev has a configurable 10-second request deadline, not a fixed delay. A timeout backs off from 5 seconds up to `cooldownMs`; there are no automatic retries. HTTP rate limits retain their backoff and `Retry-After` handling. An unavailable review stays pending without triggering extra code checks or an expensive reviewer.

Tool optimization shortlists top-level tools only when Jev confidence is sufficient and optional tools exceed the shortlist budget. Recovery and delegation tools remain available. OpenCode Code Mode and its internal tool catalog remain host-owned; this plugin does not claim to prune that inner catalog.

## Follow-up messages

The coordinator displays as **Osuki**; its configuration ID remains `osuki`. Outside goal mode, `osuki_work` preserves substantial objectives, requirement revisions, observed child session IDs and unresolved requests in native plugin storage. Jev classifies follow-ups without replacing the original complexity decision: questions, compatible additions, separate requests, conflicts, cancellation, or uncertainty. The coordinator forwards or schedules accepted work through native tools; classification itself does not interrupt, send messages or authorize edits.

Background workers use OpenCode's native execution and completion notifications. Independent requests remain pending until ownership and dependencies are checked; conflicts need reconciliation. `osuki_work` pause/cancel interrupts recorded children using native controls, while state alone is never proof that a child is running. No separate inbox, database or memory service is added. Detailed follow-up procedures live in the workflow skill's on-demand continuity reference. Existing `/osuki-goal` checkpoints and receipts remain separate.

## Goals

- `/osuki-goal <objective>` starts a persistent goal.
- `/osuki-goal-status` displays it.
- `/osuki-goal-pause`, `/osuki-goal-resume`, `/osuki-goal-cancel` control execution.

A final chat reply does not complete the goal. Completion requires acceptance evidence, an observed foreground planner call, and a matching independent reviewer child reporting approval after the latest checkpoint. Subsequent mutations invalidate review. User interruptions pause execution; runtime failures and three no-progress rounds block it. Plugin reloads pause persisted active goals until explicit resume. This is persistent continuation, not a guarantee of eventual success.

## Permissions and skills

Ordinary actions in Osuki sessions are allowed unless a native configuration explicitly denies them. Planning, exploration and review are read-only; only the coordinator may delegate. Common destructive shell operations are rejected. This guard is accident prevention, not an operating-system sandbox: arbitrary scripts and external tools cannot be proven safe by command matching.

The plugin registers `osuki-workflow` and uses OpenCode's existing skill discovery and `skill` tool. Project instructions and relevant skills remain part of the workflow.

## Dependencies

`effect@4.0.0-rc.112` is the only direct runtime package. `@opencode/plugin@2.0.1` is a development dependency because every SDK import is type-only. Runtime validation uses Effect Schema. Upstream OpenCode packages bring their own transitive dependencies; this project does not import Zod or add a Jev SDK. If runtime SDK helpers such as `Plugin.define` are introduced, move the SDK to runtime dependencies.
