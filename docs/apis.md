# 利用 / 検討中の外部 API まとめ

## 採用中（3層ハイブリッド構成）

実行時データソースは [app.js](../dashboard/app.js) の `FORECAST_SOURCE` で切替可能:
- `"hybrid"`（既定）: yr.no + 自前 ClearSky + NASA POWER 平年値
- `"openmeteo"`: 旧 Open-Meteo 直接（フォールバック）

### ① ベースライン: NASA POWER (バッチ取得・JSON 同梱)

`https://power.larc.nasa.gov/api/temporal/climatology/point`

- **取得**: [scripts/build_baseline_ghi.py](../scripts/build_baseline_ghi.py) で 47 県 × 月別 GHI 平年値 (ALLSKY_SFC_SW_DWN, kWh/m²/day)
- **配置**: [dashboard/data/baseline_monthly_ghi.json](../dashboard/data/baseline_monthly_ghi.json)
- **キー**: 不要、**CORS 可**、無料
- **更新頻度**: 平年値なのでほぼ静的（年1回見直しで十分）
- **用途**: 季節係数、サニティチェック

### ② クリアスカイ計算: 自前 JS ([dashboard/solar.js](../dashboard/solar.js))

- Spencer の赤緯式 + 均時差 + Haurwitz クリアスカイモデル
- 関数: `Solar.solarAltitude(lat, lon, dateUtc)`, `Solar.clearSkyGHI(...)`, `Solar.applyCloudCorrection(...)`, `Solar.ghiToGti(...)`
- **API コストゼロ**
- **既知の特性**: Haurwitz 式は夏至付近の中緯度で GHI を 10〜20% 過大評価する。**Performance Ratio を下げて校正する想定**（現状 0.80 のままなので CF が実機より高め）

### ③ 雲量取得: yr.no Locationforecast 2.0 compact (`https://api.met.no/weatherapi/locationforecast/2.0/compact`)

- **キー**: 不要、**CORS 可**、無料
- **ライセンス**: Norwegian License for Open Government Data (NLOD) — **非商用前提**
- **バッチ**: 不可。1座標 = 1リクエスト
- **必須ヘッダ**: User-Agent に連絡先（ブラウザでは自動付与に依存。フォールバック用に Sitename ヘッダ）
- **レート**: 公式キャップ非公開、ガイドは "be sensible / cache aggressively"
- **キャッシュ戦略**: 合成済み hourly と `Last-Modified` を同じ localStorage エントリに保持し、再取得時に 304 が返ってきたら旧 hourly の `savedAt` を更新して延命
- **取得値**: `properties.timeseries[].data.instant.details.cloud_area_fraction` [%], `air_temperature` [℃]（モジュール温度補正用、追加リクエスト不要で同時取得）

#### 本ダッシュボードでの運用

| 項目 | 値 |
|---|---|
| グリッド | 0.5°、施設覆う範囲で約 160 点 |
| 県別 | 47点 |
| 合計 | 約 200 リクエスト/フル取得 |
| リクエスト間隔 | 120 ms（礼儀正しいペース）|
| 完走時間 | 約 25〜35 秒 |
| TTL | 1 時間 (`HYBRID_CACHE_TTL_MS`) |
| 永続キャッシュ | localStorage `facility_forecast_hybrid_v1`, `pref_forecast_hybrid_v1` |

### 合成計算

```
ClearSky_GHI(lat, lon, t)       ← ②
  × NASA月別平年GHI / ClearSky月平均GHI ← ① (月別・最寄り県レコード)
  × (1 - 0.75 × (CC/100)^3.4)   ← ③ (Kasten-Czeplak 非線形)
  → 推定 GHI [W/m²]
  → GTI ≈ GHI × cos(|lat| - 30°)
  → 温度補正 = 1 + γ×(T_cell - 25℃)  ← ③ air_temperature + NOCT モデル (T_cell = T_air + (45-20)/800×GTI, γ=-0.4%/℃)
  → 発電量 = 容量 × PR × GTI 積算 × 温度補正
```

---

## フォールバック（保持）

### Open-Meteo JMA (`https://api.open-meteo.com/v1/jma`)

発電量予測と天気データ（雲量）の主データソース。フロントから直接叩く。

- **CORS**: 許可済み
- **キー**: 不要
- **ライセンス**: CC BY 4.0、Open-Access は **非商用利用のみ**
- **モデル**: `jma_seamless`（MSM+GSM）、tilt/azimuth 指定で `global_tilted_irradiance` 取得可
- **取得変数**（現状）: `global_tilted_irradiance`, `cloud_cover` の 2 つのみ

#### 無料枠（Open-Access）

| 単位 | 上限 |
|---|---|
| 1分 | 600 calls |
| 1時間 | 5,000 calls |
| 1日 | 10,000 calls |
| 1か月 | 300,000 calls |

**計測単位は IP アドレス**（GitHub Discussion #1835 で確認）。Open-Access は API キー不要・認証なしのため。

- **公開デプロイ時**: 閲覧者ごとに別 IP 枠なので、1 ユーザーが 10,000/day を使い切るのは現実的に不可能
- **開発時の弱点**: 自宅 IP が連続リロードで詰まると、自分だけ一時ブロックされる。VPN / モバイルテザリングで出口 IP 切替が回避策
- **同一 NAT 配下**: オフィス、家族の同回線、モバイル CGNAT は枠を共有する

#### "1 call" の換算

リクエスト本数ではなく **データ量で按分**される。料金ページの例:

> 2週間 × 15変数 = 1.5 calls

実用上の目安:

```
1 call ≈ 1座標 × 1変数 × 1週間ぶんの時間別データ
```

#### 本ダッシュボードでの試算

| 呼び出し | 座標 | 変数 | 期間 | 概算 |
|---|---|---|---|---|
| 施設グリッド (0.5°) | 161 | 2 | 2日 | ≈ 92 calls |
| 県別 | 47 | 2 | 2日 | ≈ 27 calls |
| **1回フル取得** | — | — | — | **≈ 120 calls** |

TTL 6h で 1 日 4 回 ≈ 480 calls。日次 10,000 枠の **約 5%** で収まる。

#### 429 が出やすい状況

- 開発中の連続リロードで **分間 600 calls** バーストに引っかかる
- 1リロード約 57 calls（100点グリッド × 2変数 × 2日）→ **11リロードで分間枠突破**
- 一度 429 を踏むと、無策にリトライすると枠をさらに消費し悪化

#### 対策（実装済み）

- localStorage に `open_meteo_cooldown_until` を保存し、429 検知から 30分は全リクエストを即 fail
- グリッドステップ 0.5° 固定（300点超で 1.0° フォールバック）
- 取得変数を必要最小（GTI + cloud のみ）に絞る
- バッチ 100点 / チャンク間 3秒 sleep
- キャッシュ TTL 6時間、日付一致判定を撤去（日跨ぎ無効化なし）

#### 商用プラン

| プラン | 月間 calls | 用途 |
|---|---|---|
| Standard | 1M | 通常の商用利用（公開時の現実的な選択肢） |
| Professional | 5M | 拡張 |
| Enterprise | 50M+ | カスタム |

公式公開価格は Standard が概ね **$29/月** 帯（要確認）。

---

## 検討中の代替（未採用）

### 同 API 互換で枠拡張

- **Open-Meteo Commercial** — そのまま移行可。最有力

### ソーラー特化

- **Solcast** — PV業界標準。無料は 10サイト×10calls/day → 161グリッドはカバー不可
- **Meteomatics** — GTI 直接、商用前提、14日トライアルあり

### 汎用気象（GTI は自前計算が必要）

- **OpenWeather One Call 3.0** — 1000calls/day、60/min、雲量のみ
- **WeatherAPI.com** — 1M calls/月、GTI なし
- **VisualCrossing** — 1000records/day、GTI は有料 tier
- **~~MetNorway (yr.no)~~** — **採用済み**（上記 ③ 参照）

### 履歴寄り

- **NASA POWER** — GHI あり、CORS 可、日次/時間、**予報用途には弱い**

### 衛星画像派生（雲量を画像から抽出 or 派生プロダクト）

- **ひまわり8/9 リアルタイムWeb** (NICT・京大) — 10分間隔の可視/赤外画像。配信元の CORS は要確認。Canvas で輝度ヒストグラム → 雲量推定が可能
- **JAXA P-Tree** (`https://www.eorc.jaxa.jp/ptree/`) — ひまわり L1/L2 プロダクト（雲量・放射）。要登録・無料、研究用途
- **Copernicus CAMS Radiation Service (SoDa)** (`http://www.soda-pro.com/web-services/radiation/cams-radiation-service`) — 衛星派生 GHI 全世界対応、無料登録あり、**CORS要確認**

### 統計・平年値（オフライン同梱可、ライセンス確認要）

- **NEDO 日射量データベース (METPV-20 / MONSOLA-20)** (`https://www.nedo.go.jp/library/nissharyou.html`) — 全国メッシュ・**月別平年 GHI**、過去30年。県別 12 値だけなら 564 値で数 KB に収まる。**季節ベースラインとして同梱する案の中核**
- **気象庁 気候平年値** — アメダス約1300点、日照時間あり。日照時間→日射換算で代理指標
- **気象庁 過去の気象データ・ダウンロード** (`https://www.data.jma.go.jp/risk/obsdl/`) — 全天日射量の日次 CSV、校正・検証用

### 観測・実績（裏取り/真値に近い）

- **アメダス** — 全国約1300点の日照時間ほぼリアルタイム。HTMLスクレイプ前提・**CORS不可**
- **OCCTO 需給実績 / 電力10社太陽光発電実績** — エリア毎の太陽光実発電量 (5〜30分遅延)。「実発電量 ÷ 想定容量 ≒ 実日射の代理指標」として **真値に最も近い**。CORS 不可、サーバー側ポーリング or 静的 JSON 化が必要

### 不採用（CORS 不可 など）

- **JMA bosai JSON** (`https://www.jma.go.jp/bosai/forecast/data/forecast/{area_code}.json` 等) — 気象庁ホームページの**非公式** JSON 配信。
  - 含まれるのは天気・気温・降水確率・風・波のみ。**雲量・日射量は含まれない**ため発電予測には使えない
  - CORS 不可、非公式 API のため仕様変更・廃止リスクあり
  - 公共データ利用規約：出典明記必須、加工時はその旨も記載。予報業務許可（気象業務法 第17条）と警報の制限（第23条）に留意
  - 「現在の天気アイコン」程度の補助表示用途なら、サーバープロキシ経由で利用可能

- **JMA 防災情報XML** (`https://xml.kishou.go.jp/`) — PULL 型 Atom フィード（PUSH 型は 2020/9 終了）。
  - 警報・注意報・地震・津波・火山などの**防災情報専用**で、数値予報（雲量・日射量・気温の格子データ）は配信されない
  - 本プロジェクトの用途と重ならない

- **気象業務支援センター GPV (MSM/GSM)** (`http://www.jmbsc.or.jp/`) — JMA 数値予報モデルの**公式一次配信**。
  - **MSM**: 5kmメッシュ、全雲量＋上中下層雲、**日射量あり**、1日6回・39時間予報。物理量としては本命
  - **GSM**: 20kmメッシュ、雲量あり、日射量は日本域版のみ、1日4回・最大264時間予報
  - 配信は**商用オンライン契約のみ**で年間数十万円〜（プロダクト・回線数で変動）、個人契約は実質不可
  - 形式は **GRIB2 バイナリ・専用回線/FTP**。フロント直叩き不可、サーバー側のパース・配信が必須
  - **Open-Meteo JMA がこの GPV をパースして無料/$29 で配信している実体**。直接契約するメリットは「Open-Meteo の停止リスクを避けたい」「データ即時性が分単位で必要」など限定的なケースのみ

- **JMA直接（公式 API）** — 公式 REST API は存在しない、CORS 不可。上記 bosai JSON / 防災XML / GPV のいずれも本プロジェクトの「フロント完結・予測用の日射量データ」には噛み合わない
- **Google Maps Platform Weather API** (`https://developers.google.com/maps/documentation/weather/`) — 雲量・UV・気温などの汎用気象。**日射量（GHI/GTI/solar radiation）を返さない** ため、Open-Meteo JMA の置き換えには使えず不採用。
  - `currentConditions.lookup` / `forecast.hours` のレスポンスに含まれるのは `cloudCover` と `uvIndex` まで。GHI を得るにはクリアスカイモデル + 雲量補正 + GHI→GTI 変換を自前実装する必要があり、Open-Meteo が `global_tilted_irradiance` を直接返してくれている利点を捨てることになる
  - 雲量単体ならすでに Open-Meteo で同時取得しているため、追加で叩く動機がない
  - 料金: 1万/月無料、超過 $0.15/1000（10k–100k）。161グリッド × 4回/日 ≈ 19k/月で 1 ユーザーあたり $1.4/月程度。公開時は閲覧者数で線形に増える
  - API キー必須（フロント直叩きはキー露出）、CORS 可否はドキュメント明記なし
  - Open-Meteo の 429 対策が動機なら、まず Open-Meteo Commercial（$29/月で 1M calls、無改修で移行可）を優先すべき

- **Google Maps Platform Solar API** (`https://developers.google.com/maps/documentation/solar/`) — 「建物の屋根太陽光ポテンシャル評価」用途のAPI。本プロジェクトには **目的不一致** のため不採用。
  - 出力は `buildingInsights`（建物単位の年間 kWh/kW）と `dataLayers`（年間/月間フラックス・時間別影マップの GeoTIFF）で、**静的・平年値ベース**。短期予報（現在/当日/翌日）は返さない
  - 内部の気象データは 4〜10km グリッドの過去気象を衛星派生 DSM と合成したもので、Open-Meteo JMA の予報を置き換える性質ではない
  - API キー必須 → フロント直叩きはキー露出、プロキシ必須で「フロント完結」方針に反する
  - 料金: Building Insights 1万/月無料・以降 $10/1000、Data Layers 1,000/月無料・以降 $75/1000（Enterprise のみ）
  - 日本カバレッジは GeoJSON 公開だが、地方のメガソーラー立地は BASE 品質に落ちやすく、そもそも地上設置の架台は「建物」として認識されない可能性が高い
  - PR 校正のバッチ前処理用途は理論上可能だが、Open-Meteo が tilt/azimuth 指定で GTI を直接返すため二重補正になり、得るものが薄い

---

## クライアントサイド計算ライブラリ（API代替の補助）

雲量だけ取得し GTI を JS 内で計算する場合に使う:

- **suncalc / solar-calculator** — 太陽位置（太陽高度・方位角）の軽量計算
- **NREL SPA (Solar Position Algorithm)** — 高精度版。JS ポート存在
- **Bird Clear Sky / Ineichen-Perez モデル** — クリアスカイ GHI の経験式。数十行で実装可能
- 想定式: `GTI ≈ ClearSkyGHI × (1 - k × CloudCover/100) × tiltFactor`（k は 0.6〜0.75）

---

## 補助的に使う API

### 国土地理院 AddressSearch (`https://msearch.gsi.go.jp/address-search/AddressSearch`)

施設住所 → 緯度経度のジオコーディング。

- **キー**: 不要
- **CORS**: **不可**（ブラウザから直接呼べない）
- **使い方**: 開発環境の Python バッチ（[cli.py](../src/solar_power_forecast/cli.py) の `geocode` サブコマンド）でのみ実行、結果 CSV をコミット
- **キャッシュ**: `data/output/geocode_cache.csv` で住所→座標を蓄積

### FIT/FIP 公表情報 (`https://www.fit-portal.go.jp/publicinfo`)

施設容量データ。県別 Excel をスクレイプ。

- **キー**: 不要
- **CORS**: 不可・Excel スクレイプはブラウザでは現実的でない
- **使い方**: 開発環境の Python バッチで定期取得 → 結果 CSV をコミット
