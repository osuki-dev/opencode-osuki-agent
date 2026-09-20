import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Exit, Queue, Schema, Scope, Stream } from "effect"
import { parseConfig } from "../src/config.ts"
import { completionError, GoalSchema, installGoals, parseGoal, type Goal } from "../src/goal.ts"

function sample(): Goal {
  return Schema.decodeUnknownSync(GoalSchema)({
    id: "goal",
    sessionID: "session",
    objective: "Ship feature",
    status: "active",
    revision: 1,
    checkpointRevision: 1,
    review: {
      childID: "review-child",
      revision: 1,
      verdict: "passed",
      findings: [],
      evidence: ["Reviewed working diff and test evidence"]
    },
    acceptance: [{ criterion: "Works", evidence: "bun test: 3 passed" }],
    receipts: [
      { id: "plan", role: "planner", evidence: "Plan result", revision: 0, childID: "plan-child" },
      { id: "review", role: "reviewer", evidence: "Review result", revision: 1, childID: "review-child" }
    ],
    processed: [],
    rounds: 0
  })
}
test("completion requires actual captured calls and nonempty acceptance evidence", () => {
  const goal = sample()
  expect(completionError(goal, "plan", "review")).toBeUndefined()
  expect(completionError({ ...goal, acceptance: [] }, "plan", "review")).toContain("evidence")
  expect(completionError({ ...goal, acceptance: [{ criterion: "Works", evidence: " " }] }, "plan", "review")).toContain(
    "evidence"
  )
  expect(completionError(goal, "forged", "review")).toContain("planner")
  expect(completionError({ ...goal, revision: 2 }, "plan", "review")).toContain("latest checkpoint")
  expect(completionError({ ...goal, status: "paused" }, "plan", "review")).toContain("not active")
})

async function harness(initial?: Goal, options: unknown = {}) {
  const config = await Effect.runPromise(parseConfig(options))
  const storage = new Map<string, unknown>()
  if (initial) storage.set("goal:session", structuredClone(initial))
  type Prompt = { sessionID: string; id: string; text: string; metadata: Record<string, unknown> }
  type Command = {
    name: string
    execute(input: { sessionID: string; prompt: { text: string }; delivery: string }): Effect.Effect<void, unknown>
  }
  type Hook = (event: Record<string, unknown>) => Promise<void>
  type EffectHook = (event: Record<string, unknown>) => Effect.Effect<void, unknown>
  type Tool = {
    name: string
    input: unknown
    execute(input: unknown, context: { sessionID: string; agent: string }): Promise<{ content: string }>
  }
  type EffectTool = {
    name: string
    input: unknown
    execute(input: unknown, context: { sessionID: string; agent: string }): Effect.Effect<{ content: string }, unknown>
  }
  const commands = new Map<string, Command>()
  const hooks = new Map<string, Hook>()
  const nativeHooks = new Map<string, EffectHook>()
  const tools = new Map<string, Tool>()
  const prompts: Prompt[] = []
  const interrupts: unknown[] = []
  const queue = await Effect.runPromise(Queue.unbounded<unknown>())
  const scope = await Effect.runPromise(Scope.make())
  const registration = { dispose: Effect.void }
  const hook = (name: string, fn: EffectHook) =>
    Effect.sync(() => {
      nativeHooks.set(name, fn)
      hooks.set(name, (event) => Effect.runPromise(fn(event)))
      return registration
    })
  const ctx = {
    storage: {
      get: (key: string) => Effect.sync(() => structuredClone(storage.get(key))),
      set: (key: string, value: unknown) =>
        Effect.sync(() => {
          storage.set(key, structuredClone(value))
        })
    },
    command: {
      transform: (fn: (editor: { add(cmd: Command): void }) => void) =>
        Effect.sync(() => {
          fn({
            add: (cmd: Command) => {
              commands.set(cmd.name, cmd)
            }
          })
          return registration
        })
    },
    tool: {
      transform: (fn: (editor: { add(tool: EffectTool): void }) => void) =>
        Effect.sync(() => {
          fn({
            add: (tool: EffectTool) => {
              tools.set(tool.name, {
                name: tool.name,
                input: tool.input,
                execute: (input, context) => Effect.runPromise(tool.execute(input, context))
              })
            }
          })
          return registration
        }),
      hook
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        Effect.succeed(
          sessionID === "review-child"
            ? { id: sessionID, agent: config.agents.review, parentID: "session" }
            : { id: sessionID, agent: config.coordinator }
        ),
      hook,
      prompt: Effect.fn(function* (input: Prompt) {
        yield* nativeHooks.get("prompt")?.({ ...input, prompt: { text: input.text } }) ?? Effect.void
        prompts.push(input)
      }),
      interrupt: (input: unknown) =>
        Effect.sync(() => {
          interrupts.push(input)
        }),
      synthetic: () => Effect.void
    },
    event: { subscribe: () => Stream.fromQueue(queue) }
  } as unknown as Context
  await Effect.runPromise(installGoals(ctx, config).pipe(Scope.provide(scope)))
  const cleanup = () => Effect.runPromise(Scope.close(scope, Exit.void))
  const flush = () => Effect.runPromise(Effect.sleep("2 millis"))
  return {
    storage,
    prompts,
    interrupts,
    hooks,
    tools,
    cleanup,
    flush,
    command: (name: string, text = "") =>
      Effect.runPromise(commands.get(name)!.execute({ sessionID: "session", prompt: { text }, delivery: "steer" })),
    event: async (type: string, id: string, extra = {}) => {
      await Effect.runPromise(Queue.offer(queue, { type, id, data: { sessionID: "session", ...extra } }))
      await flush()
    },
    goal: () => Schema.decodeUnknownSync(GoalSchema)(storage.get("goal:session"))
  }
}
test("a duplicated execution event produces only one continuation", async () => {
  const h = await harness()
  try {
    await h.command("osuki-goal", "Build it")
    expect(h.prompts).toHaveLength(1)
    await h.event("session.execution.succeeded", "event-1")
    await h.event("session.execution.succeeded", "event-1")
    expect(h.prompts).toHaveLength(2)
    expect(h.goal().rounds).toBe(1)
    expect(h.prompts[0].id).not.toBe(h.prompts[1].id)
  } finally {
    await h.cleanup()
  }
})
test("user interruption pauses without continuation; explicit resume works", async () => {
  const h = await harness()
  try {
    await h.command("osuki-goal", "Build it")
    await h.event("session.execution.interrupted", "event-1", { reason: "user" })
    await h.event("session.execution.succeeded", "event-2")
    expect(h.goal().status).toBe("paused")
    expect(h.prompts).toHaveLength(1)
    await h.command("osuki-goal-resume")
    expect(h.prompts).toHaveLength(2)
    await h.command("osuki-goal-cancel")
    expect(h.goal().status).toBe("cancelled")
    expect(h.interrupts).toEqual([{ sessionID: "session", continue: false }])
  } finally {
    await h.cleanup()
  }
})
test("restart pauses persisted goals and stale auto prompts are rejected", async () => {
  const h = await harness(sample())
  try {
    await h.event("session.execution.succeeded", "event-1")
    expect(h.goal().status).toBe("paused")
    expect(h.prompts).toHaveLength(0)
    await expect(
      h.hooks.get("prompt")!({ sessionID: "session", metadata: { source: "osuki-goal", goalID: "goal", revision: 1 } })
    ).rejects.toThrow("Stale")
  } finally {
    await h.cleanup()
  }
})
test("failed execution blocks instead of endlessly retrying", async () => {
  const h = await harness()
  try {
    await h.command("osuki-goal", "Build it")
    await h.event("session.execution.failed", "failed", { error: { message: "Unauthorized" } })
    expect(h.goal().status).toBe("blocked")
    expect(h.prompts).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
})
test("only successful foreground native subagent results become completion receipts", async () => {
  const h = await harness()
  try {
    await h.command("osuki-goal", "Build it")
    const capture = h.hooks.get("execute.after")!
    const event = {
      sessionID: "session",
      agent: "osuki",
      tool: "subagent",
      id: "planner-call",
      input: { agent: "plan" },
      status: "completed",
      result: {
        output: {
          sessionID: "plan-child",
          status: "completed",
          output: "Inspected files and produced implementation plan."
        }
      }
    }
    await capture({ ...event, status: "error" })
    await capture({ ...event, input: { agent: "plan", background: true } })
    await capture({ ...event, result: { output: { sessionID: "plan-child", status: "running", output: "Started" } } })
    await capture({ ...event, tool: "bash" })
    expect(h.goal().receipts).toHaveLength(0)
    await capture(event)
    await capture(event)
    expect(h.goal().receipts).toHaveLength(1)
    expect(h.goal().receipts[0].id).toBe("planner-call")
  } finally {
    await h.cleanup()
  }
})
test("review failure, unresolved findings, and a different child prevent completion", () => {
  const goal = sample()
  expect(
    completionError(
      { ...goal, review: { ...goal.review!, verdict: "changes_requested", findings: ["Missing validation"] } },
      "plan",
      "review"
    )
  ).toContain("independent reviewer")
  expect(
    completionError({ ...goal, review: { ...goal.review!, findings: ["Still broken"] } }, "plan", "review")
  ).toContain("independent reviewer")
  const mismatched = Schema.decodeUnknownSync(GoalSchema)({
    ...goal,
    review: { ...goal.review, childID: "another-child" }
  })
  expect(completionError(mismatched, "plan", "review")).toContain("does not match")
})
test("corrupt persisted goal state fails closed", async () => {
  expect(await Effect.runPromise(parseGoal(undefined))).toBeUndefined()
  expect((await Effect.runPromise(parseGoal(sample())))?.objective).toBe("Ship feature")
  await expect(Effect.runPromise(parseGoal({ ...sample(), revision: -1 }))).rejects.toThrow()
  await expect(Effect.runPromise(parseGoal({ ...sample(), acceptance: [{ criterion: "Works" }] }))).rejects.toThrow()
  await expect(
    Effect.runPromise(parseGoal({ ...sample(), review: { ...sample().review, evidence: [] } }))
  ).rejects.toThrow()
})
test("three empty turns block while actual work resets the no-progress counter", async () => {
  const h = await harness()
  try {
    await h.command("osuki-goal", "Build it")
    await h.event("session.execution.succeeded", "e1")
    await h.event("session.execution.succeeded", "e2")
    expect(h.goal().noProgressRounds).toBe(2)
    await h.hooks.get("execute.after")!({
      sessionID: "session",
      agent: "osuki",
      tool: "read",
      id: "read1",
      input: { path: "src/index.ts" },
      status: "completed",
      result: { content: "actual file" }
    })
    await h.event("session.execution.succeeded", "e3")
    expect(h.goal().noProgressRounds).toBe(0)
    for (const id of ["e4", "e5", "e6"]) await h.event("session.execution.succeeded", id)
    expect(h.goal().status).toBe("blocked")
    expect(h.goal().reason).toContain("Three consecutive")
  } finally {
    await h.cleanup()
  }
})
test("checkpoint cannot silently drop established acceptance criteria", async () => {
  const h = await harness()
  try {
    await h.command("osuki-goal", "Build it")
    const tool = h.tools.get("osuki_goal")!
    const context = { sessionID: "session", agent: "osuki" }
    const acceptance = [
      { criterion: "A", evidence: "test A passed" },
      { criterion: "B", evidence: "test B passed" }
    ]
    await tool.execute({ action: "checkpoint", acceptance }, context)
    await expect(tool.execute({ action: "checkpoint", acceptance: acceptance.slice(0, 1) }, context)).rejects.toThrow(
      "cannot be removed"
    )
    const revision = h.goal().revision
    const progress = h.goal().progress
    await tool.execute({ action: "checkpoint", acceptance }, context)
    expect(h.goal().revision).toBe(revision)
    expect(h.goal().progress).toBe(progress)
  } finally {
    await h.cleanup()
  }
})
test("only the real reviewer child can report; later writes invalidate its report", async () => {
  const h = await harness()
  try {
    await h.command("osuki-goal", "Build it")
    await h.tools
      .get("osuki_goal")!
      .execute(
        { action: "checkpoint", acceptance: [{ criterion: "Works", evidence: "tests passed" }] },
        { sessionID: "session", agent: "osuki" }
      )
    const report = h.tools.get("osuki_review_report")!
    const args = { verdict: "passed", findings: [], evidence: ["Inspected code against tests"] }
    await expect(report.execute(args, { sessionID: "session", agent: "osuki" })).rejects.toThrow("Only a native")
    await h.hooks.get("context")!({ sessionID: "review-child", agent: "osuki-reviewer", tools: {}, system: [] })
    await report.execute(args, { sessionID: "review-child", agent: "osuki-reviewer" })
    expect(h.goal().review?.verdict).toBe("passed")
    const revision = h.goal().revision
    const progress = h.goal().progress
    for (const name of ["execute", "osuki_status", "osuki_route"]) {
      const event = {
        sessionID: "session",
        agent: "osuki",
        tool: name,
        input: { code: "return tools.osuki_goal({action:'status'})" }
      }
      await h.hooks.get("execute.before")!(event)
      await h.hooks.get("execute.after")!({ ...event, status: "completed", result: { content: "status" } })
    }
    expect(h.goal().revision).toBe(revision)
    expect(h.goal().progress).toBe(progress)
    expect(h.goal().review?.verdict).toBe("passed")
    await h.hooks.get("execute.before")!({
      sessionID: "session",
      agent: "osuki",
      tool: "shell",
      input: { command: "echo test" }
    })
    expect(h.goal().review).toBeUndefined()
    await expect(report.execute(args, { sessionID: "review-child", agent: "osuki-reviewer" })).rejects.toThrow("stale")
  } finally {
    await h.cleanup()
  }
})
test("host scope shutdown stops the continuation event fiber", async () => {
  const h = await harness()
  await h.command("osuki-goal", "Build it")
  await h.cleanup()
  await h.event("session.execution.succeeded", "after-shutdown")
  expect(h.prompts).toHaveLength(1)
  expect(h.goal().rounds).toBe(0)
})
test("configured coordinator and planner aliases are used instead of hardcoded agents", async () => {
  const h = await harness(undefined, { coordinator: "captain", agents: { plan: "strategist", review: "auditor" } })
  try {
    await h.command("osuki-goal", "Build it")
    expect(h.prompts[0].text).toContain("Run strategist")
    expect(h.prompts[0].text).toContain("auditor child")
    await h.hooks.get("execute.after")!({
      sessionID: "session",
      agent: "captain",
      tool: "subagent",
      id: "plan-call",
      input: { agent: "strategist" },
      status: "completed",
      result: { output: { sessionID: "plan-child", status: "completed", output: "Plan with trailing newline\n" } }
    })
    expect(h.goal().receipts[0].role).toBe("planner")
    expect(String(h.goal().receipts[0].childID)).toBe("plan-child")
  } finally {
    await h.cleanup()
  }
})
test("CodeMode-facing tool schemas are plain JSON and execution validates nested input locally", async () => {
  const h = await harness()
  try {
    await h.command("osuki-goal", "Check the native JSON boundary")
    const tool = h.tools.get("osuki_goal")!
    const schema = JSON.parse(JSON.stringify(tool.input))
    expect(schema.type).toBe("object")
    expect(schema.properties.acceptance.type).toBe("array")
    expect(schema.properties.acceptance.items.properties.criterion.type).toBe("string")
    expect(tool.input).toEqual(schema)
    const context = { sessionID: "session", agent: "osuki" }
    await tool.execute({ action: "checkpoint", acceptance: [{ criterion: "foo", evidence: "bar" }] }, context)
    expect(h.goal().acceptance).toEqual([{ criterion: "foo", evidence: "bar" }])
    await expect(
      tool.execute({ action: "checkpoint", acceptance: [{ criterion: "foo", evidence: 12 }] }, context)
    ).rejects.toThrow()
    await expect(
      tool.execute({ action: "checkpoint", acceptance: [{ criterion: "foo", evidence: " " }] }, context)
    ).rejects.toThrow()
    const review = h.tools.get("osuki_review_report")!
    expect(review.input).toEqual(JSON.parse(JSON.stringify(review.input)))
  } finally {
    await h.cleanup()
  }
})
