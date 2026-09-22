import { createHash } from "node:crypto"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Option, PartitionedSemaphore, Schema, Stream, type Scope } from "effect"
import type { RoutingConfig } from "./config.ts"
import { toolInputSchema } from "./tool-schema.ts"

export const GOAL_INSTRUCTIONS = `Continue active goals until their acceptance criteria are verified. Run osuki-planner as a foreground native subagent before implementation. Checkpoint with a nonempty acceptance list of {criterion,evidence}; retain every established criterion in subsequent checkpoints. Run tests before checkpointing. Start a fresh foreground osuki-reviewer child after the final checkpoint. Reviewers must use read-only inspection tools, not shell, and call osuki_review_report with verdict passed or changes_requested, unresolved findings, and concrete evidence. Complete with observed plannerCallID and reviewerCallID from osuki_goal status. Any subsequent edit, shell invocation, or worker dispatch invalidates review. Report blocked when essential input is unavailable. Only the user can resume paused or blocked goals. Three consecutive turns without new successful tool work or changed checkpoint evidence block the goal. A final assistant reply does not complete a goal.`

const NonBlank = Schema.NonEmptyString.check(Schema.isPattern(/\S/))
const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const SessionID = Schema.String.pipe(Schema.brand("SessionID"))
const MessageID = Schema.String.pipe(Schema.brand("Session.Message.ID"))
type SessionID = typeof SessionID.Type
const StringList = Schema.mutable(Schema.Array(NonBlank))
const Acceptance = Schema.Struct({ criterion: NonBlank, evidence: NonBlank })
const Receipt = Schema.Struct({
  id: NonBlank,
  role: Schema.Literals(["planner", "reviewer"]),
  evidence: NonBlank,
  revision: Natural,
  childID: SessionID
})
const Review = Schema.Struct({
  childID: SessionID,
  revision: Natural,
  verdict: Schema.Literals(["passed", "changes_requested"]),
  findings: StringList,
  evidence: StringList.check(Schema.isNonEmpty())
})
export const GoalSchema = Schema.Struct({
  id: NonBlank,
  sessionID: SessionID,
  objective: NonBlank,
  status: Schema.mutableKey(Schema.Literals(["active", "paused", "blocked", "completed", "cancelled"])),
  revision: Schema.mutableKey(Natural),
  acceptance: Schema.mutableKey(Schema.mutable(Schema.Array(Acceptance))),
  receipts: Schema.mutable(Schema.Array(Receipt)),
  processed: Schema.mutableKey(StringList),
  rounds: Schema.mutableKey(Natural),
  reason: Schema.mutableKey(Schema.optional(NonBlank)),
  pendingID: Schema.mutableKey(Schema.optional(MessageID)),
  checkpointRevision: Schema.mutableKey(Schema.optional(Natural)),
  review: Schema.mutableKey(Schema.optional(Review)),
  progress: Schema.mutableKey(Schema.optional(Natural)),
  lastRoundProgress: Schema.mutableKey(Schema.optional(Natural)),
  noProgressRounds: Schema.mutableKey(Schema.optional(Natural)),
  progressKeys: Schema.mutableKey(Schema.optional(StringList))
})
export type Goal = typeof GoalSchema.Type
export const parseGoal = Schema.decodeUnknownEffect(Schema.UndefinedOr(GoalSchema))
const encodeGoal = Schema.encodeEffect(GoalSchema)
const GoalInput = Schema.Struct({
  action: Schema.Literals(["status", "checkpoint", "complete", "blocked"]),
  acceptance: Schema.optionalKey(Schema.mutable(Schema.Array(Acceptance))),
  plannerCallID: Schema.optionalKey(NonBlank),
  reviewerCallID: Schema.optionalKey(NonBlank),
  reason: Schema.optionalKey(NonBlank)
})
const ReviewInput = Schema.Struct({
  verdict: Schema.Literals(["passed", "changes_requested"]),
  findings: StringList,
  evidence: StringList.check(Schema.isNonEmpty())
})
const GoalToolInput = toolInputSchema(GoalInput)
const ReviewToolInput = toolInputSchema(ReviewInput)
const decodeGoalInput = Schema.decodeUnknownEffect(GoalInput)
const decodeReviewInput = Schema.decodeUnknownEffect(ReviewInput)
const SubagentInput = Schema.Struct({ agent: NonBlank, background: Schema.optional(Schema.Boolean) })
const SubagentOutput = Schema.Struct({
  sessionID: SessionID,
  status: Schema.Literal("completed"),
  output: Schema.String.check(Schema.isPattern(/\S/))
})
const GoalMetadata = Schema.Struct({ source: Schema.Literal("osuki-goal"), goalID: NonBlank, revision: Natural })
const decodeSubagentInput = Schema.decodeUnknownOption(SubagentInput)
const decodeSubagentOutput = Schema.decodeUnknownOption(SubagentOutput)
const decodeMetadata = Schema.decodeUnknownOption(GoalMetadata)
class GoalToolError extends Schema.TaggedError<GoalToolError>()("Tool.Error", { message: Schema.String }) {}
const failure = (message: string) => new GoalToolError({ message })
const asToolError = (error: unknown) => (error instanceof GoalToolError ? error : failure(String(error)))
const logFailure = (error: unknown) => Effect.logError("Osuki goal operation failed", error)

export function completionError(goal: Goal, plannerID: unknown, reviewerID: unknown): string | undefined {
  if (goal.status !== "active") return "Goal is not active."
  if (!goal.acceptance.length || goal.acceptance.some((item) => !item.criterion.trim() || !item.evidence.trim()))
    return "Every acceptance criterion needs concrete evidence."
  if (!goal.receipts.some((item) => item.id === plannerID && item.role === "planner"))
    return "A completed native planner call from this goal is required."
  const receipt = goal.receipts.find(
    (item) => item.id === reviewerID && item.role === "reviewer" && item.revision === goal.revision
  )
  if (!receipt || goal.checkpointRevision !== goal.revision)
    return "A completed native reviewer call after the latest checkpoint is required."
  if (
    !goal.review ||
    goal.review.revision !== goal.revision ||
    goal.review.verdict !== "passed" ||
    goal.review.findings.length ||
    !goal.review.evidence.length
  )
    return "An independent reviewer must report passed with evidence and no unresolved findings."
  if (receipt.childID !== goal.review.childID)
    return "Review report does not match the observed reviewer child session."
}

export const installGoals: (
  ctx: Context,
  config: RoutingConfig
) => Effect.Effect<
  {
    active: (sessionID: string) => Effect.Effect<boolean>
  },
  never,
  Scope.Scope
> = Effect.fn("installGoals")(function* (ctx: Context, config: RoutingConfig) {
  const instructions = GOAL_INSTRUCTIONS.replaceAll("osuki-planner", config.agents.plan).replaceAll(
    "osuki-reviewer",
    config.agents.review
  )
  const locks = yield* PartitionedSemaphore.make<SessionID>({ permits: 1 })
  const loaded = new Set<SessionID>()
  const reviewStarts = new Map<SessionID, { parentID: SessionID; goalID: string; revision: number }>()
  const key = (id: SessionID) => `goal:${id}`
  const save = Effect.fn("goal.save")(function* (goal: Goal) {
    const encoded = yield* encodeGoal(goal)
    yield* ctx.storage.set(key(goal.sessionID), encoded)
  })
  const read = Effect.fn("goal.read")(function* (id: SessionID) {
    const goal = yield* parseGoal(yield* ctx.storage.get(key(id)))
    if (goal && goal.sessionID !== id) return yield* failure("Persisted goal session mismatch.")
    if (goal && !loaded.has(id)) {
      loaded.add(id)
      if (goal.status === "active") {
        goal.status = "paused"
        goal.revision++
        goal.reason = "Plugin restarted; use /osuki-goal-resume explicitly."
        yield* save(goal)
      }
    }
    return goal
  })
  const requireMain = Effect.fn("goal.requireMain")(function* (sessionID: SessionID) {
    const session = yield* ctx.session.get({ sessionID })
    if (session.agent !== config.coordinator || session.parentID)
      return yield* failure(`Goals are available only in the ${config.coordinator} primary agent.`)
  })
  const submit = Effect.fn("goal.submit")(function* (goal: Goal) {
    const current = yield* read(goal.sessionID)
    if (!current || current.status !== "active" || current.revision !== goal.revision) return
    const hash = createHash("sha256").update(`${goal.id}:${goal.revision}:${goal.rounds}`).digest("hex").slice(0, 26)
    const id = goal.pendingID ?? MessageID.make(`msg_${hash}`)
    goal.pendingID = id
    yield* save(goal)
    yield* ctx.session.prompt({
      sessionID: goal.sessionID,
      id,
      delivery: "queue",
      text: `Continue the active goal: ${goal.objective}\n${instructions}\nCurrent acceptance: ${JSON.stringify(goal.acceptance)}`,
      metadata: { source: "osuki-goal", goalID: goal.id, revision: goal.revision }
    })
    delete goal.pendingID
    yield* save(goal)
  })
  const stop = Effect.fn("goal.stop")(function* (sessionID: SessionID, status: "paused" | "cancelled") {
    yield* Effect.gen(function* () {
      const goal = yield* read(sessionID)
      if (!goal) return yield* failure("No goal exists.")
      goal.status = status
      goal.revision++
      goal.reason = `User ${status} the goal.`
      delete goal.pendingID
      yield* save(goal)
    }).pipe(locks.withPermits(sessionID, 1))
    yield* ctx.session.interrupt({ sessionID, resume: false })
  })

  yield* ctx.command.transform((editor) => {
    for (const name of ["goal", "goal-pause", "goal-resume", "goal-cancel", "goal-status"])
      editor.add({
        name: `osuki-${name}`,
        description: `Osuki ${name.replaceAll("-", " ")}`,
        execute: Effect.fn(`goal.command.${name}`)(function* ({ sessionID, prompt }) {
          yield* requireMain(sessionID)
          if (name === "goal-pause" || name === "goal-cancel")
            return yield* stop(sessionID, name === "goal-pause" ? "paused" : "cancelled")
          yield* Effect.gen(function* () {
            let goal = yield* read(sessionID)
            if (name === "goal-status") {
              yield* ctx.session.synthetic({ sessionID, text: JSON.stringify(goal ?? { status: "none" }) })
              return
            }
            if (name === "goal") {
              const objective = yield* Schema.decodeUnknownEffect(NonBlank)(prompt.text.trim())
              if (goal && !["completed", "cancelled"].includes(goal.status))
                return yield* failure("An unfinished goal exists. Resume or cancel it first.")
              goal = {
                id: crypto.randomUUID(),
                sessionID,
                objective,
                status: "active",
                revision: 0,
                acceptance: [],
                receipts: [],
                processed: [],
                rounds: 0
              }
              loaded.add(sessionID)
            } else {
              if (!goal || !["paused", "blocked"].includes(goal.status))
                return yield* failure("No paused or blocked goal to resume.")
              goal.status = "active"
              goal.revision++
              goal.noProgressRounds = 0
              delete goal.reason
            }
            yield* save(goal)
            yield* submit(goal)
          }).pipe(locks.withPermits(sessionID, 1))
        })
      })
  })

  yield* ctx.tool.transform((editor) => {
    editor.add({
      name: "osuki_goal",
      description: "Inspect or checkpoint a goal; completion requires independently verified acceptance evidence.",
      input: GoalToolInput,
      execute: Effect.fn("goal.tool")(function* (input, tool) {
        const args = yield* decodeGoalInput(input)
        if (tool.agent !== config.coordinator)
          return yield* failure(`Only the ${config.coordinator} primary agent may manage goals.`)
        yield* requireMain(tool.sessionID)
        return yield* Effect.gen(function* () {
          const goal = yield* read(tool.sessionID)
          if (!goal) return { content: JSON.stringify({ status: "none" }) }
          if (args.action === "status") return { content: JSON.stringify(goal) }
          if (goal.status !== "active") return yield* failure(`Goal is ${goal.status}; only the user may resume it.`)
          if (args.action === "checkpoint") {
            const acceptance = args.acceptance
            if (!acceptance?.length)
              return yield* failure("Checkpoint needs a nonempty acceptance list with criterion and evidence strings.")
            if (new Set(acceptance.map((item) => item.criterion)).size !== acceptance.length)
              return yield* failure("Acceptance criterion names must be unique.")
            if (goal.acceptance.some((item) => !acceptance.some((next) => next.criterion === item.criterion)))
              return yield* failure("Existing acceptance criteria cannot be removed or renamed.")
            if (JSON.stringify(goal.acceptance) !== JSON.stringify(acceptance)) {
              goal.acceptance = acceptance
              goal.revision++
              goal.progress = (goal.progress ?? 0) + 1
              delete goal.review
            }
            goal.checkpointRevision = goal.revision
          } else if (args.action === "complete") {
            const error = completionError(goal, args.plannerCallID, args.reviewerCallID)
            if (error) return yield* failure(error)
            goal.status = "completed"
            goal.revision++
          } else {
            if (!args.reason) return yield* failure("A concrete blocking reason is required.")
            goal.status = "blocked"
            goal.reason = args.reason
            goal.revision++
          }
          yield* save(goal)
          return { content: JSON.stringify(goal) }
        }).pipe(locks.withPermits(tool.sessionID, 1))
      }, Effect.mapError(asToolError))
    })
    editor.add({
      name: "osuki_review_report",
      description:
        "Reviewer-only verdict for the parent goal. Passed requires concrete evidence and no unresolved findings.",
      input: ReviewToolInput,
      execute: Effect.fn("goal.reviewReport")(function* (input, tool) {
        const args = yield* decodeReviewInput(input)
        const session = yield* ctx.session.get({ sessionID: tool.sessionID })
        const parentID = session.parentID
        if (tool.agent !== config.agents.review || session.agent !== config.agents.review || !parentID)
          return yield* failure(`Only a native ${config.agents.review} child can report review results.`)
        const start = reviewStarts.get(tool.sessionID)
        if (!start || start.parentID !== parentID)
          return yield* failure("Reviewer must inspect the goal context before reporting.")
        if (
          (args.verdict === "passed" && args.findings.length) ||
          (args.verdict === "changes_requested" && !args.findings.length)
        )
          return yield* failure("Review verdict contradicts unresolved findings.")
        return yield* Effect.gen(function* () {
          const goal = yield* read(parentID)
          if (
            !goal ||
            goal.status !== "active" ||
            goal.id !== start.goalID ||
            goal.revision !== start.revision ||
            goal.checkpointRevision !== goal.revision
          )
            return yield* failure("Review is stale; checkpoint current work and start a fresh reviewer.")
          goal.review = { ...args, childID: tool.sessionID, revision: start.revision }
          goal.progress = (goal.progress ?? 0) + 1
          yield* save(goal)
          return { content: JSON.stringify(goal.review) }
        }).pipe(locks.withPermits(parentID, 1))
      }, Effect.mapError(asToolError))
    })
  })

  const bookkeepingTools = new Set([
    "execute",
    "osuki_goal",
    "osuki_review_report",
    "osuki_status",
    "osuki_route",
    "osuki_work"
  ])
  const readOnlyTools = new Set([
    "read",
    "glob",
    "grep",
    "search",
    "list",
    "webfetch",
    "websearch",
    "skill",
    ...bookkeepingTools
  ])
  const goalSession = Effect.fn("goal.findRoot")(function* (sessionID: SessionID) {
    const seen = new Set<SessionID>()
    let id: SessionID | undefined = sessionID
    while (id && seen.size < 32 && !seen.has(id)) {
      seen.add(id)
      const session: Effect.Success<ReturnType<Context["session"]["get"]>> = yield* ctx.session.get({ sessionID: id })
      if (session.agent === config.coordinator && !session.parentID) return id
      id = session.parentID
    }
  })
  yield* ctx.tool.hook(
    "execute.before",
    Effect.fn("goal.beforeTool")(function* (event) {
      if (readOnlyTools.has(event.tool)) return
      const input = event.tool === "subagent" ? decodeSubagentInput(event.input) : Option.none()
      if (
        event.tool === "subagent" &&
        Option.isSome(input) &&
        [config.agents.plan, config.agents.review].includes(input.value.agent)
      )
        return
      const id = yield* goalSession(event.sessionID)
      if (!id) return
      yield* Effect.gen(function* () {
        const goal = yield* read(id)
        if (!goal || goal.status !== "active") return
        goal.revision++
        delete goal.review
        yield* save(goal)
      }).pipe(locks.withPermits(id, 1))
    }, Effect.mapError(asToolError))
  )

  yield* ctx.tool.hook(
    "execute.after",
    Effect.fn("goal.afterTool")(function* (event) {
      if (event.status !== "completed") return
      const id = yield* goalSession(event.sessionID)
      if (!id) return
      yield* Effect.gen(function* () {
        const goal = yield* read(id)
        if (!goal || goal.status !== "active") return
        if (!bookkeepingTools.has(event.tool)) {
          const signature = createHash("sha256")
            .update(JSON.stringify([event.tool, event.input, event.result]))
            .digest("hex")
          goal.progressKeys ??= []
          if (!goal.progressKeys.includes(signature)) {
            goal.progress = (goal.progress ?? 0) + 1
            goal.progressKeys.push(signature)
            goal.progressKeys = goal.progressKeys.slice(-512)
          }
        }
        const isDelegate = event.agent === config.coordinator && event.tool === "subagent"
        const input = isDelegate ? decodeSubagentInput(event.input) : Option.none()
        const output = isDelegate ? decodeSubagentOutput(event.result.output) : Option.none()
        if (isDelegate && Option.isSome(input) && !input.value.background && Option.isSome(output)) {
          const role =
            input.value.agent === config.agents.plan
              ? "planner"
              : input.value.agent === config.agents.review
                ? "reviewer"
                : undefined
          if (role && !goal.receipts.some((item) => item.id === event.id))
            goal.receipts.push({
              id: event.id,
              role,
              evidence: output.value.output.trim().slice(0, 12000).trim(),
              revision: goal.revision,
              childID: output.value.sessionID
            })
        }
        yield* save(goal)
      }).pipe(locks.withPermits(id, 1))
    }, Effect.catch(logFailure))
  )

  yield* ctx.session.hook(
    "context",
    Effect.fn("goal.context")(function* (event) {
      if (event.agent === config.agents.review) {
        const session = yield* ctx.session.get({ sessionID: event.sessionID })
        const parentID = session.parentID
        if (parentID)
          yield* Effect.gen(function* () {
            const goal = yield* read(parentID)
            if (goal?.status === "active") {
              if (!reviewStarts.has(event.sessionID))
                reviewStarts.set(event.sessionID, { parentID, goalID: goal.id, revision: goal.revision })
              event.system.push({
                type: "text",
                text: `Independently review this goal and its acceptance evidence: ${JSON.stringify(goal.acceptance)}. Use only read-only inspection tools, not shell. Call osuki_review_report with passed only when every criterion is evidenced and no unresolved finding remains; otherwise changes_requested with findings. Supply concrete evidence.`
              })
            }
          }).pipe(locks.withPermits(parentID, 1))
      } else delete event.tools.osuki_review_report
      if (event.agent !== config.coordinator) {
        delete event.tools.osuki_goal
        return
      }
      const goal = yield* read(event.sessionID).pipe(locks.withPermits(event.sessionID, 1))
      if (goal) event.system.push({ type: "text", text: `Goal state: ${JSON.stringify(goal)}\n${instructions}` })
    }, Effect.catch(logFailure))
  )

  yield* ctx.session.hook(
    "prompt",
    Effect.fn("goal.prompt")(function* (event) {
      const metadata = decodeMetadata(event.metadata)
      if (Option.isNone(metadata)) return
      const goal = yield* read(event.sessionID)
      if (
        !goal ||
        goal.status !== "active" ||
        goal.id !== metadata.value.goalID ||
        goal.revision !== metadata.value.revision
      )
        return yield* failure("Stale goal continuation cancelled.")
    }, Effect.orDie)
  )

  yield* ctx.event.subscribe().pipe(
    Stream.runForEach(
      Effect.fn("goal.executionEvent")(function* (event) {
        if (
          event.type !== "session.execution.succeeded" &&
          event.type !== "session.execution.failed" &&
          event.type !== "session.execution.interrupted"
        )
          return
        const { sessionID } = event.data
        yield* Effect.gen(function* () {
          const goal = yield* read(sessionID)
          if (!goal || goal.status !== "active" || goal.processed.includes(event.id)) return
          goal.processed.push(event.id)
          goal.processed = goal.processed.slice(-256)
          if (event.type === "session.execution.interrupted") {
            if (event.data.reason === "superseded") {
              yield* save(goal)
              return
            }
            goal.status = "paused"
            goal.reason = `Execution interrupted: ${event.data.reason}`
            goal.revision++
            yield* save(goal)
            return
          }
          if (event.type === "session.execution.failed") {
            goal.status = "blocked"
            goal.reason = JSON.stringify(event.data.error)
            goal.revision++
            yield* save(goal)
            return
          }
          goal.rounds++
          goal.noProgressRounds =
            (goal.progress ?? 0) > (goal.lastRoundProgress ?? 0) ? 0 : (goal.noProgressRounds ?? 0) + 1
          goal.lastRoundProgress = goal.progress ?? 0
          if (goal.noProgressRounds >= 3) {
            goal.status = "blocked"
            goal.reason = "Three consecutive turns produced no new successful tool work or changed checkpoint evidence."
            goal.revision++
            yield* save(goal)
            return
          }
          yield* save(goal)
          yield* requireMain(sessionID).pipe(
            Effect.andThen(submit(goal)),
            Effect.catch(
              Effect.fn("goal.blockFailedContinuation")(function* (error) {
                goal.status = "blocked"
                goal.reason = String(error)
                goal.revision++
                yield* save(goal)
              })
            )
          )
        }).pipe(locks.withPermits(sessionID, 1))
      }, Effect.catch(logFailure))
    ),
    Effect.catch(logFailure),
    Effect.forkScoped
  )
  return {
    active: (sessionID: string) =>
      read(SessionID.make(sessionID)).pipe(
        Effect.map((goal) => goal?.status === "active"),
        Effect.orDie
      )
  }
})
