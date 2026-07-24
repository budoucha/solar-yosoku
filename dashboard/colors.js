(function (root) {
  const PALETTE = Object.freeze({
    generationLow: "#052e16",
    generationMid: "#22c55e",
    generationHigh: "#22d3ee",
    weatherDayClear: "#fb923c",
    weatherDayPartlyCloudy: "#fde68a",
    weatherDayOvercast: "#64748b",
    weatherNightClear: "#172554",
    weatherNightPartlyCloudy: "#334155",
    weatherNightOvercast: "#94a3b8",
    mapLandDay: "#d8e1e9",
    mapLandNight: "#59636f",
    mapOutlineDay: "#0f172a",
    mapOutlineNight: "#f8fafc",
    missing: "#d1d5db",
  });

  function lerpColor(a, b, t) {
    const clamped = Math.max(0, Math.min(t, 1));
    const ah = parseInt(a.slice(1), 16);
    const bh = parseInt(b.slice(1), 16);
    const ar = (ah >> 16) & 0xff;
    const ag = (ah >> 8) & 0xff;
    const ab = ah & 0xff;
    const br = (bh >> 16) & 0xff;
    const bg = (bh >> 8) & 0xff;
    const bb = bh & 0xff;
    const r = Math.round(ar + (br - ar) * clamped);
    const g = Math.round(ag + (bg - ag) * clamped);
    const bl = Math.round(ab + (bb - ab) * clamped);
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
  }

  function threeStopColor(start, middle, end, ratio) {
    const t = Math.max(0, Math.min(ratio, 1));
    if (t <= 0.5) return lerpColor(start, middle, t * 2);
    return lerpColor(middle, end, (t - 0.5) * 2);
  }

  function generationColor(value, max) {
    if (!Number.isFinite(value)) return PALETTE.missing;
    const ratio = Number.isFinite(max) && max > 0 ? value / max : 0;
    return threeStopColor(PALETTE.generationLow, PALETTE.generationMid, PALETTE.generationHigh, ratio);
  }

  function generationRateColor(rate, highRate = 0.30) {
    if (!Number.isFinite(rate)) return PALETTE.missing;
    return threeStopColor(
      PALETTE.generationLow,
      PALETTE.generationMid,
      PALETTE.generationHigh,
      rate / highRate,
    );
  }

  function isNightAt({ horizon, lat, lon, date = new Date(), solarAltitude } = {}) {
    if (horizon !== "now" || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    const altitude = solarAltitude || root.Solar?.solarAltitude;
    if (typeof altitude !== "function") return false;
    return altitude(lat, lon, date) <= 0;
  }

  function weatherColor(cloudPct, options = {}) {
    if (!Number.isFinite(cloudPct)) return PALETTE.missing;
    const t = Math.max(0, Math.min(cloudPct / 100, 1));
    if (isNightAt(options)) {
      return threeStopColor(
        PALETTE.weatherNightClear,
        PALETTE.weatherNightPartlyCloudy,
        PALETTE.weatherNightOvercast,
        t,
      );
    }
    return threeStopColor(
      PALETTE.weatherDayClear,
      PALETTE.weatherDayPartlyCloudy,
      PALETTE.weatherDayOvercast,
      t,
    );
  }

  function applyCssVariables(documentRef = root.document) {
    if (!documentRef?.documentElement) return;
    const style = documentRef.documentElement.style;
    for (const [name, value] of Object.entries(PALETTE)) {
      const cssName = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      style.setProperty(`--${cssName}`, value);
    }
  }

  const api = {
    PALETTE,
    applyCssVariables,
    generationColor,
    generationRateColor,
    isNightAt,
    lerpColor,
    weatherColor,
  };
  root.SolarColors = api;
  applyCssVariables();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
