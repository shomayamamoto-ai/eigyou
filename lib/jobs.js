// 定期的に動かす処理(サーバー起動中、1時間ごとに実行)
import { emails } from "./emails.js";

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

// 期限切れのログイン情報・招待リンクを掃除する
export function cleanupExpired({ db, now = new Date() }) {
  const iso = now.toISOString();
  db.run("DELETE FROM sessions WHERE expires_at < ?", iso);
  db.run("DELETE FROM invites WHERE expires_at < ?", iso);
}

export function startJobs({ db, mailer, appUrl }) {
  const run = async () => {
    try {
      cleanupExpired({ db });
      const n = await sendTrialReminders({ db, mailer, appUrl });
      if (n) console.log(`トライアル終了のお知らせを ${n} 社に送信しました`);
    } catch (e) {
      console.error("定期処理でエラー:", e);
    }
  };
  run();
  return setInterval(run, 60 * 60 * 1000);
}
