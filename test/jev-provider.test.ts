import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { ConfigProvider, Effect, Ref } from "effect"
import { parseConfig } from "../src/config.ts"
import { jevCredentials, makeJevClient } from "../src/jev.ts"
import { ROUTE_QUESTIONS } from "../src/routing.ts"

const answer = {
  answers: {
    complexity: {
      type: "choice" as const,
      choice: "quick",
      confidence: 0.9,
      probabilities: { quick: 0.95, standard: 0.04, deep: 0.01 }
    }
  }
}

test("provider defaults are explicit and cross-provider endpoints and inline secrets are rejected", async () => {
  const zen = await Effect.runPromise(parseConfig({}))
  const official = await Effect.runPromise(parseConfig({ jev: { provider: "typesafe", model: "custom-jev" } }))
  expect(zen.jev).toMatchObject({ provider: "opencode", model: "jev-1.13-free", timeoutMs: 10000 })
  expect(official.jev).toMatchObject({
    provider: "typesafe",
    model: "custom-jev",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    timeoutMs: 10000
  })
  expect((await Effect.runPromise(parseConfig({ jev: { timeoutMs: 2500 } }))).jev.timeoutMs).toBe(2500)
  for (const jev of [
    { provider: "typesafe", endpoint: "https://opencode.ai/zen/v1/systemone" },
    { provider: "opencode", endpoint: "https://api.typesafe.ai/v1/systemone" },
    { provider: "typesafe", endpoint: "https://third-party.invalid" },
    { provider: "typesafe", apiKey: "must-not-be-stored-here" }
  ])
    expect(await Effect.runPromise(parseConfig({ jev }).pipe(Effect.isFailure))).toBe(true)
})

test("TypeSafe reads the Effect environment provider without accessing OpenCode credentials", async () => {
  const config = await Effect.runPromise(parseConfig({ jev: { provider: "typesafe" } }))
  const ctx = {
    integration: {
      connection: {
        active: () => Effect.die("must not access OpenCode credentials"),
        resolve: () => Effect.die("must not resolve OpenCode credentials")
      }
    }
  } as unknown as Pick<Context, "integration">
  for (const key of [undefined, "", "  ", "test-typesafe-only"]) {
    const credentials = await Effect.runPromise(
      jevCredentials(ctx, config.jev).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: key }))
      )
    )
    expect(credentials).toEqual(key?.trim() ? { Authorization: `Bearer ${key}` } : undefined)
  }
})

test("OpenCode keeps its native credential resolver even when a TypeSafe key exists", async () => {
  const config = await Effect.runPromise(parseConfig({}))
  const ctx = {
    integration: {
      connection: {
        active: (id: string) => {
          expect(id).toBe("opencode")
          return Effect.succeed({ id: "native-connection" })
        },
        resolve: () => Effect.succeed({ type: "key", key: "test-zen-only" })
      }
    }
  } as unknown as Pick<Context, "integration">
  expect(
    await Effect.runPromise(
      jevCredentials(ctx, config.jev).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: "test-typesafe-only" })
        )
      )
    )
  ).toEqual({ Authorization: "Bearer test-zen-only" })
})

test("official transport uses only its endpoint, preserves latest context and omits secrets from status", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* parseConfig({ jev: { provider: "typesafe" } })
      const client = yield* makeJevClient(Effect.succeed({ Authorization: "Bearer test-typesafe-only" }), config.jev, {
        fetch: (async (url, init) => {
          expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone")
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-typesafe-only")
          expect(init?.redirect).toBe("error")
          const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))
          expect(body.model).toBe("jev-latest")
          expect(body.state).toContain("LATEST_USER_REQUEST")
          expect(body.state.length).toBeLessThanOrEqual(24_000)
          return Response.json(answer)
        }) as typeof fetch
      })
      expect(
        yield* client.evaluate([{ text: "x".repeat(40_000) }, { text: "LATEST_USER_REQUEST" }], ROUTE_QUESTIONS)
      ).toEqual(answer.answers)
      const status = yield* client.status()
      expect(status).toMatchObject({ provider: "typesafe", last: "ok", calls: 1 })
      expect(JSON.stringify(status)).not.toContain("test-typesafe-only")
    })
  )
})

test("HTTP failures are classified, honor Retry-After and never switch providers", async () => {
  for (const [code, reason] of [
    [401, "authentication"],
    [422, "invalid-request"],
    [429, "rate-limited"],
    [529, "overloaded"]
  ] as const) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* parseConfig({ jev: { provider: "typesafe" } })
        const clock = yield* Ref.make(0)
        let calls = 0
        const client = yield* makeJevClient(
          Effect.succeed({ Authorization: "Bearer test-typesafe-only" }),
          config.jev,
          {
            now: Ref.get(clock),
            fetch: (async (url) => {
              calls++
              expect(String(url)).toBe(config.jev.endpoint)
              return new Response("not logged", { status: code, headers: { "Retry-After": "600" } })
            }) as typeof fetch
          }
        )
        expect(yield* client.evaluate({}, ROUTE_QUESTIONS)).toBeUndefined()
        expect((yield* client.status()).last).toBe(`${reason}-${code}`)
        expect((yield* client.status()).retryAfterMs).toBe(code >= 429 ? 600_000 : 300_000)
        yield* Ref.set(clock, 60_001)
        expect(yield* client.evaluate({}, ROUTE_QUESTIONS)).toBeUndefined()
        expect(calls).toBe(1)
      })
    )
  }
})
