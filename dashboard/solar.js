// 太陽位置とクリアスカイGHIの軽量計算。グローバル window.Solar に関数を生やす。
// 精度は概算用途として十分なレベル（Spencer の赤緯式 + Haurwitz クリアスカイモデル）。

(function () {
  const DEG = Math.PI / 180;

  function dayOfYearUtc(date) {
    const start = Date.UTC(date.getUTCFullYear(), 0, 0);
    return Math.floor((date.getTime() - start) / 86400000);
  }

  // 赤緯 [rad] - Spencer Fourier展開
  function solarDeclination(doy) {
    const g = (2 * Math.PI * (doy - 1)) / 365;
    return (
      0.006918
      - 0.399912 * Math.cos(g)
      + 0.070257 * Math.sin(g)
      - 0.006758 * Math.cos(2 * g)
      + 0.000907 * Math.sin(2 * g)
      - 0.002697 * Math.cos(3 * g)
      + 0.001480 * Math.sin(3 * g)
    );
  }

  // 均時差 [分]
  function equationOfTime(doy) {
    const b = (2 * Math.PI * (doy - 81)) / 364;
    return 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
  }

  // 太陽高度 [rad]
  function solarAltitude(latDeg, lonDeg, dateUtc) {
    const lat = latDeg * DEG;
    const doy = dayOfYearUtc(dateUtc);
    const decl = solarDeclination(doy);
    const eot = equationOfTime(doy);
    const utcMinutes = dateUtc.getUTCHours() * 60 + dateUtc.getUTCMinutes() + dateUtc.getUTCSeconds() / 60;
    // 真太陽時 [分]: 経度4分/度 + 均時差
    const solarTimeMinutes = utcMinutes + 4 * lonDeg + eot;
    // 時角 [rad]: 1時間=15度
    const hourAngle = ((solarTimeMinutes - 720) / 60) * 15 * DEG;
    const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
    return Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  }

  // クリアスカイ GHI [W/m^2] - Haurwitz式
  function clearSkyGHI(latDeg, lonDeg, dateUtc) {
    const alt = solarAltitude(latDeg, lonDeg, dateUtc);
    if (alt <= 0) return 0;
    const cosZ = Math.sin(alt);
    return 1098 * cosZ * Math.exp(-0.057 / cosZ);
  }

  // 1時間ごとに clearSkyGHI を返す [W/m^2] 配列。dayStartUtc は当該日の UTC 00:00 に揃えた Date
  function clearSkyHourly(latDeg, lonDeg, dayStartUtc, hours = 24) {
    const out = new Array(hours);
    for (let h = 0; h < hours; h += 1) {
      const t = new Date(dayStartUtc.getTime() + h * 3600 * 1000);
      out[h] = clearSkyGHI(latDeg, lonDeg, t);
    }
    return out;
  }

  // 雲量補正後 GHI [W/m^2]。Kasten-Czeplak 非線形式
  function applyCloudCorrection(clearGhi, cloudPct) {
    if (!(clearGhi > 0)) return 0;
    const cc = Math.max(0, Math.min(100, cloudPct ?? 0)) / 100;
    return clearGhi * (1 - 0.75 * Math.pow(cc, 3.4));
  }

  // GHI -> GTI 簡易変換 (水平→傾斜面、緯度近似)
  // 入射角の概算: 真南向き・tiltDeg 傾斜面に対し cos(lat - tilt) 因子で近似
  function ghiToGti(ghi, latDeg, tiltDeg = 30) {
    const f = Math.cos((Math.abs(latDeg) - tiltDeg) * DEG);
    return ghi * Math.max(0.5, f); // f が小さくなりすぎないよう下限
  }

  // モジュール温度 [℃] - NOCT モデル (結晶シリコン一般値 NOCT=45℃)
  function cellTemperature(ambientC, poaWm2, noct = 45) {
    return ambientC + ((noct - 20) / 800) * Math.max(0, poaWm2);
  }

  // 温度による出力比率 (STC 25℃基準、gamma≈-0.4%/℃)。poaWm2<=0 なら 1 を返す
  function temperatureDerate(ambientC, poaWm2, gamma = -0.004) {
    if (!Number.isFinite(ambientC) || !(poaWm2 > 0)) return 1;
    const tCell = cellTemperature(ambientC, poaWm2, 45);
    return 1 + gamma * (tCell - 25);
  }

  window.Solar = {
    solarAltitude,
    solarDeclination,
    equationOfTime,
    clearSkyGHI,
    clearSkyHourly,
    applyCloudCorrection,
    ghiToGti,
    cellTemperature,
    temperatureDerate,
    dayOfYearUtc,
  };
})();
