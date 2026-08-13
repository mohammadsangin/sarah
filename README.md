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
the free-delivery threshold, delivery/lead times, returns & refunds, and
warranty — from **version-controlled facts** in `lib/facts.js`, not from an
uploaded knowledge file.

**Why this exists.** Sarah was giving wrong delivery/returns/lead-time answers
(e.g. "returns are 14 days", "I can't provide delivery costs") because a knowledge
file attached to the assistant was never actually read. In Vapi an uploaded
`.txt` is **not** injected into the prompt — it is only consulted when wired
into a *query tool* (a vector knowledge base), and even then semantic retrieval
is unreliable for short policy phrases. Product prices are correct because they
come from the `lookup_product` **function tool**, which returns a fixed spoken
string. This endpoint gives the policy facts the same deterministic treatment:
a `lookup_policy` function tool that can't fail to "retrieve."

The correct facts live in `lib/facts.js` — edit them there (free UK delivery
over £500 and 30-day returns are pre-filled; lead times, sub-threshold delivery
cost and warranty are `null` until you fill them in, and any `null` is spoken
as a graceful "let me confirm that for you" rather than a guess). Values can
also be overridden with env vars (`DELIVERY_FREE_THRESHOLD`,
`DELIVERY_STANDARD_COST`, `RETURNS_WINDOW_DAYS`, `LEAD_TIME_*`, `WARRANTY_YEARS`).

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

All four scripts talk to `api.vapi.ai`, so run them from a machine with normal
outbound network access (see `DEPLOY.md`).
