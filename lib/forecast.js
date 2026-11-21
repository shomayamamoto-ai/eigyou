// 売上予測と、その「当たり具合」の記録
//
// 予測(見込み):進行中の商談の「金額 × 確度」を、受注予定月ごとに合計したもの。
//   確度が未入力の商談は、ステージごとの受注率(自社の実績で補正したもの)を使う。
//   受注予定日を過ぎても進行中の商談(遅延)は、月別の予測から外す。
//
// 当たり具合:毎月はじめに、その月と翌月の予測を保存しておき、月が終わったあとに
//   実際の受注額と比べる。予測が楽観的すぎる(または悲観的すぎる)くせを、数字で確かめられる。
import { dealProbability, stageWinRates } from "./crm.js";
import { localDate } from "./time.js";

const amt = (d) => Number(d.amount) || 0;
const isOpen = (d) => !["受注", "失注"].includes(d.stage);

export function monthsFrom(today, n) {
  const [y, m] = today.split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

// 月別の予測を計算する
export function monthlyForecast(deals, { today = localDate(), months = 6 } = {}) {
  const rates = stageWinRates(deals);
  const weighted = (d) => (amt(d) * dealProbability(d, rates)) / 100;
  const open = deals.filter(isOpen);
  const list = monthsFrom(today, months);
  const slipped = open.filter((d) => d.closeDate && d.closeDate < today);
  const inRange = (d) => d.closeDate && !slipped.includes(d) && list.includes(d.closeDate.slice(0, 7));
  const forecast = list.map((month) => {
    const ds = open.filter((d) => inRange(d) && d.closeDate.startsWith(month));
    return { month, count: ds.length, total: ds.reduce((a, d) => a + amt(d), 0), weighted: Math.round(ds.reduce((a, d) => a + weighted(d), 0)) };
  });
  const undated = open.filter((d) => !slipped.includes(d) && !inRange(d));
  return { months: list, forecast, slipped, undated, rates, weighted };
}

// 受注した日(ステージが「受注」になった日)。記録がなければ受注予定日を使う
export function wonDate(d) {
  if (d.stage !== "受注") return null;
  const h = Array.isArray(d.stageHistory) ? [...d.stageHistory].reverse().find((x) => x.stage === "受注") : null;
  if (h?.at) return localDate(new Date(h.at));
  return d.closeDate || null;
}

// その月に実際に受注した金額
export function actualWon(deals, month) {
  const ds = deals.filter((d) => (wonDate(d) ?? "").startsWith(month));
  return { count: ds.length, total: ds.reduce((a, d) => a + amt(d), 0) };
}

// 今月の予測をまだ保存していなければ保存する(今月と翌月の2か月分)
export function snapshotIfDue(db, tenantId, { today = localDate() } = {}) {
  const takenMonth = today.slice(0, 7);
  if (db.get("SELECT 1 AS x FROM forecast_snapshots WHERE tenant_id = ? AND taken_month = ?", tenantId, takenMonth)) return false;
  const f = monthlyForecast(db.forTenant(tenantId).list("deals"), { today, months: 2 });
  for (const row of f.forecast) {
    db.run(
      "INSERT OR IGNORE INTO forecast_snapshots (tenant_id, taken_month, target_month, weighted, total, count, taken_on) VALUES (?, ?, ?, ?, ?, ?, ?)",
      tenantId, takenMonth, row.month, row.weighted, row.total, row.count, today,
    );
  }
  return true;
}

// 予測と実績の比較(終わった月だけ)
export function forecastAccuracy(db, tenantId, { today = localDate(), months = 6 } = {}) {
  const deals = db.forTenant(tenantId).list("deals");
  const thisMonth = today.slice(0, 7);
  const rows = db.all("SELECT * FROM forecast_snapshots WHERE tenant_id = ? AND target_month < ? ORDER BY target_month DESC, taken_month DESC", tenantId, thisMonth);
  const byMonth = new Map();
  for (const r of rows) {
    const e = byMonth.get(r.target_month) ?? { month: r.target_month };
    // 当月はじめの予測と、前月はじめ(1か月前)の予測
    if (r.taken_month === r.target_month) e.sameMonth = { weighted: r.weighted, takenOn: r.taken_on };
    else e.monthBefore = { weighted: r.weighted, takenOn: r.taken_on };
    byMonth.set(r.target_month, e);
  }
  const list = [...byMonth.values()].slice(0, months).map((e) => {
    const actual = actualWon(deals, e.month);
    const p = e.sameMonth?.weighted ?? e.monthBefore?.weighted ?? null;
    // 誤差率:(予測 − 実績)÷ 実績。実績が0のときは計算しない
    const errorRate = p !== null && actual.total > 0 ? Math.round(((p - actual.total) / actual.total) * 100) : null;
    return { ...e, actual, errorRate };
  });
  const rated = list.filter((x) => x.errorRate !== null);
  const bias = rated.length ? Math.round(rated.reduce((a, x) => a + x.errorRate, 0) / rated.length) : null;
  const meanAbs = rated.length ? Math.round(rated.reduce((a, x) => a + Math.abs(x.errorRate), 0) / rated.length) : null;
  return { months: list, bias, meanAbsError: meanAbs, sampleMonths: rated.length };
}
