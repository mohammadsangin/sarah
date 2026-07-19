// GET /api/health — quick liveness + catalog status check.
import { catalogStatus } from '../../../lib/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(
    { ok: true, service: 'sarah-product-lookup', catalog: catalogStatus() },
    { status: 200 }
  );
}
