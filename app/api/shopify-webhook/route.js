// POST /api/shopify-webhook
//
// Receives Shopify webhooks. On products/create and products/update we
// re-fetch products.json and replace the in-memory cache so Sarah always
// quotes live prices and availability.
//
// Security: every request is verified with an HMAC-SHA256 signature over the
// RAW request body, keyed by SHOPIFY_WEBHOOK_SECRET (the shared secret Shopify
// shows when you create the webhook), compared against the
// X-Shopify-Hmac-Sha256 header.

import crypto from 'node:crypto';
import { refreshCatalog } from '../../../lib/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function verifyHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const REFRESH_TOPICS = new Set(['products/create', 'products/update']);

export async function POST(req) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const hmacHeader = req.headers.get('x-shopify-hmac-sha256');
  const topic = req.headers.get('x-shopify-topic') || '';

  // Read the RAW body exactly as sent — required for a correct HMAC.
  const rawBody = await req.text();

  // Before go-live the secret may not be set yet. Acknowledge with 200 (so
  // Shopify doesn't hammer retries) but do nothing until it's configured.
  if (!secret) {
    return Response.json(
      { ok: false, reason: 'SHOPIFY_WEBHOOK_SECRET not configured yet' },
      { status: 200 }
    );
  }

  if (!verifyHmac(rawBody, hmacHeader, secret)) {
    // Reject unverified requests. Shopify treats 401 as a failed delivery.
    return Response.json({ ok: false, reason: 'invalid HMAC' }, { status: 401 });
  }

  // Only product create/update need a catalog refresh; ack everything else.
  if (REFRESH_TOPICS.has(topic)) {
    // Kick the refresh but don't block the 200 on it — Shopify wants a fast ack.
    refreshCatalog().catch((err) => {
      console.error('catalog refresh after webhook failed:', err);
    });
  }

  return Response.json({ ok: true, topic: topic || null }, { status: 200 });
}
