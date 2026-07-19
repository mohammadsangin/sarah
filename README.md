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
| `POST` | `/api/vapi-tool` | Tool-call endpoint Vapi hits during a live call. |
| `POST` | `/api/shopify-webhook` | Shopify `products/create` & `products/update` webhook → refresh cache. |
| `GET/POST` | `/api/refresh-catalog` | Scheduled/manual catalog re-sync (Vercel Cron). |
| `GET` | `/api/health` | Liveness + cache status. |

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

## Register the Vapi tool

See `scripts/register-vapi-tool.sh` — creates the `lookup_product` function
tool, points its server URL at the deployed `/api/vapi-tool`, attaches it to
the assistant, and appends the "call `lookup_product` before answering"
instruction to the system prompt.
