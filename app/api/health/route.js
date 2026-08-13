// GET /api/health — quick liveness + catalog/facts status check.
import { catalogStatus } from '../../../lib/catalog';
import { factsStatus } from '../../../lib/facts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(
    { ok: true, service: 'sarah-product-lookup', catalog: catalogStatus(), facts: factsStatus() },
    { status: 200 }
  );
}
