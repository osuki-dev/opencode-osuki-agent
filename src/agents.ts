import type { AgentEditor } from "@opencode/plugin/effect/agent"
import { Schema } from "effect"
import type { RoutingConfig } from "./config.ts"
import coordinator from "../agents/osuki.md" with { type: "text" }
import quick from "../agents/osuki-worker-quick.md" with { type: "text" }
import deep from "../agents/osuki-worker-deep.md" with { type: "text" }
import review from "../agents/osuki-reviewer.md" with { type: "text" }

const Metadata = Schema.Struct({
  description: Schema.NonEmptyString,
  mode: Schema.Literals(["primary", "subagent", "all"])
})

function definition(markdown: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(markdown)
  if (!match) throw new Error("Invalid bundled agent Markdown")
  return {
    ...Schema.decodeUnknownSync(Metadata)(Bun.YAML.parse(match[1])),
    system: match[2].trim()
  }
}

const bundled = {
  coordinator: definition(coordinator),
  quick: definition(quick),
  deep: definition(deep),
  review: definition(review)
}

export function registerAgents(editor: AgentEditor, config: RoutingConfig) {
  for (const role of ["coordinator", "quick", "deep", "review"] as const) {
    const id = role === "coordinator" ? config.coordinator : config.agents[role]
    const existing = editor.get(id)
    editor.update(id, (agent) => {
      agent.system ??= bundled[role].system
      agent.description ??= bundled[role].description
      if (!existing) agent.mode = bundled[role].mode
      if (role === "coordinator" && id === "osuki")
        agent.name = Schema.String.pipe(Schema.brand("Agent.Name")).make("Osuki")
    })
  }
  // The built-in planner must support delegation; later native configuration can override this.
  if (config.agents.plan === "plan")
    editor.update("plan", (agent) => {
      agent.mode = "all"
    })
}
