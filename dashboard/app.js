const DATASETS = {
  capacity: "../data/output/capacity_by_prefecture.csv",
  points: "../data/prefecture_points.csv",
  japan: "./japan.topojson",
  facilities: "../data/output/solar_facilities_geocoded.csv",
  baseline: "./data/baseline_monthly_ghi.json",
};

// データソース: "hybrid" = yr.no + clearSky + NEDO/NASA baseline (推奨)
//              "openmeteo" = 旧 Open-Meteo 直接 (フォールバック)
const FORECAST_SOURCE = "hybrid";

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/jma";
const YR_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact";

const FORECAST_GRID_STEP = 0.5;
const FORECAST_GRID_STEP_FALLBACK = 1.0;
const FORECAST_GRID_MAX_POINTS = 400;
const FORECAST_REFRESH_MS = 60 * 60 * 1000;          // hybrid: 1時間
const FORECAST_REFRESH_MS_OPENMETEO = 3 * 60 * 60 * 1000;

const YR_REQUEST_INTERVAL_MS = 120;                   // yr.no への礼儀正しい間隔
const HYBRID_CACHE_TTL_MS = 60 * 60 * 1000;           // 1時間

const PERFORMANCE_RATIO = 0.80;
const TILT_DEG = 30.0;
const AZIMUTH_DEG = 0.0;
const FORECAST_MODEL = "jma_seamless";
const BASELINE_SCALE_MIN = 0.25;
const BASELINE_SCALE_MAX = 1.25;

let baselineByPref = null;  // { 県名: { lat, lon, monthly_ghi_kwh_m2_day: [12] } }
let baselineScaleCache = new Map();

const HORIZONS = ["now", "today", "tomorrow"];
let currentHorizon = "today";

let leafletMap = null;
let prefectureGeoLayer = null;
let forecastMarkersLayer = null;
let forecastMarkerByPref = new Map();
let hiddenPrefs = new Set();
let prefRowsCache = null;
let prefHourlyCache = new Map();
let facilitiesCache = [];
let facilityGridForecastCache = new Map();
let facilityMarkerById = new Map();
let facilityGridStep = FORECAST_GRID_STEP;

const JAPAN_BOUNDS = [
  [24.0, 122.0],
  [46.5, 146.5],
];

const numberFormat = new Intl.NumberFormat("ja-JP", {
  maximumFractionDigits: 0,
});

const oneDecimalFormat = new Intl.NumberFormat("ja-JP", {
  maximumFractionDigits: 1,
});

const percentFormat = new Intl.NumberFormat("ja-JP", {
  style: "percent",
  maximumFractionDigits: 1,
});

function parseCsv(text) {
  const rows = [];
  const lines = text.trim().split(/\r?\n/);
  const headers = parseCsvLine(lines.shift() || "");

  for (const line of lines) {
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    rows.push(row);
  }

  return rows;
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

async function loadCsv(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${path}: ${response.status}`);
  }
  return parseCsv(await response.text());
}

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function jstToday() {
  const ms = Date.now() + 9 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function jstTomorrow() {
  const ms = Date.now() + 9 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function jstNowHourIso() {
  const ms = Date.now() + 9 * 60 * 60 * 1000;
  const d = new Date(ms);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 13);
}

function horizonLabel(h) {
  if (h === "now") return "現在";
  if (h === "tomorrow") return "翌日";
  return "当日";
}

function aggregateHourly(hourly, horizon) {
  const times = hourly?.times || [];
  const gti = hourly?.gti || [];
  const cloud = hourly?.cloud || [];
  const derate = hourly?.derate || [];
  if (!times.length) {
    return { gtiKwhM2: 0, deratedGtiKwhM2: 0, cloudPct: NaN, gtiNowWm2: NaN, derateNow: 1, mode: horizon };
  }

  if (horizon === "now") {
    const nowPrefix = jstNowHourIso();
    let idx = times.findIndex((t) => t.startsWith(nowPrefix));
    if (idx < 0) {
      const today = jstToday();
      idx = times.findIndex((t) => t.startsWith(today));
      if (idx < 0) idx = 0;
    }
    const gtiW = Math.max(0, gti[idx] ?? 0);
    return {
      gtiKwhM2: gtiW / 1000,
      deratedGtiKwhM2: NaN,
      cloudPct: Number.isFinite(cloud[idx]) ? cloud[idx] : NaN,
      gtiNowWm2: gtiW,
      derateNow: Number.isFinite(derate[idx]) ? derate[idx] : 1,
      mode: "now",
    };
  }

  const target = horizon === "tomorrow" ? jstTomorrow() : jstToday();
  let gtiSum = 0;
  let deratedGtiSum = 0;
  let cloudSum = 0;
  let cloudN = 0;
  for (let i = 0; i < times.length; i += 1) {
    if (!times[i].startsWith(target)) continue;
    const gtiW = Math.max(0, gti[i] ?? 0);
    gtiSum += gtiW / 1000;
    deratedGtiSum += (gtiW * (Number.isFinite(derate[i]) ? derate[i] : 1)) / 1000;
    if (Number.isFinite(cloud[i])) {
      cloudSum += cloud[i];
      cloudN += 1;
    }
  }
  return {
    gtiKwhM2: gtiSum,
    deratedGtiKwhM2: deratedGtiSum,
    cloudPct: cloudN ? cloudSum / cloudN : NaN,
    gtiNowWm2: NaN,
    derateNow: 1,
    mode: horizon,
  };
}

function buildPrefRows(pointRows, capacityRows) {
  const capById = new Map(capacityRows.map((r) => [r.prefecture, r]));
  const list = [];
  for (const p of pointRows) {
    const cap = capById.get(p.prefecture);
    if (!cap) continue;
    const lat = toNumber(p.latitude, NaN);
    const lon = toNumber(p.longitude, NaN);
    const capacityKw = toNumber(cap.capacity_kw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    list.push({
      prefecture: p.prefecture,
      latitude: lat,
      longitude: lon,
      capacityKw,
      city: p.city || "",
    });
  }
  return list;
}

function buildPrefForecastRows(prefList, horizon) {
  const out = [];
  for (const pref of prefList) {
    const hourly = prefHourlyCache.get(pref.prefecture);
    const agg = aggregateHourly(hourly, horizon);
    const capacityMw = pref.capacityKw / 1000;
    let estimatedMwh = 0;
    let capacityFactor = 0;
    if (horizon === "now") {
      const kw = pref.capacityKw * PERFORMANCE_RATIO * (agg.gtiNowWm2 / 1000) * agg.derateNow;
      estimatedMwh = kw / 1000;
      capacityFactor = capacityMw > 0 ? estimatedMwh / capacityMw : 0;
    } else {
      estimatedMwh = (pref.capacityKw * PERFORMANCE_RATIO * agg.deratedGtiKwhM2) / 1000;
      capacityFactor = capacityMw > 0 ? estimatedMwh / (capacityMw * 24) : 0;
    }
    out.push({
      prefecture: pref.prefecture,
      city: pref.city,
      date: horizon === "tomorrow" ? jstTomorrow() : jstToday(),
      capacityKw: pref.capacityKw,
      capacityMw,
      estimatedMwh,
      capacityFactor,
      gtiKwhM2: agg.gtiKwhM2,
      cloudCoverPct: agg.cloudPct,
      latitude: pref.latitude,
      longitude: pref.longitude,
      horizon,
    });
  }
  return out;
}

function lerpColor(a, b, t) {
  const ah = parseInt(a.slice(1), 16);
  const bh = parseInt(b.slice(1), 16);
  const ar = (ah >> 16) & 0xff, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
  const br = (bh >> 16) & 0xff, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

function weatherColor(cloudPct) {
  if (!Number.isFinite(cloudPct)) return "#f8fafc";
  const t = Math.max(0, Math.min(cloudPct / 100, 1));
  if (t < 0.5) return lerpColor("#fb923c", "#fde68a", t * 2);
  return lerpColor("#fde68a", "#94a3b8", (t - 0.5) * 2);
}

function markerColor(value, max) {
  if (!max) return "#38bdf8";
  const ratio = Math.max(0, Math.min(value / max, 1));
  if (ratio < 0.45) return "#38bdf8";
  if (ratio < 0.75) return "#22c55e";
  return "#d97706";
}

function markerRadius(capacityMw, maxCapacityMw) {
  if (!maxCapacityMw) return 12;
  return 10 + Math.sqrt(capacityMw / maxCapacityMw) * 22;
}

function metricGenerationText(rows, horizon) {
  const total = rows.reduce((sum, row) => sum + (row.estimatedMwh || 0), 0);
  if (horizon === "now") {
    return `${numberFormat.format(total * 1000)} kW`;
  }
  return `${numberFormat.format(total)} MWh`;
}

function metricGenerationLabel(horizon) {
  return horizon === "now" ? "推定出力" : "推定発電量";
}

function metricCfLabel(horizon) {
  return horizon === "now" ? "最大出力率" : "最大設備利用率";
}

function renderSummary(rows) {
  const totalCapacityMw = rows.reduce((sum, row) => sum + row.capacityMw, 0);
  const maxCapacityFactor = Math.max(...rows.map((row) => row.capacityFactor), 0);
  const date = rows.find((row) => row.date)?.date || "容量データ";

  document.querySelector("#summary-date").textContent = `${date} (${horizonLabel(currentHorizon)})`;
  document.querySelector("#metric-sites").textContent = `${rows.length}`;
  document.querySelector("#metric-capacity").textContent = `${numberFormat.format(totalCapacityMw)} MW`;
  const genLabelEl = document.querySelector("#metric-generation-label");
  if (genLabelEl) genLabelEl.textContent = metricGenerationLabel(currentHorizon);
  document.querySelector("#metric-generation").textContent = metricGenerationText(rows, currentHorizon);
  const cfLabelEl = document.querySelector("#metric-capacity-factor-label");
  if (cfLabelEl) cfLabelEl.textContent = metricCfLabel(currentHorizon);
  document.querySelector("#metric-capacity-factor").textContent = percentFormat.format(maxCapacityFactor);
}


function renderTable(rows) {
  const table = document.querySelector("#site-table");
  table.replaceChildren();

  const generationHeader = currentHorizon === "now" ? "出力" : "発電量";
  const genHeaderEl = document.querySelector("#th-generation");
  if (genHeaderEl) genHeaderEl.textContent = generationHeader;

  const sorted = [...rows].sort((a, b) => b.capacityMw - a.capacityMw);
  for (const row of sorted) {
    const tr = document.createElement("tr");
    const checked = hiddenPrefs.has(row.prefecture) ? "" : "checked";
    const generationCell = currentHorizon === "now"
      ? `${numberFormat.format(row.estimatedMwh * 1000)} kW`
      : `${numberFormat.format(row.estimatedMwh)} MWh`;
    tr.innerHTML = `
      <td><input type="checkbox" class="pref-toggle" data-pref="${row.prefecture}" ${checked}></td>
      <td><div class="site-name">${row.prefecture}<span>${row.city}</span></div></td>
      <td>${numberFormat.format(row.capacityMw)} MW</td>
      <td>${generationCell}</td>
      <td>${row.capacityFactor ? percentFormat.format(row.capacityFactor) : "-"}</td>
    `;
    table.append(tr);
  }

  if (!table.dataset.toggleBound) {
    table.addEventListener("change", (e) => {
      const cb = e.target.closest("input.pref-toggle");
      if (!cb) return;
      setPrefVisible(cb.dataset.pref, cb.checked);
    });
    table.dataset.toggleBound = "1";
  }
}

function snapToGrid(value, step) {
  return Math.round(value / step) * step;
}

function gridKey(lat, lon) {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

function buildFacilities(facilityRows) {
  return facilityRows
    .map((row) => {
      const lat = toNumber(row.latitude, NaN);
      const lon = toNumber(row.longitude, NaN);
      return {
        facilityId: row.facility_id || "",
        prefecture: row.prefecture || "",
        address: row.address || "",
        matchedAddress: row.matched_address || "",
        capacityKw: toNumber(row.capacity_kw),
        capacityMw: toNumber(row.capacity_kw) / 1000,
        latitude: lat,
        longitude: lon,
        estimatedMwh: null,
        capacityFactor: null,
        gtiKwhM2: null,
        cloudPct: null,
      };
    })
    .filter((f) => Number.isFinite(f.latitude) && Number.isFinite(f.longitude) && f.capacityMw > 0);
}

function assignFacilityGrid(facilities, step) {
  for (const f of facilities) {
    f.gridLat = snapToGrid(f.latitude, step);
    f.gridLon = snapToGrid(f.longitude, step);
    f.gridKey = gridKey(f.gridLat, f.gridLon);
  }
}

function buildForecastGridPoints(facilities) {
  const seen = new Map();
  for (const f of facilities) {
    if (!seen.has(f.gridKey)) {
      seen.set(f.gridKey, { lat: f.gridLat, lon: f.gridLon });
    }
  }
  return Array.from(seen.values());
}

function facilityRadius(capacityMw, maxMw) {
  if (!maxMw) return 4;
  return 3 + Math.sqrt(capacityMw / maxMw) * 14;
}

function facilityRateColor(rate) {
  if (!Number.isFinite(rate) || rate <= 0) return "#cbd5e1";
  const t = Math.max(0, Math.min(rate / 0.30, 1));
  if (t < 0.5) return lerpColor("#38bdf8", "#22c55e", t * 2);
  return lerpColor("#22c55e", "#ea580c", (t - 0.5) * 2);
}

function facilityTooltipHtml(f) {
  const rateTxt = Number.isFinite(f.capacityFactor) ? percentFormat.format(f.capacityFactor) : "予測待ち";
  const label = currentHorizon === "now" ? "出力率" : "発電率";
  return `<div class="tooltip-pref">${f.prefecture}</div>
       <div class="tooltip-val">${oneDecimalFormat.format(f.capacityMw)} MW / ${label} ${rateTxt}</div>
       <div class="tooltip-sub">${f.address}</div>`;
}

function facilityPopupHtml(f) {
  const rateTxt = Number.isFinite(f.capacityFactor) ? percentFormat.format(f.capacityFactor) : "-";
  const generationTxt = Number.isFinite(f.estimatedMwh)
    ? (currentHorizon === "now"
        ? `${oneDecimalFormat.format(f.estimatedMwh * 1000)} kW`
        : `${oneDecimalFormat.format(f.estimatedMwh)} MWh`)
    : "-";
  const generationLabel = currentHorizon === "now" ? "推定出力" : "推定発電量";
  const rateLabel = currentHorizon === "now" ? "出力率" : "発電率";
  const gtiTxt = Number.isFinite(f.gtiKwhM2) ? oneDecimalFormat.format(f.gtiKwhM2) + " kWh/m²" : "-";
  return `
      <div class="popup-title">${f.prefecture}<span>FIT ID ${f.facilityId}</span></div>
      <dl class="popup-grid">
        <dt>設備容量</dt><dd>${oneDecimalFormat.format(f.capacityMw)} MW</dd>
        <dt>${generationLabel}</dt><dd>${generationTxt}</dd>
        <dt>${rateLabel}</dt><dd>${rateTxt}</dd>
        <dt>代表 GTI</dt><dd>${gtiTxt}</dd>
        <dt>住所</dt><dd>${f.address}</dd>
        <dt>座標</dt><dd>${f.latitude.toFixed(4)}, ${f.longitude.toFixed(4)}</dd>
      </dl>
    `;
}

function addFacilityLayer(map, facilities) {
  if (!facilities.length) return null;
  const layer = L.layerGroup();
  const maxMw = Math.max(...facilities.map((f) => f.capacityMw));
  facilityMarkerById.clear();

  for (const f of facilities) {
    const m = L.circleMarker([f.latitude, f.longitude], {
      radius: facilityRadius(f.capacityMw, maxMw),
      color: "#1f2937",
      weight: 0.8,
      fillColor: facilityRateColor(f.capacityFactor),
      fillOpacity: 0.85,
    });
    m.bindTooltip(facilityTooltipHtml(f), { direction: "top", offset: [0, -4], sticky: false });
    m.bindPopup(facilityPopupHtml(f));
    layer.addLayer(m);
    facilityMarkerById.set(f.facilityId || `${f.latitude},${f.longitude}`, m);
  }

  layer.addTo(map);
  return layer;
}

function updateFacilityMarkers(facilities) {
  for (const f of facilities) {
    const key = f.facilityId || `${f.latitude},${f.longitude}`;
    const m = facilityMarkerById.get(key);
    if (!m) continue;
    m.setStyle({ fillColor: facilityRateColor(f.capacityFactor) });
    m.setTooltipContent(facilityTooltipHtml(f));
    m.setPopupContent(facilityPopupHtml(f));
  }
}

function initMap(japanTopo, facilities) {
  const map = L.map("map", {
    zoomControl: false,
    minZoom: 4,
    maxZoom: 12,
    attributionControl: false,
  }).fitBounds(JAPAN_BOUNDS);
  map.setZoom(map.getZoom() + 1);

  leafletMap = map;
  L.control.zoom({ position: "bottomright" }).addTo(map);

  if (japanTopo) {
    const objKey = Object.keys(japanTopo.objects)[0];
    const gj = topojson.feature(japanTopo, japanTopo.objects[objKey]);
    prefectureGeoLayer = L.geoJSON(gj, {
      style: () => ({
        color: "#8a9fa8",
        weight: 0.6,
        fillColor: "#f8fafc",
        fillOpacity: 0.7,
      }),
      interactive: false,
    }).addTo(map);
  }

  const facilityLayer = addFacilityLayer(map, facilities || []);

  forecastMarkersLayer = L.layerGroup();

  const overlays = { "都道府県マーカー": forecastMarkersLayer };
  if (facilityLayer) overlays["個別施設 (≥5MW)"] = facilityLayer;
  L.control.layers(null, overlays, { position: "topright", collapsed: false }).addTo(map);

  requestAnimationFrame(() => {
    map.invalidateSize();
    map.fitBounds(JAPAN_BOUNDS);
  });
}

function updatePrefectureLayer(rows) {
  if (!prefectureGeoLayer) return;
  const byPref = new Map(rows.map((r) => [r.prefecture, r]));
  prefectureGeoLayer.setStyle((feature) => {
    const r = byPref.get(feature.properties.nam_ja);
    return {
      color: "#8a9fa8",
      weight: 0.6,
      fillColor: weatherColor(r?.cloudCoverPct),
      fillOpacity: 0.7,
    };
  });
}

function updateForecastMarkers(rows) {
  if (!leafletMap || !forecastMarkersLayer) return;
  forecastMarkersLayer.clearLayers();
  forecastMarkerByPref.clear();
  const maxGeneration = Math.max(...rows.map((row) => row.estimatedMwh), 0);
  const maxCapacityMw = Math.max(...rows.map((row) => row.capacityMw), 0);
  const generationLabel = currentHorizon === "now" ? "推定出力" : "推定発電量";
  const rateLabel = currentHorizon === "now" ? "出力率" : "設備利用率";

  for (const row of rows) {
    const marker = L.circleMarker([row.latitude, row.longitude], {
      radius: markerRadius(row.capacityMw, maxCapacityMw),
      color: "#ffffff",
      weight: 2,
      fillColor: markerColor(row.estimatedMwh, maxGeneration),
      fillOpacity: 0.82,
      opacity: 1,
    });

    const generationText = currentHorizon === "now"
      ? `${numberFormat.format(row.estimatedMwh * 1000)} kW`
      : `${numberFormat.format(row.estimatedMwh)} MWh`;

    marker.bindTooltip(
      `<div class="tooltip-pref">${row.prefecture}</div>
       <div class="tooltip-val">${generationText}</div>
       <div class="tooltip-sub">雲量 ${oneDecimalFormat.format(row.cloudCoverPct)}%</div>`,
      { direction: "top", offset: [0, -6], sticky: false }
    );

    marker.bindPopup(`
      <div class="popup-title">${row.prefecture}<span>${row.city}</span></div>
      <dl class="popup-grid">
        <dt>設備容量</dt><dd>${oneDecimalFormat.format(row.capacityMw)} MW</dd>
        <dt>${generationLabel}</dt><dd>${generationText}</dd>
        <dt>${rateLabel}</dt><dd>${row.capacityFactor ? percentFormat.format(row.capacityFactor) : "-"}</dd>
        <dt>座標</dt><dd>${row.latitude.toFixed(3)}, ${row.longitude.toFixed(3)}</dd>
      </dl>
    `);

    forecastMarkerByPref.set(row.prefecture, marker);
    if (!hiddenPrefs.has(row.prefecture)) {
      forecastMarkersLayer.addLayer(marker);
    }
  }
}

function setPrefVisible(prefecture, visible) {
  const marker = forecastMarkerByPref.get(prefecture);
  if (!marker || !forecastMarkersLayer) return;
  if (visible) {
    hiddenPrefs.delete(prefecture);
    if (!forecastMarkersLayer.hasLayer(marker)) forecastMarkersLayer.addLayer(marker);
  } else {
    hiddenPrefs.add(prefecture);
    if (forecastMarkersLayer.hasLayer(marker)) forecastMarkersLayer.removeLayer(marker);
  }
}

function setAllPrefsVisible(visible) {
  for (const pref of forecastMarkerByPref.keys()) {
    setPrefVisible(pref, visible);
  }
  document.querySelectorAll("#site-table input.pref-toggle").forEach((cb) => {
    cb.checked = visible;
  });
}

function renderError(error) {
  document.querySelector("#data-status").textContent = "error";
  document.querySelector("#site-table").innerHTML = `
    <tr>
      <td colspan="5">
        <div class="error-state">${error.message}</div>
      </td>
    </tr>
  `;
}

function pickSeries(hourly, base) {
  if (hourly[base]) return hourly[base];
  for (const k of Object.keys(hourly)) {
    if (k.startsWith(base + "_")) return hourly[k];
  }
  return [];
}

// === yr.no + ClearSky 合成パス ============================================

function hasUsableHourly(hourly) {
  return (
    hourly
    && Array.isArray(hourly.times)
    && Array.isArray(hourly.gti)
    && Array.isArray(hourly.cloud)
    && hourly.times.length > 0
  );
}

// "2026-06-27T00:00:00Z" → "2026-06-27T09" (JST 時刻文字列)
function utcIsoToJstHourString(utcIso) {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return "";
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 13);
}

// クリアスカイ hourly を JST 0時から 48時間分作成
function buildClearSkyHourly(lat, lon) {
  const todayMs = Date.now();
  const jstNow = new Date(todayMs + 9 * 3600 * 1000);
  const jstMidnightUtcMs = Date.UTC(
    jstNow.getUTCFullYear(),
    jstNow.getUTCMonth(),
    jstNow.getUTCDate(),
  ) - 9 * 3600 * 1000;
  const times = [];
  const clearGhi = [];
  for (let h = 0; h < 48; h += 1) {
    const t = new Date(jstMidnightUtcMs + h * 3600 * 1000);
    times.push(utcIsoToJstHourString(t.toISOString()));
    clearGhi.push(window.Solar.clearSkyGHI(lat, lon, t));
  }
  return { times, clearGhi };
}

function clearSkyDailyKwhForMonth(lat, lon, monthIndex) {
  const year = 2021; // 非うるう年。日射平年値との月平均比較用なので固定する。
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  let sum = 0;
  for (let day = 1; day <= days; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const t = new Date(Date.UTC(year, monthIndex, day, hour) - 9 * 3600 * 1000);
      sum += window.Solar.clearSkyGHI(lat, lon, t) / 1000;
    }
  }
  return sum / days;
}

function findNearestBaseline(lat, lon) {
  if (!baselineByPref) return null;
  let best = null;
  let bestDist = Infinity;
  for (const [prefecture, entry] of Object.entries(baselineByPref)) {
    const entryLat = Number(entry?.lat);
    const entryLon = Number(entry?.lon);
    const monthly = entry?.monthly_ghi_kwh_m2_day;
    if (!Number.isFinite(entryLat) || !Number.isFinite(entryLon) || !Array.isArray(monthly)) continue;
    const dLat = lat - entryLat;
    const dLon = lon - entryLon;
    const dist = dLat * dLat + dLon * dLon;
    if (dist < bestDist) {
      best = { prefecture, entry };
      bestDist = dist;
    }
  }
  return best;
}

function baselineScaleFactorsForPoint(lat, lon) {
  const nearest = findNearestBaseline(lat, lon);
  if (!nearest) return null;
  if (baselineScaleCache.has(nearest.prefecture)) return baselineScaleCache.get(nearest.prefecture);

  const factors = nearest.entry.monthly_ghi_kwh_m2_day.map((baselineDaily, monthIndex) => {
    const clearSkyDaily = clearSkyDailyKwhForMonth(nearest.entry.lat, nearest.entry.lon, monthIndex);
    if (!(baselineDaily > 0) || !(clearSkyDaily > 0)) return 1;
    const ratio = baselineDaily / clearSkyDaily;
    return Math.max(BASELINE_SCALE_MIN, Math.min(BASELINE_SCALE_MAX, ratio));
  });
  baselineScaleCache.set(nearest.prefecture, factors);
  return factors;
}

function baselineScaleForHour(jstHour, factors) {
  if (!factors) return 1;
  const monthIndex = Number(jstHour.slice(5, 7)) - 1;
  const factor = factors[monthIndex];
  return Number.isFinite(factor) ? factor : 1;
}

// yr.no compact エンドポイントから cloud_area_fraction を取得
async function fetchYrCloudHourly(lat, lon, cachedHourly) {
  const url = `${YR_URL}?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
  const headers = { "Accept": "application/json" };
  if (hasUsableHourly(cachedHourly) && cachedHourly.lastModified) {
    headers["If-Modified-Since"] = cachedHourly.lastModified;
  }
  const res = await fetch(url, { headers });
  if (res.status === 304) return { notModified: true };
  if (!res.ok) throw new Error(`yr.no ${res.status}`);
  const data = await res.json();
  const series = data.properties?.timeseries || [];
  const times = [];
  const cloud = [];
  const temp = [];
  for (const s of series) {
    const cc = s.data?.instant?.details?.cloud_area_fraction;
    if (cc == null) continue;
    times.push(s.time);
    cloud.push(cc);
    temp.push(s.data?.instant?.details?.air_temperature ?? null);
  }
  return {
    notModified: false,
    times,
    cloud,
    temp,
    lastModified: res.headers.get("last-modified") || "",
  };
}

// yr.no の生 hourly (UTC, 不規則間隔) を JST 0時始まり 1時間刻みに揃え、ClearSky と合成。
function synthesizeHourly(lat, lon, yrTimes, yrCloud, yrTemp) {
  const cs = buildClearSkyHourly(lat, lon);
  const baselineScales = baselineScaleFactorsForPoint(lat, lon);
  const cloudByJstHour = new Map();
  const tempByJstHour = new Map();
  for (let i = 0; i < yrTimes.length; i += 1) {
    const h = utcIsoToJstHourString(yrTimes[i]);
    if (!cloudByJstHour.has(h)) cloudByJstHour.set(h, yrCloud[i]);
    if (!tempByJstHour.has(h) && Number.isFinite(yrTemp?.[i])) tempByJstHour.set(h, yrTemp[i]);
  }
  const times = cs.times;
  const cloud = new Array(times.length);
  const gti = new Array(times.length);
  const derate = new Array(times.length);
  let lastCloud = 0;
  let lastTemp = 15; // 観測なし時のフォールバック (日本の年平均気温近辺)
  for (let i = 0; i < times.length; i += 1) {
    const cc = cloudByJstHour.get(times[i]);
    const ccVal = Number.isFinite(cc) ? cc : lastCloud;
    if (Number.isFinite(cc)) lastCloud = cc;
    cloud[i] = ccVal;
    const tt = tempByJstHour.get(times[i]);
    const tVal = Number.isFinite(tt) ? tt : lastTemp;
    if (Number.isFinite(tt)) lastTemp = tVal;
    const baselineScale = baselineScaleForHour(times[i], baselineScales);
    const ghi = window.Solar.applyCloudCorrection(cs.clearGhi[i] * baselineScale, ccVal);
    gti[i] = window.Solar.ghiToGti(ghi, lat, TILT_DEG);
    derate[i] = window.Solar.temperatureDerate(tVal, gti[i]);
  }
  return { times, gti, cloud, derate };
}

async function fetchHybridForCoords(coords, onProgress, cachedHourlyArr = []) {
  const results = new Array(coords.length);
  let okCount = 0;
  let notModCount = 0;
  for (let i = 0; i < coords.length; i += 1) {
    const c = coords[i];
    const key = `${c.lat.toFixed(3)},${c.lon.toFixed(3)}`;
    const cachedHourly = cachedHourlyArr[i];
    try {
      const r = await fetchYrCloudHourly(c.lat, c.lon, cachedHourly);
      if (r.notModified) {
        if (!hasUsableHourly(cachedHourly)) throw new Error("yr.no 304 without cached hourly");
        results[i] = { ...cachedHourly };
        notModCount += 1;
      } else {
        const hourly = synthesizeHourly(c.lat, c.lon, r.times, r.cloud, r.temp);
        if (r.lastModified) hourly.lastModified = r.lastModified;
        results[i] = hourly;
        okCount += 1;
      }
    } catch (e) {
      results[i] = null;
      console.warn(`yr.no fetch fail ${key}:`, e.message);
    }
    if (onProgress) onProgress(i + 1, coords.length, okCount, notModCount);
    if (i + 1 < coords.length) {
      await new Promise((r) => setTimeout(r, YR_REQUEST_INTERVAL_MS));
    }
  }
  return results;
}

// === Open-Meteo パス（既存） ==============================================

const COOLDOWN_KEY = "open_meteo_cooldown_until";
const COOLDOWN_MS_ON_429 = 30 * 60 * 1000;

function getCooldownRemainingMs() {
  try {
    const v = Number(localStorage.getItem(COOLDOWN_KEY) || 0);
    const left = v - Date.now();
    return left > 0 ? left : 0;
  } catch { return 0; }
}

function setCooldown(ms) {
  try {
    localStorage.setItem(COOLDOWN_KEY, String(Date.now() + ms));
  } catch {}
}

async function fetchHourlyForCoords(coords) {
  const cooldownLeft = getCooldownRemainingMs();
  if (cooldownLeft > 0) {
    throw new Error(`Open-Meteo cooldown ${Math.ceil(cooldownLeft / 60000)}分`);
  }
  const params = new URLSearchParams({
    latitude: coords.map((c) => c.lat).join(","),
    longitude: coords.map((c) => c.lon).join(","),
    timezone: "Asia/Tokyo",
    forecast_days: 2,
    hourly: "global_tilted_irradiance,cloud_cover",
    tilt: TILT_DEG,
    azimuth: AZIMUTH_DEG,
    models: FORECAST_MODEL,
    cell_selection: "land",
  });
  const res = await fetch(`${OPEN_METEO_URL}?${params}`);
  if (res.ok) {
    const data = await res.json();
    const arr = Array.isArray(data) ? data : [data];
    return arr.map((resp) => {
      const hourly = resp.hourly || {};
      return {
        times: hourly.time || [],
        gti: pickSeries(hourly, "global_tilted_irradiance"),
        cloud: pickSeries(hourly, "cloud_cover"),
      };
    });
  }
  if (res.status === 429) {
    setCooldown(COOLDOWN_MS_ON_429);
  }
  throw new Error(`Open-Meteo ${res.status}`);
}

async function fetchForecastForGrid(gridPoints, onProgress, cachedHourlyArr = []) {
  if (FORECAST_SOURCE === "hybrid") {
    const result = new Map();
    const hourlyArr = await fetchHybridForCoords(gridPoints, onProgress, cachedHourlyArr);
    hourlyArr.forEach((hourly, idx) => {
      const pt = gridPoints[idx];
      if (hourly) result.set(gridKey(pt.lat, pt.lon), hourly);
    });
    return result;
  }
  // openmeteo パス
  const result = new Map();
  const CHUNK = 100;
  for (let i = 0; i < gridPoints.length; i += CHUNK) {
    const chunk = gridPoints.slice(i, i + CHUNK);
    const hourlyArr = await fetchHourlyForCoords(chunk);
    hourlyArr.forEach((hourly, idx) => {
      const pt = chunk[idx];
      result.set(gridKey(pt.lat, pt.lon), hourly);
    });
    if (onProgress) onProgress(Math.min(i + CHUNK, gridPoints.length), gridPoints.length);
    if (i + CHUNK < gridPoints.length) await new Promise((r) => setTimeout(r, 3000));
  }
  return result;
}

function applyFacilityForecast(facilities, gridForecast, horizon) {
  for (const f of facilities) {
    const hourly = gridForecast.get(f.gridKey);
    if (!hourly) {
      f.estimatedMwh = null;
      f.capacityFactor = null;
      f.gtiKwhM2 = null;
      f.cloudPct = null;
      continue;
    }
    const agg = aggregateHourly(hourly, horizon);
    f.gtiKwhM2 = agg.gtiKwhM2;
    f.cloudPct = agg.cloudPct;
    if (horizon === "now") {
      const kw = f.capacityKw * PERFORMANCE_RATIO * (agg.gtiNowWm2 / 1000) * agg.derateNow;
      f.estimatedMwh = kw / 1000;
      f.capacityFactor = f.capacityKw > 0 ? kw / f.capacityKw : 0;
    } else {
      const kwh = f.capacityKw * PERFORMANCE_RATIO * agg.deratedGtiKwhM2;
      f.estimatedMwh = kwh / 1000;
      f.capacityFactor = f.capacityKw > 0 ? kwh / (f.capacityKw * 24) : 0;
    }
  }
}

const FACILITY_CACHE_KEY = FORECAST_SOURCE === "hybrid" ? "facility_forecast_hybrid_v1" : "facility_forecast_v2";
const PREF_CACHE_KEY = FORECAST_SOURCE === "hybrid" ? "pref_forecast_hybrid_v1" : "pref_forecast_v2";
const FORECAST_CACHE_TTL_MS = FORECAST_SOURCE === "hybrid" ? HYBRID_CACHE_TTL_MS : 6 * 60 * 60 * 1000;

function readGridCache(key, { ignoreTtl = false } = {}) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!ignoreTtl && (!obj.savedAt || Date.now() - obj.savedAt > FORECAST_CACHE_TTL_MS)) return null;
    const map = new Map();
    for (const [k, v] of Object.entries(obj.points)) map.set(k, v);
    return { step: obj.step, gridForecast: map, savedAt: obj.savedAt };
  } catch { return null; }
}

function writeGridCache(key, step, gridForecast) {
  try {
    const points = {};
    for (const [k, v] of gridForecast) points[k] = v;
    localStorage.setItem(key, JSON.stringify({
      date: jstToday(), step, points, savedAt: Date.now(),
    }));
  } catch {}
}

async function refreshFacilityForecast({ force = false } = {}) {
  if (!facilitiesCache.length) return;
  const statusEl = document.querySelector("#facility-status");

  if (!force) {
    const cached = readGridCache(FACILITY_CACHE_KEY);
    if (cached) {
      assignFacilityGrid(facilitiesCache, cached.step);
      facilityGridStep = cached.step;
      facilityGridForecastCache = cached.gridForecast;
      applyFacilityForecast(facilitiesCache, cached.gridForecast, currentHorizon);
      updateFacilityMarkers(facilitiesCache);
      if (statusEl) {
        const ageMin = Math.round((Date.now() - cached.savedAt) / 60000);
        statusEl.textContent = `施設予測 キャッシュ(${ageMin}分前 / ${cached.step}°)`;
      }
      return;
    }
  }

  if (statusEl) statusEl.textContent = "施設予測取得中…";
  try {
    const expiredCache = readGridCache(FACILITY_CACHE_KEY, { ignoreTtl: true });
    let step = FORECAST_GRID_STEP;
    assignFacilityGrid(facilitiesCache, step);
    let gridPoints = buildForecastGridPoints(facilitiesCache);
    if (gridPoints.length > FORECAST_GRID_MAX_POINTS) {
      step = FORECAST_GRID_STEP_FALLBACK;
      assignFacilityGrid(facilitiesCache, step);
      gridPoints = buildForecastGridPoints(facilitiesCache);
    }
    facilityGridStep = step;
    console.log(`[facility forecast] source=${FORECAST_SOURCE} step=${step}° unique grid points=${gridPoints.length}`);
    const onProgress = (done, total) => {
      if (statusEl) statusEl.textContent = `施設予測取得中… ${done}/${total}`;
    };
    const cachedHourlyArr = expiredCache?.step === step
      ? gridPoints.map((pt) => expiredCache.gridForecast.get(gridKey(pt.lat, pt.lon)))
      : [];
    const gridForecast = await fetchForecastForGrid(gridPoints, onProgress, cachedHourlyArr);
    facilityGridForecastCache = gridForecast;
    applyFacilityForecast(facilitiesCache, gridForecast, currentHorizon);
    updateFacilityMarkers(facilitiesCache);
    writeGridCache(FACILITY_CACHE_KEY, step, gridForecast);
    if (statusEl) {
      const t = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
      statusEl.textContent = `施設予測 ${t} 更新 (${gridForecast.size}/${gridPoints.length}格子 / ${step}°)`;
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = `施設予測失敗: ${e.message}`;
  }
}

async function refreshPrefectureForecast({ force = false } = {}) {
  if (!prefRowsCache) return;
  const statusEl = document.querySelector("#forecast-status");

  if (!force) {
    const cached = readGridCache(PREF_CACHE_KEY);
    if (cached) {
      prefHourlyCache = cached.gridForecast;
      renderPrefectureViews();
      if (statusEl) {
        const ageMin = Math.round((Date.now() - cached.savedAt) / 60000);
        statusEl.textContent = `予測 キャッシュ(${ageMin}分前)`;
      }
      return;
    }
  }

  if (statusEl) statusEl.textContent = "予測取得中…";
  try {
    const coords = prefRowsCache.map((p) => ({ lat: p.latitude, lon: p.longitude }));
    const expiredCache = readGridCache(PREF_CACHE_KEY, { ignoreTtl: true });
    let hourlyArr;
    if (FORECAST_SOURCE === "hybrid") {
      const onProgress = (done, total) => {
        if (statusEl) statusEl.textContent = `予測取得中… ${done}/${total}`;
      };
      const cachedHourlyArr = prefRowsCache.map((p) => expiredCache?.gridForecast.get(p.prefecture));
      hourlyArr = await fetchHybridForCoords(coords, onProgress, cachedHourlyArr);
    } else {
      hourlyArr = await fetchHourlyForCoords(coords);
    }
    const gridForecast = new Map();
    prefRowsCache.forEach((p, idx) => {
      if (hourlyArr[idx]) gridForecast.set(p.prefecture, hourlyArr[idx]);
    });
    prefHourlyCache = gridForecast;
    writeGridCache(PREF_CACHE_KEY, 0, gridForecast);
    renderPrefectureViews();
    if (statusEl) {
      const t = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
      statusEl.textContent = `予測 ${t} 更新 (${gridForecast.size}/${coords.length})`;
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = `予測取得失敗: ${e.message}`;
  }
}

function renderPrefectureViews() {
  if (!prefRowsCache) return;
  const rows = buildPrefForecastRows(prefRowsCache, currentHorizon);
  updatePrefectureLayer(rows);
  updateForecastMarkers(rows);
  renderSummary(rows);
  renderTable(rows);
  document.querySelector("#data-status").textContent =
    `${rows.length} prefs / ${prefRowsCache.facilitiesCount} sites`;
}

function reapplyAllForHorizon() {
  if (prefRowsCache && prefHourlyCache.size) renderPrefectureViews();
  if (facilitiesCache.length && facilityGridForecastCache.size) {
    applyFacilityForecast(facilitiesCache, facilityGridForecastCache, currentHorizon);
    updateFacilityMarkers(facilitiesCache);
  }
}

function bindHorizonControl() {
  document.querySelectorAll('input[name="horizon"]').forEach((input) => {
    input.addEventListener("change", (e) => {
      const value = e.target.value;
      if (!HORIZONS.includes(value)) return;
      currentHorizon = value;
      reapplyAllForHorizon();
    });
  });
}

async function main() {
  try {
    const [points, capacity, japanTopo, facilityRows, baseline] = await Promise.all([
      loadCsv(DATASETS.points),
      loadCsv(DATASETS.capacity),
      loadJson(DATASETS.japan).catch(() => null),
      loadCsv(DATASETS.facilities).catch(() => []),
      loadJson(DATASETS.baseline).catch(() => null),
    ]);
    baselineByPref = baseline;

    const prefList = buildPrefRows(points, capacity);
    const facilities = buildFacilities(facilityRows);
    facilitiesCache = facilities;

    prefRowsCache = Object.assign(prefList, {
      capacityRows: capacity,
      pointRows: points,
      facilitiesCount: facilities.length,
    });

    initMap(japanTopo, facilities);
    bindHorizonControl();

    document.querySelector("#prefs-all-on").addEventListener("click", () => {
      setAllPrefsVisible(true);
      const m = document.querySelector("#prefs-master");
      if (m) m.checked = true;
    });
    document.querySelector("#prefs-all-off").addEventListener("click", () => {
      setAllPrefsVisible(false);
      const m = document.querySelector("#prefs-master");
      if (m) m.checked = false;
    });
    document.querySelector("#prefs-master").addEventListener("change", (e) => {
      setAllPrefsVisible(e.target.checked);
    });
  } catch (error) {
    renderError(error);
    return;
  }

  (async () => {
    await refreshFacilityForecast();
    await refreshPrefectureForecast();
  })();
  setInterval(() => refreshFacilityForecast({ force: true }), FORECAST_REFRESH_MS);
  setInterval(() => refreshPrefectureForecast({ force: true }), FORECAST_REFRESH_MS + 30 * 1000);
}

main();
