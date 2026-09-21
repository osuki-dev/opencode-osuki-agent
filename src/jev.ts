import type { Context } from "@opencode/plugin/effect/plugin"
import { Cause, Clock, Config, Effect, Redacted, Ref, Schema, Semaphore } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { RoutingConfig } from "./config.ts"

export const JEV_ENDPOINT = "https://opencode.ai/zen/v1/systemone"
export const JEV_MODEL = "jev-1.13-free"
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> }
export type ChoiceAnswer = {
  readonly type: "choice"
  readonly choice: string
  readonly confidence: number
  readonly probabilities: Readonly<Record<string, number>>
}
export type Questions = Record<string, ChoiceQuestion>
export type Answers = Readonly<Record<string, ChoiceAnswer>>

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

function responseSchema(questions: Questions) {
  return Schema.Struct({
    answers: Schema.Struct(
      Object.fromEntries(
        Object.entries(questions).map(([id, question]) => {
          const keys = Object.keys(question.criteria)
          return [
            id,
            Schema.Struct({
              type: Schema.Literal("choice"),
              choice: Schema.Literals(keys),
              confidence: Probability,
              probabilities: Schema.Struct(Object.fromEntries(keys.map((key) => [key, Probability])))
                .check(
                  Schema.makeFilter(
                    (probabilities) =>
                      Math.abs(Object.values(probabilities).reduce((sum, value) => sum + value, 0) - 1) <= 0.03 ||
                      "Probabilities must sum to one"
                  )
                )
                .annotate({ parseOptions: { onExcessProperty: "error" } })
            })
          ]
        })
      )
    )
  })
}

export const validateAnswers = Effect.fn("validateAnswers")(function* (raw: unknown, questions: Questions) {
  const result = yield* Schema.decodeUnknownEffect(responseSchema(questions))(raw)
  return result.answers
})

export function redact(text: string): string {
  return text
    .replace(/\b(?:sk-|ghp_|github_pat_|sk_)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, "$1[REDACTED]")
    .replace(/((?:password|api[_-]?key|access[_-]?token|secret)\s*[=:]\s*)["']?[^\s,"'}]+/gi, "$1[REDACTED]")
    .replace(/(\w+:\/\/[^\s:@/]+:)[^\s@/]+@/g, "$1[REDACTED]@")
}

export interface JevStatus {
  readonly provider: "opencode" | "typesafe"
  readonly model: string
  readonly endpoint: string
  readonly calls: number
  readonly last: string
  readonly latencyMs: number
  readonly retryAfterMs: number
}

export interface JevClient {
  readonly evaluate: (state: unknown, questions: Questions) => Effect.Effect<Answers | undefined>
  readonly status: () => Effect.Effect<JevStatus>
}

interface CircuitState {
  readonly retryAt: number
  readonly failures: number
  readonly calls: number
  readonly last: string
  readonly latencyMs: number
}

export const makeJevClient = Effect.fn("makeJevClient")(function* (
  credentials: Effect.Effect<Record<string, string> | undefined, unknown>,
  config: RoutingConfig["jev"],
  options: { readonly fetch?: typeof globalThis.fetch; readonly now?: Effect.Effect<number> } = {}
): Effect.fn.Return<JevClient> {
  const state = yield* Ref.make<CircuitState>({ retryAt: 0, failures: 0, calls: 0, last: "not-called", latencyMs: 0 })
  const semaphore = yield* Semaphore.make(1)
  const now = options.now ?? Clock.currentTimeMillis

  const request = Effect.fn("JevClient.request")(function* (context: unknown, questions: Questions) {
    const headers = yield* credentials
    if (!headers) {
      const time = yield* now
      yield* Ref.update(state, (value) => ({
        ...value,
        last: `missing-${config.provider}-credential`,
        retryAt: time + config.cooldownMs
      }))
      return undefined
    }
    const http = HttpClient.withScope(yield* HttpClient.HttpClient)
    const payload = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(context)
    const outgoing = yield* HttpClientRequest.post(config.endpoint).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyJson({ model: config.model, state: redact(payload).slice(-24_000), questions })
    )
    yield* Ref.update(state, (value) => ({ ...value, calls: value.calls + 1 }))
    const response = yield* http.execute(outgoing)
    if (response.status < 200 || response.status >= 300) {
      const time = yield* now
      yield* Ref.update(state, (value) => {
        const failures = value.failures + 1
        const transient = response.status === 408 || response.status === 429 || response.status >= 500
        const backoff = Math.min(config.cooldownMs * 5, config.cooldownMs * 2 ** Math.min(failures - 1, 5))
        const retryAfter = response.headers["retry-after"]
        const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN
        const retryMs =
          Number.isFinite(seconds) && seconds >= 0
            ? seconds * 1000
            : retryAfter
              ? Math.max(0, Date.parse(retryAfter) - time)
              : 0
        const delay = transient ? Math.max(backoff, Number.isFinite(retryMs) ? retryMs : 0) : config.cooldownMs * 5
        const reason =
          response.status === 401 || response.status === 403
            ? "authentication"
            : response.status === 422 || response.status === 400
              ? "invalid-request"
              : response.status === 429
                ? "rate-limited"
                : response.status === 529
                  ? "overloaded"
                  : "http-error"
        return { ...value, failures, last: `${reason}-${response.status}`, retryAt: time + delay }
      })
      return undefined
    }
    const result = yield* HttpClientResponse.schemaBodyJson(responseSchema(questions))(response)
    yield* Ref.update(state, (value) => ({ ...value, last: "ok", failures: 0, retryAt: 0 }))
    return result.answers
  })

  const evaluate = Effect.fn("JevClient.evaluate")(function* (context: unknown, questions: Questions) {
    const started = yield* now
    if (started < (yield* Ref.get(state)).retryAt) return undefined
    return yield* request(context, questions).pipe(
      Effect.scoped,
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, options.fetch ?? globalThis.fetch),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.timeout(config.timeoutMs),
      Effect.catch((error) =>
        Effect.gen(function* () {
          const time = yield* now
          yield* Ref.update(state, (value) => {
            const failures = value.failures + 1
            const timeout = Cause.isTimeoutError(error)
            // A single slow response is not a rate limit. Retry only on the next
            // useful evaluation; repeated timeouts still back off to the configured cap.
            const delay = timeout
              ? Math.min(config.cooldownMs, 5000 * 2 ** Math.min(failures - 1, 5))
              : config.cooldownMs
            return {
              ...value,
              failures,
              last: timeout ? "timeout" : "invalid-response-or-transport",
              retryAt: time + delay
            }
          })
          return undefined
        })
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          const finished = yield* now
          yield* Ref.update(state, (value) => ({ ...value, latencyMs: finished - started }))
        })
      )
    )
  }, semaphore.withPermit)

  const status = Effect.fn("JevClient.status")(function* () {
    const value = yield* Ref.get(state)
    const time = yield* now
    return {
      provider: config.provider,
      model: config.model,
      endpoint: config.endpoint,
      calls: value.calls,
      last: value.last,
      latencyMs: value.latencyMs,
      retryAfterMs: Math.max(0, value.retryAt - time)
    }
  })
  return { evaluate, status }
})

export const jevCredentials = (ctx: Pick<Context, "integration">, config: RoutingConfig["jev"]) =>
  Effect.gen(function* () {
    if (config.provider === "typesafe") {
      const secret = yield* Config.redacted("TYPESAFE_API_KEY").pipe(Effect.catch(() => Effect.succeed(undefined)))
      const key = secret && Redacted.value(secret).trim()
      return key ? { Authorization: `Bearer ${key}` } : undefined
    }
    const active = yield* ctx.integration.connection.active("opencode")
    const credential = active && (yield* ctx.integration.connection.resolve(active))
    // The free endpoint accepts the OpenCode key, never an OpenAI subscription token.
    if (!credential || credential.type !== "key") return undefined
    return { Authorization: `Bearer ${credential.key}` }
  })

export const makeJev = Effect.fn("makeJev")(function* (ctx: Context, config: RoutingConfig["jev"]) {
  return yield* makeJevClient(jevCredentials(ctx, config), config)
})
