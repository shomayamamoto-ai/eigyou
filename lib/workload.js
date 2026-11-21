// 予定の混み具合(待ち行列理論の応用)
//
// 考え方:
//   レジの行列と同じで、1日の予定を「こなせる量」ぎりぎりまで詰めると、
//   急な用事が1つ入っただけで後ろの予定がすべて遅れます。
//   待ち行列理論の基本式(窓口が1つの場合)では、
//       待ち時間 = 稼働率 ÷ (1 − 稼働率) × 1件の処理時間
//   となり、稼働率80%で「処理時間の4倍」、90%で「9倍」、95%で「19倍」待つことになります。
//   8割を超えると急に詰まるため、「予定は8割まで」を目安にします。
//
// ここでは、商談の「次のアクション」の期限を担当者ごと・日ごとに数え、
// 1日にこなせる件数に対する稼働率を出し、8割を超える日の予定を
// 近くの空いている日へずらす案を作ります。
//
// 注意:この式は「用事がばらばらに発生し、処理時間もばらつく」という単純な前提のものです。
//       実際の営業活動を正確に予測するものではなく、詰め込みすぎに気づくための目安です。
import { localDate } from "./time.js";
import { dealProbability } from "./crm.js";
import { isBusinessDay, dayOffReason } from "./holidays.js";

export const DEFAULT_CAPACITY = 5; // 1日にこなせる「次のアクション」の件数(既定値)
export const TARGET_UTILIZATION = 0.8; // 予定は8割まで

// 待ちの倍率:稼働率 ρ のとき、1件の処理時間の何倍待つか(ρ/(1−ρ))。100%以上は「終わらない」
export function waitFactor(utilization) {
  if (!(utilization >= 0)) return 0;
  if (utilization >= 1) return null;
  return utilization / (1 - utilization);
}

export function congestionLevel(utilization) {
  if (utilization > 1) return "over"; // こなせる量を超えている
  if (utilization > TARGET_UTILIZATION) return "busy"; // 8割を超えていて、遅れが出やすい
  return "ok";
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const addDays = (date, n) => new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);

// 今日から数えて n 営業日ぶんの日付(土日・祝日・会社の休業日を除く)
export function businessDays(from, n) {
  const out = [];
  for (let d = from; out.length < n; d = addDays(d, 1)) if (isBusinessDay(d)) out.push(d);
  return out;
}

// 1人ぶんの混み具合と、ずらす提案を計算する
export function analyzeWorkload(deals, { ownerId, capacity = DEFAULT_CAPACITY, today = localDate(), horizon = 10, companyNames = new Map() } = {}) {
  const cap = Math.max(1, Number(capacity) || DEFAULT_CAPACITY);
  const limit = cap * TARGET_UTILIZATION; // この件数までなら「8割以内」
  const days = businessDays(today, horizon);
  const firstDay = days[0];
  const lastDay = days.at(-1);

  const tasks = deals
    .filter((d) => !["受注", "失注"].includes(d.stage) && d.nextAction && d.nextActionDate && (ownerId === undefined || (d.ownerId ?? null) === ownerId))
    .map((d) => {
      const overdue = d.nextActionDate < today;
      // 期限切れは「今日(最初の営業日)に持ち越し」、休みの日の予定は「次の営業日」に寄せて数える
      let day = overdue ? firstDay : d.nextActionDate;
      const offReason = overdue ? null : dayOffReason(day);
      while (!isBusinessDay(day)) day = addDays(day, 1);
      return { deal: d, day, overdue, offReason, value: (Number(d.amount) || 0) * dealProbability(d) / 100 };
    })
    .filter((t) => t.day <= lastDay);

  const load = new Map(days.map((d) => [d, 0]));
  for (const t of tasks) load.set(t.day, (load.get(t.day) ?? 0) + 1);

  // ---------- ずらす提案 ----------
  // 8割を超えた日から、優先度の低い(見込み金額の小さい)予定を、いちばん近い空いている日へ移す
  const planned = new Map(load);
  const suggestions = [];
  for (const day of days) {
    if (planned.get(day) <= limit) continue;
    const movable = tasks
      .filter((t) => t.day === day && !t.overdue) // すでに遅れている予定は、これ以上後ろへずらさない
      .sort((a, b) => a.value - b.value);
    for (const t of movable) {
      if (planned.get(day) <= limit) break;
      const close = t.deal.closeDate || "";
      const candidates = days
        .filter((d) => d !== day && planned.get(d) + 1 <= limit && (!close || d <= close))
        .sort((a, b) => Math.abs(days.indexOf(a) - days.indexOf(day)) - Math.abs(days.indexOf(b) - days.indexOf(day)) || (a < b ? -1 : 1));
      const to = candidates[0];
      if (!to) continue;
      planned.set(day, planned.get(day) - 1);
      planned.set(to, planned.get(to) + 1);
      suggestions.push({
        dealId: t.deal.id,
        title: t.deal.title,
        companyId: t.deal.companyId,
        companyName: companyNames.get(t.deal.companyId) ?? "",
        nextAction: t.deal.nextAction,
        from: t.deal.nextActionDate,
        to,
        earlier: to < day,
      });
    }
  }

  const describe = (d, n) => {
    const u = n / cap;
    const w = waitFactor(u);
    return {
      date: d,
      weekday: WEEKDAYS[weekdayOf(d)],
      load: n,
      capacity: cap,
      utilization: Math.round(u * 100),
      level: congestionLevel(u),
      // 例:4 → 「1件にかかる時間の4倍、手をつけるまで待つ」目安
      waitFactor: w === null ? null : Math.round(w * 10) / 10,
    };
  };
  const result = days.map((d) => describe(d, load.get(d)));
  const after = days.map((d) => describe(d, planned.get(d)));
  const busy = result.filter((d) => d.level !== "ok");

  return {
    capacity: cap,
    targetLoad: Math.floor(limit + 1e-9), // 「8割まで」に収まる件数
    days: result,
    afterDays: after,
    suggestions,
    // 休みの日(土日・祝日)に期限が入っている予定。実際には次の営業日に回ることになる
    onDaysOff: tasks.filter((t) => t.offReason).map((t) => ({
      dealId: t.deal.id, title: t.deal.title, nextAction: t.deal.nextAction, companyId: t.deal.companyId,
      companyName: companyNames.get(t.deal.companyId) ?? "", date: t.deal.nextActionDate, reason: t.offReason, countedOn: t.day,
    })),
    summary: {
      taskCount: tasks.length,
      overdueCount: tasks.filter((t) => t.overdue).length,
      busyDays: busy.length,
      overDays: result.filter((d) => d.level === "over").length,
      peak: result.reduce((a, d) => (d.load > a.load ? d : a), result[0]),
      // 提案をすべて実行しても8割を超えたままの日数(=全体として予定が多すぎる)
      remainingBusyDays: after.filter((d) => d.level !== "ok").length,
    },
  };
}

// ある担当者の、ある日の混み具合だけを調べる(期限を入れたときの警告用)
export function dayLoad(deals, { ownerId, date, capacity = DEFAULT_CAPACITY, today = localDate() }) {
  const r = analyzeWorkload(deals, { ownerId, capacity, today, horizon: 20 });
  const offReason = dayOffReason(date);
  let day = date < today ? r.days[0].date : date;
  while (!isBusinessDay(day)) day = addDays(day, 1);
  const hit = r.days.find((d) => d.date === day);
  if (!hit) return offReason ? { date, offReason, nextBusinessDay: day } : null;
  const alt = r.days.find((d) => d.date > day && d.load + 1 <= r.capacity * TARGET_UTILIZATION);
  return { ...hit, offReason, nextBusinessDay: offReason ? day : null, alternative: alt?.date ?? null };
}
