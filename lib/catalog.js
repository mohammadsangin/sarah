// Shared in-memory product catalog for the Sarah voice assistant.
//
// The catalog is a cached copy of the store's public products.json. It is
// refreshed:
//   1. Lazily on the first request (cold start).
//   2. Immediately when a Shopify products/create or products/update webhook
//      fires (see app/api/shopify-webhook/route.js).
//   3. As a safety net, via stale-while-revalidate on every request once the
//      cache is older than CATALOG_TTL_MS, and via a Vercel cron that hits
//      /api/refresh-catalog on a schedule (see vercel.json).
//
// NOTE on serverless: each Vercel function instance keeps its own module
// memory, so a webhook only refreshes the instance that receives it. The
// stale-while-revalidate TTL below is what keeps every other warm instance
// self-healing. For guaranteed instant, cross-instance propagation, back this
// with a shared store (Vercel KV / Edge Config). See README.

const PRODUCTS_JSON_URL =
  process.env.PRODUCTS_JSON_URL || 'https://kymralighting.co.uk/products.json';

// How old the cache may get before a background revalidation is triggered.
const CATALOG_TTL_MS = Number(process.env.CATALOG_TTL_MS || 60 * 60 * 1000); // 60 min

const CURRENCY_SYMBOL = process.env.CURRENCY_SYMBOL || '£'; // "£"

const PAGE_LIMIT = 250; // Shopify products.json max page size
const MAX_PAGES = 40; // hard stop (up to 10k products) to avoid loops

// Module-level cache. Survives for the life of a warm serverless instance.
const cache = {
  products: null, // array of normalized products, or null before first load
  fetchedAt: 0, // epoch ms of last successful load
  refreshing: null, // in-flight refresh promise (de-dupes concurrent refreshes)
};

// --- fetching -------------------------------------------------------------

async function fetchAllProducts() {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${PRODUCTS_JSON_URL}?limit=${PAGE_LIMIT}&page=${page}`;
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      // Always hit the origin; we do our own caching.
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`products.json fetch failed: HTTP ${res.status} (page ${page})`);
    }
    const body = await res.json();
    const products = Array.isArray(body.products) ? body.products : [];
    all.push(...products);
    if (products.length < PAGE_LIMIT) break; // last page
  }
  return all.map(normalizeProduct);
}

function normalizeProduct(p) {
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const prices = variants
    .map((v) => parseFloat(v.price))
    .filter((n) => Number.isFinite(n));
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  const inStock = variants.some((v) => v.available === true);
  // products.json "tags" is a comma-separated string on some stores and an
  // array on others; normalize to an array of trimmed strings.
  let tags = [];
  if (Array.isArray(p.tags)) tags = p.tags;
  else if (typeof p.tags === 'string') tags = p.tags.split(',');
  tags = tags.map((t) => String(t).trim()).filter(Boolean);

  const optionValues = variants
    .map((v) => v.title)
    .filter((t) => t && t.toLowerCase() !== 'default title');

  return {
    id: p.id,
    title: p.title || '',
    handle: p.handle || '',
    productType: p.product_type || '',
    vendor: p.vendor || '',
    tags,
    variantTitles: optionValues,
    minPrice,
    maxPrice,
    inStock,
    bodyText: stripHtml(p.body_html || ''),
    // Precomputed lowercase haystack for fast searching.
    _haystack: [
      p.title,
      p.handle,
      p.product_type,
      p.vendor,
      tags.join(' '),
      optionValues.join(' '),
    ]
      .join('  ')
      .toLowerCase(),
  };
}

function stripHtml(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&pound;/g, '£')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- cache management -----------------------------------------------------

async function refreshCatalog() {
  // De-dupe concurrent refreshes: reuse the in-flight promise if present.
  if (cache.refreshing) return cache.refreshing;
  cache.refreshing = (async () => {
    try {
      const products = await fetchAllProducts();
      cache.products = products;
      cache.fetchedAt = Date.now();
      return products;
    } finally {
      cache.refreshing = null;
    }
  })();
  return cache.refreshing;
}

// Guarantee the cache is populated (awaits a fetch on cold start), and kick a
// background revalidation if the data is stale. Callers get a fast response
// even when the data is slightly stale.
async function ensureCatalog() {
  if (!cache.products) {
    await refreshCatalog();
    return cache.products || [];
  }
  const age = Date.now() - cache.fetchedAt;
  if (age > CATALOG_TTL_MS && !cache.refreshing) {
    // Fire-and-forget; do not block the caller on revalidation.
    refreshCatalog().catch(() => {});
  }
  return cache.products;
}

function catalogStatus() {
  return {
    loaded: Array.isArray(cache.products),
    count: cache.products ? cache.products.length : 0,
    fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    ageMs: cache.fetchedAt ? Date.now() - cache.fetchedAt : null,
    ttlMs: CATALOG_TTL_MS,
  };
}

// --- search ---------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'do', 'does', 'you', 'have', 'got', 'any',
  'me', 'i', 'about', 'for', 'of', 'in', 'on', 'with', 'and', 'or', 'to',
  'whats', "what's", 'what', 'how', 'much', 'cost', 'costs', 'price', 'priced',
  'stock', 'available', 'availability', 'tell', 'looking', 'need', 'want',
  'your', 'this', 'that', 'it', 'can', 'get', 'buy', 'please',
]);

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// Score a single product against the set of query tokens. Weights favor the
// title, then type/vendor/tags, with a bonus for the full phrase appearing.
function scoreProduct(product, tokens, phrase) {
  let score = 0;
  const title = product.title.toLowerCase();
  const type = product.productType.toLowerCase();
  const vendor = product.vendor.toLowerCase();
  const tagStr = product.tags.join(' ').toLowerCase();
  const handle = product.handle.toLowerCase();

  for (const tok of tokens) {
    if (title.includes(tok)) score += 5;
    if (handle.includes(tok)) score += 2;
    if (type.includes(tok)) score += 3;
    if (vendor.includes(tok)) score += 2;
    if (tagStr.includes(tok)) score += 2;
    // Fallback: any appearance in the combined haystack.
    if (score === 0 && product._haystack.includes(tok)) score += 1;
  }
  // Big bonus when the whole cleaned phrase appears in the title/haystack.
  if (phrase && phrase.length > 2) {
    if (title.includes(phrase)) score += 12;
    else if (product._haystack.includes(phrase)) score += 6;
  }
  return score;
}

// Returns { matches: [...], total } — the best-scoring products for a query.
function searchCatalog(products, query, limit = 3) {
  const tokens = tokenize(query);
  const phrase = String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (!tokens.length) return { matches: [], total: 0 };

  const scored = [];
  for (const p of products) {
    const score = scoreProduct(p, tokens, phrase);
    if (score > 0) scored.push({ product: p, score });
  }
  scored.sort((a, b) => b.score - a.score);

  // Require a minimum signal so a single weak token match doesn't win.
  const best = scored[0];
  if (!best || best.score < 3) return { matches: [], total: scored.length };

  return {
    matches: scored.slice(0, limit).map((s) => s.product),
    total: scored.length,
  };
}

// --- spoken-answer builder ------------------------------------------------

function formatPrice(product) {
  if (product.minPrice == null) return null;
  const fmt = (n) =>
    `${CURRENCY_SYMBOL}${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
  if (product.maxPrice != null && product.maxPrice > product.minPrice) {
    return `from ${fmt(product.minPrice)}`;
  }
  return fmt(product.minPrice);
}

function specSnippet(product) {
  const parts = [];

  // Range / vendor.
  if (product.productType && product.vendor) {
    parts.push(`It's part of our ${product.productType} range by ${product.vendor}.`);
  } else if (product.productType) {
    parts.push(`It's a ${product.productType}.`);
  } else if (product.vendor) {
    parts.push(`It's by ${product.vendor}.`);
  }

  const lc = product.tags.map((t) => t.toLowerCase());

  // Genuine spec-like features worth speaking aloud.
  const ip = [...new Set(lc.filter((t) => /^ip\d{2}$/.test(t)))].map((t) => t.toUpperCase());
  const features = [];
  if (lc.includes('dimmable')) features.push('dimmable');
  if (lc.includes('led')) features.push('LED');
  if (ip.length) features.push(`${ip.join(' and ')} rated`);
  if (features.length) parts.push(`It's ${features.join(', ')}.`);

  // Where it can be used (indoor is the default, so only call out the notable ones).
  const locations = [];
  if (lc.includes('bathroom')) locations.push('bathroom');
  if (lc.includes('outdoor')) locations.push('outdoor');
  if (locations.length) parts.push(`Suitable for ${locations.join(' and ')} use.`);

  // Finish / variant options.
  if (product.variantTitles.length > 1) {
    const finishes = product.variantTitles.slice(0, 4).join(', ');
    parts.push(`Available options include ${finishes}.`);
  }

  return parts.join(' ').trim();
}

// Build a short, spoken-language answer. Never returns JSON/HTML or newlines.
function buildAnswer(query, products) {
  const { matches, total } = searchCatalog(products, query);

  if (!matches.length) {
    return "I couldn't find that exact product, could you describe it differently? For example, the product name, the type of light, or a finish like brass or chrome.";
  }

  const p = matches[0];
  const price = formatPrice(p);
  const stock = p.inStock ? 'in stock' : 'currently out of stock';

  let answer = `The ${p.title}`;
  if (price) answer += ` is ${price}`;
  answer += price ? ` and it's ${stock}.` : ` is ${stock}.`;

  const spec = specSnippet(p);
  if (spec) answer += ` ${spec}`;

  if (total > 1) {
    const others = matches.slice(1, 3).map((m) => m.title);
    if (others.length) {
      answer += ` I also have ${others.join(' and ')} if that's closer to what you need.`;
    }
  }

  return oneLine(answer);
}

function oneLine(s) {
  return String(s).replace(/\s*[\r\n]+\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = {
  ensureCatalog,
  refreshCatalog,
  searchCatalog,
  buildAnswer,
  catalogStatus,
  normalizeProduct,
  oneLine,
  // exposed for tests
  _internal: { tokenize, scoreProduct, stripHtml, formatPrice },
};
