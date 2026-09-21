import { expect, test } from "bun:test"
import { makeSessionState } from "../src/session-state.ts"

const input = { task: "Remove border", request: "request-1", context: [], revision: 0 }
const quick = { tier: "quick" as const, planning: "skip", source: "jev" }

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
  const latest = state.get("root")!.workflow!
  state.decide("root", latest.epoch, quick)
  expect(state.canDispatch("root", workflow)).toBe(false)
  state.observe("root", { ...input, request: "new-request" })
  expect(state.canDispatch("root", latest)).toBe(false)
})
