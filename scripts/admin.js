// 運営者用の管理コマンド(サーバーに入って実行します)
//   npm run admin -- tenants                      … 契約企業の一覧
//   npm run admin -- set-plan <テナントID> <プラン> … プラン変更(internal/trial/standard/enterprise)
//   npm run admin -- extend-trial <テナントID> <日数>
//   npm run admin -- backup                       … 今すぐバックアップ
//   npm run admin -- backup-status                … 最新のバックアップを確認
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "../lib/db.js";
import { PLANS } from "../lib/plans.js";
import { backupDatabase, latestBackup } from "../lib/ops.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(here, "..", "data");
const db = new Database(path.join(dataDir, "app.db"));
const backupDir = process.env.BACKUP_DIR || path.join(dataDir, "backups");
const [cmd, ...args] = process.argv.slice(2);

if (cmd === "tenants") {
  const month = new Date().toISOString().slice(0, 7);
  console.table(db.listTenants().map((t) => {
    const u = db.usageOf(t.id, month);
    return {
      id: t.id, 会社名: t.name, プラン: PLANS[t.plan]?.label ?? t.plan, ユーザー数: t.users,
      今月AI回数: u.reduce((s, x) => s + x.count, 0),
      今月トークン: u.reduce((s, x) => s + x.input_tokens + x.output_tokens, 0),
      トライアル終了: t.trial_ends_at?.slice(0, 10) ?? "",
    };
  }));
} else if (cmd === "set-plan") {
  const [id, plan] = args;
  if (!PLANS[plan]) throw new Error(`プランは ${Object.keys(PLANS).join(" / ")} のどれかを指定してください`);
  const t = db.updateTenant(id, { plan, trial_ends_at: plan === "trial" ? db.getTenant(id)?.trial_ends_at : null });
  if (!t) throw new Error("テナントが見つかりません");
  db.audit(id, null, "プラン変更(運営者)", PLANS[plan].label);
  console.log(`${t.name} のプランを「${PLANS[plan].label}」に変更しました`);
} else if (cmd === "extend-trial") {
  const [id, days] = args;
  const t = db.getTenant(id);
  if (!t) throw new Error("テナントが見つかりません");
  const base = Math.max(Date.now(), new Date(t.trial_ends_at ?? 0).getTime());
  db.updateTenant(id, { plan: "trial", trial_ends_at: new Date(base + Number(days) * 864e5).toISOString() });
  console.log(`${t.name} のトライアルを ${days} 日延長しました`);
} else if (cmd === "backup") {
  console.log(`バックアップを作成しました:${backupDatabase(db, backupDir)}`);
} else if (cmd === "backup-status") {
  const b = latestBackup(backupDir);
  console.log(b ? `最新:${b.file}(${b.at})/保存数:${b.count}` : "バックアップはまだありません");
} else {
  console.log("使い方:npm run admin -- tenants | set-plan <id> <plan> | extend-trial <id> <days> | backup | backup-status");
}
