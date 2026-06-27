"""NASA POWER の月別 GHI 気候値（平年値）を県別に取得して JSON 化する。

ALLSKY_SFC_SW_DWN: 全天日射量 [kWh/m^2/day]
出力: dashboard/data/baseline_monthly_ghi.json
  {
    "北海道": {
      "lat": 43.06, "lon": 141.34,
      "monthly_ghi_kwh_m2_day": [Jan, Feb, ..., Dec]
    }, ...
  }
"""
import csv
import json
import sys
import time
from pathlib import Path

import requests

POINTS_CSV = Path("data/prefecture_points.csv")
OUT_JSON = Path("dashboard/data/baseline_monthly_ghi.json")
URL = "https://power.larc.nasa.gov/api/temporal/climatology/point"

MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
          "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]


def fetch(lat: float, lon: float) -> list[float]:
    params = {
        "parameters": "ALLSKY_SFC_SW_DWN",
        "community": "RE",
        "longitude": f"{lon:.4f}",
        "latitude": f"{lat:.4f}",
        "format": "JSON",
    }
    r = requests.get(URL, params=params, timeout=60,
                     headers={"User-Agent": "solar-yosoku/0.1 (https://github.com/budoucha)"})
    r.raise_for_status()
    j = r.json()
    p = j["properties"]["parameter"]["ALLSKY_SFC_SW_DWN"]
    return [float(p[m]) for m in MONTHS]


def main() -> int:
    if not POINTS_CSV.exists():
        print(f"missing {POINTS_CSV}", file=sys.stderr)
        return 1
    with POINTS_CSV.open(encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    out: dict[str, dict] = {}
    for i, row in enumerate(rows, 1):
        pref = row["prefecture"]
        lat = float(row["latitude"])
        lon = float(row["longitude"])
        print(f"[{i}/{len(rows)}] {pref} ({lat:.3f},{lon:.3f})")
        try:
            monthly = fetch(lat, lon)
        except Exception as e:
            print(f"  fail: {e}", file=sys.stderr)
            return 2
        out[pref] = {
            "lat": lat,
            "lon": lon,
            "monthly_ghi_kwh_m2_day": [round(v, 4) for v in monthly],
        }
        time.sleep(1.2)
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {OUT_JSON}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
