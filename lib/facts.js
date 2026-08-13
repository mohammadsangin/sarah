// Canonical company facts for the Sarah voice assistant — delivery, returns,
// lead times and warranty.
//
// WHY THIS EXISTS (the bug it fixes):
// Sarah was giving wrong answers about delivery cost, lead times and returns
// even though a knowledge file (kymra-customer-facts-v1.txt) was attached to
// the assistant. In Vapi an attached .txt is NOT injected into the prompt —
// it is only ever consulted when it is wired into a *query tool* (a vector
// knowledge base), and even then the semantic retrieval is unreliable for
// short policy phrases like "how much is delivery" or "what's your returns
// policy". So the file was effectively never read, and Sarah fell back to
// guessing (e.g. "returns are 14 days", "I can't provide delivery costs").
//
// Product prices are correct because they come from `lookup_product`, a
// function tool that returns a fixed spoken string — no retrieval guesswork.
// This module gives delivery/returns/lead-time/warranty the exact same
// treatment: a deterministic function tool (`lookup_policy`, served by
// /api/vapi-facts) that returns a short spoken sentence. Facts live here in
// version control — reviewable, testable, and impossible to "not retrieve".
//
// ─────────────────────────────────────────────────────────────────────────
// EDIT THE FACTS BELOW to match kymra-customer-facts-v1.txt.
//
// Two values are pre-filled from the known-correct facts:
//   • Free UK delivery on orders over £500
//   • 30-day returns
// Everything set to `null` is spoken as a graceful "let me confirm that for
// you" rather than a guess — so a blank can never become a wrong answer to a
// customer. Fill each `null` in with the canonical figure to have Sarah state
// it directly. (These can also be overridden with env vars for deploy-time
// tweaks without a code change — see the `envNum` / `envStr` reads.)
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
    // Free UK delivery over this order value (confirmed correct).
    freeThreshold: envNum('DELIVERY_FREE_THRESHOLD', 500),
    // Flat charge on UK orders below the threshold, e.g. 4.95. null → Sarah
    // offers to confirm the exact charge instead of guessing.
    standardCost: envNum('DELIVERY_STANDARD_COST', null),
    ukOnly: true,
  },
  leadTime: {
    // Human-readable phrases. null → not spoken. e.g. '1 to 2 working days'.
    inStockDispatch: envStr('LEAD_TIME_DISPATCH', null),
    ukTransit: envStr('LEAD_TIME_TRANSIT', null),
    madeToOrder: envStr('LEAD_TIME_MADE_TO_ORDER', null),
  },
  returns: {
    // 30-day returns window (confirmed correct).
    windowDays: envNum('RETURNS_WINDOW_DAYS', 30),
    condition: envStr(
      'RETURNS_CONDITION',
      'unused and in their original packaging'
    ),
  },
  warranty: {
    // Warranty length in years, e.g. 2. null → Sarah offers to confirm.
    years: envNum('WARRANTY_YEARS', null),
  },
};

// --- money formatting ------------------------------------------------------

function money(amount) {
  if (amount == null) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return `${CURRENCY}${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
}

// --- topic classification --------------------------------------------------
//
// Each topic has a set of keywords/phrases. We score the caller's query by how
// many of a topic's cues it contains, and answer the best-scoring topic. This
// is deterministic and needs no network — the whole point.

const TOPICS = [
  {
    key: 'returns',
    // Checked before delivery so "can I send it back" doesn't read as postage.
    cues: [
      'return', 'returns', 'refund', 'refunds', 'send it back', 'send them back',
      'send back', 'money back', 'exchange', 'faulty', 'damaged', 'cancel my order',
      'cancel the order', 'change my mind', 'unwanted', 'warranty return',
    ],
  },
  {
    key: 'warranty',
    cues: [
      'warranty', 'guarantee', 'guaranteed', 'cover', 'covered', 'how long is it guaranteed',
    ],
  },
  {
    key: 'delivery',
    // Covers both cost ("how much is delivery") and timing ("how long to
    // arrive"), since callers mix the two freely.
    cues: [
      'delivery', 'deliver', 'delivered', 'shipping', 'ship', 'postage',
      'post', 'carriage', 'freight', 'how much to send', 'send it to me',
      'free delivery', 'free shipping', 'lead time', 'lead times', 'dispatch',
      'how long', 'how soon', 'when will', 'arrive', 'get here', 'working days',
      'next day',
    ],
  },
];

function classify(query) {
  const q = ` ${String(query || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  let best = null;
  let bestScore = 0;
  for (const topic of TOPICS) {
    let score = 0;
    for (const cue of topic.cues) {
      if (q.includes(` ${cue} `) || q.includes(`${cue} `) || q.includes(` ${cue}`)) {
        // Longer, more specific cues weigh more than single words.
        score += cue.includes(' ') ? 3 : 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = topic.key;
    }
  }
  return bestScore > 0 ? best : null;
}

// --- spoken-answer builders ------------------------------------------------

function deliveryAnswer() {
  const d = FACTS.delivery;
  const parts = [];
  const threshold = money(d.freeThreshold);

  if (threshold) {
    parts.push(`UK delivery is free on all orders over ${threshold}.`);
    const std = money(d.standardCost);
    if (std) {
      parts.push(`For orders under that, standard UK delivery is ${std}.`);
    } else {
      parts.push(
        `For orders below that there's a standard delivery charge, and I can confirm the exact amount for you if you'd like.`
      );
    }
  } else {
    parts.push(`I can confirm our delivery charges for you — one moment.`);
  }

  // Timing, only the parts we actually know.
  const lt = FACTS.leadTime;
  const timing = [];
  if (lt.inStockDispatch) timing.push(`in-stock items are usually dispatched within ${lt.inStockDispatch}`);
  if (lt.ukTransit) timing.push(`UK delivery then takes around ${lt.ukTransit}`);
  if (timing.length) parts.push(`${capitalize(timing.join(', and '))}.`);
  if (lt.madeToOrder) parts.push(`Made-to-order pieces take around ${lt.madeToOrder}.`);

  return parts.join(' ');
}

function returnsAnswer() {
  const r = FACTS.returns;
  if (!r.windowDays) {
    return `I can confirm our returns policy for you — one moment.`;
  }
  let s = `You can return items within ${r.windowDays} days of delivery for a refund`;
  s += r.condition ? `, as long as they're ${r.condition}.` : `.`;
  return s;
}

function warrantyAnswer() {
  const w = FACTS.warranty;
  if (!w.years) {
    return `Let me confirm the exact warranty on that for you — I'll check and come back to you.`;
  }
  const yr = w.years === 1 ? 'year' : 'years';
  return `Our products come with a ${w.years}-${yr} warranty.`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Build a short, spoken-language answer for a caller's facts question. Never
// returns JSON/HTML or newlines. A topic we can't classify returns a graceful
// hand-off rather than a guess.
function buildFactsAnswer(query) {
  const topic = classify(query);
  let answer;
  switch (topic) {
    case 'delivery':
      answer = deliveryAnswer();
      break;
    case 'returns':
      answer = returnsAnswer();
      break;
    case 'warranty':
      answer = warrantyAnswer();
      break;
    default:
      answer =
        "I can help with delivery, returns, lead times and warranty. Which of those would you like to know about?";
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
    leadTimeSet:
      !!(FACTS.leadTime.inStockDispatch || FACTS.leadTime.ukTransit || FACTS.leadTime.madeToOrder),
    warrantySet: FACTS.warranty.years != null,
  };
}

module.exports = {
  buildFactsAnswer,
  factsStatus,
  oneLine,
  FACTS,
  // exposed for tests
  _internal: { classify, deliveryAnswer, returnsAnswer, warrantyAnswer, money },
};
