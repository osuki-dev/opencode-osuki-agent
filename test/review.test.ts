import { expect, test } from "bun:test"
import { Effect } from "effect"
import { parseConfig } from "../src/config.ts"
import type { Answers, JevClient } from "../src/jev.ts"
import { REVIEW_QUESTIONS, reviewChange } from "../src/review.ts"

const input = {
  task: "Remove the card border",
  diff: "--- a/card.css\n+++ b/card.css\n@@ -1 +1 @@\n-.card { border: 1px solid; }\n+.card { border: none; }",
  context: "The card selector only styles the requested component.",
  validation: [
    { check: "Visual inspection", result: "passed" as const, evidence: "Card border is gone; spacing unchanged." }
  ]
}

function passing(): Answers {
  return Object.fromEntries(
    Object.entries({ scope: "bounded", correctness: "satisfied", validation: "sufficient" }).map(([id, choice]) => [
      id,
      {
        type: "choice" as const,
        choice,
        confidence: 0.95,
        probabilities: Object.fromEntries(
          Object.keys(REVIEW_QUESTIONS[id]!.criteria).map((key) => [key, key === choice ? 1 : 0])
        )
      }
    ])
  )
}

test("a bounded validated diff batches review criteria and needs no coding-model reviewer", async () => {
  let calls = 0
  const jev: JevClient = {
    evaluate: (state, questions) => {
      calls++
      expect(state).toEqual(input)
      expect(questions).toEqual(REVIEW_QUESTIONS)
      return Effect.succeed(passing())
    },
    status: () => Effect.die("unused")
  }
  const config = await Effect.runPromise(parseConfig({}))
  const result = await Effect.runPromise(reviewChange(jev, input, config, true))
  expect(result.outcome).toBe("lightweight-passed")
  expect(result.goalReceipt).toBe(false)
  expect(calls).toBe(1)
})

test("ineligible workflows, partial or oversized context, and failed validation escalate without a Jev call", async () => {
  const jev: JevClient = { evaluate: () => Effect.die("must not call"), status: () => Effect.die("unused") }
  const config = await Effect.runPromise(parseConfig({ agents: { review: "custom-reviewer" } }))
  for (const candidate of [
    { value: input, eligible: false },
    { value: { ...input, diff: "Removed border" }, eligible: true },
    { value: { ...input, context: "x".repeat(20_000) }, eligible: true },
    { value: { ...input, validation: [] }, eligible: true },
    {
      value: { ...input, validation: [{ check: "build", result: "failed" as const, evidence: "compile error" }] },
      eligible: true
    }
  ]) {
    const result = await Effect.runPromise(reviewChange(jev, candidate.value, config, candidate.eligible))
    expect(result.outcome).toBe("reviewer-required")
    expect("agent" in result && result.agent).toBe("custom-reviewer")
  }
})

test("missing, uncertain and adverse Jev answers never approve a lightweight review", async () => {
  const config = await Effect.runPromise(parseConfig({}))
  for (const answers of [
    undefined,
    {},
    { ...passing(), scope: { ...passing().scope!, choice: "risky" } },
    { ...passing(), correctness: { ...passing().correctness!, choice: "regression" } },
    { ...passing(), validation: { ...passing().validation!, confidence: 0.1 } }
  ]) {
    const jev: JevClient = { evaluate: () => Effect.succeed(answers), status: () => Effect.die("unused") }
    const result = await Effect.runPromise(reviewChange(jev, input, config, true))
    expect(result.outcome).toBe("reviewer-required")
  }
})
