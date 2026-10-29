export type Category =
  | "footwear"
  | "bags"
  | "audio"
  | "outerwear"
  | "home"
  | "desk"
  | "time"
  | "seating"

/**
 * A merchant's receiving addresses, per network.
 *
 * `null` means "nobody has told us the address yet" — checkout for that
 * merchant on that network is blocked instead of falling back to some other
 * wallet. Addresses are never invented: the only testnet value below is the
  * shared testnet address, and it is marked
 * `placeholder` because it is a shared demo wallet, not a per-merchant one.
 */
export type MerchantAccounts = {
  name: string
  slug: string
  addresses: {
    mainnet: string | null
    testnet: string | null
  }
  /**
   * - `placeholder`: a known-safe demo address, not owned by this merchant.
   * - `configured`: supplied at build time through `VITE_MERCHANT_ADDRESS_*`.
   * - `unknown`: no address, payment blocked.
   */
  status: { mainnet: "placeholder" | "configured" | "unknown"; testnet: "placeholder" | "configured" | "unknown" }
}

/** Shared demo testnet wallet already used by this project. Not merchant-owned. */
export const DEMO_TESTNET_ADDRESS = "NQ22U2S1VUGYT5J32RKUH8QATRE2TKTSH641"

function placeholderMerchant(name: string, slug: string): MerchantAccounts {
  return {
    name,
    slug,
    addresses: { mainnet: null, testnet: DEMO_TESTNET_ADDRESS },
    status: { mainnet: "unknown", testnet: "placeholder" },
  }
}

export const MERCHANTS: MerchantAccounts[] = [
  { ...placeholderMerchant("Northline", "northline"), addresses: { mainnet: "NQ88CHCL1VJ8DH9DP5M93M1V0BE80J1P1Y71", testnet: null }, status: { mainnet: "configured", testnet: "unknown" } },
  { ...placeholderMerchant("Atlas Supply", "atlas-supply"), addresses: { mainnet: "NQ88CHCL1VJ8DH9DP5M93M1V0BE80J1P1Y71", testnet: null }, status: { mainnet: "configured", testnet: "unknown" } },
  { ...placeholderMerchant("Kite Home", "kite-home"), addresses: { mainnet: "NQ88CHCL1VJ8DH9DP5M93M1V0BE80J1P1Y71", testnet: null }, status: { mainnet: "configured", testnet: "unknown" } },
  { ...placeholderMerchant("Foundry Audio", "foundry-audio"), addresses: { mainnet: "NQ88CHCL1VJ8DH9DP5M93M1V0BE80J1P1Y71", testnet: null }, status: { mainnet: "configured", testnet: "unknown" } },
  { ...placeholderMerchant("Ledger Desk", "ledger-desk"), addresses: { mainnet: "NQ88CHCL1VJ8DH9DP5M93M1V0BE80J1P1Y71", testnet: null }, status: { mainnet: "configured", testnet: "unknown" } },
]

const MERCHANTS_BY_NAME = new Map(MERCHANTS.map((merchant) => [merchant.name, merchant]))

/**
 * Adds a merchant at runtime (seeded demo storefront or a published listing).
 *
 * A name that already exists is only accepted when it resolves to the same
 * receiving address. Otherwise a link could quietly redirect another merchant's
 * payments, so this throws instead of overwriting.
 */
export function registerMerchant(input: {
  name: string
  slug: string
  address: string
  placeholder?: boolean
}): MerchantAccounts {
  const existing = MERCHANTS_BY_NAME.get(input.name)
  if (existing) {
    const current = existing.addresses.testnet ?? existing.addresses.mainnet ?? ""
    if (current !== input.address) {
      throw new Error(`${input.name} already has a different receiving address on this device.`)
    }
    return existing
  }
  const merchant: MerchantAccounts = input.placeholder
    ? {
        name: input.name,
        slug: input.slug,
        addresses: { mainnet: null, testnet: input.address },
        status: { mainnet: "unknown", testnet: "placeholder" },
      }
    : {
        name: input.name,
        slug: input.slug,
        addresses: { mainnet: input.address, testnet: input.address },
        status: { mainnet: "configured", testnet: "configured" },
      }
  MERCHANTS.push(merchant)
  MERCHANTS_BY_NAME.set(merchant.name, merchant)
  return merchant
}

/** Adds an offer unless one with the same id already exists. Returns true when added. */
export function registerOffer(offer: Offer): boolean {
  if (CATALOG.some((existing) => existing.id === offer.id)) return false
  CATALOG.push(offer)
  return true
}

export function removeOffersFor(merchant: string): number {
  let removed = 0
  for (let i = CATALOG.length - 1; i >= 0; i -= 1) {
    if (CATALOG[i].merchant === merchant && CATALOG[i].listed) {
      CATALOG.splice(i, 1)
      removed += 1
    }
  }
  return removed
}

export function merchantByName(name: string): MerchantAccounts | undefined {
  return MERCHANTS_BY_NAME.get(name)
}

export function merchantBySlug(slug: string): MerchantAccounts | undefined {
  return MERCHANTS.find((merchant) => merchant.slug === slug)
}

export type Offer = {
  id: string
  productKey: string
  title: string
  merchant: string
  priceNim: number
  deliveryNim: number
  deliveryDays: number
  category: Category
  tags: string[]
  blurb: string
  /** Optional: merchant-supplied image URL (hosted by the merchant, never by NimiqMe). */
  imageUrl?: string
  /** Optional: units the merchant reports in stock. Absent on the built-in catalog. */
  stock?: number
  /**
   * True for offers a merchant published with a 5-field listing. Those carry no
   * delivery terms, so the UI must not describe any.
   */
  listed?: boolean
}

export const CATEGORY_LABEL: Record<Category, string> = {
  footwear: "Footwear",
  bags: "Bags",
  audio: "Audio",
  outerwear: "Outerwear",
  home: "Home",
  desk: "Desk",
  time: "Time",
  seating: "Seating",
}

export const CATALOG: Offer[] = [
  {
    id: "of-101",
    productKey: "red-runner",
    title: "Red Runner",
    merchant: "Northline",
    priceNim: 42,
    deliveryNim: 2,
    deliveryDays: 3,
    category: "footwear",
    tags: ["red", "sneakers", "running", "trainers", "shoes", "footwear"],
    blurb: "Low-profile trainer in red canvas with a gum sole.",
    imageUrl: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-102",
    productKey: "red-runner",
    title: "Red Runner",
    merchant: "Atlas Supply",
    priceNim: 39,
    deliveryNim: 3,
    deliveryDays: 2,
    category: "footwear",
    tags: ["red", "sneakers", "running", "trainers", "shoes", "footwear"],
    blurb: "The same red runner, shipped from the Atlas warehouse.",
    imageUrl: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-103",
    productKey: "sand-trainer",
    title: "Sand Trainer",
    merchant: "Kite Home",
    priceNim: 36,
    deliveryNim: 2,
    deliveryDays: 4,
    category: "footwear",
    tags: ["sand", "beige", "sneakers", "trainers", "shoes", "footwear"],
    blurb: "Everyday trainer in washed sand leather.",
    imageUrl: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-201",
    productKey: "blue-daypack",
    title: "Blue Daypack 24L",
    merchant: "Atlas Supply",
    priceNim: 28,
    deliveryNim: 2,
    deliveryDays: 2,
    category: "bags",
    tags: ["blue", "navy", "backpack", "bag", "daypack", "laptop", "14", "commute"],
    blurb: "Padded 14-inch laptop sleeve, two bottle pockets, 24 litres.",
    imageUrl: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-202",
    productKey: "blue-daypack",
    title: "Blue Daypack 24L",
    merchant: "Northline",
    priceNim: 31,
    deliveryNim: 0,
    deliveryDays: 4,
    category: "bags",
    tags: ["blue", "navy", "backpack", "bag", "daypack", "laptop", "14", "commute"],
    blurb: "Same pack from Northline with free delivery.",
    imageUrl: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-203",
    productKey: "black-sling",
    title: "Black Laptop Sling",
    merchant: "Foundry Audio",
    priceNim: 22,
    deliveryNim: 2,
    deliveryDays: 3,
    category: "bags",
    tags: ["black", "sling", "bag", "laptop", "13", "crossbody", "commute"],
    blurb: "Slim crossbody for a 13-inch laptop, charger and phone.",
    imageUrl: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-301",
    productKey: "over-ear",
    title: "Foundry Over-Ear",
    merchant: "Foundry Audio",
    priceNim: 65,
    deliveryNim: 3,
    deliveryDays: 2,
    category: "audio",
    tags: ["headphones", "over-ear", "wireless", "audio", "black", "music"],
    blurb: "Closed-back wireless headphones with 38 hours of playback.",
    imageUrl: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-302",
    productKey: "over-ear",
    title: "Foundry Over-Ear",
    merchant: "Atlas Supply",
    priceNim: 59,
    deliveryNim: 4,
    deliveryDays: 3,
    category: "audio",
    tags: ["headphones", "over-ear", "wireless", "audio", "black", "music"],
    blurb: "The same headphone, six NIM less, one day later.",
    imageUrl: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-303",
    productKey: "earbuds",
    title: "Pocket Earbuds",
    merchant: "Foundry Audio",
    priceNim: 34,
    deliveryNim: 2,
    deliveryDays: 2,
    category: "audio",
    tags: ["earbuds", "wireless", "audio", "white", "music", "gift"],
    blurb: "Small case, 24 hours with the case, USB-C.",
    imageUrl: "https://images.unsplash.com/photo-1590658268037-6bf12165a8df?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-401",
    productKey: "field-jacket",
    title: "Red Field Jacket",
    merchant: "Northline",
    priceNim: 88,
    deliveryNim: 4,
    deliveryDays: 4,
    category: "outerwear",
    tags: ["red", "jacket", "coat", "outerwear", "field"],
    blurb: "Four pockets, storm flap, unlined body for mild weather.",
    imageUrl: "https://images.unsplash.com/photo-1551028719-00167b16eac5?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-402",
    productKey: "rain-shell",
    title: "Black Rain Shell",
    merchant: "Atlas Supply",
    priceNim: 54,
    deliveryNim: 2,
    deliveryDays: 3,
    category: "outerwear",
    tags: ["black", "jacket", "shell", "rain", "outerwear", "packable"],
    blurb: "Packable shell with taped seams and a hood that stays up.",
    imageUrl: "https://images.unsplash.com/photo-1551028719-00167b16eac5?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-501",
    productKey: "brass-lamp",
    title: "Brass Desk Lamp",
    merchant: "Kite Home",
    priceNim: 19,
    deliveryNim: 3,
    deliveryDays: 3,
    category: "home",
    tags: ["lamp", "light", "brass", "desk", "home", "gift"],
    blurb: "Warm 2700K bulb, weighted base, inline switch.",
    imageUrl: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-502",
    productKey: "brass-lamp",
    title: "Brass Desk Lamp",
    merchant: "Ledger Desk",
    priceNim: 23,
    deliveryNim: 0,
    deliveryDays: 5,
    category: "home",
    tags: ["lamp", "light", "brass", "desk", "home", "gift"],
    blurb: "The same lamp with free delivery and a longer lead time.",
    imageUrl: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-503",
    productKey: "mug-set",
    title: "Ceramic Mug Set",
    merchant: "Kite Home",
    priceNim: 12,
    deliveryNim: 2,
    deliveryDays: 2,
    category: "home",
    tags: ["mug", "mugs", "ceramic", "kitchen", "home", "gift", "set"],
    blurb: "Four stoneware mugs in chalk white, dishwasher safe.",
    imageUrl: "https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-601",
    productKey: "keyboard",
    title: "Mechanical Keyboard",
    merchant: "Ledger Desk",
    priceNim: 47,
    deliveryNim: 2,
    deliveryDays: 2,
    category: "desk",
    tags: ["keyboard", "mechanical", "desk", "office", "wireless", "setup"],
    blurb: "75 percent layout, tactile switches, Bluetooth and USB-C.",
    imageUrl: "https://images.unsplash.com/photo-1587829741301-dc798b83add3?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-602",
    productKey: "laptop-stand",
    title: "Walnut Laptop Stand",
    merchant: "Ledger Desk",
    priceNim: 26,
    deliveryNim: 3,
    deliveryDays: 3,
    category: "desk",
    tags: ["stand", "laptop", "walnut", "wood", "desk", "office", "setup"],
    blurb: "Solid walnut, raises the screen to eye level, folds flat.",
    imageUrl: "https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-603",
    productKey: "desk-mat",
    title: "Felt Desk Mat",
    merchant: "Kite Home",
    priceNim: 15,
    deliveryNim: 2,
    deliveryDays: 2,
    category: "desk",
    tags: ["mat", "felt", "desk", "office", "grey", "setup"],
    blurb: "900 by 400 millimetres of dense wool felt with a cork back.",
    imageUrl: "https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-701",
    productKey: "field-watch",
    title: "Field Watch",
    merchant: "Atlas Supply",
    priceNim: 72,
    deliveryNim: 2,
    deliveryDays: 2,
    category: "time",
    tags: ["watch", "field", "time", "steel", "gift"],
    blurb: "36 millimetre steel case, sapphire crystal, 100 metre rating.",
    imageUrl: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-702",
    productKey: "field-watch",
    title: "Field Watch",
    merchant: "Northline",
    priceNim: 68,
    deliveryNim: 3,
    deliveryDays: 4,
    category: "time",
    tags: ["watch", "field", "time", "steel", "gift"],
    blurb: "Same watch, lower price, slower delivery.",
    imageUrl: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "of-801",
    productKey: "canvas-chair",
    title: "Canvas Chair",
    merchant: "Kite Home",
    priceNim: 58,
    deliveryNim: 6,
    deliveryDays: 5,
    category: "seating",
    tags: ["chair", "canvas", "seating", "home", "green", "folding"],
    blurb: "Folding canvas chair with a beech frame, indoor use.",
    imageUrl: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=85",
  },
]

export function offerById(id: string): Offer | undefined {
  return CATALOG.find((offer) => offer.id === id)
}

export function featuredOffers(): Offer[] {
  return ["of-102", "of-201", "of-302", "of-501"]
    .map((id) => offerById(id))
    .filter((offer): offer is Offer => Boolean(offer))
}
