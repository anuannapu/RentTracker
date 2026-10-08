// Cloudflare Worker: a thin, cached proxy in front of RentCast so the API key never reaches the browser.
//   GET /listings?zip=98101  -> active long-term rental listings
//   GET /market?zip=98101    -> 12-month rental market stats/history

const UPSTREAM = {
  listings: (zip) => `https://api.rentcast.io/v1/listings/rental/long-term?zipCode=${zip}&status=Active&limit=100`,
  market: (zip) => `https://api.rentcast.io/v1/markets?zipCode=${zip}&dataType=Rental&historyRange=12`,
};
const TTL = { listings: 600, market: 86400 }; // seconds; caching also protects your RentCast quota

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, cors);

    const url = new URL(request.url);
    const kind = url.pathname.replace(/^\/+|\/+$/g, '');
    const zip = url.searchParams.get('zip') || '';
    if (!UPSTREAM[kind]) return json({ error: 'Not found. Use /listings or /market.' }, 404, cors);
    if (!/^\d{5}$/.test(zip)) return json({ error: 'zip must be 5 digits' }, 400, cors);
    if (!env.RENTCAST_KEY) return json({ error: 'Server is missing RENTCAST_KEY' }, 500, cors);

    const cache = caches.default;
    const cacheKey = new Request(`https://cache.renttracker/${kind}/${zip}`);
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, { status: 200, headers: { ...Object.fromEntries(hit.headers), ...cors, 'X-Cache': 'HIT' } });

    const upstream = await fetch(UPSTREAM[kind](zip), { headers: { 'X-Api-Key': env.RENTCAST_KEY, Accept: 'application/json' } });
    if (!upstream.ok) return json({ error: `Upstream error ${upstream.status}` }, upstream.status === 429 ? 429 : 502, cors);

    const body = await upstream.text();
    const res = new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${TTL[kind]}` },
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', ...cors, 'X-Cache': 'MISS' } });
  },
};
