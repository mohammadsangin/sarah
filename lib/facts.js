// Canonical company facts for the Sarah voice assistant — delivery, lead
// times, returns, warranty, bulbs and VAT.
//
// WHY THIS EXISTS (the bug it fixes):
// Sarah gave wrong answers about delivery cost, lead times and returns even
// though a knowledge file (kymra-customer-facts-v1.txt) was attached to the
// assistant. In Vapi an attached .txt is NOT injected into the prompt — it is
// only consulted when wired into a *query tool* (a vector knowledge base), and
// even then the semantic retrieval is unreliable for short policy phrases. So
// the file was effectively never read, and Sarah fell back to guessing (e.g.
// "returns are 14 days", "I can't provide delivery costs").
//
// Product prices are correct because they come from `lookup_product`, a
// function tool that returns a fixed spoken string — no retrieval guesswork.
// This module gives the company facts the same deterministic treatment: a
// `lookup_policy` function tool (served by /api/vapi-facts) that returns a
// short spoken sentence. Facts live here in version control — reviewable,
// testable, and impossible to "not retrieve".
//
// ─────────────────────────────────────────────────────────────────────────
// EDITING FACTS
// Values marked "confirmed" are the correct Kymra facts. Values left `null`
// are genuinely unknown/variable and are spoken as a graceful hand-off ("let
// me confirm that for you") rather than a guess — a blank can never become a
// wrong answer to a customer. Numbers can also be overridden with env vars
// without a code change (see the envNum/envStr reads).
//
// Lead times are maker-dependent, so they are encoded as explicit logic in
// leadTimeAnswer() rather than a single value — see that function.
// ─────────────────────────────────────────────────────────────────────────

const CURRENCY = process.env.CURRENCY_SYMBOL || '£';

const envNum = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const envStr = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};

const FACTS = {
  delivery: {
    freeThreshold: envNum('DELIVERY_FREE_THRESHOLD', 500), // free UK delivery over this (confirmed)
    standardCost: envNum('DELIVERY_STANDARD_COST', null), // sub-threshold charge — genuinely unknown, keep null
    ukOnly: true,
  },
  returns: {
    windowDays: envNum('RETURNS_WINDOW_DAYS', 30), // 30 days (confirmed — NOT 14)
    condition: envStr('RETURNS_CONDITION', 'unused and in their original condition'),
    channel: envStr(
      'RETURNS_CHANNEL',
      'through our returns portal rather than by post to the office'
    ),
  },
  warranty: {
    // Genuinely varies by product, so we never commit to a single figure.
    // These reference points are spoken as examples framed as "it varies",
    // always with an offer to confirm the exact cover. Set examples to null
    // (or WARRANTY_EXAMPLES="") for a pure hand-off with no numbers.
    examples: envStr(
      'WARRANTY_EXAMPLES',
      'most Soho Lighting fittings carry a 2-year warranty, and some switches are covered for up to 15 years'
    ),
  },
  bulbs: {
    // Most Soho fittings do NOT include a bulb; Mullan varies by piece.
    sohoIncludesBulb: false,
  },
  vat: {
    registered: false, // Kymra is not VAT registered — listed price is the full amount paid
  },
};

// --- money formatting ------------------------------------------------------

function money(amount) {
  if (amount == null) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return `${CURRENCY}${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
}

// Normalize a query to " token token " form for whole-word cue matching.
function norm(s) {
  return ` ${String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}
function has(q, cue) {
  // cue may be a phrase; match on word boundaries via the padded string.
  return q.includes(` ${cue} `) || q.includes(` ${cue}`) || q.includes(`${cue} `);
}

// --- topic classification --------------------------------------------------
//
// Deterministic, network-free. Each topic scores by how many of its cues the
// query contains (multi-word cues weigh more). Ties are broken by the priority
// order in TOPIC_ORDER so specific topics (returns, vat, bulbs) win over the
// broad delivery/lead-time split.

const CUES = {
  returns: [
    'return', 'returns', 'refund', 'refunds', 'send it back', 'send them back',
    'send back', 'exchange', 'faulty', 'damaged', 'cancel my order',
    'cancel the order', 'change my mind', 'unwanted', 'returns portal',
  ],
  vat: ['vat', 'tax', 'vat invoice', 'vat registered', 'including vat', 'inc vat', 'plus vat', 'ex vat'],
  bulbs: [
    'bulb', 'bulbs', 'lightbulb', 'light bulb', 'lamp included', 'include a bulb',
    'includes a bulb', 'comes with a bulb', 'does it come with', 'bulb included',
  ],
  warranty: ['warranty', 'guarantee', 'guaranteed', 'guarantees'],
  leadTime: [
    'how long', 'lead time', 'lead times', 'when will', 'when do', 'when can',
    'arrive', 'arrives', 'arriving', 'dispatch', 'dispatched', 'working days',
    'how soon', 'get here', 'delivery time', 'take to arrive', 'made to order',
    'how many days', 'how many weeks', 'turnaround', 'ready', 'in stock',
    // maker/collection names imply a lead-time question in context:
    'soho', 'mullan', 'palace', 'bespoke', 'ceramic', 'ceramics',
  ],
  delivery: [
    'how much', 'cost', 'costs', 'charge', 'charges', 'free delivery',
    'free shipping', 'delivery cost', 'shipping cost', 'postage',
    'price of delivery', 'delivery charge', 'flat rate', 'free over',
  ],
};
// Broad tokens that nudge a bare "delivery?" toward the cost answer.
const DELIVERY_BASE = ['delivery', 'deliver', 'delivered', 'shipping', 'ship', 'send it to me'];
// Tie-break priority (earlier wins).
const TOPIC_ORDER = ['returns', 'vat', 'bulbs', 'warranty', 'leadTime', 'delivery'];

function scoreCues(q, cues) {
  let score = 0;
  for (const cue of cues) {
    if (has(q, cue)) score += cue.includes(' ') ? 3 : 1;
  }
  return score;
}

function classify(query) {
  const q = norm(query);
  const scores = {
    returns: scoreCues(q, CUES.returns),
    vat: scoreCues(q, CUES.vat),
    bulbs: scoreCues(q, CUES.bulbs),
    warranty: scoreCues(q, CUES.warranty),
    leadTime: scoreCues(q, CUES.leadTime),
    delivery: scoreCues(q, CUES.delivery),
  };
  // A bare mention of delivery/shipping (no explicit time cue) leans to cost.
  if (scores.leadTime === 0 && DELIVERY_BASE.some((c) => has(q, c))) scores.delivery += 1;

  let best = null;
  let bestScore = 0;
  for (const topic of TOPIC_ORDER) {
    if (scores[topic] > bestScore) {
      bestScore = scores[topic];
      best = topic;
    }
  }
  return bestScore > 0 ? best : null;
}

// --- spoken-answer builders ------------------------------------------------

function deliveryAnswer() {
  const d = FACTS.delivery;
  const threshold = money(d.freeThreshold);
  if (!threshold) return `I can confirm our delivery charges for you — one moment.`;
  const std = money(d.standardCost);
  if (std) {
    return `UK delivery is free on all orders over ${threshold}. For orders under that, standard UK delivery is ${std}.`;
  }
  return `UK delivery is free on all orders over ${threshold}. For orders below that there's a standard delivery charge, and I can confirm the exact amount for you if you'd like.`;
}

// Lead times are maker/collection-specific. We read the maker from the query;
// Sarah is instructed (system prompt) to include the product or maker when she
// asks. Mullan is made to order across its whole range and is always quoted in
// WEEKS, never days.
function leadTimeAnswer(query) {
  const q = norm(query);
  const mullan = has(q, 'mullan');
  const soho = has(q, 'soho');
  const palace = has(q, 'palace');
  const ceramic = has(q, 'ceramic') || has(q, 'ceramics');
  const bespoke = has(q, 'bespoke');

  if (mullan) {
    let range;
    if (ceramic) range = 'around 4 to 6 weeks';
    else if (bespoke) range = 'around 8 to 10 weeks';
    else range = 'around 2 to 3 weeks';
    return `Mullan Lighting pieces are all made to order, so that's ${range}. The lead time runs from the date payment is received, not the date the order is placed.`;
  }

  if (palace) {
    // Palace Collection sockets are the made-to-order exception within Soho.
    return `The Soho Lighting Palace Collection sockets are made to order, so those take approximately 5 weeks. Most other Soho pieces are in stock and arrive within 2 to 3 working days.`;
  }

  if (soho) {
    return `Most Soho Lighting pieces are in stock and arrive within 2 to 3 working days. The one exception is the Palace Collection sockets, which are made to order at approximately 5 weeks.`;
  }

  // Ceramic/bespoke named without a maker, or maker unknown: give the honest
  // span and ask which piece.
  return `Lead times depend on the piece. Stocked items, like most Soho Lighting, arrive within 2 to 3 working days, while made-to-order pieces such as Mullan Lighting run from 2 to 3 weeks up to 8 to 10 weeks for bespoke. Which piece did you have in mind, so I can give you the exact timing?`;
}

function returnsAnswer() {
  const r = FACTS.returns;
  if (!r.windowDays) return `I can confirm our returns policy for you — one moment.`;
  let s = `You can return items within ${r.windowDays} days of delivery for a refund`;
  s += r.condition ? `, as long as they're ${r.condition}.` : `.`;
  if (r.channel) s += ` Returns are handled ${r.channel}.`;
  return s;
}

function warrantyAnswer() {
  const w = FACTS.warranty;
  if (w.examples) {
    return `Warranty cover varies by product — ${w.examples}. I can confirm the exact warranty for your specific item.`;
  }
  return `Warranty cover varies by product, so let me confirm the exact cover for your item — I'll check and come back to you.`;
}

function bulbsAnswer(query) {
  const q = norm(query);
  if (has(q, 'mullan')) {
    return `Whether a bulb's included varies across the Mullan Lighting range, so it's best to check the specific product page.`;
  }
  return `Most of our Soho Lighting fittings don't include a bulb — bulbs are sold separately. For Mullan Lighting it varies by piece, so it's worth checking the product page.`;
}

function vatAnswer() {
  if (FACTS.vat.registered) {
    return `Prices include VAT.`;
  }
  return `Kymra Lighting isn't VAT registered, so the listed price is the full amount you pay — there's no VAT added at checkout, and we don't issue a VAT invoice.`;
}

// Build a short, spoken-language answer. Never returns JSON/HTML or newlines.
// An unclassifiable query returns a helpful menu rather than a guess.
function buildFactsAnswer(query) {
  const topic = classify(query);
  let answer;
  switch (topic) {
    case 'delivery': answer = deliveryAnswer(); break;
    case 'leadTime': answer = leadTimeAnswer(query); break;
    case 'returns': answer = returnsAnswer(); break;
    case 'warranty': answer = warrantyAnswer(); break;
    case 'bulbs': answer = bulbsAnswer(query); break;
    case 'vat': answer = vatAnswer(); break;
    default:
      answer =
        "I can help with delivery, lead times, returns, warranty, bulbs and VAT. Which of those would you like to know about?";
  }
  return oneLine(answer);
}

function oneLine(s) {
  return String(s).replace(/\s*[\r\n]+\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function factsStatus() {
  return {
    deliveryFreeThreshold: FACTS.delivery.freeThreshold,
    deliveryStandardCostSet: FACTS.delivery.standardCost != null,
    returnsWindowDays: FACTS.returns.windowDays,
    warrantyExamplesSet: !!FACTS.warranty.examples,
    vatRegistered: FACTS.vat.registered,
  };
}

module.exports = {
  buildFactsAnswer,
  factsStatus,
  oneLine,
  FACTS,
  // exposed for tests
  _internal: {
    classify, deliveryAnswer, leadTimeAnswer, returnsAnswer, warrantyAnswer,
    bulbsAnswer, vatAnswer, money,
  },
};
