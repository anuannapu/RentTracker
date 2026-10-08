'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Math.round(n).toLocaleString();
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const state = {
  zip: '', place: '', center: null, listings: [], view: 'results', highlight: null,
  saved: store.get('rt.saved', {}), // id -> {listing, history:[{date,price}]}
};

/* ---------- map ---------- */
const map = L.map('map').setView([39.5, -98.35], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
const markers = L.layerGroup().addTo(map);

/* ---------- data ---------- */
async function geocodeZip(zip) {
  const r = await fetch(`https://api.zippopotam.us/us/${zip}`);
  if (!r.ok) throw new Error('Zip code not found');
  const p = (await r.json()).places[0];
  return { lat: +p.latitude, lng: +p.longitude, name: `${p['place name']}, ${p['state abbreviation']}` };
}

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function demoListings(zip, c) {
  const rand = rng(+zip);
  const streets = ['Maple', 'Oak', 'Pine', 'Cedar', 'Elm', 'Lake', 'Hill', 'Park', 'Sunset', 'River', 'Main', 'Highland'];
  const sfx = ['St', 'Ave', 'Blvd', 'Dr', 'Ln', 'Way'];
  const types = ['Apartment', 'Apartment', 'House', 'Condo', 'Townhouse'];
  const base = 1100 + rand() * 1400; // area baseline
  return Array.from({ length: 24 }, (_, i) => {
    const beds = Math.floor(rand() * 4) + (rand() > 0.85 ? 0 : 1);
    const baths = Math.max(1, Math.min(beds, 1 + Math.floor(rand() * 3)));
    const sqft = Math.round(350 + beds * 380 + rand() * 300);
    return {
      id: `demo-${zip}-${i}`,
      address: `${100 + Math.floor(rand() * 9800)} ${streets[Math.floor(rand() * streets.length)]} ${sfx[Math.floor(rand() * sfx.length)]}`,
      price: Math.round((base + beds * 380 + sqft * 0.25 + rand() * 250) / 25) * 25,
      beds, baths, sqft,
      type: types[Math.floor(rand() * types.length)],
      lat: c.lat + (rand() - 0.5) * 0.04, lng: c.lng + (rand() - 0.5) * 0.05,
      daysOnMarket: Math.floor(rand() * 45),
    };
  });
}

async function liveListings(zip, key) {
  const r = await fetch(`https://api.rentcast.io/v1/listings/rental/long-term?zipCode=${zip}&status=Active&limit=100`, { headers: { 'X-Api-Key': key } });
  if (!r.ok) throw new Error(`RentCast error ${r.status}`);
  return (await r.json()).filter((x) => x.price && x.latitude && x.longitude).map((x) => ({
    id: String(x.id), address: x.formattedAddress, price: x.price,
    beds: x.bedrooms ?? 0, baths: x.bathrooms ?? 0, sqft: x.squareFootage ?? 0,
    type: x.propertyType === 'Single Family' ? 'House' : (x.propertyType || 'Apartment'),
    lat: x.latitude, lng: x.longitude, daysOnMarket: x.daysOnMarket ?? 0,
  }));
}

async function search(zip) {
  $('list').innerHTML = '<div class="empty">Searching…</div>';
  try {
    const c = await geocodeZip(zip);
    const key = store.get('rt.key', '');
    state.zip = zip; state.place = c.name; state.center = c;
    state.listings = key ? await liveListings(zip, key) : demoListings(zip, c);
    state.demo = !key;
    syncSavedPrices();
    map.setView([c.lat, c.lng], 13);
    state.view = 'results'; setTabs();
    render();
  } catch (e) {
    $('list').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/* ---------- saved / price tracking ---------- */
function syncSavedPrices() {
  const today = new Date().toISOString().slice(0, 10);
  for (const l of state.listings) {
    const s = state.saved[l.id];
    if (!s) continue;
    s.listing = l;
    if (s.history.at(-1).price !== l.price) s.history.push({ date: today, price: l.price });
  }
  store.set('rt.saved', state.saved);
}

function toggleSave(l) {
  if (state.saved[l.id]) delete state.saved[l.id];
  else state.saved[l.id] = { listing: l, history: [{ date: new Date().toISOString().slice(0, 10), price: l.price }] };
  store.set('rt.saved', state.saved);
  render();
}

function priceBadge(id) {
  const h = state.saved[id]?.history;
  if (!h || h.length < 2) return '';
  const d = h.at(-1).price - h[0].price;
  if (!d) return '';
  return `<span class="badge ${d < 0 ? 'down' : 'up'}">${d < 0 ? '▼' : '▲'} ${money(Math.abs(d))} since saved</span>`;
}

/* ---------- filtering & render ---------- */
function visible() {
  if (state.view === 'saved') return Object.values(state.saved).map((s) => s.listing);
  const f = {
    min: +$('minPrice').value || 0, max: +$('maxPrice').value || Infinity,
    beds: +$('beds').value, baths: +$('baths').value, type: $('type').value,
  };
  const out = state.listings.filter((l) => l.price >= f.min && l.price <= f.max && l.beds >= f.beds && l.baths >= f.baths && (!f.type || l.type === f.type));
  const sorts = { new: (a, b) => a.daysOnMarket - b.daysOnMarket, low: (a, b) => a.price - b.price, high: (a, b) => b.price - a.price, sqft: (a, b) => b.sqft - a.sqft };
  return out.sort(sorts[$('sort').value]);
}

function render() {
  const items = visible();
  $('savedCount').textContent = Object.keys(state.saved).length;

  const prices = items.map((l) => l.price).sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : 0;
  const where = state.view === 'saved' ? 'Saved listings' : (state.place || 'Enter a zip code to begin');
  $('summary').innerHTML = `
    <div class="stat"><b>${items.length}</b>${esc(where)}</div>
    ${prices.length ? `<div class="stat"><b>${money(median)}</b>Median rent</div>
    <div class="stat"><b>${money(prices[0])} – ${money(prices.at(-1))}</b>Range</div>` : ''}
    ${state.demo && state.view === 'results' && state.zip ? '<div class="stat">Demo data — add API key in ⚙︎ for live listings</div>' : ''}`;

  $('list').innerHTML = items.length ? items.map((l) => `
    <div class="card ${state.highlight === l.id ? 'hl' : ''}" data-id="${esc(l.id)}">
      <div class="thumb" style="background:hsl(${(parseInt(l.id.replace(/\D/g, '').slice(-4)) || 0) % 360} 45% 55% / .25)">${l.type === 'House' ? '🏡' : l.type === 'Townhouse' ? '🏘️' : '🏢'}</div>
      <div>
        <div class="price">${money(l.price)}<span class="meta">/mo</span> ${priceBadge(l.id)}</div>
        <div class="meta">${l.beds === 0 ? 'Studio' : l.beds + ' bd'} · ${l.baths} ba${l.sqft ? ' · ' + l.sqft.toLocaleString() + ' sqft' : ''} · ${esc(l.type)}</div>
        <div class="addr">${esc(l.address)}</div>
        <div class="row"><span class="meta">${l.daysOnMarket === 0 ? 'Listed today' : l.daysOnMarket + ' days on market'}</span>
          <button class="save ${state.saved[l.id] ? 'on' : ''}" data-save="${esc(l.id)}">${state.saved[l.id] ? '★ Tracking' : '☆ Track'}</button></div>
      </div>
    </div>`).join('')
    : `<div class="empty">${state.view === 'saved' ? 'No saved listings yet. Click “Track” on a listing.' : state.zip ? 'No rentals match your filters.' : 'Search a zip code to see rentals.'}</div>`;

  markers.clearLayers();
  for (const l of items) {
    const m = L.marker([l.lat, l.lng]).addTo(markers)
      .bindPopup(`<b>${money(l.price)}/mo</b><br>${esc(l.address)}<br>${l.beds} bd · ${l.baths} ba`);
    m.on('click', () => { state.highlight = l.id; render(); document.querySelector(`[data-id="${CSS.escape(l.id)}"]`)?.scrollIntoView({ block: 'nearest' }); });
  }
  if (state.view === 'saved' && items.length) map.fitBounds(items.map((l) => [l.lat, l.lng]), { padding: [40, 40] });
}

function setTabs() {
  document.querySelectorAll('.tab[data-view]').forEach((t) => t.classList.toggle('active', t.dataset.view === state.view));
}

/* ---------- events ---------- */
$('searchForm').addEventListener('submit', (e) => { e.preventDefault(); search($('zip').value.trim()); });
document.querySelectorAll('.tab[data-view]').forEach((t) => t.addEventListener('click', () => { state.view = t.dataset.view; setTabs(); render(); }));
$('filters').addEventListener('input', render);
$('list').addEventListener('click', (e) => {
  const sb = e.target.closest('[data-save]');
  const all = [...state.listings, ...Object.values(state.saved).map((s) => s.listing)];
  if (sb) { toggleSave(all.find((l) => l.id === sb.dataset.save)); return; }
  const card = e.target.closest('.card');
  if (card) {
    const l = all.find((x) => x.id === card.dataset.id);
    state.highlight = l.id; map.setView([l.lat, l.lng], 16); render();
  }
});
$('settingsBtn').addEventListener('click', () => { $('apiKey').value = store.get('rt.key', ''); $('settings').showModal(); });
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue === 'save') { store.set('rt.key', $('apiKey').value.trim()); if (state.zip) search(state.zip); }
});

render();
