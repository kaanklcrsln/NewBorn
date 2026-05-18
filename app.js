/* NewBorn — live world birth-rate visualization
 *
 * Data sources
 *  - World Bank: crude birth rate  SP.DYN.CBRT.IN   (births / 1000 people / year)
 *  - World Bank: total population  SP.POP.TOTL      (used to turn the rate into
 *                                                    an absolute births/second)
 *  - REST Countries: flags, names, ISO code crosswalk (cca3 <-> ccn3)
 *  - world-atlas (TopoJSON 110m): country polygons, keyed by numeric M49 id
 *
 * Join chain:
 *   GeoJSON.id (numeric M49) === RestCountries.ccn3
 *   RestCountries.cca3       === WorldBank.countryiso3code
 */

const SECONDS_PER_YEAR = 31_557_600;

const WB_BASE = "https://api.worldbank.org/v2/country/all/indicator";
const WB_QS = "?format=json&per_page=20000&mrnev=1"; // most recent non-empty value
const URLS = {
  birthRate: `${WB_BASE}/SP.DYN.CBRT.IN${WB_QS}`,
  population: `${WB_BASE}/SP.POP.TOTL${WB_QS}`,
  countries: "https://restcountries.com/v3.1/all?fields=name,cca3,ccn3,flags",
  world: "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json",
};

/* ---------- Map (fully fixed: no pan, no zoom) ---------- */

const map = L.map("map", {
  zoomControl: false,
  attributionControl: true,
  dragging: false,
  scrollWheelZoom: false,
  doubleClickZoom: false,
  boxZoom: false,
  touchZoom: false,
  keyboard: false,
  zoomSnap: 0,
  worldCopyJump: false,
});
map.attributionControl.setPrefix("");
// A view must exist before any layer is added, otherwise Leaflet throws.
map.setView([25, 5], 2);

/* ---------- State ---------- */

// iso3 -> { name, flag, perSec, count, layer, row, ... }
const countries = new Map();
let geoLayer = null;
let totalCount = 0;
let speedMultiplier = 1;
let isRunning = true;

const els = {
  board: document.getElementById("leaderboard"),
  loading: document.getElementById("loadingState"),
};

/* ---------- Data loading ---------- */

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

// World Bank returns [metadata, [rows]]; collapse to iso3 -> value
function indexWorldBank(payload) {
  const rows = Array.isArray(payload) ? payload[1] : null;
  const out = new Map();
  if (!rows) return out;
  for (const r of rows) {
    const iso3 = r.countryiso3code;
    if (iso3 && r.value != null) out.set(iso3, Number(r.value));
  }
  return out;
}

/* Un-smear polygons that straddle the antimeridian (Russia, Fiji):
 * if a ring spans > 180° of longitude, lift its negative longitudes by 360°
 * so the geometry stays continuous instead of streaking across the map. */
function unwrapAntimeridian(geometry) {
  const fixRing = (ring) => {
    let min = Infinity;
    let max = -Infinity;
    for (const [lng] of ring) {
      if (lng < min) min = lng;
      if (lng > max) max = lng;
    }
    if (max - min <= 180) return ring;
    return ring.map(([lng, lat]) => [lng < 0 ? lng + 360 : lng, lat]);
  };
  if (geometry.type === "Polygon") {
    geometry.coordinates = geometry.coordinates.map(fixRing);
  } else if (geometry.type === "MultiPolygon") {
    geometry.coordinates = geometry.coordinates.map((poly) =>
      poly.map(fixRing)
    );
  }
}

async function loadData() {
  const [cbrRaw, popRaw, restRaw, world] = await Promise.all([
    fetchJSON(URLS.birthRate),
    fetchJSON(URLS.population),
    fetchJSON(URLS.countries),
    fetchJSON(URLS.world),
  ]);

  const cbr = indexWorldBank(cbrRaw);
  const pop = indexWorldBank(popRaw);

  // numeric M49 (ccn3) -> rest countries record
  const byCcn3 = new Map();
  for (const c of restRaw) {
    if (!c.ccn3) continue;
    byCcn3.set(parseInt(c.ccn3, 10), {
      iso3: c.cca3,
      name: c.name?.common ?? c.cca3,
      flag: c.flags?.png ?? c.flags?.svg ?? "",
    });
  }

  for (const [iso3, rate] of cbr) {
    const population = pop.get(iso3);
    if (!population) continue;
    const perSec = ((rate / 1000) * population) / SECONDS_PER_YEAR;
    if (perSec <= 0) continue;
    countries.set(iso3, {
      iso3,
      name: iso3,
      flag: "",
      perSec,
      count: 0,
      layer: null,
      row: null,
    });
  }

  // attach geometry + names/flags via the numeric-code crosswalk
  const fc = topojson.feature(world, world.objects.countries);
  for (const feat of fc.features) {
    const meta = byCcn3.get(parseInt(feat.id, 10));
    if (!meta) continue;
    const country = countries.get(meta.iso3);
    if (!country) continue;
    country.name = meta.name;
    country.flag = meta.flag;
    feat.properties._iso3 = meta.iso3;
    if (meta.iso3 === "RUS" || meta.iso3 === "FJI") {
      unwrapAntimeridian(feat.geometry);
    }
  }

  geoLayer = L.geoJSON(fc, {
    style: { className: "country" },
    onEachFeature: (feat, layer) => {
      const iso3 = feat.properties._iso3;
      if (!iso3 || !countries.has(iso3)) return;
      const c = countries.get(iso3);
      c.layer = layer;
      // hover only — tooltip follows the cursor, no click behavior
      layer.bindTooltip(c.name, { sticky: true, direction: "top" });
    },
  }).addTo(map);

  // Frame the whole world once; interaction is disabled so it stays put.
  map.invalidateSize(false);
  // Frame from ~58°S up — that drops Antarctica out of view.
  // East edge goes past 180° because Russia was un-wrapped across it.
  map.fitBounds(
    L.latLngBounds([
      [-58, -180],
      [84, 195],
    ]),
    { padding: [12, 12], animate: false }
  );
  map.setZoom(map.getZoom() * 0.9, { animate: false }); // ~10% less than 1.0

  const worldPerSec = [...countries.values()].reduce(
    (s, c) => s + c.perSec,
    0
  );
  els.loading?.remove();

  return worldPerSec;
}

/* ---------- Weighted picker (cumulative) ---------- */

let cumulative = [];
let cumulativeTotal = 0;

function buildPicker() {
  cumulative = [];
  let acc = 0;
  for (const c of countries.values()) {
    if (!c.layer) continue; // only countries we can actually draw
    acc += c.perSec;
    cumulative.push({ ceil: acc, country: c });
  }
  cumulativeTotal = acc;
}

function pickCountry() {
  const target = Math.random() * cumulativeTotal;
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid].ceil < target) lo = mid + 1;
    else hi = mid;
  }
  return cumulative[lo].country;
}

/* ---------- Birth event ---------- */

function registerBirth(c) {
  c.count += 1;
  totalCount += 1;

  const path = c.layer?.getElement?.();
  if (path) {
    path.classList.remove("flash");
    void path.getBBox; // reflow so the transition re-triggers
    path.classList.add("flash");
    clearTimeout(c._flashTimer);
    c._flashTimer = setTimeout(() => path.classList.remove("flash"), 120);
  }
}

/* ---------- Simulation loop ---------- */

const TICK_MS = 200;

function poisson(lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.round(lambda + Math.sqrt(lambda) * gauss());
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}
function gauss() {
  return (
    Math.sqrt(-2 * Math.log(Math.random())) *
    Math.cos(2 * Math.PI * Math.random())
  );
}

function startSimulation() {
  setInterval(() => {
    if (!isRunning) return;
    const lambda = cumulativeTotal * (TICK_MS / 1000) * speedMultiplier;
    const births = poisson(lambda);
    for (let i = 0; i < births; i++) registerBirth(pickCountry());
    if (births > 0) scheduleBoardRender();
  }, TICK_MS);
}

/* ---------- Leaderboard ---------- */

let boardQueued = false;
function scheduleBoardRender() {
  if (boardQueued) return;
  boardQueued = true;
  requestAnimationFrame(() => {
    boardQueued = false;
    renderBoard();
  });
}

function renderBoard() {
  const ranked = [...countries.values()]
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 60);

  const frag = document.createDocumentFragment();
  ranked.forEach((c, i) => {
    let row = c.row;
    if (!row) {
      row = document.createElement("li");
      row.className = "lb-row";
      row.innerHTML = `
        <span class="lb-rank"></span>
        <img class="lb-flag" alt="" loading="lazy" />
        <span class="lb-name"></span>
        <span class="lb-count"></span>`;
      c.row = row;
      c._flagSet = false;
    }
    row.querySelector(".lb-rank").textContent = i + 1;
    if (!c._flagSet && c.flag) {
      const img = row.querySelector(".lb-flag");
      img.src = c.flag;
      img.alt = c.name;
      c._flagSet = true;
    }
    row.querySelector(".lb-name").textContent = c.name;
    const countEl = row.querySelector(".lb-count");
    if (countEl.textContent !== String(c.count)) {
      countEl.textContent = c.count;
      row.classList.add("bump");
      clearTimeout(c._bumpTimer);
      c._bumpTimer = setTimeout(() => row.classList.remove("bump"), 240);
    }
    frag.appendChild(row);
  });
  els.board.replaceChildren(frag);
}

/* ---------- Controls ---------- */

document.getElementById("speedRow").addEventListener("click", (e) => {
  const btn = e.target.closest(".speed-btn");
  if (!btn) return;
  speedMultiplier = Number(btn.dataset.speed);
  document
    .querySelectorAll(".speed-btn")
    .forEach((b) => b.classList.toggle("active", b === btn));
});

const playBtn = document.getElementById("playBtn");
const stopBtn = document.getElementById("stopBtn");
function setRunning(running) {
  isRunning = running;
  playBtn.classList.toggle("active", running);
  stopBtn.classList.toggle("active", !running);
}
playBtn.addEventListener("click", () => setRunning(true));
stopBtn.addEventListener("click", () => setRunning(false));

/* ---------- About panel ---------- */

const aboutOverlay = document.getElementById("aboutOverlay");
document
  .getElementById("helpBtn")
  .addEventListener("click", () => (aboutOverlay.hidden = false));
document
  .getElementById("aboutClose")
  .addEventListener("click", () => (aboutOverlay.hidden = true));
aboutOverlay.addEventListener("click", (e) => {
  if (e.target === aboutOverlay) aboutOverlay.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") aboutOverlay.hidden = true;
});

/* ---------- Boot ---------- */

(async function init() {
  try {
    await loadData();
    buildPicker();
    startSimulation();
  } catch (err) {
    console.error(err);
    if (els.loading)
      els.loading.textContent =
        "Could not load data — check your connection and reload.";
  }
})();
