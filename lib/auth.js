// ログイン・セッション・権限まわり
import crypto from "node:crypto";

const SESSION_DAYS = 14;
export const ROLE_LEVEL = { member: 1, admin: 2, owner: 3 };
export const ROLE_LABEL = { owner: "オーナー", admin: "管理者", member: "メンバー" };

// ---------- パスワード(scrypt でハッシュ化。平文は保存しない) ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  if (!stored?.startsWith("scrypt$")) return false;
  const [, saltB64, hashB64] = stored.split("$");
  const expected = Buffer.from(hashB64, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

export function checkPasswordPolicy(pw) {
  if (typeof pw !== "string" || pw.length < 10) return "パスワードは10文字以上にしてください";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return "パスワードは英字と数字の両方を含めてください";
  return null;
}

export const isEmail = (s) => typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;

// ---------- トークン(DBにはハッシュだけ保存し、漏えい時の悪用を防ぐ) ----------
export const newToken = () => crypto.randomBytes(32).toString("base64url");
export const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

export function createSession(db, userId) {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.run("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", hashToken(token), userId, expires, new Date().toISOString());
  return { token, expires };
}

export function findSession(db, token) {
  if (!token) return null;
  const row = db.get(
    `SELECT u.*, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    hashToken(token), new Date().toISOString(),
  );
  if (!row || row.disabled) return null;
  return row;
}

export function destroySession(db, token) {
  if (token) db.run("DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
}

export function destroyUserSessions(db, userId) {
  db.run("DELETE FROM sessions WHERE user_id = ?", userId);
}

export function cookieOptions(secure) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`;
}

export function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((p) => p.trim().split("="))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]),
  );
}

// ---------- ログイン試行回数の制限(総当たり攻撃対策) ----------
export class RateLimiter {
  constructor({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  hit(key) {
    const t = Date.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 10000) this.hits.clear();
    return list.length <= this.max;
  }
  reset(key) {
    this.hits.delete(key);
  }
}
