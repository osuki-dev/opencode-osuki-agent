import { expect, test } from "bun:test"
import { makeSessionState } from "../src/session-state.ts"

const input = { task: "Remove border", request: "request-1", context: [], revision: 0 }
const quick = { tier: "quick" as const, planning: "skip", source: "jev" }
const call = (id: string) => ({ sessionID: "root", messageID: "message-1", id })

test("current evidence refreshes without reclassifying the same request", () => {
  const state = makeSessionState()
  const first = state.observe("root", input)
  expect(first.changed).toBe(true)
  expect(state.decide("root", first.workflow.epoch, quick)).toBe(true)
  const context = [{ role: "assistant" as const, content: [{ text: "The inspected code has no behavior change" }] }]
  const next = state.observe("root", { ...input, context })
  expect(next.changed).toBe(false)
  expect(next.workflow.context).toEqual(context)
  expect(next.workflow.decision).toEqual(quick)
  expect(next.workflow.epoch).toBe(first.workflow.epoch)
})

test("new requests, work revisions and mutations reject stale asynchronous decisions and reviews", () => {
  for (const change of ["request", "revision", "mutation"] as const) {
    const state = makeSessionState()
    const old = state.observe("root", input).workflow
    state.decide("root", old.epoch, quick)
    state.reviewed("root", old.epoch, { outcome: "reviewer-required", evidence: "diff-hash" })
    if (change === "mutation") state.invalidate("root")
    else state.observe("root", { ...input, ...(change === "request" ? { request: "request-2" } : { revision: 1 }) })
    expect(state.get("root")?.workflow?.review).toBeUndefined()
    expect(state.decide("root", old.epoch, quick)).toBe(false)
    expect(state.reviewed("root", old.epoch, { outcome: "lightweight-passed", evidence: "old-hash" })).toBe(false)
  }
})

test("diagnostics are session-local and eviction cannot revive an old epoch", () => {
  const state = makeSessionState()
  const old = state.observe("root", input).workflow
  state.tools("root", { before: 12, after: 8, mode: "top-level-shortlist" })
  state.tools("other", { before: 2, after: 2, mode: "skipped-catalog-size" })
  expect(state.get("root")?.toolRouting?.before).toBe(12)
  expect(state.get("other")?.toolRouting?.before).toBe(2)
  for (let i = 0; i < 256; i++) state.routed(`session-${i}`, { source: "test" })
  expect(state.get("root")).toBeUndefined()
  expect(state.observe("root", input).workflow.epoch).not.toBe(old.epoch)
  expect(state.decide("root", old.epoch, quick)).toBe(false)
})

test("parallel edits invalidate review but not an unchanged dispatch decision", () => {
  const state = makeSessionState()
  const workflow = state.observe("root", input).workflow
  state.invalidate("root")
  expect(state.current("root", workflow.epoch)).toBe(false)
  expect(state.canDispatch("root", workflow)).toBe(true)
  expect(state.canDispatch("root", workflow, true)).toBe(false)
  const latest = state.get("root")!.workflow!
  state.decide("root", latest.epoch, quick)
  expect(state.canDispatch("root", workflow)).toBe(false)
  state.observe("root", { ...input, request: "new-request" })
  expect(state.canDispatch("root", latest)).toBe(false)
})

test("review waits for every active write across requests and accepts only settled evidence", () => {
  const state = makeSessionState()
  state.observe("root", input)
  state.mutation("root", call("write-1"), true)
  state.mutation("root", call("write-2"), true)
  const current = state.observe("root", { ...input, request: "request-2" }).workflow
  const review = { outcome: "lightweight-passed" as const, evidence: "diff-hash" }
  expect(state.mutating("root")).toBe(true)
  expect(state.reviewed("root", current.epoch, review)).toBe(false)
  expect(state.canDispatch("root", current, true)).toBe(false)
  expect(state.canDispatch("root", current)).toBe(true)
  state.mutation("root", call("write-1"), false)
  expect(state.mutating("root")).toBe(true)
  state.mutation("root", call("write-2"), false)
  expect(state.mutating("root")).toBe(false)
  expect(state.reviewed("root", current.epoch, review)).toBe(false)
  const settled = state.get("root")!.workflow!
  expect(state.reviewed("root", settled.epoch, review)).toBe(true)
  expect(state.canDispatch("root", settled, true)).toBe(true)
})

test("cache churn cannot discard an active write", () => {
  const state = makeSessionState()
  state.observe("root", input)
  state.mutation("root", call("write-1"), true)
  for (let i = 0; i < 300; i++) state.tools(`child-${i}`, { before: 1, after: 1, mode: "skipped-catalog-size" })
  const current = state.observe("root", input).workflow
  expect(state.mutating("root")).toBe(true)
  expect(state.reviewed("root", current.epoch, { outcome: "lightweight-passed", evidence: "diff" })).toBe(false)
  state.mutation("root", call("write-1"), false)
  for (let i = 0; i < 256; i++) state.routed(`session-${i}`, {})
  expect(state.get("root")).toBeUndefined()
})

test("CodeMode writes are counted and terminal cleanup is scoped to the exact native call", () => {
  const state = makeSessionState()
  state.observe("root", input)
  const outer = call("execute-1")
  state.mutation("root", outer, true)
  state.mutation("root", outer, true)
  state.mutation("root", outer, false)
  expect(state.mutating("root")).toBe(true)
  state.settled({ ...outer, messageID: "older-message" })
  state.settled({ ...outer, sessionID: "other-child" })
  expect(state.mutating("root")).toBe(true)
  state.settled(outer)
  expect(state.mutating("root")).toBe(false)
  expect(state.get("root")?.workflow?.review).toBeUndefined()
  const settled = state.get("root")!.workflow!
  state.settled(outer)
  expect(state.current("root", settled.epoch)).toBe(true)
})
