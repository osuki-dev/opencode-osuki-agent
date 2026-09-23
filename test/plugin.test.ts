import { expect, spyOn, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Skill } from "@opencode/plugin/effect"
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
    pluginOptions?: Record<string, unknown>
    credentials?: boolean
    brokenLookup?: boolean
    storage?: Map<string, unknown>
    events?: PubSub.PubSub<unknown>
    agentLookup?: (id: string) => Effect.Effect<void, unknown>
    storageWrite?: (key: string, value: unknown) => Effect.Effect<void, unknown>
    sessionLookup?: (id: string) => {
      id: string
      agent: string
      parentID?: string
      model?: { providerID: string; id: string }
    }
  } = {}
) {
  const permissionHooks = new Map<string, Hook[]>()
  const toolHooks = new Map<string, Hook[]>()
  const sessionHooks = new Map<string, Hook[]>()
  const tools = new Map<string, Tool>()
  const skills = new Map<string, Skill.Info>()
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
    options: options.pluginOptions ?? {},
    app: { version: "2.0.12" },
    command: { transform: noTransform },
    skill: {
      transform: (transform: (editor: { add(skill: Skill.Info): void }) => void) =>
        Effect.sync(() => {
          transform({
            add: (skill) => {
              skills.set(skill.id, Schema.decodeUnknownSync(Skill.Info)(skill))
            }
          })
          return { dispose: Effect.void }
        }),
      list: () => Effect.succeed({ data: [] })
    },
    storage: {
      get: (key: string) => Effect.succeed(storage.get(key)),
      set: (key: string, value: unknown) =>
        Effect.gen(function* () {
          yield* options.storageWrite?.(key, value) ?? Effect.void
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
        transform: (editor: {
          get(id: string): typeof displayAgent | undefined
          update(id: string, fn: (agent: typeof displayAgent) => void): void
        }) => void
      ) =>
        Effect.sync(() => {
          transform({
            get: (id: string) => (id === displayAgent.id ? displayAgent : undefined),
            update: (id, fn) => {
              if (id === displayAgent.id) fn(displayAgent)
            }
          })
          return { dispose: Effect.void }
        }),
      get: ({ agentID }: { agentID: string }) =>
        Effect.gen(function* () {
          yield* options.agentLookup?.(agentID) ?? Effect.void
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
              options.sessionLookup
                ? options.sessionLookup(sessionID)
                : sessionID === "root"
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
    skills,
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

test("workflow skill uses the current host schema and a real packaged path", async () => {
  const harness = await Effect.runPromise(Effect.scoped(makeHarness()))
  const skill = harness.skills.get("osuki-workflow")!
  expect(skill.name).toBe(Skill.Name.make("osuki-workflow"))
  expect(skill).not.toHaveProperty("location")
  expect(await Bun.file(skill.path).exists()).toBe(true)
  expect(skill.content).toContain("/osuki-goal")
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

test("managed sessions distinguish native tools from the execute catalog", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        for (const [sessionID, agent] of [
          ["root", "osuki"],
          ["worker", "general"],
          ["other-child", "unlisted-agent"],
          ["unrelated", "general"]
        ]) {
          const tools = {
            grep: { description: "Search file contents" },
            read: { description: "Read a file" },
            execute: { description: "Run code using the discovered tool catalog" }
          }
          const event = {
            sessionID,
            agent,
            model: harness.model,
            tools: { ...tools },
            system: [] as { type: string; text: string }[],
            messages: []
          }
          yield* harness.context(event)
          const prompt = event.system.map((part) => part.text).join("\n")
          if (sessionID === "unrelated") expect(prompt).toBe("")
          else {
            expect(prompt).toContain("Call exposed native tools directly")
            expect(prompt).toContain("only tools confirmed by its own catalog")
            expect(prompt).toContain("do not assume tools.grep or tools.read exists")
            expect(prompt).toContain("rediscover the catalog or use the exposed native tool")
          }
          expect(event.tools).toEqual(tools)
        }
      })
    )
  )
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
        const choice =
          id === "complexity"
            ? input.state.includes("architecture")
              ? "deep"
              : "quick"
            : id === "planning"
              ? input.state.includes("architecture")
                ? "required"
                : "skip"
              : "read"
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
              ["read", "write", "edit", "shell", "webfetch", "search", "subagent"].map((name) => [
                name,
                { description: name }
              ])
            )
          )
          yield* harness.context(first)
          expect(questionSets[0]).toEqual(["complexity", "planning", "next"])
          expect(first.system.some((part) => part.text.includes('"planning":"skip"'))).toBe(true)
          const same = event("Remove the border")
          yield* harness.context(same)
          expect(questionSets).toHaveLength(1)
          expect(same.system.some((part) => part.text.includes('"planning":"skip"'))).toBe(true)
          const changed = event("Redesign the authentication architecture")
          yield* harness.context(changed)
          expect(questionSets[1]).toEqual(["complexity", "planning"])
          expect(changed.system.some((part) => part.text.includes('"planning":"required"'))).toBe(true)
          const repeated = {
            ...event("Remove the border"),
            messages: [{ role: "user", content: [{ type: "text", text: "Remove the border" }], id: "new-message" }]
          }
          yield* harness.context(repeated)
          yield* harness.context(repeated)
          expect(questionSets).toHaveLength(3)
        })
      )
    )
  } finally {
    fetch.mockRestore()
  }
})

test("lightweight review follows workflow eligibility and risk reassessment updates cached context", async () => {
  let complexityConfidence = 0.95
  let complexityChoice = "quick"
  const respond = async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))
    const risky = String(request.state).includes("security change")
    const choices: Record<string, string> = {
      complexity: risky ? "deep" : complexityChoice,
      planning: risky ? "required" : "skip",
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
              confidence: id === "complexity" ? complexityConfidence : 0.95,
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
          complexityConfidence = 0.7
          yield* harness.context({
            ...event(),
            messages: [{ role: "user", id: "second-request", content: [{ type: "text", text: "Remove border" }] }]
          })
          expect(JSON.parse((yield* harness.call("osuki_review", input)).content).outcome).toBe("lightweight-passed")
          expect((yield* harness.before(reviewer()).pipe(Effect.exit))._tag).toBe("Failure")
          complexityConfidence = 0.95
          complexityChoice = "standard"
          yield* harness.context({
            ...event(),
            messages: [{ role: "user", id: "third-request", content: [{ type: "text", text: "Remove border" }] }]
          })
          expect(JSON.parse((yield* harness.call("osuki_review", input)).content).outcome).toBe("lightweight-passed")
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
          const refreshed = {
            ...event(),
            messages: [{ role: "user", id: "third-request", content: [{ type: "text", text: "Remove border" }] }]
          }
          yield* harness.context(refreshed)
          expect(refreshed.system.some((part) => part.text.includes('"planning":"required"'))).toBe(true)
          expect(JSON.parse((yield* harness.call("osuki_review", input)).content).outcome).toBe("reviewer-required")
          yield* harness.before(reviewer())
          expect(harness.selectedAgents).toEqual(["osuki-reviewer", "osuki-reviewer"])
          expect(fetch).toHaveBeenCalledTimes(7)
        })
      )
    )
  } finally {
    fetch.mockRestore()
  }
})

test("initial workflow requests assessment when Jev has no credential", async () => {
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
            (part) => part.text.includes('"planning":"assess"') && part.text.includes('"source":"fallback"')
          )
        ).toBe(true)
        const planner = {
          sessionID: "root",
          agent: "osuki",
          tool: "subagent",
          input: { agent: "plan", description: "Plan", prompt: "Plan deletion" }
        }
        expect(yield* harness.before(planner).pipe(Effect.isFailure)).toBe(true)
        const unassessed = JSON.parse(
          (yield* harness.call("osuki_review", {
            task: "Delete label",
            diff: "@@ -1 +0,0 @@\n-label",
            context: "Decorative label",
            validation: [{ check: "diff", result: "passed", evidence: "Only label removed" }]
          })).content
        )
        expect(unassessed.outcome).toBe("evidence-required")
        expect(
          yield* harness
            .before({ ...planner, input: { ...planner.input, agent: "osuki-reviewer" } })
            .pipe(Effect.isFailure)
        ).toBe(true)
        yield* harness.call("osuki_route", {
          role: "implement",
          task: "Delete the confirmed decorative label",
          assessment: {
            tier: "quick",
            planning: "skip",
            evidence: "Inspected the label; it has no interaction or dependencies."
          }
        })
        expect(yield* harness.before(planner).pipe(Effect.isFailure)).toBe(true)
        const review = JSON.parse(
          (yield* harness.call("osuki_review", {
            task: "Delete label",
            diff: "@@ -1 +0,0 @@\n-label",
            context: "Decorative label",
            validation: [{ check: "diff", result: "passed", evidence: "Only label removed" }]
          })).content
        )
        expect(review.outcome).toBe("evidence-required")
        const status = JSON.parse((yield* harness.status()).content)
        expect(status.routing.some((entry: { event: string }) => entry.event === "planner-denied")).toBe(true)
        expect(status.lastRoute.source).toBe("coordinator-assessment")
        yield* harness.call("osuki_route", {
          role: "plan",
          task: "User explicitly requests a plan before any edit",
          assessment: {
            tier: "quick",
            planning: "required",
            evidence: "The current user explicitly asks for a read-only plan."
          }
        })
        yield* harness.before(planner)
        expect(harness.selectedAgents).toEqual(["plan"])
      })
    )
  )
})

test("resolved routing cannot introduce an unapproved planner", async () => {
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))
    return Response.json({
      answers: Object.fromEntries(
        Object.entries(request.questions as Record<string, { criteria: Record<string, string> }>).map(
          ([id, question]) => {
            const choice = id === "complexity" ? "deep" : "skip"
            return [
              id,
              {
                type: "choice",
                choice,
                confidence: 0.99,
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
          const harness = yield* makeHarness({ credentials: true, pluginOptions: { agents: { deep: "plan" } } })
          const result = yield* harness
            .before({
              sessionID: "root",
              agent: "osuki",
              tool: "subagent",
              input: {
                agent: "general",
                description: "Investigate",
                prompt: "Investigate a difficult issue without a separate plan"
              }
            })
            .pipe(Effect.isFailure)
          expect(result).toBe(true)
          expect(harness.selectedAgents).toHaveLength(0)
          const audit = JSON.parse((yield* harness.status()).content).routing
          expect(audit.at(-1)).toMatchObject({ event: "planner-denied", agent: "plan" })
        })
      )
    )
  } finally {
    fetch.mockRestore()
  }
})

test("continued dispatch validates the actual child owner, agent and model", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          sessionLookup: (id) => ({
            id,
            agent: id === "hidden-planner" ? "plan" : "general",
            parentID: id === "foreign" ? "another-parent" : "root",
            ...(id === "excluded" ? { model: { providerID: "openai", id: "gpt-5.3-codex" } } : {})
          })
        })
        for (const sessionID of ["hidden-planner", "foreign", "excluded"])
          expect(
            yield* harness
              .before({
                sessionID: "root",
                agent: "osuki",
                tool: "subagent",
                input: {
                  agent: "general",
                  description: "Continue",
                  prompt: "Continue assigned work",
                  sessionID
                }
              })
              .pipe(Effect.isFailure)
          ).toBe(true)
        const allowed = {
          sessionID: "root",
          agent: "osuki",
          tool: "subagent",
          input: {
            agent: "osuki-worker-quick",
            description: "Continue",
            prompt: "Continue assigned work",
            sessionID: "worker"
          }
        }
        yield* harness.before(allowed)
        expect(allowed.input.agent).toBe("general")
        expect(harness.selectedAgents).toHaveLength(0)
      })
    )
  )
})

test("observed edits invalidate lightweight review including edits during its request", async () => {
  let duringReview: (() => Promise<void>) | undefined
  let duringAudit: (() => Effect.Effect<void, unknown>) | undefined
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))
    const choices: Record<string, string> = {
      complexity: "quick",
      planning: "skip",
      scope: "bounded",
      correctness: "satisfied",
      validation: "sufficient"
    }
    if (request.questions.scope && duringReview) await duringReview()
    return Response.json({
      answers: Object.fromEntries(
        Object.entries(request.questions as Record<string, { criteria: Record<string, string> }>).map(
          ([id, question]) => [
            id,
            {
              type: "choice",
              choice: choices[id],
              confidence: 0.99,
              probabilities: Object.fromEntries(
                Object.keys(question.criteria).map((key) => [key, key === choices[id] ? 1 : 0])
              )
            }
          ]
        )
      )
    })
  }) as typeof globalThis.fetch)
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({
            credentials: true,
            storageWrite: (key) => (key === "routing:root" ? (duringAudit?.() ?? Effect.void) : Effect.void)
          })
          yield* harness.context({
            sessionID: "root",
            agent: "osuki",
            model: harness.model,
            tools: {},
            system: [],
            messages: [{ role: "user", content: [{ type: "text", text: "Remove border" }] }]
          })
          const input = {
            task: "Remove border",
            diff: "@@ -1 +1 @@\n-border: solid;\n+border: none;",
            context: "Only the border",
            validation: [{ check: "inspection", result: "passed", evidence: "Only the border declaration changed" }]
          }
          yield* harness.call("osuki_review", input)
          const before = JSON.parse((yield* harness.status()).content).decision
          expect(before.review.outcome).toBe("lightweight-passed")
          expect(before.review.evidence).toMatch(/^[a-f0-9]{64}$/)
          const edit = { id: "edit-1", sessionID: "worker", agent: "general", tool: "patch", input: {} }
          yield* harness.before(edit)
          expect(JSON.parse((yield* harness.status()).content).decision.review).toBeUndefined()
          const callsBefore = fetch.mock.calls.length
          expect(yield* harness.call("osuki_review", input).pipe(Effect.isFailure)).toBe(true)
          expect(fetch).toHaveBeenCalledTimes(callsBefore)
          yield* harness.after({ ...edit, status: "completed" })
          expect(JSON.parse((yield* harness.call("osuki_review", input)).content).outcome).toBe("lightweight-passed")
          duringReview = () => Effect.runPromise(harness.before(edit))
          expect(yield* harness.call("osuki_review", input).pipe(Effect.isFailure)).toBe(true)
          expect(fetch).toHaveBeenCalledTimes(callsBefore + 2)
          expect(JSON.parse((yield* harness.status()).content).decision.review).toBeUndefined()
          yield* harness.after({ ...edit, status: "error" })
          duringReview = () =>
            Effect.runPromise(harness.before(edit).pipe(Effect.andThen(harness.after({ ...edit, status: "error" }))))
          expect(yield* harness.call("osuki_review", input).pipe(Effect.isFailure)).toBe(true)
          expect(fetch).toHaveBeenCalledTimes(callsBefore + 3)
          expect(JSON.parse((yield* harness.status()).content).decision.review).toBeUndefined()
          duringReview = undefined
          duringAudit = () => harness.before(edit).pipe(Effect.andThen(harness.after({ ...edit, status: "completed" })))
          expect(yield* harness.call("osuki_review", input).pipe(Effect.isFailure)).toBe(true)
          expect(JSON.parse((yield* harness.status()).content).decision.review).toBeUndefined()
          duringAudit = undefined
          expect(JSON.parse((yield* harness.call("osuki_review", input)).content).outcome).toBe("lightweight-passed")
        })
      )
    )
  } finally {
    fetch.mockRestore()
  }
})

test("reviewer authorization is rechecked after agent lookup and audit writes", async () => {
  for (const boundary of ["lookup", "audit"] as const) {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let mutate: (() => Effect.Effect<void, unknown>) | undefined
          const harness = yield* makeHarness({
            agentLookup: () => (boundary === "lookup" ? (mutate?.() ?? Effect.void) : Effect.void),
            storageWrite: (key) =>
              boundary === "audit" && key === "routing:root" ? (mutate?.() ?? Effect.void) : Effect.void
          })
          yield* harness.context({
            sessionID: "root",
            agent: "osuki",
            model: harness.model,
            tools: {},
            system: [],
            messages: [{ role: "user", content: [{ type: "text", text: "Remove border" }] }]
          })
          yield* harness.call("osuki_route", {
            task: "Remove border",
            role: "implement",
            assessment: { tier: "quick", planning: "skip", evidence: "Inspection confirms a bounded cosmetic change" }
          })
          const input = {
            task: "Remove border",
            diff: "@@ -1 +1 @@\n-border: solid;\n+border: none;",
            context: "x".repeat(20_001),
            validation: []
          }
          expect(JSON.parse((yield* harness.call("osuki_review", input)).content).outcome).toBe("reviewer-required")
          let mutations = 0
          mutate = () =>
            Effect.gen(function* () {
              mutate = undefined
              mutations++
              const edit = { id: "write-1", sessionID: "worker", agent: "general", tool: "patch", input: {} }
              yield* harness.before(edit)
              yield* harness.after({ ...edit, status: "completed" })
            })
          const event = {
            sessionID: "root",
            agent: "osuki",
            tool: "subagent",
            input: {
              agent: "osuki-reviewer",
              prompt: "Review the current diff",
              description: "Review",
              background: false
            }
          }
          expect(yield* harness.before(event).pipe(Effect.isFailure)).toBe(true)
          expect(mutations).toBe(1)
          expect(harness.selectedAgents).toEqual(["osuki-reviewer"])
          expect(JSON.parse((yield* harness.status()).content).decision.review).toBeUndefined()
          yield* harness.call("osuki_review", input)
          yield* harness.before(event)
          expect(harness.selectedAgents).toEqual(["osuki-reviewer", "osuki-reviewer"])
        })
      )
    )
  }
})

test("native planning is blocked for direct work but allowed for explicit planning and goals", async () => {
  let requiresPlan = false
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))
    return Response.json({
      answers: Object.fromEntries(
        Object.entries(request.questions as Record<string, { criteria: Record<string, string> }>).map(([id, q]) => {
          const choice = id === "planning" ? (requiresPlan ? "required" : "skip") : id === "message" ? "amend" : "quick"
          return [
            id,
            {
              type: "choice",
              choice,
              confidence: 0.98,
              probabilities: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === choice ? 1 : 0]))
            }
          ]
        })
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
            system: [],
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "The decorative label has no behavior; it can be removed." }]
              },
              { role: "user", content: [{ type: "text", text }] }
            ]
          })
          yield* harness.context(context("Delete it"))
          const planner = (sessionID?: string) => ({
            sessionID: "root",
            agent: "osuki",
            tool: "subagent",
            input: { agent: "plan", description: "Plan deletion", prompt: "Plan the edit", sessionID }
          })
          expect(yield* harness.before(planner()).pipe(Effect.isFailure)).toBe(true)
          expect(yield* harness.before(planner("previous-planner")).pipe(Effect.isFailure)).toBe(true)
          expect(harness.selectedAgents).toHaveLength(0)
          requiresPlan = true
          yield* harness.context(context("First give me a plan; do not edit"))
          yield* harness.before(planner())
          expect(harness.selectedAgents).toEqual(["plan"])
          const reopened = yield* makeHarness({ storage: harness.storage })
          const status = JSON.parse((yield* reopened.status()).content)
          expect(status.routing.filter((entry: { event: string }) => entry.event === "classification")).toHaveLength(2)
          expect(status.routing.at(-1)).toMatchObject({ event: "dispatch", agent: "plan" })
        })
      )
    )
  } finally {
    fetch.mockRestore()
  }
})

test("transport recovery keeps the current request instead of routing a new one", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      answers: {
        complexity: {
          type: "choice",
          choice: "quick",
          confidence: 0.98,
          probabilities: { quick: 1, standard: 0, deep: 0 }
        },
        planning: {
          type: "choice",
          choice: "skip",
          confidence: 0.98,
          probabilities: { skip: 1, required: 0, assess: 0 }
        }
      }
    })
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({ credentials: true })
          const user = { role: "user", content: [{ type: "text", text: "Remove the border" }] }
          const context = (messages: unknown[]) => ({
            sessionID: "root",
            agent: "osuki",
            model: harness.model,
            tools: {},
            system: [],
            messages
          })
          yield* harness.context(context([user]))
          const recovery = {
            role: "user",
            content: [
              {
                type: "text",
                text: "The previous response was interrupted. Continue from where you left off without repeating completed content."
              }
            ]
          }
          const resumed = context([user, recovery])
          yield* harness.context(resumed)
          expect(fetch).toHaveBeenCalledTimes(1)
          expect(resumed.system.some((part: { text: string }) => part.text.includes('"planning":"skip"'))).toBe(true)
          const status = JSON.parse((yield* harness.status()).content)
          expect(status.routing.filter((entry: { event: string }) => entry.event === "classification")).toHaveLength(1)
        })
      )
    )
  } finally {
    fetch.mockRestore()
  }
})

test("Jev decision rewrites native dispatch and records the configured agent model", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      answers: {
        planning: {
          type: "choice",
          choice: "skip",
          confidence: 0.95,
          probabilities: { skip: 1, required: 0, assess: 0 }
        },
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

test("Osuki registers its prompt without changing the agent ID or configured model", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        expect(harness.displayAgent).toMatchObject({ id: "osuki", name: "Osuki", model: { id: "user-selected-model" } })
      })
    )
  )
})

test("parallel assignments reuse identical decisions without blocking distinct Jev-routed subtasks", async () => {
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, _init?: RequestInit) =>
    Response.json({
      answers: {
        complexity: {
          type: "choice",
          choice: "quick",
          confidence: 0.99,
          probabilities: { quick: 1, standard: 0, deep: 0 }
        },
        planning: {
          type: "choice",
          choice: "skip",
          confidence: 0.99,
          probabilities: { skip: 1, required: 0, assess: 0 }
        }
      }
    })) as typeof globalThis.fetch)
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({ credentials: true })
          const context = () => ({
            sessionID: "root",
            agent: "osuki",
            model: harness.model,
            system: [],
            tools: Object.fromEntries(
              ["execute", "subagent", "question", "skill", "osuki_review", "read", "patch", "shell", "webfetch"].map(
                (name) => [name, { description: name }]
              )
            ),
            messages: [{ role: "user", content: [{ type: "text", text: "Remove two independent borders" }] }]
          })
          yield* harness.context(context())
          yield* harness.context(context())
          expect(fetch).toHaveBeenCalledTimes(1)
          const events = [
            "Remove two independent borders",
            "Remove two independent borders",
            "Remove card A border",
            "Remove card B border"
          ].map((prompt, index) => ({
            id: `dispatch-${index}`,
            sessionID: "root",
            agent: "osuki",
            tool: "subagent",
            input: { agent: "general", description: "Bounded edit", prompt, background: true }
          }))
          yield* Effect.all(
            events.map((event) => harness.before(event)),
            { concurrency: "unbounded" }
          )
          expect(events.every((event) => event.input.agent === "osuki-worker-quick")).toBe(true)
          expect(fetch).toHaveBeenCalledTimes(3)
          const audit = JSON.parse((yield* harness.status()).content).routing
          expect(audit.filter((entry: { source: string }) => entry.source === "jev-reused")).toHaveLength(2)
          expect(audit.filter((entry: { event: string }) => entry.event === "dispatch")).toHaveLength(4)
        })
      )
    )
  } finally {
    fetch.mockRestore()
  }
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
            const choice = id === "message" ? intent : id === "planning" ? "skip" : "quick"
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
          expect(questions).toEqual([
            ["complexity", "planning"],
            ["complexity", "planning", "message"]
          ])
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

test("native terminal events clean interrupted writes without clearing other calls", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<unknown>()
        const harness = yield* makeHarness({ events })
        const review = {
          task: "Inspect the diff",
          diff: "@@ -1 +1 @@\n-a\n+b",
          context: "Fixture",
          validation: []
        }
        const edit = {
          id: "execute-1",
          messageID: "message-1",
          sessionID: "worker",
          agent: "general",
          tool: "patch",
          input: {}
        }
        // Nested CodeMode writes share the outer call ID; one after-hook cannot clear both.
        yield* harness.before(edit)
        yield* harness.before(edit)
        yield* harness.after({ ...edit, status: "completed" })
        expect(yield* harness.call("osuki_review", review).pipe(Effect.isFailure)).toBe(true)
        yield* PubSub.publish(events, {
          type: "session.tool.failed",
          data: { sessionID: "worker", assistantMessageID: "older-message", id: edit.id }
        })
        yield* Effect.sleep("5 millis")
        expect(yield* harness.call("osuki_review", review).pipe(Effect.isFailure)).toBe(true)
        for (const type of ["session.tool.failed", "session.tool.success"]) {
          yield* PubSub.publish(events, {
            type,
            data: { sessionID: "worker", assistantMessageID: edit.messageID, id: edit.id }
          })
          yield* Effect.sleep("5 millis")
          expect(yield* harness.call("osuki_review", review).pipe(Effect.isSuccess)).toBe(true)
          if (type === "session.tool.failed") yield* harness.before(edit)
        }
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
        yield* harness.context({
          sessionID: "root",
          agent: "osuki",
          model: harness.model,
          tools: {},
          system: [],
          messages: [{ role: "user", content: [{ type: "text", text: "A separate question" }] }]
        })
        expect(JSON.parse((yield* harness.call("osuki_work", { action: "status" })).content).pending).toEqual([])
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
        // Startup reconciliation pauses persisted goals; a paused goal cannot bypass routing.
        expect(yield* harness.before(event).pipe(Effect.isFailure)).toBe(true)
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

test("foreground one-off delegation does not manufacture a work record", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        const event = {
          id: "one-off",
          sessionID: "root",
          agent: "osuki",
          tool: "subagent",
          input: { agent: "general", description: "Small edit", prompt: "Remove a border", background: false }
        }
        yield* harness.before(event)
        yield* harness.after({ ...event, status: "completed", result: { output: { sessionID: "worker" } } })
        expect(JSON.parse((yield* harness.call("osuki_work", { action: "status" })).content)).toEqual({
          status: "none"
        })
        yield* harness.before({ ...event, id: "background", input: { ...event.input, background: true } })
        expect(JSON.parse((yield* harness.call("osuki_work", { action: "status" })).content).status).toBe("active")
      })
    )
  )
})

test("work schemas expose action-specific fields and reject invalid state changes without mutation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        const schema = JSON.parse(JSON.stringify(harness.tools.get("osuki_work")!.input))
        const terminal = schema.anyOf.find((branch: { properties: { action: { enum?: string[] } } }) =>
          branch.properties.action.enum?.includes("block")
        )
        expect(Object.keys(terminal.properties).sort()).toEqual(["action", "evidence", "revision"])
        expect(terminal.required.sort()).toEqual(["action", "evidence", "revision"])
        yield* harness.call("osuki_work", { action: "start", objective: "Build a feature" })
        for (const extra of [{ objective: "Rewrite the objective" }, { resolved: ["Passed tests"] }]) {
          expect(
            yield* harness
              .call("osuki_work", { action: "block", revision: 0, evidence: "Review pending", ...extra })
              .pipe(Effect.isFailure)
          ).toBe(true)
          expect(JSON.parse((yield* harness.call("osuki_work", { action: "status" })).content).revision).toBe(0)
        }
        expect(
          JSON.parse(
            (yield* harness.call("osuki_work", { action: "block", revision: 0, evidence: "Review pending" })).content
          )
        ).toMatchObject({ status: "blocked", revision: 1, objective: "Build a feature" })
      })
    )
  )
})
