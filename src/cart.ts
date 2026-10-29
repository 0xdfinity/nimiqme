import { offerById, type Offer } from "./catalog"

export type CartLine = { offerId: string; qty: number }

export type QuoteLine = {
  offer: Offer
  qty: number
  lineTotal: number
}

export type Quote = {
  lines: QuoteLine[]
  itemCount: number
  subtotal: number
  delivery: number
  total: number
  merchants: string[]
  dropped: number
  /** True when this bag can be turned into a payment quote at all. */
  payable: boolean
  /** Why the bag is not payable, in user words. Empty when payable. */
  blockedReason: string
}

const CART_KEY = "nimiqme-bag-v1"

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    throw new Error("This device will not save the bag.")
  }
}

export function readCart(): CartLine[] {
  const raw = readJson<unknown>(CART_KEY, [])
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (line): line is CartLine =>
        Boolean(line) &&
        typeof line === "object" &&
        typeof (line as CartLine).offerId === "string" &&
        Number.isInteger((line as CartLine).qty) &&
        (line as CartLine).qty > 0
    )
    .map((line) => ({ offerId: line.offerId, qty: Math.min(line.qty, 9) }))
}

export function writeCart(lines: CartLine[]): void {
  writeJson(CART_KEY, lines)
}

export function addToCart(offerId: string): CartLine[] {
  const lines = readCart()
  const found = lines.find((line) => line.offerId === offerId)
  if (found) found.qty = Math.min(found.qty + 1, 9)
  else lines.push({ offerId, qty: 1 })
  writeCart(lines)
  return lines
}

export function removeFromCart(offerId: string): CartLine[] {
  const lines = readCart().filter((line) => line.offerId !== offerId)
  writeCart(lines)
  return lines
}

export function setQuantity(offerId: string, qty: number): CartLine[] {
  const next = Math.max(0, Math.min(9, Math.round(qty)))
  let lines = readCart()
  if (next === 0) lines = lines.filter((line) => line.offerId !== offerId)
  else {
    const found = lines.find((line) => line.offerId === offerId)
    if (found) found.qty = next
  }
  writeCart(lines)
  return lines
}

export function cartCount(lines: CartLine[] = readCart()): number {
  return lines.reduce((sum, line) => sum + line.qty, 0)
}

export function quoteFromLines(lines: CartLine[]): Quote {
  const quoteLines: QuoteLine[] = []
  let dropped = 0
  for (const line of lines) {
    const offer = offerById(line.offerId)
    if (!offer) {
      dropped += 1
      continue
    }
    quoteLines.push({
      offer,
      qty: line.qty,
      lineTotal: Number((offer.priceNim * line.qty).toFixed(2)),
    })
  }
  if (dropped) {
    const valid = quoteLines.map((line) => ({ offerId: line.offer.id, qty: line.qty }))
    try {
      writeCart(valid)
    } catch {
      // A blocked storage write does not block the current quote.
    }
  }
  const subtotal = Number(
    quoteLines.reduce((sum, line) => sum + line.lineTotal, 0).toFixed(2)
  )
  const deliveryByMerchant = new Map<string, number>()
  for (const line of quoteLines) {
    const current = deliveryByMerchant.get(line.offer.merchant) ?? 0
    deliveryByMerchant.set(line.offer.merchant, Math.max(current, line.offer.deliveryNim))
  }
  const delivery = Number(
    [...deliveryByMerchant.values()].reduce((sum, fee) => sum + fee, 0).toFixed(2)
  )
  const merchants = [...new Set(quoteLines.map((line) => line.offer.merchant))]

  let blockedReason = ""
  if (!quoteLines.length) blockedReason = ""
  else if (merchants.length > 1) {
    blockedReason = `This bag holds items from ${merchants.length} merchants (${merchants.join(", ")}). NimiqMe pays one merchant per transaction, so empty the bag and check out one item at a time.`
  } else if (quoteLines.length > 1) {
    blockedReason = `This bag has ${quoteLines.length} lines. NimiqMe checks out one line at a time; remove the others and pay each separately.`
  }

  return {
    lines: quoteLines,
    itemCount: quoteLines.reduce((sum, line) => sum + line.qty, 0),
    subtotal,
    delivery,
    total: Number((subtotal + delivery).toFixed(2)),
    merchants,
    dropped,
    payable: Boolean(quoteLines.length) && merchants.length === 1 && quoteLines.length === 1,
    blockedReason,
  }
}

export function currentQuote(): Quote {
  return quoteFromLines(readCart())
}

/**
 * Hands the bag to the quote builder. Prices stay per unit; the merchant
 * delivery fee rides along once for the line, never multiplied by quantity.
 */
export function quoteBagLines(quote: Quote): {
  offerId: string
  title: string
  merchant: string
  qty: number
  unitNim: number
  deliveryNim: number
}[] {
  return quote.lines.map((line) => ({
    offerId: line.offer.id,
    title: line.offer.title,
    merchant: line.offer.merchant,
    qty: line.qty,
    unitNim: line.offer.priceNim,
    deliveryNim: line.qty === quote.itemCount ? line.offer.deliveryNim : 0,
  }))
}
