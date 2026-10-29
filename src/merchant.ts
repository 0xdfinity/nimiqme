/**
 * Merchant onboarding, kept pure so it can be tested without a DOM.
 *
 * A small merchant onboards with one CSV of five columns:
 *   name, price, image_url, description, stock
 * Images are URLs only; NimiqMe hosts nothing. Each valid row becomes a
 * payable link: a self-contained `#/pay/<code>` fragment that carries the
 * merchant's receiving address and the one item being sold, so a buyer who
 * opens it on another device can pay without any server in between.
 *
 * The codec is strict on purpose. A link that cannot be decoded, or that
 * carries an invalid address, a non-https image, or an out-of-range price, is
 * refused rather than repaired.
 */

import { isValidNimiqAddress, normalizeAddress } from "./quote.ts"

export const CSV_HEADER = ["name", "price", "image_url", "description", "stock"] as const
export const MAX_ROWS = 200
export const MAX_NAME = 60
export const MAX_DESCRIPTION = 280
export const MAX_PRICE_NIM = 1_000_000
export const MAX_STOCK = 100_000
export const MAX_IMAGE_URL = 500

export type ListingRow = {
  line: number
  name: string
  priceNim: number
  imageUrl: string
  description: string
  stock: number
}

export type CsvError = { line: number; message: string }

export type CsvResult = {
  rows: ListingRow[]
  errors: CsvError[]
  /** True when the header itself is wrong; no rows are read in that case. */
  headerOk: boolean
}

/** RFC 4180 style parser: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsvText(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "")
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') inQuotes = true
    else if (char === ",") {
      row.push(field)
      field = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else {
      field += char
    }
  }
  if (field !== "" || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""))
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

export function validateStoreName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return "Store name is required."
  if (trimmed.length > MAX_NAME) return `Store name must be ${MAX_NAME} characters or fewer.`
  if (!slugify(trimmed)) return "Store name needs at least one letter or number."
  return null
}

export function validateImageUrl(value: string): string | null {
  if (!value) return null
  if (value.length > MAX_IMAGE_URL) return `image_url is longer than ${MAX_IMAGE_URL} characters.`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return "image_url is not a valid URL."
  }
  if (url.protocol !== "https:") return "image_url must start with https://."
  return null
}

/** Parses a price in NIM: positive, at most 5 decimals (one luna), within range. */
export function parsePriceNim(value: string): number | null {
  const trimmed = value.trim()
  if (!/^\d+(\.\d{1,5})?$/.test(trimmed)) return null
  const number = Number(trimmed)
  if (!Number.isFinite(number) || number <= 0 || number > MAX_PRICE_NIM) return null
  return number
}

export function parseStock(value: string): number | null {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const number = Number(trimmed)
  if (number > MAX_STOCK) return null
  return number
}

export function parseListingCsv(text: string): CsvResult {
  const table = parseCsvText(text)
  if (!table.length) {
    return { rows: [], errors: [{ line: 1, message: "The file is empty. Add the header row and at least one product." }], headerOk: false }
  }
  const header = table[0].map((cell) => cell.trim().toLowerCase())
  const headerOk = CSV_HEADER.every((column, index) => header[index] === column) && header.length === CSV_HEADER.length
  if (!headerOk) {
    return {
      rows: [],
      errors: [
        {
          line: 1,
          message: `The header must be exactly: ${CSV_HEADER.join(", ")}.`,
        },
      ],
      headerOk: false,
    }
  }

  const body = table.slice(1)
  const errors: CsvError[] = []
  const rows: ListingRow[] = []
  if (body.length > MAX_ROWS) {
    errors.push({ line: 1, message: `A file can list at most ${MAX_ROWS} products. Split it into smaller files.` })
    return { rows: [], errors, headerOk: true }
  }

  body.forEach((cells, index) => {
    const line = index + 2
    if (cells.length !== CSV_HEADER.length) {
      errors.push({ line, message: `Expected ${CSV_HEADER.length} columns, found ${cells.length}.` })
      return
    }
    const [rawName, rawPrice, rawImage, rawDescription, rawStock] = cells.map((cell) => cell.trim())
    const rowErrors: string[] = []
    if (!rawName) rowErrors.push("name is empty")
    else if (rawName.length > MAX_NAME) rowErrors.push(`name is longer than ${MAX_NAME} characters`)
    const priceNim = parsePriceNim(rawPrice)
    if (priceNim === null) rowErrors.push("price must be a positive NIM amount with at most 5 decimals")
    const imageProblem = validateImageUrl(rawImage)
    if (imageProblem) rowErrors.push(imageProblem)
    if (rawDescription.length > MAX_DESCRIPTION) rowErrors.push(`description is longer than ${MAX_DESCRIPTION} characters`)
    const stock = parseStock(rawStock)
    if (stock === null) rowErrors.push("stock must be a whole number, 0 or more")

    if (rowErrors.length) {
      errors.push({ line, message: rowErrors.join("; ") })
      return
    }
    rows.push({
      line,
      name: rawName,
      priceNim: priceNim as number,
      imageUrl: rawImage,
      description: rawDescription,
      stock: stock as number,
    })
  })

  const seen = new Map<string, number>()
  for (const row of rows) {
    const key = row.name.toLowerCase()
    const first = seen.get(key)
    if (first !== undefined) {
      errors.push({ line: row.line, message: `duplicate product name, already on line ${first}` })
    } else {
      seen.set(key, row.line)
    }
  }

  return { rows, errors, headerOk: true }
}

/** Payable link payload. Short keys keep the fragment compact. */
export type PayablePayload = {
  v: 1
  /** store name */
  m: string
  /** receiving Nimiq address (normalised) */
  a: string
  /** item: id, name, price, image, description, stock */
  i: { id: string; n: string; p: number; u: string; d: string; s: number }
}

export type PayableItem = {
  id: string
  title: string
  merchant: string
  address: string
  priceNim: number
  imageUrl: string
  description: string
  stock: number
}

export function itemIdFor(storeName: string, line: number): string {
  return `sf-${slugify(storeName)}-${line}`
}

function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(code: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(code) || code.length > 4000) return null
  try {
    const base64 = code.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(code.length / 4) * 4, "=")
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function encodePayable(payload: PayablePayload): string {
  return toBase64Url(JSON.stringify(payload))
}

/** Decodes and validates a payable link. Returns null on any problem; never repairs. */
export function decodePayable(code: string): PayableItem | null {
  const json = fromBase64Url(code)
  if (!json) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const payload = parsed as Partial<PayablePayload>
  if (payload.v !== 1 || typeof payload.m !== "string" || typeof payload.a !== "string") return null
  const item = payload.i as PayablePayload["i"] | undefined
  if (!item || typeof item !== "object") return null
  if (typeof item.id !== "string" || !/^sf-[a-z0-9-]{1,40}-\d{1,4}$/.test(item.id)) return null
  if (typeof item.n !== "string" || typeof item.d !== "string" || typeof item.u !== "string") return null
  if (typeof item.p !== "number" || typeof item.s !== "number") return null
  if (validateStoreName(payload.m) !== null) return null
  if (item.n.trim() === "" || item.n.length > MAX_NAME) return null
  if (item.d.length > MAX_DESCRIPTION) return null
  if (validateImageUrl(item.u) !== null) return null
  const lunaExact = item.p * 100000
  if (!(item.p > 0) || item.p > MAX_PRICE_NIM || Math.abs(lunaExact - Math.round(lunaExact)) > 1e-6) return null
  if (!Number.isInteger(item.s) || item.s < 0 || item.s > MAX_STOCK) return null
  const address = normalizeAddress(payload.a)
  if (!isValidNimiqAddress(address)) return null
  return {
    id: item.id,
    title: item.n,
    merchant: payload.m.trim(),
    address,
    priceNim: item.p,
    imageUrl: item.u,
    description: item.d,
    stock: item.s,
  }
}

export function buildPayablePayload(input: {
  storeName: string
  address: string
  row: ListingRow
}): PayablePayload {
  const address = normalizeAddress(input.address)
  if (!isValidNimiqAddress(address)) throw new Error("receiving address is not a valid Nimiq address")
  return {
    v: 1,
    m: input.storeName.trim(),
    a: address,
    i: {
      id: itemIdFor(input.storeName, input.row.line),
      n: input.row.name,
      p: input.row.priceNim,
      u: input.row.imageUrl,
      d: input.row.description,
      s: input.row.stock,
    },
  }
}

/** The link a buyer opens. `base` is the mini app URL without its hash. */
export function payableLink(base: string, payload: PayablePayload): string {
  return `${base.replace(/#.*$/, "")}#/pay/${encodePayable(payload)}`
}
