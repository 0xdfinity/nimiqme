import { CATALOG, CATEGORY_LABEL, type Category, type Offer } from "./catalog"

export type Intent = "search" | "compare" | "cart" | "help" | "empty"

export type Answer = {
  intent: Intent
  query: string
  offers: Offer[]
  reply: string
}

const CATEGORY_WORDS: Record<Category, string[]> = {
  footwear: ["footwear", "shoe", "shoes", "sneaker", "sneakers", "runner", "runners", "trainer", "trainers"],
  bags: ["bag", "bags", "backpack", "backpacks", "daypack", "sling", "crossbody", "commute"],
  audio: ["audio", "headphone", "headphones", "earbud", "earbuds", "music"],
  outerwear: ["outerwear", "jacket", "jackets", "coat", "shell", "rain", "packable"],
  home: ["home", "lamp", "lamps", "light", "mug", "mugs", "kitchen", "gift"],
  desk: ["desk", "office", "keyboard", "stand", "mat", "setup", "monitor"],
  time: ["time", "watch", "watches"],
  seating: ["seating", "seat", "chair", "chairs"],
}

const STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "best", "below", "budget", "but", "buy",
  "can", "cheap", "cheapest", "compare", "could", "do", "for", "from", "get", "give", "good",
  "have", "help", "i", "in", "is", "it", "less", "like", "looking", "max", "maximum", "me",
  "my", "need", "new", "of", "on", "option", "options", "or", "please", "price", "prices",
  "show", "some", "something", "than", "the", "to", "under", "up", "want", "what", "with",
  "would", "you", "your", "nim",
])

const CART_WORDS = /^(cart|bag|basket|checkout|check out|pay|payment|review|approve)\b/i

function money(value: number): string {
  return `${value.toFixed(2)} NIM`
}

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9.\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function detectCategory(text: string): Category | null {
  for (const category of Object.keys(CATEGORY_WORDS) as Category[]) {
    if (CATEGORY_WORDS[category].some((word) => new RegExp(`\\b${word}\\b`).test(text))) {
      return category
    }
  }
  return null
}

function detectBudget(text: string): number | null {
  const patterns = [
    /(?:under|below|less than|max(?:imum)?|up to|budget(?: of)?)\s*(?:nim\s*)?(\d+(?:\.\d{1,2})?)/,
    /(\d+(?:\.\d{1,2})?)\s*nim\b/,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) {
      const value = Number(match[1])
      if (Number.isFinite(value) && value > 0) return value
    }
  }
  return null
}

function tokensOf(text: string): string[] {
  return text
    .split(/[\s-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function hasWord(text: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`).test(text)
}

function wordForms(token: string): string[] {
  const forms = [token]
  if (token.endsWith("ies") && token.length > 4) forms.push(`${token.slice(0, -3)}y`)
  if (token.endsWith("es") && token.length > 4) forms.push(token.slice(0, -2))
  if (token.endsWith("s") && token.length > 3) forms.push(token.slice(0, -1))
  return [...new Set(forms)]
}

function scoreOffer(offer: Offer, tokens: string[]): number {
  if (!tokens.length) return 0
  const title = offer.title.toLowerCase()
  const merchant = offer.merchant.toLowerCase()
  const category = offer.category.toLowerCase()
  const blurb = offer.blurb.toLowerCase()
  let score = 0
  for (const token of tokens) {
    for (const form of wordForms(token)) {
      if (offer.tags.some((tag) => tag === form || tag.startsWith(form))) score += 4
      if (hasWord(title, form)) score += 3
      if (category === form) score += 2
      if (hasWord(merchant, form)) score += 1
      if (hasWord(blurb, form)) score += 1
    }
  }
  return score
}

function uniqueProducts(offers: Offer[]): number {
  return new Set(offers.map((offer) => offer.productKey)).size
}

function compareReply(offers: Offer[]): string {
  if (offers.length < 2) return "Only one offer for that item is in the catalog right now."
  const sorted = [...offers].sort((a, b) => a.priceNim - b.priceNim)
  const cheapest = sorted[0]
  const dearest = sorted[sorted.length - 1]
  const gap = dearest.priceNim - cheapest.priceNim
  const speed = [...offers].sort((a, b) => a.deliveryDays - b.deliveryDays)[0]
  const parts = [
    `${offers.length} offers for the ${cheapest.title.toLowerCase()}.`,
    `${cheapest.merchant} is ${money(gap)} lower at ${money(cheapest.priceNim)}.`,
  ]
  if (speed.merchant !== cheapest.merchant) {
    parts.push(`${speed.merchant} delivers in ${speed.deliveryDays} days if speed matters more.`)
  } else {
    parts.push(`It also delivers in ${cheapest.deliveryDays} days.`)
  }
  parts.push("Add the one you want, or ask me to review the bag.")
  return parts.join(" ")
}

function searchReply(offers: Offer[], query: string, budget: number | null): string {
  const products = uniqueProducts(offers)
  const cheapest = [...offers].sort((a, b) => a.priceNim - b.priceNim)[0]
  const scope = budget ? ` under ${money(budget)}` : ""
  if (products > 1) {
    return `${offers.length} offers across ${products} products${scope}. The lowest is ${cheapest.merchant} at ${money(cheapest.priceNim)}. Add what you want, or name one item to compare every offer.`
  }
  if (offers.length > 1) {
    return `${offers.length} offers for “${query}”${scope}. ${cheapest.merchant} has the lowest at ${money(cheapest.priceNim)}. Add one, or ask me to compare.`
  }
  return `One match for “${query}”${scope}: ${cheapest.title} from ${cheapest.merchant} at ${money(cheapest.priceNim)}, delivered in ${cheapest.deliveryDays} days.`
}

export function answer(input: string, bagCount: number): Answer {
  const query = input.trim()
  const text = normalize(query)

  if (!text) {
    return {
      intent: "help",
      query,
      offers: [],
      reply: "Type what you need. A product, a category, or a budget is enough.",
    }
  }

  if (/^(hi|hey|hello|good (morning|afternoon|evening))\b/.test(text)) {
    return {
      intent: "help",
      query,
      offers: [],
      reply: "Hi. Tell me what you need and your budget. I compare the catalog, build the bag, and wait for your approval before anything is paid.",
    }
  }

  if (CART_WORDS.test(text) || /what.*(bag|cart)/.test(text)) {
    if (bagCount === 0) {
      return {
        intent: "cart",
        query,
        offers: [],
        reply: "Your bag is empty. Ask me for a product first, then I will price the whole order.",
      }
    }
    return {
      intent: "cart",
      query,
      offers: [],
      reply: `Your bag has ${bagCount} ${bagCount === 1 ? "item" : "items"}. Open it to see the full quote, then approve the total.`,
    }
  }

  if (/(help|how does this work|what can you do|what do you do)/.test(text)) {
    return {
      intent: "help",
      query,
      offers: [],
      reply: "I find products by name, category, or budget. I show every merchant offer for an item, build a bag, and price delivery. Payment runs through your Nimiq Pay wallet only after you approve the total.",
    }
  }

  const category = detectCategory(text)
  const budget = detectBudget(text)
  const wantsCompare = /\b(compare|comparison|cheapest|best price|all offers|options)\b/.test(text)
  const tokens = tokensOf(text).filter(
    (token) =>
      !(budget !== null && /^\d+(?:\.\d+)?$/.test(token) && Number(token) === budget)
  )

  let scored = CATALOG.map((offer) => ({ offer, score: scoreOffer(offer, tokens) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.offer.priceNim - b.offer.priceNim)
    .map(({ offer }) => offer)

  if (!scored.length && category) {
    scored = CATALOG.filter((offer) => offer.category === category).sort(
      (a, b) => a.priceNim - b.priceNim
    )
  }

  if (budget) {
    scored = scored.filter((offer) => offer.priceNim <= budget)
  }

  if (!scored.length) {
    const categories = Object.values(CATEGORY_LABEL).join(", ").toLowerCase()
    return {
      intent: "empty",
      query,
      offers: [],
      reply: `Nothing in the catalog matches “${query}”${budget ? ` under ${money(budget)}` : ""}. Try a category such as ${categories}, or a budget like “under 40 NIM”.`,
    }
  }

  if (wantsCompare) {
    const groups = new Map<string, Offer[]>()
    for (const offer of scored) {
      const group = groups.get(offer.productKey) ?? []
      group.push(offer)
      groups.set(offer.productKey, group)
    }
    const lead = scored[0]
    let group = groups.get(lead.productKey) ?? []
    if (group.length < 2) {
      const multi = [...groups.values()].find((candidate) => candidate.length > 1)
      if (multi) group = multi
    }
    group = [...group].sort((a, b) => a.priceNim - b.priceNim)
    return {
      intent: "compare",
      query,
      offers: group,
      reply: compareReply(group),
    }
  }

  const offers = scored.slice(0, 4)
  return {
    intent: "search",
    query,
    offers,
    reply: searchReply(offers, query, budget),
  }
}
