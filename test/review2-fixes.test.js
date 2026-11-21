// 2回目の独立した点検で見つかった不具合の再発防止テスト
import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../lib/db.js";
import { quoteFound, quoteOwner, classifyLines, isSellerSpeaker, parseAmounts, parseAmount, normalizeUrl, verifyExtract, verifyMeeting } from "../lib/verify.js";
import { handleStripeEvent } from "../lib/billing.js";

test("#1 再送された古い申し込み通知で、解約済みの契約を復活させない", async () => {
  const db = new Database(":memory:");
  const t = db.createTenant({ name: "課金社" });
  const mailer = { send: async () => ({ ok: true }) };
  const ev = (id, type, created, obj) => ({ id, type, created, data: { object: { customer: "cus_1", metadata: { tenant_id: t.id }, ...obj } } });
  await handleStripeEvent(ev("d", "customer.subscription.deleted", 300, { id: "sub_1" }), { db, mailer, appUrl: "" });
  await handleStripeEvent(ev("c", "checkout.session.completed", 100, { mode: "subscription", client_reference_id: t.id, subscription: "sub_1" }), { db, mailer, appUrl: "" });
  assert.notEqual(db.getTenant(t.id).plan, "standard");
  // メール送信が失敗しても、処理そのものは成功扱い(やり直しにならない)
  const broken = { send: async () => { throw new Error("SMTP down"); } };
  const t2 = db.createTenant({ name: "別社" });
  const r = await handleStripeEvent({ id: "c2", type: "checkout.session.completed", created: 500, data: { object: { mode: "subscription", customer: "cus_2", client_reference_id: t2.id, subscription: "sub_2", metadata: { tenant_id: t2.id } } } }, { db, mailer: broken, appUrl: "" });
  assert.equal(r.action, "subscribed");
});

test("#2 営業担当を名前・姓・役割つきで書いても、営業側の発言と判定する", () => {
  const sellers = ["山田太郎", "佐藤 花子"];
  for (const sp of ["山田", "山田太郎", "営業 山田", "弊社山田", "営業担当 山田", "山田(営業)", "佐藤", "佐藤花子", "営業"]) {
    assert.ok(isSellerSpeaker(sp, sellers), sp);
  }
  for (const sp of ["田中部長", "田中様", "鈴木"]) assert.ok(!isSellerSpeaker(sp, sellers), sp);
  const t = "田中部長:検討中です\n山田:予算は1000万円が一般的です";
  assert.equal(quoteOwner(t, "予算は1000万円が一般的です", sellers), "seller");
});

test("#3 引用に話者名が付いていても、その話者で判定する", () => {
  const t = "営業:年間800万円のご予算を確保いただいている前提で進めます\n田中:検討します";
  assert.equal(quoteOwner(t, "営業:年間800万円のご予算を確保いただいている"), "seller");
  assert.equal(quoteOwner(t, "年間800万円のご予算を確保いただいている"), "seller");
});

test("#4 中略つきの引用は、順番どおり・十分な長さの部分だけを認める", () => {
  const src = "予算はまだ全く確保できていません。人員は確保しています";
  assert.ok(!quoteFound(src, "予算は…確保しています"), "短い部分の寄せ集めは不可");
  assert.ok(!quoteFound(src, "人員は確保しています…予算はまだ全く確保"), "順番が逆は不可");
  assert.ok(quoteFound(src, "予算はまだ全く…人員は確保しています"));
});

test("#6 【名前】・Teams形式の時刻・箇条書きを、メモではなく発言として扱う", () => {
  const lines = classifyLines("【田中】予算は1000万円で確保済みです\n[10:02:33 AM] 田中: 来期からです\n* 予算は1000万円\n(メモ:確認する)\n※補足");
  // 3行目の箇条書きは、直前の田中さんの発言の続き
  assert.deepEqual(lines.map((l) => l.kind), ["customer", "customer", "customer", "memo", "memo"]);
  assert.equal(lines[0].speaker, "田中");
});

test("#7 名刺の上下の行の番号をつなげず、正しい電話番号を残す", () => {
  const text = "株式会社テスト\n田中 一郎\n〒100-0001\nTEL 03-1234-5678\n090-9876-5432";
  const r = verifyExtract({ companies: [], contacts: [{ name: "田中 一郎", phone: "03-1234-5678", email: "", companyName: "" }], deals: [] }, text);
  assert.equal(r.contacts[0].phone, "03-1234-5678");
});

test("#8 「100万人」のような、お金でない数を金額として拾わない", () => {
  assert.deepEqual([...parseAmounts("ユーザーは100万人、拠点は3千か所")], []);
  assert.deepEqual([...parseAmounts("予算は100万で、残りは来期")], [1000000], "「万」のあとが円でなくても、数え方の単位でなければ金額");
});

test("#9 不正なカンマの金額は、数値にしない", () => {
  assert.equal(parseAmount("12,34"), null);
  assert.equal(parseAmount("1,000,00"), null);
  assert.equal(parseAmount("1,000,000"), 1000000);
});

test("#11 出典URL:記事IDなどのパラメータは区別し、追跡用は無視する", () => {
  assert.notEqual(normalizeUrl("https://news.example.jp/article?id=1"), normalizeUrl("https://news.example.jp/article?id=999"));
  assert.equal(normalizeUrl("https://www.news.example.jp/article/?id=1&utm_source=x"), normalizeUrl("https://news.example.jp/article?id=1"));
});

test("話者つき議事録で、行をまたぐ引用は根拠にしない", () => {
  const t = "営業:ご予算はいかがですか\n田中:800万円です";
  const a = { bant: { budget: { status: "確認済", quote: "ご予算はいかがですか 田中:800万円です" }, authority: { status: "未確認" }, need: { status: "未確認" }, timeline: { status: "未確認" } }, winProbability: 30, crmUpdate: { stage: "提案", amount: null } };
  assert.equal(verifyMeeting(a, t).bant.budget.status, "未確認");
});
