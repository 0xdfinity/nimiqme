/**
 * Checkout references.
 *
 * A checkout reference is the short, human-readable plain text that identifies
 * one payment attempt: `NQM:7KQ2XF3M`. The same string is
 *   - the idempotency key for persisted payment state,
 *   - shown on the approval screen and the receipt,
 *   - written into the Nimiq transaction `data` field so an explorer can prove
 *     which order a transaction belongs to.
 *
 * Two encodings are kept deliberately apart:
 *   - the reference itself is plain text (never a bare hex blob);
 *   - the wire form passed to `sendBasicTransactionWithData({ data })` is
 *     lowercase hex of those same UTF-8 bytes, which is what the wallet API
 *     expects. Block explorers return those raw bytes back as base64.
 */

/** Nimiq basic transactions accept at most 255 bytes of `data`. */
export const MAX_TX_DATA_BYTES = 255

/** Human-readable prefix so a reference is recognisable on an explorer. */
export const REFERENCE_PREFIX = "NQM:"

/**
 * Unambiguous base32 alphabet (no I, L, O, U) so a reference survives being
 * read aloud or retyped from the wallet approval screen.
 */
const REFERENCE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ123456789"

const REFERENCE_BODY_LENGTH = 8

function readRandomByte(): number {
  const cryptoObject = globalThis.crypto
  if (cryptoObject && typeof cryptoObject.getRandomValues === "function") {
    const byte = new Uint8Array(1)
    cryptoObject.getRandomValues(byte)
    return byte[0]
  }
  // Only reached where crypto.getRandomValues is unavailable.
  return Math.floor(Math.random() * 256)
}

/**
 * Creates a fresh reference, e.g. `NQM:7KQ2XF3M`.
 * 12 bytes, far below the 255 byte data limit.
 */
export function createCheckoutRef(): string {
  let body = ""
  for (let index = 0; index < REFERENCE_BODY_LENGTH; index += 1) {
    body += REFERENCE_ALPHABET[readRandomByte() % REFERENCE_ALPHABET.length]
  }
  return `${REFERENCE_PREFIX}${body}`
}

const REFERENCE_BODY_PATTERN = /^NQM:[A-Z0-9]{8}$/

export function isCheckoutRef(value: unknown): value is string {
  return typeof value === "string" && REFERENCE_BODY_PATTERN.test(value)
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function bytesToUtf8(bytes: Uint8Array): string {
  try {
    // fatal: true means a non-UTF-8 data field decodes to null, not to mojibake
    // that could accidentally compare equal to a reference.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return ""
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().toLowerCase()
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) return null
  const bytes = new Uint8Array(clean.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/**
 * Wire form for the wallet: lowercase hex of the UTF-8 bytes of the reference.
 * Throws rather than let an over-long reference reach the wallet.
 */
export function encodeReferenceData(checkoutRef: string): string {
  const bytes = utf8Bytes(checkoutRef)
  if (bytes.length > MAX_TX_DATA_BYTES) {
    throw new RangeError(`Reference does not fit the ${MAX_TX_DATA_BYTES} byte data limit.`)
  }
  return bytesToHex(bytes)
}

/** Recovers the plain-text reference from the hex handed to the wallet. */
export function decodeReferenceData(hex: string): string | null {
  const bytes = hexToBytes(hex)
  if (!bytes) return null
  const text = bytesToUtf8(bytes)
  return text.startsWith(REFERENCE_PREFIX) ? text : null
}

function base64ToBytes(value: string): Uint8Array | null {
  const clean = value.trim()
  if (!/^[A-Za-z0-9+/]+=*$/.test(clean) || clean.length % 4 !== 0) return null
  try {
    const binary = atob(clean)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

/**
 * Decodes the `data` field as returned by the explorer API (base64 of the raw
 * transaction bytes). Returns the reference only when those bytes are valid
 * UTF-8 that begins with the reference prefix; anything else is `null`, which
 * verification treats as a failed check rather than a missing one.
 */
export function decodeBase64Reference(base64: string | null | undefined): string | null {
  if (!base64) return null
  const bytes = base64ToBytes(base64)
  if (!bytes) return null
  const text = bytesToUtf8(bytes)
  return text.startsWith(REFERENCE_PREFIX) ? text : null
}
