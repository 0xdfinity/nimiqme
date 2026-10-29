/**
 * Payment quotes.
 *
 * The approval screen never binds to the live bag: it binds to an immutable
 * quote captured when the screen is painted. Before the wallet is opened the
 * quote is rebuilt from the bag and compared, so a bag edited in another tab,
 * an expired approval screen, or a recipient that no longer resolves can never
 * produce a transaction for something the user did not approve.
 *
 * This module is deliberately dependency-free and side-effect-free so it can be
 * unit tested outside a browser.
 */

/** 1 NIM = 100,000 luna. The chain only ever moves integer luna. */
export const LUNA_PER_NIM = 100_000

/** An approval is valid for 15 minutes, then must be re-confirmed. */
export const QUOTE_TTL_MS = 15 * 60 * 1000

export type ExpectedNetwork = "mainnet" | "testnet"

export type QuoteItem = {
  offerId: string
  title: string
  merchant: string
  qty: number
  unitLuna: number
  lineLuna: number
}

export type PaymentQuote = {
  checkoutRef: string
  amountMinor: number
  /** Merchant delivery fee folded into amountMinor; charged once per line, not per unit. */
  deliveryMinor: number
  currency: "NIM"
  merchant: string
  recipient: string
  network: ExpectedNetwork
  items: QuoteItem[]
  createdAt: number
  expiresAt: number
}

export type QuoteBagLine = {
  offerId: string
  title: string
  merchant: string
  qty: number
  unitNim: number
  /** Delivery for the merchant, charged once for the whole line. */
  deliveryNim?: number
}

export type QuoteFailure =
  | { code: "EMPTY_BAG"; message: string }
  | { code: "MULTI_MERCHANT"; message: string }
  | { code: "MULTI_LINE"; message: string }
  | { code: "NO_RECIPIENT"; message: string }
  | { code: "BAD_AMOUNT"; message: string }

export type QuoteResult = { ok: true; quote: PaymentQuote } | { ok: false; failure: QuoteFailure }

function decimalToLuna(nim: number): number {
  if (!Number.isFinite(nim) || nim < 0) return -1
  return Math.round(nim * LUNA_PER_NIM)
}

/** Normalises an address for comparison and for the wallet: `NQAB1234…`, no spaces. */
export function normalizeAddress(address: string): string {
  return address.replace(/\s+/g, "").toUpperCase()
}

/**
 * Checks a Nimiq IBAN: `NQ`, two check digits, then 32 base32 characters, with
 * the mod-97 remainder equal to 1 (ISO 7064, digits moved to the end).
 */
export function isValidNimiqAddress(address: string): boolean {
  const value = normalizeAddress(address)
  if (!/^NQ[0-9]{2}[0-9A-Z]{32}$/.test(value)) return false
  const rearranged = `${value.slice(4)}${value.slice(0, 4)}`
  let digits = ""
  for (const char of rearranged) {
    if (char >= "0" && char <= "9") digits += char
    else if (char >= "A" && char <= "Z") digits += String(char.charCodeAt(0) - 55)
    else return false
  }
  let remainder = 0
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97
  return remainder === 1
}

/**
 * Builds the quote a payment is bound to.
 *
 * Enforces the two hard rules of this slice: one merchant and one line per
 * checkout. A mixed bag is refused here rather than silently paying one
 * merchant with another merchant's money.
 */
export function buildQuote(input: {
  checkoutRef: string
  lines: QuoteBagLine[]
  merchant: string
  recipient: string
  network: ExpectedNetwork
  now: number
}): QuoteResult {
  const { checkoutRef, lines, merchant, network, now } = input

  if (!lines.length) {
    return {
      ok: false,
      failure: { code: "EMPTY_BAG", message: "There is nothing in the bag to pay for." },
    }
  }

  const merchants = [...new Set(lines.map((line) => line.merchant))]
  if (merchants.length > 1) {
    return {
      ok: false,
      failure: {
        code: "MULTI_MERCHANT",
        message: `This bag mixes ${merchants.length} merchants (${merchants.join(", ")}). Each merchant is paid separately, so remove everything except one merchant's item.`,
      },
    }
  }

  if (lines.length > 1) {
    return {
      ok: false,
      failure: {
        code: "MULTI_LINE",
        message: `Checkout takes one item at a time. This bag has ${lines.length} lines; keep one and pay the others separately.`,
      },
    }
  }

  const recipient = normalizeAddress(input.recipient)
  if (!recipient) {
    return {
      ok: false,
      failure: {
        code: "NO_RECIPIENT",
        message: `${merchant} has no receiving address connected on ${network}. Nothing can be charged.`,
      },
    }
  }
  if (!isValidNimiqAddress(recipient)) {
    return {
      ok: false,
      failure: {
        code: "NO_RECIPIENT",
        message: `${merchant}'s receiving address is not a valid Nimiq address on ${network}. Nothing can be charged.`,
      },
    }
  }

  const items: QuoteItem[] = []
  let goodsMinor = 0
  let deliveryMinor = 0
  for (const line of lines) {
    const unitLuna = decimalToLuna(line.unitNim)
    if (unitLuna < 0 || !Number.isInteger(line.qty) || line.qty <= 0) {
      return {
        ok: false,
        failure: { code: "BAD_AMOUNT", message: "An item price is not a usable amount." },
      }
    }
    const lineDelivery = decimalToLuna(line.deliveryNim ?? 0)
    if (lineDelivery < 0) {
      return {
        ok: false,
        failure: { code: "BAD_AMOUNT", message: "The delivery fee is not a usable amount." },
      }
    }
    const lineLuna = unitLuna * line.qty
    goodsMinor += lineLuna
    deliveryMinor += lineDelivery
    items.push({
      offerId: line.offerId,
      title: line.title,
      merchant: line.merchant,
      qty: line.qty,
      unitLuna,
      lineLuna,
    })
  }

  const amountMinor = goodsMinor + deliveryMinor
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return {
      ok: false,
      failure: { code: "BAD_AMOUNT", message: "The checkout total is not a valid amount." },
    }
  }

  return {
    ok: true,
    quote: {
      checkoutRef,
      amountMinor,
      deliveryMinor,
      currency: "NIM",
      merchant,
      recipient,
      network,
      items,
      createdAt: now,
      expiresAt: now + QUOTE_TTL_MS,
    },
  }
}

/**
 * Stable identity of everything the user approved. Excludes the reference and
 * the timestamps, because those change per attempt and per refresh.
 */
export function quoteDigest(
  quote: Pick<
    PaymentQuote,
    "amountMinor" | "deliveryMinor" | "currency" | "merchant" | "recipient" | "network" | "items"
  >
): string {
  const lines = [...quote.items]
    .sort((a, b) => a.offerId.localeCompare(b.offerId))
    .map((item) => `${item.offerId}:${item.qty}:${item.unitLuna}`)
    .join(",")
  return [
    quote.currency,
    quote.amountMinor,
    quote.deliveryMinor,
    quote.merchant,
    quote.recipient,
    quote.network,
    lines,
  ].join("|")
}

export type QuoteDrift =
  | { ok: true }
  | {
      ok: false
      reason: "expired" | "changed"
      message: string
    }

/**
 * Re-checks the captured quote against the live bag before signing.
 * Any drift voids the approval instead of silently re-pricing it.
 */
export function recheckQuote(
  approved: PaymentQuote,
  current: PaymentQuote,
  now: number
): QuoteDrift {
  if (now >= approved.expiresAt) {
    return {
      ok: false,
      reason: "expired",
      message: `This approval expired after ${QUOTE_TTL_MS / 60000} minutes. Review the total again before paying.`,
    }
  }
  if (quoteDigest(approved) !== quoteDigest(current)) {
    return {
      ok: false,
      reason: "changed",
      message: "The bag, price, or receiving address changed after this approval was shown. Nothing was sent — review the new total.",
    }
  }
  return { ok: true }
}

export function isQuoteExpired(quote: PaymentQuote, now: number = Date.now()): boolean {
  return now >= quote.expiresAt
}

export function lunaToNim(luna: number): number {
  return luna / LUNA_PER_NIM
}
