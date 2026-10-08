# RentTracker API proxy (Cloudflare Worker)

Lets the static site show live listings to everyone while keeping your RentCast key secret.

## Deploy (free Cloudflare account + RentCast API key)

```bash
cd worker
npm install -g wrangler
wrangler login
wrangler secret put RENTCAST_KEY     # paste your RentCast API key when prompted
wrangler deploy                      # prints https://renttracker-api.<subdomain>.workers.dev
```

Then set that URL in `../config.js`:

```js
window.RT_CONFIG = { API_BASE: 'https://renttracker-api.<subdomain>.workers.dev' };
```

Commit and push; the site now serves live data with no key needed from visitors.

## Notes
- Endpoints: `GET /listings?zip=98101`, `GET /market?zip=98101`.
- Responses are cached (10 min for listings, 24 h for market) to protect your RentCast quota.
- CORS is limited to `ALLOWED_ORIGINS` in `wrangler.toml` (plus localhost). Update it if you use a custom domain.
- Anyone can still call the Worker URL directly with a valid zip; the cache bounds your quota use, and you can add Cloudflare rate-limiting rules if needed.
