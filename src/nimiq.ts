import { getHostNetwork, init, NimiqProviderError, type NimiqProvider } from "@nimiq/mini-app-sdk"
import { merchantByName } from "./catalog"
import { encodeReferenceData } from "./reference"
import { LUNA_PER_NIM, normalizeAddress, type ExpectedNetwork } from "./quote"

export type WalletState =
  | { kind: "unknown" }
  | { kind: "absent" }
  | { kind: "ready"; accounts: string[]; network: ExpectedNetwork | null; label: string }
  | { kind: "denied"; message: string }

export type BalanceState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; address: string; luna: number; nim: number }
  | { kind: "error"; message: string }

export type PaymentCode =
  | "NOT_IN_PAY"
  | "NO_ACCOUNT"
  | "NO_RECIPIENT"
  | "INSUFFICIENT"
  | "DECLINED"
  | "INVALID"
  | "SUBMITTED_UNKNOWN"
  | "NETWORK"
  | "UNSUPPORTED"
  | "UNKNOWN"

export class PaymentError extends Error {
  readonly code: PaymentCode

  constructor(code: PaymentCode, message: string) {
    super(message)
    this.name = "PaymentError"
    this.code = code
  }
}

/**
 * Whether the outcome of a send is knowable. Anything that happens *after* the
 * wallet may have broadcast the transaction is `aftermath` — the app must not
 * claim nothing was charged, and must not resend.
 */
export type FailureStage = "before_send" | "aftermath"

export { LUNA_PER_NIM }

const CONFIGURED_STORE = String(import.meta.env.VITE_STORE_ADDRESS ?? "").trim()

/** Vite inlines `VITE_*` keys; per-merchant keys are built from slugs. */
function envValue(key: string): string {
  const env = import.meta.env as Record<string, string | boolean | undefined>
  return String(env[key] ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase()
}

let providerPromise: Promise<NimiqProvider> | null = null

export function hostNetwork(): ExpectedNetwork | null {
  return getHostNetwork() ?? null
}

export function networkLabel(network: ExpectedNetwork | null = hostNetwork()): string {
  if (network === "testnet") return "Nimiq testnet"
  if (network === "mainnet") return "Nimiq mainnet"
  return "Nimiq"
}

/**
 * Per-merchant receiving address.
 *
 * Order of precedence: `VITE_MERCHANT_ADDRESS_<SLUG>`, then the catalog entry,
 * then the legacy `VITE_STORE_ADDRESS` for single-store builds, then — on
 * testnet only — the shared demo wallet. A merchant with no mainnet address is
 * reported as unconfigured so checkout can block instead of routing money to an
 * unrelated wallet.
 */
export function merchantRecipient(
  merchantName: string,
  network: ExpectedNetwork | null
): {
  address: string
  source: "env" | "catalog" | "store_env" | "none"
} {
  const merchant = merchantByName(merchantName)
  const fromEnv = merchant
    ? envValue(`VITE_MERCHANT_ADDRESS_${merchant.slug.replace(/-/g, "_").toUpperCase()}`)
    : ""
  if (fromEnv) return { address: fromEnv, source: "env" }

  const fromCatalog = merchant?.addresses[network ?? "mainnet"]
  if (fromCatalog) return { address: normalizeAddress(fromCatalog), source: "catalog" }

  if (CONFIGURED_STORE) return { address: normalizeAddress(CONFIGURED_STORE), source: "store_env" }

  return { address: "", source: "none" }
}

export function hasConfiguredStore(): boolean {
  return Boolean(CONFIGURED_STORE)
}

export function formatAddress(address: string): string {
  const clean = normalizeAddress(address)
  return clean.replace(/(.{4})/g, "$1 ").trim()
}

export function shortAddress(address: string): string {
  const clean = normalizeAddress(address)
  return clean.length > 12 ? `${clean.slice(0, 6)}…${clean.slice(-4)}` : clean
}

export function formatNim(luna: number): string {
  const nim = luna / LUNA_PER_NIM
  return `${nim.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 5 })} NIM`
}

async function getProvider(): Promise<NimiqProvider> {
  if (providerPromise) return providerPromise
  providerPromise = init({ timeout: 5_000 })
  return providerPromise
}

function providerErrorMessage(error: unknown, fallback: string): string {
  if (NimiqProviderError.is(error)) return error.message || fallback
  return error instanceof Error ? error.message : fallback
}

export async function walletState(): Promise<WalletState> {
  if (typeof window === "undefined" || !window.nimiq) return { kind: "absent" }
  try {
    const provider = await getProvider()
    const accounts = await provider.listAccounts()
    return {
      kind: "ready",
      accounts: Array.isArray(accounts) ? accounts.filter(Boolean) : [],
      network: hostNetwork(),
      label: networkLabel(),
    }
  } catch (error) {
    if (NimiqProviderError.is(error) && error.type === "PERMISSION_DENIED") {
      return { kind: "denied", message: "Wallet access was declined." }
    }
    return { kind: "denied", message: providerErrorMessage(error, "The wallet did not answer.") }
  }
}

/**
 * Reads a real balance from the host wallet.
 * `getBalance` accepts any address and does not need account access.
 */
export async function fetchBalance(address: string): Promise<BalanceState> {
  const target = normalizeAddress(address)
  if (!target) return { kind: "error", message: "No address to read." }
  if (typeof window === "undefined" || !window.nimiq) {
    return { kind: "error", message: "Balances need the Nimiq Pay wallet." }
  }
  try {
    const provider = await getProvider()
    if (typeof provider.getBalance !== "function") {
      return {
        kind: "error",
        message: "This Nimiq Pay version cannot read balances. Update the app and try again.",
      }
    }
    const balance = await provider.getBalance(target)
    if (typeof balance !== "number" || !Number.isFinite(balance) || balance < 0) {
      return { kind: "error", message: "The wallet returned an unreadable balance." }
    }
    return { kind: "ready", address: target, luna: balance, nim: balance / LUNA_PER_NIM }
  } catch (error) {
    return { kind: "error", message: providerErrorMessage(error, "The balance lookup failed.") }
  }
}

export type SendRequest = {
  recipient: string
  amountMinor: number
  checkoutRef: string
}

export type SendResult = {
  txHash: string
  recipient: string
  amountMinor: number
  checkoutRef: string
  sender: string
  network: ExpectedNetwork | null
}

/**
 * True when the host's reply means the transaction may already be on its way,
 * so the caller must verify rather than report a clean failure.
 */
function isAftermath(code: PaymentCode): boolean {
  return code === "SUBMITTED_UNKNOWN" || code === "NETWORK"
}

export function failureStage(code: PaymentCode): FailureStage {
  return isAftermath(code) ? "aftermath" : "before_send"
}

function paymentError(error: unknown): PaymentError {
  if (error instanceof PaymentError) return error
  if (NimiqProviderError.is(error)) {
    if (error.type === "PERMISSION_DENIED") {
      // Declined in the wallet prompt: the host did not sign, so nothing left the wallet.
      return new PaymentError("DECLINED", "You declined the request in Nimiq Pay. Nothing was sent.")
    }
    if (error.type === "INVALID_TRANSACTION") {
      return new PaymentError("INVALID", "The wallet rejected the transaction. Nothing was sent.")
    }
    if (error.type === "NETWORK_ERROR") {
      // The host could not reach the network. That does NOT prove the
      // transaction never left — it may already be broadcast. Say so.
      return new PaymentError(
        "NETWORK",
        "The wallet could not confirm the network accepted the transaction. It may still be on chain — check it below before paying again."
      )
    }
    if (error.type === "TRANSACTION_OUTCOME_UNKNOWN") {
      return new PaymentError(
        "SUBMITTED_UNKNOWN",
        "The wallet could not tell whether this transaction went through. Check it before paying again."
      )
    }
    return new PaymentError("UNKNOWN", error.message || "The wallet did not complete the payment.")
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/reject|denied|declin|cancel/i.test(message)) {
    return new PaymentError("DECLINED", "You declined the request in Nimiq Pay. Nothing was sent.")
  }
  return new PaymentError("UNKNOWN", message || "The wallet did not complete the payment.")
}

/**
 * Signs and submits one payment. Returns a hash — which is a *pending* payment,
 * never a confirmed one. Confirmation happens in verify.ts.
 */
export async function sendPayment(request: SendRequest): Promise<SendResult> {
  const recipient = normalizeAddress(request.recipient)
  if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0) {
    throw new PaymentError("INVALID", "The checkout amount is not a valid luna value.")
  }
  if (!recipient) {
    throw new PaymentError("NO_RECIPIENT", "This merchant has no receiving address. Nothing was sent.")
  }
  if (typeof window === "undefined" || !window.nimiq) {
    throw new PaymentError(
      "NOT_IN_PAY",
      "Payments run inside Nimiq Pay. Open this page in the Nimiq Pay Mini Apps browser."
    )
  }

  try {
    const provider = await getProvider()
    const accounts = await provider.listAccounts()
    const account = Array.isArray(accounts) ? accounts.find(Boolean) : undefined
    if (!account) {
      throw new PaymentError("NO_ACCOUNT", "Nimiq Pay did not share an account. Nothing was sent.")
    }

    if (typeof provider.sendBasicTransactionWithData !== "function") {
      throw new PaymentError(
        "UNSUPPORTED",
        "This Nimiq Pay version cannot attach an order reference to a payment. Update the app."
      )
    }

    const balance = await provider.getBalance(account).catch(() => null)
    if (typeof balance === "number" && Number.isFinite(balance) && balance < request.amountMinor) {
      throw new PaymentError(
        "INSUFFICIENT",
        `This account holds ${formatNim(balance)}, below the ${formatNim(request.amountMinor)} total. Add NIM in Nimiq Pay and retry.`
      )
    }

    const txHash = await provider.sendBasicTransactionWithData({
      recipient,
      value: request.amountMinor,
      // Plain text `NQM:XXXXXXXX` hex-encoded for the wallet API.
      data: encodeReferenceData(request.checkoutRef),
    })

    if (typeof txHash !== "string" || !/^[0-9a-f]{64}$/i.test(txHash.trim())) {
      // A submission was attempted but no usable hash came back: outcome unknown.
      throw new PaymentError(
        "SUBMITTED_UNKNOWN",
        "The wallet accepted the request but returned no transaction hash. Check the wallet history before paying again."
      )
    }

    return {
      txHash: txHash.trim(),
      recipient,
      amountMinor: request.amountMinor,
      checkoutRef: request.checkoutRef,
      sender: normalizeAddress(account),
      network: hostNetwork(),
    }
  } catch (error) {
    throw paymentError(error)
  }
}
