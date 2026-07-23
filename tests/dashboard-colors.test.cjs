const test = require("node:test");
const assert = require("node:assert/strict");

const colors = require("../dashboard/colors.js");

function rgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function liesOnRgbSegment(candidateHex, startHex, endHex) {
  const candidate = rgb(candidateHex);
  const start = rgb(startHex);
  const end = rgb(endHex);
  const varyingChannel = start.findIndex((value, index) => value !== end[index]);
  if (varyingChannel === -1) return candidate.every((value, index) => value === start[index]);
  const t = (candidate[varyingChannel] - start[varyingChannel])
    / (end[varyingChannel] - start[varyingChannel]);
  if (t < 0 || t > 1) return false;
  return candidate.every((value, index) => (
    Math.abs(value - (start[index] + (end[index] - start[index]) * t)) < 1e-9
  ));
}

test("generation scale distinguishes low, middle, and high values", () => {
  assert.equal(colors.generationColor(0, 100), colors.PALETTE.generationLow);
  assert.equal(colors.generationColor(50, 100), colors.PALETTE.generationMid);
  assert.equal(colors.generationColor(100, 100), colors.PALETTE.generationHigh);
  assert.equal(colors.generationColor(Number.NaN, 100), colors.PALETTE.missing);
});

test("night palette is used only for the current horizon below the horizon", () => {
  const night = { horizon: "now", lat: 35, lon: 139, solarAltitude: () => -0.1 };
  const day = { horizon: "now", lat: 35, lon: 139, solarAltitude: () => 0.1 };
  const daily = { horizon: "today", lat: 35, lon: 139, solarAltitude: () => -0.1 };

  assert.equal(colors.weatherColor(0, night), colors.PALETTE.weatherNightClear);
  assert.equal(colors.weatherColor(0, day), colors.PALETTE.weatherDayClear);
  assert.equal(colors.weatherColor(0, daily), colors.PALETTE.weatherDayClear);
});

test("forced preview time of day overrides the actual solar state", () => {
  assert.equal(
    colors.weatherColor(0, { forceTimeOfDay: "night", solarAltitude: () => 0.5 }),
    colors.PALETTE.weatherNightClear,
  );
  assert.equal(
    colors.weatherColor(0, { forceTimeOfDay: "day", solarAltitude: () => -0.5 }),
    colors.PALETTE.weatherDayClear,
  );
});

test("longitude preview gradient runs from clear west to overcast east", () => {
  assert.equal(colors.longitudeCloudGradient(130.40), 0);
  assert.equal(colors.longitudeCloudGradient(135.875), 50);
  assert.equal(colors.longitudeCloudGradient(141.35), 100);
  assert.equal(colors.longitudeCloudGradient(145), 100);
});

test("weather missing values use the shared missing-data color", () => {
  assert.equal(colors.weatherColor(undefined), colors.PALETTE.missing);
  assert.equal(colors.generationRateColor(undefined), colors.PALETTE.missing);
});

test("map outline colors are outside every continuous legend scale", () => {
  const scales = [
    [colors.PALETTE.generationLow, colors.PALETTE.generationMid, colors.PALETTE.generationHigh],
    [colors.PALETTE.weatherDayClear, colors.PALETTE.weatherDayPartlyCloudy, colors.PALETTE.weatherDayOvercast],
    [colors.PALETTE.weatherNightClear, colors.PALETTE.weatherNightPartlyCloudy, colors.PALETTE.weatherNightOvercast],
  ];
  const outlineColors = [
    colors.PALETTE.mapOutlineDay,
    colors.PALETTE.mapOutlineNight,
  ];

  for (const outlineColor of outlineColors) {
    for (const [start, middle, end] of scales) {
      assert.equal(liesOnRgbSegment(outlineColor, start, middle), false);
      assert.equal(liesOnRgbSegment(outlineColor, middle, end), false);
    }
    assert.notEqual(outlineColor, colors.PALETTE.missing);
  }
});
