import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../lib/db.js";
import { initSecrets } from "../lib/secrets.js";
import { createApp } from "../lib/app.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

process.env.APP_ENCRYPTION_KEY = "a".repeat(64);
delete process.env.ANTHROPIC_API_KEY;
initSecrets({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "eigyou-")) });

// ---- 外部CRMの代わりになる偽のHTTP応答 ----
const calls = [];
function fakeFetch(url, opts = {}) {
  calls.push({ url: String(url), method: opts.method ?? "GET", body: opts.body });
  const json = (data, status = 200) => Promise.resolve(new Response(data === null ? null : JSON.stringify(data), { status }));
  const u = new URL(url);
  if (u.host === "api.hubapi.com") {
    if (opts.method === "PATCH") return json({ id: "d1" });
    const obj = u.pathname.split("/").pop();
    const data = {
      companies: [{ id: "c1", properties: { name: "(株)ハブ商事", industry: "IT", domain: "hub.example", numberofemployees: "2000" } }],
      contacts: [{ id: "p1", properties: { lastname: "山本", firstname: "太郎", email: "y@hub.example" }, associations: { companies: { results: [{ id: "c1" }] } } }],
      deals: [{ id: "d1", properties: { dealname: "全社導入", amount: "5000000", dealstage: "presentationscheduled" }, associations: { companies: { results: [{ id: "c1" }] } } }],
    }[obj];
    return json({ results: data ?? [] });
  }
  if (u.host === "acme.my.salesforce.com") {
    if (u.pathname === "/services/oauth2/token") return json({ access_token: "tok", instance_url: "https://acme.my.salesforce.com" });
    if (opts.method === "PATCH") return json(null, 204);
    const q = u.searchParams.get("q") ?? "";
    if (q.includes("FROM Account")) return json({ done: true, records: [{ Id: "A1", Name: "セールス工業株式会社", NumberOfEmployees: 50 }] });
    if (q.includes("FROM Contact")) return json({ done: true, records: [{ Id: "C1", LastName: "田中", AccountId: "A1", Email: "t@sf.example" }] });
    if (q.includes("FROM Opportunity")) return json({ done: true, records: [{ Id: "O1", Name: "PoC", StageName: "Qualification", AccountId: "A1", Amount: 100 }] });
    return json({});
  }
  return json({ error: "unknown" }, 404);
}

let server, base;
before(async () => {
  const db = new Database(":memory:");
  server = createApp({ db, deps: { fetch: fakeFetch } }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

// Cookie を保持する簡易クライアント
function client() {
  let cookie = "";
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie && { Cookie: cookie }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}

const owner = client();
const PW = "Password123";

test("初回登録で社内利用プランのオーナーになる", async () => {
  const r = await owner("POST", "/api/auth/signup", { companyName: "自社", name: "オーナー", email: "owner@a.example", password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const meta = await owner("GET", "/api/meta");
  assert.equal(meta.data.tenant.plan, "internal");
  assert.equal(meta.data.user.role, "owner");
});

test("2社目以降は ALLOW_SIGNUP=false なら登録できない", async () => {
  const r = await client()("POST", "/api/auth/signup", { companyName: "他社", name: "x", email: "x@b.example", password: PW, agree: true });
  assert.equal(r.status, 403);
});

test("未ログインではデータを取得できない", async () => {
  const r = await client()("GET", "/api/companies");
  assert.equal(r.status, 401);
});

test("弱いパスワード・誤ったパスワードは拒否", async () => {
  const c = client();
  assert.equal((await c("POST", "/api/auth/login", { email: "owner@a.example", password: "wrongpass1" })).status, 401);
  assert.equal((await c("POST", "/api/auth/login", { email: "owner@a.example", password: PW })).status, 200);
});

test("JSON以外・別オリジンからの書き込みは拒否(CSRF対策)", async () => {
  const r = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "email=a" });
  assert.equal(r.status, 415);
  const r2 = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
  assert.equal(r2.status, 403);
});

const member = client();
test("招待したメンバーは管理機能を使えない", async () => {
  const inv = await owner("POST", "/api/admin/invites", { email: "m@a.example", role: "member" });
  assert.equal(inv.status, 200);
  const token = inv.data.link.split("accept=")[1];
  const acc = await member("POST", "/api/auth/accept", { token, name: "メンバー", password: PW });
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  assert.equal((await member("GET", "/api/admin/users")).status, 403);
  assert.equal((await member("GET", "/api/integrations")).status, 403);
  // 同じ招待リンクは2回使えない
  assert.equal((await client()("POST", "/api/auth/accept", { token, name: "x", password: PW })).status, 404);
});

test("同じテナントのメンバーには共有される(他社との分離は tenant.test.js で確認)", async () => {
  const c = await owner("POST", "/api/companies", { name: "共有の顧客株式会社", tier: "大手" });
  assert.equal(c.status, 200);
  assert.ok((await member("GET", "/api/companies")).data.some((x) => x.id === c.data.id));
});

test("CSV出力は数式インジェクションを無害化する", async () => {
  await owner("POST", "/api/companies", { name: "=HYPERLINK(\"x\")社" });
  const r = await owner("GET", "/api/export/companies");
  assert.match(r.data, /'=HYPERLINK/);
});

test("HubSpot:接続→取り込み→商談分析をCRMに反映すると書き戻される", async () => {
  const save = await owner("PUT", "/api/integrations/hubspot", { config: { accessToken: "pat-secret-token" } });
  assert.equal(save.status, 200, JSON.stringify(save.data));
  const hs = save.data.find((x) => x.provider === "hubspot");
  assert.equal(hs.connected, true);
  assert.ok(!JSON.stringify(save.data).includes("pat-secret-token"), "トークンは画面に返さない");

  const sync = await owner("POST", "/api/integrations/hubspot/sync");
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  assert.equal(sync.data.companies.added, 1);
  const companies = (await owner("GET", "/api/companies")).data;
  const hub = companies.find((x) => x.external?.id === "c1");
  assert.equal(hub.name, "株式会社ハブ商事");
  assert.equal(hub.tier, "大手");
  const deal = (await owner("GET", "/api/deals")).data.find((d) => d.external?.id === "d1");
  assert.equal(deal.stage, "提案");
  assert.equal(deal.companyId, hub.id);

  // 2回目の同期では重複せず「更新」になる
  const again = await owner("POST", "/api/integrations/hubspot/sync");
  assert.equal(again.data.companies.added, 0);
  assert.equal(again.data.deals.updated, 1);

  const m = await owner("POST", "/api/meetings/analyze", { dealId: deal.id, transcript: "テスト議事録", date: "2026-11-09" });
  assert.equal(m.status, 200);
  calls.length = 0;
  const ap = await owner("POST", `/api/meetings/${m.data.id}/apply`);
  assert.equal(ap.status, 200);
  assert.equal(ap.data.pushed?.ok, true, JSON.stringify(ap.data.pushed));
  const patch = calls.find((c) => c.method === "PATCH");
  assert.match(patch.url, /\/crm\/v3\/objects\/deals\/d1$/);
  assert.equal(JSON.parse(patch.body).properties.dealstage, "qualifiedtobuy"); // デモ結果のステージ「ヒアリング」
});

test("Salesforce:URLは salesforce.com ドメインのみ・取り込みできる", async () => {
  const bad = await owner("PUT", "/api/integrations/salesforce", { config: { instanceUrl: "https://evil.example", clientId: "id", clientSecret: "sec" } });
  assert.equal(bad.status, 400);
  const ok = await owner("PUT", "/api/integrations/salesforce", { config: { instanceUrl: "https://acme.my.salesforce.com", clientId: "id", clientSecret: "sec" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const sync = await owner("POST", "/api/integrations/salesforce/sync");
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  const deal = (await owner("GET", "/api/deals")).data.find((d) => d.external?.source === "salesforce");
  assert.equal(deal.stage, "ヒアリング");
  calls.length = 0;
  const push = await owner("POST", `/api/integrations/push/${deal.id}`);
  assert.equal(push.status, 200, JSON.stringify(push.data));
  assert.equal(push.data.sent.StageName, "Qualification");
});

test("監査ログに操作が記録される", async () => {
  const logs = (await owner("GET", "/api/admin/audit")).data;
  const actions = logs.map((l) => l.action);
  for (const a of ["ログイン", "メンバー招待", "外部CRM連携を設定", "HubSpotから取り込み"]) assert.ok(actions.includes(a), a);
});

test("メンバーを無効化するとログインできなくなる", async () => {
  const users = (await owner("GET", "/api/admin/users")).data;
  const m = users.find((u) => u.email === "m@a.example");
  assert.equal((await owner("PUT", `/api/admin/users/${m.id}`, { disabled: true })).status, 200);
  assert.equal((await member("GET", "/api/companies")).status, 401);
});
