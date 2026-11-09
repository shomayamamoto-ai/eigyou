// 外部CRMのトークンなど「秘密情報」を暗号化して保存するための仕組み。
// AES-256-GCM で暗号化し、鍵は環境変数 APP_ENCRYPTION_KEY(32バイトを
// base64 か 16進数で表したもの)から読みます。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let KEY = null;

export function initSecrets({ dataDir }) {
  const env = process.env.APP_ENCRYPTION_KEY;
  if (env) {
    KEY = /^[0-9a-f]{64}$/i.test(env) ? Buffer.from(env, "hex") : Buffer.from(env, "base64");
    if (KEY.length !== 32) throw new Error("APP_ENCRYPTION_KEY は32バイト(16進数64文字)にしてください");
    return;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("本番環境では APP_ENCRYPTION_KEY の設定が必須です");
  }
  // 開発用:鍵ファイルを自動作成(本番では使わない)
  const file = path.join(dataDir, "secret.key");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    console.warn(`[注意] 開発用の暗号鍵を作成しました:${file}`);
  }
  KEY = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
}

export function encrypt(obj) {
  if (!KEY) throw new Error("暗号鍵が初期化されていません");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decrypt(text) {
  if (!KEY) throw new Error("暗号鍵が初期化されていません");
  const [iv, tag, data] = text.split(".").map((s) => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString("utf8"));
}

// 画面に返すときは秘密の値を伏せる
export function mask(value) {
  if (!value) return "";
  const s = String(value);
  return s.length <= 6 ? "******" : `${s.slice(0, 3)}******${s.slice(-3)}`;
}
