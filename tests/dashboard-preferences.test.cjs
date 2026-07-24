const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const app = fs.readFileSync(
  path.join(__dirname, "..", "dashboard", "app.js"),
  "utf8",
);

test("dashboard radio selections are restored from localStorage", () => {
  assert.match(app, /DASHBOARD_PREFERENCES_KEY\s*=\s*"solar_dashboard_preferences_v1"/);
  assert.match(app, /loadDashboardPreferences\(\)/);
  assert.match(app, /HORIZONS\.includes\(savedDashboardPreferences\.horizon\)/);
  assert.match(app, /LIST_MODES\.includes\(savedDashboardPreferences\.listMode\)/);
  assert.match(app, /WEATHER_FILL_MODES\.includes\(savedDashboardPreferences\.weatherFillMode\)/);
  assert.match(
    app,
    /FACILITY_CAPACITY_THRESHOLDS_MW\.includes\(\s*savedDashboardPreferences\.facilityCapacityThresholdMw\s*\)/,
  );
  assert.match(app, /syncOverviewControls\(\)/);
});

test("dashboard radio selections are saved after changes", () => {
  assert.match(app, /localStorage\.setItem\(DASHBOARD_PREFERENCES_KEY/);
  assert.match(app, /weatherFillMode:\s*currentWeatherFillMode/);
  assert.match(app, /facilityCapacityThresholdMw:\s*currentFacilityCapacityThresholdMw/);
  assert.match(app, /horizon:\s*currentHorizon/);
  assert.match(app, /listMode:\s*currentListMode/);

  const saveCalls = app.match(/saveDashboardPreferences\(\);/g) || [];
  assert.equal(saveCalls.length, 4);
});
