// Network-free checks of the company-facts logic (delivery, returns, lead
// times, warranty) served by /api/vapi-facts via lib/facts.js.
// Run: node test/facts-test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const facts = require('../lib/facts.js');

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function main() {
  // --- delivery: the free-over-£500 fact Sarah used to refuse to state ---
  const d1 = facts.buildFactsAnswer('how much is delivery?');
  console.log('  Q: "how much is delivery?"\n  A:', d1);
  check('delivery answer states free over £500', /free on all orders over £500/i.test(d1));
  check('delivery answer never says "can\'t provide"', !/can't provide|cannot provide/i.test(d1));
  check('delivery answer has no line breaks', !/[\r\n]/.test(d1));

  // Phrasing variants all route to delivery.
  check('"free delivery?" routes to delivery', /free on all orders over £500/i.test(facts.buildFactsAnswer('do you do free delivery?')));
  check('"shipping cost" routes to delivery', /£500/i.test(facts.buildFactsAnswer('what does shipping cost')));
  check('"how long to arrive" routes to delivery', /£500|delivery/i.test(facts.buildFactsAnswer('how long will it take to arrive?')));

  // --- returns: the 30-day fact (Sarah previously said 14) ---
  const r1 = facts.buildFactsAnswer("what's your returns policy?");
  console.log('  Q: "what\'s your returns policy?"\n  A:', r1);
  check('returns answer says 30 days', /within 30 days/i.test(r1));
  check('returns answer does NOT say 14 days', !/14 days/i.test(r1));
  check('"can I get a refund" routes to returns', /30 days/i.test(facts.buildFactsAnswer('can I get a refund')));
  check('"send it back" routes to returns', /30 days/i.test(facts.buildFactsAnswer('can I send it back?')));

  // --- unset facts fall back gracefully, never a guess ---
  const w1 = facts.buildFactsAnswer('is there a warranty?');
  console.log('  Q: "is there a warranty?"\n  A:', w1);
  // With WARRANTY_YEARS unset, we must NOT invent a number.
  check('unset warranty does not invent a number', !/\b\d+-year/i.test(w1) || facts.FACTS.warranty.years != null);
  check('unset warranty offers to confirm', /confirm|check/i.test(w1) || facts.FACTS.warranty.years != null);

  // --- unclassifiable query gets a helpful menu, not an error ---
  const u1 = facts.buildFactsAnswer('is the moon made of cheese');
  check('unknown topic returns a helpful string', typeof u1 === 'string' && u1.length > 0);
  check('unknown topic offers delivery/returns/etc', /delivery|returns|warranty/i.test(u1));

  // --- empty query handled (no crash) ---
  const e1 = facts.buildFactsAnswer('');
  check('empty query -> non-empty string', typeof e1 === 'string' && e1.length > 0);

  // --- money formatting: whole pounds have no pence ---
  check('money() formats whole pounds without pence', facts._internal.money(500) === '£500');
  check('money() formats pence when present', facts._internal.money(4.95) === '£4.95');
  check('money() handles null', facts._internal.money(null) === null);

  // --- optional facts, when configured, are spoken ---
  // Prove the composition works if the store fills in the standard cost.
  const savedStd = facts.FACTS.delivery.standardCost;
  facts.FACTS.delivery.standardCost = 4.95;
  const d2 = facts.buildFactsAnswer('how much is delivery');
  check('configured standard cost is spoken', /standard uk delivery is £4\.95/i.test(d2));
  facts.FACTS.delivery.standardCost = savedStd; // restore

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
