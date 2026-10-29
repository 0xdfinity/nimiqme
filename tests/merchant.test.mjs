/**
 * Unit tests for the merchant CSV onboarding and payable-link codec.
 *
 * Run with `npm test` on Node 22. Like the payment tests this file is
 * DOM-free: it imports the pure modules directly.
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import {
  MAX_ROWS,
  buildPayablePayload,
  decodePayable,
  encodePayable,
  parseListingCsv,
  parsePriceNim,
  payableLink,
  validateImageUrl,
} from "../src/merchant.ts"

const here = dirname(fileURLToPath(import.meta.url))
const ADDRESS = "NQ22U2S1VUGYT5J32RKUH8QATRE2TKTSH641"
const HEADER = "name,price,image_url,description,stock"
const GOOD = "https://picsum.photos/seed/x/800/800"

const checks = []
function check(name, fn) {
  try {
    fn()
    checks.push([name, true])
    console.log(`  ok  ${name}`)
  } catch (error) {
    checks.push([name, false])
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}

console.log("merchant csv and payable links")

check("a valid five-column file parses into rows", () => {
  const csv = `${HEADER}\nMug,12,${GOOD},"Stoneware, 350ml",5`
  const result = parseListingCsv(csv)
  assert.equal(result.headerOk, true)
  assert.equal(result.errors.length, 0)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].name, "Mug")
  assert.equal(result.rows[0].description, "Stoneware, 350ml")
})

check("a wrong header refuses every row", () => {
  const result = parseListingCsv(`name,price,image,desc,qty\nMug,12,${GOOD},x,5`)
  assert.equal(result.headerOk, false)
  assert.equal(result.rows.length, 0)
})

check("an unclosed quote is reported, not repaired", () => {
  const result = parseListingCsv(`${HEADER}\nMug,12,${GOOD},"never closes,5`)
  assert.ok(result.errors.length > 0)
  assert.equal(result.rows.length, 0)
})

check("more than the row limit is refused", () => {
  const lines = [HEADER]
  for (let i = 0; i <= MAX_ROWS; i += 1) lines.push(`Item ${i},1,${GOOD},d,1`)
  const result = parseListingCsv(lines.join("\n"))
  assert.ok(result.errors.some((e) => /at most/i.test(e.message)))
})

check("price 0.1 NIM is accepted despite float error", () => {
  assert.equal(parsePriceNim("0.1"), 0.1)
})

check("price above the cap is refused", () => {
  assert.equal(parsePriceNim("1000001"), null)
})

check("zero and negative prices are refused", () => {
  assert.equal(parsePriceNim("0"), null)
  assert.equal(parsePriceNim("-3"), null)
})

check("more than five decimals (luna precision) is refused", () => {
  assert.equal(parsePriceNim("1.000001"), null)
})

check("non-https image is refused", () => {
  assert.notEqual(validateImageUrl("http://example.com/a.jpg"), null)
  assert.notEqual(validateImageUrl("javascript:alert(1)"), null)
})

check("https image is accepted", () => {
  assert.equal(validateImageUrl(GOOD), null)
})

check("an invalid Nimiq address is refused by the payable codec", () => {
  const row = parseListingCsv(`${HEADER}\nMug,12,${GOOD},d,5`).rows[0]
  assert.throws(() => buildPayablePayload({ storeName: "Shop", address: "NQ00BAD", row }))
})

check("payable link round trips through encode and decode", () => {
  const row = parseListingCsv(`${HEADER}\nMug,12,${GOOD},"Stoneware",5`).rows[0]
  const payload = buildPayablePayload({ storeName: "Shop", address: ADDRESS, row })
  const code = encodePayable(payload)
  const item = decodePayable(code)
  assert.ok(item)
  assert.equal(item.title, "Mug")
  assert.equal(item.priceNim, 12)
  assert.equal(item.merchant, "Shop")
})

check("payable link is built on the base url with a #/pay route", () => {
  const row = parseListingCsv(`${HEADER}\nMug,12,${GOOD},d,5`).rows[0]
  const payload = buildPayablePayload({ storeName: "Shop", address: ADDRESS, row })
  const link = payableLink("https://nimiqme.example/app/#/", payload)
  assert.ok(link.startsWith("https://nimiqme.example/app/#/pay/"))
})

check("a tampered code is refused, not partially read", () => {
  assert.equal(decodePayable("not-a-real-code!!"), null)
  assert.equal(decodePayable(""), null)
})

check("the three seed storefronts parse cleanly", () => {
  const files = ["kiln-coffee.csv", "field-notes.csv", "tidewater-goods.csv"]
  for (const file of files) {
    const text = readFileSync(join(here, "..", "src", "data", "storefronts", file), "utf8")
    const result = parseListingCsv(text)
    assert.equal(result.headerOk, true, `${file} header`)
    assert.equal(result.errors.length, 0, `${file} errors: ${JSON.stringify(result.errors)}`)
    assert.ok(result.rows.length >= 3, `${file} has too few rows`)
  }
})

const failed = checks.filter(([, ok]) => !ok).length
console.log("")
console.log(failed ? `${failed} merchant check(s) failed.` : `All ${checks.length} merchant checks passed.`)
if (failed) process.exit(1)
