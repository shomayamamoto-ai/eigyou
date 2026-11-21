// 3回目の独立した点検で見つかった不具合の再発防止テスト。
// 「悪い入力を通さない」だけでなく「正しい入力を弾かない」ことも確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../lib/db.js";
import { wonDate, actualWon, snapshotIfDue, forecastAccuracy } from "../lib/forecast.js";
import { parseAmounts, isSellerSpeaker, classifyLines, quoteOwner, quoteFound, verifyExtract, normalizeUrl } from "../lib/verify.js";
import { handleStripeEvent } from "../lib/billing.js";

test("#1 最初から受注として取り込んだ商談は、受注予定日の月に数える", () => {
  const db = new Database(":memory:");
  const s = db.forTenant(db.createTenant({ name: "t" }).id);
  const imported = s.insert("deals", { companyId: "c", title: "過去の受注", stage: "受注", amount: 5000000, closeDate: "2025-03-15" });
  assert.equal(wonDate(imported), "2025-03-15");
  assert.equal(actualWon(s.list("deals"), "2025-03").total, 5000000);
  const thisMonth = new Date().toISOString().slice(0, 7);
  assert.equal(actualWon(s.list("deals"), thisMonth).total, 0, "取り込んだ月には数えない");
  // システム上で受注に変えた商談は、変えた日を使う
  const d = s.insert("deals", { companyId: "c", title: "今回", stage: "交渉", amount: 1, closeDate: "2099-01-01" });
  const w = s.update("deals", d.id, { stage: "受注" });
  assert.notEqual(wonDate(w), "2099-01-01");
});

test("#2 「1000万から」「1000万かかる」は金額として読み、「3か所」「2か月」は除く", () => {
  assert.deepEqual([...parseAmounts("予算は1000万からで考えています")], [10000000]);
  assert.deepEqual([...parseAmounts("導入に1000万かかります")], [10000000]);
  assert.deepEqual([...parseAmounts("300万から500万")].sort((a, b) => a - b), [3000000, 5000000]);
  assert.deepEqual([...parseAmounts("200万か300万")].sort((a, b) => a - b), [2000000, 3000000]);
  assert.deepEqual([...parseAmounts("拠点は3千か所、期間は2万か月")], []);
});

test("#7 「2千万人」などを、短い単位で読み直して金額にしない", () => {
  assert.deepEqual([...parseAmounts("会員は2千万人")], []);
  assert.deepEqual([...parseAmounts("人口1億2000万人")], []);
  assert.deepEqual([...parseAmounts("社員3万5千人")], []);
  assert.deepEqual([...parseAmounts("予算は2千万円")], [20000000]);
});

test("#3 顧客側の肩書き・ローマ字名を、営業側と取り違えない", () => {
  for (const sp of ["Ishikawa", "Ishii", "AEON 鈴木", "営業部長", "担当部長", "担当者の田中", "こちらの部長"]) {
    assert.ok(!isSellerSpeaker(sp, ["山田太郎"]), sp);
  }
  for (const sp of ["営業", "IS", "弊社山田", "営業 山田", "営業・山田", "担当 山田"]) assert.ok(isSellerSpeaker(sp, []), sp);
});

test("#4 営業担当の姓で始まる、顧客の会社名・名前を営業側としない", () => {
  assert.ok(!isSellerSpeaker("山田商事 鈴木", ["山田"]));
  assert.ok(!isSellerSpeaker("鈴木部長", ["鈴木"]), "姓で始まる別の表記は、断定しない");
  assert.ok(isSellerSpeaker("山田", ["山田太郎"]));
});

test("#5 話者名のない続きの行は、直前の話者の発言として扱う", () => {
  const t = "営業:ご予算は?\n鈴木: 予算については\n来期に1000万円を確保しています";
  assert.equal(quoteOwner(t, "予算については来期に1000万円を確保しています"), "customer");
  assert.equal(classifyLines(t)[2].continued, true);
  // 話者をまたぐ引用は、引き続き認めない
  assert.equal(quoteOwner(t, "ご予算は?鈴木:予算については"), null);
});

test("#6 当月の途中で取った予測は、予測を取った日以降の実績と比べる", () => {
  const db = new Database(":memory:");
  const t = db.createTenant({ name: "予測社" });
  const s = db.forTenant(t.id);
  const early = s.insert("deals", { companyId: "c", title: "月初の受注", stage: "交渉", amount: 3000000, probability: 80, closeDate: "2026-11-05" });
  s.update("deals", early.id, { stage: "受注", stageHistory: [{ stage: "交渉", at: "2026-11-01T00:00:00Z" }, { stage: "受注", at: "2026-11-05T00:00:00Z" }] });
  s.insert("deals", { companyId: "c", title: "月末予定", stage: "交渉", amount: 2000000, probability: 50, closeDate: "2026-11-28" });
  snapshotIfDue(db, t.id, { today: "2026-11-21" }); // 機能の導入日(月の途中)に初めて予測を取った
  const later = s.list("deals").find((d) => d.title === "月末予定");
  s.update("deals", later.id, { stage: "受注", stageHistory: [{ stage: "交渉", at: "2026-11-21T00:00:00Z" }, { stage: "受注", at: "2026-11-27T00:00:00Z" }] });
  const nov = forecastAccuracy(db, t.id, { today: "2026-12-02" }).months.find((m) => m.month === "2026-11");
  assert.equal(nov.actual.total, 5000000, "月全体の実績");
  assert.equal(nov.compared.total, 2000000, "予測後の実績");
  assert.equal(nov.errorRate, -50, "予測100万 vs 予測後の実績200万");
});

test("そのほか:(株)つきの話者名・中略の短い頭・同じ行の2つの番号・URLの大文字小文字", () => {
  assert.equal(classifyLines("(株)ABC 鈴木:予算は確保済みです")[0].kind, "customer");
  assert.ok(quoteFound("予算は、来期に1000万円程度を見込んでいます", "予算は…1000万円程度を見込んでいます"));
  assert.ok(!quoteFound("予算はまだ全く確保できていません。人員は確保しています", "予算は…確保しています"));
  const r = verifyExtract({ companies: [], contacts: [{ name: "田中 一郎", phone: "03-1234-5678", email: "", companyName: "" }, { name: "田中 一郎", phone: "03.9999.8888", email: "", companyName: "" }], deals: [] },
    "田中 一郎\nTEL 03-1234-5678 090-1111-2222\n03.9999.8888");
  assert.equal(r.contacts[0].phone, "03-1234-5678");
  assert.equal(r.contacts[1].phone, "03.9999.8888");
  assert.equal(normalizeUrl("https://a.example/%e3%81%82"), normalizeUrl("https://a.example/%E3%81%82"));
});

test("そのほか:古い「支払い失敗」の通知で、未払い扱いに戻さない", async () => {
  const db = new Database(":memory:");
  const t = db.createTenant({ name: "請求社", plan: "standard" });
  const mailer = { send: async () => ({ ok: true }) };
  const ev = (id, type, created) => ({ id, type, created, data: { object: { customer: "cus_x", metadata: { tenant_id: t.id } } } });
  db.updateTenant(t.id, { billing_status: "past_due" });
  await handleStripeEvent(ev("paid", "invoice.paid", 200), { db, mailer, appUrl: "" });
  await handleStripeEvent(ev("oldfail", "invoice.payment_failed", 100), { db, mailer, appUrl: "" });
  assert.equal(db.getTenant(t.id).billing_status, "active");
});
