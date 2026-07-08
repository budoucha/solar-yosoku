# solar-power-forecast

国内の FIT/FIP 公表対象太陽光設備と、任意追加した外部施設（例: 電力会社保有の非FIT施設）を地図上に並べ、**当日・翌日・現時点**の発電量を概算するダッシュボード。

ランタイムはフロントエンドで完結し、Python は **データ取得バッチ**（FIT スクレイプ、外部施設CSVの統合、ジオコーディング、平年値取得）専用。

## アーキテクチャ

3層ハイブリッド構成で施設地点の日射量を推定する:

```
   FIT/FIP 公表 Excel ─┐                          ┌─ yr.no 雲量 (CORS可・キー不要)
   外部施設 CSV       ─┤
                       │   [Python バッチ]        │
   国土地理院         ─┤   build-capacity         │   [フロントエンド (dashboard/)]
   ジオコーダー         │   geocode                ├─ NASA POWER 平年値 JSON
                       │   build_baseline_ghi.py  │   (同梱)
   NASA POWER ─────────┘                          ├─ 自前 ClearSky 計算 (solar.js)
                                                  │
                                                  └─ → 3層合成 → GTI → 発電量
```

詳細は [docs/apis.md](docs/apis.md) を参照。

## ディレクトリ構成

```text
.
├── dashboard/                            # フロントエンド（静的アセット）
│   ├── index.html
│   ├── app.js                            # メインロジック
│   ├── solar.js                          # 太陽位置・クリアスカイ計算
│   ├── styles.css
│   ├── japan.topojson                    # 県境ポリゴン
│   └── data/
│       └── baseline_monthly_ghi.json     # NASA POWER 県別×月別 GHI 平年値
├── data/
│   ├── prefecture_points.csv             # 県代表点座標
│   ├── fit_raw/                          # FIT 公表 Excel 生データ
│   └── output/
│       ├── capacity_by_prefecture.csv
│       ├── solar_facilities_detail.csv
│       ├── solar_facilities_geocoded.csv
│       └── geocode_cache.csv
├── scripts/
│   └── build_baseline_ghi.py             # NASA POWER 平年値取得
├── src/solar_power_forecast/             # Python CLI（FIT 収集 + ジオコード）
├── docs/
│   ├── apis.md                           # 利用 / 検討中の API まとめ
│   └── solar-glossary.md                 # 太陽光発電・日射量の用語と計算
└── README.md
```

## ダッシュボード起動

プロジェクトルートで簡易サーバを立て、`/dashboard/` を開く。

```bash
python -m http.server 8765 --bind 127.0.0.1
# → http://127.0.0.1:8765/dashboard/
```

または:

```bash
npx serve .
```

**`file://` で直接開くことは不可** — ローカル CSV/JSON への `fetch()` が CORS でブロックされる。サーバのルートは **プロジェクトルート**（`dashboard/` の 1 つ上）にする必要がある。

### 動作

- 初回ロードで yr.no から雲量を約 200 点取得し、約 30 秒で全国メトリクスが揃う
- 進行状況は右側パネルの `施設予測取得中… N/M` に表示
- 結果は localStorage に 1 時間キャッシュされ、再アクセス時は即時表示
- 時間軸は「現在 / 当日 / 翌日」をラジオで切替（雲量データの再フェッチは不要）

## データソース切替

[dashboard/app.js](dashboard/app.js) 冒頭の定数で切替可能:

```js
const FORECAST_SOURCE = "hybrid";       // 既定。yr.no + ClearSky + NASA POWER
// const FORECAST_SOURCE = "openmeteo"; // フォールバック。Open-Meteo JMA 直接
```

詳細・各 API の無料枠は [docs/apis.md](docs/apis.md) を参照。

## データ更新（Python バッチ）

### セットアップ

```bash
python -m venv .venv
.venv/Scripts/Activate.ps1            # PowerShell
# or: source .venv/bin/activate       # POSIX shell
pip install -r requirements.txt
```

### FIT 容量データ（不定期、年 1〜2 回想定）

FIT/FIP 公表ページから県別 Excel を取得して集計:

```bash
python -m solar_power_forecast build-capacity \
  --min-kw 1000 \
  --out data/output/capacity_by_prefecture.csv \
  --detail-out data/output/solar_facilities_detail.csv
```

`--prefs` で対象県を絞れる。例: `--prefs 茨城県 千葉県 鹿児島県`。

FIT/FIP 以外の施設を混ぜる場合は、`--extra-facilities` にCSVを渡す。電力会社保有の非FIT施設など、公開資料から確認できた設備を手入力で追加する用途を想定している:

```bash
python -m solar_power_forecast build-capacity \
  --min-kw 1000 \
  --extra-facilities data/input/extra_facilities.csv \
  --out data/output/capacity_by_prefecture.csv \
  --detail-out data/output/solar_facilities_detail.csv
```

外部施設CSVは `prefecture`, `capacity_kw` が必須。任意で `facility_name`, `owner`, `operator`, `address`, `latitude`, `longitude`, `source`, `source_url`, `facility_id` を持てる。座標が入っている行はジオコーディング時にそのまま使う。形式例は [data/sample/sample_extra_facilities.csv](data/sample/sample_extra_facilities.csv)。

### ジオコーディング（容量データ更新時）

施設住所 → 緯度経度（国土地理院 API、CORS 不可なのでサーバ側で実施）:

```bash
python -m solar_power_forecast geocode \
  --detail data/output/solar_facilities_detail.csv \
  --out data/output/solar_facilities_geocoded.csv \
  --min-kw 5000
```

`data/output/geocode_cache.csv` に住所→座標がキャッシュされる。

### NASA POWER 平年値（年 1 回程度で十分）

47 県分の月別 GHI 平年値を JSON 化:

```bash
python scripts/build_baseline_ghi.py
# → dashboard/data/baseline_monthly_ghi.json
```

## 計算モデル

```text
推定 GHI [W/m²]
  = ClearSkyGHI(lat, lon, t)           ← Haurwitz クリアスカイモデル
    × NASA月別平年GHI / ClearSky月平均GHI
    × (1 − 0.75 × (CC/100)^3.4)        ← Kasten-Czeplak 雲量補正
推定 GTI [W/m²] ≈ GHI × cos(|lat| − 30°)
温度補正係数 = 1 + γ × (T_cell − 25℃)   ← NOCT モデル (γ=-0.4%/℃, NOCT=45℃)
推定発電量 [kWh] = 容量[kW] × PR × GTI 積算[kWh/m²] × 温度補正係数
```

- `PR = 0.80`（暫定）、`TILT = 30°`、`AZIMUTH = 0°`（南向き）で全国一律
- 用語・式の詳細は [docs/solar-glossary.md](docs/solar-glossary.md)

## 現時点の制約 / 既知の課題

- **CF は概算**: NASA POWER 平年値で月別の地域差・季節差を補正し、yr.no の気温でモジュール温度損も補正しているが、実発電量で `performance_ratio` を地域別・季節別に校正する余地がある
- **パネル幾何は全国一律決め打ち**。施設別の真値は FIT データに含まれないため
- **初回ロード約 30 秒**: yr.no がバッチ非対応のため逐次取得。progressive 表示で UX を補完
- **yr.no は非商用前提** (NLOD)。商用デプロイ時は Open-Meteo Commercial 等への切替を想定
- **出力抑制・積雪・影・汚れ**は未モデル化

## 次の改善案

- OCCTO / 電力 10 社の実発電量で PR を地域別・季節別に逆算・校正
- 別クリアスカイ式（Ineichen, Bird）への差替で夏期過大評価の緩和
- 送配電エリア単位への再集計
- 市区町村単位または 5 km メッシュ単位へ細分化

## 関連ドキュメント

- [docs/apis.md](docs/apis.md) — 利用中・検討中の外部 API、無料枠、CORS、ライセンス
- [docs/solar-glossary.md](docs/solar-glossary.md) — GHI/GTI/PR/CF などの用語、計算式、間接推定手法

## ライセンス

[LICENSE](LICENSE) 参照。データソースのライセンスは [docs/apis.md](docs/apis.md) を参照。
