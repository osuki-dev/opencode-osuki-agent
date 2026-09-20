import { expect, spyOn, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema, Stream } from "effect"
import plugin from "../src/index.ts"

type Hook = (event: Record<string, unknown>) => Effect.Effect<void, unknown>
type Tool = {
  name: string
  execute(input: unknown, context: { sessionID: string; agent: string }): Effect.Effect<{ content: string }, unknown>
}

const makeHarness = Effect.fn("test.makePluginHarness")(function* (
  options: { credentials?: boolean; brokenLookup?: boolean } = {}
) {
  const permissionHooks = new Map<string, Hook[]>()
  const toolHooks = new Map<string, Hook[]>()
  const sessionHooks = new Map<string, Hook[]>()
  const tools = new Map<string, Tool>()
  const selectedAgents: string[] = []
  const model = { providerID: "openai", id: "configured-model", variant: "high" }
  const registerHook = (registry: Map<string, Hook[]>) => (name: string, hook: Hook) =>
    Effect.sync(() => {
      registry.set(name, [...(registry.get(name) ?? []), hook])
      return { dispose: Effect.void }
    })
  const noTransform = () => Effect.succeed({ dispose: Effect.void })
  const ctx = {
    options: {},
    app: { version: "2.0.1" },
    command: { transform: noTransform },
    skill: { transform: noTransform, list: () => Effect.succeed({ data: [] }) },
    storage: { get: () => Effect.succeed(undefined), set: () => Effect.void },
    event: { subscribe: () => Stream.never },
    integration: {
      connection: {
        active: () => Effect.succeed(options.credentials ? "opencode-key" : undefined),
        resolve: () => Effect.succeed({ type: "key", key: "test-only" })
      }
    },
    agent: {
      get: ({ agentID }: { agentID: string }) =>
        Effect.sync(() => {
          selectedAgents.push(agentID)
          return { data: { id: agentID, mode: "subagent", model } }
        }),
      list: () => Effect.succeed({ data: [{ id: "osuki-worker-quick", mode: "subagent", model }] })
    },
    session: {
      hook: registerHook(sessionHooks),
      get: ({ sessionID }: { sessionID: string }) =>
        options.brokenLookup
          ? Effect.fail(new Error("session inventory unavailable"))
          : Effect.succeed(
              sessionID === "root"
                ? { id: "root", agent: "osuki" }
                : sessionID === "unrelated"
                  ? { id: "unrelated", agent: "general" }
                  : { id: sessionID, agent: sessionID === "worker" ? "general" : "unlisted-agent", parentID: "root" }
            )
    },
    permission: { hook: registerHook(permissionHooks) },
    tool: {
      hook: registerHook(toolHooks),
      transform: (transform: (editor: { add(tool: Tool): void }) => void) =>
        Effect.sync(() => {
          transform({
            add: (tool) => {
              tools.set(tool.name, tool)
            }
          })
          return { dispose: Effect.void }
        })
    }
  } as unknown as Context
  yield* plugin.effect(ctx)
  const runHooks = (registry: Map<string, Hook[]>, name: string, event: Record<string, unknown>) =>
    Effect.forEach(registry.get(name) ?? [], (hook) => hook(event), { discard: true })
  return {
    model,
    selectedAgents,
    permission: (event: Record<string, unknown>) => runHooks(permissionHooks, "evaluate", event),
    before: (event: Record<string, unknown>) => runHooks(toolHooks, "execute.before", event),
    context: (event: Record<string, unknown>) => runHooks(sessionHooks, "context", event),
    call: (name: string, input: unknown, agent = "osuki") =>
      tools.get(name)!.execute(input, { sessionID: "root", agent }),
    status: () => tools.get("osuki_status")!.execute({}, { sessionID: "root", agent: "osuki" })
  }
})

test("Jev cannot be selected as the Osuki conversation model", async () => {
  await expect(
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness()
          yield* harness.context({
            sessionID: "root",
            agent: "osuki",
            model: { providerID: "opencode", id: "jev-1.13-free" },
            tools: {},
            system: [],
            messages: []
          })
        })
      )
    )
  ).rejects.toThrow("Jev is the routing model, not a chat model")
})

test("managed workers and unlisted descendants cannot delegate through either enforcement hook", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        for (const [sessionID, agent] of [
          ["worker", "general"],
          ["other-child", "unlisted-agent"]
        ]) {
          const permission = { sessionID, agent, action: "subagent", resources: ["build"], effect: "ask" }
          yield* harness.permission(permission)
          expect(permission.effect).toBe("deny")
          expect(
            yield* harness
              .before({ sessionID, agent, tool: "subagent", input: { agent: "build" } })
              .pipe(Effect.isFailure)
          ).toBe(true)
        }
        const unrelated = {
          sessionID: "unrelated",
          agent: "general",
          action: "subagent",
          resources: ["build"],
          effect: "ask"
        }
        yield* harness.permission(unrelated)
        expect(unrelated.effect).toBe("ask")
      })
    )
  )
})

test("dangerous operations stay denied for unlisted descendants and planners stay read-only", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        const dangerous = {
          sessionID: "other-child",
          agent: "unlisted-agent",
          action: "shell",
          resources: ["/usr/sbin/mkfs.ext4 /dev/sdb"],
          effect: "allow"
        }
        yield* harness.permission(dangerous)
        expect(dangerous.effect).toBe("deny")
        expect(
          yield* harness
            .before({
              sessionID: "other-child",
              agent: "unlisted-agent",
              tool: "shell",
              input: { command: "rm -rf /tmp/example" }
            })
            .pipe(Effect.isFailure)
        ).toBe(true)
        const planner = {
          sessionID: "planner",
          agent: "plan",
          action: "edit",
          resources: ["src/app.ts"],
          effect: "allow"
        }
        yield* harness.permission(planner)
        expect(planner.effect).toBe("deny")
      })
    )
  )
})

test("ancestry lookup failure aborts enforcement instead of allowing the operation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ brokenLookup: true })
        const event = {
          sessionID: "worker",
          agent: "general",
          action: "shell",
          resources: ["rm -rf /tmp/example"],
          effect: "ask"
        }
        const exit = yield* harness.permission(event).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        expect(event.effect).toBe("ask")
      })
    )
  )
})

test("initial requests batch workflow and tool routing, cache decisions, and reclassify new requests", async () => {
  const questionSets: string[][] = []
  const respond = async (_url: string | URL | Request, init?: RequestInit) => {
    const input = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))
    questionSets.push(Object.keys(input.questions))
    const answers = Object.fromEntries(
      Object.entries(input.questions).map(([id, raw]) => {
        const question = raw as { criteria: Record<string, string> }
        const keys = Object.keys(question.criteria)
        const choice = id === "complexity" ? (input.state.includes("architecture") ? "deep" : "quick") : "read"
        return [
          id,
          {
            type: "choice",
            choice,
            confidence: 0.95,
            probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0]))
          }
        ]
      })
    )
    return Response.json({ answers })
  }
  const fetch = spyOn(globalThis, "fetch").mockImplementation(respond as typeof globalThis.fetch)
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({ credentials: true })
          const event = (text: string, tools: Record<string, { description: string }> = {}) => ({
            sessionID: "root",
            agent: "osuki",
            model: harness.model,
            tools,
            system: [] as { type: string; text: string }[],
            messages: [{ role: "user", content: [{ type: "text", text }] }]
          })
          const first = event(
            "Remove the border",
            Object.fromEntries(
              ["read", "write", "edit", "shell", "search", "subagent"].map((name) => [name, { description: name }])
            )
          )
          yield* harness.context(first)
          expect(questionSets[0]).toEqual(["complexity", "next"])
          expect(first.system.some((part) => part.text.includes('"planning":"skip"'))).toBe(true)
          const same = event("Remove the border")
          yield* harness.context(same)
          expect(questionSets).toHaveLength(1)
          expect(same.system.some((part) => part.text.includes('"planning":"skip"'))).toBe(true)
          const changed = event("Redesign the authentication architecture")
          yield* harness.context(changed)
          expect(questionSets[1]).toEqual(["complexity"])
          expect(changed.system.some((part) => part.text.includes('"planning":"required"'))).toBe(true)
        })
      )
    )
  } finally {
    fetch.mockRestore()
  }
})

test("lightweight review follows workflow eligibility and risk reassessment updates cached context", async () => {
  const respond = async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))
    const risky = String(request.state).includes("security change")
    const choices: Record<string, string> = {
      complexity: risky ? "deep" : "quick",
      scope: "bounded",
      correctness: "satisfied",
      validation: "sufficient"
    }
    return Response.json({
      answers: Object.fromEntries(
        Object.entries(request.questions as Record<string, { criteria: Record<string, string> }>).map(
          ([id, question]) => [
            id,
            {
              type: "choice",
              choice: choices[id],
              confidence: 0.95,
              probabilities: Object.fromEntries(
                Object.keys(question.criteria).map((key) => [key, key === choices[id] ? 1 : 0])
              )
            }
          ]
        )
      )
    })
  }
  const fetch = spyOn(globalThis, "fetch").mockImplementation(respond as typeof globalThis.fetch)
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({ credentials: true })
          const input = {
            task: "Remove border",
            diff: "@@ -1 +1 @@\n-border: solid;\n+border: none;",
            context: "Only the card border changes",
            validation: [{ check: "Visual inspection", result: "passed", evidence: "No border; layout unchanged" }]
          }
          expect(JSON.parse((yield* harness.call("osuki_review", input)).content).outcome).toBe("reviewer-required")
          const event = () => ({
            sessionID: "root",
            agent: "osuki",
            model: harness.model,
            tools: {},
            system: [] as { text: string }[],
            messages: [{ role: "user", content: [{ type: "text", text: "Remove border" }] }]
          })
          yield* harness.context(event())
          expect(JSON.parse((yield* harness.call("osuki_review", input)).content).outcome).toBe("lightweight-passed")
          const denied = yield* harness.call("osuki_review", input, "general").pipe(Effect.exit)
          expect(denied._tag).toBe("Failure")
          yield* harness.call("osuki_route", { role: "implement", task: "Discovered security change" })
          const refreshed = event()
          yield* harness.context(refreshed)
          expect(refreshed.system.some((part) => part.text.includes('"planning":"required"'))).toBe(true)
          expect(JSON.parse((yield* harness.call("osuki_review", input)).content).outcome).toBe("reviewer-required")
          expect(fetch).toHaveBeenCalledTimes(3)
        })
      )
    )
  } finally {
    fetch.mockRestore()
  }
})

test("initial workflow falls back to planning when Jev has no credential", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        const event = {
          sessionID: "root",
          agent: "osuki",
          model: harness.model,
          tools: {},
          system: [] as { type: string; text: string }[],
          messages: [{ role: "user", content: [{ type: "text", text: "Remove a border" }] }]
        }
        yield* harness.context(event)
        expect(
          event.system.some(
            (part) => part.text.includes('"planning":"required"') && part.text.includes('"source":"fallback"')
          )
        ).toBe(true)
      })
    )
  )
})

test("Jev decision rewrites native dispatch and records the configured agent model", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      answers: {
        complexity: {
          type: "choice",
          choice: "quick",
          confidence: 0.95,
          probabilities: { quick: 0.95, standard: 0.04, deep: 0.01 }
        }
      }
    })
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({ credentials: true })
          const event = {
            sessionID: "root",
            agent: "osuki",
            tool: "subagent",
            input: {
              agent: "general",
              description: "Rename variable",
              prompt: "Rename a local variable",
              background: false
            }
          }
          yield* harness.before(event)
          expect(event.input.agent).toBe("osuki-worker-quick")
          expect(harness.selectedAgents).toEqual(["osuki-worker-quick"])
          const status = yield* harness.status()
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                lastRoute: Schema.Struct({
                  agent: Schema.String,
                  source: Schema.String,
                  dispatch: Schema.String,
                  model: Schema.Struct({ providerID: Schema.String, id: Schema.String, variant: Schema.String })
                })
              })
            )
          )(status.content)
          expect(decoded.lastRoute).toEqual({
            agent: "osuki-worker-quick",
            source: "jev",
            dispatch: "applied",
            model: harness.model
          })
        })
      )
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally {
    fetch.mockRestore()
  }
})
