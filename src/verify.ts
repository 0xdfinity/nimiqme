import { decodeReferenceData, encodeReferenceData } from "./reference.ts"
import { normalizeAddress, type ExpectedNetwork } from "./quote.ts"

/** Public Nimiq JSON-RPC endpoints, selected by the quoted order network. */
export const NIMIQ_RPC_URL: Record<ExpectedNetwork, string> = { mainnet: "https://rpc.nimiqwatch.com", testnet: "https://rpc.testnet.nimiqwatch.com" }
export const EXPLORER_PAGE_BASE: Record<ExpectedNetwork, string> = { mainnet: "https://nimiq.watch/#", testnet: "https://test.nimiq.watch/#" }
export const REQUIRED_CONFIRMATIONS = 1
export const POLL_BUDGET_MS = 90_000
export const POLL_INTERVAL_MS = 4_000
export const MAX_POLL_ATTEMPTS = 40
const REQUEST_TIMEOUT_MS = 8_000

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
export type ExplorerTransaction = { block_height: number | null; hash: string | null; sender_address: string | null; receiver_address: string | null; value: number | null; fee: number | null; executed: boolean | null; timestamp: number | null; validity_start_height: number | null; data: string | null; confirmations: number | null }
export type ExpectedPayment = { txHash: string; checkoutRef: string; amountMinor: number; recipient: string; network: ExpectedNetwork; sender?: string }
export type CheckId = "found" | "hash" | "included" | "confirmations" | "executed" | "recipient" | "value" | "reference" | "network" | "sender"
export type Check = { id: CheckId; label: string; ok: boolean; detail: string }
export type ShapeVerdict = { ok: boolean; mismatch: boolean; checks: Check[] }
export type Lookup = { kind: "found"; tx: ExplorerTransaction } | { kind: "not_found" } | { kind: "error"; message: string }
const TX_HASH_PATTERN = /^[0-9a-f]{64}$/
function asString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null }
function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10)
  return null
}
function asBool(value: unknown): boolean | null { return typeof value === "boolean" ? value : null }
export function explorerTxUrl(network: ExpectedNetwork, txHash: string): string { return `${EXPLORER_PAGE_BASE[network]}${encodeURIComponent(txHash)}` }

/** Looks up the order on its own network and accepts only the observed tx schema. */
export async function lookupTransaction(network: ExpectedNetwork, txHash: string, options: { fetchImpl?: FetchLike; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Lookup> {
  if (!TX_HASH_PATTERN.test(txHash.toLowerCase())) return { kind: "error", message: "The wallet returned a malformed transaction hash." }
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)
  if (!fetchImpl) return { kind: "error", message: "This browser cannot reach the Nimiq RPC node." }
  const controller = new AbortController(), timer = globalThis.setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS)
  const abort = () => controller.abort(); options.signal?.addEventListener("abort", abort)
  try {
    const response = await fetchImpl(NIMIQ_RPC_URL[network], { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "getTransactionByHash", params: [txHash], id: 1 }), signal: controller.signal })
    let body: unknown
    try { body = await response.json() } catch { return { kind: "error", message: `Nimiq RPC replied with unreadable data (HTTP ${response.status}).` } }
    if (!response.ok) return { kind: "error", message: `Nimiq RPC replied HTTP ${response.status}.` }
    if (typeof body !== "object" || body === null || !("result" in body)) return { kind: "error", message: "Nimiq RPC returned an unexpected transaction schema." }
    const envelope = body as { result?: unknown; error?: { message?: string } }
    if (envelope.error) { const message = envelope.error.message ?? "RPC lookup failed."; if (/not found|unknown transaction|no transaction/i.test(message)) return { kind: "not_found" }; return { kind: "error", message: `Nimiq RPC: ${message}` } }
    const result = envelope.result
    if (typeof result !== "object" || result === null || !("data" in result)) return { kind: "error", message: "Nimiq RPC returned an unexpected transaction schema." }
    const tx = (result as { data?: unknown }).data
    if (tx === null || tx === undefined) return { kind: "not_found" }
    if (typeof tx !== "object") return { kind: "error", message: "Nimiq RPC returned an unexpected transaction schema." }
    const row = tx as Record<string, unknown>
    const hash = asString(row.hash)
    if (!hash) return { kind: "error", message: "Nimiq RPC replied without a transaction hash." }
    const dataHex = asString(row.recipientData) ?? asString(row.senderData)
    const transaction: ExplorerTransaction = { block_height: asInt(row.blockNumber), hash, sender_address: asString(row.from), receiver_address: asString(row.to), value: asInt(row.value), fee: asInt(row.fee), executed: asBool(row.executionResult), timestamp: asInt(row.timestamp), validity_start_height: asInt(row.validityStartHeight), data: dataHex, confirmations: asInt(row.confirmations) }
    if (transaction.block_height === null || transaction.executed === null || transaction.receiver_address === null || transaction.value === null || transaction.confirmations === null || !dataHex) return { kind: "error", message: "Nimiq RPC returned an incomplete transaction schema." }
    if (!/^(?:[0-9a-f]{2})*$/i.test(dataHex)) return { kind: "error", message: "Nimiq RPC returned transaction data that was not hexadecimal." }
    return { kind: "found", tx: transaction }
  } catch (error) { if (options.signal?.aborted) return { kind: "error", message: "The verification check was cancelled." }; return { kind: "error", message: `Could not reach Nimiq RPC: ${error instanceof Error ? error.message : "The node did not answer."}` } }
  finally { globalThis.clearTimeout(timer); options.signal?.removeEventListener("abort", abort) }
}
function check(id: CheckId, label: string, ok: boolean, detail: string): Check { return { id, label, ok, detail } }
function shorten(value: string): string { return !value ? "nothing" : value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value }
function labelFor(id: CheckId): string {
  switch (id) {
    case "hash": return "Hash matches"
    case "included": return "Included in a block"
    case "confirmations": return `${REQUIRED_CONFIRMATIONS}+ confirmations`
    case "executed": return "Executed by the node"
    case "recipient": return "Paid to the merchant"
    case "value": return "Amount matches"
    case "reference": return "Reference in data"
    case "sender": return "Sent from your account"
    default: return String(id)
  }
}
export function verifyPaymentShape(tx: ExplorerTransaction | null, expected: ExpectedPayment): ShapeVerdict {
  const checks: Check[] = [check("found", "Transaction exists", Boolean(tx), tx ? "Returned by Nimiq RPC." : "Not found yet.")]
  if (!tx) return { ok: false, mismatch: false, checks: checks.concat((["hash", "included", "confirmations", "executed", "recipient", "value", "reference"] as CheckId[]).map((id) => check(id, labelFor(id), false, "Waiting for the transaction.")), check("network", `On ${expected.network}`, true, `Looked up on ${expected.network} RPC.`), ...(expected.sender ? [check("sender", "Sent from your account", false, "Waiting for the transaction.")] : [])) }
  const returnedHash = (tx.hash ?? "").toLowerCase()
  checks.push(check("hash", "Hash matches", TX_HASH_PATTERN.test(returnedHash) && returnedHash === expected.txHash.toLowerCase(), `RPC ${shorten(returnedHash)} for ${shorten(expected.txHash)}.`))
  const included = typeof tx.block_height === "number" && tx.block_height > 0
  checks.push(check("included", "Included in a block", included, included ? `Block ${tx.block_height}.` : "No block number returned."))
  const confirmations = typeof tx.confirmations === "number" ? tx.confirmations : null
  checks.push(check("confirmations", `${REQUIRED_CONFIRMATIONS}+ confirmations`, confirmations !== null && confirmations >= REQUIRED_CONFIRMATIONS, confirmations === null ? "RPC reported no confirmations." : `${confirmations} confirmation(s).`))
  checks.push(check("executed", "Executed by the node", tx.executed === true, tx.executed === true ? "executionResult is true." : "executionResult was not true."))
  const recipient = normalizeAddress(expected.recipient), actualRecipient = tx.receiver_address ? normalizeAddress(tx.receiver_address) : ""
  checks.push(check("recipient", `Paid to ${shorten(recipient)}`, actualRecipient === recipient, actualRecipient ? `Received ${shorten(actualRecipient)}.` : "No recipient returned."))
  checks.push(check("value", `Amount is ${expected.amountMinor} luna`, tx.value === expected.amountMinor, typeof tx.value === "number" ? `Received ${tx.value} luna.` : "No value returned."))
  let onChainRef: string | null = null
  try { onChainRef = tx.data ? decodeReferenceData(tx.data) : null } catch { onChainRef = null }
  let expectedHex: string | null = null
  try { expectedHex = encodeReferenceData(expected.checkoutRef) } catch { expectedHex = null }
  const dataMatches = Boolean(tx.data && expectedHex && tx.data.replace(/\s+/g, "").toLowerCase() === expectedHex.toLowerCase())
  checks.push(check("reference", `Reference ${expected.checkoutRef}`, dataMatches, onChainRef ? `RPC hex decodes to ${onChainRef}.` : "recipientData/senderData hex did not match this reference."))
  checks.push(check("network", `On ${expected.network}`, true, `Looked up on ${expected.network} RPC.`))
  if (expected.sender) { const sender = normalizeAddress(expected.sender), actual = tx.sender_address ? normalizeAddress(tx.sender_address) : ""; checks.push(check("sender", "Sent from your account", actual === sender, actual ? `Received from ${shorten(actual)}.` : "No sender returned.")) }
  const mismatch = checks.some((item) => ["recipient", "value", "reference", "hash"].includes(item.id) && !item.ok) || tx.executed === false
  const requiredForPaid = ["hash", "included", "confirmations", "executed", "recipient", "value", "reference"]
  const ok = requiredForPaid.every((id) => checks.some((item) => item.id === id && item.ok))
  return { ok, mismatch, checks }
}
export type PollOutcome = { state: "confirmed"; verdict: ShapeVerdict } | { state: "mismatch"; verdict: ShapeVerdict; message: string } | { state: "unconfirmed"; message: string; verdict: ShapeVerdict | null } | { state: "cancelled" }
export async function pollTransaction(expected: ExpectedPayment, options: { fetchImpl?: FetchLike; signal?: AbortSignal; budgetMs?: number; intervalMs?: number; now?: () => number; wait?: (ms: number, signal?: AbortSignal) => Promise<void>; onAttempt?: (attempt: number, lookup: Lookup) => void } = {}): Promise<PollOutcome> {
  const budgetMs = options.budgetMs ?? POLL_BUDGET_MS, intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
  const now = options.now ?? (() => Date.now()), started = now()
  const wait = options.wait ?? ((ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => { const timer = globalThis.setTimeout(resolve, ms); signal?.addEventListener("abort", () => { globalThis.clearTimeout(timer); resolve() }) }))
  let attempt = 0, lastVerdict: ShapeVerdict | null = null, lastMessage = "Nimiq RPC has not returned this transaction yet."
  while (now() - started < budgetMs && attempt < MAX_POLL_ATTEMPTS) {
    if (options.signal?.aborted) return { state: "cancelled" }
    attempt++
    const lookup = await lookupTransaction(expected.network, expected.txHash, { fetchImpl: options.fetchImpl, signal: options.signal })
    options.onAttempt?.(attempt, lookup)
    if (lookup.kind === "error") lastMessage = lookup.message
    else if (lookup.kind === "not_found") { lastMessage = `No transaction with that hash on ${expected.network} yet.`; lastVerdict = verifyPaymentShape(null, expected) }
    else {
      const verdict = verifyPaymentShape(lookup.tx, expected); lastVerdict = verdict
      if (verdict.ok) return { state: "confirmed", verdict }
      lastMessage = verdict.mismatch ? "The RPC response does not confirm the expected payment fields yet. This order remains verifying." : "Transaction found, waiting for inclusion or confirmations."
    }
    if (options.signal?.aborted) return { state: "cancelled" }
    await wait(intervalMs, options.signal)
  }
  return options.signal?.aborted ? { state: "cancelled" } : { state: "unconfirmed", message: lastMessage, verdict: lastVerdict }
}
