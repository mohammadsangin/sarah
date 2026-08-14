# sarah-product-lookup

Live Shopify product-lookup API for **Sarah**, the Vapi voice assistant that
answers customer calls for [Kymra Lighting](https://kymralighting.co.uk).

Sarah calls this service mid-conversation to quote live prices, stock status
and key specs. The catalog is an in-memory cached copy of the store's public
`products.json`, kept fresh by Shopify webhooks (near-instant) with a scheduled
refresh as a safety net.

Built with Next.js App Router route handlers, deployed as Vercel serverless
functions.

## Endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/api/vapi-tool` | `lookup_product` tool-call endpoint — live product price/stock/specs. |
| `POST` | `/api/vapi-facts` | `lookup_policy` tool-call endpoint — delivery, returns, lead times, warranty. |
| `POST` | `/api/shopify-webhook` | Shopify `products/create` & `products/update` webhook → refresh cache. |
| `GET/POST` | `/api/refresh-catalog` | Scheduled/manual catalog re-sync (Vercel Cron). |
| `GET` | `/api/health` | Liveness + cache/facts status. |

### `POST /api/vapi-tool`

Expects a Vapi `ServerMessageToolCalls` payload:

```json
{ "message": { "toolCallList": [
  { "id": "<toolCallId>", "function": { "arguments": { "query": "<search text>" } } }
] } }
```

`arguments` may be an object or a JSON-encoded string; both are handled.

Always responds **HTTP 200** with:

```json
{ "results": [ { "toolCallId": "<echoed id>", "result": "<plain spoken string>" } ] }
```

The `result` is a short, spoken-language sentence (price, in/out of stock, key
specs) — never raw JSON or HTML, never a line break. Searches product `title`,
`handle`, `product_type`, `tags` and `vendor`. A miss returns a graceful
"could you describe it differently?" prompt rather than an error.

### `POST /api/vapi-facts`

Same Vapi `ServerMessageToolCalls` shape and same **HTTP 200 always** contract
as `/api/vapi-tool`, but answers company-policy questions — delivery cost and
the free-delivery threshold, delivery/lead times, returns & refunds, warranty,
whether a bulb is included, and VAT — from **version-controlled facts** in
`lib/facts.js`, not from an uploaded knowledge file.

Lead times are **maker-dependent** and encoded as explicit logic (not a single
value): Soho stock (2–3 working days) with the Palace Collection sockets as the
made-to-order exception (~5 weeks); Mullan is made to order across its whole
range and always quoted in weeks — standard 2–3, ceramics 4–6, bespoke 8–10,
with the clock starting from payment. An unknown maker gets the honest range
and a "which piece?" follow-up rather than a guess.

**Why this exists.** Sarah was giving wrong delivery/returns/lead-time answers
(e.g. "returns are 14 days", "I can't provide delivery costs") because a knowledge
file attached to the assistant was never actually read. In Vapi an uploaded
`.txt` is **not** injected into the prompt — it is only consulted when wired
into a *query tool* (a vector knowledge base), and even then semantic retrieval
is unreliable for short policy phrases. Product prices are correct because they
come from the `lookup_product` **function tool**, which returns a fixed spoken
string. This endpoint gives the policy facts the same deterministic treatment:
a `lookup_policy` function tool that can't fail to "retrieve."

The facts live in `lib/facts.js`. Confirmed values are filled in (free UK
delivery over £500, 30-day returns via the returns portal, not VAT registered,
maker lead times, Soho bulbs sold separately). Genuinely-variable values are
handled honestly rather than guessed: the sub-£500 delivery charge is unknown
(`null` → Sarah offers to confirm), and warranty varies by product (spoken as
"it varies — most Soho fittings 2 years, some switches up to 15" plus an offer
to confirm, never one committed figure). Numbers can be overridden with env
vars (`DELIVERY_FREE_THRESHOLD`, `DELIVERY_STANDARD_COST`, `RETURNS_WINDOW_DAYS`,
`WARRANTY_EXAMPLES`).

### `POST /api/shopify-webhook`

Verifies the `X-Shopify-Hmac-Sha256` signature over the **raw** body using
`SHOPIFY_WEBHOOK_SECRET`, then, for `products/create` / `products/update`,
re-fetches `products.json` and replaces the in-memory cache. Returns 200
quickly and does the refetch asynchronously.

- Secret not yet configured → 200 (acknowledged, no-op) so Shopify doesn't retry.
- Bad signature → 401.

## Catalog freshness strategy

1. **Cold start** — first request awaits a fresh `products.json` fetch.
2. **Webhook** — `products/*` webhooks refresh the cache within the receiving
   instance immediately.
3. **Stale-while-revalidate** — once the cache is older than `CATALOG_TTL_MS`
   (default 60 min) any request kicks a non-blocking background refresh.
4. **Cron safety net** — `vercel.json` schedules `/api/refresh-catalog` hourly.

> **Serverless note:** each Vercel instance holds its own in-memory cache, so a
> webhook only refreshes the instance that receives it. The TTL revalidation
> (step 3) keeps every other warm instance self-healing within `CATALOG_TTL_MS`.
> For guaranteed instant, cross-instance propagation, back the cache with a
> shared store (Vercel KV / Edge Config) — the fetch/normalize/search logic in
> `lib/catalog.js` is already isolated for that.

## Environment variables

| Var | Required | Notes |
| --- | -------- | ----- |
| `SHOPIFY_WEBHOOK_SECRET` | for webhook | Shared secret from Shopify when you create the webhook. |
| `VAPI_PRIVATE_KEY` | no (admin only) | Used only to register the tool / update the assistant; runtime endpoints don't read it. |
| `CRON_SECRET` | no | If set, `/api/refresh-catalog` requires `Authorization: Bearer <value>`. |
| `PRODUCTS_JSON_URL` | no | Defaults to `https://kymralighting.co.uk/products.json`. |
| `CATALOG_TTL_MS` | no | Background-revalidation age. Default `3600000` (60 min). |
| `CURRENCY_SYMBOL` | no | Default `£`. |

## Local development

```bash
npm install
npm run dev          # http://localhost:3000

# Fast logic + HMAC checks (spins up a fixture origin):
npm test
```

`test/` contains a `products.json` fixture, a tiny origin server, and a check
suite covering search, spoken-answer formatting, availability wording and HMAC
verification.

## Register the Vapi tools

- `scripts/register-vapi-tool.sh` — creates the `lookup_product` function tool
  (server URL → `/api/vapi-tool`), attaches it, and appends the "call
  `lookup_product` before answering" instruction to the system prompt.
- `scripts/register-vapi-facts-tool.sh` — same for the `lookup_policy` function
  tool (server URL → `/api/vapi-facts`), appending a "call `lookup_policy` for
  delivery/returns/lead-time/warranty — never guess" instruction.

## Diagnose & clean up the assistant

- `scripts/inspect-vapi-assistant.sh` — read-only dump of the assistant's
  system prompt, attached tools, and knowledge-base/file wiring. Confirms
  whether an uploaded facts file is actually retrievable (wired into a query
  tool) or just sitting unused.
- `scripts/audit-vapi-files.sh` — lists every file in the Vapi account, flags
  duplicate names (e.g. the nine `kymra-sarah-knowledge-base-v7.txt` copies),
  and with `--delete` removes the duplicates (keeps the newest of each name and
  refuses to delete any file still referenced by a query tool).
- `scripts/split-voice-text-assistants.mjs` — splits the single assistant into a
  voice assistant (the original, keeps the phone number + `transfer_to_human`)
  and a `Sarah — Text` copy for the chat widget, so voice/text escalation rules
  never contradict. It removes the "in text chat" sections from the voice prompt,
  removes the "on a call" and "Pronunciation Rules" sections plus the
  `transfer_to_human` tool from the text copy, and copies everything else
  (identity, price rule, facts, general rules, `lookup_products`) unchanged.
  Dry-run by default; `--apply` to write, `--selftest` to check the prompt
  surgery offline. Requires Node 18+.

All four scripts talk to `api.vapi.ai`, so run them from a machine with normal
outbound network access (see `DEPLOY.md`).
