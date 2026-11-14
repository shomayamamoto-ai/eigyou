// 営業AIプラットフォーム:起動用ファイル
// 起動:npm start → ブラウザで http://localhost:3000 を開く
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "./lib/db.js";
import { initSecrets } from "./lib/secrets.js";
import { createApp } from "./lib/app.js";
import { aiEnabled } from "./lib/ai.js";
import { createMailer } from "./lib/mailer.js";
import { billingEnabled } from "./lib/billing.js";
import { startJobs } from "./lib/jobs.js";
import { alert } from "./lib/ops.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(here, "data");
initSecrets({ dataDir });
const db = new Database(path.join(dataDir, "app.db"));
const mailer = createMailer();
const app = createApp({ db, deps: { mailer } });

const port = Number(process.env.PORT) || 3000;
const appUrl = (process.env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, "");
const backupDir = process.env.BACKUP_DIR || path.join(dataDir, "backups");
const jobs = startJobs({ db, mailer, appUrl, backupDir });
const server = app.listen(port, () => {
  console.log(`${process.env.APP_NAME || "営業AIプラットフォーム"} 起動:http://localhost:${port}`);
  console.log(aiEnabled() ? "AIモード:Claude API に接続します" : "デモモード:ANTHROPIC_API_KEY が未設定のため、AI結果はサンプルを表示します");
  console.log(mailer.enabled ? "メール:SMTPで送信します" : "メール:SMTP_HOST が未設定のため、送信せずログに表示します");
  console.log(billingEnabled() ? "決済:Stripe に接続します" : "決済:STRIPE_SECRET_KEY が未設定のため、オンライン決済は無効です");
  console.log(process.env.ALLOW_SIGNUP === "true" ? "新規登録:受付中(外部販売モード)" : "新規登録:停止中(社内利用モード。メンバーは招待で追加)");
});

// 想定外のエラーで落ちる前に、運営者へ通知する
process.on("unhandledRejection", (e) => alert("想定外のエラー(unhandledRejection)", e?.stack ?? String(e)));
process.on("uncaughtException", async (e) => {
  await alert("想定外のエラーで停止(uncaughtException)", e?.stack ?? String(e));
  process.exit(1); // コンテナ基盤が自動で再起動する
});

// 停止時にデータベースを安全に閉じる
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    clearInterval(jobs);
    server.close(() => { db.db.close(); process.exit(0); });
  });
}
