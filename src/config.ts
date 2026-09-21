import { Effect, Schema } from "effect"

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const AgentMappings = Schema.Struct({
  explore: Schema.optional(Schema.NonEmptyString),
  plan: Schema.optional(Schema.NonEmptyString),
  review: Schema.optional(Schema.NonEmptyString),
  quick: Schema.optional(Schema.NonEmptyString),
  standard: Schema.optional(Schema.NonEmptyString),
  deep: Schema.optional(Schema.NonEmptyString)
})
const JevCommon = {
  model: Schema.optional(Schema.NonEmptyString),
  timeoutMs: Schema.optional(PositiveInt),
  cooldownMs: Schema.optional(PositiveInt)
}
const JevOptions = Schema.Union([
  Schema.Struct({
    ...JevCommon,
    provider: Schema.optional(Schema.Literal("opencode")),
    endpoint: Schema.optional(Schema.Literal("https://opencode.ai/zen/v1/systemone"))
  }),
  Schema.Struct({
    ...JevCommon,
    provider: Schema.Literal("typesafe"),
    endpoint: Schema.optional(Schema.Literal("https://api.typesafe.ai/v1/systemone"))
  })
])
const RoutingOptions = Schema.Struct({
  confidence: Schema.optional(Probability),
  toolConfidence: Schema.optional(Probability),
  topK: Schema.optional(PositiveInt)
})
const Options = Schema.Struct({
  coordinator: Schema.optional(Schema.NonEmptyString),
  agents: Schema.optional(AgentMappings),
  jev: Schema.optional(JevOptions),
  routing: Schema.optional(RoutingOptions),
  excludedModels: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

export const parseConfig = Effect.fn("osuki.parseConfig")(function* (input: unknown) {
  const options = yield* Schema.decodeUnknownEffect(Options)(input, { onExcessProperty: "error" })
  return {
    coordinator: options.coordinator ?? "osuki",
    agents: {
      explore: options.agents?.explore ?? "explore",
      plan: options.agents?.plan ?? "plan",
      review: options.agents?.review ?? "osuki-reviewer",
      quick: options.agents?.quick ?? "osuki-worker-quick",
      standard: options.agents?.standard ?? "general",
      deep: options.agents?.deep ?? "osuki-worker-deep"
    },
    jev: {
      provider: options.jev?.provider ?? "opencode",
      model: options.jev?.model ?? (options.jev?.provider === "typesafe" ? "jev-latest" : "jev-1.13-free"),
      endpoint:
        options.jev?.provider === "typesafe"
          ? "https://api.typesafe.ai/v1/systemone"
          : "https://opencode.ai/zen/v1/systemone",
      timeoutMs: options.jev?.timeoutMs ?? 10_000,
      cooldownMs: options.jev?.cooldownMs ?? 60_000
    },
    routing: {
      confidence: options.routing?.confidence ?? 0.75,
      toolConfidence: options.routing?.toolConfidence ?? 0.8,
      topK: options.routing?.topK ?? 3
    },
    excludedModels: options.excludedModels ?? ["openai/gpt-5.3-codex", "openai/gpt-5.3-codex-spark"]
  }
})

export type RoutingConfig = Effect.Success<ReturnType<typeof parseConfig>>
