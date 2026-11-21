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

// 受注した日。システム上で「ほかのステージ → 受注」に変わった記録があればその日、
// 最初から受注として登録された商談(CSV・外部CRMからの取り込み、過去の受注の後入力)は
// 受注予定日(=実際の受注日)を使う。登録した日を受注日にすると、過去の受注が今月に集まってしまうため
export function wonDate(d) {
  if (d.stage !== "受注") return null;
  const hist = Array.isArray(d.stageHistory) ? d.stageHistory : [];
  for (let i = hist.length - 1; i >= 1; i--) {
    if (hist[i].stage === "受注" && hist[i - 1].stage !== "受注" && hist[i].at) return localDate(new Date(hist[i].at));
  }
  if (d.closeDate) return d.closeDate;
  return hist[0]?.at ? localDate(new Date(hist[0].at)) : null;
}

// その月に実際に受注した金額(from を指定すると、その日以降の分だけ)
export function actualWon(deals, month, from = "") {
  const ds = deals.filter((d) => {
    const w = wonDate(d) ?? "";
    return w.startsWith(month) && w >= from;
  });
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
    // 比べる相手をそろえる:
    // ・前月はじめの予測 … その月全体の実績と比べる
    // ・当月の途中で取った予測 … 予測を取った日より前の受注は予測に含まれていないので、その日以降の実績と比べる
    // 前月はじめの予測があれば、そちらを優先する(月全体を見通した予測のため)
    let p = null;
    let compared = actual;
    if (e.monthBefore) p = e.monthBefore.weighted;
    else if (e.sameMonth) {
      p = e.sameMonth.weighted;
      compared = actualWon(deals, e.month, e.sameMonth.takenOn);
    }
    // 誤差率:(予測 − 実績)÷ 実績。実績が0のときは計算しない
    const errorRate = p !== null && compared.total > 0 ? Math.round(((p - compared.total) / compared.total) * 100) : null;
    return { ...e, actual, compared: compared === actual ? null : compared, errorRate };
  });
  const rated = list.filter((x) => x.errorRate !== null);
  const bias = rated.length ? Math.round(rated.reduce((a, x) => a + x.errorRate, 0) / rated.length) : null;
  const meanAbs = rated.length ? Math.round(rated.reduce((a, x) => a + Math.abs(x.errorRate), 0) / rated.length) : null;
  return { months: list, bias, meanAbsError: meanAbs, sampleMonths: rated.length };
}

// =====================================================
// 確度の当たり具合(担当者が付けた確度は、実際の結果と合っているか)
// =====================================================
// 受注・失注した商談について、直前に付いていた確度(closedFromProbability)と結果を比べる。
// 天気予報の「降水確率70%の日に、本当に7割の日で雨が降ったか」と同じ考え方。
const BUCKETS = [[0, 20], [20, 40], [40, 60], [60, 80], [80, 101]];
export function probabilityCalibration(deals) {
  const rows = deals
    .filter((d) => (d.stage === "受注" || d.stage === "失注") && Number.isFinite(Number(d.closedFromProbability)) && d.closedFromProbability !== null)
    .map((d) => ({ p: Math.min(100, Math.max(0, Number(d.closedFromProbability))), won: d.stage === "受注" ? 1 : 0, ownerId: d.ownerId ?? null }));
  const buckets = BUCKETS.map(([lo, hi]) => {
    const rs = rows.filter((r) => r.p >= lo && r.p < hi);
    return {
      range: `${lo}〜${Math.min(hi, 100)}%`,
      count: rs.length,
      avgProbability: rs.length ? Math.round(rs.reduce((a, r) => a + r.p, 0) / rs.length) : null,
      actualWinRate: rs.length ? Math.round((rs.reduce((a, r) => a + r.won, 0) / rs.length) * 100) : null,
    };
  });
  // ブライアスコア:0に近いほど確度の付け方が正確(いつも50%と付けた場合は0.25)
  const brier = rows.length ? Math.round((rows.reduce((a, r) => a + (r.p / 100 - r.won) ** 2, 0) / rows.length) * 1000) / 1000 : null;
  // 付けた確度の平均 − 実際の受注率(プラスなら楽観的)
  const bias = rows.length ? Math.round(rows.reduce((a, r) => a + r.p, 0) / rows.length - (rows.reduce((a, r) => a + r.won, 0) / rows.length) * 100) : null;
  return { count: rows.length, buckets, brier, bias, rows };
}
