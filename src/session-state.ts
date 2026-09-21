import type { compactState, implementationWorkflow } from "./routing.ts"
import type { reviewChange } from "./review.ts"
import type { Effect } from "effect"

export type Decision = ReturnType<typeof implementationWorkflow>
export type ReviewOutcome = Effect.Success<ReturnType<typeof reviewChange>>["outcome"]
export interface Workflow {
  readonly task: string
  readonly request: string
  readonly context: ReturnType<typeof compactState>
  readonly revision?: number
  readonly epoch: number
  readonly decision: Decision
  readonly review?: { readonly outcome: ReviewOutcome; readonly evidence: string }
}
export interface ToolRouting {
  readonly before: number
  readonly after: number
  readonly mode: string
}
interface SessionState {
  readonly workflow?: Workflow
  readonly lastRoute?: unknown
  readonly toolRouting?: ToolRouting
}

// Runtime evidence only. OpenCode owns durable work, goals and execution state.
export function makeSessionState() {
  const entries = new Map<string, SessionState>()
  let epoch = 0
  const update = (id: string, change: Partial<SessionState>) => {
    const next = { ...entries.get(id), ...change }
    entries.delete(id)
    entries.set(id, next)
    if (entries.size > 256) entries.delete(entries.keys().next().value ?? "")
    return next
  }
  const current = (id: string, expected: number) => entries.get(id)?.workflow?.epoch === expected
  return {
    get: (id: string) => entries.get(id),
    current,
    canDispatch(id: string, expected: Workflow) {
      const workflow = entries.get(id)?.workflow
      // Parallel workers may edit without changing the assignment decision.
      return (
        workflow?.request === expected.request &&
        workflow.revision === expected.revision &&
        workflow.decision === expected.decision
      )
    },
    observe(id: string, input: Pick<Workflow, "task" | "request" | "context" | "revision">) {
      const previous = entries.get(id)?.workflow
      const changed = previous?.request !== input.request
      const invalidated = changed || previous?.revision !== input.revision
      const workflow: Workflow = {
        ...input,
        epoch: invalidated || !previous ? ++epoch : previous.epoch,
        decision:
          !changed && previous ? previous.decision : { tier: "standard", planning: "assess", source: "fallback" },
        review: invalidated ? undefined : previous?.review
      }
      update(id, { workflow, ...(changed ? { lastRoute: undefined, toolRouting: undefined } : {}) })
      return { workflow, changed }
    },
    decide(id: string, expected: number, decision: Decision) {
      const workflow = entries.get(id)?.workflow
      if (!workflow || !current(id, expected)) return false
      update(id, { workflow: { ...workflow, decision } })
      return true
    },
    invalidate(id: string) {
      const workflow = entries.get(id)?.workflow
      if (!workflow) return undefined
      const next = { ...workflow, epoch: ++epoch, review: undefined }
      update(id, { workflow: next })
      return next
    },
    reviewed(id: string, expected: number, review: NonNullable<Workflow["review"]>) {
      const workflow = entries.get(id)?.workflow
      if (!workflow || !current(id, expected)) return false
      update(id, { workflow: { ...workflow, review } })
      return true
    },
    routed: (id: string, route: unknown) => update(id, { lastRoute: route }),
    tools: (id: string, toolRouting: ToolRouting) => update(id, { toolRouting })
  }
}
