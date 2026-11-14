// サービス紹介ページ:サービス名・料金表を、サーバーの設定から表示する
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

(async () => {
  let cfg;
  try {
    cfg = await (await fetch("/api/public-config")).json();
  } catch {
    document.getElementById("plans").innerHTML = `<p class="muted">料金表を読み込めませんでした。</p>`;
    return;
  }
  document.querySelectorAll("[data-app-name]").forEach((el) => (el.textContent = cfg.appName));
  document.title = document.title.replace("営業AIプラットフォーム", cfg.appName);

  // 申し込みを受け付けていない(社内利用のみの)場合は、問い合わせ導線にする
  if (!cfg.allowSignup) {
    document.querySelectorAll("[data-signup]").forEach((a) => {
      a.textContent = "お問い合わせ";
      a.href = cfg.contactEmail ? `mailto:${cfg.contactEmail}` : "/";
    });
    document.querySelector("[data-trial-note]")?.remove();
  }
  if (cfg.contactEmail) {
    document.querySelector("[data-contact]").innerHTML = `ご不明な点は <a href="mailto:${esc(cfg.contactEmail)}">${esc(cfg.contactEmail)}</a> までお気軽にどうぞ。`;
  }

  const yen = (n) => `${Number(n).toLocaleString("ja-JP")}円`;
  const featured = "standard";
  document.getElementById("plans").innerHTML = cfg.plans
    .map((p) => `
      <div class="plan ${p.key === featured ? "featured" : ""}">
        ${p.key === featured ? `<span class="badge">おすすめ</span>` : ""}
        <h3>${esc(p.label)}</h3>
        <p class="price">${p.priceYen === null ? "お見積り" : p.priceYen === 0 ? "無料" : `${yen(p.priceYen)}<small>/月</small>`}</p>
        <ul>
          <li>AI利用 ${p.aiPerMonth === null ? "上限なし" : `月${p.aiPerMonth}回まで`}</li>
          <li>ユーザー ${p.users === null ? "人数無制限" : `${p.users}人まで`}</li>
          <li>Salesforce・HubSpot 連携</li>
          ${p.key === "enterprise" ? "<li>導入支援・個別のご相談</li>" : ""}
        </ul>
        ${p.key === "enterprise"
          ? `<a class="btn ghost" href="${cfg.contactEmail ? `mailto:${esc(cfg.contactEmail)}` : "/"}">相談する</a>`
          : cfg.allowSignup ? `<a class="btn ${p.key === featured ? "primary" : "ghost"}" href="/#signup">${p.key === "trial" ? "無料で始める" : "まずは無料で試す"}</a>` : ""}
      </div>`)
    .join("");
})();
