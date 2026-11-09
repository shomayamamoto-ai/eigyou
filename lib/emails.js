// メールの文面(テンプレート)
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const appName = () => process.env.APP_NAME || "営業AIプラットフォーム";

// 本文(段落の配列)と、ボタン(任意)から、テキスト版とHTML版を作る
function build({ subject, greeting, paragraphs, button, footer }) {
  const name = appName();
  const text = [
    greeting,
    "",
    ...paragraphs.flatMap((p) => [p, ""]),
    ...(button ? [`${button.label}:`, button.url, ""] : []),
    ...(footer ? [footer, ""] : []),
    "――――――――――――――――",
    name,
    "このメールは送信専用です。心当たりがない場合は、破棄してください。",
  ].join("\n");

  const html = `<!doctype html><html lang="ja"><body style="margin:0;background:#efebe8;font-family:'Hiragino Sans','Noto Sans JP','Meiryo',sans-serif;color:#2a2522">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="font-weight:700;color:#e85d36;margin-bottom:12px">${esc(name)}</div>
    <div style="background:#fff;border-radius:12px;padding:24px;line-height:1.8;font-size:15px">
      <p style="margin:0 0 16px">${esc(greeting)}</p>
      ${paragraphs.map((p) => `<p style="margin:0 0 16px">${esc(p).replace(/\n/g, "<br>")}</p>`).join("")}
      ${button ? `<p style="margin:24px 0;text-align:center"><a href="${esc(button.url)}" style="display:inline-block;background:#e85d36;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700">${esc(button.label)}</a></p>
      <p style="margin:0 0 16px;font-size:12px;color:#6f6762;word-break:break-all">ボタンが押せない場合は、次のURLを開いてください。<br>${esc(button.url)}</p>` : ""}
      ${footer ? `<p style="margin:0;font-size:13px;color:#6f6762">${esc(footer)}</p>` : ""}
    </div>
    <p style="font-size:12px;color:#6f6762;margin-top:16px">このメールは送信専用です。心当たりがない場合は、破棄してください。</p>
  </div></body></html>`;

  return { subject: `【${name}】${subject}`, text, html };
}

export const emails = {
  welcome: ({ name, tenantName, url, trialEndsAt }) =>
    build({
      subject: "ご登録ありがとうございます",
      greeting: `${name} 様`,
      paragraphs: [
        `${appName()} にご登録いただき、ありがとうございます。\n${tenantName} のアカウントを作成しました。`,
        trialEndsAt
          ? `無料トライアルは ${new Date(trialEndsAt).toLocaleDateString("ja-JP")} までご利用いただけます。`
          : "",
        "まずは「設定」で自社のサービス内容を登録すると、AIの提案の精度が上がります。",
      ].filter(Boolean),
      button: { label: "ログインする", url },
    }),

  invite: ({ inviterName, tenantName, url, days }) =>
    build({
      subject: `${tenantName} への招待が届いています`,
      greeting: "こんにちは。",
      paragraphs: [`${inviterName} さんから、${appName()} の「${tenantName}」に招待されました。`, "下のボタンから、お名前とパスワードを設定して参加してください。"],
      button: { label: "招待を受けて参加する", url },
      footer: `このリンクの有効期限は ${days} 日間です。`,
    }),

  passwordReset: ({ name, url, hours }) =>
    build({
      subject: "パスワード再設定のご案内",
      greeting: `${name} 様`,
      paragraphs: ["パスワード再設定のお手続きを受け付けました。", "下のボタンから、新しいパスワードを設定してください。"],
      button: { label: "パスワードを再設定する", url },
      footer: `このリンクの有効期限は ${hours} 時間です。お手続きに心当たりがない場合は、このメールを破棄してください(パスワードは変更されません)。`,
    }),

  trialEnding: ({ name, tenantName, endsAt, url }) =>
    build({
      subject: "無料トライアル終了のお知らせ",
      greeting: `${name} 様`,
      paragraphs: [
        `${tenantName} の無料トライアルは、${new Date(endsAt).toLocaleDateString("ja-JP")} に終了します。`,
        "終了後も引き続きAI機能をご利用いただくには、有料プランへのお申し込みが必要です。登録済みのデータは、そのまま引き継がれます。",
      ],
      button: { label: "プランを申し込む", url },
    }),

  subscribed: ({ name, tenantName, planLabel, url }) =>
    build({
      subject: "お申し込みありがとうございます",
      greeting: `${name} 様`,
      paragraphs: [`${tenantName} の「${planLabel}」プランへのお申し込みが完了しました。`, "請求書・領収書の確認やお支払い方法の変更は、管理画面の「プラン・利用状況」から行えます。"],
      button: { label: "管理画面を開く", url },
    }),

  paymentFailed: ({ name, tenantName, url }) =>
    build({
      subject: "【重要】お支払いが完了しませんでした",
      greeting: `${name} 様`,
      paragraphs: [
        `${tenantName} のご利用料金のお支払いが、完了しませんでした。`,
        "カードの有効期限や利用限度額をご確認のうえ、お支払い方法を更新してください。お支払いが確認できない状態が続くと、ご利用を停止する場合があります。",
      ],
      button: { label: "お支払い方法を更新する", url },
    }),

  canceled: ({ name, tenantName, url }) =>
    build({
      subject: "ご契約終了のお知らせ",
      greeting: `${name} 様`,
      paragraphs: [`${tenantName} のご契約が終了しました。これまでのご利用、ありがとうございました。`, "登録済みのデータは閲覧・ダウンロードできます。再開をご希望の場合は、管理画面からお申し込みください。"],
      button: { label: "管理画面を開く", url },
    }),
};
