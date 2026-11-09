// メール送信。SMTP に対応しているサービスなら何でも使えます
// (SendGrid、Amazon SES、Google Workspace、Microsoft 365 など)。
//
// SMTP_HOST が未設定のときは「開発モード」になり、実際には送らずに
// サーバーのログへ内容を表示します(リンクの確認ができます)。
import nodemailer from "nodemailer";

export function createMailer({ transport } = {}) {
  const from = process.env.MAIL_FROM || "営業AIプラットフォーム <no-reply@example.com>";
  let mode = "smtp";
  if (!transport) {
    if (process.env.SMTP_HOST) {
      transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      });
    } else {
      mode = "log";
      transport = {
        sendMail: async (m) => {
          console.log(`\n[メール(開発モード:実際には送信していません)]\n宛先:${m.to}\n件名:${m.subject}\n${m.text}\n`);
          return { messageId: "dev" };
        },
      };
    }
  } else {
    mode = "custom";
  }

  return {
    mode,
    enabled: mode !== "log",
    // 送信に失敗しても、画面の処理は止めない(結果だけ返す)
    async send({ to, subject, text, html }) {
      try {
        await transport.sendMail({ from, to, subject, text, html });
        return { ok: true };
      } catch (e) {
        console.error("メール送信に失敗:", e.message);
        return { ok: false, error: e.message };
      }
    },
  };
}
