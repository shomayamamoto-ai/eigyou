// 独立した点検で見つかった不具合の再発防止テスト
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../lib/db.js";
import { initSecrets } from "../lib/secrets.js";
import { createApp } from "../lib/app.js";
import { isDateString, parseDateLoose } from "../lib/time.js";
import { parseAmounts, parseAmount, verifyExtract } from "../lib/verify.js";
import { parseCookies } from "../lib/auth.js";
import { companyKey, mergeCompanies, checkQuality } from "../lib/crm.js";
import { handleStripeEvent } from "../lib/billing.js";

process.env.APP_ENCRYPTION_KEY = "f".repeat(64);
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ALLOW_SIGNUP;
initSecrets({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "eigyou-")) });

const tmp = () => { const db = new Database(":memory:"); return { db, s: db.forTenant(db.createTenant({ name: "t" }).id) }; };

test("#1 同じIDを2回指定して統合しても、会社が消えない", () => {
  const { s } = tmp();
  const a = s.insert("companies", { name: "A社" });
  s.insert("deals", { companyId: a.id, title: "d", stage: "提案" });
  mergeCompanies(s, [a.id, a.id]);
  assert.ok(s.get("companies", a.id));
  assert.equal(s.list("deals").length, 1);
});

test("#3 別の会社へ移した商談の議事録は、元の会社を消しても残り、会社IDも付け替わる", () => {
  const { s } = tmp();
  const a = s.insert("companies", { name: "A社" });
  const b = s.insert("companies", { name: "B社" });
  const d = s.insert("deals", { companyId: a.id, title: "d", stage: "提案" });
  const m = s.insert("meetings", { dealId: d.id, companyId: a.id, date: "2026-11-01" });
  s.insert("meetings", { dealId: null, companyId: a.id, date: "2026-11-02" }); // 商談なしの議事録は会社と一緒に消える
  s.update("deals", d.id, { companyId: b.id });
  assert.equal(s.get("meetings", m.id).companyId, b.id);
  s.remove("companies", a.id);
  assert.ok(s.get("meetings", m.id));
  assert.equal(s.list("meetings").length, 1);
});

test("#5 取り込み:1文字違うメール・桁の足りない電話番号は採用しない", () => {
  const text = "山田 太郎\ntaro.yamada@abc-corp.co.jp\n090-1234-5678\nABC株式会社";
  const r = verifyExtract({ companies: [], contacts: [{ name: "山田 太郎", email: "taroyamada@abccorp.co.jp", phone: "090-1234-567", companyName: "" }], deals: [] }, text);
  assert.equal(r.contacts[0].email, "");
  assert.equal(r.contacts[0].phone, "");
  const ok = verifyExtract({ companies: [], contacts: [{ name: "山田 太郎", email: "Taro.Yamada@abc-corp.co.jp", phone: "09012345678", companyName: "" }], deals: [] }, text);
  assert.equal(ok.contacts[0].email, "Taro.Yamada@abc-corp.co.jp", "大文字・小文字の違いは同じアドレス");
  assert.equal(ok.contacts[0].phone, "09012345678", "ハイフンの有無は同じ番号");
});

test("#6 存在しない日付(2月30日など)は受け付けない", () => {
  assert.equal(isDateString("2026-02-30"), false);
  assert.equal(isDateString("2026-02-28"), true);
  assert.equal(isDateString("2028-02-29"), true, "うるう年");
  assert.equal(parseDateLoose("2026-02-30"), "");
  assert.equal(parseDateLoose("2026-13-01"), "");
});

test("#8 壊れたCookieがあっても落ちない", () => {
  assert.deepEqual(parseCookies("sid=abc; x=%E0%A4%A"), { sid: "abc", x: "%E0%A4%A" });
});

test("#10 金額:区切りのカンマで次の数字をくっつけない", () => {
  assert.deepEqual([...parseAmounts("予算は300万,2社で分担")], [3000000]);
  assert.deepEqual([...parseAmounts("1,200万円と、3,000円")].sort((a, b) => a - b), [3000, 12000000]);
  assert.equal(parseAmount("300万,2"), null, "読み方があいまいなものは数値にしない");
  assert.equal(parseAmount("1,234,567"), 1234567);
});

test("#12 共有アドレス(氏名が違う人どうし)は、確認してから統合する扱いにする", () => {
  const { s } = tmp();
  const c = s.insert("companies", { name: "A社", industry: "x", tier: "大手", website: "https://a.example" });
  s.insert("contacts", { companyId: c.id, name: "佐藤", email: "sales@a.example" });
  s.insert("contacts", { companyId: c.id, name: "鈴木", email: "sales@a.example" });
  const i = checkQuality(s).issues.find((x) => x.fix === "merge-contacts");
  assert.equal(i.needsReview, true);
  assert.equal(i.severity, "medium");
});

test("#13 ホールディングスと事業会社は、同じ会社とみなさない", () => {
  assert.notEqual(companyKey("ABC Holdings Inc."), companyKey("ABC Inc."));
  assert.equal(companyKey("ABC Inc."), companyKey("ABC Co., Ltd."));
});

test("#7 Stripe:古い通知や、終わった契約の通知でプランを戻さない。同時の二重通知も1回だけ処理", async () => {
  const db = new Database(":memory:");
  const t = db.createTenant({ name: "課金社", plan: "trial" });
  const mailer = { send: async () => ({ ok: true }) };
  const ev = (id, type, created, obj) => ({ id, type, created, data: { object: { customer: "cus_1", metadata: { tenant_id: t.id }, ...obj } } });
  await handleStripeEvent(ev("e1", "checkout.session.completed", 100, { mode: "subscription", client_reference_id: t.id, subscription: "sub_1" }), { db, mailer, appUrl: "" });
  await handleStripeEvent(ev("e2", "customer.subscription.deleted", 300, { id: "sub_1" }), { db, mailer, appUrl: "" });
  assert.equal(db.getTenant(t.id).plan, "canceled");
  // 解約より前に発生した「有効」の通知が、遅れて届いた
  await handleStripeEvent(ev("e3", "customer.subscription.updated", 200, { id: "sub_1", status: "active" }), { db, mailer, appUrl: "" });
  assert.equal(db.getTenant(t.id).plan, "canceled", "古い通知で復活させない");
  // 同じ通知が同時に2回
  const [r1, r2] = await Promise.all([
    handleStripeEvent(ev("e4", "invoice.paid", 400, {}), { db, mailer, appUrl: "" }),
    handleStripeEvent(ev("e4", "invoice.paid", 400, {}), { db, mailer, appUrl: "" }),
  ]);
  assert.equal([r1, r2].filter((r) => r.duplicate).length, 1);
});

// ---------- 画面からの操作 ----------
let server, base, db;
before(async () => {
  db = new Database(":memory:");
  server = createApp({ db, deps: { mailer: { enabled: true, send: async () => ({ ok: true }) } } }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
const client = () => {
  let cookie = "";
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...(cookie && { Cookie: cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const t = await res.text();
    let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: res.status, data };
  };
};
const PW = "Password123";
const owner = client();
const member = client();
let memberId;

test("準備", async () => {
  await owner("POST", "/api/auth/signup", { companyName: "点検社", name: "オーナー", email: "o@rv.example", password: PW });
  const inv = await owner("POST", "/api/admin/invites", { email: "m@rv.example" });
  await member("POST", "/api/auth/accept", { token: inv.data.link.split("accept=")[1], name: "メンバー", password: PW });
  memberId = (await owner("GET", "/api/members")).data.find((m) => m.name === "メンバー").id;
});

test("#1 画面からの統合でも、同じIDの重複指定で会社が消えない", async () => {
  const c = await owner("POST", "/api/companies", { name: "消えない株式会社" });
  const r = await owner("POST", "/api/crm/fix", { fix: "merge", ids: [c.data.id, c.data.id] });
  assert.equal(r.status, 400);
  assert.ok((await owner("GET", "/api/companies")).data.some((x) => x.id === c.data.id));
});

test("#4 停止したメンバーの商談も、担当者別の集計に残り、編集もできる", async () => {
  const co = (await owner("GET", "/api/companies")).data[0];
  const d = await member("POST", "/api/deals", { companyId: co.id, title: "停止前の案件", stage: "提案", amount: 5000000 });
  await owner("PUT", `/api/admin/users/${memberId}`, { disabled: true });
  const r = (await owner("GET", "/api/reports")).data;
  const sum = r.byOwner.reduce((a, o) => a + o.pipeline, 0);
  assert.equal(sum, r.summary.pipeline, "担当者別の合計が全体と一致する");
  assert.ok(r.byOwner.some((o) => o.name.includes("停止中") && o.pipeline === 5000000));
  const edit = await owner("PUT", `/api/deals/${d.data.id}`, { ownerId: memberId, amount: 6000000 });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  await owner("PUT", `/api/admin/users/${memberId}`, { disabled: false });
});

test("#2 2段階認証が必須のとき、/meetings や /members も止める", async () => {
  await owner("PUT", "/api/settings", { require2fa: true });
  const m2 = client();
  await m2("POST", "/api/auth/login", { email: "m@rv.example", password: PW });
  for (const url of ["/api/meetings", "/api/members", "/api/companies"]) {
    assert.equal((await m2("GET", url)).status, 403, url);
  }
  assert.equal((await m2("GET", "/api/meta")).status, 200);
  // オーナー自身も2段階認証が未設定なので、設定画面以外は止まる(正しい動き)。テストの後始末として直接戻す
  const t = db.listTenants().find((x) => x.name === "点検社");
  db.forTenant(t.id).setSettings({ require2fa: false });
});

test("#9 同じ分析を2回反映できない", async () => {
  const co = (await owner("GET", "/api/companies")).data[0];
  const d = await owner("POST", "/api/deals", { companyId: co.id, title: "反映テスト", stage: "リード" });
  const m = await owner("POST", "/api/meetings/analyze", { dealId: d.data.id, transcript: "顧客:検討します", date: "2026-11-01" });
  assert.equal((await owner("POST", `/api/meetings/${m.data.id}/apply`)).status, 200);
  assert.equal((await owner("POST", `/api/meetings/${m.data.id}/apply`)).status, 409);
});

test("#11 削除されたユーザーの再設定リンクは、500ではなく404", async () => {
  const users = (await owner("GET", "/api/admin/users")).data;
  const u = users.find((x) => x.email === "m@rv.example");
  const link = (await owner("POST", `/api/admin/users/${u.id}/reset-link`)).data.link;
  await owner("DELETE", `/api/admin/users/${u.id}`);
  const r = await client()("POST", "/api/auth/accept", { token: link.split("accept=")[1], password: "NewPassword9" });
  assert.equal(r.status, 404);
});
