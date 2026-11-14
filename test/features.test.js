import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../lib/db.js";
import { initSecrets } from "../lib/secrets.js";
import { createApp } from "../lib/app.js";
import { base32Encode, base32Decode, totp, verifyTotp } from "../lib/totp.js";
import { backupDatabase, latestBackup, ConcurrencyLimiter } from "../lib/ops.js";
import { backupIfDue } from "../lib/jobs.js";

process.env.APP_ENCRYPTION_KEY = "c".repeat(64);
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ALLOW_SIGNUP;
initSecrets({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "eigyou-")) });

// ---------- 2段階認証の計算(RFC 6238 の公式テスト値) ----------
test("TOTP:規格どおりのコードを計算する", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual(base32Decode(secret), Buffer.from("12345678901234567890"));
  assert.equal(totp(secret, 59 * 1000, 30, 8), "94287082");
  assert.equal(totp(secret, 1111111109 * 1000, 30, 8), "07081804");
  assert.ok(verifyTotp(secret, totp(secret, 1e12), 1e12));
  assert.ok(verifyTotp(secret, totp(secret, 1e12 - 30000), 1e12), "30秒前のコードも許容");
  assert.ok(!verifyTotp(secret, totp(secret, 1e12 - 90000), 1e12), "90秒前は不可");
  assert.ok(!verifyTotp(secret, "abc", 1e12));
});

test("AIの同時実行は1社あたり上限まで", () => {
  const l = new ConcurrencyLimiter(2);
  const r1 = l.acquire("t"), r2 = l.acquire("t");
  assert.ok(r1 && r2);
  assert.equal(l.acquire("t"), null);
  assert.ok(l.acquire("other"), "他社には影響しない");
  r1(); r1(); // 2回呼んでも1回分だけ解放
  assert.ok(l.acquire("t"));
  assert.equal(l.acquire("t"), null);
});

test("バックアップ:複製を作り、古いものは指定数だけ残す", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eigyou-bk-"));
  const file = path.join(dir, "src.db");
  const db = new Database(file);
  db.forTenant(db.createTenant({ name: "バックアップ社" }).id).insert("companies", { name: "残る会社" });
  const bdir = path.join(dir, "backups");
  const out = backupDatabase(db, bdir, 2);
  const copy = new Database(out);
  assert.equal(copy.listTenants()[0].name, "バックアップ社");
  // 24時間以内なら取り直さない
  assert.equal(backupIfDue({ db, backupDir: bdir }), null);
  assert.ok(backupIfDue({ db, backupDir: bdir, now: Date.now() + 25 * 3600e3 }));
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(bdir, `app-2000-01-0${i + 1}T00-00-00.db`), "");
  }
  backupDatabase(db, bdir, 2);
  assert.equal(latestBackup(bdir).count, 2);
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

function client() {
  let cookie = "";
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie && { Cookie: cookie }) },
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
let secret;

test("ヘルスチェックはDBまで確認する", async () => {
  const r = await fetch(base + "/healthz");
  assert.equal(r.status, 200);
});

test("2段階認証:設定 → パスワードだけではログインできない → コードでログイン", async () => {
  await owner("POST", "/api/auth/signup", { companyName: "安全社", name: "オーナー", email: "o@safe.example", password: PW });
  const setup = await owner("POST", "/api/me/2fa/setup");
  assert.equal(setup.status, 200);
  assert.match(setup.data.qrSvg, /<svg/);
  secret = setup.data.secret;
  assert.equal((await owner("POST", "/api/me/2fa/enable", { code: "000000" })).status, 400);
  const en = await owner("POST", "/api/me/2fa/enable", { code: totp(secret) });
  assert.equal(en.status, 200);
  assert.equal(en.data.recoveryCodes.length, 8);

  const c = client();
  const step1 = await c("POST", "/api/auth/login", { email: "o@safe.example", password: PW });
  assert.equal(step1.data.mfaRequired, true);
  assert.equal((await c("GET", "/api/companies")).status, 401, "コード確認前はログインしていない");
  assert.equal((await c("POST", "/api/auth/mfa", { mfaToken: step1.data.mfaToken, code: "123456" })).status, 401);
  const ok = await c("POST", "/api/auth/mfa", { mfaToken: step1.data.mfaToken, code: totp(secret) });
  assert.equal(ok.status, 200);
  assert.equal((await c("GET", "/api/companies")).status, 200);

  // 回復コードは1回だけ使える
  const rc = en.data.recoveryCodes[0];
  const s2 = await client()("POST", "/api/auth/login", { email: "o@safe.example", password: PW });
  const c2 = client();
  const s3 = await c2("POST", "/api/auth/login", { email: "o@safe.example", password: PW });
  assert.equal((await c2("POST", "/api/auth/mfa", { mfaToken: s3.data.mfaToken, code: rc })).status, 200);
  const c3 = client();
  const s4 = await c3("POST", "/api/auth/login", { email: "o@safe.example", password: PW });
  assert.equal((await c3("POST", "/api/auth/mfa", { mfaToken: s4.data.mfaToken, code: rc })).status, 401);
  assert.ok(s2.data.mfaRequired);
});

test("会社として2段階認証を必須にすると、未設定のメンバーは設定するまで使えない", async () => {
  assert.equal((await owner("PUT", "/api/settings", { require2fa: true })).status, 200);
  const inv = await owner("POST", "/api/admin/invites", { email: "m@safe.example" });
  const m = client();
  await m("POST", "/api/auth/accept", { token: inv.data.link.split("accept=")[1], name: "メンバー", password: PW });
  const r = await m("GET", "/api/companies");
  assert.equal(r.status, 403);
  assert.equal(r.data.code, "MFA_SETUP_REQUIRED");
  assert.equal((await m("GET", "/api/meta")).data.mustSetup2fa, true);
  const st = await m("POST", "/api/me/2fa/setup");
  await m("POST", "/api/me/2fa/enable", { code: totp(st.data.secret) });
  assert.equal((await m("GET", "/api/companies")).status, 200);
  // 必須の間は解除できない
  assert.equal((await m("POST", "/api/me/2fa/disable", { password: PW })).status, 400);
  await owner("PUT", "/api/settings", { require2fa: false });
});

test("パスワード変更:現在のパスワードが必要・ほかの端末はログアウト", async () => {
  assert.equal((await owner("PUT", "/api/me/password", { current: "wrong", next: "NewPassword1" })).status, 400);
  assert.equal((await owner("PUT", "/api/me/password", { current: PW, next: "NewPassword1" })).status, 200);
  assert.equal((await owner("GET", "/api/companies")).status, 200, "この端末はログインしたまま");
});

test("全体検索・会社詳細・AI文面の手直し", async () => {
  await owner("POST", "/api/seed");
  const s = await owner("GET", "/api/search?q=" + encodeURIComponent("みらい"));
  assert.ok(s.data.some((r) => r.type === "company"));
  const s2 = await owner("GET", "/api/search?q=" + encodeURIComponent("山田"));
  assert.ok(s2.data.some((r) => r.type === "contact" && r.sub.includes("みらい")));

  const co = s.data.find((r) => r.type === "company");
  const d = await owner("GET", `/api/company-detail/${co.id}`);
  assert.equal(d.status, 200);
  assert.ok(d.data.contacts.length >= 1 && d.data.deals.length >= 1);

  await owner("POST", `/api/account-plan/${co.id}`);
  const e = await owner("PUT", `/api/companies/${co.id}/plan-email`, { subject: "修正した件名", body: "修正した本文" });
  assert.equal(e.data.accountPlan.email.subject, "修正した件名");
  assert.equal(e.data.accountPlan.email.edited, true);

  const deal = d.data.deals[0];
  const m = await owner("POST", "/api/meetings/analyze", { dealId: deal.id, transcript: "1回目", date: "2026-11-01" });
  await owner("POST", "/api/meetings/analyze", { dealId: deal.id, transcript: "2回目", date: "2026-11-10" });
  const f = await owner("PUT", `/api/meetings/${m.data.id}/followup`, { subject: "お礼", body: "本文を直しました" });
  assert.equal(f.data.analysis.followupEmail.body, "本文を直しました");
  const d2 = await owner("GET", `/api/company-detail/${co.id}`);
  assert.equal(d2.data.meetings[0].date, "2026-11-10", "新しい順");
  assert.equal(d2.data.meetings[0].transcript, undefined, "一覧では議事録の全文を返さない");
});

test("ホームに初回ガイド(チェックリスト)が出る", async () => {
  const r = await owner("GET", "/api/dashboard");
  const keys = r.data.onboarding.map((o) => o.key);
  assert.deepEqual(keys, ["offering", "company", "research", "meeting", "member"]);
  assert.ok(r.data.onboarding.find((o) => o.key === "company").done);
});
