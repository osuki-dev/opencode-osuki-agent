import { expect, test } from "bun:test"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import { Effect } from "effect"
import { registerAgents } from "../src/agents.ts"
import { parseConfig } from "../src/config.ts"

type Entry = { id: string; name: string; mode: string; system?: string; description?: string; model?: unknown }
function registry() {
  const agents = new Map<string, Entry>([
    ["plan", { id: "plan", name: "Plan", mode: "primary", system: "Native planning" }],
    ["general", { id: "general", name: "General", mode: "subagent", system: "Native implementation" }]
  ])
  const editor = {
    get: (id: string) => agents.get(id),
    update: (id: string, update: (agent: Entry) => void) => {
      const agent = agents.get(id) ?? { id, name: id, mode: "primary" }
      update(agent)
      agents.set(id, agent)
    }
  } as unknown as AgentEditor
  return { agents, editor }
}

test("clean installation registers bundled prompts and worker modes without selecting models", async () => {
  const { agents, editor } = registry()
  const config = await Effect.runPromise(parseConfig({}))
  registerAgents(editor, config)
  expect(agents.get("osuki")).toMatchObject({ name: "Osuki", mode: "primary" })
  expect(agents.get("osuki")?.system).toContain("You are Osuki")
  for (const id of ["osuki-worker-quick", "osuki-worker-deep", "osuki-reviewer"]) {
    expect(agents.get(id)?.mode).toBe("subagent")
    expect(agents.get(id)?.system?.length).toBeGreaterThan(100)
    expect(agents.get(id)?.system).not.toStartWith("---")
    expect(agents.get(id)?.description).toBeTruthy()
    expect(agents.get(id)?.model).toBeUndefined()
  }
  expect(agents.get("plan")).toMatchObject({ mode: "all", system: "Native planning" })
  expect(agents.get("general")?.system).toBe("Native implementation")
  const before = JSON.stringify([...agents])
  registerAgents(editor, config)
  expect(JSON.stringify([...agents])).toBe(before)
})

test("custom role IDs and existing agent configuration are preserved", async () => {
  const { agents, editor } = registry()
  agents.set("coder", {
    id: "coder",
    name: "My coder",
    mode: "all",
    system: "My prompt",
    description: "Mine",
    model: "custom/model"
  })
  const config = await Effect.runPromise(
    parseConfig({ coordinator: "lead", agents: { quick: "coder", deep: "expert", review: "audit", plan: "planner" } })
  )
  registerAgents(editor, config)
  expect(agents.get("coder")).toEqual({
    id: "coder",
    name: "My coder",
    mode: "all",
    system: "My prompt",
    description: "Mine",
    model: "custom/model"
  })
  expect(agents.get("lead")?.system).toContain("You are Osuki")
  expect(agents.get("expert")?.mode).toBe("subagent")
  expect(agents.get("audit")?.mode).toBe("subagent")
  expect(agents.has("osuki")).toBe(false)
  expect(agents.get("plan")?.mode).toBe("primary")
})
