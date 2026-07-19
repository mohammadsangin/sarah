# Go-live runbook

The code is built, tested, and pushed. The remaining steps talk to Vercel,
Vapi, and Shopify — external services that must be reached from a machine with
normal outbound network access (they were blocked from the build environment).
Each step below is a couple of commands.

## 1. Deploy to Vercel

**Option A — Vercel CLI (uses your token):**

```bash
npm i -g vercel
cd sarah            # repo root (this project)

# Authenticate non-interactively with your token:
export VERCEL_TOKEN="vck_********"          # the token you provided

vercel link --yes --project sarah-product-lookup --token "$VERCEL_TOKEN"
vercel deploy --prod --yes --token "$VERCEL_TOKEN"
```

**Option B — Dashboard:** New Project → Import Git Repository →
`mohammadsangin/sarah`, branch `claude/sarah-product-lookup-q1p9jr`. Framework
is auto-detected as Next.js.

After deploying, your endpoints are:

- `https://<deployment>/api/vapi-tool`         (Vapi tool-call endpoint)
- `https://<deployment>/api/shopify-webhook`   (register this in Shopify)
- `https://<deployment>/api/refresh-catalog`   (hourly cron, auto-configured)
- `https://<deployment>/api/health`            (status check)

Verify:

```bash
curl -s https://<deployment>/api/health
curl -s -X POST https://<deployment>/api/vapi-tool \
  -H 'content-type: application/json' \
  -d '{"message":{"toolCallList":[{"id":"t1","function":{"arguments":{"query":"Carlisle Trine wall light"}}}]}}'
```

## 2. Set environment variables (do not hardcode secrets)

```bash
# Shopify webhook signing secret — paste the value Shopify gives you in step 4.
vercel env add SHOPIFY_WEBHOOK_SECRET production --token "$VERCEL_TOKEN"

# Vapi private key (admin/registration convenience; runtime endpoints don't use it).
vercel env add VAPI_PRIVATE_KEY production --token "$VERCEL_TOKEN"

# Optional: protect the cron refresh endpoint.
vercel env add CRON_SECRET production --token "$VERCEL_TOKEN"

# Redeploy so the new env vars take effect:
vercel deploy --prod --yes --token "$VERCEL_TOKEN"
```

## 3. Register the Vapi tool + attach to the assistant

```bash
export VAPI_PRIVATE_KEY="d928aa47-****"                 # your Vapi private key
export VAPI_TOOL_URL="https://<deployment>/api/vapi-tool"
export ASSISTANT_ID="f67cfb35"                          # use the full assistant UUID

./scripts/register-vapi-tool.sh
```

This creates the `lookup_product` function tool (one `query` string parameter),
points its server URL at your deployment, attaches it to the assistant, and
appends to the assistant's system prompt:

> If the caller asks about products, prices, availability, or specs, call
> lookup_product before answering — never guess.

## 4. Register the Shopify webhook

In Shopify admin → **Settings → Notifications → Webhooks** (or via the Admin
API), create two webhooks:

- Event: **Product creation** → URL: `https://<deployment>/api/shopify-webhook`
- Event: **Product update**   → URL: `https://<deployment>/api/shopify-webhook`

Format JSON. Copy the **signing secret** Shopify shows and set it as
`SHOPIFY_WEBHOOK_SECRET` (step 2), then redeploy. Until that secret is set the
webhook endpoint returns 200 but does nothing (it won't error or retry-storm).

## Done

Once steps 1–4 are complete, Sarah will call `lookup_product` during calls and
the catalog will refresh within seconds of any product create/update in Shopify.
