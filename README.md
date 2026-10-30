# NimiqMe

NimiqMe is an AI shopping agent for Nimiq Pay. You describe what you want, the agent compares merchant offers and builds one cart, and you approve a single NIM payment in your wallet. An order is only shown as paid once the transaction is verified by Nimiq mainnet RPC.

Website: http://nimiqme.vercel.app

walkthrough video: https://youtu.be/AwgmhofP25w?si=ZmiQbbT0ENsPsAPM

## Features

- Plain-language shopping: budget, category and product words are read locally against a curated catalog of offers from several merchants.
- One quote per order: the total is calculated from the live bag and bound to an immutable quote. Any price or stock drift voids the approval instead of silently re-pricing it.
- Wallet-only approval: funds move only after you approve the exact total in Nimiq Pay. The app never holds a private key.
- Nimiq RPC verification: a payment remains verifying unless mainnet RPC confirms inclusion, successful execution, recipient and amount. Unknown schemas and RPC errors fail closed.
- Honest states: pending, confirmed, failed, and unconfirmed. A timeout is shown as unconfirmed with an explorer link and is never re-sent.
- Merchant onboarding: a five-column CSV (name, price, image URL, description, stock) is validated row by row with line-numbered errors, then turned into payable links and an orders view.
- Optional language model: a small gateway can re-word answers through Groq, with NVIDIA Nemotron as fallback. The app works fully without it.

## Architecture

- `src/main.ts`: single-page mini app with routes for chat, bag, approval, payment and wallet.
- `src/assistant.ts`, `src/catalog.ts`, `src/cart.ts`, `src/quote.ts`: ranking, pricing and immutable quotes.
- `src/reference.ts`: order reference encoding.
- `src/nimiq.ts`: wallet interaction through the Nimiq Mini App SDK.
- `src/verify.ts`: Nimiq mainnet RPC polling and payment verification.
- `src/payment-state.ts`: persisted payment state.
- `src/merchant.ts`, `src/merchant-ui.ts`: CSV parsing, payable links, merchant dashboard.
- `server/brain.mjs`: optional model gateway. Keys live on the server only.
- `website/`: static marketing page.

## Tech stack

- Nimiq Pay Mini Apps SDK (`@nimiq/mini-app-sdk`)
- Nimiq explorer API (mainnet and testnet)
- TypeScript and Vite
- Groq and NVIDIA Nemotron through the optional gateway

## Getting started

Requirements: Node.js 22 or newer.

```bash
git clone https://github.com/0xdfinity/nimiqme.git
cd nimiqme
npm install
cp .env.example .env
npm run dev
```

Open the printed local address. For a real payment, open the app inside Nimiq Pay with a funded account.

## Scripts

```bash
npm run dev       # start the mini app
npm run build     # type-check and build to dist/
npm run preview   # serve the production build
npm run brain     # start the optional model gateway on BRAIN_PORT
npm test          # payment, brain and merchant test suites
```

## Configuration

All variables are documented in `.env.example`. Every value is optional for local development. Mainnet checkout stays blocked until a merchant receiving address is configured, so funds are never routed to an unrelated wallet.

## License

MIT. See `LICENSE`.
