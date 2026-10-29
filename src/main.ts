import "./style.css"
import { answer } from "./assistant"
import { brainReply } from "./brain"
import {
  addToCart,
  cartCount,
  currentQuote,
  quoteBagLines,
  readCart,
  removeFromCart,
  setQuantity,
  writeCart,
  type Quote,
} from "./cart"
import { CATEGORY_LABEL, MERCHANTS, offerById, CATALOG, type Offer } from "./catalog"
import { loadSeedStorefronts } from "./storefronts"
import { MAX_ROWS } from "./merchant"
import { buildListingReport, categoryLabel, importPayableLink, publishStore, readStores, removeStore, loadPublishedStores, type ImportReport } from "./merchant-ui"
import { createCheckoutRef } from "./reference"
import {
  buildQuote,
  recheckQuote,
  LUNA_PER_NIM,
  type ExpectedNetwork,
  type PaymentQuote,
  type QuoteBagLine,
  type QuoteResult,
} from "./quote"
import {
  explorerTxUrl,
  pollTransaction,
  REQUIRED_CONFIRMATIONS,
  type ExpectedPayment,
  type ShapeVerdict,
} from "./verify"
import {
  findPaymentByRef,
  patchPayment,
  readPayments,
  savePayment,
  type PaymentRecord,
} from "./payment-state"
import {
  failureStage,
  fetchBalance,
  formatAddress,
  formatNim,
  hasConfiguredStore,
  hostNetwork,
  merchantRecipient,
  networkLabel,
  PaymentError,
  sendPayment,
  shortAddress,
  walletState,
  type BalanceState,
  type WalletState,
} from "./nimiq"

const root = document.getElementById("app")!
const APP_NAME = "NimiqMe"
const SUGGESTIONS = [
  "Running shoes under 40 NIM",
  "A bag for a 14-inch laptop",
  "Compare desk lamps",
  "Gift under 25 NIM",
]

type Message = {
  id: number
  role: "user" | "assistant"
  text: string
  offers?: Offer[]
  proposal?: boolean
  error?: boolean
  retry?: string
}

/** What the app is currently doing about one payment. */
type VerificationPhase =
  | "idle"
  | "sending"
  | "checking"
  | "verifying"
  | "confirmed"
  | "unconfirmed"
  | "failed"

let messages: Message[] = []
let thinking = false
let wallet: WalletState = { kind: "unknown" }
let balance: BalanceState = { kind: "idle" }
let nextId = 1
/** The quote the approval screen is bound to; rebuilt and compared before send. */
let approvedQuote: PaymentQuote | null = null
let verificationPhase: VerificationPhase = "idle"
let verificationNote = ""
let verificationVerdict: ShapeVerdict | null = null
let verifyAbort: AbortController | null = null

const reducedMotion =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

const PRICE_CACHE_KEY = "nimiqme.price-rates.v1"
const PRICE_CACHE_TTL = 5 * 60 * 1000
let lastPriceFetch = 0
let priceFetchPromise: Promise<void> | null = null
let priceRates: { usdPerNim: number; ngnPerUsd: number | null; fetchedAt: number } | null = null
function readCachedRates(): typeof priceRates {
  try { const raw = localStorage.getItem(PRICE_CACHE_KEY); if (!raw) return null; const cached = JSON.parse(raw) as typeof priceRates; if (!cached || !Number.isFinite(cached.usdPerNim) || Date.now() - cached.fetchedAt > 6 * 60 * 60 * 1000) return null; return cached } catch { return null }
}
function formatFiat(value: number, currency: string): string { return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: currency === "NGN" ? 0 : 2 }).format(value) }
function priceEquivalents(value: number): string {
  const rates = priceRates; if (!rates) return ""
  const usd = value * rates.usdPerNim, usdt = `${formatFiat(usd, "USD")} USDT approx`
  return rates.ngnPerUsd ? ` · ${usdt} · ${formatFiat(usd * rates.ngnPerUsd, "NGN")} approx` : ` · ${usdt}`
}
function renderPriceRates(): void {
  document.querySelectorAll<HTMLElement>("[data-nim-price]").forEach((node) => {
    const suffix = priceEquivalents(Number(node.dataset.nimPrice)); if (!suffix) return
    let extra = node.parentElement?.querySelector<HTMLElement>(".price-equivalent")
    if (!extra) { extra = document.createElement("small"); extra.className = "price-equivalent"; node.insertAdjacentElement("afterend", extra) }
    extra.textContent = suffix
  })
}
async function loadPriceRates(): Promise<void> {
  if (priceFetchPromise) return priceFetchPromise
  if (Date.now() - lastPriceFetch < PRICE_CACHE_TTL) return
  lastPriceFetch = Date.now()
  const run = async (): Promise<void> => {
  const cached = readCachedRates()
  if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL) priceRates = cached
  renderPriceRates()
  try {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2&vs_currencies=usd", { headers: { Accept: "application/json" } })
    if (!response.ok) throw new Error("rate request failed")
    const body = await response.json() as { "nimiq-2"?: { usd?: number } }, usdPerNim = body["nimiq-2"]?.usd
    if (!usdPerNim || !Number.isFinite(usdPerNim)) throw new Error("invalid rate")
    let ngnPerUsd: number | null = null
    try { const fxResponse = await fetch("https://open.er-api.com/v6/latest/USD", { headers: { Accept: "application/json" } }); if (fxResponse.ok) { const fx = await fxResponse.json() as { result?: string; rates?: { NGN?: number } }; if (fx.result === "success" && Number.isFinite(fx.rates?.NGN)) ngnPerUsd = fx.rates!.NGN! } } catch { /* NGN is optional. */ }
    priceRates = { usdPerNim, ngnPerUsd, fetchedAt: Date.now() }
    try { localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(priceRates)) } catch { /* Storage can be disabled. */ }
    renderPriceRates()
  } catch { if (!cached) { priceRates = null; renderPriceRates() } }
  }
  priceFetchPromise = run().finally(() => { priceFetchPromise = null })
  return priceFetchPromise
}
function money(value: number): string { return `<span data-nim-price="${value.toFixed(8)}">${value.toFixed(2)} NIM</span>` }

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function initials(title: string): string {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("")
}

function walletPillText(): string {
  if (wallet.kind === "ready") {
    return wallet.accounts[0]
      ? `<span class="dot dot-live" aria-hidden="true"></span>${esc(shortAddress(wallet.accounts[0]))}`
      : `<span class="dot dot-warn" aria-hidden="true"></span>No account`
  }
  if (wallet.kind === "absent") return APP_NAME
  if (wallet.kind === "denied") return "Wallet off"
  return "Wallet"
}

function walletPillLabel(): string {
  if (wallet.kind === "ready") return "Wallet connected. Open the wallet screen for balance and payments."
  if (wallet.kind === "absent") return "Wallet not available. Open this page inside Nimiq Pay."
  if (wallet.kind === "denied") return "Wallet access declined. Open the wallet screen."
  return "Checking the wallet."
}

function shell(inner: string, pageClass = ""): string {
  const count = cartCount()
  return `
    <header class="topbar">
      <a class="brand" href="#/" aria-label="${APP_NAME} home">${APP_NAME}</a>
      <div class="top-actions">
        <a class="merchant-entry" href="#/merchant">Merchant</a>
        ${typeof window !== "undefined" && !window.nimiq ? `<a class="pay-deeplink" href="nimiqpay://miniapp?url=https://nimiqme.vercel.app">Open in Nimiq Pay</a><small class="pay-fallback">If it does not open, open this app in Nimiq Pay.</small>` : ""}
        <a class="pill wallet" href="#/wallet" aria-label="${esc(walletPillLabel())}">${walletPillText()}</a>
        <a class="bag-link" href="#/cart" aria-label="Bag, ${count} ${count === 1 ? "item" : "items"}">
          Bag<span class="bag-count" aria-hidden="true">${count}</span>
        </a>
      </div>
    </header>
    <main class="page ${pageClass}" id="main">${inner}</main>`
}

function updateBagBadge(): void {
  const count = cartCount()
  document.querySelectorAll<HTMLElement>(".bag-count").forEach((node) => {
    node.textContent = String(count)
  })
  const link = document.querySelector<HTMLAnchorElement>(".bag-link")
  if (link) link.setAttribute("aria-label", `Bag, ${count} ${count === 1 ? "item" : "items"}`)
}

function paintWalletPill(): void {
  const pill = document.querySelector<HTMLAnchorElement>(".wallet")
  if (!pill) return
  pill.innerHTML = walletPillText()
  pill.setAttribute("aria-label", walletPillLabel())
}

/** Tracks the account the wallet shares, and reads its real balance with it. */
async function refreshWallet(): Promise<void> {
  const previousAccount = wallet.kind === "ready" ? wallet.accounts[0] ?? "" : ""
  const previousNetwork = wallet.kind === "ready" ? wallet.network : null

  wallet = await walletState()
  paintWalletPill()

  const account = wallet.kind === "ready" ? wallet.accounts[0] ?? "" : ""
  const network = wallet.kind === "ready" ? wallet.network : null
  const changed = account !== previousAccount || network !== previousNetwork

  if (!account) {
    balance = { kind: "idle" }
    return
  }
  // Only re-read when the address or network moved, or we have nothing yet —
  // otherwise a stray re-render would hammer the wallet.
  if (!changed && balance.kind !== "idle" && balance.kind !== "error") return
  await refreshBalance()
}

/** `getBalance` answers in luna; 100,000 luna is 1 NIM. */
async function refreshBalance(): Promise<void> {
  const account = wallet.kind === "ready" ? wallet.accounts[0] ?? "" : ""
  if (!account) {
    balance = { kind: "error", message: "No wallet account was shared." }
    return
  }
  balance = { kind: "loading" }
  paintBalance()
  balance = await fetchBalance(account)
  paintBalance()
}

function balanceHtml(): string {
  if (balance.kind === "loading") {
    return `<div class="balance balance-loading" role="status"><span class="spinner" aria-hidden="true"></span>Reading the balance…</div>`
  }
  if (balance.kind === "ready") {
    return `<div class="balance" role="group" aria-label="Account balance">
      <span class="balance-value">${esc(balance.luna.toLocaleString("en"))}</span>
      <span class="balance-unit">luna</span>
      <span class="balance-nim">${esc(formatNim(balance.luna))}</span>
      <button class="linklike" type="button" id="refresh-balance">Refresh</button>
    </div>
    <p class="fine">1 NIM = ${LUNA_PER_NIM.toLocaleString("en")} luna. The balance is read from Nimiq Pay for ${esc(shortAddress(balance.address))}.</p>`
  }
  if (balance.kind === "error") {
    return `<div class="balance balance-error" role="alert">
      <span class="tag tag-danger">Balance unavailable</span>
      <p>${esc(balance.message)}</p>
      <button class="linklike" type="button" id="refresh-balance">Try again</button>
    </div>`
  }
  return `<div class="balance balance-idle">Connect Nimiq Pay to read a balance.</div>`
}

function paintBalance(): void {
  const slot = document.getElementById("balance-slot")
  if (!slot) return
  slot.innerHTML = balanceHtml()
  const refresh = document.getElementById("refresh-balance")
  if (refresh) refresh.onclick = () => void refreshBalance()
}

function focusTitle(): void {
  window.requestAnimationFrame(() => {
    document.getElementById("page-title")?.focus({ preventScroll: true })
  })
}

function loadingRows(count: number): string {
  return `<div class="skeleton-list" aria-hidden="true">${Array.from({ length: count })
    .map(() => `<div class="skeleton-row"></div>`)
    .join("")}</div><p class="loading-note" role="status">Pricing the bag…</p>`
}

function emptyState(title: string, body: string, action?: string): string {
  return `<section class="state">
    <div class="state-mark" aria-hidden="true">N</div>
    <h2>${esc(title)}</h2>
    <p>${esc(body)}</p>
    ${action ?? ""}
  </section>`
}

function errorState(title: string, body: string, action: string, retryId?: string): string {
  return `<section class="state state-error" role="alert" tabindex="-1">
    <span class="tag tag-danger">Needs attention</span>
    <h2>${esc(title)}</h2>
    <p>${esc(body)}</p>
    ${retryId ? `<button class="btn" type="button" id="${retryId}">Try again</button>` : ""}
    ${action}
  </section>`
}

function offerCard(offer: Offer, isLowest: boolean): string {
  const qty = readCart().find((line) => line.offerId === offer.id)?.qty ?? 0
  return `<article class="offer">
    <div class="offer-top">
      <span class="merchant">${esc(offer.merchant)}</span>
      <span class="tag${isLowest ? " tag-accent" : ""}">${isLowest ? "Lowest price" : esc(CATEGORY_LABEL[offer.category])}</span>
    </div>
    ${offer.imageUrl ? `<img class="product-image" src="${esc(offer.imageUrl)}" alt="${esc(offer.title)}" loading="lazy" referrerpolicy="no-referrer">` : ""}
    <div class="offer-title">
      <h3>${esc(offer.title)}</h3>
      <span class="price">${money(offer.priceNim)}</span>
    </div>
    <p class="offer-blurb">${esc(offer.blurb)}</p>
    <div class="offer-foot">
      ${offer.listed ? `<span class="delivery">${offer.stock !== undefined ? `${offer.stock} in stock` : "Listed by merchant"}</span>` : `<span class="delivery">${offer.deliveryNim ? `Delivery from ${money(offer.deliveryNim)}` : "Free delivery"} · ${offer.deliveryDays} ${offer.deliveryDays === 1 ? "day" : "days"}</span>`}
      <button class="add" type="button" data-add="${offer.id}" aria-label="Add ${esc(offer.title)} from ${esc(offer.merchant)} to bag">${qty ? `In bag · ${qty}` : "Add"}</button>
    </div>
  </article>`
}

function lowestOfferIds(offers: Offer[]): Set<string> {
  const byProduct = new Map<string, Offer[]>()
  for (const offer of offers) {
    const list = byProduct.get(offer.productKey) ?? []
    list.push(offer)
    byProduct.set(offer.productKey, list)
  }
  const ids = new Set<string>()
  for (const list of byProduct.values()) {
    if (list.length < 2) continue
    const cheapest = [...list].sort((a, b) => a.priceNim - b.priceNim)[0]
    ids.add(cheapest.id)
  }
  return ids
}

function offersHtml(offers: Offer[]): string {
  if (!offers.length) return ""
  const lowest = lowestOfferIds(offers)
  return `<div class="offers">${offers.map((offer) => offerCard(offer, lowest.has(offer.id))).join("")}</div>`
}

function summaryHtml(quote: Quote, compact = false): string {
  return `<div class="summary${compact ? " summary-compact" : ""}">
    <div class="summary-row"><span>Items</span><span>${money(quote.subtotal)}</span></div>
    <div class="summary-row"><span>Delivery</span><span>${quote.delivery ? money(quote.delivery) : "Free"}</span></div>
    <div class="summary-row summary-total"><span>Total</span><span>${money(quote.total)}</span></div>
  </div>`
}

function proposalHtml(): string {
  const quote = currentQuote()
  if (!quote.lines.length) return ""
  return `<div class="proposal">
    <div class="proposal-head"><span class="tag tag-accent">Bag</span><span class="mono">${quote.itemCount} ${quote.itemCount === 1 ? "item" : "items"}</span></div>
    <ul class="proposal-lines">
      ${quote.lines
        .map(
          (line) =>
            `<li>${line.offer.imageUrl ? `<img class="line-image" src="${esc(line.offer.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}<span class="line-copy">${line.qty} × ${esc(line.offer.title)}</span><span class="mono">${money(line.lineTotal)}</span></li>`
        )
        .join("")}
    </ul>
    ${summaryHtml(quote, true)}
    <a class="btn" href="#/cart">Review bag</a>
  </div>`
}

function messageHtml(message: Message): string {
  if (message.role === "user") {
    return `<div class="msg msg-user"><p>${esc(message.text)}</p></div>`
  }
  return `<div class="msg msg-assistant${message.error ? " msg-error" : ""}">
    <div class="avatar" aria-hidden="true">N</div>
    <div class="bubble">
      <p>${esc(message.text)}</p>
      ${offersHtml(message.offers ?? [])}
      ${message.proposal ? proposalHtml() : ""}
      ${message.error && message.retry ? `<button class="linklike" type="button" data-retry="${esc(message.retry)}">Try again</button>` : ""}
    </div>
  </div>`
}

function typingHtml(): string {
  return `<div class="msg msg-assistant" role="status" aria-label="NimiqMe is reading the catalog">
    <div class="avatar" aria-hidden="true">N</div>
    <div class="bubble typing"><span></span><span></span><span></span></div>
  </div>`
}

function emptyThreadHtml(): string {
  return `<div class="empty">
    <div class="empty-copy">
      <h2>Start with a product, a category, or a budget.</h2>
      <p>Every answer prices delivery from each merchant. Nothing joins the bag until you add it.</p>
    </div>
    <div class="suggestions" aria-label="Example questions">
      ${SUGGESTIONS.map(
        (suggestion) =>
          `<button class="suggestion" type="button" data-suggest="${esc(suggestion)}">${esc(suggestion)}</button>`
      ).join("")}
    </div>
  </div>`
}

function renderThread(): void {
  const thread = document.getElementById("thread")
  if (!thread) return
  const nearBottom =
    window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 260
  thread.innerHTML = messages.length
    ? `${messages.map(messageHtml).join("")}${thinking ? typingHtml() : ""}`
    : emptyThreadHtml()
  thread.setAttribute("aria-busy", thinking ? "true" : "false")

  thread.onclick = (event) => {
    const target = event.target as HTMLElement
    const add = target.closest<HTMLButtonElement>("[data-add]")
    if (add) {
      const offerId = add.dataset.add ?? ""
      try {
        addToCart(offerId)
      } catch {
        messages.push({
          id: nextId++,
          role: "assistant",
          text: "This device did not save the bag. Allow site data for this page, then add the item again.",
          error: true,
        })
        renderThread()
        return
      }
      updateBagBadge()
      const qty = readCart().find((line) => line.offerId === offerId)?.qty ?? 0
      add.textContent = `In bag · ${qty}`
      const status = document.getElementById("thread-status")
      if (status) status.textContent = `Added. Bag now has ${cartCount()} ${cartCount() === 1 ? "item" : "items"}.`
      return
    }
    const retry = target.closest<HTMLButtonElement>("[data-retry]")
    if (retry) {
      const text = retry.dataset.retry ?? ""
      void ask(text)
      return
    }
    const suggestion = target.closest<HTMLButtonElement>("[data-suggest]")
    if (suggestion) {
      void ask(suggestion.dataset.suggest ?? "")
    }
  }

  if (messages.length && nearBottom) {
    window.requestAnimationFrame(() => {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: reducedMotion ? "auto" : "smooth",
      })
    })
  }
}

async function ask(raw: string): Promise<void> {
  const text = raw.trim()
  if (!text || thinking) return
  thinking = true
  messages.push({ id: nextId++, role: "user", text })
  const input = document.getElementById("ask") as HTMLInputElement | null
  if (input) input.value = ""
  renderThread()

  try {
    await wait(420)
    const quote = currentQuote()
    const result = answer(text, quote.itemCount)
    // The local rule engine already decides what is real. When a brain proxy is
    // configured, let it word the answer about these verified offers; otherwise
    // keep the local reply. Fail-soft, so offline stays fully functional.
    let replyText = result.reply
    if (result.offers.length) {
      const brief = result.offers.slice(0, 6).map((offer) => ({
        title: offer.title,
        merchant: offer.merchant,
        priceNim: offer.priceNim,
      }))
      const brain = await brainReply(text, brief)
      if (brain) replyText = brain
    }
    messages.push({
      id: nextId++,
      role: "assistant",
      text: replyText,
      offers: result.offers,
      proposal: result.intent === "cart" && quote.itemCount > 0,
    })
  } catch {
    messages.push({
      id: nextId++,
      role: "assistant",
      text: "I could not read the catalog. Nothing changed. Try that question again.",
      error: true,
      retry: text,
    })
  } finally {
    thinking = false
    renderThread()
    document.getElementById("ask")?.focus()
  }
}

function renderChat(): void {
  document.title = "NimiqMe · Commerce assistant in Nimiq Pay"
  root.innerHTML = shell(
    `<section class="hero">
      <p class="eyebrow">NimiqMe · Nimiq Pay</p>
      <h1 id="page-title" tabindex="-1">Ask for what you need.</h1>
      <p class="lede">I compare merchant offers and price the bag. You approve the total before the wallet opens.</p>
      <a class="btn merchant-main" href="#/merchant">Merchant onboarding</a>
    </section>
    <section class="thread" id="thread" role="log" aria-live="polite" aria-relevant="additions text"></section>
    <p class="sr-only" id="thread-status" role="status" aria-live="polite"></p>
    <form class="composer" id="composer">
      <label class="sr-only" for="ask">Ask NimiqMe</label>
      <input id="ask" name="ask" type="text" inputmode="text" maxlength="180" autocomplete="off" placeholder="A bag for a 14-inch laptop" />
      <button class="send" type="submit">Ask</button>
    </form>
    <p class="fine composer-fine">Prices settle in NIM. Payment opens in the Nimiq Pay wallet.</p>`,
    "chat"
  )

  const form = document.getElementById("composer") as HTMLFormElement | null
  const input = document.getElementById("ask") as HTMLInputElement | null
  if (form) {
    form.onsubmit = (event) => {
      event.preventDefault()
      if (input) void ask(input.value)
    }
  }
  renderThread()
  updateBagBadge()
  void loadPriceRates()
  void refreshWallet()
  focusTitle()
}

function cartRowHtml(line: Quote["lines"][number]): string {
  const offer = line.offer
  return `<article class="cart-row">
    <span class="tile" aria-hidden="true">${esc(initials(offer.title))}</span>
    <div class="row-main">
      <h2>${esc(offer.title)}</h2>
      <p>${esc(offer.merchant)} · ${offer.deliveryDays} ${offer.deliveryDays === 1 ? "day" : "days"} delivery</p>
      <div class="qty" role="group" aria-label="Quantity for ${esc(offer.title)}">
        <button type="button" data-action="dec" data-offer="${offer.id}" aria-label="Decrease quantity for ${esc(offer.title)}">−</button>
        <span aria-live="polite">${line.qty}</span>
        <button type="button" data-action="inc" data-offer="${offer.id}" aria-label="Increase quantity for ${esc(offer.title)}">+</button>
      </div>
    </div>
    <div class="row-end">
      <span class="price">${money(line.lineTotal)}</span>
      <button class="linklike" type="button" data-action="remove" data-offer="${offer.id}">Remove</button>
    </div>
  </article>`
}

function paintCart(focus?: { action: string; offerId: string }): void {
  const body = document.getElementById("cart-body")
  if (!body) return
  const quote = currentQuote()
  if (!quote.lines.length) {
    body.innerHTML = emptyState(
      "Your bag is empty.",
      "Ask for a product, a category, or a budget. I will price delivery before anything is added.",
      `<a class="btn" href="#/">Ask NimiqMe</a>`
    )
    updateBagBadge()
    return
  }

  const merchantNote =
    quote.merchants.length === 1
      ? `Sold by ${esc(quote.merchants[0])}`
      : `Sold by ${quote.merchants.length} merchants`

  body.innerHTML = `
    ${quote.dropped ? `<div class="notice" role="status">${quote.dropped} ${quote.dropped === 1 ? "item is" : "items are"} no longer listed and ${quote.dropped === 1 ? "was" : "were"} removed.</div>` : ""}
    <div class="cart-list">${quote.lines.map(cartRowHtml).join("")}</div>
    <div class="merchant-note">${merchantNote}</div>
    ${summaryHtml(quote)}
    ${
      quote.payable
        ? `<a class="btn" href="#/checkout">Continue to approval</a>
           <p class="fine">Nothing is charged yet. The next screen shows the exact total, the order reference, and the receiving address.</p>`
        : `<div class="state-error inline" role="alert" tabindex="-1">
            <span class="tag tag-danger">Checkout blocked</span>
            <h3>One merchant, one line per payment.</h3>
            <p>${esc(quote.blockedReason)}</p>
            <button class="btn btn-quiet" type="button" id="keep-first">Keep only the first item</button>
          </div>
          <p class="fine">A Nimiq transaction pays one address, so this bag cannot be settled as a single payment.</p>`
    }`

  const keepFirst = document.getElementById("keep-first")
  if (keepFirst) {
    keepFirst.onclick = () => {
      const first = quote.lines[0]
      if (!first) return
      try {
        writeCart([{ offerId: first.offer.id, qty: first.qty }])
        paintCart()
      } catch {
        body.innerHTML = errorState(
          "This device did not save the change.",
          "Allow site data for this page, then edit the bag again.",
          `<a class="linklike" href="#/">Back to chat</a>`
        )
      }
    }
  }

  body.onclick = (event) => {
    const target = event.target as HTMLElement
    const control = target.closest<HTMLButtonElement>("[data-action]")
    if (!control) return
    const action = control.dataset.action ?? ""
    const offerId = control.dataset.offer ?? ""
    try {
      if (action === "inc" || action === "dec") {
        const line = readCart().find((item) => item.offerId === offerId)
        if (!line) return
        const next = action === "inc" ? line.qty + 1 : line.qty - 1
        setQuantity(offerId, next)
        updateBagBadge()
        paintCart({ action: next > 0 ? action : "remove", offerId })
      }
      if (action === "remove") {
        removeFromCart(offerId)
        updateBagBadge()
        paintCart()
      }
    } catch {
      body.innerHTML = errorState(
        "This device did not save the change.",
        "Allow site data for this page, then edit the bag again.",
        `<a class="linklike" href="#/">Back to chat</a>`
      )
    }
  }

  if (focus) {
    const selector = `[data-action="${focus.action}"][data-offer="${focus.offerId}"]`
    body.querySelector<HTMLButtonElement>(selector)?.focus()
  }
  updateBagBadge()
}

function renderCart(): void {
  document.title = "Bag · NimiqMe"
  root.innerHTML = shell(
    `<a class="back" href="#/">← Ask NimiqMe</a>
    <section class="screen-head">
      <p class="eyebrow">Bag</p>
      <h1 id="page-title" tabindex="-1">Review the bag.</h1>
      <p class="lede">Change quantities, check delivery, then approve the total.</p>
    </section>
    <div id="cart-body">${loadingRows(2)}</div>`,
    "narrow"
  )
  updateBagBadge()
  void refreshWallet()
  focusTitle()
  window.setTimeout(() => {
    try {
      paintCart()
    } catch {
      const body = document.getElementById("cart-body")
      if (body) {
        body.innerHTML = errorState(
          "I could not read the bag on this device.",
          "Private browsing can block local storage. Allow site data, then try again.",
          `<a class="linklike" href="#/">Back to chat</a>`,
          "retry-cart"
        )
        const retry = document.getElementById("retry-cart")
        if (retry) retry.onclick = () => renderCart()
      }
    }
  }, 260)
}

/** The network the wallet is on, once the host has answered. */
function currentNetwork(): ExpectedNetwork | null {
  return wallet.kind === "ready" ? wallet.network : hostNetwork()
}

function accountAddress(): string {
  return wallet.kind === "ready" ? wallet.accounts[0] ?? "" : ""
}

/**
 * Turns the live bag into the immutable quote a payment is bound to.
 * Refuses anything this slice cannot pay safely.
 */
function makePaymentQuote(quote: Quote, checkoutRef: string, now: number) {
  const merchant = quote.merchants[0] ?? ""
  const network = currentNetwork()
  const recipient = merchant ? merchantRecipient(merchant, network) : { address: "", source: "none" }
  return buildQuote({
    checkoutRef,
    lines: quoteBagLines(quote) as QuoteBagLine[],
    merchant,
    recipient: recipient.address,
    network: network ?? "mainnet",
    now,
  })
}

/** Why checkout cannot run yet, in user words. Null means it can. */
function blockedPayment(quote: Quote): { reason: string; body: string; retry: boolean } | null {
  if (!quote.payable) {
    return {
      reason: "One merchant, one line per payment.",
      body: quote.blockedReason,
      retry: false,
    }
  }
  if (wallet.kind === "absent") {
    return {
      reason: "Payments run inside Nimiq Pay.",
      body: "Open this Mini App from Nimiq Pay to connect a wallet. The bag and quote stay saved here.",
      retry: false,
    }
  }
  if (wallet.kind === "denied") {
    return { reason: "The wallet did not open.", body: wallet.message, retry: true }
  }
  if (wallet.kind === "ready" && !wallet.accounts.length) {
    return {
      reason: "Nimiq Pay did not share an account.",
      body: "Choose an account in the wallet prompt, then check the wallet again.",
      retry: true,
    }
  }
  const merchant = quote.merchants[0] ?? "This merchant"
  const network = currentNetwork()
  const recipient = merchantRecipient(merchant, network)
  if (!recipient.address) {
    return {
      reason: `${merchant} has no receiving address on ${networkLabel(network)}.`,
      body: hasConfiguredStore()
        ? `The total is ready at ${money(quote.total)}, but no address is connected for ${merchant} on ${networkLabel(network)}. Nothing can be charged.`
        : `This build ships no mainnet receiving address for ${merchant}. A demo address is only wired up on testnet. Nothing can be charged.`,
      retry: false,
    }
  }
  return null
}

function balanceLine(): string {
  if (balance.kind === "ready") {
    return `<div><span>Wallet balance</span><b class="mono">${esc(formatNim(balance.luna))}</b></div>`
  }
  if (balance.kind === "loading") {
    return `<div><span>Wallet balance</span><b>Reading…</b></div>`
  }
  if (balance.kind === "error") {
    return `<div><span>Wallet balance</span><b class="text-danger">${esc(balance.message)}</b></div>`
  }
  return ""
}

function approvalHtml(quote: Quote, quoteResult: QuoteResult): string {
  const blocked = blockedPayment(quote)
  const paymentQuote = quoteResult.ok ? quoteResult.quote : null
  const recipient = paymentQuote?.recipient ?? ""
  const reference = paymentQuote?.checkoutRef ?? ""
  const secondsLeft = paymentQuote
    ? Math.max(0, Math.round((paymentQuote.expiresAt - Date.now()) / 1000))
    : 0
  const firstLine = quote.lines[0]
  return `<section class="approval" id="approval-card" aria-busy="false">
    <div class="approval-top">
      <span class="tag tag-accent">Approval</span>
      <span class="mono">${esc(networkLabel())}</span>
    </div>
    <h2>${paymentQuote?.items[0]?.qty ?? firstLine?.qty ?? quote.itemCount} × ${esc(paymentQuote?.items[0]?.title ?? firstLine?.offer.title ?? "this item")} from ${esc(quote.merchants[0] ?? "")}</h2>
    <ul class="approval-lines">
      ${quote.lines
        .map(
          (line) =>
            `<li><span>${line.qty} × ${esc(line.offer.title)}<small>${esc(line.offer.merchant)}</small></span><span class="mono">${money(line.lineTotal)}</span></li>`
        )
        .join("")}
    </ul>
    ${summaryHtml(quote)}
    <div class="pay-meta">
      <div><span>From</span><b>${accountAddress() ? esc(shortAddress(accountAddress())) : "No wallet account"}</b></div>
      <div><span>To</span><b>${recipient ? esc(shortAddress(recipient)) : "Not connected"}</b></div>
      <div><span>Network</span><b>${esc(networkLabel())}</b></div>
      <div><span>Order reference</span><b class="mono">${reference ? esc(reference) : "—"}</b></div>
      <div><span>Amount sent</span><b class="mono">${paymentQuote ? `${paymentQuote.amountMinor.toLocaleString("en")} luna` : "—"}</b></div>
      ${balanceLine()}
      ${
        paymentQuote
          ? `<div><span>Approval expires</span><b class="mono" id="quote-countdown">${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}</b></div>`
          : ""
      }
    </div>
    <div id="pay-status" role="status" aria-live="polite"></div>
    ${
      blocked
        ? `<div class="state-error inline" role="alert" tabindex="-1">
            <span class="tag tag-danger">Payment unavailable</span>
            <h3>${esc(blocked.reason)}</h3>
            <p>${esc(blocked.body)}</p>
            ${blocked.retry ? `<button class="btn" type="button" id="retry-wallet">Check wallet again</button>` : ""}
          </div>`
        : `<button class="btn" type="button" id="pay">Approve and pay ${money(quote.total)}</button>
           <p class="fine">This opens Nimiq Pay's approval screen. Funds move only after you approve there. The order reference <b class="mono">${esc(reference)}</b> is written into the transaction, so you can prove which order a payment belongs to.</p>
           <p class="fine">After approving, this page verifies the transaction on the ${esc(networkLabel())} explorer before it says Paid.</p>`
    }
    <a class="back inline-back" href="#/cart">← Back to bag</a>
  </section>`
}

/**
 * Voids the approval the user was shown, explains why, and paints a fresh
 * quote for the current bag. The old numbers can never be paid by an old click.
 */
function rearmApproval(quote: Quote, note: string): void {
  approvedQuote = null
  verificationPhase = "failed"
  verificationNote = note
  paintApproval(quote)
  renderPayStatus(document.getElementById("pay-status"))
}

function bindApproval(quote: Quote): void {
  const retryWallet = document.getElementById("retry-wallet")
  if (retryWallet) {
    retryWallet.onclick = () => {
      retryWallet.setAttribute("aria-busy", "true")
      void refreshWallet().then(() => paintApproval(quote))
    }
  }

  const pay = document.getElementById("pay") as HTMLButtonElement | null
  if (!pay || !approvedQuote) return

  pay.onclick = async () => {
    // Bind the module-level quote once: the closure must keep the same
    // amounts the user actually saw even if another render replaces it.
    const bound = approvedQuote
    if (!bound) return
    const card = document.getElementById("approval-card")
    const status = document.getElementById("pay-status")
    pay.disabled = true
    if (card) card.setAttribute("aria-busy", "true")

    // Re-check the captured quote against the live bag before signing.
    const live = currentQuote()
    const rebuilt = makePaymentQuote(live, bound.checkoutRef, bound.createdAt)
    if (!rebuilt.ok) {
      // The bag no longer converts to a payable quote at all (another tab
      // changed it). Void, show why, and let the user approve the new state.
      rearmApproval(live, rebuilt.failure.message)
      return
    }
    const drift = recheckQuote(bound, rebuilt.quote, Date.now())
    if (!drift.ok) {
      rearmApproval(live, drift.message)
      return
    }

    verificationPhase = "sending"
    if (status) {
      status.innerHTML = `<div class="loading-inline" role="status"><span class="spinner" aria-hidden="true"></span>Open Nimiq Pay and approve ${money(quote.total)}. Nothing moves until you do.</div>`
    }

    try {
      const result = await sendPayment({
        recipient: bound.recipient,
        amountMinor: bound.amountMinor,
        checkoutRef: bound.checkoutRef,
      })
      const record: PaymentRecord = {
        checkoutRef: bound.checkoutRef,
        txHash: result.txHash,
        status: "verifying",
        amountMinor: bound.amountMinor,
        recipient: bound.recipient,
        network: bound.network,
        merchant: bound.merchant,
        items: bound.items.map((item) => ({
          offerId: item.offerId,
          title: item.title,
          merchant: item.merchant,
          qty: item.qty,
          unitLuna: item.unitLuna,
        })),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        verifiedAt: null,
        explorerUrl: explorerTxUrl(bound.network, result.txHash),
        note: "Verifying against Nimiq mainnet. If the RPC cannot confirm this transaction yet, check again later.",
        checks: null,
      }
      try {
        savePayment(record)
      } catch {
        // Storage blocked: the payment page still verifies from the URL.
      }
      approvedQuote = null
      window.location.hash = `#/payment/${encodeURIComponent(record.checkoutRef)}`
    } catch (error) {
      if (card) card.setAttribute("aria-busy", "false")
      const payment =
        error instanceof PaymentError
          ? error
          : new PaymentError("UNKNOWN", "The wallet did not complete the payment.")
      verificationPhase = failureStage(payment.code) === "aftermath" ? "unconfirmed" : "failed"
      verificationNote = payment.message
      renderPayStatus(status)
      if (failureStage(payment.code) === "aftermath") {
        // Never offer a blind second send once the outcome is unknown.
        pay.disabled = true
        pay.textContent = "Outcome unknown — check the wallet"
      } else {
        restorePayButton(pay, quote)
      }
    }
  }
}

function restorePayButton(pay: HTMLButtonElement, quote: Quote): void {
  pay.disabled = false
  pay.textContent = `Approve and pay ${money(quote.total)}`
}

function renderPayStatus(slot: HTMLElement | null): void {
  if (!slot) return
  if (verificationPhase === "sending" || verificationPhase === "idle") return
  const dangerous = verificationPhase === "failed" || verificationPhase === "unconfirmed"
  slot.innerHTML = `<div class="${dangerous ? "state-error inline" : "notice"}" role="${dangerous ? "alert" : "status"}" tabindex="-1">
      <span class="tag ${dangerous ? "tag-danger" : "tag-accent"}">${verificationPhase === "unconfirmed" ? "Outcome unknown" : "Not sent"}</span>
      <p>${esc(verificationNote)}</p>
    </div>`
  slot.querySelector<HTMLElement>("[role='alert'], [role='status']")?.focus()
}

function paintApproval(quote: Quote): void {
  const body = document.getElementById("checkout-body")
  if (!body) return
  if (!approvedQuote) {
    const built = makePaymentQuote(quote, createCheckoutRef(), Date.now())
    approvedQuote = built.ok ? built.quote : null
    body.innerHTML = approvalHtml(quote, built)
    bindApproval(quote)
    startCountdown()
    return
  }
  const built = makePaymentQuote(quote, approvedQuote.checkoutRef, approvedQuote.createdAt)
  if (built.ok) approvedQuote = built.quote
  body.innerHTML = approvalHtml(quote, built)
  bindApproval(quote)
  startCountdown()
}

let countdownTimer: number | null = null

function startCountdown(): void {
  if (countdownTimer !== null) {
    globalThis.clearInterval(countdownTimer)
    countdownTimer = null
  }
  if (!approvedQuote) return
  countdownTimer = globalThis.setInterval(() => {
    const node = document.getElementById("quote-countdown")
    if (!node || !approvedQuote) {
      if (countdownTimer !== null) globalThis.clearInterval(countdownTimer)
      countdownTimer = null
      return
    }
    const left = Math.max(0, Math.round((approvedQuote.expiresAt - Date.now()) / 1000))
    node.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
    if (left === 0 && countdownTimer !== null) {
      globalThis.clearInterval(countdownTimer)
      countdownTimer = null
      void voidExpiredQuote()
    }
  }, 1000)
}

async function voidExpiredQuote(): Promise<void> {
  if (!approvedQuote) return
  approvedQuote = null
  verificationPhase = "failed"
  verificationNote = "This approval expired. Nothing was sent — review the total and approve a fresh quote."
  // Repaint through paintApproval so a fresh, in-date quote is built and the
  // Pay button is rebound — a hand-rolled render here left a dead button.
  const quote = currentQuote()
  const body = document.getElementById("checkout-body")
  if (!body) return
  paintApproval(quote)
  renderPayStatus(document.getElementById("pay-status"))
}

function renderCheckout(): void {
  document.title = "Approval · NimiqMe"
  root.innerHTML = shell(
    `<a class="back" href="#/cart">← Back to bag</a>
    <section class="screen-head">
      <p class="eyebrow">Approval</p>
      <h1 id="page-title" tabindex="-1">Approve the exact total.</h1>
      <p class="lede">Check the item, the receiving address, the order reference, and the network. Then approve in your wallet.</p>
    </section>
    <div id="checkout-body">${loadingRows(2)}</div>`,
    "narrow"
  )
  updateBagBadge()
  focusTitle()

  void (async () => {
    const quote = currentQuote()
    const body = document.getElementById("checkout-body")
    if (!body) return
    if (!quote.lines.length) {
      body.innerHTML = emptyState(
        "There is nothing to approve.",
        "Your bag is empty. Ask for a product first, then review the total.",
        `<a class="btn" href="#/">Ask NimiqMe</a>`
      )
      return
    }
    wallet = await walletState()
    paintWalletPill()
    if (accountAddress()) void refreshBalance()
    if (!document.getElementById("checkout-body")) return
    approvedQuote = null
    verificationPhase = "idle"
    verificationNote = ""
    paintApproval(quote)
  })()
}

function dateLabel(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso)
    )
  } catch {
    return iso
  }
}

function statusTag(status: PaymentRecord["status"]): string {
  if (status === "confirmed") return `<span class="tag tag-accent">Paid</span>`
  if (status === "failed") return `<span class="tag tag-danger">Not this payment</span>`
  if (status === "verifying") return `<span class="tag tag-warn">Verifying</span>`
  return `<span class="tag tag-warn">Pending</span>`
}

function headingFor(record: PaymentRecord): { title: string; body: string } {
  if (record.status === "confirmed") {
    return {
      title: "Verified on chain.",
      body: `Nimiq RPC confirmed inclusion, successful execution, recipient and amount on ${record.network}.`,
    }
  }
  if (record.status === "failed") {
    return {
      title: "This transaction is not the payment you approved.",
      body: record.note ?? "The explorer returned a transaction that does not match this checkout.",
    }
  }
  if (record.status === "verifying") {
    return {
      title: "Payment verifying.",
      body: record.note ?? "Checking the transaction with Nimiq mainnet. If it cannot be confirmed yet, check again later.",
    }
  }
  return {
    title: "Payment pending.",
    body: "The wallet returned a transaction hash. NimiqMe will only say Paid once the Nimiq RPC confirms inclusion, success, recipient and amount.",
  }
}

function checksListHtml(record: PaymentRecord, note: string | null): string {
  const checks = record.checks ?? []
  if (!checks.length) {
    return `<div class="verify-pending" role="status"><span class="spinner" aria-hidden="true"></span>${esc(
      note ?? "Checking the explorer…"
    )}</div>`
  }
  return `<ul class="check-list" aria-label="Verification checks">
    ${checks
      .map(
        (item) =>
          `<li class="${item.ok ? "check-ok" : "check-bad"}"><span aria-hidden="true">${item.ok ? "✓" : "✕"}</span><span class="check-label">${esc(item.label)}</span><span class="check-detail">${esc(item.detail)}</span></li>`
      )
      .join("")}
  </ul>`
}

function paymentHtml(record: PaymentRecord, liveNote: string | null): string {
  const heading = headingFor(record)
  const items = record.items.reduce((sum, item) => sum + item.unitLuna * item.qty, 0)
  const delivery = Math.max(0, record.amountMinor - items)
  const isLive = verificationPhase === "checking"
  return `<section class="receipt-card" aria-busy="${isLive ? "true" : "false"}">
    <div class="receipt-top">
      ${statusTag(record.status)}
      <span class="mono">${esc(dateLabel(record.updatedAt))}</span>
    </div>
    <h2>${esc(heading.title)}</h2>
    <p class="lede">${esc(heading.body)}</p>
    <div class="receipt-total">${esc(formatNim(record.amountMinor))}</div>
    <ul class="approval-lines">
      ${record.items
        .map(
          (item) => {
            const productImage = CATALOG.find((offer) => offer.id === item.offerId)?.imageUrl
            return `<li>${productImage ? `<img class="line-image" src="${esc(productImage)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}<span class="line-copy">${item.qty} × ${esc(item.title)}<small>${esc(item.merchant)}</small></span><span class="mono">${esc(formatNim(item.unitLuna * item.qty))}</span></li>`
          }
        )
        .join("")}
    </ul>
    <div class="summary summary-compact receipt-summary">
      <div class="summary-row"><span>Items</span><span>${esc(formatNim(items))}</span></div>
      <div class="summary-row"><span>Delivery</span><span>${delivery ? esc(formatNim(delivery)) : "Free"}</span></div>
      <div class="summary-row summary-total"><span>Total</span><span>${esc(formatNim(record.amountMinor))}</span></div>
    </div>

    <div class="section-head"><h3>Verification</h3><span class="mono">${esc(networkLabel(record.network))}</span></div>
    ${checksListHtml(record, liveNote ?? record.note)}

    <div class="pay-meta">
      <div><span>Order reference</span><b class="mono">${esc(record.checkoutRef)}</b></div>
      <div><span>Amount sent</span><b class="mono">${record.amountMinor.toLocaleString("en")} luna</b></div>
      <div><span>Paid to</span><b class="mono">${esc(formatAddress(record.recipient))}</b></div>
      <div><span>Merchant</span><b>${esc(record.merchant)}</b></div>
    </div>
    <div class="tx-row">
      <span>Transaction</span>
      <a class="mono" href="${esc(record.explorerUrl)}" target="_blank" rel="noreferrer">${esc(record.txHash.slice(0, 18))}…</a>
    </div>
    <p class="fine">Keep the reference for support. It is written into the transaction data, so the payment can be matched to this order on the explorer.</p>
    <div class="payment-actions">
      ${
        record.status === "pending"
          ? `<button class="btn" type="button" id="check-again" ${isLive ? "disabled" : ""}>${isLive ? "Checking…" : "Check again"}</button>`
          : ""
      }
      <button class="linklike" type="button" id="copy-ref">Copy reference</button>
    </div>
    ${
      record.status === "confirmed"
        ? `<a class="btn" href="#/">Ask for something else</a>`
        : `<a class="back inline-back" href="#/wallet">← Wallet</a>`
    }
  </section>`
}

let livePaymentNote: string | null = null

function paintPayment(ref: string, record: PaymentRecord): void {
  const body = document.getElementById("payment-body")
  if (!body) return
  body.innerHTML = paymentHtml(record, livePaymentNote)
  const copy = document.getElementById("copy-ref")
  if (copy) {
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(record.checkoutRef)
        copy.textContent = "Copied"
      } catch {
        copy.textContent = "Copy failed"
      }
      window.setTimeout(() => {
        copy.textContent = "Copy reference"
      }, 1800)
    }
  }
  const check = document.getElementById("check-again")
  if (check) check.onclick = () => void verifyRecord(ref)
}

function stopVerification(): void {
  if (verifyAbort) {
    verifyAbort.abort()
    verifyAbort = null
  }
  if (verificationPhase === "checking") verificationPhase = "idle"
  livePaymentNote = null
}

/**
 * Polls the explorer for one payment and records what it proved.
 * A payment is only ever marked confirmed from a verified transaction;
 * timeouts leave it pending so the user can check again. Nothing resends.
 */
async function verifyRecord(ref: string): Promise<void> {
  const record = findPaymentByRef(ref)
  if (!record) return
  if (record.status === "confirmed") {
    livePaymentNote = null
    paintPayment(ref, record)
    return
  }

  verifyAbort?.abort()
  verifyAbort = new AbortController()
  verificationPhase = "checking"
  livePaymentNote = `Looking up ${shortAddress(record.txHash)} on the ${record.network} explorer…`
  paintPayment(ref, record)

  const expected: ExpectedPayment = {
    txHash: record.txHash,
    checkoutRef: record.checkoutRef,
    amountMinor: record.amountMinor,
    recipient: record.recipient,
    network: record.network,
  }

  try {
    const outcome = await pollTransaction(expected, {
      signal: verifyAbort.signal,
      onAttempt: (attempt) => {
        livePaymentNote = `Check ${attempt}: waiting for ${REQUIRED_CONFIRMATIONS} confirmations on ${record.network}.`
        const slot = document.querySelector("#payment-body .verify-pending")
        if (slot && verificationPhase === "checking") slot.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(livePaymentNote)}`
      },
    })
    if (verifyAbort?.signal.aborted) return

    if (outcome.state === "confirmed") {
      verificationPhase = "confirmed"
      livePaymentNote = null
      const stored = patchPayment(ref, {
        status: "confirmed",
        note: null,
        checks: outcome.verdict.checks,
        verifiedAt: new Date().toISOString(),
      })
      for (const item of record.items) {
        try {
          removeFromCart(item.offerId)
        } catch {
          // A blocked storage write must not undo a verified payment.
        }
      }
      updateBagBadge()
      paintPayment(ref, stored ?? record)
      paintWalletPill()
      return
    }

    if (outcome.state === "unconfirmed" || outcome.state === "mismatch") {
      verificationPhase = "verifying"
      livePaymentNote = null
      const stored = patchPayment(ref, {
        status: "verifying",
        note: `${outcome.message} Check again later. Nothing proves this payment landed yet.`,
        checks: outcome.verdict?.checks ?? null,
      })
      paintPayment(ref, stored ?? record)
      return
    }
  } catch {
    verificationPhase = "unconfirmed"
    livePaymentNote = "The verification check itself failed. This order remains verifying. Check again later."
    const fallback = patchPayment(ref, { status: "verifying", note: livePaymentNote }) ?? findPaymentByRef(ref)
    if (fallback) paintPayment(ref, fallback)
  } finally {
    if (verificationPhase !== "checking") verifyAbort = null
  }
}

function renderPayment(ref: string): void {
  document.title = "Payment · NimiqMe"
  stopVerification()
  root.innerHTML = shell(
    `<a class="back" href="#/wallet">← Wallet</a>
    <section class="screen-head">
      <p class="eyebrow">Payment</p>
      <h1 id="page-title" tabindex="-1">Payment status.</h1>
    </section>
    <div id="payment-body">${loadingRows(1)}</div>`,
    "narrow"
  )
  focusTitle()
  updateBagBadge()

  window.setTimeout(() => {
    const body = document.getElementById("payment-body")
    if (!body) return
    let record: PaymentRecord | null = null
    try {
      record = findPaymentByRef(ref)
    } catch {
      record = null
    }
    if (!record) {
      body.innerHTML = emptyState(
        "No payment stored with that reference.",
        "It may belong to another device, or local storage is blocked here. The money itself is on the Nimiq network — the explorer link in the wallet history works from anywhere.",
        `<a class="btn" href="#/wallet">Open wallet</a>`
      )
      return
    }
    paintPayment(ref, record)
    // A payment that is still pending resumes verification on its own.
    if (record.status === "pending" || record.status === "verifying") void verifyRecord(ref)
  }, 240)
}

/**
 * Per-merchant receiving addresses, with where each one came from. This is the
 * honesty table: a `unknown` row means checkout for that merchant is blocked,
 * not that some other wallet gets the money.
 */
function merchantTableHtml(network: ExpectedNetwork | null): string {
  const rows = MERCHANTS.map((merchant) => {
    const resolved = merchantRecipient(merchant.name, network)
    const label =
      resolved.source === "none"
        ? `<span class="tag tag-warn">Unknown</span>`
        : resolved.source === "env"
          ? `<span class="tag tag-accent">Configured</span>`
          : resolved.source === "store_env"
            ? `<span class="tag tag-warn">Shared store</span>`
            : `<span class="tag tag-warn">Placeholder</span>`
    return `<tr>
      <td>${esc(merchant.name)}</td>
      <td class="mono">${resolved.address ? esc(shortAddress(resolved.address)) : "not set"}</td>
      <td>${label}</td>
    </tr>`
  })
  return `<table class="merchant-table">
    <caption class="sr-only">Receiving address per merchant on ${esc(networkLabel(network))}</caption>
    <thead><tr><th scope="col">Merchant</th><th scope="col">Receives on ${esc(networkLabel(network))}</th><th scope="col">Source</th></tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table>
  <p class="fine"><b>Placeholder</b> is a shared demo wallet, not owned by that merchant. <b>Unknown</b> means no address was ever supplied, so payment stays blocked. <b>Shared store</b> means <span class="mono">VITE_STORE_ADDRESS</span> is taking money for every merchant at once — fine for a single-store build, wrong for a marketplace. Real deployments set <span class="mono">VITE_MERCHANT_ADDRESS_*</span> per merchant.</p>`
}

function walletScreenBody(): string {
  if (wallet.kind === "ready") {
    const address = wallet.accounts[0] ?? ""
    const network = wallet.network
    return `<section class="wallet-card">
      <div class="approval-top">
        <span class="tag tag-accent">Connected</span>
        <span class="mono">${esc(networkLabel(network))}</span>
      </div>
      <h2>${address ? esc(shortAddress(address)) : "No account shared"}</h2>
      <div id="balance-slot">${balanceHtml()}</div>
      <div class="pay-meta">
        <div><span>Account</span><b class="mono">${address ? esc(formatAddress(address)) : "None"}</b></div>
      </div>
      <p class="fine">Nimiq Pay asks for approval on every payment. This Mini App never sees a private key.</p>
    </section>
    <section class="orders-block">
      <div class="section-head"><h2>Merchant addresses</h2></div>
      ${merchantTableHtml(network)}
    </section>`
  }
  if (wallet.kind === "denied") {
    return errorState(
      "The wallet did not open.",
      wallet.message,
      `<a class="linklike" href="#/">Back to chat</a>`,
      "retry-wallet-screen"
    )
  }
  if (wallet.kind === "absent") {
    return emptyState(
      "No wallet in this browser.",
      "Open this Mini App inside Nimiq Pay to connect a wallet, read a balance and pay. The catalog and bag still work here.",
      `<a class="btn" href="#/">Ask NimiqMe</a>`
    )
  }
  return loadingRows(1)
}

function paymentsListHtml(): string {
  let payments: PaymentRecord[] = []
  try {
    payments = readPayments()
  } catch {
    return `<p class="notice">Payments cannot be read on this device.</p>`
  }
  if (!payments.length) {
    return `<div class="orders-empty">
      <p>No payments yet.</p>
      <p>When you approve an order, its status lands here and stays until the explorer confirms it.</p>
    </div>`
  }
  return `<ul class="orders">${payments
    .map(
      (payment) =>
        `<li><a href="#/payment/${encodeURIComponent(payment.checkoutRef)}">
          <span><b>${esc(formatNim(payment.amountMinor))}</b><small>${esc(dateLabel(payment.updatedAt))} · ${esc(payment.checkoutRef)}</small></span>
          <span class="pill-status pill-${payment.status}">${payment.status}</span>
        </a></li>`
    )
    .join("")}</ul>`
}

function paintWallet(): void {
  const body = document.getElementById("wallet-body")
  if (!body) return
  let count = 0
  try {
    count = readPayments().length
  } catch {
    count = 0
  }
  body.innerHTML = `${walletScreenBody()}
    <section class="orders-block">
      <div class="section-head"><h2>Payments</h2><span class="mono">${count}</span></div>
      ${paymentsListHtml()}
    </section>`
  paintBalance()
  const retry = document.getElementById("retry-wallet-screen")
  if (retry) {
    retry.onclick = () => {
      const current = document.getElementById("wallet-body")
      if (current) current.innerHTML = loadingRows(1)
      void refreshWallet().then(() => paintWallet())
    }
  }
}

function renderPayLanding(code: string): void {
  document.title = "Pay · NimiqMe"
  const result = importPayableLink(`#/pay/${code}`)
  root.innerHTML = shell(
    `<section class="screen-head">
      <p class="eyebrow">Payment link</p>
      <h1 id="page-title" tabindex="-1">${result.ok ? "Review this item." : "This link cannot be used."}</h1>
      ${result.ok ? "" : `<p class="lede">${esc(result.reason)}</p>`}
    </section>
    ${result.ok ? `<article class="offer">
      <div class="offer-top"><span class="merchant">${esc(result.offer.merchant)}</span><span class="tag">${esc(categoryLabel(result.offer.category))}</span></div>
      <div class="offer-title"><h3>${esc(result.offer.title)}</h3><span class="price">${money(result.offer.priceNim)}</span></div>
      <p class="offer-blurb">${esc(result.offer.blurb)}</p>
      ${result.offer.stock !== undefined ? `<p class="fine">${result.offer.stock} in stock</p>` : ""}
      <div class="offer-foot"><a class="add" href="#/cart" data-add="${esc(result.offer.id)}">Add to bag</a></div>
    </article>` : `<a class="back" href="#/">← Ask NimiqMe</a>`}`,
    "narrow"
  )
  focusTitle()
  updateBagBadge()
  if (result.ok) {
    const button = root.querySelector<HTMLAnchorElement>("[data-add]")
    button?.addEventListener("click", (event) => {
      event.preventDefault()
      try {
        addToCart(result.offer.id)
      } catch {
        /* the bag reports storage problems on its own screen */
      }
      window.location.hash = "#/cart"
    })
  }
}

function renderMerchant(): void {
  document.title = "Merchant · NimiqMe"
  const stores = readStores()
  const listRows = stores.map((store) => `<li><span>${esc(store.name)}</span> <span class="mono">${esc(shortAddress(store.address))}</span> <span class="fine">${store.links.length} items</span> <button type="button" class="linklike" data-remove="${esc(store.name)}">Remove</button>
    <details><summary>Payable links</summary>${store.links.map((l) => `<p class="fine">${esc(l.title)}: <span class="mono">${esc(l.link)}</span></p>`).join("")}</details></li>`).join("")
  root.innerHTML = shell(
    `<a class="back" href="#/">← Ask NimiqMe</a>
    <section class="screen-head">
      <p class="eyebrow">Merchant</p>
      <h1 id="page-title" tabindex="-1">Onboard with one CSV.</h1>
      <p class="lede">Five columns: name, price, image_url, description, stock. Price is in NIM. Images are links you host, NimiqMe stores nothing. Up to ${MAX_ROWS} products.</p>
    </section>
    <form id="merchant-form" class="merchant-form">
      <label>Storefront name <input id="store-name" type="text" maxlength="60" required></label>
      <label>Receiving address (Nimiq) <input id="store-address" type="text" class="mono" required></label>
      <label>Product CSV <input id="store-csv" type="file" accept=".csv,text/csv" required></label>
      <p class="fine"><a href="sample-storefront.csv" download>Sample CSV</a></p>
      <button type="submit" class="add">Check and generate links</button>
    </form>
    <div id="merchant-report"></div>
    <section class="orders-block"><h2>Your storefronts</h2>${stores.length ? `<ul class="store-list">${listRows}</ul>` : `<p class="fine">None yet.</p>`}</section>
    <p class="fine"><a href="#/orders">Orders dashboard</a></p>`,
    "narrow"
  )
  focusTitle()
  updateBagBadge()
  const form = document.getElementById("merchant-form") as HTMLFormElement
  const report = document.getElementById("merchant-report")!
  let pending: ImportReport | null = null
  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    const name = (document.getElementById("store-name") as HTMLInputElement).value
    const address = (document.getElementById("store-address") as HTMLInputElement).value
    const file = (document.getElementById("store-csv") as HTMLInputElement).files?.[0]
    if (!file) return
    const text = await file.text()
    pending = buildListingReport(name, address, text)
    const bad = pending.errors.length
    const rows = pending.links.map(({ row, link }) => `<li><strong>${esc(row.name)}</strong> ${money(row.priceNim)} · ${row.stock} in stock <span class="mono fine">${esc(link)}</span></li>`).join("")
    const errs = pending.errors.map((e) => `<li>${e.line ? `line ${e.line}: ` : ""}${esc(e.message)}</li>`).join("")
    report.innerHTML = `<section class="orders-block">
      <h2>${pending.links.length} ready, ${bad} refused</h2>
      ${errs ? `<ul class="errors">${errs}</ul>` : ""}
      ${rows ? `<ul>${rows}</ul>` : ""}
      ${pending.links.length ? `<button type="button" class="add" id="publish-store">Publish storefront</button>` : ""}
      <p id="publish-note" class="fine"></p>
    </section>`
    report.querySelector("#publish-store")?.addEventListener("click", () => {
      if (!pending) return
      const result = publishStore(name, address, pending)
      const note = document.getElementById("publish-note")!
      note.textContent = result.refused || `Published ${result.published} items. They appear in the catalog on this device.`
      if (!result.refused) window.setTimeout(renderMerchant, 900)
    })
  })
  root.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      removeStore(button.dataset.remove ?? "")
      renderMerchant()
    })
  })
}

function renderOrders(): void {
  document.title = "Orders · NimiqMe"
  const records = readPayments().filter((record) => record.status === "confirmed" || record.status === "pending")
  const rows = records
    .map((record) => {
      const items = record.items.map((item) => `${esc(item.title)} x${item.qty}`).join(", ")
      const status = record.status === "confirmed" ? `<span class="tag tag-accent">Confirmed</span>` : `<span class="tag tag-warn">Pending</span>`
      return `<tr><td>${esc(record.merchant)}</td><td>${items}</td><td>${formatNim(record.amountMinor / LUNA_PER_NIM)}</td><td>${status}</td><td>${new Date(record.createdAt).toLocaleString()}</td><td class="mono">${esc(record.checkoutRef)}</td></tr>`
    })
    .join("")
  root.innerHTML = shell(
    `<a class="back" href="#/merchant">← Merchant</a>
    <section class="screen-head">
      <p class="eyebrow">Orders</p>
      <h1 id="page-title" tabindex="-1">Orders dashboard.</h1>
      <p class="lede">Payments this device has recorded, read from the same verified payment records as the wallet page. Confirmed means the explorer confirmed the transaction.</p>
    </section>
    ${records.length ? `<table class="merchant-table"><thead><tr><th scope="col">Merchant</th><th scope="col">Items</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Placed</th><th scope="col">Reference</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="fine">No payments recorded on this device yet.</p>`}`,
    "narrow"
  )
  focusTitle()
  updateBagBadge()
}

function renderWallet(): void {
  document.title = "Wallet · NimiqMe"
  stopVerification()
  root.innerHTML = shell(
    `<a class="back" href="#/">← Ask NimiqMe</a>
    <section class="screen-head">
      <p class="eyebrow">Wallet</p>
      <h1 id="page-title" tabindex="-1">Wallet, balance and payments.</h1>
      <p class="lede">The wallet lives in Nimiq Pay. This page reads the account balance, shows every merchant address, and tracks each payment until the explorer confirms it.</p>
    </section>
    <div id="wallet-body">${loadingRows(1)}</div>`,
    "narrow"
  )
  focusTitle()
  updateBagBadge()
  void refreshWallet().then(() => {
    if (!document.getElementById("wallet-body")) return
    paintWallet()
  })
}

function route(): void {
  void loadPriceRates()
  const hash = window.location.hash || "#/"
  window.scrollTo(0, 0)
  // Leaving the payment screen stops the poll; the record stays pending.
  if (!hash.startsWith("#/payment/")) stopVerification()
  if (hash.startsWith("#/payment/")) {
    renderPayment(decodeURIComponent(hash.slice("#/payment/".length)))
  } else if (hash.startsWith("#/receipt/")) {
    window.location.replace(`#/payment/${encodeURIComponent(decodeURIComponent(hash.slice("#/receipt/".length)))}`)
  } else if (hash === "#/cart") {
    renderCart()
  } else if (hash === "#/checkout") {
    renderCheckout()
  } else if (hash === "#/wallet") {
    renderWallet()
  } else if (hash.startsWith("#/pay/")) {
    renderPayLanding(hash.slice("#/pay/".length))
  } else if (hash === "#/merchant") {
    renderMerchant()
  } else if (hash === "#/orders") {
    renderOrders()
  } else {
    renderChat()
  }
}

loadSeedStorefronts()
loadPublishedStores()
window.addEventListener("hashchange", route)
route()
