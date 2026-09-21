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
  readonly mutations?: ReadonlyMap<string, number>
}
type Call = { readonly sessionID: string; readonly messageID: string; readonly id: string }
const callKey = (call: Call) => JSON.stringify([call.sessionID, call.messageID, call.id])

// Runtime evidence only. OpenCode owns durable work, goals and execution state.
export function makeSessionState() {
  const entries = new Map<string, SessionState>()
  let epoch = 0
  const update = (id: string, change: Partial<SessionState>) => {
    const next = { ...entries.get(id), ...change }
    entries.delete(id)
    entries.set(id, next)
    if (entries.size > 256) {
      // Active writes are safety state, not evictable cached decisions.
      for (const [key, state] of entries) {
        if (state.mutations?.size) continue
        entries.delete(key)
        break
      }
    }
    return next
  }
  const current = (id: string, expected: number) => entries.get(id)?.workflow?.epoch === expected
  const mutating = (id: string) => Boolean(entries.get(id)?.mutations?.size)
  return {
    get: (id: string) => entries.get(id),
    current,
    mutating,
    mutation(id: string, call: Call, active: boolean) {
      const state = entries.get(id)
      const mutations = new Map(state?.mutations)
      const key = callKey(call)
      const count = (mutations.get(key) ?? 0) + (active ? 1 : -1)
      // Parallel CodeMode tools share their outer call ID.
      if (count > 0) mutations.set(key, count)
      else mutations.delete(key)
      update(id, { mutations, workflow: state?.workflow && { ...state.workflow, epoch: ++epoch, review: undefined } })
    },
    settled(call: Call) {
      const key = callKey(call)
      for (const [id, state] of entries) {
        if (!state.mutations?.has(key)) continue
        const mutations = new Map(state.mutations)
        mutations.delete(key)
        update(id, { mutations, workflow: state.workflow && { ...state.workflow, epoch: ++epoch, review: undefined } })
        return
      }
    },
    canDispatch(id: string, expected: Workflow, review = false) {
      const workflow = entries.get(id)?.workflow
      // Parallel workers may edit without changing the assignment decision.
      return (
        workflow?.request === expected.request &&
        workflow.revision === expected.revision &&
        workflow.decision === expected.decision &&
        (!review || (workflow.epoch === expected.epoch && !mutating(id)))
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
      if (!workflow || !current(id, expected) || mutating(id)) return false
      update(id, { workflow: { ...workflow, review } })
      return true
    },
    routed: (id: string, route: unknown) => update(id, { lastRoute: route }),
    tools: (id: string, toolRouting: ToolRouting) => update(id, { toolRouting })
  }
}
