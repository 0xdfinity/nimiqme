/**
 * Merchant pages: CSV onboarding, payable-link generator, and orders.
 *
 * Kept free of payment logic. A link only decodes into an offer; checkout and
 * verification still go through the existing bag and quote path.
 */

import { CATEGORY_LABEL, registerMerchant, registerOffer, removeOffersFor, merchantByName, offerById, type Offer, DEMO_TESTNET_ADDRESS } from "./catalog.ts"
import { buildPayablePayload, decodePayable, encodePayable, parseListingCsv, payableLink, MAX_ROWS, slugify, type ListingRow } from "./merchant.ts"
import { offerFromRow } from "./storefronts.ts"
import { normalizeAddress, isValidNimiqAddress } from "./quote.ts"

const STORE_KEY = "nimiqme:merchant:listings:v1"

export type StoredStore = { name: string; address: string; slug: string; links: { title: string; link: string; offerId: string }[] }

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value))
}

export function readStores(): StoredStore[] {
  return readJson<StoredStore[]>(STORE_KEY, [])
}

/** Restores every merchant-published storefront into the live catalog. */
export function loadPublishedStores(): number {
  let loaded = 0
  for (const store of readStores()) {
    try {
      registerMerchant({ name: store.name, slug: store.slug, address: store.address })
    } catch {
      continue
    }
    for (const link of store.links) {
      const item = decodeLinkForOffer(link.link)
      if (item && registerOffer(item)) loaded += 1
    }
  }
  return loaded
}

function codeOf(link: string): string | null {
  const hash = link.indexOf("#/pay/")
  return hash === -1 ? null : link.slice(hash + "#/pay/".length)
}

/** Turns a payable link into a listed offer, or null when the link is refused. */
export function decodeLinkForOffer(link: string): Offer | null {
  const code = codeOf(link)
  if (!code) return null
  const item = decodePayable(code)
  if (!item) return null
  return {
    id: item.id,
    productKey: `sf-${slugify(item.title)}`,
    title: item.title,
    merchant: item.merchant,
    priceNim: item.priceNim,
    deliveryNim: 0,
    deliveryDays: 0,
    category: "home",
    tags: item.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
    blurb: item.description,
    imageUrl: item.imageUrl,
    stock: item.stock,
    listed: true,
  }
}

/** Resolves a landing link: registers its merchant guard-safe and its item into the catalog. */
export function importPayableLink(link: string): { ok: true; offer: Offer } | { ok: false; reason: string } {
  const offer = decodeLinkForOffer(link)
  if (!offer) return { ok: false, reason: "This payment link is not valid. It may have been edited or cut short." }
  const code = codeOf(link) ?? ""
  const payload = decodePayable(code)
  if (!payload) return { ok: false, reason: "This payment link could not be read." }
  try {
    registerMerchant({ name: payload.merchant, slug: slugify(payload.merchant), address: payload.address })
  } catch {
    return { ok: false, reason: `${payload.merchant} already has a different receiving address on this device. The link was not used.` }
  }
  registerOffer(offer)
  return { ok: true, offer }
}

export type ImportReport = {
  rows: ListingRow[]
  links: { row: ListingRow; link: string }[]
  errors: { line: number; message: string }[]
  headerOk: boolean
}

/** Validates a merchant CSV and builds one payable link per valid row. Nothing is saved here. */
export function buildListingReport(storeName: string, addressInput: string, csv: string): ImportReport {
  const parsed = parseListingCsv(csv)
  const address = normalizeAddress(addressInput)
  const errors = [...parsed.errors]
  if (!isValidNimiqAddress(address)) {
    errors.unshift({ line: 0, message: "The receiving address is not a valid Nimiq address." })
    return { rows: [], links: [], errors, headerOk: parsed.headerOk }
  }
  if (!storeName.trim()) {
    errors.unshift({ line: 0, message: "Give the storefront a name." })
    return { rows: [], links: [], errors, headerOk: parsed.headerOk }
  }
  const base = typeof window !== "undefined" ? window.location.href.split("#")[0] : "https://nimiqme.app/"
  const links = parsed.rows.map((row) => {
    const payload = buildPayablePayload({ storeName, address, row })
    return { row, link: payableLink(base, payload) }
  })
  return { rows: parsed.rows, links, errors, headerOk: parsed.headerOk }
}

/** Publishes a validated storefront: saves its links and loads its offers into the catalog. */
export function publishStore(storeName: string, addressInput: string, report: ImportReport): { published: number; refused: string } {
  const address = normalizeAddress(addressInput)
  const name = storeName.trim()
  const existing = merchantByName(name)
  const current = existing?.addresses.testnet ?? existing?.addresses.mainnet ?? ""
  if (existing && current !== address) {
    return { published: 0, refused: `${name} already has a different receiving address on this device. Pick another storefront name.` }
  }
  const slug = slugify(name)
  registerMerchant({ name, slug, address })
  const stores = readStores().filter((store) => store.name !== name)
  const links = report.links.map(({ row, link }) => ({ title: row.name, link, offerId: `sf-${slugify(name)}-${row.line}` }))
  stores.push({ name, address, slug, links })
  writeJson(STORE_KEY, stores)
  removeOffersFor(name)
  let published = 0
  for (const { row, link } of report.links) {
    const offer = decodeLinkForOffer(link)
    if (offer && registerOffer(offer)) published += 1
    void row
  }
  return { published, refused: "" }
}

export function removeStore(name: string): void {
  writeJson(STORE_KEY, readStores().filter((store) => store.name !== name))
  removeOffersFor(name)
}

export function fmtNim(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 5 })} NIM`
}

export function categoryLabel(category: Offer["category"]): string {
  return CATEGORY_LABEL[category]
}

export { DEMO_TESTNET_ADDRESS, offerById, encodePayable, MAX_ROWS }
