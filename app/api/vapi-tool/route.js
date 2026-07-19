// POST /api/vapi-tool
//
// The tool-call endpoint Vapi hits during a live call. Vapi sends a
// ServerMessageToolCalls payload:
//
//   { "message": { "toolCallList": [
//       { "id": "<toolCallId>", "function": { "arguments": { "query": "<text>" } } }
//   ] } }
//
// We must always return HTTP 200 with:
//
//   { "results": [ { "toolCallId": "<id>", "result": "<plain spoken string>" } ] }

import { ensureCatalog, buildAnswer, oneLine } from '../../../lib/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Vapi has shifted field names across versions. Pull the tool calls out of
// whichever shape arrived.
function extractToolCalls(body) {
  const msg = body && body.message ? body.message : body || {};
  const list = msg.toolCallList || msg.toolCalls || msg.tool_calls || [];
  return Array.isArray(list) ? list : [];
}

// The tool-call id can live under a few keys depending on Vapi version.
function extractId(call) {
  return call.id || call.toolCallId || (call.function && call.function.id) || null;
}

// "arguments" may be an object or a JSON-encoded string. The caller's search
// text lives under `query` (fall back to other common keys, or the whole
// arguments string if it's just plain text).
function extractQuery(call) {
  const fn = call.function || call.parameters || call;
  let args = fn && fn.arguments !== undefined ? fn.arguments : fn;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (trimmed.startsWith('{')) {
      try {
        args = JSON.parse(trimmed);
      } catch {
        return trimmed; // plain string argument
      }
    } else {
      return trimmed;
    }
  }
  if (args && typeof args === 'object') {
    return args.query || args.q || args.search || args.text || args.product || '';
  }
  return '';
}

async function handle(body) {
  const calls = extractToolCalls(body);

  // Load the catalog (awaits a fresh fetch on cold start, then reuses cache).
  let products = [];
  try {
    products = await ensureCatalog();
  } catch (err) {
    // Never fail the call: give Sarah something graceful to say.
    const fallback = oneLine(
      "I'm having trouble reaching our live product list right now, so I can't confirm that detail. Please try again in a moment, or I can take your details and have someone follow up."
    );
    return {
      results: (calls.length ? calls : [{}]).map((c) => ({
        toolCallId: extractId(c) || 'unknown',
        result: fallback,
      })),
    };
  }

  const results = (calls.length ? calls : [{}]).map((call) => {
    const toolCallId = extractId(call) || 'unknown';
    const query = extractQuery(call);
    const result = query
      ? buildAnswer(query, products)
      : oneLine(
          "I didn't catch which product you meant. Could you tell me the product name, the type of light, or a feature you're after?"
        );
    return { toolCallId, result };
  });

  return { results };
}

export async function POST(req) {
  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const payload = await handle(body);
  // Always 200 so Vapi delivers the spoken result to the caller.
  return Response.json(payload, { status: 200 });
}

// A GET is handy for a quick manual sanity check in the browser.
export async function GET() {
  return Response.json(
    { ok: true, endpoint: 'vapi-tool', hint: 'POST a Vapi ServerMessageToolCalls payload here.' },
    { status: 200 }
  );
}
