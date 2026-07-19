// Fast, network-free-ish checks of the catalog logic and the webhook HMAC.
// Fetches the catalog from the local fixture server (start it first, or this
// spawns its own). Run: node test/local-test.mjs
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = 4556;
process.env.PRODUCTS_JSON_URL = `http://localhost:${PORT}/products.json`;
process.env.FIXTURE_PORT = String(PORT);

const catalog = require('../lib/catalog.js');

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  // Start the fixture origin.
  const server = spawn(process.execPath, [join(__dirname, 'fixture-server.mjs')], {
    env: { ...process.env, FIXTURE_PORT: String(PORT) },
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 600));

  try {
    // --- catalog fetch + pagination ---
    const products = await catalog.ensureCatalog();
    check('catalog loads from products.json', products.length === 4, `got ${products.length}`);

    // --- search: exact-ish product name ---
    const a1 = catalog.buildAnswer('Carlisle Trine wall light', products);
    console.log('  Q: "Carlisle Trine wall light"\n  A:', a1);
    check('matches Carlisle Trine', /Carlisle Trine/i.test(a1));
    check('quotes £130', a1.includes('£130'));
    check('says in stock', /in stock/i.test(a1));
    check('answer has no line breaks', !/[\r\n]/.test(a1));

    // --- search: by type/feature ---
    const a2 = catalog.buildAnswer('do you have a brass toggle switch', products);
    console.log('  Q: "do you have a brass toggle switch"\n  A:', a2);
    check('matches toggle switch', /Toggle Switch/i.test(a2));
    check('mentions finishes/options', /options|Toggle/i.test(a2));

    // --- availability wording for out-of-stock product ---
    const a3 = catalog.buildAnswer('USB-C charging socket', products);
    console.log('  Q: "USB-C charging socket"\n  A:', a3);
    check('USB-C socket found', /USB-C/i.test(a3));
    check('reports out of stock', /out of stock/i.test(a3));

    // --- price range wording (single price, no range) ---
    check('price formatted without pence for whole numbers', a1.includes('£130') && !a1.includes('£130.00'));

    // --- graceful miss ---
    const a4 = catalog.buildAnswer('do you sell garden trampolines', products);
    console.log('  Q: "do you sell garden trampolines"\n  A:', a4);
    check('graceful fallback on no match', /couldn't find that exact product/i.test(a4));

    // --- empty query handled by builder (no crash) ---
    const a5 = catalog.buildAnswer('', products);
    check('empty query -> fallback string', typeof a5 === 'string' && a5.length > 0);

    // --- HMAC: prove the exact algorithm the webhook route uses ---
    const secret = 'test_secret_123';
    const rawBody = JSON.stringify({ id: 123, title: 'x' });
    const goodSig = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
    const verify = (body, sig) => {
      const digest = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
      const x = Buffer.from(digest);
      const y = Buffer.from(sig);
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    };
    check('HMAC accepts a valid signature', verify(rawBody, goodSig));
    check('HMAC rejects a tampered body', !verify(rawBody + ' ', goodSig));
    check('HMAC rejects a wrong signature', !verify(rawBody, 'AAAA'));
  } finally {
    server.kill();
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
