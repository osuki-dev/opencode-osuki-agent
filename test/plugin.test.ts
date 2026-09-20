import { expect, spyOn, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, PubSub, Schema, Stream } from "effect"
import plugin from "../src/index.ts"

type Hook = (event: Record<string, unknown>) => Effect.Effect<void, unknown>
type Tool = {
  name: string
  input: unknown
  execute(input: unknown, context: { sessionID: string; agent: string }): Effect.Effect<{ content: string }, unknown>
}

const makeHarness = Effect.fn("test.makePluginHarness")(function* (
  options: {
    credentials?: boolean
    brokenLookup?: boolean
    storage?: Map<string, unknown>
    events?: PubSub.PubSub<unknown>
  } = {}
) {
  const permissionHooks = new Map<string, Hook[]>()
  const toolHooks = new Map<string, Hook[]>()
  const sessionHooks = new Map<string, Hook[]>()
  const tools = new Map<string, Tool>()
  const storage = options.storage ?? new Map<string, unknown>()
  const interrupts: string[] = []
  const displayAgent = { id: "osuki", name: "osuki", model: { id: "user-selected-model" } }
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
    storage: {
      get: (key: string) => Effect.succeed(storage.get(key)),
      set: (key: string, value: unknown) =>
        Effect.sync(() => {
          storage.set(key, value)
        })
    },
    event: { subscribe: () => (options.events ? Stream.fromPubSub(options.events) : Stream.never) },
    integration: {
      connection: {
        active: () => Effect.succeed(options.credentials ? "opencode-key" : undefined),
        resolve: () => Effect.succeed({ type: "key", key: "test-only" })
      }
    },
    agent: {
      transform: (
        transform: (editor: { update(id: string, fn: (agent: typeof displayAgent) => void): void }) => void
      ) =>
        Effect.sync(() => {
          transform({
            update: (id, fn) => {
              if (id === displayAgent.id) fn(displayAgent)
            }
          })
          return { dispose: Effect.void }
        }),
      get: ({ agentID }: { agentID: string }) =>
        Effect.sync(() => {
          selectedAgents.push(agentID)
          return { data: { id: agentID, mode: "subagent", model } }
        }),
      list: () => Effect.succeed({ data: [{ id: "osuki-worker-quick", mode: "subagent", model }] })
    },
    session: {
      interrupt: ({ sessionID }: { sessionID: string }) =>
        Effect.sync(() => {
          interrupts.push(sessionID)
          return { interrupted: true }
        }),
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
    storage,
    interrupts,
    displayAgent,
    tools,
    model,
    selectedAgents,
    permission: (event: Record<string, unknown>) => runHooks(permissionHooks, "evaluate", event),
    before: (event: Record<string, unknown>) => runHooks(toolHooks, "execute.before", event),
    after: (event: Record<string, unknown>) => runHooks(toolHooks, "execute.after", event),
    context: (event: Record<string, unknown>) => runHooks(sessionHooks, "context", event),
    call: (name: string, input: unknown, agent = "osuki") =>
      tools.get(name)!.execute(input, { sessionID: "root", agent }),
    status: () => tools.get("osuki_status")!.execute({}, { sessionID: "root", agent: "osuki" })
  }
})

test("routing and review expose JSON-only schemas and validate arguments locally", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        for (const name of ["osuki_route", "osuki_review", "osuki_status"]) {
          const input = harness.tools.get(name)!.input
          expect(JSON.parse(JSON.stringify(input))).toEqual(input)
          expect(input).toHaveProperty("type", "object")
          expect(input).not.toHaveProperty("ast")
        }
        const invalidRoute = yield* harness.call("osuki_route", { task: "", role: "implement" }).pipe(Effect.exit)
        expect(invalidRoute._tag).toBe("Failure")
        const invalidReview = yield* harness
          .call("osuki_review", {
            task: "x",
            diff: "x",
            context: "x",
            validation: [{ check: "x", result: "passed", evidence: "" }]
          })
          .pipe(Effect.exit)
        expect(invalidReview._tag).toBe("Failure")
      })
    )
  )
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
          const reviewer = () => ({
            sessionID: "root",
            agent: "osuki",
            tool: "subagent",
            input: {
              agent: "osuki-reviewer",
              description: "Review border change",
              prompt: "Review the border-only change",
              background: false
            }
          })
          expect((yield* harness.before(reviewer()).pipe(Effect.exit))._tag).toBe("Failure")
          const incomplete = {
            ...input,
            validation: [{ check: "E2E", result: "failed", evidence: "Emulator selection is ambiguous" }]
          }
          expect(JSON.parse((yield* harness.call("osuki_review", incomplete)).content).outcome).toBe(
            "evidence-required"
          )
          expect((yield* harness.before(reviewer()).pipe(Effect.exit))._tag).toBe("Failure")
          expect(harness.selectedAgents).toHaveLength(0)
          const goal = {
            id: "goal-test",
            sessionID: "root",
            objective: "Goal fixture",
            status: "paused",
            revision: 0,
            acceptance: [],
            receipts: [],
            processed: [],
            rounds: 0
          }
          harness.storage.set("goal:root", goal)
          expect((yield* harness.before(reviewer()).pipe(Effect.exit))._tag).toBe("Failure")
          harness.storage.set("goal:root", { ...goal, status: "active" })
          yield* harness.before(reviewer())
          expect(harness.selectedAgents).toEqual(["osuki-reviewer"])
          harness.storage.clear()
          const denied = yield* harness.call("osuki_review", input, "general").pipe(Effect.exit)
          expect(denied._tag).toBe("Failure")
          yield* harness.call("osuki_route", { role: "implement", task: "Discovered security change" })
          const refreshed = event()
          yield* harness.context(refreshed)
          expect(refreshed.system.some((part) => part.text.includes('"planning":"required"'))).toBe(true)
          expect(JSON.parse((yield* harness.call("osuki_review", input)).content).outcome).toBe("reviewer-required")
          yield* harness.before(reviewer())
          expect(harness.selectedAgents).toEqual(["osuki-reviewer", "osuki-reviewer"])
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

test("Osuki changes only the display name, not the agent ID or configured model", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        expect(harness.displayAgent).toEqual({ id: "osuki", name: "Osuki", model: { id: "user-selected-model" } })
      })
    )
  )
})

test("follow-up questions preserve workflow; additions persist and completion requires resolution", async () => {
  const questions: string[][] = []
  let intent = "question"
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))
    questions.push(Object.keys(request.questions))
    return Response.json({
      answers: Object.fromEntries(
        Object.entries(request.questions as Record<string, { criteria: Record<string, string> }>).map(
          ([id, question]) => {
            const choice = id === "message" ? intent : "quick"
            return [
              id,
              {
                type: "choice",
                choice,
                confidence: 0.95,
                probabilities: Object.fromEntries(
                  Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0])
                )
              }
            ]
          }
        )
      )
    })
  }) as typeof globalThis.fetch)
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({ credentials: true })
          const context = (text: string) => ({
            sessionID: "root",
            agent: "osuki",
            model: harness.model,
            tools: {},
            system: [] as { text: string }[],
            messages: [{ role: "user", content: [{ type: "text", text }] }]
          })
          yield* harness.context(context("Remove the border"))
          yield* harness.call("osuki_work", { action: "start", objective: "Remove the border" })
          const question = context("How is it going?")
          yield* harness.context(question)
          yield* harness.context(context("How is it going?"))
          expect(questions).toEqual([["complexity"], ["message"]])
          expect(question.system.some((part) => part.text.includes('"planning":"skip"'))).toBe(true)
          let work = JSON.parse((yield* harness.call("osuki_work", { action: "status" })).content)
          expect(work.objective).toBe("Remove the border")
          expect(work.pending).toEqual([])
          expect(harness.interrupts).toEqual([])
          for (const kind of ["amend", "independent", "conflict", "cancel"]) {
            intent = kind
            yield* harness.context(context(`Follow-up ${kind}`))
          }
          work = JSON.parse((yield* harness.call("osuki_work", { action: "status" })).content)
          expect(work.pending.map((item: { intent: string }) => item.intent)).toEqual([
            "amend",
            "independent",
            "conflict",
            "cancel"
          ])
          expect(work.status).toBe("active")
          expect(harness.interrupts).toEqual([]) // Advice never performs a cancellation.
          expect(
            yield* harness
              .call("osuki_work", { action: "complete", revision: 0, evidence: "Inspected diff" })
              .pipe(Effect.isFailure)
          ).toBe(true)
          yield* harness.call("osuki_work", {
            action: "checkpoint",
            revision: 0,
            objective: "Reconciled objective",
            resolved: work.pending.map((item: { id: string }) => item.id),
            evidence: "User clarified the requirements; all additions incorporated."
          })
          expect(
            yield* harness
              .call("osuki_work", { action: "complete", revision: 0, evidence: "Stale" })
              .pipe(Effect.isFailure)
          ).toBe(true)
          yield* harness.call("osuki_work", {
            action: "complete",
            revision: 1,
            evidence: "Inspected integrated diff and relevant checks passed."
          })
          const reopened = yield* makeHarness({ storage: harness.storage })
          expect(JSON.parse((yield* reopened.call("osuki_work", { action: "status" })).content).status).toBe(
            "completed"
          )
        })
      )
    )
  } finally {
    fetch.mockRestore()
  }
})

test("work records capture native child revisions, stop scoped children and reject corrupt state", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        yield* harness.call("osuki_work", { action: "start", objective: "Build feature" })
        const event = {
          id: "call-one",
          sessionID: "root",
          agent: "osuki",
          tool: "subagent",
          input: { agent: "general", description: "Implement feature", prompt: "Build feature", background: true }
        }
        yield* harness.before(event)
        yield* harness.call("osuki_work", {
          action: "checkpoint",
          revision: 0,
          objective: "Build revised feature",
          evidence: "Accepted user clarification."
        })
        yield* harness.after({
          ...event,
          status: "completed",
          result: { output: { sessionID: "worker", status: "running" } }
        })
        let work = JSON.parse((yield* harness.call("osuki_work", { action: "status" })).content)
        expect(work.workers[0].revision).toBe(0)
        expect(work.revision).toBe(1)
        yield* harness.call("osuki_work", { action: "pause", revision: 1, evidence: "User requested a pause." })
        expect(harness.interrupts).toEqual(["worker"])
        const reloaded = yield* makeHarness({ storage: harness.storage })
        work = JSON.parse((yield* reloaded.call("osuki_work", { action: "status" })).content)
        expect(work.status).toBe("paused")
        expect(reloaded.interrupts).toEqual([])
        expect(yield* harness.call("osuki_work", { action: "status" }, "general").pipe(Effect.isFailure)).toBe(true)
        harness.storage.set("work:root", { revision: "invalid" })
        expect(yield* harness.call("osuki_work", { action: "status" }).pipe(Effect.isFailure)).toBe(true)
      })
    )
  )
})

test("native user interruptions pause work but superseded turns do not", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<unknown>()
        const harness = yield* makeHarness({ events })
        yield* harness.call("osuki_work", { action: "start", objective: "Build feature" })
        yield* PubSub.publish(events, {
          type: "session.execution.interrupted",
          data: { sessionID: "root", reason: "superseded" }
        })
        yield* Effect.sleep("5 millis")
        expect(JSON.parse((yield* harness.call("osuki_work", { action: "status" })).content).status).toBe("active")
        yield* PubSub.publish(events, {
          type: "session.execution.interrupted",
          data: { sessionID: "root", reason: "user" }
        })
        yield* Effect.sleep("5 millis")
        expect(JSON.parse((yield* harness.call("osuki_work", { action: "status" })).content).status).toBe("paused")
        expect(harness.interrupts).toEqual([])
      })
    )
  )
})

test("active goals retain their own checkpoints instead of creating a second work record", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        const goal = {
          id: "existing-goal",
          sessionID: "root",
          objective: "Existing goal",
          status: "active",
          revision: 0,
          acceptance: [],
          receipts: [],
          processed: [],
          rounds: 0
        }
        harness.storage.set("goal:root", goal)
        const event = {
          id: "goal-call",
          sessionID: "root",
          agent: "osuki",
          tool: "subagent",
          input: { agent: "plan", description: "Plan", prompt: "Plan the goal" }
        }
        // The first read reconciles a persisted goal after plugin startup.
        yield* harness.before(event)
        harness.storage.delete("work:root")
        harness.storage.set("goal:root", { ...goal, status: "active" })
        yield* harness.before({ ...event, id: "active-goal-call" })
        expect(harness.storage.has("work:root")).toBe(false)
        expect(
          yield* harness
            .call("osuki_work", { action: "start", objective: "Conflicting objective" })
            .pipe(Effect.isFailure)
        ).toBe(true)
      })
    )
  )
})
