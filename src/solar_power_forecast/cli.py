#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
solar_proto.py

FIT/FIP公表対象の太陽光設備容量を都道府県別に集計し、
JMA系の日射量予報から簡易的な太陽光発電量を推定する試作用スクリプト。

主な仮定:
- FIT/FIP公表対象だけを対象にする。
- 初期版は都道府県代表点、つまり県庁所在地付近の1点で日射量を代表させる。
- 推定発電量[kWh] = 設備容量[kW] * performance_ratio * GTI[kWh/m2]
- GTIはOpen-Meteo JMA APIの global_tilted_irradiance を使う。
"""

from __future__ import annotations

import argparse
import io
import re
import time
import unicodedata
from pathlib import Path
from urllib.parse import urljoin

import pandas as pd
import requests
from bs4 import BeautifulSoup


FIT_PUBLICINFO_URL = "https://www.fit-portal.go.jp/publicinfo"
OPEN_METEO_JMA_URL = "https://api.open-meteo.com/v1/jma"

PREFECTURES = [
    "北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県",
    "茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県",
    "新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県","三重県",
    "滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県",
    "鳥取県","島根県","岡山県","広島県","山口県",
    "徳島県","香川県","愛媛県","高知県",
    "福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県",
]


def norm_text(x) -> str:
    if pd.isna(x):
        return ""
    return unicodedata.normalize("NFKC", str(x)).replace("\n", "").replace("\r", "").strip()


def to_number(x) -> float:
    s = norm_text(x)
    s = s.replace(",", "")
    s = re.sub(r"[^\d.\-]", "", s)
    if s in ("", ".", "-", "-."):
        return float("nan")
    try:
        return float(s)
    except ValueError:
        return float("nan")


def scrape_fit_links() -> dict[str, str]:
    """FIT公表ページから都道府県別Excelファイルのリンクを拾う。"""
    r = requests.get(FIT_PUBLICINFO_URL, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    links: dict[str, str] = {}
    for a in soup.find_all("a"):
        label = norm_text(a.get_text())
        href = a.get("href")
        if label in PREFECTURES and href:
            links[label] = urljoin(FIT_PUBLICINFO_URL, href)
    if not links:
        raise RuntimeError("FIT公表ページから都道府県別リンクを検出できなかった。ページ構造変更の可能性あり。")
    return links


def download_fit_excels(prefectures: list[str], out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    links = scrape_fit_links()
    paths: list[Path] = []

    for pref in prefectures:
        if pref not in links:
            raise KeyError(f"{pref} のダウンロードリンクが見つからない")
        url = links[pref]
        path = out_dir / f"{pref}.xlsx"
        print(f"download: {pref} -> {path.name}")
        r = requests.get(url, timeout=180, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        path.write_bytes(r.content)
        paths.append(path)
        time.sleep(0.5)
    return paths


def find_header_row(raw: pd.DataFrame) -> int | None:
    """Excelのヘッダ行をゆるく推定する。"""
    max_rows = min(len(raw), 40)
    for i in range(max_rows):
        row = " ".join(norm_text(v) for v in raw.iloc[i].tolist())
        has_id = ("設備ID" in row) or ("認定ID" in row) or ("申請ID" in row)
        has_output = ("出力" in row and "kW" in row) or ("出力" in row and "KW" in row)
        has_location = ("所在地" in row) or ("設置場所" in row)
        if has_output and (has_id or has_location or "太陽光" in row):
            return i
    return None


def pick_col(columns, patterns: list[str]) -> str | None:
    cols = [norm_text(c) for c in columns]
    best = None
    best_score = 0
    for original, c in zip(columns, cols):
        score = 0
        for pat in patterns:
            if pat in c:
                score += len(pat)
        if score > best_score:
            best = original
            best_score = score
    return best


def read_fit_file(path: Path, prefecture: str, min_kw: float, exclude_inactive: bool = True) -> pd.DataFrame:
    """都道府県Excelから太陽光設備の候補行を抽出する。列名変更に耐えるためヒューリスティックで読む。"""
    xls = pd.ExcelFile(path)
    frames = []

    for sheet in xls.sheet_names:
        raw = pd.read_excel(path, sheet_name=sheet, header=None, dtype=object)
        header = find_header_row(raw)
        if header is None:
            continue

        df = pd.read_excel(path, sheet_name=sheet, header=header, dtype=object)
        df.columns = [norm_text(c) for c in df.columns]
        df = df.dropna(how="all")
        if df.empty:
            continue

        output_col = pick_col(df.columns, [
            "発電設備の出力", "発電設備出力", "発電出力", "設備出力", "出力(kW)", "出力"
        ])
        if output_col is None:
            continue

        source_col = pick_col(df.columns, [
            "発電設備区分", "発電設備の区分", "再生可能エネルギー発電設備の区分", "電源", "発電種別", "種類"
        ])

        if source_col is not None:
            mask_solar = df[source_col].astype(str).map(norm_text).str.contains("太陽光|太陽電池|ソーラー", regex=True, na=False)
            df = df[mask_solar]
        elif "太陽" not in sheet:
            # 電源種別列もシート名の太陽光表記もない場合は、混入リスクがあるのでスキップ。
            continue

        status_col = pick_col(df.columns, ["認定状態", "状態", "廃止", "失効"])
        if exclude_inactive and status_col is not None:
            s = df[status_col].astype(str).map(norm_text)
            df = df[~s.str.contains("廃止|失効|取消|取り消し", regex=True, na=False)]

        df = df.copy()
        df["capacity_kw"] = df[output_col].map(to_number)
        df = df[df["capacity_kw"].notna()]
        df = df[df["capacity_kw"] >= min_kw]
        if df.empty:
            continue

        address_col = pick_col(df.columns, ["発電設備の所在地", "所在地", "設置場所", "住所"])
        id_col = pick_col(df.columns, ["設備ID", "認定ID", "申請ID"])

        out = pd.DataFrame({
            "prefecture": prefecture,
            "capacity_kw": df["capacity_kw"],
            "sheet": sheet,
            "source_file": path.name,
        })
        if id_col is not None:
            out["facility_id"] = df[id_col].map(norm_text)
        if address_col is not None:
            out["address"] = df[address_col].map(norm_text)
        frames.append(out)

    if not frames:
        return pd.DataFrame(columns=["prefecture", "capacity_kw", "sheet", "source_file"])
    return pd.concat(frames, ignore_index=True)


def build_capacity(args):
    data_dir = Path(args.data_dir)
    raw_dir = data_dir / "fit_raw"
    prefectures = args.prefs or PREFECTURES

    if args.from_dir:
        files = []
        for pref in prefectures:
            # ファイル名は「茨城県.xlsx」などを想定。なければ前方一致で探す。
            candidates = list(Path(args.from_dir).glob(f"{pref}*.*"))
            if not candidates:
                print(f"skip: {pref} のExcelが見つからない")
                continue
            files.append((pref, candidates[0]))
    else:
        paths = download_fit_excels(prefectures, raw_dir)
        files = list(zip(prefectures, paths))

    detail_frames = []
    for pref, path in files:
        print(f"parse: {pref} {path}")
        detail = read_fit_file(Path(path), pref, min_kw=args.min_kw, exclude_inactive=not args.include_inactive)
        if detail.empty:
            print(f"  no rows: {pref}")
        detail_frames.append(detail)

    details = pd.concat(detail_frames, ignore_index=True) if detail_frames else pd.DataFrame()
    if details.empty:
        raise RuntimeError("対象設備を抽出できなかった。Excel列名または閾値を確認して。")

    summary = (
        details.groupby("prefecture", as_index=False)
        .agg(capacity_kw=("capacity_kw", "sum"), plant_count=("capacity_kw", "count"))
        .sort_values("capacity_kw", ascending=False)
    )
    summary["min_kw"] = args.min_kw
    summary["source"] = "FIT/FIP publicinfo"

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    summary.to_csv(args.out, index=False, encoding="utf-8-sig")
    if args.detail_out:
        Path(args.detail_out).parent.mkdir(parents=True, exist_ok=True)
        details.to_csv(args.detail_out, index=False, encoding="utf-8-sig")

    print(f"wrote: {args.out}")
    if args.detail_out:
        print(f"wrote: {args.detail_out}")


def fetch_open_meteo_jma(lat: float, lon: float, forecast_days: int, tilt: float, azimuth: float, model: str | None) -> dict:
    params = {
        "latitude": lat,
        "longitude": lon,
        "timezone": "Asia/Tokyo",
        "forecast_days": forecast_days,
        "hourly": ",".join([
            "global_tilted_irradiance",
            "shortwave_radiation",
            "temperature_2m",
            "cloud_cover",
            "sunshine_duration",
        ]),
        "daily": ",".join([
            "shortwave_radiation_sum",
            "sunshine_duration",
        ]),
        "tilt": tilt,
        "azimuth": azimuth,
        "cell_selection": "land",
    }
    if model:
        params["models"] = model

    r = requests.get(OPEN_METEO_JMA_URL, params=params, timeout=60, headers={"User-Agent": "Mozilla/5.0"})
    if not r.ok:
        raise RuntimeError(f"Open-Meteo error {r.status_code}: {r.text[:500]}")
    return r.json()


def get_hourly_series(hourly: dict, base_name: str):
    """モデル指定時に変数名が suffix 付きで返る場合に備え、最初の候補を拾う。"""
    if base_name in hourly:
        return hourly[base_name]
    for k in hourly.keys():
        if k.startswith(base_name + "_"):
            return hourly[k]
    raise KeyError(f"hourly variable not found: {base_name}")


def forecast(args):
    cap = pd.read_csv(args.capacity)
    points = pd.read_csv(args.points)

    cap["prefecture"] = cap["prefecture"].astype(str)
    points["prefecture"] = points["prefecture"].astype(str)
    df = cap.merge(points, on="prefecture", how="left")
    missing = df[df["latitude"].isna()]["prefecture"].tolist()
    if missing:
        raise RuntimeError(f"代表点座標がない都道府県: {missing}")

    hourly_rows = []
    daily_rows = []

    for _, row in df.iterrows():
        pref = row["prefecture"]
        capacity_kw = float(row["capacity_kw"])
        lat = float(row["latitude"])
        lon = float(row["longitude"])

        print(f"forecast: {pref} capacity={capacity_kw:,.0f} kW")
        data = fetch_open_meteo_jma(
            lat=lat,
            lon=lon,
            forecast_days=args.days,
            tilt=args.tilt,
            azimuth=args.azimuth,
            model=args.model if args.model != "auto" else None,
        )

        hourly = data["hourly"]
        times = hourly["time"]
        gti = get_hourly_series(hourly, "global_tilted_irradiance")
        ghi = get_hourly_series(hourly, "shortwave_radiation")
        temp = get_hourly_series(hourly, "temperature_2m")
        cloud = get_hourly_series(hourly, "cloud_cover")

        for t, gti_wm2, ghi_wm2, temp_c, cloud_pct in zip(times, gti, ghi, temp, cloud):
            gti_wm2 = 0 if gti_wm2 is None else max(float(gti_wm2), 0.0)
            # W/m2平均 * 1h = Wh/m2。kWh/m2にするには1000で割る。
            gti_kwh_m2 = gti_wm2 / 1000.0
            estimated_kwh = capacity_kw * args.performance_ratio * gti_kwh_m2
            hourly_rows.append({
                "prefecture": pref,
                "time": t,
                "capacity_kw": capacity_kw,
                "gti_w_m2": gti_wm2,
                "gti_kwh_m2": gti_kwh_m2,
                "ghi_w_m2": ghi_wm2,
                "temperature_c": temp_c,
                "cloud_cover_pct": cloud_pct,
                "estimated_kwh": estimated_kwh,
                "estimated_mwh": estimated_kwh / 1000.0,
                "performance_ratio": args.performance_ratio,
                "tilt_deg": args.tilt,
                "azimuth_deg": args.azimuth,
                "model": args.model,
                "representative_city": row.get("city", ""),
                "latitude": lat,
                "longitude": lon,
            })
        time.sleep(args.sleep)

    hdf = pd.DataFrame(hourly_rows)
    hdf["date"] = hdf["time"].str.slice(0, 10)

    ddf = (
        hdf.groupby(["prefecture", "date"], as_index=False)
        .agg(
            capacity_kw=("capacity_kw", "first"),
            gti_kwh_m2_sum=("gti_kwh_m2", "sum"),
            estimated_mwh=("estimated_mwh", "sum"),
            mean_cloud_cover_pct=("cloud_cover_pct", "mean"),
            mean_temperature_c=("temperature_c", "mean"),
            representative_city=("representative_city", "first"),
            latitude=("latitude", "first"),
            longitude=("longitude", "first"),
        )
    )
    ddf["capacity_mw"] = ddf["capacity_kw"] / 1000.0
    ddf["capacity_factor"] = ddf["estimated_mwh"] / (ddf["capacity_mw"] * 24.0)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    ddf.to_csv(args.out, index=False, encoding="utf-8-sig")
    print(f"wrote: {args.out}")

    if args.hourly_out:
        Path(args.hourly_out).parent.mkdir(parents=True, exist_ok=True)
        hdf.to_csv(args.hourly_out, index=False, encoding="utf-8-sig")
        print(f"wrote: {args.hourly_out}")


def main():
    parser = argparse.ArgumentParser(description="FIT solar capacity + JMA irradiance forecast prototype")
    sub = parser.add_subparsers(required=True)

    p = sub.add_parser("build-capacity", help="FIT/FIP公表Excelから都道府県別の太陽光設備容量を集計")
    p.add_argument("--prefs", nargs="*", default=None, help="対象都道府県。省略時は47都道府県")
    p.add_argument("--min-kw", type=float, default=1000.0, help="対象にする最小設備容量[kW]")
    p.add_argument("--data-dir", default="data")
    p.add_argument("--from-dir", default=None, help="既にダウンロード済みのFIT Excelディレクトリ")
    p.add_argument("--include-inactive", action="store_true", help="廃止・失効らしき行を除外しない")
    p.add_argument("--out", default="data/capacity_by_prefecture.csv")
    p.add_argument("--detail-out", default="data/solar_facilities_detail.csv")
    p.set_defaults(func=build_capacity)

    p = sub.add_parser("forecast", help="都道府県別容量と日射量予報から発電量を推定")
    p.add_argument("--capacity", default="data/capacity_by_prefecture.csv")
    p.add_argument("--points", default="prefecture_points.csv")
    p.add_argument("--days", type=int, default=4, help="予報日数。JMA MSM重視なら4日程度")
    p.add_argument("--model", default="jma_seamless", help="auto, jma_seamless, jma_msm, jma_gsm など")
    p.add_argument("--tilt", type=float, default=30.0, help="パネル傾斜角。0=水平")
    p.add_argument("--azimuth", type=float, default=0.0, help="方位。0=南、-90=東、90=西")
    p.add_argument("--performance-ratio", type=float, default=0.80, help="損失込み係数。初期値0.80")
    p.add_argument("--sleep", type=float, default=0.2)
    p.add_argument("--out", default="data/forecast_by_prefecture_daily.csv")
    p.add_argument("--hourly-out", default="data/forecast_by_prefecture_hourly.csv")
    p.set_defaults(func=forecast)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
