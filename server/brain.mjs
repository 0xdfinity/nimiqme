// NimiqMe brain proxy — the model keys live here, never in the mini app.
//
// A buyer-facing mini app cannot hold an API key safely (the WebView origin is
// not trusted and the bundle is public). So the app asks this tiny gateway, and
// only this gateway talks to the model. Primary Groq, fallback NVIDIA Nemotron,
// both OpenAI-compatible. It is a narration helper: the app already decides
// what is real from its own catalog; this only words the answer. Fail-closed —
// no key, no reach, or every provider down returns a clean error and the app
// keeps working on its local rule-based answers.
//
// Run:  node server/brain.mjs        (reads ./.env, listens BRAIN_PORT)
// Env:  BRAIN_PORT (8797), GROQ_API_KEY, NVIDIA_API_KEY, GROQ_MODEL,
//       NEMOTRON_MODEL, BRAIN_CORS (comma origins; empty = no cross-origin).

const PROVIDERS = () => {
  const list = [];
  if (process.env.GROQ_API_KEY)
    list.push({
      name: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
    });
  if (process.env.NVIDIA_API_KEY)
    list.push({
      name: "nemotron",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: process.env.NVIDIA_API_KEY,
      model: process.env.NEMOTRON_MODEL || "nvidia/llama-3.3-nemotron-super-49b-v1",
    });
  return list;
};

const SYSTEM =
  "You are NimiqMe, a shopping assistant inside a Nimiq Pay mini app. Answer in one or two short, plain sentences about the products given. Use only the listed offers, prices, and merchants. Never invent prices or stock. If there is no match, say so. Plain text only, no markdown.";

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return null;
  const kept = messages
    .filter((m) => m && ["system", "user", "assistant"].includes(m.role) && typeof m.content === "string" && m.content.length > 0 && m.content.length <= 4000)
    .slice(0, 20);
  return kept.length ? kept : null;
}

async function oneProvider(p, messages, fetchImpl, timeoutMs) {
  const res = await fetchImpl(`${p.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
    body: JSON.stringify({ model: p.model, messages, max_tokens: 400, temperature: 0.3 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${p.name} answered ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error(`${p.name} returned no text`);
  return { text: text.trim(), model: p.model };
}

/** Try each provider in order; first success wins. Never throws. */
export async function chatWithFallback(messages, opts = {}) {
  const kept = cleanMessages(messages);
  if (!kept) return { ok: false, error: "Send 1 to 20 message texts." };
  const providers = opts.providers ?? PROVIDERS();
  if (!providers.length) return { ok: false, error: "No brain configured." };
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const withSystem = [{ role: "system", content: SYSTEM }, ...kept];
  const failed = [];
  for (const p of providers) {
    try {
      const { text, model } = await oneProvider(p, withSystem, fetchImpl, timeoutMs);
      return { ok: true, text, model };
    } catch (e) {
      failed.push(e instanceof Error ? e.message : String(p.name));
    }
  }
  return { ok: false, error: `Brain unavailable (${failed.join(", ")}).` };
}

// ---- HTTP server (only when run directly) ---------------------------------
import { createServer } from "node:http"
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

function loadEnv() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const p = resolve(root, ".env")
  if (!existsSync(p)) return
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
  }
}

export function startServer() {
  loadEnv()
  const port = Number(process.env.BRAIN_PORT ?? "8797")
  const cors = (process.env.BRAIN_CORS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin
    const corsOn = Boolean(origin && (cors.includes(origin) || cors.includes("*")))
    if (corsOn) {
      res.setHeader("access-control-allow-origin", cors.includes("*") ? "*" : origin)
      res.setHeader("vary", "origin")
      res.setHeader("access-control-allow-headers", "content-type")
    }
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)) }
    if (req.method === "OPTIONS") { res.writeHead(corsOn ? 204 : 405); return res.end() }
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, providers: PROVIDERS().map((p) => p.name) })
    if (req.method !== "POST" || req.url !== "/v1/chat") return send(404, { error: "Unknown endpoint." })
    let raw = ""
    for await (const chunk of req) raw += chunk
    if (raw.length > 65536) return send(400, { error: "Body too large." })
    let body
    try { body = JSON.parse(raw || "{}") } catch { return send(400, { error: "Send JSON." }) }
    const result = await chatWithFallback(body.messages)
    if (!result.ok) return send(result.error === "No brain configured." ? 503 : 400, { error: result.error })
    return send(200, { text: result.text, model: result.model })
  })
  server.listen(port, () => console.log(JSON.stringify({ msg: `NimiqMe brain up. Port ${port}. Providers: ${PROVIDERS().map((p) => p.name).join(", ") || "none"}.` })))
  return server
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) startServer()
