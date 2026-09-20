import { expect, test } from "bun:test"
import { messageDecision } from "../src/continuity.ts"

test("message classification falls back safely for uncertainty and invalid categories", () => {
  expect(messageDecision(undefined, 0.75)).toEqual({ intent: "uncertain", source: "fallback" })
  for (const [choice, confidence] of [
    ["question", 0.5],
    ["invented", 1]
  ] as const)
    expect(messageDecision({ type: "choice", choice, confidence, probabilities: {} }, 0.75).intent).toBe("uncertain")
  for (const choice of ["question", "amend", "independent", "conflict", "cancel"] as const)
    expect(messageDecision({ type: "choice", choice, confidence: 0.95, probabilities: {} }, 0.75)).toEqual({
      intent: choice,
      source: "jev"
    })
})
