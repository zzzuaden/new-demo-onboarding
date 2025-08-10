// ES module app.js — config-driven mock/real toggle + clustering + charts

async function loadConfig() {
  const defaults = { useMock: true, apiBase: 'http://localhost:4000/api/v1' };
  try {
    const res = await fetch('config.json', { cache: 'no-store' });
    if (res.ok) Object.assign(defaults, await res.json());
  } catch (err) { console.warn('Could not load config.json, using defaults', err); }
  const qs = new URLSearchParams(location.search);
  if (qs.has('mock')) defaults.useMock = qs.get('mock') !== '0';
  if (qs.has('api'))  defaults.apiBase = qs.get('api');
  return defaults;
}
const CONFIG = await loadConfig();
const USE_MOCK = CONFIG.useMock;
const API_BASE = CONFIG.apiBase;
console.log('Config loaded:', CONFIG);

const MAP_DEFAULT = { lat: -37.8136, lng: 144.9631, zoom: 14 };
const CAR_CO2_KG_PER_KM = 0.2;

const map = L.map('leaflet').setView([MAP_DEFAULT.lat, MAP_DEFAULT.lng], MAP_DEFAULT.zoom);
// --- Clickable Car-Park Marker Styles & Legend ---
(function injectCarparkStylesAndLegend() {
  const css = `
  .carpark-icon{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;
    color:#fff;font-weight:700;box-shadow:0 0 0 2px #fff inset,0 2px 6px rgba(0,0,0,.35); user-select:none;}
  .carpark-icon.available{background:#2ecc71;}   /* green */
  .carpark-icon.low{background:#f39c12;}         /* amber */
  .carpark-icon.full{background:#e74c3c;}        /* red */
  .carpark-legend{background:#fff;padding:6px 8px;border-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,.2);font:12px/1.2 Arial;}
  .carpark-legend .row{display:flex;align-items:center;margin:4px 0;}
  .carpark-legend .swatch{width:14px;height:14px;border-radius:50%;margin-right:6px;}
  .swatch.available{background:#2ecc71}.swatch.low{background:#f39c12}.swatch.full{background:#e74c3c}
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  // Mini legend (bottom-left)
  const Legend = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd: function () {
      const div = L.DomUtil.create('div', 'carpark-legend');
      div.innerHTML = `
        <div><strong>Car Parks</strong></div>
        <div class="row"><span class="swatch available"></span><span>Available</span></div>
        <div class="row"><span class="swatch low"></span><span>Limited (&le;20% free)</span></div>
        <div class="row"><span class="swatch full"></span><span>Full</span></div>
        <div class="row" style="margin-top:4px;"><small>Click a marker to view spots</small></div>
      `;
      return div;
    }
  });
  map.addControl(new Legend());
})();

// Utility: choose icon class by free-space ratio
function iconClassFor(p){
  const free = Number(p.available_spots ?? 0);
  const cap  = Math.max(1, Number(p.capacity ?? 0));
  if (free <= 0) return 'full';
  if (free / cap <= 0.2) return 'low';
  return 'available';
}
// Build a Leaflet DivIcon that is clearly clickable
function markerIcon(p){
  return L.divIcon({
    className: '',
    html: `<div class="carpark-icon ${iconClassFor(p)}" title="${p.name} (${p.available_spots}/${p.capacity})">P</div>`,
    iconSize: [28,28],
    iconAnchor: [14,28],
    popupAnchor: [0,-24]
  });
}
// --- End styles & legend ---
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

const cluster = L.markerClusterGroup({ disableClusteringAtZoom: 17, showCoverageOnHover: false, spiderfyOnMaxZoom: true, maxClusterRadius: 60 });
map.addLayer(cluster);

const markers = new Map();
const statusEl = document.getElementById('status');
const lotListEl = document.getElementById('lotList');
let currentDestination = null;

const searchBox = document.getElementById('searchBox');
const suggestionsEl = document.getElementById('suggestions');
let debounceTimer;

// Press Enter to search the first suggestion (fallback to typed text)
searchBox.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const q = (searchBox.value || '').trim();
  if (!q) return;
  try {
    suggestionsEl.style.display = 'none';
    const results = await api.geoSearch(q);
    if (results && Array.isArray(results.items) && results.items.length > 0) {
      await chooseDestination(results.items[0]);
    } else {
      // fallback: use current map center as coordinates with the typed name
      const center = map.getCenter();
      await chooseDestination({ name: q, lat: center.lat, lng: center.lng });
    }
  } catch (err) {
    console.error('Enter search failed:', err);
  }
});

searchBox.addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(debounceTimer);
  if (!q) { suggestionsEl.style.display = 'none'; return; }
  debounceTimer = setTimeout(async () => {
    const results = await api.geoSearch(q);
    renderSuggestions(results.items);
  }, 250);
});

function renderSuggestions(items) {
  suggestionsEl.innerHTML = '';
  if (!items.length) { suggestionsEl.style.display = 'none'; return; }
  for (const it of items) {
    const li = document.createElement('li');
    li.textContent = it.name;
    li.tabIndex = 0;
    li.addEventListener('click', () => chooseDestination(it));
    li.addEventListener('keypress', (e) => { if (e.key === 'Enter') chooseDestination(it); });
    suggestionsEl.appendChild(li);
  }
  suggestionsEl.style.display = 'block';
}

async function chooseDestination(place) {
  suggestionsEl.style.display = 'none';
  searchBox.value = place.name;
  currentDestination = place;

  map.setView([place.lat, place.lng], 16);
  statusEl.textContent = 'Loading nearby parking…';
  const { items } = USE_MOCK
    ? await api.parkingNear(place.lat, place.lng, 900)
    : await api.parkingByDest(place.name);
  // cache current items for nearest-on-map-click feature
  window.__lastParkingItems = items.slice();

  for (const it of items) it.distance_m = distanceMeters({ lat: place.lat, lng: place.lng }, it);

  markers.clear();
  cluster.clearLayers();
  lotListEl.innerHTML = '';
  items.forEach((p) => { upsertMarker(p); lotListEl.appendChild(lotCard(p)); });

  if (cluster.getLayers().length) map.fitBounds(cluster.getBounds(), { padding: [20, 20] });

  statusEl.textContent = items.length ? `Showing ${items.length} car parks near ${place.name}.` : 'No car parks found in this area.';
  renderEnvSuggestions(place, items);
  renderCharts(items);
  subscribeRealtime();
}

// Show a popup with up-to-date details for a car park
async function showLotPopup(p) {
  try {
    // Try to refresh single-lot details from backend if available
    const r = await fetch(`${API_BASE}/parking/${encodeURIComponent(p.id)}`, { cache: 'no-store' });
    if (r.ok) {
      const fresh = mapBackendParking(await r.json());
      p = { ...p, ...fresh };
    }
  } catch (_) { /* ignore and use existing p */ }

  L.popup()
    .setLatLng([p.lat, p.lng])
    .setContent(`${p.name}<br/>Availability: <strong>${p.available_spots}/${p.capacity}</strong><br/><small>Updated: ${new Date(p.updated_at).toLocaleTimeString()}</small>`)
    .openOn(map);
}

function popupHtml(p) {
  return `${p.name}<br/>Availability: <strong>${p.available_spots}/${p.capacity}</strong><br/><small>Updated: ${new Date(p.updated_at).toLocaleTimeString()}</small>`;
}
function upsertMarker(p) {
  const html = popupHtml(p);
  if (markers.has(p.id)) {
    const mk = markers.get(p.id);
    mk.setPopupContent(html);
    mk.setIcon(markerIcon(p));
    mk.data = p;
    mk.options.title = `${p.name} (${p.available_spots}/${p.capacity})`;
    return;
  }
  const m = L.marker([p.lat, p.lng], { icon: markerIcon(p), title: `${p.name} (${p.available_spots}/${p.capacity})`, riseOnHover: true })
    .bindPopup(html);
  m.data = p; // store data on marker
  m.on('click', () => showLotPopup(p));
  cluster.addLayer(m);
  markers.set(p.id, m);
}
function lotCard(p) {
  const div = document.createElement('div');
  div.className = 'lot-card';
  div.innerHTML = `<h4>${p.name}</h4>
    <div>
      <span class="badge ${p.available_spots === 0 ? 'red' : ''}">${p.available_spots}/${p.capacity} spots</span>
      <span class="badge">${(p.distance_m/1000).toFixed(2)} km</span>
      ${p.price ? `<span class="badge">${p.price}</span>` : ''}
    </div>`;
  div.onclick = () => {
    map.setView([p.lat, p.lng], 17);
    showLotPopup(p);
  };
  return div;
}

let mockInterval;
function subscribeRealtime() {
  if (!USE_MOCK) {
    // Example SSE wiring here later
    return;
  }
  if (mockInterval) clearInterval(mockInterval);
  mockInterval = setInterval(() => {
    const updates = api.__mockPushUpdates(Array.from(markers.keys()));
    for (const u of updates) {
      const m = markers.get(u.id);
      if (m) m.setPopupContent(popupHtml(u));
      const cards = Array.from(lotListEl.querySelectorAll('.lot-card'));
      cards.forEach(card => {
        if (card.querySelector('h4').textContent === u.name) {
          const badge = card.querySelector('.badge');
          badge.textContent = `${u.available_spots}/${u.capacity} spots`;
          badge.classList.toggle('red', u.available_spots === 0);
        }
      });
    }
  }, 2500 + Math.random() * 2000);
}

function renderEnvSuggestions(place, lots) {
  const env = document.getElementById('envSuggestions');
  const intro = document.getElementById('envIntro');
  env.innerHTML = '';

  if (!lots.length) {
    intro.textContent = `No car parks found near ${place.name}. Consider public transport, cycling, or walking if suitable.`;
    env.appendChild(envCard('Public transport', 'Use tram/train/bus to avoid parking and reduce congestion.', 'High'));
    return;
  }
  const nearest = lots.slice().sort((a,b) => a.distance_m - b.distance_m)[0];
  const km = nearest.distance_m / 1000;
  const co2 = (km * CAR_CO2_KG_PER_KM).toFixed(2);
  intro.textContent = `Approx. distance to the nearest car park: ${km.toFixed(2)} km. Estimated car CO₂ emissions: ~${co2} kg. Alternatives below:`;

  if (km <= 1.2) {
    env.appendChild(envCard('Walk', 'Distance is short. Walking avoids emissions and parking fees.', '≈100% CO₂ saved'));
    env.appendChild(envCard('Cycle', 'Fast and zero-emission for short trips.', '≈100% CO₂ saved'));
    env.appendChild(envCard('Public transport', 'If a direct service exists, it’s cheaper than parking.', 'High'));
  } else if (km <= 5) {
    env.appendChild(envCard('Cycle', '5 km is comfortable bike range for many riders.', '≈100% CO₂ saved'));
    env.appendChild(envCard('Public transport', 'Likely options available depending on route.', 'High'));
    env.appendChild(envCard('Park & Walk', 'Park slightly further away and walk the last 500–800 m.', 'Some savings'));
  } else {
    env.appendChild(envCard('Public transport', 'Avoid city traffic and parking costs.', 'High'));
    env.appendChild(envCard('Park & Ride', 'Drive to a suburban station, then train/tram to destination.', 'Moderate savings'));
    env.appendChild(envCard('Car share', 'Use shared vehicles to reduce total cars parked.', 'Varies'));
  }
}
function envCard(title, text, impact) {
  const div = document.createElement('div'); div.className = 'env-card';
  div.innerHTML = `<h4>${title}</h4><p>${text}</p><p class="muted">Impact: ${impact}</p>`; return div;
}

let avgOccChart, busyHoursChart;
async function renderCharts(lots) {
  const ctx1 = document.getElementById('avgOccChart');
  const ctx2 = document.getElementById('busyHoursChart');

  // If using real backend, try to fetch stats from /stats/parking
  if (!USE_MOCK) {
    try {
      const r = await fetch(`${API_BASE}/stats/parking`, { cache: 'no-store' });
      if (r.ok) {
        const stats = await r.json();
        // Average Occupancy from backend
        const labels1 = Array.isArray(stats.averageOccupancy) ? stats.averageOccupancy.map(x => x.carPark) : [];
        const occ1    = Array.isArray(stats.averageOccupancy) ? stats.averageOccupancy.map(x => Number(x.percentage) || 0) : [];
        if (avgOccChart) avgOccChart.destroy();
        avgOccChart = new Chart(ctx1, {
          type: 'bar',
          data: { labels: labels1, datasets: [{ label: 'Occupancy %', data: occ1 }] },
          options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100 } } }
        });

        // Busiest Hours from backend
        const labels2 = Array.isArray(stats.busiestHours) ? stats.busiestHours.map(x => x.hour) : [];
        const counts2 = Array.isArray(stats.busiestHours) ? stats.busiestHours.map(x => Number(x.count) || 0) : [];
        if (busyHoursChart) busyHoursChart.destroy();
        busyHoursChart = new Chart(ctx2, {
          type: 'line',
          data: { labels: labels2, datasets: [{ label: 'Cars/hour', data: counts2, tension: 0.35 }] },
          options: { responsive: true, plugins: { legend: { display: false } } }
        });
        return; // done with real stats
      } else {
        console.warn('Stats endpoint returned', r.status, r.statusText);
      }
    } catch (err) {
      console.warn('Failed to fetch /stats/parking, falling back to local charts:', err);
    }
  }

  // Fallback (mock or when stats endpoint unavailable): compute from current lots + mock busiest hours
  const labels = lots.map(l => l.name);
  const occ = lots.map(l => Math.round((l.capacity - l.available_spots) / Math.max(1, l.capacity) * 100));
  if (avgOccChart) avgOccChart.destroy();
  avgOccChart = new Chart(ctx1, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Occupancy % (from current results)', data: occ }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100 } } }
  });

  const hours = ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00'];
  const counts = hours.map(() => Math.floor(Math.random() * 100));
  if (busyHoursChart) busyHoursChart.destroy();
  busyHoursChart = new Chart(ctx2, {
    type: 'line',
    data: { labels: hours, datasets: [{ label: 'Cars/hour (mock)', data: counts, tension: 0.35 }] },
    options: { responsive: true, plugins: { legend: { display: false } } }
  });
}

// Map backend contract (available) → frontend shape (available_spots)
function mapBackendParking(p) {
  return {
    id: p.id,
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    capacity: p.capacity,
    available_spots: (typeof p.available_spots === 'number') ? p.available_spots : (p.available ?? 0),
    price: p.price,
    updated_at: p.updated_at || new Date().toISOString()
  };
}

const api = {
  async geoSearch(q) {
    if (USE_MOCK) return mock.geoSearch(q);
    // If no real geo endpoint yet, fall back to mock suggestions (non-blocking)
    try {
      const r = await fetch(`${API_BASE}/geo/search?q=${encodeURIComponent(q)}`);
      if (r.ok) return r.json();
    } catch (_) {}
    return mock.geoSearch(q);
  },
  async parkingNear(lat, lng, radius) {
    // Real backend doesn't support lat/lng in this iteration; only use mock for this path
    if (USE_MOCK) return mock.parkingNear(lat, lng, radius);
    return { items: [] };
  },
  async parkingByDest(dest) {
    const r = await fetch(`${API_BASE}/parking?dest=${encodeURIComponent(dest)}`, { cache: 'no-store' });
    const arr = await r.json();              // backend returns an array
    return { items: arr.map(mapBackendParking) }; // normalize to frontend shape
  },
  __mockPushUpdates(ids) { return mock.pushUpdates(ids); }
};

const mock = (() => {
  const places = [
    { place_id:'g-fedsq', name:'Federation Square', lat:-37.817979, lng:144.969093 },
    { place_id:'g-caulfield', name:'Monash Caulfield Campus', lat:-37.8770, lng:145.0443 },
    { place_id:'g-swanston', name:'Swanston St & Bourke St', lat:-37.8134, lng:144.9635 },
  ];
  let lots = [
    { id:'CP-101', name:'Flinders Lane Car Park', lat:-37.8173, lng:144.9655, capacity:220, available_spots: 88, price:'$3/hr' },
    { id:'CP-102', name:'Russell St Car Park',    lat:-37.8128, lng:144.9675, capacity:160, available_spots: 47, price:'$4/hr' },
    { id:'CP-103', name:'QV Car Park',            lat:-37.8106, lng:144.9652, capacity:120, available_spots: 12, price:'$5/hr' },
    { id:'CP-201', name:'Derby Rd Car Park',      lat:-37.8779, lng:145.0449, capacity:180, available_spots: 61, price:'$3/hr' },
    { id:'CP-202', name:'Caulfield Plaza Car Park',lat:-37.8765,lng:145.0431, capacity:140, available_spots:  9, price:'$3/hr' },
  ].map(p => ({ ...p, updated_at: new Date().toISOString() }));
  function toRad(d){ return d*Math.PI/180; }
  function haversine(a,b){ const R=6371000, dLat=toRad(b.lat-a.lat), dLng=toRad(b.lng-a.lng), la1=toRad(a.lat), la2=toRad(b.lat);
    const h=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }
  return {
    async geoSearch(q){ const qn=q.toLowerCase(); const items=places.filter(p=>p.name.toLowerCase().includes(qn)).slice(0,8); return { items }; },
    async parkingNear(lat,lng,radius=900){ const c={lat,lng}; const items=lots.filter(p=>haversine(c,p)<=radius).map(p=>({...p}));
      if (!items.length){ const nearest=lots.map(p=>({...p,_d:haversine(c,p)})).sort((a,b)=>a._d-b._d).slice(0,3).map(({_d,...r})=>r); return { items: nearest }; }
      return { items }; },
    pushUpdates(ids){ const changes=[]; for (const id of ids){ const i=lots.findIndex(l=>l.id===id); if (i===-1) continue;
      const delta=Math.floor((Math.random()-0.5)*8); lots[i].available_spots=Math.max(0,Math.min(lots[i].capacity,lots[i].available_spots+delta));
      lots[i].updated_at=new Date().toISOString(); changes.push({ ...lots[i] }); } return changes; }
  };
})();

function distanceMeters(a,b){ const R=6371000, toRad=d=>d*Math.PI/180, dLat=toRad(b.lat-a.lat), dLng=toRad(b.lng-a.lng), la1=toRad(a.lat), la2=toRad(b.lat);
  const h=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }

// ---- Auto-load initial car parks (no manual search needed) ----
let __initialLoaded = false;
async function loadInitialCarParks() {
  if (__initialLoaded) return;
  __initialLoaded = true;
  try {
    let items = [];
    // Prefer real backend if USE_MOCK is false
    if (!USE_MOCK) {
      const r = await fetch(`${API_BASE}/parking`, { cache: 'no-store' });
      const arr = await r.json();
      items = Array.isArray(arr) ? arr.map(mapBackendParking) : [];
    } else {
      // fallback to mock by default map center
      const { items: list } = await api.parkingNear(MAP_DEFAULT.lat, MAP_DEFAULT.lng, 1200);
      items = list || [];
    }

    // compute distance from map default center for display
    const center = { lat: MAP_DEFAULT.lat, lng: MAP_DEFAULT.lng };
    for (const it of items) it.distance_m = distanceMeters(center, it);

    // cache for "click map to choose nearest"
    window.__lastParkingItems = items.slice();

    // clear and render
    markers.clear(); cluster.clearLayers(); lotListEl.innerHTML = '';
    items.forEach((p) => { upsertMarker(p); lotListEl.appendChild(lotCard(p)); });

    // fit map if we have markers
    if (items.length && cluster.getLayers().length) {
      map.fitBounds(cluster.getBounds(), { padding: [20, 20] });
    }

    // status + charts + env tips
    if (typeof statusEl !== 'undefined' && statusEl) {
      statusEl.textContent = items.length ? `Showing ${items.length} car parks (initial load).` : 'No car parks available yet.';
    }
    renderCharts(items);
    // Provide a minimal env card without a chosen destination
    if (typeof renderEnvSuggestions === 'function') {
      const pseudoPlace = { name: 'Melbourne CBD', lat: MAP_DEFAULT.lat, lng: MAP_DEFAULT.lng };
      renderEnvSuggestions(pseudoPlace, items);
    }
    console.log('Initial car parks loaded:', items.length);
  } catch (err) {
    console.error('loadInitialCarParks failed:', err);
  }
}

// Run after DOM is ready
(function autoLoadBootstrap(){
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(loadInitialCarParks, 300);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(loadInitialCarParks, 300));
  }
})();
// ---- /Auto-load initial car parks ----

// Click anywhere on the map to focus the nearest car park and show details
(function enableNearestOnMapClick(){
  let enabled = false;
  if (enabled) return;
  enabled = true;
  map.on('click', (e) => {
    const list = Array.isArray(window.__lastParkingItems) ? window.__lastParkingItems : [];
    if (!list.length) return;
    const target = { lat: e.latlng.lat, lng: e.latlng.lng };
    const nearest = list.reduce((best, cur) => {
      const d = distanceMeters(target, cur);
      return (!best || d < best.dist) ? { node: cur, dist: d } : best;
    }, null);
    if (nearest && nearest.node) {
      map.setView([nearest.node.lat, nearest.node.lng], 17);
      showLotPopup(nearest.node);
    }
  });
})();
