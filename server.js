// 営業AIプラットフォーム:起動用ファイル
// 起動:npm start → ブラウザで http://localhost:3000 を開く
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "./lib/db.js";
import { initSecrets } from "./lib/secrets.js";
import { createApp } from "./lib/app.js";
import { aiEnabled } from "./lib/ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(here, "data");
initSecrets({ dataDir });
const db = new Database(path.join(dataDir, "app.db"));
const app = createApp({ db });

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
  console.log(`${process.env.APP_NAME || "営業AIプラットフォーム"} 起動:http://localhost:${port}`);
  console.log(aiEnabled() ? "AIモード:Claude API に接続します" : "デモモード:ANTHROPIC_API_KEY が未設定のため、AI結果はサンプルを表示します");
  console.log(process.env.ALLOW_SIGNUP === "true" ? "新規登録:受付中(外部販売モード)" : "新規登録:停止中(社内利用モード。メンバーは招待で追加)");
});

// 停止時にデータベースを安全に閉じる
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => { db.db.close(); process.exit(0); }));
}
