/**
 * Seeded storefronts. Three CSV storefronts ship in src/data/storefronts and
 * load through the same parser merchants use. They sit on the demo testnet
 * address and are flagged as placeholders, so nothing here moves real NIM.
 */

import kilnCsv from "./data/storefronts/kiln-coffee.csv?raw"
import fieldCsv from "./data/storefronts/field-notes.csv?raw"
import tideCsv from "./data/storefronts/tidewater-goods.csv?raw"
import { DEMO_TESTNET_ADDRESS, registerMerchant, registerOffer, type Category, type Offer } from "./catalog.ts"
import { parseListingCsv, slugify, type ListingRow } from "./merchant.ts"

export type SeedStore = { name: string; slug: string; category: Category; csv: string }

export const SEED_STORES: SeedStore[] = [
  { name: "Kiln & Bean", slug: "kiln-bean", category: "home", csv: kilnCsv },
  { name: "Field Notes Co", slug: "field-notes-co", category: "desk", csv: fieldCsv },
  { name: "Tidewater Goods", slug: "tidewater-goods", category: "bags", csv: tideCsv },
]

/** Builds the catalog offer for one imported listing row. Listed offers carry no delivery terms. */
export function offerFromRow(store: SeedStore, row: ListingRow): Offer {
  return {
    id: `sf-${slugify(store.name)}-${row.line}`,
    productKey: `sf-${slugify(row.name)}`,
    title: row.name,
    merchant: store.name,
    priceNim: row.priceNim,
    deliveryNim: 0,
    deliveryDays: 0,
    category: store.category,
    tags: row.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
    blurb: row.description,
    imageUrl: row.imageUrl,
    stock: row.stock,
    listed: true,
  }
}

/** Registers every seed storefront. Throws if a seed CSV stops parsing, so a bad edit fails loudly. */
export function loadSeedStorefronts(): number {
  let loaded = 0
  for (const store of SEED_STORES) {
    const parsed = parseListingCsv(store.csv)
    if (parsed.errors.length) {
      const detail = parsed.errors.map((e) => `line ${e.line}: ${e.message}`).join("; ")
      throw new Error(`${store.name} seed has errors: ${detail}`)
    }
    registerMerchant({ name: store.name, slug: store.slug, address: DEMO_TESTNET_ADDRESS, placeholder: true })
    for (const row of parsed.rows) {
      if (registerOffer(offerFromRow(store, row))) loaded += 1
    }
  }
  return loaded
}
