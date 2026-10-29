/**
 * Dependency-free unit tests for the money-critical pure modules.
 *
 * Run with `npm test`. Uses Node's built-in type stripping, which is why the
 * modules under test import each other with explicit `.ts` extensions and have
 * no runtime dependency on the SDK, the DOM, or Vite.
 */

import assert from "node:assert/strict"
import {
  LUNA_PER_NIM,
  QUOTE_TTL_MS,
  buildQuote,
  isValidNimiqAddress,
  quoteDigest,
  recheckQuote,
} from "../src/quote.ts"
import {
  createCheckoutRef,
  decodeBase64Reference,
  decodeReferenceData,
  encodeReferenceData,
  isCheckoutRef,
  MAX_TX_DATA_BYTES,
} from "../src/reference.ts"
import {
  EXPLORER_API_BASE,
  REQUIRED_CONFIRMATIONS,
  explorerApiUrl,
  explorerTxUrl,
  pollTransaction,
  verifyPaymentShape,
} from "../src/verify.ts"
import { mergePayment, parsePayments } from "../src/payment-state.ts"

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL  ${name}`)
    console.log(`      ${error.message.split("\n").slice(0, 6).join("\n      ")}`)
  }
}

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

const CHECKOUT_REF = "NQM:7KQ2XF3M"
const RECIPIENT = "NQ22U2S1VUGYT5J32RKUH8QATRE2TKTSH641"
const SENDER = "NQ08ACT8T0FEPTG8P5RLH2S3QGXHV15RNVXY"

function base64OfHex(hex) {
  return Buffer.from(hex, "hex").toString("base64")
}

/**
 * Recorded verbatim from `GET https://v2.nimiqwatch.com/api/v1/transaction/
 * 5d7d7625c829ff34fb001421ab6137579b83637f9eb526d91a4731b6dc1142e7` so the
 * field names, the spaced address, and the base64 data field are real shapes.
 */
const LIVE_TX_SHAPE = {
  block_height: 64763103,
  hash: "5d7d7625c829ff34fb001421ab6137579b83637f9eb526d91a4731b6dc1142e7",
  sender_address: "NQ08 ACT8 T0FE PTG8 P5RL H2S3 QGXH V15R NVXY",
  value: 216,
  fee: 0,
  validity_start_height: 64763102,
  executed: true,
  timestamp: 1792555742,
  receiver_address: "NQ77 0000 0000 0000 0000 0000 0000 0000 0001",
  data: "BgJ2PEmYhqBDGdTLK4kfuqQprPka",
  confirmations: 339,
}

/** Same shape, but carrying this checkout's recipient, amount and reference. */
function ourTx(overrides = {}) {
  return {
    ...LIVE_TX_SHAPE,
    hash: "a".repeat(64),
    receiver_address: "NQ22 U2S1 VUGY T5J3 2RKU H8QA TRE2 TKTS H641",
    value: 4_100_000,
    data: base64OfHex(encodeReferenceData(CHECKOUT_REF)),
    confirmations: REQUIRED_CONFIRMATIONS,
    ...overrides,
  }
}

const expected = {
  txHash: "a".repeat(64),
  checkoutRef: CHECKOUT_REF,
  amountMinor: 4_100_000,
  recipient: RECIPIENT,
  network: "mainnet",
  sender: SENDER,
}

console.log("\nreference")
test("reference looks like NQM:<8 chars>", () => {
  const ref = createCheckoutRef()
  assert.match(ref, /^NQM:[A-Z0-9]{8}$/)
  assert.equal(isCheckoutRef(ref), true)
  assert.equal(isCheckoutRef("54a60c78683948"), false)
  assert.equal(isCheckoutRef("nqm:7kq2xf3m"), false)
})

test("reference survives the wallet hex round trip", () => {
  const hex = encodeReferenceData(CHECKOUT_REF)
  assert.match(hex, /^[0-9a-f]+$/, "wire data must be lowercase hex")
  assert.equal(decodeReferenceData(hex), CHECKOUT_REF)
  assert.ok(hex.length / 2 <= MAX_TX_DATA_BYTES)
})

test("explorer base64 data decodes to the plain-text reference", () => {
  const fromWire = base64OfHex(encodeReferenceData(CHECKOUT_REF))
  assert.equal(decodeBase64Reference(fromWire), CHECKOUT_REF)
})

test("a real non-reference payload is not mistaken for a reference", () => {
  assert.equal(decodeBase64Reference(LIVE_TX_SHAPE.data), null)
  assert.equal(decodeBase64Reference(null), null)
  assert.equal(decodeBase64Reference("not base64!!"), null)
  assert.equal(decodeBase64Reference("AAAA"), null)
})

console.log("\nquote")
const bagLine = {
  offerId: "of-102",
  title: "Red Runner",
  merchant: "Atlas Supply",
  qty: 1,
  unitNim: 39,
  deliveryNim: 3,
}

test("single merchant, single line builds luna", () => {
  const built = buildQuote({
    checkoutRef: CHECKOUT_REF,
    lines: [bagLine],
    merchant: "Atlas Supply",
    recipient: RECIPIENT,
    network: "testnet",
    now: 1_000,
  })
  assert.equal(built.ok, true)
  assert.equal(built.quote.amountMinor, 42 * LUNA_PER_NIM)
  assert.equal(built.quote.deliveryMinor, 3 * LUNA_PER_NIM)
  assert.equal(built.quote.currency, "NIM")
  assert.equal(built.quote.expiresAt, 1_000 + QUOTE_TTL_MS)
})

test("delivery is charged once, not per unit", () => {
  const built = buildQuote({
    checkoutRef: CHECKOUT_REF,
    lines: [{ ...bagLine, qty: 2 }],
    merchant: "Atlas Supply",
    recipient: RECIPIENT,
    network: "testnet",
    now: 0,
  })
  assert.equal(built.ok, true)
  assert.equal(built.quote.amountMinor, 2 * 39 * LUNA_PER_NIM + 3 * LUNA_PER_NIM)
})

test("mixed-merchant bag is refused", () => {
  const built = buildQuote({
    checkoutRef: CHECKOUT_REF,
    lines: [bagLine, { ...bagLine, offerId: "of-501", merchant: "Kite Home" }],
    merchant: "Atlas Supply",
    recipient: RECIPIENT,
    network: "testnet",
    now: 0,
  })
  assert.equal(built.ok, false)
  assert.equal(built.failure.code, "MULTI_MERCHANT")
})

test("multi-line bag for one merchant is refused", () => {
  const built = buildQuote({
    checkoutRef: CHECKOUT_REF,
    lines: [bagLine, { ...bagLine, offerId: "of-201" }],
    merchant: "Atlas Supply",
    recipient: RECIPIENT,
    network: "testnet",
    now: 0,
  })
  assert.equal(built.ok, false)
  assert.equal(built.failure.code, "MULTI_LINE")
})

test("missing or invalid recipient is refused", () => {
  for (const recipient of ["", "NQ0000", "NOTANADDRESS"]) {
    const built = buildQuote({
      checkoutRef: CHECKOUT_REF,
      lines: [bagLine],
      merchant: "Atlas Supply",
      recipient,
      network: "mainnet",
      now: 0,
    })
    assert.equal(built.ok, false, `${recipient || "(blank)"} must not build a quote`)
    assert.equal(built.failure.code, "NO_RECIPIENT")
  }
})

test("empty bag is refused", () => {
  const built = buildQuote({
    checkoutRef: CHECKOUT_REF,
    lines: [],
    merchant: "Atlas Supply",
    recipient: RECIPIENT,
    network: "testnet",
    now: 0,
  })
  assert.equal(built.ok, false)
  assert.equal(built.failure.code, "EMPTY_BAG")
})

test("address checksums from live explorer data validate", () => {
  assert.equal(isValidNimiqAddress(LIVE_TX_SHAPE.receiver_address), true)
  assert.equal(isValidNimiqAddress(RECIPIENT), true)
  assert.equal(isValidNimiqAddress("NQ22U2S1VUGYT5J32RKUH8QATRE2TKTSH642"), false)
  assert.equal(isValidNimiqAddress("NQ22U2S1VUGYT5J32RKUH8QATRE2TKTSH64"), false)
})

function quoteFor(lines, now = Date.now()) {
  const built = buildQuote({
    checkoutRef: CHECKOUT_REF,
    lines,
    merchant: lines[0]?.merchant ?? "Atlas Supply",
    recipient: RECIPIENT,
    network: "testnet",
    now,
  })
  assert.equal(built.ok, true)
  return built.quote
}

test("recheck accepts an unchanged bag and voids on price drift", () => {
  const approved = quoteFor([bagLine])
  assert.deepEqual(recheckQuote(approved, quoteFor([bagLine]), Date.now()), { ok: true })
  const drift = recheckQuote(approved, quoteFor([{ ...bagLine, unitNim: 40 }]), Date.now())
  assert.equal(drift.ok, false)
  assert.equal(drift.reason, "changed")
})

test("recheck voids on recipient drift", () => {
  const now = Date.now()
  const approved = quoteFor([bagLine], now)
  const moved = buildQuote({
    checkoutRef: CHECKOUT_REF,
    lines: [bagLine],
    merchant: "Atlas Supply",
    recipient: SENDER,
    network: "testnet",
    now,
  })
  assert.equal(moved.ok, true)
  const drift = recheckQuote(approved, moved.quote, now)
  assert.equal(drift.ok, false)
  assert.equal(drift.reason, "changed")
})

test("quote expires after 15 minutes", () => {
  const approved = quoteFor([bagLine], 10_000)
  assert.equal(quoteDigest(approved), quoteDigest(quoteFor([bagLine], 10_000)))
  const late = recheckQuote(approved, quoteFor([bagLine], 10_000), 10_000 + QUOTE_TTL_MS)
  assert.equal(late.ok, false)
  assert.equal(late.reason, "expired")
  assert.equal(QUOTE_TTL_MS, 15 * 60 * 1000)
})

console.log("\nverification")
test("endpoints are network-bound", () => {
  assert.equal(EXPLORER_API_BASE.mainnet, "https://v2.nimiqwatch.com/api/v1")
  assert.equal(EXPLORER_API_BASE.testnet, "https://v2.test.nimiqwatch.com/api/v1")
  assert.equal(
    explorerApiUrl("testnet", "ab12"),
    "https://v2.test.nimiqwatch.com/api/v1/transaction/ab12"
  )
  assert.ok(explorerTxUrl("mainnet", "ab12").startsWith("https://nimiq.watch/#"))
})

test("a matching confirmed transaction passes every check", () => {
  const verdict = verifyPaymentShape(ourTx(), expected)
  assert.equal(verdict.ok, true, verdict.checks.filter((c) => !c.ok).map((c) => c.id).join(","))
  assert.equal(verdict.mismatch, false)
  const ids = verdict.checks.map((c) => c.id)
  for (const required of ["found", "hash", "included", "confirmations", "recipient", "value", "reference", "network"]) {
    assert.ok(ids.includes(required), `missing check: ${required}`)
  }
})

test("wrong recipient is a hard mismatch, not a wait", () => {
  const verdict = verifyPaymentShape(
    ourTx({ receiver_address: "NQ08 ACT8 T0FE PTG8 P5RL H2S3 QGXH V15R NVXY" }),
    expected
  )
  assert.equal(verdict.ok, false)
  assert.equal(verdict.mismatch, true)
  assert.equal(verdict.checks.find((c) => c.id === "recipient").ok, false)
})

test("wrong value is a hard mismatch", () => {
  const verdict = verifyPaymentShape(ourTx({ value: 4_000_000 }), expected)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.mismatch, true)
  assert.equal(verdict.checks.find((c) => c.id === "value").ok, false)
})

test("wrong or missing reference data is a hard mismatch", () => {
  for (const data of [null, LIVE_TX_SHAPE.data, base64OfHex(encodeReferenceData("NQM:AAAAAAAA"))]) {
    const verdict = verifyPaymentShape(ourTx({ data }), expected)
    assert.equal(verdict.checks.find((c) => c.id === "reference").ok, false)
    assert.equal(verdict.mismatch, true)
  }
})

test("pending transaction is not ok but not a mismatch", () => {
  const verdict = verifyPaymentShape(ourTx({ confirmations: null, block_height: null }), expected)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.mismatch, false)
})

test("executed false blocks confirmation", () => {
  const verdict = verifyPaymentShape(ourTx({ executed: false }), expected)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.checks.find((c) => c.id === "executed").ok, false)
})

test("too few confirmations blocks confirmation", () => {
  const verdict = verifyPaymentShape(ourTx({ confirmations: REQUIRED_CONFIRMATIONS - 1 }), expected)
  assert.equal(verdict.ok, false)
})

test("unknown sender blocks confirmation", () => {
  const verdict = verifyPaymentShape(ourTx({ sender_address: "NQ77 0000 0000 0000 0000 0000 0000 0000 0001" }), expected)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.mismatch, false)
})

test("a missing transaction fails closed without claiming failure", () => {
  const verdict = verifyPaymentShape(null, expected)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.mismatch, false)
  assert.equal(verdict.checks.find((c) => c.id === "found").ok, false)
})

function fakeFetch(handler) {
  const calls = []
  return {
    calls,
    fetch: async (url) => {
      calls.push(url)
      return handler(url, calls.length)
    },
  }
}

const okBody = (tx) => ({ ok: true, status: 200, json: async () => tx })
const notFound = { ok: false, status: 404, json: async () => ({ message: "Transaction not found" }) }

await asyncTest("polling confirms once confirmations arrive", async () => {
  const { calls, fetch } = fakeFetch((url, n) =>
    n < 3 ? notFound : okBody(ourTx({ confirmations: n < 2 ? null : REQUIRED_CONFIRMATIONS }))
  )
  const outcome = await pollTransaction(expected, {
    fetchImpl: fetch,
    budgetMs: 10_000,
    intervalMs: 1,
    wait: async () => {},
  })
  assert.equal(outcome.state, "confirmed")
  assert.equal(calls.length, 3)
})

await asyncTest("polling stops early on a real mismatch", async () => {
  const { calls, fetch } = fakeFetch(() => okBody(ourTx({ value: 1 })))
  const outcome = await pollTransaction(expected, {
    fetchImpl: fetch,
    budgetMs: 10_000,
    intervalMs: 1,
    wait: async () => {},
  })
  assert.equal(outcome.state, "mismatch")
  assert.equal(calls.length, 1)
})

await asyncTest("exhausted budget reports unconfirmed, never paid", async () => {
  const { fetch } = fakeFetch(() => notFound)
  let nowValue = 0
  const outcome = await pollTransaction(expected, {
    fetchImpl: fetch,
    budgetMs: 1_000,
    intervalMs: 500,
    now: () => nowValue,
    wait: async () => {
      nowValue += 500
    },
  })
  assert.equal(outcome.state, "unconfirmed")
  assert.match(outcome.message, /mainnet/)
})

await asyncTest("network errors report unconfirmed with a reason", async () => {
  const { fetch } = fakeFetch(() => {
    throw new TypeError("Failed to fetch")
  })
  let clock = 0
  const outcome = await pollTransaction(expected, {
    fetchImpl: fetch,
    budgetMs: 1_000,
    intervalMs: 500,
    now: () => clock,
    wait: async () => {
      clock += 500
    },
  })
  assert.equal(outcome.state, "unconfirmed")
  assert.match(outcome.message, /could not reach the explorer/i)
})

await asyncTest("malformed hash never hits the network", async () => {
  const { calls, fetch } = fakeFetch(() => okBody(ourTx()))
  let clock = 0
  const outcome = await pollTransaction({ ...expected, txHash: "zzz" }, {
    fetchImpl: fetch,
    budgetMs: 1_000,
    intervalMs: 500,
    now: () => clock,
    wait: async () => {
      clock += 500
    },
  })
  assert.equal(outcome.state, "unconfirmed")
  assert.equal(calls.length, 0)
})

console.log("\npayment state")
const pendingRecord = {
  checkoutRef: CHECKOUT_REF,
  txHash: "a".repeat(64),
  status: "pending",
  amountMinor: 4_100_000,
  recipient: RECIPIENT,
  network: "mainnet",
  merchant: "Atlas Supply",
  items: [],
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  verifiedAt: null,
  explorerUrl: "https://nimiq.watch/#" + "a".repeat(64),
  note: null,
  checks: null,
}

test("replaying the same record is idempotent", () => {
  assert.deepEqual(mergePayment(null, pendingRecord), pendingRecord)
  assert.deepEqual(mergePayment(pendingRecord, pendingRecord), pendingRecord)
})

test("confirmed is terminal against a replayed pending", () => {
  const confirmed = {
    ...pendingRecord,
    status: "confirmed",
    verifiedAt: "2026-10-20T00:01:00.000Z",
    updatedAt: "2026-10-20T00:01:00.000Z",
  }
  assert.deepEqual(mergePayment(confirmed, pendingRecord), confirmed)
})

test("pending upgrades to failed and keeps the earliest createdAt", () => {
  const later = { ...pendingRecord, status: "failed", updatedAt: "2026-10-20T00:02:00.000Z", createdAt: "2026-10-20T00:00:30.000Z", note: "mismatch" }
  const merged = mergePayment(pendingRecord, later)
  assert.equal(merged.status, "failed")
  assert.equal(merged.createdAt, pendingRecord.createdAt)
})

test("unreadable storage parses to nothing", () => {
  assert.deepEqual(parsePayments(null), [])
  assert.deepEqual(parsePayments("not json"), [])
  assert.deepEqual(parsePayments("{}"), [])
  assert.deepEqual(parsePayments("[{\"checkoutRef\":1}]"), [])
})

console.log("\nsummary")
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} failed\n`)
  for (const failure of failures) console.error(`${failure.name}: ${failure.error.stack}\n`)
  process.exitCode = 1
} else {
  console.log(`All ${passed} checks passed.\n`)
}
