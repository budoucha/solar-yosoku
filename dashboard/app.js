const DATASETS = {
  forecast: "../data/output/sample_forecast_daily.csv",
  capacity: "../data/sample/sample_capacity_by_prefecture.csv",
  points: "../data/prefecture_points.csv",
};

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

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildRows(forecastRows, capacityRows, pointRows) {
  const points = new Map(pointRows.map((row) => [row.prefecture, row]));
  const forecastByPref = new Map(forecastRows.map((row) => [row.prefecture, row]));

  return capacityRows
    .map((capacity) => {
      const pref = capacity.prefecture;
      const forecast = forecastByPref.get(pref) || {};
      const point = points.get(pref) || {};
      const capacityKw = toNumber(forecast.capacity_kw || capacity.capacity_kw);
      const estimatedMwh = toNumber(forecast.estimated_mwh);
      const capacityFactor = toNumber(forecast.capacity_factor);
      const latitude = toNumber(forecast.latitude || point.latitude, NaN);
      const longitude = toNumber(forecast.longitude || point.longitude, NaN);

      return {
        prefecture: pref,
        city: forecast.representative_city || point.city || "",
        date: forecast.date || "",
        capacityKw,
        capacityMw: capacityKw / 1000,
        estimatedMwh,
        capacityFactor,
        latitude,
        longitude,
      };
    })
    .filter((row) => Number.isFinite(row.latitude) && Number.isFinite(row.longitude));
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

function renderSummary(rows) {
  const totalCapacityMw = rows.reduce((sum, row) => sum + row.capacityMw, 0);
  const totalGeneration = rows.reduce((sum, row) => sum + row.estimatedMwh, 0);
  const maxCapacityFactor = Math.max(...rows.map((row) => row.capacityFactor), 0);
  const date = rows.find((row) => row.date)?.date || "容量データ";

  document.querySelector("#summary-date").textContent = date;
  document.querySelector("#metric-sites").textContent = `${rows.length}`;
  document.querySelector("#metric-capacity").textContent = `${numberFormat.format(totalCapacityMw)} MW`;
  document.querySelector("#metric-generation").textContent = `${numberFormat.format(totalGeneration)} MWh`;
  document.querySelector("#metric-capacity-factor").textContent = percentFormat.format(maxCapacityFactor);
}

function renderBars(rows) {
  const bars = document.querySelector("#bars");
  bars.replaceChildren();

  const sorted = [...rows].sort((a, b) => b.estimatedMwh - a.estimatedMwh);
  const max = Math.max(...sorted.map((row) => row.estimatedMwh), 1);

  for (const row of sorted) {
    const item = document.createElement("div");
    item.className = "bar-row";
    item.innerHTML = `
      <div class="bar-label">${row.prefecture}</div>
      <div class="bar-track"><div class="bar-fill" style="width: ${(row.estimatedMwh / max) * 100}%"></div></div>
      <div class="bar-value">${numberFormat.format(row.estimatedMwh)}</div>
    `;
    bars.append(item);
  }
}

function renderTable(rows) {
  const table = document.querySelector("#site-table");
  table.replaceChildren();

  const sorted = [...rows].sort((a, b) => b.capacityMw - a.capacityMw);
  for (const row of sorted) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><div class="site-name">${row.prefecture}<span>${row.city}</span></div></td>
      <td>${numberFormat.format(row.capacityMw)} MW</td>
      <td>${numberFormat.format(row.estimatedMwh)} MWh</td>
      <td>${row.capacityFactor ? percentFormat.format(row.capacityFactor) : "-"}</td>
    `;
    table.append(tr);
  }
}

function renderMap(rows) {
  const map = L.map("map", {
    zoomControl: false,
    minZoom: 4,
    maxZoom: 12,
  });

  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", {
    attribution:
      '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>',
    maxZoom: 18,
  }).addTo(map);

  const maxGeneration = Math.max(...rows.map((row) => row.estimatedMwh), 0);
  const maxCapacityMw = Math.max(...rows.map((row) => row.capacityMw), 0);
  const markers = [];

  for (const row of rows) {
    const marker = L.circleMarker([row.latitude, row.longitude], {
      radius: markerRadius(row.capacityMw, maxCapacityMw),
      color: "#ffffff",
      weight: 2,
      fillColor: markerColor(row.estimatedMwh, maxGeneration),
      fillOpacity: 0.82,
      opacity: 1,
    }).addTo(map);

    marker.bindPopup(`
      <div class="popup-title">${row.prefecture}<span>${row.city}</span></div>
      <dl class="popup-grid">
        <dt>設備容量</dt><dd>${oneDecimalFormat.format(row.capacityMw)} MW</dd>
        <dt>推定発電量</dt><dd>${numberFormat.format(row.estimatedMwh)} MWh</dd>
        <dt>設備利用率</dt><dd>${row.capacityFactor ? percentFormat.format(row.capacityFactor) : "-"}</dd>
        <dt>座標</dt><dd>${row.latitude.toFixed(3)}, ${row.longitude.toFixed(3)}</dd>
      </dl>
    `);

    markers.push(marker);
  }

  if (markers.length) {
    map.fitBounds(L.featureGroup(markers).getBounds().pad(0.2));
  } else {
    map.fitBounds(JAPAN_BOUNDS);
  }
}

function renderError(error) {
  document.querySelector("#data-status").textContent = "error";
  document.querySelector("#site-table").innerHTML = `
    <tr>
      <td colspan="4">
        <div class="error-state">${error.message}</div>
      </td>
    </tr>
  `;
}

async function main() {
  try {
    const [points, capacity] = await Promise.all([
      loadCsv(DATASETS.points),
      loadCsv(DATASETS.capacity),
    ]);

    let forecast = [];
    try {
      forecast = await loadCsv(DATASETS.forecast);
    } catch {
      forecast = [];
    }

    const rows = buildRows(forecast, capacity, points);
    renderMap(rows);
    renderSummary(rows);
    renderBars(rows);
    renderTable(rows);
    document.querySelector("#data-status").textContent = `${rows.length} sites`;
  } catch (error) {
    renderError(error);
  }
}

main();
