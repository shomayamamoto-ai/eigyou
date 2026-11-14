// アプリ本体(Webサーバーの処理)。テストから呼べるよう、起動処理とは分けています。
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ai from "./ai.js";
import {
  STAGES, STATUSES, TIERS, ROLES,
  checkQuality, mergeCompanies, normalizeCompanyName, companyKey,
  priorityScore, parseCsv, toCsv,
} from "./crm.js";
import { seed } from "./seed.js";
import {
  hashPassword, verifyPassword, checkPasswordPolicy, isEmail, newToken, hashToken,
  createSession, findSession, destroySession, destroyUserSessions,
  cookieOptions, parseCookies, RateLimiter, ROLE_LEVEL, ROLE_LABEL,
} from "./auth.js";
import { PLANS, SELLABLE, planOf, trialExpired, aiBlockedReason, userLimitReached } from "./plans.js";
import { createMailer } from "./mailer.js";
import QRCode from "qrcode";
import { encrypt, decrypt } from "./secrets.js";
import { newTotpSecret, verifyTotp, otpauthUrl, newRecoveryCodes } from "./totp.js";
import { alert, requestLogger, ConcurrencyLimiter } from "./ops.js";
import { emails } from "./emails.js";
import { billingEnabled, createStripe, priceIdFor, verifyWebhook, handleStripeEvent } from "./billing.js";
import {
  PROVIDERS, describeIntegrations, saveIntegration, deleteIntegration,
  clientFor, importFromProvider, pushDeal, getIntegration,
} from "./integrations/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const COLS = ["companies", "contacts", "deals", "meetings"];

export function createApp({ db, deps = {} } = {}) {
  const app = express();
  const mailer = deps.mailer ?? createMailer();
  const stripe = () => createStripe({ fetch: deps.fetch });
  // メールのリンクや決済後の戻り先に使う、このサービスのURL
  const appUrl = (req) => (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
  const APP_NAME = process.env.APP_NAME || "営業AIプラットフォーム";
  const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP === "true";
  const SECURE_COOKIE = process.env.NODE_ENV === "production";
  const loginLimiter = new RateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
  const signupLimiter = new RateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
  if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);
  app.disable("x-powered-by");

  // ---------- セキュリティ用のHTTPヘッダー ----------
  app.use((req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (SECURE_COOKIE) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });

  // 死活監視用。データベースまで読めるかを確認する
  app.get("/healthz", (req, res) => {
    try {
      db.get("SELECT 1 AS ok");
      res.json({ ok: true });
    } catch (e) {
      alert("ヘルスチェック失敗", e.message);
      res.status(503).json({ ok: false });
    }
  });
  app.use(requestLogger());
  const aiLimiter = new ConcurrencyLimiter();

  // ---------- 決済サービス(Stripe)からの通知 ----------
  // 署名の検証に「受け取ったままの本文」が必要なため、JSONとして読む前に処理する
  app.post("/api/billing/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    let event;
    try {
      event = verifyWebhook(req.body.toString("utf8"), req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (e) {
      return res.status(e.status ?? 400).json({ error: e.message });
    }
    try {
      const appBase = (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
      res.json(await handleStripeEvent(event, { db, mailer, appUrl: appBase }));
    } catch (e) {
      console.error("Webhook の処理に失敗:", e);
      res.status(500).json({ error: "処理に失敗しました" }); // Stripe が自動で再送する
    }
  });
  app.get(["/about", "/lp"], (req, res) => res.sendFile(path.join(here, "..", "public", "lp.html")));
  app.use(express.static(path.join(here, "..", "public")));
  app.use(express.json({ limit: "2mb" }));

  // ---------- CSRF対策:書き込み系はJSON形式・同一オリジンからのみ受け付ける ----------
  app.use("/api", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (!req.is("application/json")) return res.status(415).json({ error: "不正なリクエストです" });
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return res.status(403).json({ error: "不正なリクエスト元です" });
    next();
  });

  // ---------- ログイン状態の読み込み ----------
  app.use("/api", (req, res, next) => {
    const token = parseCookies(req.headers.cookie).sid;
    const user = findSession(db, token);
    if (user) {
      req.user = user;
      req.tenant = db.getTenant(user.tenant_id);
      req.store = db.forTenant(user.tenant_id);
    }
    next();
  });

  const h = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (!e.status || e.status >= 500) {
        console.error(e);
        alert("サーバーエラー", `${req.method} ${req.path}\n${e.stack ?? e.message}`);
      }
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
      const msg =
        e.status === 401 && e.name?.includes("Authentication") ? "AIのAPIキーが正しくありません(運営者にお問い合わせください)"
        : e.status === 429 ? "AIの利用が混み合っています。少し待って再実行してください"
        : status === 500 ? "サーバーでエラーが発生しました。時間をおいて再度お試しください"
        : e.message;
      res.status(status).json({ error: msg });
    }
  };
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const ip = (req) => req.ip || "";
  const audit = (req, action, detail) => db.audit(req.tenant.id, req.user, action, detail, ip(req));

  const requireRole = (role) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "ログインしてください" });
    if (ROLE_LEVEL[req.user.role] < ROLE_LEVEL[role]) return res.status(403).json({ error: "この操作の権限がありません" });
    next();
  };
  const authed = requireRole("member");
  const adminOnly = requireRole("admin");
  const ownerOnly = requireRole("owner");

  const setSessionCookie = (res, token) => res.setHeader("Set-Cookie", `sid=${token}; ${cookieOptions(SECURE_COOKIE)}`);
  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, roleLabel: ROLE_LABEL[u.role], totpEnabled: Boolean(u.totp_enabled) });

  // =====================================================
  // 認証(ログイン・新規登録・招待の受諾)
  // =====================================================
  const isFirstRun = () => db.get("SELECT COUNT(*) AS n FROM tenants").n === 0;

  app.get("/api/public-config", (req, res) => {
    res.json({
      appName: APP_NAME,
      allowSignup: ALLOW_SIGNUP || isFirstRun(),
      firstRun: isFirstRun(),
      // サービス紹介ページの料金表に使う(設定と常に一致させる)
      plans: SELLABLE.map((k) => ({ key: k, ...PLANS[k] })),
      contactEmail: process.env.SALES_CONTACT_EMAIL || "",
    });
  });

  app.post("/api/auth/signup", h(async (req, res) => {
    const firstRun = isFirstRun();
    if (!ALLOW_SIGNUP && !firstRun) throw fail(403, "新規登録は受け付けていません。管理者から招待を受けてください");
    if (!signupLimiter.hit(ip(req))) throw fail(429, "登録の試行回数が多すぎます。時間をおいて再度お試しください");
    const { companyName, name, email, password, agree } = req.body;
    if (!String(companyName ?? "").trim() || !String(name ?? "").trim()) throw fail(400, "会社名とお名前を入力してください");
    if (!isEmail(email)) throw fail(400, "メールアドレスの形式が正しくありません");
    const pwErr = checkPasswordPolicy(password);
    if (pwErr) throw fail(400, pwErr);
    if (!firstRun && !agree) throw fail(400, "利用規約とプライバシーポリシーへの同意が必要です");
    if (db.getUserByEmail(email)) throw fail(409, "このメールアドレスはすでに登録されています");
    const { tenant, user } = db.tx(() => {
      // 最初の1社は「社内利用」プラン、それ以降の申し込みは無料トライアル
      const tenant = db.createTenant({ name: String(companyName).trim(), plan: firstRun ? "internal" : "trial" });
      const user = db.createUser({ tenantId: tenant.id, email, name: String(name).trim(), passwordHash: hashPassword(password), role: "owner" });
      return { tenant, user };
    });
    db.audit(tenant.id, user, "テナント作成", `${tenant.name}(${PLANS[tenant.plan].label})`, ip(req));
    setSessionCookie(res, createSession(db, user.id).token);
    await mailer.send({ to: user.email, ...emails.welcome({ name: user.name, tenantName: tenant.name, url: appUrl(req), trialEndsAt: tenant.trial_ends_at }) });
    res.json({ user: publicUser(user) });
  }));

  app.post("/api/auth/login", h((req, res) => {
    const { email, password } = req.body;
    const key = `${ip(req)}|${String(email).toLowerCase()}`;
    if (!loginLimiter.hit(key)) throw fail(429, "ログインの試行回数が多すぎます。15分ほどおいて再度お試しください");
    const user = isEmail(email) ? db.getUserByEmail(email) : null;
    // 「メールが存在しない」と「パスワード違い」を区別しない(アカウントの有無を推測させない)
    if (!user || user.disabled || !verifyPassword(String(password ?? ""), user.password_hash)) {
      if (user) db.audit(user.tenant_id, user, "ログイン失敗", "", ip(req));
      throw fail(401, "メールアドレスまたはパスワードが正しくありません");
    }
    loginLimiter.reset(key);
    if (user.totp_enabled) {
      // 2段階認証:パスワードが正しくても、コードの確認が済むまでログインさせない
      const mfaToken = newToken();
      mfaPending.set(hashToken(mfaToken), { userId: user.id, expires: Date.now() + 5 * 60 * 1000, tries: 0 });
      return res.json({ mfaRequired: true, mfaToken });
    }
    completeLogin(req, res, user);
  }));

  const mfaPending = new Map();
  function completeLogin(req, res, user, how = "") {
    db.updateUser(user.id, { last_login_at: new Date().toISOString() });
    db.audit(user.tenant_id, user, "ログイン", how, ip(req));
    setSessionCookie(res, createSession(db, user.id).token);
    res.json({ user: publicUser(user) });
  }

  // 2段階認証のコード(または回復コード)を確認してログインを完了する
  app.post("/api/auth/mfa", h((req, res) => {
    const key = hashToken(String(req.body.mfaToken ?? ""));
    const p = mfaPending.get(key);
    if (!p || p.expires < Date.now()) {
      mfaPending.delete(key);
      throw fail(401, "時間切れです。もう一度ログインしてください");
    }
    if (++p.tries > 5) {
      mfaPending.delete(key);
      throw fail(429, "試行回数が多すぎます。もう一度ログインしてください");
    }
    const user = db.getUser(p.userId);
    if (!user || user.disabled) throw fail(401, "ログインできません");
    const code = String(req.body.code ?? "").trim();
    let how = "2段階認証";
    if (!verifyTotp(decrypt(user.totp_secret_enc).secret, code)) {
      // 回復コード(使い切り)
      const codes = JSON.parse(user.recovery_codes || "[]");
      const h = hashToken(code.toUpperCase());
      if (!codes.includes(h)) throw fail(401, "コードが正しくありません");
      db.updateUser(user.id, { recovery_codes: JSON.stringify(codes.filter((c) => c !== h)) });
      how = `回復コード使用(残り${codes.length - 1}個)`;
    }
    mfaPending.delete(key);
    if (mfaPending.size > 5000) mfaPending.clear();
    completeLogin(req, res, user, how);
  }));

  app.post("/api/auth/logout", (req, res) => {
    destroySession(db, parseCookies(req.headers.cookie).sid);
    res.setHeader("Set-Cookie", `sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE_COOKIE ? "; Secure" : ""}`);
    res.json({ ok: true });
  });

  // パスワードを忘れた場合:登録メールアドレスに再設定リンクを送る
  const forgotLimiter = new RateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
  app.post("/api/auth/forgot", h(async (req, res) => {
    const email = String(req.body.email ?? "").trim();
    if (!isEmail(email)) throw fail(400, "メールアドレスの形式が正しくありません");
    if (!forgotLimiter.hit(`${ip(req)}|${email.toLowerCase()}`)) throw fail(429, "試行回数が多すぎます。時間をおいて再度お試しください");
    const user = db.getUserByEmail(email);
    if (user && !user.disabled) {
      const link = issueReset(user, 1);
      await mailer.send({ to: user.email, ...emails.passwordReset({ name: user.name, url: `${appUrl(req)}${link}`, hours: 1 }) });
      db.audit(user.tenant_id, user, "パスワード再設定メール送信", "", ip(req));
    }
    // 登録の有無がわからないよう、常に同じ返事をする
    res.json({ ok: true });
  }));

  function issueReset(user, hours) {
    const token = newToken();
    db.run(
      "INSERT INTO invites (token_hash, tenant_id, kind, user_id, expires_at, created_at) VALUES (?, ?, 'reset', ?, ?, ?)",
      hashToken(token), user.tenant_id, user.id, new Date(Date.now() + hours * 3600e3).toISOString(), new Date().toISOString(),
    );
    return `/#accept=${token}`;
  }

  // 招待リンク・パスワード再設定リンクの内容を確認
  app.get("/api/auth/invite/:token", h((req, res) => {
    const inv = db.get("SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?", hashToken(req.params.token), new Date().toISOString());
    if (!inv) throw fail(404, "リンクが無効か、有効期限が切れています。管理者に再発行を依頼してください");
    const tenant = db.getTenant(inv.tenant_id);
    const user = inv.user_id ? db.getUser(inv.user_id) : null;
    res.json({ kind: inv.kind, email: inv.email ?? user?.email, tenantName: tenant.name, name: user?.name ?? "" });
  }));

  app.post("/api/auth/accept", h((req, res) => {
    const { token, name, password } = req.body;
    const inv = db.get("SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?", hashToken(token), new Date().toISOString());
    if (!inv) throw fail(404, "リンクが無効か、有効期限が切れています");
    const pwErr = checkPasswordPolicy(password);
    if (pwErr) throw fail(400, pwErr);
    let user;
    if (inv.kind === "invite") {
      if (!String(name ?? "").trim()) throw fail(400, "お名前を入力してください");
      if (db.getUserByEmail(inv.email)) throw fail(409, "このメールアドレスはすでに登録されています");
      const tenant = db.getTenant(inv.tenant_id);
      if (userLimitReached(db, tenant)) throw fail(403, "ご契約プランのユーザー数の上限に達しています。管理者にお問い合わせください");
      user = db.createUser({ tenantId: inv.tenant_id, email: inv.email, name: String(name).trim(), passwordHash: hashPassword(password), role: inv.role });
      db.audit(inv.tenant_id, user, "招待を受諾", user.email, ip(req));
    } else {
      user = db.updateUser(inv.user_id, { password_hash: hashPassword(password) });
      destroyUserSessions(db, user.id);
      db.audit(inv.tenant_id, user, "パスワード再設定", "", ip(req));
    }
    db.run("UPDATE invites SET used_at = ? WHERE token_hash = ?", new Date().toISOString(), inv.token_hash);
    setSessionCookie(res, createSession(db, user.id).token);
    res.json({ user: publicUser(user) });
  }));

  // =====================================================
  // ここから下はログイン必須
  // =====================================================
  app.use("/api", (req, res, next) => (req.user ? next() : res.status(401).json({ error: "ログインしてください" })));

  // 会社の方針で2段階認証が必須なのに未設定なら、設定画面以外は使わせない
  const mustSetup2fa = (req) => Boolean(req.store.getSettings().require2fa) && !req.user.totp_enabled;
  app.use("/api", (req, res, next) => {
    if (!mustSetup2fa(req)) return next();
    if (req.path === "/meta" || req.path.startsWith("/me")) return next();
    res.status(403).json({ error: "2段階認証の設定が必要です", code: "MFA_SETUP_REQUIRED" });
  });

  // ---------- 自分のアカウント ----------
  app.put("/api/me", h((req, res) => {
    const name = String(req.body.name ?? "").trim();
    if (!name || name.length > 100) throw fail(400, "お名前を入力してください");
    db.updateUser(req.user.id, { name });
    res.json({ ok: true });
  }));

  app.put("/api/me/password", h((req, res) => {
    const { current, next } = req.body;
    if (!verifyPassword(String(current ?? ""), req.user.password_hash)) throw fail(400, "現在のパスワードが正しくありません");
    const err = checkPasswordPolicy(next);
    if (err) throw fail(400, err);
    db.updateUser(req.user.id, { password_hash: hashPassword(next) });
    // ほかの端末のログインは解除し、この端末だけ新しいログインにする
    destroyUserSessions(db, req.user.id);
    setSessionCookie(res, createSession(db, req.user.id).token);
    audit(req, "パスワード変更");
    res.json({ ok: true });
  }));

  app.post("/api/me/2fa/setup", h(async (req, res) => {
    if (req.user.totp_enabled) throw fail(400, "すでに2段階認証は有効です");
    const secret = newTotpSecret();
    db.updateUser(req.user.id, { totp_secret_enc: encrypt({ secret }) });
    const url = otpauthUrl({ secret, account: req.user.email, issuer: APP_NAME });
    const qrSvg = await QRCode.toString(url, { type: "svg", margin: 1, width: 200 });
    res.json({ secret, qrSvg });
  }));

  app.post("/api/me/2fa/enable", h((req, res) => {
    const u = db.getUser(req.user.id);
    if (u.totp_enabled) throw fail(400, "すでに2段階認証は有効です");
    if (!u.totp_secret_enc) throw fail(400, "先に設定を開始してください");
    if (!verifyTotp(decrypt(u.totp_secret_enc).secret, req.body.code)) throw fail(400, "コードが正しくありません。アプリに表示されている最新の6桁を入力してください");
    const codes = newRecoveryCodes();
    db.updateUser(u.id, { totp_enabled: true, recovery_codes: JSON.stringify(codes.map((c) => hashToken(c))) });
    audit(req, "2段階認証を有効化");
    res.json({ recoveryCodes: codes });
  }));

  app.post("/api/me/2fa/disable", h((req, res) => {
    if (!verifyPassword(String(req.body.password ?? ""), req.user.password_hash)) throw fail(400, "パスワードが正しくありません");
    if (req.store.getSettings().require2fa) throw fail(400, "会社の方針で2段階認証が必須のため、解除できません");
    db.updateUser(req.user.id, { totp_enabled: false, totp_secret_enc: null, recovery_codes: null });
    audit(req, "2段階認証を解除");
    res.json({ ok: true });
  }));

  app.get("/api/meta", (req, res) => {
    const plan = planOf(req.tenant);
    const used = db.usageOf(req.tenant.id).reduce((s, u) => s + u.count, 0);
    res.json({
      appName: APP_NAME,
      aiEnabled: ai.aiEnabled(),
      user: publicUser(req.user),
      tenant: {
        id: req.tenant.id, name: req.tenant.name, plan: req.tenant.plan, planLabel: plan.label,
        trialEndsAt: req.tenant.trial_ends_at, trialExpired: trialExpired(req.tenant), billingStatus: req.tenant.billing_status,
      },
      billingEnabled: billingEnabled(),
      usage: { used, limit: plan.aiPerMonth },
      options: { STAGES, STATUSES, TIERS, ROLES },
      settings: req.store.getSettings(),
      integrations: Object.keys(PROVIDERS).filter((p) => getIntegration(db, req.tenant.id, p)),
      mustSetup2fa: mustSetup2fa(req),
    });
  });

  app.put("/api/settings", adminOnly, h((req, res) => {
    const patch = {};
    if ("offering" in req.body) patch.offering = String(req.body.offering ?? "").slice(0, 3000);
    if ("require2fa" in req.body) patch.require2fa = Boolean(req.body.require2fa);
    const s = req.store.setSettings(patch);
    audit(req, "設定変更", Object.keys(patch).map((k) => ({ offering: "自社の提供サービス", require2fa: `2段階認証の必須化:${patch.require2fa ? "オン" : "オフ"}` })[k]).join("、"));
    res.json(s);
  }));

  // AIを呼ぶ前のチェックと、利用量の記録
  function aiGuard(req, feature, res) {
    const reason = aiBlockedReason(db, req.tenant);
    if (reason) throw fail(402, reason);
    const release = aiLimiter.acquire(req.tenant.id);
    if (!release) throw fail(429, "AIの処理が同時に多く実行されています。ほかの処理が終わってから、もう一度お試しください");
    res.on("close", release); // 成功・失敗どちらでも、応答が終わったら枠を空ける
    let tokens = { input: 0, output: 0 };
    return {
      onUsage: (u) => { tokens.input += u.input; tokens.output += u.output; },
      done: (detail) => {
        if (ai.aiEnabled()) db.addUsage(req.tenant.id, feature, tokens);
        audit(req, `AI:${feature}`, detail);
      },
    };
  }

  // ---------- ダッシュボード ----------
  app.get("/api/dashboard", (req, res) => {
    const store = req.store;
    const deals = store.list("deals");
    const companies = store.list("companies");
    const open = deals.filter((d) => !["受注", "失注"].includes(d.stage));
    const byStage = STAGES.map((s) => {
      const ds = deals.filter((d) => d.stage === s);
      return { stage: s, count: ds.length, amount: ds.reduce((a, d) => a + (Number(d.amount) || 0), 0) };
    });
    const nameOf = new Map(companies.map((c) => [c.id, c.name]));
    const upcoming = open
      .filter((d) => d.nextAction)
      .sort((a, b) => (a.nextActionDate || "9999").localeCompare(b.nextActionDate || "9999"))
      .slice(0, 8)
      .map((d) => ({ ...d, companyName: nameOf.get(d.companyId) ?? "(不明)" }));
    const q = checkQuality(store);
    const settings = store.getSettings();
    res.json({
      onboarding: [
        { key: "offering", label: "自社の提供サービスを登録する", done: Boolean(settings.offering), href: "#admin" },
        { key: "company", label: "営業先の会社を登録する(CSV・外部CRMからも可)", done: companies.length > 0, href: "#crm" },
        { key: "research", label: "AIで1社リサーチしてみる", done: companies.some((c) => c.research), href: "#research" },
        { key: "meeting", label: "商談の議事録をAIで分析してみる", done: store.list("meetings").length > 0, href: "#meeting" },
        { key: "member", label: "チームのメンバーを招待する", done: db.listUsers(req.tenant.id).length > 1, href: "#admin" },
      ],
      counts: {
        companies: companies.length,
        contacts: store.list("contacts").length,
        openDeals: open.length,
        meetings: store.list("meetings").length,
        researched: companies.filter((c) => c.research).length,
        enterprise: companies.filter((c) => c.tier === "大手").length,
      },
      pipelineAmount: open.reduce((a, d) => a + (Number(d.amount) || 0), 0),
      weightedAmount: open.reduce((a, d) => a + ((Number(d.amount) || 0) * (Number(d.probability) || 0)) / 100, 0),
      byStage,
      upcoming,
      quality: { score: q.score, issueCount: q.issues.length },
    });
  });

  // ---------- サンプルデータ ----------
  app.post("/api/seed", adminOnly, h((req, res) => {
    seed(req.store);
    audit(req, "サンプルデータ投入");
    res.json({ ok: true });
  }));

  // ---------- 汎用CRUD ----------
  const ALLOWED = {
    companies: ["name", "industry", "tier", "status", "website", "notes"],
    contacts: ["companyId", "name", "department", "title", "role", "email", "phone"],
    deals: ["companyId", "title", "stage", "amount", "probability", "nextAction", "nextActionDate", "closeDate"],
    meetings: [],
  };
  const clean = (req, col, body) => {
    // 決められた項目以外は受け付けない(外部IDやAI結果を勝手に書き換えさせない)
    const b = Object.fromEntries(Object.entries(body ?? {}).filter(([k]) => ALLOWED[col].includes(k)).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 5000) : v]));
    if (col === "companies") {
      if ("name" in b || !body?.id) {
        if (!String(b.name ?? "").trim()) throw fail(400, "会社名は必須です");
        b.name = normalizeCompanyName(b.name);
      }
    }
    if (col === "contacts" && "name" in b && !String(b.name).trim()) throw fail(400, "氏名は必須です");
    if (col === "deals" && "title" in b && !String(b.title).trim()) throw fail(400, "案件名は必須です");
    if ("companyId" in b && !req.store.get("companies", b.companyId)) throw fail(400, "会社が見つかりません");
    if ("amount" in b) b.amount = b.amount === "" || b.amount === null ? null : Number(b.amount);
    if ("probability" in b) b.probability = b.probability === "" || b.probability === null ? null : Number(b.probability);
    return b;
  };

  app.get("/api/:col", (req, res, next) => {
    if (!COLS.includes(req.params.col)) return next();
    res.json(req.store.list(req.params.col));
  });
  app.post("/api/:col", (req, res, next) => (COLS.includes(req.params.col) && req.params.col !== "meetings" ? next() : next("route")), h((req, res) => {
    const rec = req.store.insert(req.params.col, clean(req, req.params.col, req.body));
    res.json(rec);
  }));
  app.put("/api/:col/:id", (req, res, next) => (COLS.includes(req.params.col) && req.params.col !== "meetings" ? next() : next("route")), h((req, res) => {
    const r = req.store.update(req.params.col, req.params.id, clean(req, req.params.col, { ...req.body, id: req.params.id }));
    if (!r) throw fail(404, "データが見つかりません");
    res.json(r);
  }));
  app.delete("/api/:col/:id", (req, res, next) => (COLS.includes(req.params.col) ? next() : next("route")), h((req, res) => {
    const rec = req.store.get(req.params.col, req.params.id);
    if (!rec) throw fail(404, "データが見つかりません");
    req.store.remove(req.params.col, req.params.id);
    audit(req, "削除", `${req.params.col}:${rec.name ?? rec.title ?? rec.date ?? rec.id}`);
    res.json({ ok: true });
  }));

  // ---------- ① リサーチ ----------
  app.post("/api/research/:companyId", h(async (req, res) => {
    const c = req.store.get("companies", req.params.companyId);
    if (!c) throw fail(404, "会社が見つかりません");
    const g = aiGuard(req, "リサーチ", res);
    const r = await ai.research(c, req.store.getSettings().offering, g.onUsage);
    g.done(c.name);
    const patch = { research: r };
    if (!c.industry && r.industry) patch.industry = r.industry;
    if (!c.tier && r.tier) patch.tier = r.tier;
    if (!c.website && r.website) patch.website = r.website;
    res.json(req.store.update("companies", c.id, patch));
  }));

  // ---------- ② 大手開拓 ----------
  app.get("/api/targets", (req, res) => {
    const contacts = req.store.list("contacts");
    const list = req.store.list("companies").map((c) => ({
      ...c,
      score: priorityScore(req.store, c),
      contactCount: contacts.filter((p) => p.companyId === c.id).length,
      hasDecisionMaker: contacts.some((p) => p.companyId === c.id && p.role === "決裁者"),
    }));
    list.sort((a, b) => b.score - a.score);
    res.json(list);
  });

  app.post("/api/account-plan/:companyId", h(async (req, res) => {
    const c = req.store.get("companies", req.params.companyId);
    if (!c) throw fail(404, "会社が見つかりません");
    const contacts = req.store.list("contacts").filter((p) => p.companyId === c.id);
    const deals = req.store.list("deals").filter((d) => d.companyId === c.id);
    const g = aiGuard(req, "開拓プラン", res);
    const plan = await ai.accountPlan(c, contacts, deals, req.store.getSettings().offering, g.onUsage);
    g.done(c.name);
    res.json(req.store.update("companies", c.id, { accountPlan: plan }));
  }));

  // ---------- ③ CRM整備 ----------
  app.get("/api/crm/quality", (req, res) => res.json(checkQuality(req.store)));

  app.post("/api/crm/fix", h((req, res) => {
    const { fix, ids, value } = req.body;
    if (!Array.isArray(ids) || !ids.every((id) => req.store.get("companies", id))) throw fail(400, "対象のデータが見つかりません");
    if (fix === "normalize") req.store.update("companies", ids[0], { name: normalizeCompanyName(value) });
    else if (fix === "merge") mergeCompanies(req.store, ids);
    else throw fail(400, "この項目は自動修正できません");
    audit(req, "CRM整備", fix === "merge" ? "重複統合" : "表記修正");
    res.json(checkQuality(req.store));
  }));

  app.post("/api/crm/extract", h(async (req, res) => {
    const text = String(req.body.text ?? "").trim();
    if (!text) throw fail(400, "テキストを入力してください");
    if (text.length > 20000) throw fail(400, "テキストが長すぎます(2万文字まで)");
    const g = aiGuard(req, "取り込み", res);
    const r = await ai.extractCrm(text, g.onUsage);
    g.done(`${text.length}文字`);
    res.json(r);
  }));

  function findOrCreateCompany(store, name, extra = {}) {
    const key = companyKey(name);
    const found = store.list("companies").find((c) => companyKey(c.name) === key);
    if (found) return { company: found, created: false };
    const allowed = Object.fromEntries(Object.entries(extra).filter(([k]) => ALLOWED.companies.includes(k)));
    return { company: store.insert("companies", { status: "未接触", ...allowed, name: normalizeCompanyName(name) }), created: true };
  }

  function importRecords(store, { companies = [], contacts = [], deals = [] }) {
    const result = { companies: 0, contacts: 0, deals: 0, linked: 0 };
    const pick = (col, o) => Object.fromEntries(Object.entries(o).filter(([k]) => ALLOWED[col].includes(k)));
    for (const c of companies.slice(0, 5000)) {
      if (!c.name) continue;
      const { created } = findOrCreateCompany(store, c.name, c);
      created ? result.companies++ : result.linked++;
    }
    for (const p of contacts.slice(0, 10000)) {
      if (!p.name) continue;
      const { company } = findOrCreateCompany(store, p.companyName || "(会社未設定)");
      const rest = pick("contacts", p);
      const dup = store.list("contacts").find((x) => x.companyId === company.id && x.name === p.name);
      if (dup) store.update("contacts", dup.id, Object.fromEntries(Object.entries(rest).filter(([, v]) => v)));
      else { store.insert("contacts", { role: "不明", ...rest, companyId: company.id }); result.contacts++; }
    }
    for (const d of deals.slice(0, 5000)) {
      if (!d.title) continue;
      const { company } = findOrCreateCompany(store, d.companyName || "(会社未設定)");
      const rest = pick("deals", d);
      const amount = rest.amount === "" || rest.amount === undefined || rest.amount === null ? null : Number(rest.amount);
      const probability = rest.probability ? Number(rest.probability) : null;
      store.insert("deals", { stage: "リード", ...rest, amount, probability, companyId: company.id });
      result.deals++;
    }
    return result;
  }

  app.post("/api/crm/import", h((req, res) => {
    const r = importRecords(req.store, req.body);
    audit(req, "データ取り込み", JSON.stringify(r));
    res.json(r);
  }));

  const CSV_FIELDS = {
    companies: [["name", "会社名"], ["industry", "業種"], ["tier", "企業規模"], ["status", "ステータス"], ["website", "Webサイト"], ["notes", "メモ"]],
    contacts: [["companyName", "会社名"], ["name", "氏名"], ["department", "部署"], ["title", "役職"], ["role", "役割"], ["email", "メール"], ["phone", "電話"]],
    deals: [["companyName", "会社名"], ["title", "案件名"], ["stage", "ステージ"], ["amount", "金額"], ["probability", "確度"], ["nextAction", "次アクション"], ["nextActionDate", "期限"], ["closeDate", "受注予定日"]],
  };

  app.get("/api/export/:col", (req, res) => {
    const fields = CSV_FIELDS[req.params.col];
    if (!fields) return res.status(404).end();
    const names = new Map(req.store.list("companies").map((c) => [c.id, c.name]));
    // Excelで開いたときに数式として実行されないよう、先頭の = + - @ を無害化
    const safe = (v) => (typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
    const rows = req.store.list(req.params.col).map((r) => fields.map(([k]) => safe(k === "companyName" ? names.get(r.companyId) ?? "" : r[k])));
    audit(req, "CSV出力", req.params.col);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.col}.csv"`);
    res.send(toCsv([fields.map(([, label]) => label), ...rows]));
  });

  app.post("/api/import/:col", h((req, res) => {
    const fields = CSV_FIELDS[req.params.col];
    if (!fields) throw fail(404, "Not found");
    const [header, ...rows] = parseCsv(String(req.body.csv ?? ""));
    if (!header) throw fail(400, "CSVが空です");
    const idx = fields.map(([k, label]) => header.findIndex((x) => x.trim() === label || x.trim() === k));
    if (idx[fields.findIndex(([k]) => k === "name" || k === "title")] === -1 && idx[0] === -1) throw fail(400, "CSVの見出しを確認してください");
    const items = rows.map((r) => Object.fromEntries(fields.map(([k], i) => [k, idx[i] >= 0 ? r[idx[i]]?.trim() ?? "" : ""])));
    const r = importRecords(req.store, { [req.params.col]: items });
    audit(req, "CSV取込", `${req.params.col}:${JSON.stringify(r)}`);
    res.json(r);
  }));

  // ---------- ④ 商談分析 ----------
  app.post("/api/meetings/analyze", h(async (req, res) => {
    const { dealId, transcript, date } = req.body;
    const text = String(transcript ?? "").trim();
    if (!text) throw fail(400, "議事録を入力してください");
    if (text.length > 100000) throw fail(400, "議事録が長すぎます(10万文字まで)");
    const deal = dealId ? req.store.get("deals", dealId) : null;
    if (dealId && !deal) throw fail(404, "商談が見つかりません");
    const company = deal ? req.store.get("companies", deal.companyId) : null;
    const g = aiGuard(req, "商談分析", res);
    // 同じ商談の過去の分析結果(新しい順に最大5件)も、AIに渡して流れをふまえさせる
    const history = deal
      ? req.store.list("meetings").filter((m) => m.dealId === deal.id).sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 5)
          .map((m) => ({ date: m.date, summary: m.analysis?.summary, winProbability: m.analysis?.winProbability, nextActions: m.analysis?.nextActions?.map((n) => n.task) }))
      : [];
    const analysis = await ai.analyzeMeeting({ transcript: text, company, deal, date, history }, g.onUsage);
    g.done(deal ? `${company?.name}|${deal.title}` : "商談未選択");
    const meeting = req.store.insert("meetings", {
      dealId: deal?.id ?? null,
      companyId: company?.id ?? null,
      date: date || new Date().toISOString().slice(0, 10),
      transcript: text,
      analysis,
      applied: false,
      createdBy: req.user.name,
    });
    res.json(meeting);
  }));

  // 分析結果をCRMに反映(外部CRMから取り込んだ商談なら、そちらにも書き戻す)
  app.post("/api/meetings/:id/apply", h(async (req, res) => {
    const store = req.store;
    const m = store.get("meetings", req.params.id);
    if (!m) throw fail(404, "議事録が見つかりません");
    if (!m.dealId) throw fail(400, "この議事録は商談にひもづいていません");
    const u = m.analysis.crmUpdate;
    const patch = {
      stage: u.stage,
      probability: Math.round(m.analysis.winProbability),
      nextAction: u.nextAction,
      ...(u.nextActionDate && { nextActionDate: u.nextActionDate }),
      ...(u.amount && { amount: u.amount }),
    };
    const deal = store.update("deals", m.dealId, patch);
    if (!deal) throw fail(404, "商談が見つかりません");
    store.update("meetings", m.id, { applied: true });
    const company = store.get("companies", deal.companyId);
    if (company && company.status !== "取引中") {
      store.update("companies", company.id, { status: deal.stage === "受注" ? "取引中" : "商談中" });
    }
    audit(req, "商談分析をCRMに反映", deal.title);

    let pushed = null;
    const provider = deal.external?.source;
    if (provider && PROVIDERS[provider]) {
      const it = getIntegration(db, req.tenant.id, provider);
      if (it?.options.autoPush && planOf(req.tenant).crmSync) {
        try {
          const { client } = clientFor(db, req.tenant.id, provider, deps);
          await pushDeal(client, deal, PROVIDERS[provider].stageMap.export);
          pushed = { provider: PROVIDERS[provider].label, ok: true };
          audit(req, `${PROVIDERS[provider].label}へ書き戻し`, deal.title);
        } catch (e) {
          pushed = { provider: PROVIDERS[provider].label, ok: false, error: e.message };
        }
      }
    }
    res.json({ deal, pushed });
  }));

  // ---------- AIが作った文面を手直しして保存 ----------
  const cleanEmail = (b) => {
    const subject = String(b.subject ?? "").slice(0, 300);
    const body = String(b.body ?? "").slice(0, 20000);
    if (!subject.trim() || !body.trim()) throw fail(400, "件名と本文を入力してください");
    return { subject, body };
  };
  app.put("/api/meetings/:id/followup", h((req, res) => {
    const m = req.store.get("meetings", req.params.id);
    if (!m) throw fail(404, "議事録が見つかりません");
    const analysis = { ...m.analysis, followupEmail: { ...cleanEmail(req.body), edited: true } };
    res.json(req.store.update("meetings", m.id, { analysis }));
  }));
  app.put("/api/companies/:id/plan-email", h((req, res) => {
    const c = req.store.get("companies", req.params.id);
    if (!c?.accountPlan) throw fail(404, "開拓プランが見つかりません");
    const accountPlan = { ...c.accountPlan, email: { ...cleanEmail(req.body), edited: true } };
    res.json(req.store.update("companies", c.id, { accountPlan }));
  }));

  // ---------- 全体検索 ----------
  app.get("/api/search", (req, res) => {
    const q = String(req.query.q ?? "").normalize("NFKC").toLowerCase().trim();
    if (!q) return res.json([]);
    const hit = (...vals) => vals.some((v) => String(v ?? "").normalize("NFKC").toLowerCase().includes(q));
    const companies = req.store.list("companies");
    const nameOf = new Map(companies.map((c) => [c.id, c.name]));
    const results = [
      ...companies.filter((c) => hit(c.name, c.industry, c.notes)).map((c) => ({ type: "company", id: c.id, companyId: c.id, title: c.name, sub: c.industry || "" })),
      ...req.store.list("contacts").filter((p) => hit(p.name, p.email, p.department, p.title)).map((p) => ({ type: "contact", id: p.id, companyId: p.companyId, title: p.name, sub: `${nameOf.get(p.companyId) ?? ""} ${p.department ?? ""} ${p.title ?? ""}`.trim() })),
      ...req.store.list("deals").filter((d) => hit(d.title, d.nextAction)).map((d) => ({ type: "deal", id: d.id, companyId: d.companyId, title: d.title, sub: `${nameOf.get(d.companyId) ?? ""}|${d.stage ?? ""}` })),
    ];
    res.json(results.slice(0, 30));
  });

  // ---------- 会社の詳細(関連情報をまとめて返す) ----------
  app.get("/api/company-detail/:id", h((req, res) => {
    const c = req.store.get("companies", req.params.id);
    if (!c) throw fail(404, "会社が見つかりません");
    const meetings = req.store.list("meetings").filter((m) => m.companyId === c.id)
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .map(({ transcript, ...m }) => ({ ...m, transcriptLength: transcript?.length ?? 0 }));
    res.json({
      company: c,
      score: priorityScore(req.store, c),
      contacts: req.store.list("contacts").filter((p) => p.companyId === c.id),
      deals: req.store.list("deals").filter((d) => d.companyId === c.id),
      meetings,
    });
  }));

  // =====================================================
  // 外部CRM連携(Salesforce / HubSpot)
  // =====================================================
  app.get("/api/integrations", adminOnly, (req, res) => res.json(describeIntegrations(db, req.tenant.id)));

  app.put("/api/integrations/:provider", adminOnly, h((req, res) => {
    if (!planOf(req.tenant).crmSync) throw fail(402, "ご契約のプランでは外部CRM連携を利用できません");
    saveIntegration(db, req.tenant.id, req.params.provider, req.body.config, req.body.options);
    audit(req, "外部CRM連携を設定", req.params.provider);
    res.json(describeIntegrations(db, req.tenant.id));
  }));

  app.delete("/api/integrations/:provider", adminOnly, h((req, res) => {
    deleteIntegration(db, req.tenant.id, req.params.provider);
    audit(req, "外部CRM連携を解除", req.params.provider);
    res.json(describeIntegrations(db, req.tenant.id));
  }));

  app.post("/api/integrations/:provider/test", adminOnly, h(async (req, res) => {
    const { client } = clientFor(db, req.tenant.id, req.params.provider, deps);
    await client.test();
    res.json({ ok: true });
  }));

  const requireCrmSync = (req) => {
    if (!planOf(req.tenant).crmSync) throw fail(402, "ご契約のプランでは外部CRM連携を利用できません");
  };

  app.post("/api/integrations/:provider/sync", adminOnly, h(async (req, res) => {
    requireCrmSync(req);
    const provider = req.params.provider;
    const { client } = clientFor(db, req.tenant.id, provider, deps);
    const result = await importFromProvider(req.store, client, PROVIDERS[provider].stageMap.import);
    db.run(
      "UPDATE integrations SET last_sync_at = ?, last_result = ? WHERE tenant_id = ? AND provider = ?",
      new Date().toISOString(), JSON.stringify(result), req.tenant.id, provider,
    );
    audit(req, `${PROVIDERS[provider].label}から取り込み`, JSON.stringify(result));
    res.json(result);
  }));

  app.post("/api/integrations/push/:dealId", h(async (req, res) => {
    const deal = req.store.get("deals", req.params.dealId);
    if (!deal) throw fail(404, "商談が見つかりません");
    requireCrmSync(req);
    const provider = deal.external?.source;
    if (!PROVIDERS[provider]) throw fail(400, "外部CRMから取り込んだ商談ではありません");
    const { client } = clientFor(db, req.tenant.id, provider, deps);
    const sent = await pushDeal(client, deal, PROVIDERS[provider].stageMap.export);
    audit(req, `${PROVIDERS[provider].label}へ書き戻し`, deal.title);
    res.json({ ok: true, sent });
  }));

  // =====================================================
  // 管理(メンバー・利用状況・監査ログ・データ管理)
  // =====================================================
  app.get("/api/admin/users", adminOnly, (req, res) => {
    res.json(db.listUsers(req.tenant.id).map((u) => ({ ...u, roleLabel: ROLE_LABEL[u.role], disabled: Boolean(u.disabled) })));
  });

  app.post("/api/admin/invites", adminOnly, h(async (req, res) => {
    const { email, role = "member" } = req.body;
    if (!isEmail(email)) throw fail(400, "メールアドレスの形式が正しくありません");
    if (!["member", "admin"].includes(role)) throw fail(400, "権限の指定が正しくありません");
    if (role === "admin" && req.user.role !== "owner") throw fail(403, "管理者として招待できるのはオーナーだけです");
    if (db.getUserByEmail(email)) throw fail(409, "このメールアドレスはすでに登録されています");
    if (userLimitReached(db, req.tenant)) throw fail(402, "ご契約プランのユーザー数の上限に達しています");
    const token = newToken();
    db.run(
      "INSERT INTO invites (token_hash, tenant_id, kind, email, role, expires_at, created_at) VALUES (?, ?, 'invite', ?, ?, ?, ?)",
      hashToken(token), req.tenant.id, email.toLowerCase(), role, new Date(Date.now() + 7 * 864e5).toISOString(), new Date().toISOString(),
    );
    audit(req, "メンバー招待", `${email}(${ROLE_LABEL[role]})`);
    const link = `/#accept=${token}`;
    const sent = await mailer.send({
      to: email,
      ...emails.invite({ inviterName: req.user.name, tenantName: req.tenant.name, url: `${appUrl(req)}${link}`, days: 7 }),
    });
    res.json({ link, expiresInDays: 7, emailed: sent.ok && mailer.enabled });
  }));

  const targetUser = (req) => {
    const u = db.getUser(req.params.id);
    if (!u || u.tenant_id !== req.tenant.id) throw fail(404, "ユーザーが見つかりません");
    if (u.role === "owner" && req.user.role !== "owner") throw fail(403, "オーナーの設定は変更できません");
    return u;
  };

  app.put("/api/admin/users/:id", adminOnly, h((req, res) => {
    const u = targetUser(req);
    if (u.id === req.user.id) throw fail(400, "自分自身の権限・状態は変更できません");
    const patch = {};
    if (req.body.role !== undefined) {
      if (!["member", "admin"].includes(req.body.role)) throw fail(400, "権限の指定が正しくありません");
      if (req.user.role !== "owner") throw fail(403, "権限を変更できるのはオーナーだけです");
      patch.role = req.body.role;
    }
    if (req.body.disabled !== undefined) patch.disabled = Boolean(req.body.disabled);
    db.updateUser(u.id, patch);
    if (patch.disabled) destroyUserSessions(db, u.id);
    audit(req, "メンバー設定変更", `${u.email} ${JSON.stringify(patch)}`);
    res.json({ ok: true });
  }));

  app.post("/api/admin/users/:id/reset-link", adminOnly, h(async (req, res) => {
    const u = targetUser(req);
    const link = issueReset(u, 24);
    const sent = await mailer.send({ to: u.email, ...emails.passwordReset({ name: u.name, url: `${appUrl(req)}${link}`, hours: 24 }) });
    audit(req, "パスワード再設定リンク発行", u.email);
    res.json({ link, expiresInHours: 24, emailed: sent.ok && mailer.enabled });
  }));

  app.delete("/api/admin/users/:id", adminOnly, h((req, res) => {
    const u = targetUser(req);
    if (u.id === req.user.id) throw fail(400, "自分自身は削除できません");
    db.deleteUser(u.id);
    audit(req, "メンバー削除", u.email);
    res.json({ ok: true });
  }));

  app.get("/api/admin/usage", adminOnly, (req, res) => {
    const plan = planOf(req.tenant);
    res.json({
      plan: { key: req.tenant.plan, ...plan },
      trialEndsAt: req.tenant.trial_ends_at,
      month: new Date().toISOString().slice(0, 7),
      usage: db.usageOf(req.tenant.id),
      users: db.listUsers(req.tenant.id).length,
      plans: Object.fromEntries(SELLABLE.map((k) => [k, PLANS[k]])),
      billing: {
        enabled: billingEnabled(),
        status: req.tenant.billing_status,
        hasCustomer: Boolean(req.tenant.stripe_customer_id),
        purchasable: billingEnabled() ? SELLABLE.filter((k) => priceIdFor(k)) : [],
      },
      contactEmail: process.env.SALES_CONTACT_EMAIL || "",
    });
  });

  // =====================================================
  // 決済(オーナーのみ)
  // =====================================================
  app.post("/api/billing/checkout", ownerOnly, h(async (req, res) => {
    if (!billingEnabled()) throw fail(503, "決済が設定されていません。運営者にお問い合わせください");
    if (req.tenant.plan === "internal") throw fail(400, "社内利用プランでは決済は不要です");
    const plan = String(req.body.plan ?? "standard");
    const priceId = priceIdFor(plan);
    if (!priceId) throw fail(400, "このプランはオンラインでお申し込みいただけません");
    if (req.tenant.stripe_subscription_id && req.tenant.billing_status !== "canceled") {
      throw fail(409, "すでにお申し込み済みです。「お支払い・請求書の管理」から変更してください");
    }
    const s = stripe();
    let customerId = req.tenant.stripe_customer_id;
    if (!customerId) {
      customerId = (await s.createCustomer({ tenant: req.tenant, email: req.user.email })).id;
      db.updateTenant(req.tenant.id, { stripe_customer_id: customerId });
    }
    const session = await s.createCheckout({ customerId, tenant: req.tenant, priceId, appUrl: appUrl(req) });
    audit(req, "決済ページへ移動", PLANS[plan].label);
    res.json({ url: session.url });
  }));

  app.post("/api/billing/portal", ownerOnly, h(async (req, res) => {
    if (!billingEnabled()) throw fail(503, "決済が設定されていません");
    if (!req.tenant.stripe_customer_id) throw fail(400, "まだお申し込みがありません");
    const session = await stripe().createPortal({ customerId: req.tenant.stripe_customer_id, appUrl: appUrl(req) });
    res.json({ url: session.url });
  }));

  app.get("/api/admin/audit", adminOnly, (req, res) => res.json(db.auditLogs(req.tenant.id)));

  // データの一括ダウンロード(解約時のデータ返却・個人情報の開示請求への対応用)
  app.get("/api/admin/export", ownerOnly, (req, res) => {
    audit(req, "全データ出力");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify({ tenant: { name: req.tenant.name }, users: db.listUsers(req.tenant.id), ...req.store.exportAll() }, null, 2));
  });

  // 解約:テナントと全データを完全に削除
  app.delete("/api/admin/tenant", ownerOnly, h(async (req, res) => {
    if (req.body.confirmName !== req.tenant.name) throw fail(400, "確認のため、会社名を正確に入力してください");
    // 課金が続かないよう、先にサブスクリプションを止める
    if (billingEnabled() && req.tenant.stripe_subscription_id && req.tenant.billing_status !== "canceled") {
      await stripe().cancelSubscription(req.tenant.stripe_subscription_id);
    }
    db.deleteTenant(req.tenant.id);
    res.setHeader("Set-Cookie", `sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  }));

  app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
  return app;
}
