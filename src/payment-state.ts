/**
 * Persisted payment state.
 *
 * A wallet returning a hash is not a payment: it is a *pending* payment. This
 * store keeps that distinction across reloads, keyed by checkout reference and
 * indexed by transaction hash, so a user who closes Nimiq Pay while a
 * transaction is still confirming comes back to `pending` — not to a false
 * `Paid`, and not to a bag that invites them to pay twice.
 *
 * `confirmed` and `failed` are terminal; a late `pending` write can never
 * downgrade them, which makes every merge idempotent.
 */

import type { Check, CheckId } from "./verify.ts"

export type PaymentStatus = "pending" | "verifying" | "confirmed" | "failed"

export type PaymentRecord = {
  checkoutRef: string
  txHash: string
  status: PaymentStatus
  amountMinor: number
  recipient: string
  network: "mainnet" | "testnet"
  merchant: string
  items: { offerId: string; title: string; merchant: string; qty: number; unitLuna: number }[]
  createdAt: string
  updatedAt: string
  verifiedAt: string | null
  explorerUrl: string
  /** Why a payment is not confirmed, in user words. */
  note: string | null
  checks: { id: CheckId; label: string; ok: boolean; detail: string }[] | null
}

const PAYMENTS_KEY = "nimiqme-payments-v1"
const MAX_HISTORY = 24

const TERMINAL: PaymentStatus[] = ["confirmed", "failed"]

/**
 * Pure merge used for every write. Three rules make it idempotent:
 *   1. no stored record  -> take the incoming one;
 *   2. stored is terminal (`confirmed`/`failed`) and incoming is `pending`
 *      -> keep the stored record untouched, so a replayed send can never
 *         downgrade a verified payment back to pending;
 *   3. otherwise -> incoming fields win, but the reference and the earliest
 *      creation time are preserved, and a missing `verifiedAt`/`checks` falls
 *      back to what is already stored.
 * Applying the same record twice returns an equal record.
 */
export function mergePayment(
  existing: PaymentRecord | null,
  incoming: PaymentRecord
): PaymentRecord {
  if (!existing) return incoming

  if (TERMINAL.includes(existing.status) && (incoming.status === "pending" || incoming.status === "verifying")) return existing

  return {
    ...existing,
    ...incoming,
    checkoutRef: existing.checkoutRef,
    createdAt:
      Date.parse(incoming.createdAt) < Date.parse(existing.createdAt)
        ? incoming.createdAt
        : existing.createdAt,
    verifiedAt: incoming.verifiedAt ?? existing.verifiedAt,
    checks: incoming.checks ?? existing.checks,
    note: incoming.status === "pending" || incoming.status === "verifying" ? (incoming.note ?? existing.note) : incoming.note,
  }
}

function isValidRecord(value: unknown): value is PaymentRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<PaymentRecord>
  return (
    typeof record.checkoutRef === "string" &&
    typeof record.txHash === "string" &&
    (record.status === "pending" || record.status === "verifying" || record.status === "confirmed" || record.status === "failed") &&
    typeof record.amountMinor === "number" &&
    typeof record.recipient === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  )
}

export function parsePayments(raw: string | null): PaymentRecord[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidRecord).map((record) => ({
      ...record,
      items: Array.isArray(record.items) ? record.items : [],
      checks: Array.isArray(record.checks) ? record.checks : null,
      verifiedAt: record.verifiedAt ?? null,
      explorerUrl: typeof record.explorerUrl === "string" ? record.explorerUrl : "",
      note: typeof record.note === "string" ? record.note : null,
    }))
  } catch {
    return []
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

export function readPayments(): PaymentRecord[] {
  const store = storage()
  if (!store) return []
  return parsePayments(store.getItem(PAYMENTS_KEY))
}

function writePayments(records: PaymentRecord[]): void {
  const store = storage()
  if (!store) throw new Error("This device will not save payment state.")
  store.setItem(PAYMENTS_KEY, JSON.stringify(records))
}

/** Idempotent upsert by checkout reference, keeping the hash index intact. */
export function savePayment(record: PaymentRecord): PaymentRecord {
  const all = readPayments()
  const existing = all.find((item) => item.checkoutRef === record.checkoutRef) || null
  const merged = mergePayment(existing, record)
  const next = [merged, ...all.filter((item) => item.checkoutRef !== record.checkoutRef)]
    // A hash must never map to two references.
    .filter((item, index, list) => list.findIndex((other) => other.txHash === item.txHash) === index)
    .slice(0, MAX_HISTORY)
  writePayments(next)
  return merged
}

export function findPaymentByRef(checkoutRef: string): PaymentRecord | null {
  return readPayments().find((record) => record.checkoutRef === checkoutRef) ?? null
}

export function findPaymentByHash(txHash: string): PaymentRecord | null {
  const needle = txHash.toLowerCase()
  return readPayments().find((record) => record.txHash.toLowerCase() === needle) ?? null
}

export type PaymentPatch = {
  status: PaymentStatus
  note?: string | null
  checks?: Check[] | null
  verifiedAt?: string | null
}

/** Applies a status change to a stored payment. Returns null when unknown. */
export function patchPayment(checkoutRef: string, patch: PaymentPatch): PaymentRecord | null {
  const existing = findPaymentByRef(checkoutRef)
  if (!existing) return null
  if (TERMINAL.includes(existing.status) && (patch.status === "pending" || patch.status === "verifying")) return existing
  return savePayment({
    ...existing,
    status: patch.status,
    note: patch.note === undefined ? existing.note : patch.note,
    checks: patch.checks === undefined ? existing.checks : patch.checks,
    verifiedAt: patch.verifiedAt === undefined ? existing.verifiedAt : patch.verifiedAt,
    updatedAt: new Date().toISOString(),
  })
}
