#!/usr/bin/env bash
set -euo pipefail

python -m solar_power_forecast forecast \
  --capacity data/sample/sample_capacity_by_prefecture.csv \
  --points data/prefecture_points.csv \
  --days 4 \
  --model jma_seamless \
  --out data/output/sample_forecast_daily.csv \
  --hourly-out data/output/sample_forecast_hourly.csv
