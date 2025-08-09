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
  const { items } = await api.parkingNear(place.lat, place.lng, 900);

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

function popupHtml(p) {
  return `${p.name}<br/>Availability: <strong>${p.available_spots}/${p.capacity}</strong><br/><small>Updated: ${new Date(p.updated_at).toLocaleTimeString()}</small>`;
}
function upsertMarker(p) {
  const html = popupHtml(p);
  if (markers.has(p.id)) { markers.get(p.id).setPopupContent(html); return; }
  const m = L.marker([p.lat, p.lng]).bindPopup(html);
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
  div.onclick = () => { map.setView([p.lat, p.lng], 17); const m = markers.get(p.id); if (m) m.openPopup(); };
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
function renderCharts(lots) {
  const ctx1 = document.getElementById('avgOccChart');
  const ctx2 = document.getElementById('busyHoursChart');
  const labels = lots.map(l => l.name);
  const occ = lots.map(l => Math.round((l.capacity - l.available_spots) / l.capacity * 100));
  if (avgOccChart) avgOccChart.destroy();
  avgOccChart = new Chart(ctx1, { type: 'bar', data: { labels, datasets: [{ label: 'Occupancy %', data: occ }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100 } } } });
  const hours = ['8','9','10','11','12','13','14','15','16','17'];
  const counts = hours.map(() => Math.floor(Math.random()*100));
  if (busyHoursChart) busyHoursChart.destroy();
busyHoursChart = new Chart(ctx2, {
    type: 'line',
    data: {
        labels: hours,
        datasets: [{
            label: 'Cars/hour (mock)',
            data: counts,
            tension: 0.35
        }]
    },
    options: {
        responsive: true,
        plugins: {
            legend: { display: false }
        }
    }
});

}

const api = {
  async geoSearch(q){ if (USE_MOCK) return mock.geoSearch(q); const r = await fetch(`${API_BASE}/geo/search?q=${encodeURIComponent(q)}`); return r.json(); },
  async parkingNear(lat,lng,radius){ if (USE_MOCK) return mock.parkingNear(lat,lng,radius); const r = await fetch(`${API_BASE}/parking/near?lat=${lat}&lng=${lng}&radius=${radius}`); return r.json(); },
  __mockPushUpdates(ids){ return mock.pushUpdates(ids); }
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
