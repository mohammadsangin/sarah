// Tiny local origin that mimics Shopify's paginated products.json.
// Page 1 returns the fixture; later pages return an empty list (end of data).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixture-products.json'), 'utf8'));
const port = Number(process.env.FIXTURE_PORT || 4555);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === '/products.json') {
    const page = Number(url.searchParams.get('page') || '1');
    const body = page > 1 ? { products: [] } : fixture;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, () => {
  console.log(`fixture products.json server listening on http://localhost:${port}/products.json`);
});
