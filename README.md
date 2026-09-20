# Osuki for OpenCode

An Effect-native coordinator with Jev routing, native subagents, project skills, and persistent goals.

## Run

Requires Bun 1.4.2+ and OpenCode 2.0.1. The SDK is pinned to the tested host version; newer OpenCode releases may change plugin APIs.

Configuration references the official `https://opencode.ai/config.json` schema. At verification time that endpoint still returned V1 fields (`plugin` and `agent`), causing editor warnings for valid V2 `plugins` and `agents` entries. Native V2 validation and runtime loading are tested independently. The root model omits a variant; per-agent models retain their `#variant` settings.

```sh
bun install --frozen-lockfile
bun test
bun run build
opencode
```

This repository configures the plugin locally. Select `osuki` in a new session. To use it in another project, add this directory to that project's `plugins`, copy the four `agents/*.md` files into its `.opencode/agents`, and merge the `agents` entries from `opencode.json`. For global use, use `~/.config/opencode/agents` and the global OpenCode configuration instead. Preserve existing providers, credentials, MCP servers and permission rules.

## Models and routing

Configure models exclusively through native `agents.<id>.model` entries in `opencode.json(c)`. The included subscription-model assignments are editable examples, not runtime constants. Built-in `explore`, `plan` and `general` are reused; `plan` needs `mode: "all"` for delegation. Custom agents supply the coordinator, quick/deep workers and independent reviewer.

Jev automatically evaluates native subagent dispatch. Planning and review use the deep role policy; other tasks are classified by complexity. `osuki_route` is an optional preview. `osuki_status` reports actual role models, routing source and Jev health.

Jev is a structured decision model, not a chat model. The small Effect HTTP adapter calls OpenCode Zen's official `/v1/systemone` endpoint using the active OpenCode integration credential. No TypeSafe SDK or separate credential store is required. The default is `jev-1.13-free`; failures, low confidence and rate limits use explicit deterministic fallbacks, never an automatic paid-model fallback.

Do not select Jev as the session's conversation model. Select `osuki` as the agent and a coding model such as the configured Sol coordinator model. Existing sessions retain their previously selected model; changing the default configuration does not switch them.

Plugin options use OpenCode's native object-form registration:

```json
{
  "plugins": [
    {
      "package": "/absolute/path/opencode-osuki-agent",
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
        "jev": { "model": "jev-1.13-free", "timeoutMs": 2500, "cooldownMs": 60000 },
        "routing": { "confidence": 0.75, "toolConfidence": 0.8, "topK": 3 },
        "excludedModels": ["openai/gpt-5.3-codex", "openai/gpt-5.3-codex-spark"]
      }
    }
  ]
}
```

Tool optimization shortlists top-level tools only when Jev confidence is sufficient. Recovery and delegation tools remain available. OpenCode Code Mode and its internal tool catalog remain host-owned; this plugin does not claim to prune that inner catalog.

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
