import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../lib/db.js";
import { initSecrets } from "../lib/secrets.js";
import { createApp } from "../lib/app.js";
import { localDate, localHour, isDateString } from "../lib/time.js";
import { checkQuality } from "../lib/crm.js";
import { sendDailyDigests } from "../lib/jobs.js";
import { totp } from "../lib/totp.js";

process.env.APP_ENCRYPTION_KEY = "d".repeat(64);
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ALLOW_SIGNUP;
delete process.env.APP_TIMEZONE;
initSecrets({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "eigyou-")) });

test("日付は日本時間で判定する(UTCでは前日でも、日本ではもう当日)", () => {
  const utc2330 = new Date("2026-11-13T23:30:00Z"); // 日本時間 11/14 08:30
  assert.equal(localDate(utc2330), "2026-11-14");
  assert.equal(localHour(utc2330), 8);
  assert.equal(localDate(utc2330, 1), "2026-11-15");
  assert.ok(isDateString("2026-11-14"));
  assert.ok(!isDateString("2026/11/14"));
  assert.ok(!isDateString("2026-13-40"));
});

test("期限切れの判定も日本時間:当日が期限の予定は、朝でも期限切れにしない", () => {
  const db = new Database(":memory:");
  const s = db.forTenant(db.createTenant({ name: "t" }).id);
  const c = s.insert("companies", { name: "A社", industry: "x", tier: "大手", website: "https://a.example" });
  s.insert("contacts", { companyId: c.id, name: "x", email: "x@a.example" });
  s.insert("deals", { companyId: c.id, title: "案件", stage: "提案", amount: 1, nextAction: "連絡", nextActionDate: "2026-11-14" });
  const jstMorning = new Date("2026-11-13T23:30:00Z");
  assert.ok(!checkQuality(s, jstMorning).issues.some((i) => i.type === "stale"));
  assert.ok(checkQuality(s, new Date("2026-11-14T15:30:00Z")).issues.some((i) => i.type === "stale"), "日本時間で翌日になれば期限切れ");
});

let server, base, db;
const sent = [];
before(async () => {
  db = new Database(":memory:");
  server = createApp({ db, deps: { mailer: { enabled: true, send: async (m) => { sent.push(m); return { ok: true }; } } } }).listen(0);
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
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const t = await res.text();
    let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: res.status, data };
  };
}
const PW = "Password123";
const owner = client();
const member = client();
let ownerId, memberId, companyId;

test("準備:オーナーとメンバー", async () => {
  await owner("POST", "/api/auth/signup", { companyName: "品質社", name: "オーナー", email: "o@q.example", password: PW });
  const inv = await owner("POST", "/api/admin/invites", { email: "m@q.example" });
  await member("POST", "/api/auth/accept", { token: inv.data.link.split("accept=")[1], name: "営業 花子", password: PW });
  const ms = (await owner("GET", "/api/members")).data;
  ownerId = ms.find((m) => m.name === "オーナー").id;
  memberId = ms.find((m) => m.name === "営業 花子").id;
  companyId = (await owner("POST", "/api/companies", { name: "テスト株式会社" })).data.id;
});

test("Origin が URL として読めない値でも、落ちずに拒否する", async () => {
  const r = await owner("POST", "/api/companies", { name: "x" }, { Origin: "null" });
  assert.equal(r.status, 403);
});

test("決まった選択肢・日付形式以外は登録できない", async () => {
  assert.equal((await owner("POST", "/api/deals", { companyId, title: "a", stage: "謎のステージ" })).status, 400);
  assert.equal((await owner("POST", "/api/deals", { companyId, title: "a", nextActionDate: "来週" })).status, 400);
  assert.equal((await owner("POST", "/api/companies", { name: "B社", tier: "超大手" })).status, 400);
  const ok = await owner("POST", "/api/deals", { companyId, title: "正常", stage: "提案", amount: "1,200,000円", probability: 150 });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.amount, 1200000, "カンマや円を取り除く");
  assert.equal(ok.data.probability, 100, "確度は100まで");
});

test("商談の担当者:既定は登録した本人。他社のユーザーは指定できない", async () => {
  const d = await member("POST", "/api/deals", { companyId, title: "花子の案件", stage: "ヒアリング" });
  assert.equal(d.data.ownerId, memberId);
  const moved = await owner("PUT", `/api/deals/${d.data.id}`, { ownerId });
  assert.equal(moved.data.ownerId, ownerId);
  assert.equal((await owner("PUT", `/api/deals/${d.data.id}`, { ownerId: "someone-else" })).status, 400);
  await owner("PUT", `/api/deals/${d.data.id}`, { ownerId: memberId });
});

test("CSV取り込み:想定外の値は安全な値に直し、重複した会社・担当者は作らない", async () => {
  const csv = [
    "会社名,案件名,ステージ,金額,期限",
    "(株)取込商事,案件1,ふしぎ,abc,2026/01/01",
    "株式会社取込商事,案件2,交渉,500000,2026-12-01",
  ].join("\n");
  const r = await owner("POST", "/api/import/deals", { csv });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.deals, 2);
  const deals = (await owner("GET", "/api/deals")).data;
  const d1 = deals.find((d) => d.title === "案件1");
  assert.equal(d1.stage, "リード");
  assert.equal(d1.amount, null);
  assert.equal(d1.nextActionDate, "");
  const d2 = deals.find((d) => d.title === "案件2");
  assert.equal(d2.stage, "交渉");
  assert.equal(d1.companyId, d2.companyId, "表記ゆれは同じ会社にまとめる");
  assert.equal((await owner("GET", "/api/companies")).data.filter((c) => c.name.includes("取込商事")).length, 1);

  const pcsv = "会社名,氏名,メール,役割\n取込商事,佐藤,s@t.example,社長\n取込商事,佐藤,,\n";
  const pr = await owner("POST", "/api/import/contacts", { csv: pcsv });
  assert.equal(pr.data.contacts, 1, "同じ人は1人だけ");
  const p = (await owner("GET", "/api/contacts")).data.find((x) => x.name === "佐藤");
  assert.equal(p.role, "不明");
  assert.equal(p.email, "s@t.example", "空欄で上書きしない");
});

test("大量の取り込みも短時間で終わる(2000件)", async () => {
  const rows = ["会社名,氏名,メール"];
  for (let i = 0; i < 2000; i++) rows.push(`大量株式会社${i % 400},担当${i},p${i}@bulk.example`);
  const t = Date.now();
  const r = await owner("POST", "/api/import/contacts", { csv: rows.join("\n") });
  assert.equal(r.data.contacts, 2000);
  assert.equal(r.data.companies, 0);
  assert.ok(Date.now() - t < 5000, `かかった時間 ${Date.now() - t}ms`);
});

test("ホーム:自分の担当だけに絞り込める", async () => {
  await member("PUT", `/api/deals/${(await member("GET", "/api/deals")).data.find((d) => d.title === "花子の案件").id}`, { nextAction: "見積送付", nextActionDate: "2020-01-01" });
  const mine = await member("GET", "/api/dashboard?mine=1");
  assert.deepEqual(mine.data.upcoming.map((u) => u.title), ["花子の案件"]);
  assert.equal(mine.data.my.overdue, 1);
});

test("「今日やること」メール:平日の朝8時以降に、担当者へ1日1回だけ", async () => {
  sent.length = 0;
  const args = { db, mailer: { send: async (m) => { sent.push(m); return { ok: true }; } }, appUrl: "https://app.example.com" };
  const fri0730 = new Date("2026-11-12T22:30:00Z"); // 日本時間 金曜 07:30
  const fri0830 = new Date("2026-11-12T23:30:00Z"); // 日本時間 金曜 08:30
  const sat0900 = new Date("2026-11-14T00:00:00Z"); // 日本時間 土曜 09:00
  assert.equal(await sendDailyDigests({ ...args, now: fri0730 }), 0, "8時前は送らない");
  assert.equal(await sendDailyDigests({ ...args, now: fri0830 }), 2);
  const toMember = sent.find((m) => m.to === "m@q.example");
  assert.match(toMember.text, /期限切れ/);
  assert.match(toMember.text, /花子の案件/);
  assert.ok(!toMember.text.includes("案件2"), "他人の担当分は含めない");
  assert.equal(await sendDailyDigests({ ...args, now: fri0830 }), 0, "同じ日に2回は送らない");
  assert.equal(await sendDailyDigests({ ...args, now: sat0900 }), 0, "土日は送らない");

  // 受け取らない設定にした人には送らない
  await member("PUT", "/api/me", { digestOptout: true });
  sent.length = 0;
  const mon = new Date("2026-11-15T23:30:00Z"); // 日本時間 月曜 08:30
  await sendDailyDigests({ ...args, now: mon });
  assert.ok(!sent.some((m) => m.to === "m@q.example"));
});

test("2段階認証:同じコードの使い回しはできない", async () => {
  const st = await owner("POST", "/api/me/2fa/setup");
  await owner("POST", "/api/me/2fa/enable", { code: totp(st.data.secret) });
  const code = totp(st.data.secret);
  const c1 = client();
  const s1 = await c1("POST", "/api/auth/login", { email: "o@q.example", password: PW });
  assert.equal((await c1("POST", "/api/auth/mfa", { mfaToken: s1.data.mfaToken, code })).status, 200);
  const c2 = client();
  const s2 = await c2("POST", "/api/auth/login", { email: "o@q.example", password: PW });
  const again = await c2("POST", "/api/auth/mfa", { mfaToken: s2.data.mfaToken, code });
  assert.equal(again.status, 401);
  assert.match(again.data.error, /すでに使われました/);
});
