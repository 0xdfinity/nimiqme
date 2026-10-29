// Browser-side brain call. Talks to the NimiqMe brain proxy (server/brain.mjs),
// which holds the model keys. If no proxy is configured, or it is unreachable,
// this returns null and the app keeps using its local, rule-based answers — so
// the mini app is fully functional with or without a brain, and never a key.

export type OfferBrief = { title: string; merchant: string; priceNim: number }

const BASE = String((import.meta.env?.VITE_BRAIN_URL as string | undefined) ?? "").replace(/\/$/, "")

/** Ask the brain to word an answer about these offers. Null when off/unreachable. */
export async function brainReply(
  question: string,
  offers: OfferBrief[]
): Promise<string | null> {
  if (!BASE) return null
  const clean = question.trim()
  if (!clean) return null
  const listed = offers.length
    ? `OFFERS:\n${offers.map((o) => `- ${o.title} from ${o.merchant}: ${o.priceNim.toFixed(2)} NIM`).join("\n")}`
    : "OFFERS: (none found)"
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 12000)
    const res = await fetch(`${BASE}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: `${clean}\n\n${listed}` }] }),
      signal: ctl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = (await res.json()) as { text?: unknown }
    return typeof data.text === "string" && data.text.trim() ? data.text.trim() : null
  } catch {
    return null
  }
}
