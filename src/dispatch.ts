import type { RoutingConfig } from "./config.ts"
import type { Workflow } from "./session-state.ts"

export function dispatchDenial(
  agent: string,
  workflow: Workflow | undefined,
  activeGoal: boolean,
  config: RoutingConfig
) {
  if (activeGoal) return undefined
  if (agent === config.agents.plan && workflow?.decision.planning !== "required")
    return {
      event: "planner-denied",
      message:
        "A separate planner is not justified for the current request. Answer, inspect or implement directly within user authority. If new design/risk evidence or an explicit planning requirement changes this, use osuki_route with that evidence; on Jev uncertainty provide a reasoned assessment. Do not relabel the same work to bypass this decision."
    }
  if (
    agent === config.agents.review &&
    (workflow?.decision.planning === "assess" ||
      (workflow?.decision.tier === "quick" && workflow.decision.planning === "skip")) &&
    workflow?.review?.outcome !== "reviewer-required"
  )
    return {
      event: "reviewer-denied",
      message:
        "Unresolved routing or a bounded edit does not justify the expensive reviewer. Use osuki_route to assess uncertain scope, then osuki_review for eligible edits; collect missing evidence or resolve local findings first. Unavailable Jev or E2E is not a code-risk escalation."
    }
}
