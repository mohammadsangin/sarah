// POST /api/vapi-facts
//
// The tool-call endpoint Vapi hits for the `lookup_policy` function tool —
// company facts: delivery cost, lead times, returns and warranty. It mirrors
// /api/vapi-tool (same Vapi ServerMessageToolCalls shape, same 200-always
// contract) but answers from lib/facts.js instead of the product catalog.
//
// Vapi sends:
//   { "message": { "toolCallList": [
//       { "id": "<toolCallId>", "function": { "arguments": { "query": "<text>" } } }
//   ] } }
//
// We must always return HTTP 200 with:
//   { "results": [ { "toolCallId": "<id>", "result": "<plain spoken string>" } ] }

import { buildFactsAnswer, oneLine } from '../../../lib/facts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Vapi has shifted field names across versions; pull tool calls out of
// whichever shape arrived. (Kept in sync with app/api/vapi-tool/route.js.)
function extractToolCalls(body) {
  const msg = body && body.message ? body.message : body || {};
  const list = msg.toolCallList || msg.toolCalls || msg.tool_calls || [];
  return Array.isArray(list) ? list : [];
}

function extractId(call) {
  return call.id || call.toolCallId || (call.function && call.function.id) || null;
}

// "arguments" may be an object or a JSON-encoded string; the caller's question
// lives under `query` (fall back to other common keys, or a plain string).
function extractQuery(call) {
  const fn = call.function || call.parameters || call;
  let args = fn && fn.arguments !== undefined ? fn.arguments : fn;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (trimmed.startsWith('{')) {
      try {
        args = JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
    } else {
      return trimmed;
    }
  }
  if (args && typeof args === 'object') {
    return args.query || args.q || args.search || args.text || args.topic || '';
  }
  return '';
}

function handle(body) {
  const calls = extractToolCalls(body);
  const results = (calls.length ? calls : [{}]).map((call) => {
    const toolCallId = extractId(call) || 'unknown';
    const query = extractQuery(call);
    // Even an empty query gets a helpful spoken menu, not an error.
    const result = buildFactsAnswer(query);
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
  // buildFactsAnswer never throws and needs no network, but stay defensive so
  // the phone line never gets a non-200.
  let payload;
  try {
    payload = handle(body);
  } catch {
    payload = {
      results: [
        {
          toolCallId: 'unknown',
          result: oneLine(
            "I can't confirm that detail right now. I can take your details and have a colleague follow up."
          ),
        },
      ],
    };
  }
  return Response.json(payload, { status: 200 });
}

// A GET is handy for a quick manual sanity check in the browser.
export async function GET() {
  return Response.json(
    { ok: true, endpoint: 'vapi-facts', hint: 'POST a Vapi ServerMessageToolCalls payload here.' },
    { status: 200 }
  );
}
