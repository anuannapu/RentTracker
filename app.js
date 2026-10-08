'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Math.round(n).toLocaleString();
const short = (n) => (n >= 1000 ? '$' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : '$' + Math.round(n));
const today = () => new Date().toISOString().slice(0, 10);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const state = {
  zip: '', place: '', center: null, listings: [], view: 'results', demo: true, hl: null, beds: 0, cmp: [], trend: [], trendSimulated: true,
  saved: store.get('rt.saved', {}), // id -> {listing, history:[{date,price}]}
};
const markerById = new Map();

/* ---------- map ---------- */
const map = L.map('map', { zoomControl: false }).setView([39.5, -98.35], 4);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
const markers = L.layerGroup().addTo(map);

/* ---------- data ---------- */
async function geocodeZip(zip) {
  const r = await fetch(`https://api.zippopotam.us/us/${zip}`);
  if (!r.ok) throw new Error('We couldn’t find that zip code. Try another one?');
  const p = (await r.json()).places[0];
  return { lat: +p.latitude, lng: +p.longitude, name: `${p['place name']}, ${p['state abbreviation']}` };
}

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

function demoListings(zip, c) {
  const rand = rng(+zip);
  const streets = ['Maple', 'Oak', 'Pine', 'Cedar', 'Elm', 'Lake', 'Hill', 'Park', 'Sunset', 'River', 'Main', 'Highland'];
  const sfx = ['St', 'Ave', 'Blvd', 'Dr', 'Ln', 'Way'];
  const types = ['Apartment', 'Apartment', 'House', 'Condo', 'Townhouse'];
  const base = 1100 + rand() * 1400;
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

/* Live data: via the serverless proxy (RT_CONFIG.API_BASE) if configured, else direct with the visitor's own key. */
const CFG = window.RT_CONFIG || {};
const isLive = () => Boolean(CFG.API_BASE || store.get('rt.key', ''));

async function rc(kind, zip) {
  let url, opts = {};
  if (CFG.API_BASE) {
    url = `${CFG.API_BASE.replace(/\/$/, '')}/${kind}?zip=${zip}`;
  } else {
    url = kind === 'listings'
      ? `https://api.rentcast.io/v1/listings/rental/long-term?zipCode=${zip}&status=Active&limit=100`
      : `https://api.rentcast.io/v1/markets?zipCode=${zip}&dataType=Rental&historyRange=12`;
    opts = { headers: { 'X-Api-Key': store.get('rt.key', '') } };
  }
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`The rental data service returned an error (${r.status}).`);
  return r.json();
}

async function liveTrend(zip) {
  const h = (await rc('market', zip))?.rentalData?.history ?? {};
  return Object.entries(h).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => ({ date: k.slice(0, 7), rent: v.averageRent ?? v.medianRent })).filter((p) => p.rent);
}

function demoTrend(zip, endRent) { // simulated 12-month history ending at today's median
  const rand = rng(+zip + 7), drift = (rand() - 0.35) * 0.012, now = new Date();
  let v = endRent; const pts = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    pts.unshift({ date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, rent: Math.round(v) });
    v /= 1 + drift + (rand() - 0.5) * 0.01;
  }
  return pts;
}

async function liveListings(zip) {
  return (await rc('listings', zip)).filter((x) => x.price && x.latitude && x.longitude).map((x) => ({
    id: String(x.id), address: x.formattedAddress, price: x.price,
    beds: x.bedrooms ?? 0, baths: x.bathrooms ?? 0, sqft: x.squareFootage ?? 0,
    type: x.propertyType === 'Single Family' ? 'House' : (x.propertyType || 'Apartment'),
    lat: x.latitude, lng: x.longitude, daysOnMarket: x.daysOnMarket ?? 0,
  }));
}

async function search(zip) {
  document.querySelectorAll('.zipinput').forEach((i) => { i.value = zip; });
  document.body.classList.add('searched');
  $('app').hidden = false;
  map.invalidateSize();
  $('list').innerHTML = '<div class="empty">Looking around the neighborhood…</div>';
  try {
    const c = await geocodeZip(zip);
    state.zip = zip; state.place = c.name; state.center = c; state.cmp = [];
    state.demo = !isLive();
    state.listings = state.demo ? demoListings(zip, c) : await liveListings(zip);
    try { state.trend = state.demo ? [] : await liveTrend(zip); } catch { state.trend = []; }
    if (state.trend.length < 2) state.trend = demoTrend(zip, median(state.listings.map((l) => l.price)));
    state.trendSimulated = state.demo || !state.trend.length;
    syncSavedPrices();
    map.setView([c.lat, c.lng], 13);
    state.view = 'results'; setTabs();
    render(); renderTrend();
    window.scrollTo({ top: 0 });
  } catch (e) {
    $('list').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/* ---------- saved / price tracking ---------- */
function syncSavedPrices() {
  for (const l of state.listings) {
    const s = state.saved[l.id];
    if (!s) continue;
    s.listing = l;
    if (s.history.at(-1).price !== l.price) s.history.push({ date: today(), price: l.price });
  }
  store.set('rt.saved', state.saved);
}

function toggleSave(l) {
  if (state.saved[l.id]) delete state.saved[l.id];
  else state.saved[l.id] = { listing: l, history: [{ date: today(), price: l.price }] };
  store.set('rt.saved', state.saved);
  render();
}

/* ---------- visuals ---------- */
function art(l) { // unique little illustration per listing
  const h = hash(l.id), hue = h % 360, hue2 = (hue + 40) % 360;
  const wall = `hsl(${(hue + 20) % 360} 38% 38%)`, roof = `hsl(${hue2} 40% 28%)`, glass = 'hsl(48 90% 78%)';
  const win = (x, y, w = 9, hh = 12) => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="1.5" fill="${(h >> (x % 9)) & 1 ? glass : 'hsl(200 25% 70% / .7)'}"/>`;
  let b = '';
  if (l.type === 'House') {
    b = `<rect x="70" y="72" width="100" height="58" fill="${wall}"/><polygon points="60,74 120,36 180,74" fill="${roof}"/>
      <rect x="112" y="96" width="16" height="34" rx="2" fill="${roof}"/>${win(82, 88, 14, 14)}${win(144, 88, 14, 14)}<rect x="146" y="44" width="10" height="20" fill="${roof}"/>`;
  } else if (l.type === 'Townhouse') {
    b = [0, 1, 2].map((i) => { const x = 40 + i * 54, c = `hsl(${(hue + i * 35) % 360} 38% ${36 + i * 4}%)`;
      return `<rect x="${x}" y="${58 - i * 6}" width="50" height="${72 + i * 6}" fill="${c}"/><polygon points="${x - 3},${58 - i * 6} ${x + 25},${40 - i * 6} ${x + 53},${58 - i * 6}" fill="${roof}"/>${win(x + 8, 74 - i * 6)}${win(x + 33, 74 - i * 6)}<rect x="${x + 19}" y="106" width="12" height="24" rx="2" fill="${roof}"/>`; }).join('');
  } else if (l.type === 'Condo') {
    b = `<rect x="50" y="48" width="64" height="82" fill="${wall}"/><rect x="118" y="30" width="62" height="100" fill="${roof}"/>` +
      [0, 1, 2, 3].map((r) => win(60, 58 + r * 18) + win(84, 58 + r * 18) + win(128, 40 + r * 22) + win(152, 40 + r * 22)).join('');
  } else {
    b = `<rect x="68" y="22" width="104" height="108" fill="${wall}"/><rect x="62" y="18" width="116" height="8" fill="${roof}"/>` +
      [0, 1, 2, 3, 4].map((r) => [0, 1, 2].map((c) => win(80 + c * 30, 34 + r * 18)).join('')).join('') + `<rect x="112" y="112" width="16" height="18" fill="${roof}"/>`;
  }
  return `<svg viewBox="0 0 240 160" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><linearGradient id="g${h}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 82%)"/><stop offset="1" stop-color="hsl(${hue2} 80% 92%)"/></linearGradient></defs>
    <rect width="240" height="160" fill="url(#g${h})"/><circle cx="${30 + (h % 160)}" cy="30" r="14" fill="hsl(40 100% 75%)" opacity=".8"/>
    <rect y="130" width="240" height="30" fill="hsl(${(hue + 120) % 360} 30% 42%)"/>${b}</svg>`;
}

function spark(history) {
  if (history.length < 2) return '';
  const ps = history.map((p) => p.price), lo = Math.min(...ps), hi = Math.max(...ps), r = hi - lo || 1;
  const pts = ps.map((p, i) => [4 + (i * 82) / (ps.length - 1), 22 - ((p - lo) / r) * 18]);
  return `<svg class="spark" viewBox="0 0 90 26"><polyline points="${pts.map((p) => p.join(',')).join(' ')}"/><circle cx="${pts.at(-1)[0]}" cy="${pts.at(-1)[1]}" r="3"/></svg>`;
}

function histogram(all, shown) {
  if (all.length < 2) return '';
  const lo = Math.min(...all), hi = Math.max(...all), n = 14, w = (hi - lo) / n || 1;
  const bin = (p) => Math.min(n - 1, Math.floor((p - lo) / w));
  const a = Array(n).fill(0), s = Array(n).fill(0);
  all.forEach((p) => a[bin(p)]++); shown.forEach((p) => s[bin(p)]++);
  const mx = Math.max(...a), bw = 280 / n;
  return `<svg class="hist" viewBox="0 0 280 46" preserveAspectRatio="none" aria-label="Rent distribution">${a.map((v, i) => {
    const hA = (v / mx) * 44, hS = (s[i] / mx) * 44;
    return `<rect class="ghost" x="${i * bw + 1}" y="${46 - hA}" width="${bw - 2}" height="${hA}" rx="2"/><rect class="bar" x="${i * bw + 1}" y="${46 - hS}" width="${bw - 2}" height="${hS}" rx="2"/>`;
  }).join('')}</svg>`;
}

/* ---------- filtering & render ---------- */
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

function visible() {
  if (state.view === 'saved') return Object.values(state.saved).map((s) => s.listing);
  const f = { min: +$('minPrice').value || 0, max: +$('maxPrice').value || Infinity, baths: +$('baths').value, type: $('type').value };
  const med = median(state.listings.map((l) => l.price));
  const out = state.listings.filter((l) => l.price >= f.min && l.price <= f.max && l.beds >= state.beds && l.baths >= f.baths && (!f.type || l.type === f.type));
  const sorts = {
    new: (a, b) => a.daysOnMarket - b.daysOnMarket, low: (a, b) => a.price - b.price, high: (a, b) => b.price - a.price,
    sqft: (a, b) => b.sqft - a.sqft, deal: (a, b) => (a.price / (a.sqft || 1)) - (b.price / (b.sqft || 1)),
  };
  void med;
  return out.sort(sorts[$('sort').value]);
}

function priceBadge(id) {
  const h = state.saved[id]?.history;
  if (!h || h.length < 2) return '<span class="meta">Tracking since ' + esc(h?.[0]?.date ?? today()) + '</span>';
  const d = h.at(-1).price - h[0].price;
  if (!d) return '<span class="meta">No change since saved</span>';
  return `<span class="badge ${d < 0 ? 'down' : 'up'}">${d < 0 ? '▼' : '▲'} ${money(Math.abs(d))} since saved</span>`;
}

function render() {
  const items = visible();
  const areaMed = median(state.listings.map((l) => l.price));
  $('savedCount').textContent = Object.keys(state.saved).length;

  // stats
  const prices = items.map((l) => l.price);
  const ppsf = items.filter((l) => l.sqft).map((l) => l.price / l.sqft);
  const where = state.view === 'saved' ? 'Your tracked rentals' : (state.place || '—');
  $('stats').innerHTML = `
    <div class="tile place hist-tile"><div class="k">${state.view === 'saved' ? 'Tracking' : esc(state.zip)}</div><div class="v">${esc(where)}</div>
      ${state.view === 'results' ? histogram(state.listings.map((l) => l.price), prices) : ''}</div>
    <div class="tile"><div class="k">Homes</div><div class="v">${items.length}</div><div class="s">${state.view === 'results' ? 'of ' + state.listings.length + ' in area' : 'saved'}</div></div>
    <div class="tile"><div class="k">Median rent</div><div class="v">${prices.length ? money(median(prices)) : '—'}</div><div class="s">${prices.length ? money(Math.min(...prices)) + ' – ' + money(Math.max(...prices)) : ''}</div></div>
    <div class="tile"><div class="k">Per sq ft</div><div class="v">${ppsf.length ? '$' + (ppsf.reduce((a, b) => a + b, 0) / ppsf.length).toFixed(2) : '—'}</div><div class="s">average</div></div>
    ${state.demo && state.view === 'results' ? '<div class="demo-note">Showing generated demo listings. Add a RentCast key in ⚙︎ for live rentals.</div>' : ''}`;

  // cards
  $('list').innerHTML = items.length ? items.map((l) => {
    const diff = areaMed ? Math.round(((l.price - areaMed) / areaMed) * 100) : 0;
    const vs = Math.abs(diff) < 3 ? '<span class="vs">At area median</span>' : `<span class="vs ${diff < 0 ? 'down' : 'up'}">${Math.abs(diff)}% ${diff < 0 ? 'below' : 'above'} area</span>`;
    const sv = state.saved[l.id];
    return `<article class="card ${state.hl === l.id ? 'hl' : ''}" data-id="${esc(l.id)}">
      <div class="art">${art(l)}${l.daysOnMarket <= 3 ? '<span class="tag">New</span>' : ''}
        <button class="heart ${sv ? 'on' : ''}" data-save="${esc(l.id)}" aria-label="${sv ? 'Stop tracking' : 'Track this rental'}">♥</button></div>
      <div class="body">
        <div class="price">${money(l.price)}<small> /mo</small></div>
        <div class="facts"><span><b>${l.beds === 0 ? 'Studio' : l.beds}</b>${l.beds === 0 ? '' : ' bd'}</span><span><b>${l.baths}</b> ba</span>${l.sqft ? `<span><b>${l.sqft.toLocaleString()}</b> sqft</span>` : ''}</div>
        <div class="addr">${esc(l.address)}</div>
        <div class="foot">${vs}<span>${l.daysOnMarket === 0 ? 'Today' : l.daysOnMarket + 'd'} · ${esc(l.type)}</span></div>
        <button class="cmp ${state.cmp.includes(l.id) ? 'on' : ''}" data-cmp="${esc(l.id)}">${state.cmp.includes(l.id) ? '✓ Comparing' : '⇄ Compare'}</button>
        ${sv ? `<div class="track">${priceBadge(l.id)}${spark(sv.history)}</div>` : ''}
      </div></article>`;
  }).join('')
    : `<div class="empty">${state.view === 'saved' ? 'Nothing tracked yet. Tap the ♥ on a rental to watch its price.' : 'No rentals match those filters. Try widening them.'}</div>`;

  renderMap(items);
  renderCmpBar();
}

/* ---------- rent trend ---------- */
const monthLabel = (ym) => new Date(ym + '-01T00:00:00').toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

function renderTrend() {
  const el = $('trend'), pts = state.trend, n = pts.length;
  if (state.view !== 'results' || n < 2) { el.hidden = true; return; }
  el.hidden = false;
  const first = pts[0].rent, last = pts[n - 1].rent, chg = ((last - first) / first) * 100;
  const W = 600, H = 150, P = 12, vals = pts.map((p) => p.rent);
  const lo = Math.min(...vals) * 0.98, hi = Math.max(...vals) * 1.02;
  const x = (i) => P + (i * (W - 2 * P)) / (n - 1), y = (v) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.rent).toFixed(1)}`).join(' ');
  const cls = Math.abs(chg) < 0.5 ? '' : chg < 0 ? 'down' : 'up'; // falling rent is good news for renters
  el.innerHTML = `
    <div class="thead">
      <div><div class="k">12-month rent trend · ${esc(state.zip)}</div>
        <div class="v">${money(last)} <span class="chg ${cls}">${chg < 0 ? '▼' : '▲'} ${Math.abs(chg).toFixed(1)}%</span></div></div>
      <div class="s">${state.trendSimulated ? 'Simulated history (demo)' : 'Average rent, market data'}<br>${monthLabel(pts[0].date)} → ${monthLabel(pts[n - 1].date)}</div>
    </div>
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rent trend, ${n} months">
        <defs><linearGradient id="tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--brand)" stop-opacity=".28"/><stop offset="1" stop-color="var(--brand)" stop-opacity="0"/></linearGradient></defs>
        <path d="${line} L${x(n - 1)},${H - P} L${x(0)},${H - P} Z" fill="url(#tg)"/>
        <path d="${line}" class="tline"/>
        <circle class="dot" r="5" style="display:none"/>
        <circle cx="${x(n - 1)}" cy="${y(last)}" r="4" class="endpt"/>
      </svg>
      <div class="tip" hidden></div>
    </div>`;
  const svg = el.querySelector('svg'), dot = svg.querySelector('.dot'), tip = el.querySelector('.tip');
  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((((e.clientX - r.left) / r.width) * W - P) / (W - 2 * P)) * (n - 1))));
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(pts[i].rent)); dot.style.display = '';
    tip.hidden = false; tip.textContent = `${monthLabel(pts[i].date)} · ${money(pts[i].rent)}`;
    tip.style.left = `${(x(i) / W) * 100}%`;
  });
  svg.addEventListener('mouseleave', () => { dot.style.display = 'none'; tip.hidden = true; });
}

/* ---------- compare ---------- */
const findListing = (id) => [...state.listings, ...Object.values(state.saved).map((s) => s.listing)].find((l) => l.id === id);

function toggleCmp(id) {
  const i = state.cmp.indexOf(id);
  if (i >= 0) state.cmp.splice(i, 1);
  else { if (state.cmp.length >= 2) state.cmp.shift(); state.cmp.push(id); }
  render();
}

function renderCmpBar() {
  const n = state.cmp.length;
  $('cmpbar').hidden = n === 0;
  $('cmpMsg').textContent = n === 1 ? 'Pick one more rental to compare' : '2 rentals selected';
  $('cmpGo').disabled = n < 2;
}

function openCompare() {
  const [a, b] = state.cmp.map(findListing);
  if (!a || !b) return;
  const med = median(state.listings.map((l) => l.price));
  const vsArea = (l) => (med ? Math.round(((l.price - med) / med) * 100) : 0);
  const rows = [
    ['Rent', (l) => money(l.price) + '/mo', (l) => l.price, 'low'],
    ['Bedrooms', (l) => (l.beds === 0 ? 'Studio' : l.beds), (l) => l.beds, 'high'],
    ['Bathrooms', (l) => l.baths, (l) => l.baths, 'high'],
    ['Size', (l) => (l.sqft ? l.sqft.toLocaleString() + ' sqft' : '—'), (l) => l.sqft || NaN, 'high'],
    ['Per sq ft', (l) => (l.sqft ? '$' + (l.price / l.sqft).toFixed(2) : '—'), (l) => (l.sqft ? l.price / l.sqft : NaN), 'low'],
    ['Vs area median', (l) => `${vsArea(l) > 0 ? '+' : ''}${vsArea(l)}%`, (l) => l.price, 'low'],
    ['On market', (l) => (l.daysOnMarket === 0 ? 'Today' : l.daysOnMarket + ' days'), null, null],
    ['Type', (l) => esc(l.type), null, null],
  ];
  const win = (va, vb, dir) => {
    if (!dir || !Number.isFinite(va) || !Number.isFinite(vb) || va === vb) return ['', ''];
    const aWins = dir === 'low' ? va < vb : va > vb;
    return aWins ? ['win', ''] : ['', 'win'];
  };
  const head = (l) => `<th><div class="cart">${art(l)}</div><div class="caddr">${esc(l.address)}</div></th>`;
  const diff = Math.abs(a.price - b.price), cheaper = a.price < b.price ? a : b;
  $('compareBody').innerHTML = `
    <table class="ctable"><thead><tr><th></th>${head(a)}${head(b)}</tr></thead><tbody>
    ${rows.map(([label, fmt, val, dir]) => {
      const [wa, wb] = val ? win(val(a), val(b), dir) : ['', ''];
      return `<tr><td class="lbl">${label}</td><td class="${wa}">${fmt(a)}</td><td class="${wb}">${fmt(b)}</td></tr>`;
    }).join('')}</tbody></table>
    <p class="verdict">${diff ? `<b>${esc(cheaper.address)}</b> is ${money(diff)}/mo cheaper — ${money(diff * 12)} less per year.` : 'Both rentals have the same rent.'}</p>`;
  $('compare').showModal();
}

function renderMap(items) {
  markers.clearLayers(); markerById.clear();
  for (const l of items) {
    const icon = L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="pin ${state.saved[l.id] ? 'sv' : ''} ${state.hl === l.id ? 'on' : ''}">${short(l.price)}</div>` });
    const m = L.marker([l.lat, l.lng], { icon }).addTo(markers);
    m.bindPopup(`<b>${money(l.price)}/mo</b><br>${esc(l.address)}<br>${l.beds} bd · ${l.baths} ba`);
    m.on('click', () => selectCard(l.id, false));
    markerById.set(l.id, m);
  }
  if (state.view === 'saved' && items.length) map.fitBounds(items.map((l) => [l.lat, l.lng]), { padding: [50, 50], maxZoom: 15 });
}

function selectCard(id, pan) {
  state.hl = id;
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('hl', c.dataset.id === id));
  markerById.forEach((m, k) => m.getElement()?.firstElementChild?.classList.toggle('on', k === id));
  const m = markerById.get(id);
  if (pan && m) map.flyTo(m.getLatLng(), 16, { duration: 0.6 });
  if (!pan) document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function setTabs() {
  document.querySelectorAll('.tab[data-view]').forEach((t) => t.classList.toggle('active', t.dataset.view === state.view));
}

/* ---------- events ---------- */
document.querySelectorAll('.zipform').forEach((f) => f.addEventListener('submit', (e) => {
  e.preventDefault(); search(f.querySelector('.zipinput').value.trim());
}));
document.querySelectorAll('.chips [data-zip]').forEach((b) => b.addEventListener('click', () => search(b.dataset.zip)));
document.querySelectorAll('.tab[data-view]').forEach((t) => t.addEventListener('click', () => {
  state.view = t.dataset.view; setTabs();
  if (!document.body.classList.contains('searched')) { document.body.classList.add('searched'); $('app').hidden = false; map.invalidateSize(); }
  render(); renderTrend();
}));
$('cmpGo').addEventListener('click', openCompare);
$('cmpClear').addEventListener('click', () => { state.cmp = []; render(); });
$('bedSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-beds]'); if (!b) return;
  state.beds = +b.dataset.beds;
  $('bedSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  render();
});
$('filters').addEventListener('input', render);
$('list').addEventListener('click', (e) => {
  const all = [...state.listings, ...Object.values(state.saved).map((s) => s.listing)];
  const sb = e.target.closest('[data-save]');
  if (sb) { e.stopPropagation(); toggleSave(all.find((l) => l.id === sb.dataset.save)); return; }
  const cb = e.target.closest('[data-cmp]');
  if (cb) { e.stopPropagation(); toggleCmp(cb.dataset.cmp); return; }
  const card = e.target.closest('.card');
  if (card) selectCard(card.dataset.id, true);
});
$('list').addEventListener('mouseover', (e) => {
  const card = e.target.closest('.card');
  if (card && card.dataset.id !== state.hl) markerById.forEach((m, k) => m.getElement()?.firstElementChild?.classList.toggle('on', k === card.dataset.id));
});
$('settingsBtn').addEventListener('click', () => { $('apiKey').value = store.get('rt.key', ''); $('settings').showModal(); });
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue === 'save') { store.set('rt.key', $('apiKey').value.trim()); if (state.zip) search(state.zip); }
});
