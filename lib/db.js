// データベース(SQLite)。Node.js に標準で入っている node:sqlite を使うため、
// 追加のインストールは不要です。
//
// 販売(SaaS)を前提に、すべての営業データは「テナント(契約企業)」ごとに
// 分けて保存し、ほかの会社のデータが見えない作りにしています。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const COLLECTIONS = ["companies", "contacts", "deals", "meetings"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial',
  trial_ends_at TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- invite(招待) / reset(パスワード再設定)
  email TEXT,
  role TEXT,
  user_id TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  col TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_tenant_col ON records(tenant_id, col);
CREATE TABLE IF NOT EXISTS usage (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  feature TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, month, feature)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT,
  user_name TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs(tenant_id, id);
CREATE TABLE IF NOT EXISTS integrations (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  config_enc TEXT NOT NULL,      -- 接続情報(暗号化して保存)
  options TEXT NOT NULL DEFAULT '{}',
  last_sync_at TEXT,
  last_result TEXT,
  PRIMARY KEY (tenant_id, provider)
);
`;

const now = () => new Date().toISOString();
const plain = (row) => (row ? { ...row } : null);

export class Database {
  constructor(file) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  run(sql, ...args) {
    return this.db.prepare(sql).run(...args);
  }
  get(sql, ...args) {
    return plain(this.db.prepare(sql).get(...args));
  }
  all(sql, ...args) {
    return this.db.prepare(sql).all(...args).map(plain);
  }
  tx(fn) {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---------- テナント ----------
  createTenant({ name, plan = "trial", trialDays = 14 }) {
    const id = crypto.randomUUID();
    const trialEnds = plan === "trial" ? new Date(Date.now() + trialDays * 864e5).toISOString() : null;
    this.run("INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)", id, name, plan, trialEnds, now());
    return this.getTenant(id);
  }
  getTenant(id) {
    const t = this.get("SELECT * FROM tenants WHERE id = ?", id);
    if (t) t.settings = JSON.parse(t.settings || "{}");
    return t;
  }
  listTenants() {
    return this.all(
      `SELECT t.id, t.name, t.plan, t.trial_ends_at, t.created_at,
        (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS users
       FROM tenants t ORDER BY t.created_at`,
    );
  }
  updateTenant(id, patch) {
    const t = this.getTenant(id);
    if (!t) return null;
    const next = { ...t, ...patch };
    this.run(
      "UPDATE tenants SET name = ?, plan = ?, trial_ends_at = ?, settings = ? WHERE id = ?",
      next.name, next.plan, next.trial_ends_at, JSON.stringify(next.settings ?? {}), id,
    );
    return this.getTenant(id);
  }
  deleteTenant(id) {
    this.run("DELETE FROM tenants WHERE id = ?", id);
  }

  // ---------- ユーザー ----------
  createUser({ tenantId, email, name, passwordHash, role = "member" }) {
    const id = crypto.randomUUID();
    this.run(
      "INSERT INTO users (id, tenant_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, tenantId, email.toLowerCase(), name, passwordHash, role, now(),
    );
    return this.getUser(id);
  }
  getUser(id) {
    return this.get("SELECT * FROM users WHERE id = ?", id);
  }
  getUserByEmail(email) {
    return this.get("SELECT * FROM users WHERE email = ?", String(email).toLowerCase());
  }
  listUsers(tenantId) {
    return this.all(
      "SELECT id, email, name, role, disabled, created_at, last_login_at FROM users WHERE tenant_id = ? ORDER BY created_at",
      tenantId,
    );
  }
  updateUser(id, patch) {
    const u = this.getUser(id);
    if (!u) return null;
    const n = { ...u, ...patch };
    this.run(
      "UPDATE users SET name = ?, role = ?, disabled = ?, password_hash = ?, last_login_at = ? WHERE id = ?",
      n.name, n.role, n.disabled ? 1 : 0, n.password_hash, n.last_login_at, id,
    );
    return this.getUser(id);
  }
  deleteUser(id) {
    this.run("DELETE FROM users WHERE id = ?", id);
  }

  // ---------- 利用量(料金プランの上限管理・原価管理に使う) ----------
  addUsage(tenantId, feature, { input = 0, output = 0 } = {}) {
    const month = now().slice(0, 7);
    this.run(
      `INSERT INTO usage (tenant_id, month, feature, count, input_tokens, output_tokens) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(tenant_id, month, feature) DO UPDATE SET
         count = count + 1, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
      tenantId, month, feature, input, output,
    );
  }
  usageOf(tenantId, month = now().slice(0, 7)) {
    return this.all("SELECT feature, count, input_tokens, output_tokens FROM usage WHERE tenant_id = ? AND month = ?", tenantId, month);
  }

  // ---------- 監査ログ ----------
  audit(tenantId, user, action, detail = "", ip = "") {
    this.run(
      "INSERT INTO audit_logs (tenant_id, user_id, user_name, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      tenantId, user?.id ?? null, user?.name ?? "システム", action, String(detail).slice(0, 500), ip, now(),
    );
  }
  auditLogs(tenantId, limit = 200) {
    return this.all("SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT ?", tenantId, limit);
  }

  forTenant(tenantId) {
    return new TenantStore(this, tenantId);
  }
}

// 1つのテナントのデータだけを読み書きする窓口。
// 画面からのAPIは必ずこれを通すため、他社のデータには触れられない。
export class TenantStore {
  constructor(database, tenantId) {
    if (!tenantId) throw new Error("tenantId is required");
    this.d = database;
    this.tenantId = tenantId;
  }

  #row(r) {
    return r ? { ...JSON.parse(r.data), id: r.id, createdAt: r.created_at, updatedAt: r.updated_at } : null;
  }

  list(col) {
    return this.d
      .all("SELECT * FROM records WHERE tenant_id = ? AND col = ? ORDER BY created_at, rowid", this.tenantId, col)
      .map((r) => this.#row(r));
  }

  get(col, id) {
    return this.#row(this.d.get("SELECT * FROM records WHERE tenant_id = ? AND col = ? AND id = ?", this.tenantId, col, id));
  }

  insert(col, item) {
    const id = crypto.randomUUID();
    const t = now();
    const { id: _i, createdAt: _c, updatedAt: _u, ...data } = item;
    this.d.run(
      "INSERT INTO records (id, tenant_id, col, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      id, this.tenantId, col, JSON.stringify(data), t, t,
    );
    return this.get(col, id);
  }

  update(col, id, patch) {
    const cur = this.get(col, id);
    if (!cur) return null;
    const { id: _i, createdAt: _c, updatedAt: _u, ...data } = { ...cur, ...patch };
    this.d.run(
      "UPDATE records SET data = ?, updated_at = ? WHERE tenant_id = ? AND col = ? AND id = ?",
      JSON.stringify(data), now(), this.tenantId, col, id,
    );
    return this.get(col, id);
  }

  remove(col, id) {
    return this.d.tx(() => {
      const r = this.d.run("DELETE FROM records WHERE tenant_id = ? AND col = ? AND id = ?", this.tenantId, col, id);
      if (col === "companies") {
        // 会社を消したら、ひもづく担当者・商談・議事録も消す
        for (const c of ["contacts", "deals", "meetings"]) {
          for (const x of this.list(c)) if (x.companyId === id) this.d.run("DELETE FROM records WHERE id = ?", x.id);
        }
      }
      if (col === "deals") {
        for (const m of this.list("meetings")) if (m.dealId === id) this.d.run("DELETE FROM records WHERE id = ?", m.id);
      }
      return r.changes > 0;
    });
  }

  getSettings() {
    return this.d.getTenant(this.tenantId)?.settings ?? {};
  }
  setSettings(patch) {
    const settings = { ...this.getSettings(), ...patch };
    this.d.updateTenant(this.tenantId, { settings });
    return settings;
  }

  exportAll() {
    return Object.fromEntries(COLLECTIONS.map((c) => [c, this.list(c)]));
  }
}
