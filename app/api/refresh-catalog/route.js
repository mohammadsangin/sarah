// GET/POST /api/refresh-catalog
//
// The scheduled "safety net" refresh. Vercel Cron calls this on a schedule
// (see vercel.json) so the catalog stays fresh even if a webhook is ever
// missed. Also useful for a manual re-sync.
//
// If CRON_SECRET is set, requests must present it (Vercel Cron sends it
// automatically as an Authorization: Bearer header). If it's unset, the
// endpoint is open — fine for a low-risk read-only refresh.

import { refreshCatalog, catalogStatus } from '../../../lib/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get('authorization') || '';
  return auth === `Bearer ${secret}`;
}

async function run(req) {
  if (!authorized(req)) {
    return Response.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
  }
  try {
    await refreshCatalog();
    return Response.json({ ok: true, status: catalogStatus() }, { status: 200 });
  } catch (err) {
    return Response.json(
      { ok: false, error: String(err && err.message ? err.message : err) },
      { status: 500 }
    );
  }
}

export async function GET(req) {
  return run(req);
}

export async function POST(req) {
  return run(req);
}
