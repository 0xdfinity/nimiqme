/**
 * Dependency-free tests for the brain proxy's provider fallback.
 *
 * The proxy is narration-only: it must try providers in order, never throw, and
 * fail closed (ok:false) when nothing is configured or everything is down — so
 * the mini app can keep using its local answers. Run with `npm test`.
 */

import assert from "node:assert/strict"
import { chatWithFallback } from "../server/brain.mjs"

let passed = 0
const failures = []

async function asyncTest(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL  ${name}`)
    console.log(`      ${error.message.split("\n").slice(0, 6).join("\n      ")}`)
  }
}

const groq = { name: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: "g", model: "gm" }
const nemotron = { name: "nemotron", baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: "n", model: "nm" }

const completion = (text) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: text } }] }),
})
const httpError = (status) => ({ ok: false, status, json: async () => ({}) })

/** Fetch stub that answers per provider base URL and records the call order. */
function scriptFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { calls, fetchImpl }
}

const MSG = [{ role: "user", content: "running shoes under 40" }]

console.log("\nbrain fallback")

await asyncTest("primary provider answers and its system prompt is prepended", async () => {
  const { calls, fetchImpl } = scriptFetch(() => completion("Atlas Supply has the Red Runner at 39.00 NIM."))
  const result = await chatWithFallback(MSG, { providers: [groq, nemotron], fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.model, "gm")
  assert.match(result.text, /Atlas Supply/)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.startsWith(groq.baseUrl), "hits groq first")
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.messages[0].role, "system", "system narration rule prepended")
  assert.ok(body.messages[0].content.includes("Never invent prices"), "anti-hallucination guard present")
  assert.match(calls[0].init.headers.authorization, /^Bearer g$/)
})

await asyncTest("primary down falls through to the fallback provider", async () => {
  const { calls, fetchImpl } = scriptFetch((url) =>
    url.startsWith(groq.baseUrl) ? httpError(503) : completion("Found two offers; lowest is 34.00 NIM.")
  )
  const result = await chatWithFallback(MSG, { providers: [groq, nemotron], fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.model, "nm")
  assert.equal(calls.length, 2, "tried groq then nemotron")
  assert.ok(calls[1].url.startsWith(nemotron.baseUrl))
})

await asyncTest("every provider down fails closed, never throws", async () => {
  const { fetchImpl } = scriptFetch(() => {
    throw new TypeError("fetch failed")
  })
  const result = await chatWithFallback(MSG, { providers: [groq, nemotron], fetchImpl })
  assert.equal(result.ok, false)
  assert.match(result.error, /Brain unavailable/)
})

await asyncTest("a provider that returns no text counts as a failure", async () => {
  const { fetchImpl } = scriptFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: "   " } }] }),
  }))
  const result = await chatWithFallback(MSG, { providers: [groq], fetchImpl })
  assert.equal(result.ok, false)
  assert.match(result.error, /returned no text/)
})

await asyncTest("no providers configured fails closed with the setup hint", async () => {
  const result = await chatWithFallback(MSG, { providers: [], fetchImpl: async () => completion("x") })
  assert.equal(result.ok, false)
  assert.equal(result.error, "No brain configured.")
})

await asyncTest("malformed messages are rejected before any network call", async () => {
  const { calls, fetchImpl } = scriptFetch(() => completion("should not reach here"))
  for (const bad of [undefined, null, [], [{ role: "user" }], [{ role: "hacker", content: "x" }]]) {
    const result = await chatWithFallback(bad, { providers: [groq], fetchImpl })
    assert.equal(result.ok, false)
    assert.match(result.error, /message/i)
  }
  assert.equal(calls.length, 0, "never hits the network on invalid input")
})

await asyncTest("oversized and excess messages are trimmed, not rejected", async () => {
  const long = "a".repeat(5000)
  const many = Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `q${i}` }))
  const { calls, fetchImpl } = scriptFetch(() => completion("ok"))
  const trimmed = await chatWithFallback([...many, { role: "user", content: long }], {
    providers: [groq],
    fetchImpl,
  })
  assert.equal(trimmed.ok, true)
  const body = JSON.parse(calls[0].init.body)
  // system + at most 20 kept, and the 5000-char message dropped (>4000).
  assert.ok(body.messages.length <= 21)
  assert.ok(body.messages.every((m) => m.content.length <= 4000))
})

console.log("\nsummary")
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} failed\n`)
  for (const failure of failures) console.error(`${failure.name}: ${failure.error.stack}\n`)
  process.exitCode = 1
} else {
  console.log(`All ${passed} checks passed.\n`)
}
