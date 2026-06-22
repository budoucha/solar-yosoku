# solar-power-forecast

日本国内のFIT/FIP公表対象の太陽光設備容量と、JMA系の日射量予報から、地域別の太陽光発電量を簡易推定する試作リポジトリ。

## 目的

天気予報データから地域ごとの日照量を推定し、ソーラーパネルの分布と照合して、短期の太陽光発電量を概算する。

初期版では以下の簡易モデルを使う。

```text
estimated_kWh = capacity_kW * performance_ratio * GTI_kWh_per_m2
```

- `capacity_kW`: FIT/FIP公表対象の太陽光設備容量
- `GTI_kWh_per_m2`: 傾斜面全天日射量
- `performance_ratio`: 損失込み係数。初期値は `0.80`

## ディレクトリ構成

```text
.
├── src/solar_power_forecast/
│   ├── __init__.py
│   ├── __main__.py
│   └── cli.py
├── data/
│   ├── prefecture_points.csv
│   └── sample/
│       └── sample_capacity_by_prefecture.csv
├── scripts/
├── pyproject.toml
├── requirements.txt
├── .gitignore
├── LICENSE
└── README.md
```

## セットアップ

通常のスクリプトとして使う場合。

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

パッケージとしてインストールする場合。

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

Windows PowerShellなら、仮想環境の有効化は次のようにする。

```powershell
.venv\Scripts\Activate.ps1
```

## サンプル実行

まずは架空サンプル容量でAPI連携だけ確認する。

```bash
python -m solar_power_forecast forecast \
  --capacity data/sample/sample_capacity_by_prefecture.csv \
  --points data/prefecture_points.csv \
  --days 4 \
  --model jma_seamless \
  --out data/output/sample_forecast_daily.csv \
  --hourly-out data/output/sample_forecast_hourly.csv
```

`pip install -e .` 済みなら、コマンド名でも実行できる。

```bash
solar-power-forecast forecast \
  --capacity data/sample/sample_capacity_by_prefecture.csv \
  --points data/prefecture_points.csv \
  --days 4 \
  --out data/output/sample_forecast_daily.csv
```

## ダッシュボード

予測結果CSVと地点CSVを地理院タイル上に表示する簡易ダッシュボード。

```bash
python -m http.server 8765 --bind 127.0.0.1
```

ブラウザで次を開く。

```text
http://127.0.0.1:8765/dashboard/
```

現時点では、設備ごとの緯度経度ではなく都道府県代表点を発電地点としてプロットする。

## FIT/FIP公表値から設備容量を作る

例：1MW以上の太陽光を数県だけ集計。

```bash
python -m solar_power_forecast build-capacity \
  --prefs 茨城県 千葉県 鹿児島県 北海道 \
  --min-kw 1000 \
  --out data/output/capacity_by_prefecture.csv \
  --detail-out data/output/solar_facilities_detail.csv
```

全国47都道府県を対象にする場合。

```bash
python -m solar_power_forecast build-capacity \
  --min-kw 1000 \
  --out data/output/capacity_by_prefecture.csv \
  --detail-out data/output/solar_facilities_detail.csv
```

続けて予測。

```bash
python -m solar_power_forecast forecast \
  --capacity data/output/capacity_by_prefecture.csv \
  --points data/prefecture_points.csv \
  --days 4 \
  --model jma_seamless \
  --out data/output/forecast_by_prefecture_daily.csv \
  --hourly-out data/output/forecast_by_prefecture_hourly.csv
```

## モデル指定

Open-Meteo JMA APIを使う。

- `jma_msm`: 短期・高解像度寄り
- `jma_gsm`: 予報期間長め
- `jma_seamless`: 使いやすい自動接続寄り
- `auto`: Open-Meteo側に任せる

例。

```bash
python -m solar_power_forecast forecast \
  --capacity data/output/capacity_by_prefecture.csv \
  --points data/prefecture_points.csv \
  --model jma_msm \
  --days 4
```

## 主な出力

### 日次CSV

- `prefecture`
- `date`
- `capacity_kw`
- `capacity_mw`
- `gti_kwh_m2_sum`
- `estimated_mwh`
- `capacity_factor`
- `mean_cloud_cover_pct`
- `mean_temperature_c`
- `representative_city`
- `latitude`
- `longitude`

### 時間別CSV

- `prefecture`
- `time`
- `capacity_kw`
- `gti_w_m2`
- `gti_kwh_m2`
- `estimated_kwh`
- `estimated_mwh`
- `temperature_c`
- `cloud_cover_pct`

## 現時点の制約

- 都道府県代表点で日射量を代表させている。
- FIT/FIPの「認定情報」を使うため、実稼働設備とはズレる可能性がある。
- 地番ジオコーディングは未実装。
- パネル方位・傾斜・追尾式・PCS容量・出力抑制・積雪・影・汚れ・温度損失は簡略化している。
- `performance_ratio=0.80` は暫定値。

## 次の改善案

- 市区町村単位または5kmメッシュ単位にする。
- FIT所在地をジオコーディングし、JMA MSM格子へ割り当てる。
- 送配電エリア単位に再集計する。
- 実績値で `performance_ratio` を地域別・季節別に補正する。
- 出力抑制や積雪補正を追加する。
