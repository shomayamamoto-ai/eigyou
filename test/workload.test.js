// 予定の混み具合(待ち行列理論)のテスト
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitFactor, congestionLevel, businessDays, analyzeWorkload, dayLoad } from "../lib/workload.js";

test("待ちの倍率:稼働率が8割を超えると急に増える(動画の数字と同じ関係)", () => {
  // レジ1台・1人あたり平均1分:48人/時=稼働率80% → 待ち約4分、54人=90% → 約9分、57人=95% → 約19分
  assert.equal(Math.round(waitFactor(48 / 60)), 4);
  assert.equal(Math.round(waitFactor(54 / 60)), 9);
  assert.equal(Math.round(waitFactor(57 / 60)), 19);
  assert.equal(waitFactor(0.5), 1);
  assert.equal(waitFactor(1), null, "100%以上は終わらない");
  assert.equal(congestionLevel(0.8), "ok");
  assert.equal(congestionLevel(0.81), "busy");
  assert.equal(congestionLevel(1.2), "over");
});

test("営業日:土日を飛ばして数える", () => {
  // 2026-11-20 は金曜日
  assert.deepEqual(businessDays("2026-11-20", 3), ["2026-11-20", "2026-11-23", "2026-11-24"]);
  assert.deepEqual(businessDays("2026-11-21", 1), ["2026-11-23"], "土曜始まりは月曜から");
});

const deal = (id, date, extra = {}) => ({ id, title: `案件${id}`, companyId: "c", stage: "提案", amount: 1000000, probability: 50, nextAction: `連絡${id}`, nextActionDate: date, ownerId: "u1", ...extra });

test("8割を超えた日から、見込みの小さい予定を近くの空いている日へずらす", () => {
  const today = "2026-11-24"; // 火曜
  const deals = [
    ...[1, 2, 3, 4, 5, 6].map((i) => deal(String(i), "2026-11-25", { amount: i * 1000000 })), // 水曜に6件(容量5 → 120%)
    deal("x", "2026-11-26"),
    deal("other", "2026-11-25", { ownerId: "u2" }), // 他人の予定は数えない
    deal("done", "2026-11-25", { stage: "受注" }), // 終わった商談は数えない
    deal("nodate", "", {}),
  ];
  const r = analyzeWorkload(deals, { ownerId: "u1", capacity: 5, today, horizon: 10 });
  const wed = r.days.find((d) => d.date === "2026-11-25");
  assert.equal(wed.load, 6);
  assert.equal(wed.utilization, 120);
  assert.equal(wed.level, "over");
  assert.equal(r.targetLoad, 4, "容量5の8割=4件");
  // 4件まで減らすので2件動かす。見込みの小さい順(案件1・案件2)
  assert.deepEqual(r.suggestions.map((m) => m.dealId), ["1", "2"]);
  // いちばん近い日へ(前日の火曜 or 翌日の木曜。木曜は1件あるので、まず火曜へ)
  assert.equal(r.suggestions[0].to, "2026-11-24");
  assert.ok(r.afterDays.every((d) => d.load <= 4), "提案どおりに動かせば、すべて8割以内");
  assert.equal(r.summary.remainingBusyDays, 0);
});

test("期限切れの予定は今日に数え、後ろへはずらさない。受注予定日を過ぎる移動もしない", () => {
  const today = "2026-11-24";
  const deals = [
    ...[1, 2, 3, 4, 5].map((i) => deal(`late${i}`, "2026-11-10")), // 期限切れ5件 → 今日に集中
    deal("tight", "2026-11-24", { closeDate: "2026-11-24", amount: 1 }),
  ];
  const r = analyzeWorkload(deals, { ownerId: "u1", capacity: 5, today, horizon: 5 });
  assert.equal(r.days[0].load, 6);
  assert.equal(r.summary.overdueCount, 5);
  assert.equal(r.suggestions.length, 0, "期限切れは動かさず、受注予定日を過ぎる移動もしない");
  assert.equal(r.summary.remainingBusyDays, 1);
});

test("期限を入れるときの確認:混んでいる日と、空いている候補日を返す", () => {
  const today = "2026-11-24";
  const deals = [1, 2, 3, 4].map((i) => deal(String(i), "2026-11-25"));
  const r = dayLoad(deals, { ownerId: "u1", date: "2026-11-25", capacity: 5, today });
  assert.equal(r.load, 4);
  assert.equal(r.alternative, "2026-11-26");
  const sat = dayLoad(deals, { ownerId: "u1", date: "2026-11-28", capacity: 5, today });
  assert.equal(sat.date, "2026-11-30", "土曜は次の月曜として数える");
});
