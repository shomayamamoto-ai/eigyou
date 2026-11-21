// 売上予測と「当たり具合」のテスト
import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../lib/db.js";
import { monthlyForecast, monthsFrom, wonDate, actualWon, snapshotIfDue, forecastAccuracy } from "../lib/forecast.js";

test("月の並び:年をまたいでも正しく数える", () => {
  assert.deepEqual(monthsFrom("2026-11-21", 4), ["2026-11", "2026-12", "2027-01", "2027-02"]);
});

test("予測:遅延・範囲外・終わった商談を正しく振り分ける", () => {
  const deals = [
    { stage: "提案", amount: 1000000, probability: 50, closeDate: "2026-12-10" },
    { stage: "交渉", amount: 2000000, probability: null, closeDate: "2026-12-20" }, // 確度未入力 → 交渉の標準70%
    { stage: "提案", amount: 9000000, probability: 50, closeDate: "2026-10-01" }, // 遅延
    { stage: "提案", amount: 3000000, probability: 50, closeDate: "2028-01-01" }, // 範囲外
    { stage: "受注", amount: 5000000, closeDate: "2026-12-01" }, // 終わった商談
  ];
  const f = monthlyForecast(deals, { today: "2026-11-21", months: 3 });
  assert.deepEqual(f.forecast.map((x) => [x.month, x.count, x.weighted]), [["2026-11", 0, 0], ["2026-12", 2, 500000 + 1400000], ["2027-01", 0, 0]]);
  assert.equal(f.slipped.length, 1);
  assert.equal(f.undated.length, 1);
});

test("受注した日:ステージが「受注」になった日を使い、記録がなければ受注予定日", () => {
  assert.equal(wonDate({ stage: "受注", stageHistory: [{ stage: "提案", at: "2026-09-01T00:00:00Z" }, { stage: "受注", at: "2026-10-15T03:00:00Z" }], closeDate: "2026-12-01" }), "2026-10-15");
  assert.equal(wonDate({ stage: "受注", closeDate: "2026-12-01" }), "2026-12-01");
  assert.equal(wonDate({ stage: "提案", closeDate: "2026-12-01" }), null);
  // 日本時間で日付をまたぐ:UTC 10/31 20:00 = 日本時間 11/1 05:00
  assert.equal(wonDate({ stage: "受注", stageHistory: [{ stage: "受注", at: "2026-10-31T20:00:00Z" }] }), "2026-11-01");
});

test("当たり具合:月はじめの予測を保存し、月が終わったら実績と比べる", () => {
  const db = new Database(":memory:");
  const t = db.createTenant({ name: "予測社" });
  const s = db.forTenant(t.id);
  const d1 = s.insert("deals", { companyId: "c", title: "a", stage: "交渉", amount: 4000000, probability: 50, closeDate: "2026-11-25" });
  s.insert("deals", { companyId: "c", title: "b", stage: "提案", amount: 2000000, probability: 50, closeDate: "2026-11-28" });
  // 11月はじめに予測を保存(11月:200万+100万=300万)
  assert.equal(snapshotIfDue(db, t.id, { today: "2026-11-02" }), true);
  assert.equal(snapshotIfDue(db, t.id, { today: "2026-11-15" }), false, "同じ月に2回は保存しない");
  // 実際には a だけ受注(400万)
  s.update("deals", d1.id, { stage: "受注", stageHistory: [{ stage: "交渉", at: "2026-11-01T00:00:00Z" }, { stage: "受注", at: "2026-11-20T00:00:00Z" }] });
  assert.deepEqual(actualWon(s.list("deals"), "2026-11"), { count: 1, total: 4000000 });
  // 12月になってから比べる
  const acc = forecastAccuracy(db, t.id, { today: "2026-12-05" });
  const nov = acc.months.find((m) => m.month === "2026-11");
  assert.equal(nov.sameMonth.weighted, 3000000);
  assert.equal(nov.actual.total, 4000000);
  assert.equal(nov.errorRate, -25, "予測が実績より25%少なかった(悲観的)");
  assert.equal(acc.bias, -25);
  assert.equal(acc.sampleMonths, 1);
  // 今月(12月)はまだ終わっていないので、比べない
  assert.ok(!acc.months.some((m) => m.month === "2026-12"));
});

import { probabilityCalibration } from "../lib/forecast.js";

test("受注・失注になったとき、直前の確度を記録する", () => {
  const db = new Database(":memory:");
  const s = db.forTenant(db.createTenant({ name: "t" }).id);
  const d = s.insert("deals", { companyId: "c", title: "a", stage: "交渉", probability: 70 });
  // 商談分析の反映のように、確度とステージを同時に変えても「変える前」の確度を記録する
  const after = s.update("deals", d.id, { stage: "受注", probability: 100 });
  assert.equal(after.closedFromProbability, 70);
  const n = s.insert("deals", { companyId: "c", title: "b", stage: "提案", probability: null });
  assert.equal(s.update("deals", n.id, { stage: "失注" }).closedFromProbability, undefined, "確度が未入力なら記録しない");
});

test("確度の当たり具合:確度ごとの実際の受注率・ブライアスコア・偏り", () => {
  const mk = (p, won) => ({ stage: won ? "受注" : "失注", closedFromProbability: p });
  const deals = [mk(80, true), mk(80, true), mk(80, false), mk(90, false), mk(30, false), mk(30, true), { stage: "提案", closedFromProbability: 50 }];
  const c = probabilityCalibration(deals);
  assert.equal(c.count, 6, "進行中の商談は数えない");
  const hi = c.buckets.find((b) => b.range === "80〜100%");
  assert.deepEqual([hi.count, hi.avgProbability, hi.actualWinRate], [4, 83, 50]);
  const lo = c.buckets.find((b) => b.range === "20〜40%");
  assert.deepEqual([lo.count, lo.actualWinRate], [2, 50]);
  // ブライア:((0.2²+0.2²+0.8²+0.9²+0.3²+0.7²)/6) = (0.04+0.04+0.64+0.81+0.09+0.49)/6 = 0.352
  assert.equal(c.brier, 0.352);
  // 偏り:付けた確度の平均 65 − 実際の受注率 50 = +15(楽観的)
  assert.equal(c.bias, 15);
});
