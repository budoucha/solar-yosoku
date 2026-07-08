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
GSI_GEOCODE_URL = "https://msearch.gsi.go.jp/address-search/AddressSearch"

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


def is_facility_sheet(sheet_name: str) -> bool:
    """FIT公表Excelは「認定設備」=1行1施設、「すべての設備の所在地」=1行1区画。
    後者は同一施設IDが多区画ぶん複製され出力kWも全行に重複するので集計に使うと多重計上になる。
    施設一覧として正しいのは前者だけ。"""
    name = norm_text(sheet_name)
    if "所在地" in name:
        return False
    return "認定" in name or "設備" in name


def read_fit_file(path: Path, prefecture: str, min_kw: float, exclude_inactive: bool = True) -> pd.DataFrame:
    """都道府県Excelから太陽光設備の候補行を抽出する。列名変更に耐えるためヒューリスティックで読む。"""
    xls = pd.ExcelFile(path)
    frames = []

    for sheet in xls.sheet_names:
        if not is_facility_sheet(sheet):
            continue
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
            "source_type": "fit",
            "source": "FIT/FIP publicinfo",
            "facility_name": "",
            "operator": "",
            "owner": "",
            "source_url": "",
        })
        if id_col is not None:
            out["facility_id"] = df[id_col].map(norm_text)
        if address_col is not None:
            out["address"] = df[address_col].map(norm_text)
        frames.append(out)

    if not frames:
        return pd.DataFrame(columns=["prefecture", "capacity_kw", "sheet", "source_file"])
    return pd.concat(frames, ignore_index=True)


EXTRA_FACILITY_COLUMN_ALIASES = {
    "prefecture": ["prefecture", "都道府県", "県"],
    "capacity_kw": ["capacity_kw", "capacity_kW", "容量kw", "容量(kW)", "設備容量kw", "設備容量(kW)", "出力kw", "出力(kW)"],
    "facility_id": ["facility_id", "id", "施設id", "施設ID", "設備id", "設備ID"],
    "facility_name": ["facility_name", "name", "施設名", "発電所名", "名称"],
    "operator": ["operator", "事業者", "発電事業者", "運営者"],
    "owner": ["owner", "所有者", "保有者"],
    "address": ["address", "住所", "所在地", "設置場所"],
    "latitude": ["latitude", "lat", "緯度"],
    "longitude": ["longitude", "lon", "lng", "経度"],
    "matched_address": ["matched_address", "照合住所"],
    "source": ["source", "出典", "情報源"],
    "source_url": ["source_url", "url", "URL", "出典URL"],
}


def _normalized_column_lookup(columns) -> dict[str, str]:
    return {norm_text(c).lower(): c for c in columns}


def _pick_extra_col(columns, canonical: str) -> str | None:
    lookup = _normalized_column_lookup(columns)
    for alias in EXTRA_FACILITY_COLUMN_ALIASES[canonical]:
        col = lookup.get(norm_text(alias).lower())
        if col is not None:
            return col
    return None


def read_extra_facilities(path: Path, min_kw: float) -> pd.DataFrame:
    """FIT/FIP以外の手入力・外部ソース施設CSVを標準スキーマに揃える。"""
    df = pd.read_csv(path, dtype=object)
    pref_col = _pick_extra_col(df.columns, "prefecture")
    cap_col = _pick_extra_col(df.columns, "capacity_kw")
    if pref_col is None or cap_col is None:
        raise RuntimeError(f"{path} は prefecture と capacity_kw 相当の列が必要")

    out = pd.DataFrame({
        "prefecture": df[pref_col].map(norm_text),
        "capacity_kw": df[cap_col].map(to_number),
        "sheet": "external",
        "source_file": path.name,
        "source_type": "external",
    })

    for col in [
        "facility_id", "facility_name", "operator", "owner", "address",
        "matched_address", "source", "source_url",
    ]:
        src_col = _pick_extra_col(df.columns, col)
        out[col] = df[src_col].map(norm_text) if src_col is not None else ""

    for col in ["latitude", "longitude"]:
        src_col = _pick_extra_col(df.columns, col)
        if src_col is not None:
            out[col] = df[src_col].map(to_number)

    out["source"] = out["source"].where(out["source"].astype(str).str.len() > 0, path.stem)
    out = out[out["prefecture"].astype(str).str.len() > 0]
    out = out[out["capacity_kw"].notna()]
    out = out[out["capacity_kw"] >= min_kw]
    return out


def dedupe_facility_details(details: pd.DataFrame) -> pd.DataFrame:
    """空IDの外部施設を落とさず、IDがある行だけ重複排除する。"""
    if "facility_id" not in details.columns:
        return details
    details = details.copy()
    details["facility_id"] = details["facility_id"].map(norm_text)
    has_id = details["facility_id"].astype(str).str.len() > 0
    without_id = details[~has_id]
    with_id = details[has_id].drop_duplicates(subset=["facility_id"], keep="first")
    return pd.concat([with_id, without_id], ignore_index=True)


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

    for extra_path in args.extra_facilities or []:
        path = Path(extra_path)
        print(f"parse external facilities: {path}")
        extra = read_extra_facilities(path, min_kw=args.min_kw)
        if extra.empty:
            print(f"  no rows: {path}")
        detail_frames.append(extra)

    details = pd.concat(detail_frames, ignore_index=True) if detail_frames else pd.DataFrame()
    if details.empty:
        raise RuntimeError("対象設備を抽出できなかった。Excel列名または閾値を確認して。")

    if "facility_id" in details.columns:
        before = len(details)
        details = dedupe_facility_details(details)
        if before != len(details):
            print(f"dedupe by facility_id: {before} -> {len(details)}")

    summary = (
        details.groupby("prefecture", as_index=False)
        .agg(capacity_kw=("capacity_kw", "sum"), plant_count=("capacity_kw", "count"))
        .sort_values("capacity_kw", ascending=False)
    )
    summary["min_kw"] = args.min_kw
    source_by_pref = (
        details.groupby("prefecture")["source"]
        .apply(lambda values: " + ".join(sorted({norm_text(v) for v in values if norm_text(v)})))
        .reset_index(name="source")
    )
    summary = summary.drop(columns=["source"], errors="ignore").merge(source_by_pref, on="prefecture", how="left")

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
            "precipitation",
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
        precip = get_hourly_series(hourly, "precipitation")

        for t, gti_wm2, ghi_wm2, temp_c, cloud_pct, precip_mm in zip(times, gti, ghi, temp, cloud, precip):
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
                "precipitation_mm": 0.0 if precip_mm is None else float(precip_mm),
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
            precipitation_mm_sum=("precipitation_mm", "sum"),
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


_ADDR_NORMALIZE_PATTERNS = [
    (re.compile(r"地内$"), ""),
    (re.compile(r"地先$"), ""),
    (re.compile(r"先$"), ""),
    (re.compile(r"外$"), ""),
    (re.compile(r"他$"), ""),
    (re.compile(r"番地?$"), ""),
    (re.compile(r"大字"), ""),
    (re.compile(r"字"), ""),
    (re.compile(r"[‐−–—―ー－]"), "-"),
    (re.compile(r"\s+"), ""),
]


def normalize_jp_address(addr: str) -> list[str]:
    """ジオコーディング用に住所候補を生成する。フル住所→末尾を段階的に削り倒した候補を返す。"""
    base = norm_text(addr)
    if not base:
        return []
    for pat, repl in _ADDR_NORMALIZE_PATTERNS:
        base = pat.sub(repl, base)

    candidates = [base]
    # 「市名町名字以下」を削った候補を順に追加（番地が見つからないことが多いので有効）
    truncated = re.sub(r"[-\d０-９一二三四五六七八九十].*$", "", base)
    if truncated and truncated != base:
        candidates.append(truncated)
    # さらに先頭の都道府県+市区町村だけ
    municipality = re.match(r"(.+?[都道府県].+?[市区町村郡])", base)
    if municipality:
        muni = municipality.group(1)
        if muni not in candidates:
            candidates.append(muni)
    return candidates


def geocode_one(address: str, session: requests.Session, retries: int = 2) -> tuple[float, float, str] | None:
    """GSIジオコーダで住所→(lat, lon, matched_address)。失敗時はNone。"""
    for query in normalize_jp_address(address):
        for attempt in range(retries + 1):
            try:
                r = session.get(
                    GSI_GEOCODE_URL,
                    params={"q": query},
                    timeout=15,
                    headers={"User-Agent": "solar-yosoku/0.1"},
                )
                if r.status_code == 200 and r.text.strip():
                    data = r.json()
                    if data:
                        coords = data[0]["geometry"]["coordinates"]
                        title = data[0].get("properties", {}).get("title", query)
                        return float(coords[1]), float(coords[0]), title
                break
            except (requests.RequestException, ValueError):
                if attempt == retries:
                    break
                time.sleep(0.5 * (attempt + 1))
    return None


def geocode(args):
    src = pd.read_csv(args.detail)
    if "address" not in src.columns:
        src["address"] = ""

    src["capacity_kw"] = src["capacity_kw"].map(to_number)
    src = src[src["capacity_kw"] >= args.min_kw].copy()
    for col in ["latitude", "longitude", "matched_address"]:
        if col not in src.columns:
            src[col] = "" if col == "matched_address" else float("nan")
    print(f"geocode targets: {len(src)} (min_kw={args.min_kw})")

    cache: dict[str, tuple[float, float, str]] = {}
    if args.cache and Path(args.cache).exists():
        cdf = pd.read_csv(args.cache)
        for _, row in cdf.iterrows():
            lat = to_number(row["latitude"])
            lon = to_number(row["longitude"])
            if pd.notna(lat) and pd.notna(lon):
                cache[norm_text(row["address"])] = (float(lat), float(lon), str(row.get("matched_address", "")))
        print(f"loaded cache: {len(cache)} entries")

    session = requests.Session()
    lats, lons, matched = [], [], []
    miss = 0
    new_cache_rows = []

    for i, row in enumerate(src.to_dict("records"), 1):
        addr = norm_text(row.get("address", ""))
        current_lat = to_number(row.get("latitude"))
        current_lon = to_number(row.get("longitude"))
        if pd.notna(current_lat) and pd.notna(current_lon):
            lat, lon = float(current_lat), float(current_lon)
            m = norm_text(row.get("matched_address", "")) or addr
        elif addr in cache:
            lat, lon, m = cache[addr]
        elif not addr:
            lat = lon = float("nan")
            m = ""
            miss += 1
        else:
            result = geocode_one(addr, session)
            if result is None:
                lat = lon = float("nan")
                m = ""
                miss += 1
            else:
                lat, lon, m = result
                cache[addr] = result
                new_cache_rows.append({"address": addr, "latitude": lat, "longitude": lon, "matched_address": m})
            time.sleep(args.sleep)
        lats.append(lat)
        lons.append(lon)
        matched.append(m)
        if i % 50 == 0:
            print(f"  {i}/{len(src)}  miss={miss}")

    src["latitude"] = lats
    src["longitude"] = lons
    src["matched_address"] = matched

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    src.to_csv(args.out, index=False, encoding="utf-8-sig")
    print(f"wrote: {args.out}  matched={len(src)-miss}/{len(src)}")

    if args.cache and new_cache_rows:
        existing = pd.read_csv(args.cache) if Path(args.cache).exists() else pd.DataFrame()
        merged = pd.concat([existing, pd.DataFrame(new_cache_rows)], ignore_index=True).drop_duplicates("address", keep="last")
        Path(args.cache).parent.mkdir(parents=True, exist_ok=True)
        merged.to_csv(args.cache, index=False, encoding="utf-8-sig")
        print(f"updated cache: {args.cache} ({len(merged)} entries)")


def main():
    parser = argparse.ArgumentParser(description="FIT solar capacity + JMA irradiance forecast prototype")
    sub = parser.add_subparsers(required=True)

    p = sub.add_parser("build-capacity", help="FIT/FIP公表Excelから都道府県別の太陽光設備容量を集計")
    p.add_argument("--prefs", nargs="*", default=None, help="対象都道府県。省略時は47都道府県")
    p.add_argument("--min-kw", type=float, default=1000.0, help="対象にする最小設備容量[kW]")
    p.add_argument("--data-dir", default="data")
    p.add_argument("--from-dir", default=None, help="既にダウンロード済みのFIT Excelディレクトリ")
    p.add_argument("--extra-facilities", nargs="*", default=None, help="FIT/FIP以外の施設CSV。prefecture, capacity_kw は必須")
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

    p = sub.add_parser("geocode", help="施設詳細CSVの住所をGSI APIで緯度経度に変換")
    p.add_argument("--detail", default="data/output/solar_facilities_detail.csv")
    p.add_argument("--out", default="data/output/solar_facilities_geocoded.csv")
    p.add_argument("--min-kw", type=float, default=5000.0, help="対象にする最小設備容量[kW]")
    p.add_argument("--sleep", type=float, default=0.3, help="リクエスト間隔[秒]")
    p.add_argument("--cache", default="data/output/geocode_cache.csv")
    p.set_defaults(func=geocode)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
