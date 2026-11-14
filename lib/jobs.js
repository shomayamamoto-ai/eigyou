// 定期的に動かす処理(サーバー起動中、1時間ごとに実行)
import { emails } from "./emails.js";
import { backupDatabase, latestBackup, alert } from "./ops.js";
import { localDate, localHour, TIMEZONE } from "./time.js";

// 無料トライアル終了の3日前に、オーナーへお知らせメールを送る(1社1回だけ)
export async function sendTrialReminders({ db, mailer, appUrl, now = new Date() }) {
  const soon = new Date(now.getTime() + 3 * 864e5).toISOString();
  const targets = db.all(
    `SELECT * FROM tenants WHERE plan = 'trial' AND trial_notified_at IS NULL
       AND trial_ends_at IS NOT NULL AND trial_ends_at > ? AND trial_ends_at <= ?`,
    now.toISOString(), soon,
  );
  for (const t of targets) {
    const owners = db.all("SELECT * FROM users WHERE tenant_id = ? AND role = 'owner' AND disabled = 0", t.id);
    for (const o of owners) {
      await mailer.send({ to: o.email, ...emails.trialEnding({ name: o.name, tenantName: t.name, endsAt: t.trial_ends_at, url: `${appUrl}/#admin` }) });
    }
    db.updateTenant(t.id, { trial_notified_at: now.toISOString() });
  }
  return targets.length;
}

// 毎朝(平日8時以降に1回)、担当している商談の「今日やること」をメールで送る
export async function sendDailyDigests({ db, mailer, appUrl, now = new Date() }) {
  if (process.env.DIGEST_DISABLED === "true") return 0;
  if (localHour(now) < (Number(process.env.DIGEST_HOUR) || 8)) return 0;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE(), weekday: "short" }).format(now);
  if (["Sat", "Sun"].includes(weekday)) return 0;
  const today = localDate(now);
  let sent = 0;
  const tenants = db.all("SELECT id FROM tenants WHERE plan != 'canceled' AND (last_digest_date IS NULL OR last_digest_date != ?)", today);
  for (const { id } of tenants) {
    // 先に「送信済み」にして、途中で失敗しても同じ人に何度も送らないようにする
    db.updateTenant(id, { last_digest_date: today });
    const store = db.forTenant(id);
    const nameOf = new Map(store.list("companies").map((c) => [c.id, c.name]));
    const open = store.list("deals").filter((d) => !["受注", "失注"].includes(d.stage)).map((d) => ({ ...d, companyName: nameOf.get(d.companyId) ?? "(不明)" }));
    const users = db.all("SELECT * FROM users WHERE tenant_id = ? AND disabled = 0 AND digest_optout = 0", id);
    for (const u of users) {
      const mine = open.filter((d) => d.ownerId === u.id);
      const overdue = mine.filter((d) => d.nextAction && d.nextActionDate && d.nextActionDate < today);
      const dueToday = mine.filter((d) => d.nextAction && d.nextActionDate === today);
      const noAction = mine.filter((d) => !d.nextAction);
      if (!overdue.length && !dueToday.length && !noAction.length) continue; // やることがない日は送らない
      const r = await mailer.send({ to: u.email, ...emails.digest({ name: u.name, overdue, today: dueToday, noAction, url: `${appUrl}/#crm` }) });
      if (r.ok) sent++;
    }
  }
  return sent;
}

// 期限切れのログイン情報・招待リンクを掃除する
export function cleanupExpired({ db, now = new Date() }) {
  const iso = now.toISOString();
  db.run("DELETE FROM sessions WHERE expires_at < ?", iso);
  db.run("DELETE FROM invites WHERE expires_at < ?", iso);
}

// 最後のバックアップから24時間たっていれば、新しく取る
export function backupIfDue({ db, backupDir, now = Date.now() }) {
  if (!backupDir || process.env.BACKUP_DISABLED === "true") return null;
  const last = latestBackup(backupDir);
  if (last && now - new Date(last.at).getTime() < 24 * 3600e3) return null;
  return backupDatabase(db, backupDir);
}

export function startJobs({ db, mailer, appUrl, backupDir }) {
  const run = async () => {
    try {
      cleanupExpired({ db });
      const n = await sendTrialReminders({ db, mailer, appUrl });
      if (n) console.log(`トライアル終了のお知らせを ${n} 社に送信しました`);
      const d = await sendDailyDigests({ db, mailer, appUrl });
      if (d) console.log(`「今日やること」メールを ${d} 人に送信しました`);
    } catch (e) {
      alert("定期処理でエラー", e.stack ?? e.message);
    }
    try {
      const file = backupIfDue({ db, backupDir });
      if (file) console.log(`バックアップを作成しました:${file}`);
    } catch (e) {
      alert("バックアップに失敗", e.stack ?? e.message);
    }
  };
  run();
  return setInterval(run, 60 * 60 * 1000);
}
