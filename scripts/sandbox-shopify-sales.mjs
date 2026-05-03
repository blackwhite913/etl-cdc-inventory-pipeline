/**
 * Sandbox: read recent Shopify orders (sales) via Admin REST API.
 *
 * Env (same as lib/shopify.ts): SHOPIFY_ACCESS_TOKEN, SHOPIFY_STORE_DOMAIN
 * Optional: SHOPIFY_API_VERSION (default 2026-04), SHOPIFY_SALES_LIMIT (default 5, max 250)
 *
 * Required scope: read_orders
 *
 * Run: npm run sandbox:shopify-sales (loads .env then .env.local via dotenv-cli)
 */

const token = process.env.SHOPIFY_ACCESS_TOKEN?.trim();
const storeDomain = process.env.SHOPIFY_STORE_DOMAIN?.trim();
const apiVersion = process.env.SHOPIFY_API_VERSION?.trim() || "2026-04";
const rawLimit = Number.parseInt(process.env.SHOPIFY_SALES_LIMIT || "5", 10);
const limit = Number.isFinite(rawLimit) ? Math.min(250, Math.max(1, rawLimit)) : 5;

if (!token || !storeDomain) {
  console.error("Missing SHOPIFY_ACCESS_TOKEN or SHOPIFY_STORE_DOMAIN (add to .env or .env.local).");
  process.exit(1);
}

const normalizedDomain =
  storeDomain.startsWith("http://") || storeDomain.startsWith("https://")
    ? storeDomain.replace(/\/+$/, "")
    : `https://${storeDomain.replace(/\/+$/, "")}`;

const url = new URL(`${normalizedDomain}/admin/api/${apiVersion}/orders.json`);
url.searchParams.set("limit", String(limit));
url.searchParams.set("status", "any");

const res = await fetch(url, {
  headers: {
    "X-Shopify-Access-Token": token,
    "Content-Type": "application/json",
  },
});

const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = text;
}

if (!res.ok) {
  console.error(`${res.status} ${res.statusText} — ${url.origin}/admin/api/.../orders.json`);
  console.error(typeof body === "string" ? body : JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(body, null, 2));
