#!/usr/bin/env bash
set -euo pipefail

python -m solar_power_forecast build-capacity \
  --prefs 茨城県 千葉県 鹿児島県 北海道 \
  --min-kw 1000 \
  --out data/output/capacity_by_prefecture.csv \
  --detail-out data/output/solar_facilities_detail.csv
