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
  const optionalUnavailable = {
    ...input,
    validation: [...input.validation, { check: "Optional stylelint", result: "unavailable" as const, evidence: "No stylelint configuration" }]
  }
  const optional = await Effect.runPromise(
    reviewChange({ ...jev, evaluate: () => Effect.succeed(passing()) }, optionalUnavailable, config, true)
  )
  expect(optional.outcome).toBe("lightweight-passed")
})

test("only ineligible or oversized work escalates; missing and failed checks request evidence without a Jev call", async () => {
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
    const escalates = !candidate.eligible || candidate.value.context.length >= 20_000
    expect(result.outcome).toBe(escalates ? "reviewer-required" : "evidence-required")
    expect("agent" in result ? result.agent : undefined).toBe(escalates ? "custom-reviewer" : undefined)
  }
})

test("missing, uncertain and adverse Jev answers never approve a lightweight review", async () => {
  const config = await Effect.runPromise(parseConfig({}))
  const cases: (Answers | undefined)[] = [
    undefined,
    {},
    { ...passing(), scope: { ...passing().scope!, choice: "risky" } },
    { ...passing(), correctness: { ...passing().correctness!, choice: "regression" } },
    { ...passing(), validation: { ...passing().validation!, confidence: 0.1 } }
  ]
  for (const answers of cases) {
    const jev: JevClient = { evaluate: () => Effect.succeed(answers), status: () => Effect.die("unused") }
    const result = await Effect.runPromise(reviewChange(jev, input, config, true))
    expect(result.outcome).not.toBe("lightweight-passed")
    if (!answers) {
      expect(result.reason).toContain("review is pending")
      expect("note" in result && result.note).toContain("Do not gather unrelated evidence")
    }
    if (answers?.scope?.choice !== "risky") expect(result).not.toHaveProperty("agent")
  }
})

test("validation uncertainty and local findings do not invoke the expensive reviewer", async () => {
  const config = await Effect.runPromise(parseConfig({}))
  for (const [answers, outcome] of [
    [{ ...passing(), validation: { ...passing().validation!, confidence: 0.66 } }, "evidence-required"],
    [{ ...passing(), validation: { ...passing().validation!, choice: "failed" } }, "evidence-required"],
    [{ ...passing(), correctness: { ...passing().correctness!, choice: "regression" } }, "changes-required"],
    [{ ...passing(), scope: { ...passing().scope!, choice: "risky" } }, "reviewer-required"]
  ] as const) {
    const jev: JevClient = { evaluate: () => Effect.succeed(answers), status: () => Effect.die("unused") }
    expect((await Effect.runPromise(reviewChange(jev, input, config, true))).outcome).toBe(outcome)
  }
})

test("a small reviewed change with a blocked broad check remains a validation blocker, not a model escalation", async () => {
  let calls = 0
  const jev: JevClient = {
    evaluate: () => {
      calls++
      return Effect.succeed(passing())
    },
    status: () => Effect.die("unused")
  }
  const config = await Effect.runPromise(parseConfig({}))
  const result = await Effect.runPromise(
    reviewChange(
      jev,
      {
        ...input,
        validation: [
          ...input.validation,
          { check: "Required integration suite", result: "unavailable", evidence: "Dependency service is unreachable", required: true }
        ]
      },
      config,
      true
    )
  )
  expect(calls).toBe(0)
  expect(result.outcome).toBe("evidence-required")
  expect(result).not.toHaveProperty("agent")
  expect(result.goalReceipt).toBe(false)
})
