import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../lib/db.js";
import { initSecrets } from "../lib/secrets.js";
import { createApp } from "../lib/app.js";
import { verifyWebhook, signWebhook } from "../lib/billing.js";
import { sendTrialReminders } from "../lib/jobs.js";

const SECRET = "whsec_test_secret";
Object.assign(process.env, {
  APP_ENCRYPTION_KEY: "b".repeat(64),
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_PRICE_STANDARD: "price_standard",
  STRIPE_WEBHOOK_SECRET: SECRET,
  ALLOW_SIGNUP: "true",
  APP_URL: "https://app.example.com",
});
delete process.env.ANTHROPIC_API_KEY;
initSecrets({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "eigyou-")) });

// ---- 偽の Stripe・偽のメール ----
const stripeCalls = [];
const sent = [];
function fakeFetch(url, opts = {}) {
  const u = new URL(url);
  stripeCalls.push({ path: u.pathname, method: opts.method, body: String(opts.body ?? ""), headers: opts.headers });
  const json = (d) => Promise.resolve(new Response(JSON.stringify(d), { status: 200 }));
  if (u.pathname === "/v1/customers") return json({ id: "cus_123" });
  if (u.pathname === "/v1/checkout/sessions") return json({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
  if (u.pathname === "/v1/billing_portal/sessions") return json({ url: "https://billing.stripe.com/p/session_1" });
  if (u.pathname.startsWith("/v1/subscriptions/")) return json({ id: "sub_1", status: "canceled" });
  return Promise.resolve(new Response("{}", { status: 404 }));
}
const mailer = { enabled: true, send: async (m) => { sent.push(m); return { ok: true }; } };

let server, base, db;
before(async () => {
  db = new Database(":memory:");
  server = createApp({ db, deps: { fetch: fakeFetch, mailer } }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

function client() {
  let cookie = "";
  return async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie && { Cookie: cookie }), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const t = await res.text();
    let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: res.status, data };
  };
}
const webhook = (event) => {
  const raw = JSON.stringify(event);
  return fetch(base + "/api/billing/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": signWebhook(raw, SECRET) }, body: raw });
};

const PW = "Password123";
const internalOwner = client();
const buyer = client();
let tenantId;

test("署名の検証:正しい署名だけを受け付ける", () => {
  const raw = '{"id":"evt_1"}';
  assert.equal(verifyWebhook(raw, signWebhook(raw, SECRET), SECRET).id, "evt_1");
  assert.throws(() => verifyWebhook(raw.replace("1", "2"), signWebhook(raw, SECRET), SECRET), /一致しません/);
  assert.throws(() => verifyWebhook(raw, signWebhook(raw, "other"), SECRET), /一致しません/);
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.throws(() => verifyWebhook(raw, signWebhook(raw, SECRET, old), SECRET), /有効期限/);
});

test("登録すると歓迎メールが届く(2社目はトライアル)", async () => {
  await internalOwner("POST", "/api/auth/signup", { companyName: "運営会社", name: "運営", email: "ops@op.example", password: PW });
  sent.length = 0;
  const r = await buyer("POST", "/api/auth/signup", { companyName: "購入社", name: "購入 太郎", email: "buyer@buy.example", password: PW, agree: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const meta = (await buyer("GET", "/api/meta")).data;
  assert.equal(meta.tenant.plan, "trial");
  tenantId = meta.tenant.id;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "buyer@buy.example");
  assert.match(sent[0].subject, /ご登録ありがとうございます/);
  assert.match(sent[0].text, /https:\/\/app\.example\.com/);
});

test("社内利用プランは決済できない", async () => {
  const r = await internalOwner("POST", "/api/billing/checkout", { plan: "standard" });
  assert.equal(r.status, 400);
});

test("申し込み:Stripe の決済ページURLが返る", async () => {
  stripeCalls.length = 0;
  const r = await buyer("POST", "/api/billing/checkout", { plan: "standard" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.url, /^https:\/\/checkout\.stripe\.com/);
  const checkout = stripeCalls.find((c) => c.path === "/v1/checkout/sessions");
  const form = new URLSearchParams(checkout.body);
  assert.equal(form.get("line_items[0][price]"), "price_standard");
  assert.equal(form.get("client_reference_id"), tenantId);
  assert.equal(form.get("mode"), "subscription");
  assert.equal(checkout.headers.Authorization, "Bearer sk_test_dummy");
  assert.equal(db.getTenant(tenantId).stripe_customer_id, "cus_123");
});

test("偽の通知(署名なし・不正署名)は拒否", async () => {
  const raw = JSON.stringify({ id: "evt_fake", type: "checkout.session.completed", data: { object: { client_reference_id: tenantId, mode: "subscription" } } });
  const r1 = await fetch(base + "/api/billing/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
  assert.equal(r1.status, 400);
  const r2 = await fetch(base + "/api/billing/webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": signWebhook(raw, "wrong") }, body: raw });
  assert.equal(r2.status, 400);
  assert.equal(db.getTenant(tenantId).plan, "trial");
});

test("支払い完了の通知でスタンダードになり、お礼メールが届く(二重通知は無視)", async () => {
  sent.length = 0;
  const event = { id: "evt_paid", type: "checkout.session.completed", data: { object: { mode: "subscription", client_reference_id: tenantId, customer: "cus_123", subscription: "sub_1", metadata: { tenant_id: tenantId } } } };
  assert.equal((await webhook(event)).status, 200);
  const t = db.getTenant(tenantId);
  assert.equal(t.plan, "standard");
  assert.equal(t.billing_status, "active");
  assert.equal(t.trial_ends_at, null);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /お申し込みありがとうございます/);
  const again = await (await webhook(event)).json();
  assert.equal(again.duplicate, true);
  assert.equal(sent.length, 1);
});

test("お支払い管理画面(Stripe)のURLが返る。メンバーは使えない", async () => {
  const r = await buyer("POST", "/api/billing/portal");
  assert.equal(r.status, 200);
  assert.match(r.data.url, /billing\.stripe\.com/);
});

test("支払い失敗で警告メール、解約で契約終了になりAIが止まる", async () => {
  sent.length = 0;
  await webhook({ id: "evt_fail", type: "invoice.payment_failed", data: { object: { id: "in_1", customer: "cus_123" } } });
  assert.equal(db.getTenant(tenantId).billing_status, "past_due");
  assert.match(sent[0].subject, /お支払いが完了しませんでした/);

  await webhook({ id: "evt_del", type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_123", metadata: { tenant_id: tenantId } } } });
  assert.equal(db.getTenant(tenantId).plan, "canceled");
  const c = await buyer("POST", "/api/companies", { name: "テスト株式会社" });
  const r = await buyer("POST", `/api/research/${c.data.id}`);
  assert.equal(r.status, 402);
  // データの閲覧はできる
  assert.equal((await buyer("GET", "/api/companies")).status, 200);
});

test("招待するとメールが届き、リンクから参加できる", async () => {
  sent.length = 0;
  const r = await internalOwner("POST", "/api/admin/invites", { email: "new@op.example", role: "member" });
  assert.equal(r.data.emailed, true);
  assert.equal(sent[0].to, "new@op.example");
  const url = sent[0].text.match(/https:\/\/app\.example\.com\/#accept=\S+/)[0];
  assert.ok(sent[0].html.includes("招待を受けて参加する"));
  const token = url.split("accept=")[1];
  assert.equal((await client()("POST", "/api/auth/accept", { token, name: "新人", password: PW })).status, 200);
});

test("パスワードを忘れた:登録済みならメールが届き、未登録でも同じ返事", async () => {
  sent.length = 0;
  const c = client();
  const r1 = await c("POST", "/api/auth/forgot", { email: "ops@op.example" });
  const r2 = await c("POST", "/api/auth/forgot", { email: "nobody@op.example" });
  assert.deepEqual(r1.data, r2.data);
  assert.equal(sent.length, 1);
  const token = sent[0].text.match(/#accept=(\S+)/)[1];
  assert.equal((await c("POST", "/api/auth/accept", { token, password: "NewPassword9" })).status, 200);
  assert.equal((await client()("POST", "/api/auth/login", { email: "ops@op.example", password: "NewPassword9" })).status, 200);
  assert.equal((await client()("POST", "/api/auth/login", { email: "ops@op.example", password: PW })).status, 401);
});

test("トライアル終了3日前のお知らせは1回だけ送る", async () => {
  const t = db.createTenant({ name: "試用中社", plan: "trial", trialDays: 2 });
  db.createUser({ tenantId: t.id, email: "trial@t.example", name: "試用", passwordHash: "x", role: "owner" });
  sent.length = 0;
  assert.equal(await sendTrialReminders({ db, mailer, appUrl: "https://app.example.com" }), 1);
  assert.equal(sent[0].to, "trial@t.example");
  assert.equal(await sendTrialReminders({ db, mailer, appUrl: "https://app.example.com" }), 0);
});

test("解約(全データ削除)時は Stripe の契約も止める", async () => {
  const owner = client();
  await owner("POST", "/api/auth/signup", { companyName: "解約社", name: "解約", email: "bye@bye.example", password: PW, agree: true });
  const id = (await owner("GET", "/api/meta")).data.tenant.id;
  db.updateTenant(id, { stripe_subscription_id: "sub_bye", billing_status: "active", plan: "standard" });
  stripeCalls.length = 0;
  const r = await owner("DELETE", "/api/admin/tenant", { confirmName: "解約社" });
  assert.equal(r.status, 200);
  assert.ok(stripeCalls.some((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_bye"));
  assert.equal(db.getTenant(id), null);
});
