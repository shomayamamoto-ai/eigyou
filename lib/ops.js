// 運用のための仕組み:自動バックアップ・障害通知・アクセス記録・AIの同時実行制限
import fs from "node:fs";
import path from "node:path";

// ---------- 自動バックアップ ----------
// SQLite の「VACUUM INTO」で、動かしたまま安全にデータベースを丸ごと複製する
export function backupDatabase(db, dir, keep = Number(process.env.BACKUP_KEEP) || 14) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
  let file = path.join(dir, `app-${stamp}.db`);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `app-${stamp}-${i}.db`);
  db.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  // 古いものから削除して、指定した世代数だけ残す
  const files = fs.readdirSync(dir).filter((f) => /^app-.*\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f));
  return file;
}

export function latestBackup(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^app-.*\.db$/.test(f)).sort();
  if (!files.length) return null;
  const f = files.at(-1);
  return { file: f, at: fs.statSync(path.join(dir, f)).mtime.toISOString(), count: files.length };
}

// ---------- 障害の通知(Slack・Teams などの Webhook) ----------
// 同じ種類の通知は10分に1回までにして、通知が殺到しないようにする
const lastSent = new Map();
export async function alert(title, detail = "", { fetch = globalThis.fetch } = {}) {
  const url = process.env.ALERT_WEBHOOK_URL;
  console.error(`[ALERT] ${title} ${detail}`);
  if (!url) return false;
  const now = Date.now();
  if (now - (lastSent.get(title) ?? 0) < 10 * 60 * 1000) return false;
  lastSent.set(title, now);
  const appName = process.env.APP_NAME || "営業AIプラットフォーム";
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `:rotating_light: 【${appName}】${title}\n${String(detail).slice(0, 1500)}` }),
    });
    return true;
  } catch (e) {
    console.error("障害通知の送信に失敗:", e.message);
    return false;
  }
}

// ---------- アクセス記録(個人情報は含めない) ----------
export function requestLogger() {
  return (req, res, next) => {
    if (process.env.LOG_REQUESTS !== "true" || !req.path.startsWith("/api")) return next();
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      // パスに含まれるIDは伏せて記録する
      const route = req.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id");
      console.log(JSON.stringify({ t: new Date().toISOString(), method: req.method, path: route, status: res.statusCode, ms: Math.round(ms), tenant: req.tenant?.id ?? null }));
    });
    next();
  };
}

// ---------- AIの同時実行数の制限 ----------
// 1社で大量に同時実行されると、他社の処理が遅くなり、費用も急増するため
export class ConcurrencyLimiter {
  constructor(max = Number(process.env.AI_MAX_CONCURRENT_PER_TENANT) || 3) {
    this.max = max;
    this.running = new Map();
  }
  acquire(key) {
    const n = this.running.get(key) ?? 0;
    if (n >= this.max) return null;
    this.running.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.running.get(key) ?? 1) - 1;
      if (left <= 0) this.running.delete(key);
      else this.running.set(key, left);
    };
  }
}
