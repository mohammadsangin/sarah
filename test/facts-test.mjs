// Network-free checks of the company-facts logic (delivery, lead times,
// returns, warranty, bulbs, VAT) served by /api/vapi-facts via lib/facts.js.
// Run: node test/facts-test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const facts = require('../lib/facts.js');
const A = (q) => facts.buildFactsAnswer(q);

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function main() {
  // ── DELIVERY (cost) — the free-over-£500 fact Sarah used to refuse ──
  const d1 = A('how much is delivery?');
  console.log('  Q: how much is delivery?\n  A:', d1);
  check('delivery states free over £500', /free on all orders over £500/i.test(d1));
  check('delivery never says "can\'t provide"', !/can'?t provide|cannot provide/i.test(d1));
  check('answers have no line breaks', !/[\r\n]/.test(d1));
  check('"free delivery?" → delivery', /free on all orders over £500/i.test(A('do you do free delivery?')));
  check('"shipping cost" → delivery', /£500/i.test(A('what does shipping cost')));

  // ── LEAD TIMES — maker dependent ──
  const soho = A('how long for a Soho wall light?');
  console.log('  Q: how long for a Soho wall light?\n  A:', soho);
  check('Soho stocked → 2 to 3 working days', /2 to 3 working days/i.test(soho));

  const palace = A('when will the Palace Collection socket arrive?');
  console.log('  Q: Palace socket lead time\n  A:', palace);
  check('Palace sockets → approximately 5 weeks', /5 weeks/i.test(palace));

  const mullan = A('how long for a Mullan pendant?');
  console.log('  Q: how long for a Mullan pendant?\n  A:', mullan);
  check('Mullan standard → 2 to 3 weeks', /2 to 3 weeks/i.test(mullan));
  check('Mullan is made to order', /made to order/i.test(mullan));
  check('Mullan NEVER quoted in days', !/\bdays\b/i.test(mullan));
  check('Mullan clock starts at payment', /payment is received/i.test(mullan));

  const mullanCeramic = A('lead time on a Mullan ceramic light');
  check('Mullan ceramics → 4 to 6 weeks', /4 to 6 weeks/i.test(mullanCeramic));
  check('Mullan ceramics not in days', !/\bdays\b/i.test(mullanCeramic));

  const mullanBespoke = A('how long for a bespoke Mullan piece');
  check('Mullan bespoke → 8 to 10 weeks', /8 to 10 weeks/i.test(mullanBespoke));

  const unknownMaker = A('how long will delivery take?');
  console.log('  Q: how long will delivery take? (no maker)\n  A:', unknownMaker);
  check('unknown maker gives the range', /2 to 3 working days/i.test(unknownMaker) && /weeks/i.test(unknownMaker));
  check('unknown maker asks which piece', /which piece|which item/i.test(unknownMaker));

  // ── RETURNS — 30 days, portal, no "money-back guarantee" ──
  const r1 = A("what's your returns policy?");
  console.log('  Q: returns policy?\n  A:', r1);
  check('returns says 30 days', /within 30 days/i.test(r1));
  check('returns does NOT say 14 days', !/14 days/i.test(r1));
  check('returns mentions the portal', /returns portal/i.test(r1));
  check('returns avoids "money-back guarantee"', !/money[- ]back guarantee/i.test(r1));
  check('"can I send it back" → returns', /30 days/i.test(A('can I send it back?')));

  // ── WARRANTY — varies, never one committed figure ──
  const w1 = A('is there a warranty?');
  console.log('  Q: warranty?\n  A:', w1);
  check('warranty says it varies', /varies/i.test(w1));
  check('warranty offers to confirm', /confirm/i.test(w1));

  // ── BULBS ──
  const b1 = A('does it come with a bulb?');
  console.log('  Q: bulb included?\n  A:', b1);
  check('bulbs: Soho sold separately', /sold separately/i.test(b1));
  const b2 = A('is a bulb included with the Mullan light?');
  check('bulbs: Mullan → check product page', /product page/i.test(b2));

  // ── VAT ──
  const v1 = A('do you charge VAT?');
  console.log('  Q: VAT?\n  A:', v1);
  check('VAT: not registered', /isn'?t VAT registered|not VAT registered/i.test(v1));
  check('VAT: no invoice issued', /don'?t issue a VAT invoice|no VAT invoice/i.test(v1));

  // ── robustness ──
  check('empty query → non-empty string', typeof A('') === 'string' && A('').length > 0);
  const u1 = A('is the moon made of cheese');
  check('unknown topic → helpful menu', /delivery|returns|warranty|vat/i.test(u1));

  // ── money formatting ──
  check('money whole pounds no pence', facts._internal.money(500) === '£500');
  check('money with pence', facts._internal.money(4.95) === '£4.95');
  check('money null', facts._internal.money(null) === null);

  // ── optional sub-threshold cost, when configured, is spoken ──
  const savedStd = facts.FACTS.delivery.standardCost;
  facts.FACTS.delivery.standardCost = 4.95;
  check('configured standard cost is spoken', /standard uk delivery is £4\.95/i.test(A('delivery cost')));
  facts.FACTS.delivery.standardCost = savedStd;

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
