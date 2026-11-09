// 営業AIプラットフォーム:画面のふるまい(フレームワークなしの素のJavaScript)
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
let META = { options: { STAGES: [], STATUSES: [], TIERS: [], ROLES: [] }, settings: {} };
const state = { researchId: null, planId: null, crmTab: "companies", meetingId: null, adminTab: "settings" };
const isAdmin = () => ["admin", "owner"].includes(META.user?.role);
const isOwner = () => META.user?.role === "owner";

// ---------- 共通ユーティリティ ----------
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const yen = (n) => (n || n === 0 ? `${Math.round(Number(n)).toLocaleString("ja-JP")}円` : "—");
const man = (n) => (Number(n) >= 10000 ? `${Math.round(Number(n) / 10000).toLocaleString("ja-JP")}` : `${Number(n || 0).toLocaleString("ja-JP")}`);
const manUnit = (n) => (Number(n) >= 10000 ? "万円" : "円");
const fmtDate = (s) => (s ? new Date(s).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" }) : "");
const today = () => new Date().toISOString().slice(0, 10);

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith("/api/auth/")) {
    showAuth("login");
    throw new Error("ログインの有効期限が切れました。もう一度ログインしてください");
  }
  if (!res.ok) throw new Error(data.error || `エラー(${res.status})`);
  return data;
}

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = "toast"), isError ? 5000 : 2600);
}

// ボタンを押している間「処理中」にする
async function busy(btn, label, fn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${esc(label)}`;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

const opts = (list, cur, blank = true) =>
  (blank ? `<option value="">(未選択)</option>` : "") +
  list.map((v) => `<option ${v === cur ? "selected" : ""}>${esc(v)}</option>`).join("");

const stageChip = (s) => {
  const cls = s === "受注" ? "ok" : s === "失注" ? "ng" : ["提案", "交渉"].includes(s) ? "accent" : "";
  return `<span class="chip ${cls}">${esc(s || "—")}</span>`;
};

const PROVIDER_LABEL = { salesforce: "Salesforce", hubspot: "HubSpot" };
const extBadge = (r) => (r.external ? ` <span class="chip" title="外部CRMと連携中">${esc(PROVIDER_LABEL[r.external.source] ?? r.external.source)}</span>` : "");

const list = (items, fmt = (x) => esc(x)) =>
  items?.length ? `<ul class="clean">${items.map((x) => `<li>${fmt(x)}</li>`).join("")}</ul>` : `<p class="muted">なし</p>`;

// ---------- 入力ダイアログ(会社・担当者・商談の追加/編集) ----------
const FORMS = {
  companies: () => [
    ["name", "会社名", "text", true],
    ["industry", "業種"],
    ["tier", "企業規模", META.options.TIERS],
    ["status", "ステータス", META.options.STATUSES],
    ["website", "Webサイト", "url"],
    ["notes", "メモ", "textarea"],
  ],
  contacts: (companies) => [
    ["companyId", "会社", companies.map((c) => [c.id, c.name]), true],
    ["name", "氏名", "text", true],
    ["department", "部署"],
    ["title", "役職"],
    ["role", "役割", META.options.ROLES],
    ["email", "メール", "email"],
    ["phone", "電話", "tel"],
  ],
  deals: (companies) => [
    ["companyId", "会社", companies.map((c) => [c.id, c.name]), true],
    ["title", "案件名", "text", true],
    ["stage", "ステージ", META.options.STAGES],
    ["amount", "金額(円)", "number"],
    ["probability", "確度(%)", "number"],
    ["nextAction", "次のアクション"],
    ["nextActionDate", "次アクション期限", "date"],
    ["closeDate", "受注予定日", "date"],
  ],
};
const LABEL = { companies: "会社", contacts: "担当者", deals: "商談" };

async function openForm(col, record = {}) {
  const companies = col === "companies" ? [] : await api("/api/companies");
  if (col !== "companies" && !companies.length) return toast("先に会社を登録してください", true);
  const fields = FORMS[col](companies);
  $("#dialog-title").textContent = `${LABEL[col]}を${record.id ? "編集" : "追加"}`;
  $("#dialog-body").innerHTML = `<div class="form-grid">${fields
    .map(([k, label, type = "text", required]) => {
      const v = record[k] ?? "";
      const req = required ? "required" : "";
      let input;
      if (Array.isArray(type)) {
        const options = type.map((o) => (Array.isArray(o) ? o : [o, o]));
        input = `<select name="${k}" ${req}>${required ? "" : `<option value="">(未選択)</option>`}${options
          .map(([val, text]) => `<option value="${esc(val)}" ${val === v ? "selected" : ""}>${esc(text)}</option>`)
          .join("")}</select>`;
      } else if (type === "textarea") input = `<textarea name="${k}" style="min-height:80px">${esc(v)}</textarea>`;
      else input = `<input name="${k}" type="${type}" value="${esc(v)}" ${req} />`;
      return `<div ${type === "textarea" ? 'style="grid-column:1/-1"' : ""}><label>${esc(label)}${required ? " *" : ""}</label>${input}</div>`;
    })
    .join("")}</div>`;
  const dlg = $("#dialog");
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.onclose = async () => {
      if (dlg.returnValue !== "ok") return resolve(null);
      const body = Object.fromEntries(new FormData($("#dialog-form")));
      try {
        const saved = await api(record.id ? `/api/${col}/${record.id}` : `/api/${col}`, { method: record.id ? "PUT" : "POST", body });
        toast("保存しました");
        resolve(saved);
      } catch (e) {
        toast(e.message, true);
        resolve(null);
      }
    };
  });
}

// =====================================================
// ホーム
// =====================================================
async function renderHome() {
  const d = await api("/api/dashboard");
  const maxCount = Math.max(1, ...d.byStage.map((s) => s.count));
  const qChip = d.quality.score >= 80 ? "ok" : d.quality.score >= 50 ? "warn" : "ng";
  view.innerHTML = `
    <section class="card" style="background:#f6f3f1">
      <div class="cycle">
        <div class="center"><div><b>営業AI</b><span>プラットフォーム</span></div></div>
        <a class="p1" href="#research">リサーチ<small>調査 ${d.counts.researched}社</small></a>
        <a class="p2" href="#enterprise">大手開拓<small>大手 ${d.counts.enterprise}社</small></a>
        <a class="p3" href="#crm">CRM整備<small>品質 ${d.quality.score}点</small></a>
        <a class="p4" href="#meeting">商談分析<small>記録 ${d.counts.meetings}件</small></a>
      </div>
      <p class="muted" style="text-align:center;margin:0">
        リサーチで集めた情報が大手開拓の戦略になり、<br class="hide-sm" />
        商談分析の結果がCRMに戻って、次のリサーチに生きる。<br class="hide-sm" />
        この流れを1つの画面で回します。
      </p>
    </section>

    ${d.counts.companies === 0 ? `
      <section class="card empty" style="margin-top:16px">
        <p>まだデータがありません。<br />まずはサンプルデータで動きを試してみましょう。</p>
        ${isAdmin() ? `<button class="btn primary" id="seed">サンプルデータを入れる</button>` : ""}
        ${isAdmin() && !META.integrations.length ? `<p class="muted" style="margin-top:12px">Salesforce・HubSpot をお使いなら、<a href="#admin">管理 → 外部CRM連携</a> から<br />データをまとめて取り込めます。</p>` : ""}
      </section>` : ""}

    <section class="grid grid-kpi" style="margin-top:16px">
      <div class="card kpi"><div class="label">登録企業</div><div class="value">${d.counts.companies}<small>社</small></div></div>
      <div class="card kpi"><div class="label">担当者</div><div class="value">${d.counts.contacts}<small>人</small></div></div>
      <div class="card kpi"><div class="label">進行中の商談</div><div class="value">${d.counts.openDeals}<small>件</small></div></div>
      <div class="card kpi"><div class="label">パイプライン総額</div><div class="value">${man(d.pipelineAmount)}<small>${manUnit(d.pipelineAmount)}</small></div></div>
      <div class="card kpi"><div class="label">確度加味の見込額</div><div class="value">${man(d.weightedAmount)}<small>${manUnit(d.weightedAmount)}</small></div></div>
      <div class="card kpi"><div class="label">CRMデータ品質</div><div class="value">${d.quality.score}<small>点</small></div><span class="chip ${qChip}">要対応 ${d.quality.issueCount}件</span></div>
    </section>

    <section class="grid grid-2" style="margin-top:16px">
      <div class="card">
        <h3>ステージ別の商談</h3>
        <div class="pipeline">
          ${d.byStage.map((s) => `
            <div class="bar"><span>${esc(s.stage)}</span>
              <div class="track"><i style="width:${(s.count / maxCount) * 100}%"></i></div>
              <span class="muted">${s.count}件</span></div>`).join("")}
        </div>
      </div>
      <div class="card">
        <h3>次のアクション(期限順)</h3>
        ${d.upcoming.length ? `<div class="table-wrap"><table><tbody>${d.upcoming.map((u) => `
          <tr><td style="white-space:nowrap">${u.nextActionDate && u.nextActionDate < today() ? `<span class="chip ng">${esc(u.nextActionDate)}</span>` : esc(u.nextActionDate || "期限なし")}</td>
          <td><b>${esc(u.companyName)}</b><br /><span class="muted">${esc(u.title)}</span></td>
          <td>${esc(u.nextAction)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">予定はありません</p>`}
      </div>
    </section>`;
  $("#seed")?.addEventListener("click", (e) =>
    busy(e.currentTarget, "登録中", async () => {
      await api("/api/seed", { method: "POST" });
      toast("サンプルデータを登録しました");
      renderHome();
    }),
  );
}

// =====================================================
// ① リサーチ
// =====================================================
async function renderResearch() {
  const companies = await api("/api/companies");
  if (!state.researchId || !companies.some((c) => c.id === state.researchId)) state.researchId = companies[0]?.id ?? null;
  const cur = companies.find((c) => c.id === state.researchId);
  const r = cur?.research;

  view.innerHTML = `
    <h2>リサーチ</h2>
    <p class="lead">会社を選んで「AIでリサーチ」を押すと、Web上の公開情報から<br class="hide-sm" />
      事業内容・最新ニュース・想定課題・初回商談の質問案をまとめます。</p>
    <div class="grid grid-2" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))">
      <div class="card">
        <div class="row between"><h3 style="margin:0">企業リスト</h3><button class="btn small primary" id="add-co">+ 会社を追加</button></div>
        ${companies.length ? `<div class="table-wrap" style="margin-top:8px"><table><tbody>${companies.map((c) => `
          <tr class="clickable ${c.id === state.researchId ? "selected" : ""}" data-id="${c.id}">
            <td><b>${esc(c.name)}</b><br /><span class="muted">${esc(c.industry || "業種未設定")}</span></td>
            <td class="num">${c.research ? `<span class="chip ok">調査済</span>` : `<span class="chip">未調査</span>`}</td>
          </tr>`).join("")}</tbody></table></div>` : `<p class="empty">会社が登録されていません</p>`}
      </div>
      <div class="card" style="grid-column:span 1; min-width:0">
        ${cur ? `
          <div class="row between">
            <div><h3 style="margin:0">${esc(cur.name)}</h3>
              <span class="muted">${r ? `最終調査:${fmtDate(r.generatedAt)}` : "まだ調査していません"}</span></div>
            <button class="btn primary" id="run">${r ? "再リサーチ" : "AIでリサーチ"}</button>
          </div>
          ${r ? researchHtml(r) : `<p class="empty">右上のボタンで調査を開始します。<br />(Web検索を行うため、1〜3分ほどかかります)</p>`}
        ` : `<p class="empty">左のリストから会社を選んでください</p>`}
      </div>
    </div>`;

  view.querySelectorAll("tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => { state.researchId = tr.dataset.id; renderResearch(); }),
  );
  $("#add-co").addEventListener("click", async () => {
    const c = await openForm("companies", { tier: "大手", status: "未接触" });
    if (c) { state.researchId = c.id; renderResearch(); }
  });
  $("#run")?.addEventListener("click", (e) =>
    busy(e.currentTarget, "調査中…", async () => {
      await api(`/api/research/${cur.id}`, { method: "POST" });
      toast("リサーチが完了しました");
      renderResearch();
    }),
  );
}

function researchHtml(r) {
  return `
    ${r.demo ? `<p class="notice" style="margin-top:12px">デモモードの結果です(架空のサンプル)。<br />設定タブの手順でAPIキーを設定すると、実際の調査結果になります。</p>` : ""}
    <h4>概要</h4><p style="margin:0">${esc(r.summary)}</p>
    <p class="muted" style="margin:6px 0 0">規模感:${esc(r.scale)}</p>
    <h4>主な事業</h4>${list(r.business)}
    <h4>最近の動き</h4>${list(r.recentNews, (n) => `<b>${esc(n.date)}</b> ${esc(n.title)}<br /><span class="muted">→ ${esc(n.point)}</span>`)}
    <h4>想定される課題</h4>${list(r.challenges, (c) => `${esc(c.text)} <span class="chip ${c.basis === "事実" ? "ok" : "warn"}">${esc(c.basis)}</span>`)}
    <h4>提案の切り口</h4>${list(r.opportunities)}
    <h4>初回商談で聞くこと</h4>${list(r.keyQuestions)}
    ${r.sources?.length ? `<h4>出典</h4>${list(r.sources.slice(0, 12), (s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>`)}` : ""}
    <div class="row" style="margin-top:16px"><a class="btn ghost" href="#enterprise">この情報で大手開拓プランを作る →</a></div>`;
}

// =====================================================
// ② 大手開拓
// =====================================================
async function renderEnterprise() {
  const targets = await api("/api/targets");
  if (!state.planId || !targets.some((c) => c.id === state.planId)) state.planId = (targets.find((t) => t.tier === "大手") ?? targets[0])?.id ?? null;
  const cur = targets.find((c) => c.id === state.planId);
  const p = cur?.accountPlan;

  view.innerHTML = `
    <h2>大手開拓</h2>
    <p class="lead">攻める優先度の高い順に並べています。会社を選んで「開拓プランを作成」を押すと、<br class="hide-sm" />
      キーパーソンの仮説・アプローチ手順・初回メール文面までAIが作ります。</p>
    <section class="card">
      <h3>ターゲット企業(優先度順)</h3>
      ${targets.length ? `<div class="table-wrap"><table>
        <thead><tr><th>会社</th><th>規模</th><th class="hide-sm">ステータス</th><th>担当者</th><th style="min-width:110px">優先度</th></tr></thead>
        <tbody>${targets.map((t) => `
          <tr class="clickable ${t.id === state.planId ? "selected" : ""}" data-id="${t.id}">
            <td><b>${esc(t.name)}</b>${t.accountPlan ? ` <span class="chip ok">プラン有</span>` : ""}</td>
            <td><span class="chip ${t.tier === "大手" ? "accent" : ""}">${esc(t.tier || "—")}</span></td>
            <td class="hide-sm">${esc(t.status || "—")}</td>
            <td>${t.contactCount}人${t.hasDecisionMaker ? ` <span class="chip ok">決裁者</span>` : ""}</td>
            <td><div class="row" style="flex-wrap:nowrap"><div class="score-bar" style="flex:1"><i style="width:${t.score}%"></i></div><b>${t.score}</b></div></td>
          </tr>`).join("")}</tbody></table></div>
        <p class="muted" style="margin:8px 0 0">優先度は「企業規模・決裁者との接点・進行中の商談・リサーチ有無」から自動計算した目安です。</p>`
        : `<p class="empty">会社が登録されていません</p>`}
    </section>

    ${cur ? `
    <section class="card" style="margin-top:16px">
      <div class="row between">
        <div><h3 style="margin:0">${esc(cur.name)} の開拓プラン</h3>
          <span class="muted">${p ? `作成:${fmtDate(p.generatedAt)}` : cur.research ? "リサーチ結果を使って作成します" : "先にリサーチしておくと精度が上がります"}</span></div>
        <div class="row">
          ${cur.research ? "" : `<a class="btn ghost" href="#research">先にリサーチ</a>`}
          <button class="btn primary" id="run">${p ? "作り直す" : "開拓プランを作成"}</button>
        </div>
      </div>
      ${p ? planHtml(p) : ""}
    </section>` : ""}`;

  view.querySelectorAll("tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => { state.planId = tr.dataset.id; renderEnterprise(); }),
  );
  $("#run")?.addEventListener("click", (e) =>
    busy(e.currentTarget, "作成中…", async () => {
      await api(`/api/account-plan/${cur.id}`, { method: "POST" });
      toast("開拓プランを作成しました");
      renderEnterprise();
    }),
  );
  $("#copy-mail")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`件名:${p.email.subject}\n\n${p.email.body}`);
      toast("メール文面をコピーしました");
    } catch {
      toast("コピーできませんでした。手動で選択してください", true);
    }
  });
}

function planHtml(p) {
  return `
    ${p.demo ? `<p class="notice" style="margin-top:12px">デモモードの結果です(架空のサンプル)。</p>` : ""}
    <h4>今アプローチすべき理由</h4><p style="margin:0">${esc(p.whyNow)}</p>
    <h4>意思決定プロセスの仮説</h4><p style="margin:0">${esc(p.decisionProcess)}</p>
    <h4>キーパーソン(仮説)</h4>
    <div class="table-wrap"><table><thead><tr><th>部署・役職</th><th>役割</th><th>関心ごと</th><th>アプローチ</th></tr></thead>
      <tbody>${p.keyPersons.map((k) => `<tr><td>${esc(k.position)}</td><td><span class="chip accent">${esc(k.role)}</span></td><td>${esc(k.concerns)}</td><td>${esc(k.approach)}</td></tr>`).join("")}</tbody></table></div>
    <h4>接点を作る入り口</h4>${list(p.entryPoints)}
    <h4>アプローチ手順</h4>
    <div class="table-wrap"><table><thead><tr><th>フェーズ</th><th>やること</th><th>時期</th><th>目標</th></tr></thead>
      <tbody>${p.steps.map((s) => `<tr><td>${esc(s.phase)}</td><td>${esc(s.action)}</td><td>${esc(s.timing)}</td><td>${esc(s.kpi)}</td></tr>`).join("")}</tbody></table></div>
    <h4>初回アプローチメール</h4>
    <div class="pre"><b>件名:${esc(p.email.subject)}</b>\n\n${esc(p.email.body)}</div>
    <div class="row" style="margin-top:8px"><button class="btn small ghost" id="copy-mail">文面をコピー</button></div>
    <h4>リスクと対策</h4>${list(p.risks, (r) => `${esc(r.risk)}<br /><span class="muted">→ ${esc(r.countermeasure)}</span>`)}`;
}

// =====================================================
// ③ CRM整備
// =====================================================
async function renderCrm() {
  const [q, companies, contacts, deals] = await Promise.all([
    api("/api/crm/quality"), api("/api/companies"), api("/api/contacts"), api("/api/deals"),
  ]);
  const coName = (id) => companies.find((c) => c.id === id)?.name ?? "(不明)";
  const sevChip = { high: ["ng", "重要"], medium: ["warn", "注意"], low: ["", "軽微"] };
  const tab = state.crmTab;

  const tables = {
    companies: () => `<table><thead><tr><th>会社名</th><th>業種</th><th>規模</th><th>ステータス</th><th></th></tr></thead><tbody>
      ${companies.map((c) => `<tr><td><b>${esc(c.name)}</b>${extBadge(c)}</td><td>${esc(c.industry)}</td><td>${esc(c.tier)}</td><td>${esc(c.status)}</td>
        <td class="num"><button class="btn small ghost" data-edit="companies" data-id="${c.id}">編集</button> <button class="btn small danger" data-del="companies" data-id="${c.id}">削除</button></td></tr>`).join("")}</tbody></table>`,
    contacts: () => `<table><thead><tr><th>氏名</th><th>会社</th><th>部署・役職</th><th>役割</th><th>連絡先</th><th></th></tr></thead><tbody>
      ${contacts.map((p) => `<tr><td><b>${esc(p.name)}</b>${extBadge(p)}</td><td>${esc(coName(p.companyId))}</td><td>${esc(p.department)} ${esc(p.title)}</td><td>${esc(p.role)}</td>
        <td>${esc(p.email)}<br />${esc(p.phone)}</td>
        <td class="num"><button class="btn small ghost" data-edit="contacts" data-id="${p.id}">編集</button> <button class="btn small danger" data-del="contacts" data-id="${p.id}">削除</button></td></tr>`).join("")}</tbody></table>`,
    deals: () => `<table><thead><tr><th>案件</th><th>会社</th><th>ステージ</th><th>金額</th><th>確度</th><th>次アクション</th><th></th></tr></thead><tbody>
      ${deals.map((d) => `<tr><td><b>${esc(d.title)}</b>${extBadge(d)}${d.external ? `<br /><button class="btn small ghost" data-push="${d.id}" style="margin-top:4px">${esc(PROVIDER_LABEL[d.external.source] ?? "")}へ送る</button>` : ""}</td><td>${esc(coName(d.companyId))}</td><td>${stageChip(d.stage)}</td>
        <td class="num">${yen(d.amount)}</td><td class="num">${d.probability ?? "—"}%</td><td>${esc(d.nextAction)}<br /><span class="muted">${esc(d.nextActionDate)}</span></td>
        <td class="num"><button class="btn small ghost" data-edit="deals" data-id="${d.id}">編集</button> <button class="btn small danger" data-del="deals" data-id="${d.id}">削除</button></td></tr>`).join("")}</tbody></table>`,
  };
  const all = { companies, contacts, deals };

  view.innerHTML = `
    <h2>CRM整備</h2>
    <p class="lead">データの重複・未入力・期限切れを自動で見つけて直します。<br class="hide-sm" />
      名刺やメール署名を貼り付ければ、AIが項目を読み取って登録します。</p>

    <div class="grid grid-2">
      <section class="card">
        <div class="row between"><h3 style="margin:0">データ品質チェック</h3>
          <span class="chip ${q.score >= 80 ? "ok" : q.score >= 50 ? "warn" : "ng"}" style="font-size:.9rem">${q.score}点 / 100</span></div>
        <div style="margin-top:8px;max-height:420px;overflow:auto">
          ${q.issues.length ? q.issues.map((i, n) => `
            <div class="issue">
              <div><span class="chip ${sevChip[i.severity][0]}">${sevChip[i.severity][1]}</span> ${esc(i.message)}</div>
              ${i.fix ? `<button class="btn small primary" data-fix="${n}">${i.fix === "merge" ? "統合" : "修正"}</button>` : ""}
            </div>`).join("") : `<p class="empty">問題は見つかりませんでした</p>`}
        </div>
      </section>

      <section class="card">
        <h3>AIで取り込み(名刺・署名・メモ)</h3>
        <textarea id="ext-text" placeholder="例)&#10;株式会社〇〇&#10;営業企画部 部長&#10;山田 太郎&#10;yamada@example.co.jp / 03-1234-5678&#10;来月、営業支援ツールの比較検討を始めるとのこと"></textarea>
        <div class="row" style="margin-top:8px"><button class="btn primary" id="ext-run">読み取る</button></div>
        <div id="ext-result"></div>
      </section>
    </div>

    <section class="card" style="margin-top:16px">
      <div class="row between">
        <div class="row">
          ${["companies", "contacts", "deals"].map((c) => `<button class="btn small ${tab === c ? "primary" : "ghost"}" data-tab="${c}">${LABEL[c]}(${all[c].length})</button>`).join("")}
        </div>
        <div class="row">
          <button class="btn small primary" id="add">+ ${LABEL[tab]}を追加</button>
          <a class="btn small ghost" href="/api/export/${tab}">CSV出力</a>
          <label class="btn small ghost" style="margin:0">CSV取込<input type="file" accept=".csv,text/csv" id="csv" hidden /></label>
        </div>
      </div>
      <div class="table-wrap" style="margin-top:10px">${all[tab].length ? tables[tab]() : `<p class="empty">データがありません</p>`}</div>
    </section>`;

  view.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { state.crmTab = b.dataset.tab; renderCrm(); }));
  view.querySelectorAll("[data-fix]").forEach((b) =>
    b.addEventListener("click", () => busy(b, "", async () => {
      await api("/api/crm/fix", { method: "POST", body: q.issues[Number(b.dataset.fix)] });
      toast("修正しました");
      renderCrm();
    })),
  );
  view.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", async () => {
      const rec = all[b.dataset.edit].find((x) => x.id === b.dataset.id);
      if (await openForm(b.dataset.edit, rec)) renderCrm();
    }),
  );
  view.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      const extra = b.dataset.del === "companies" ? "\n(ひもづく担当者・商談・議事録も削除されます)" : "";
      if (!confirm(`削除してよろしいですか?${extra}`)) return;
      await api(`/api/${b.dataset.del}/${b.dataset.id}`, { method: "DELETE" });
      toast("削除しました");
      renderCrm();
    }),
  );
  $("#add").addEventListener("click", async () => { if (await openForm(tab)) renderCrm(); });
  view.querySelectorAll("[data-push]").forEach((b) =>
    b.addEventListener("click", () => busy(b, "送信中", async () => {
      await api(`/api/integrations/push/${b.dataset.push}`, { method: "POST" });
      toast("外部CRMの商談を更新しました");
    })),
  );
  $("#csv").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const r = await api(`/api/import/${tab}`, { method: "POST", body: { csv: await file.text() } });
      toast(`取り込み完了:会社${r.companies}件・担当者${r.contacts}件・商談${r.deals}件`);
      renderCrm();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#ext-run").addEventListener("click", (e) =>
    busy(e.currentTarget, "読み取り中…", async () => {
      const r = await api("/api/crm/extract", { method: "POST", body: { text: $("#ext-text").value } });
      showExtract(r);
    }),
  );
}

function showExtract(r) {
  const box = $("#ext-result");
  const total = r.companies.length + r.contacts.length + r.deals.length;
  box.innerHTML = `
    <h4>読み取り結果(確認してから登録)</h4>
    ${r.demo ? `<p class="notice">デモモード:メール・電話・会社名らしき行だけを機械的に拾っています。</p>` : ""}
    ${r.companies.length ? `<p style="margin:4px 0"><b>会社</b></p>${list(r.companies, (c) => `${esc(c.name)} <span class="muted">${esc(c.industry)} ${esc(c.tier)}</span>`)}` : ""}
    ${r.contacts.length ? `<p style="margin:8px 0 4px"><b>担当者</b></p>${list(r.contacts, (p) => `${esc(p.name)}(${esc(p.companyName)} ${esc(p.department)} ${esc(p.title)})<br /><span class="muted">${esc(p.email)} ${esc(p.phone)} / ${esc(p.role)}</span>`)}` : ""}
    ${r.deals.length ? `<p style="margin:8px 0 4px"><b>商談</b></p>${list(r.deals, (d) => `${esc(d.title)}(${esc(d.companyName)}) ${stageChip(d.stage)} ${yen(d.amount)}`)}` : ""}
    ${total ? `<div class="row" style="margin-top:10px"><button class="btn primary" id="ext-save">この内容で登録</button></div>` : `<p class="muted">登録できる情報が見つかりませんでした。</p>`}`;
  $("#ext-save")?.addEventListener("click", (e) =>
    busy(e.currentTarget, "登録中…", async () => {
      const res = await api("/api/crm/import", { method: "POST", body: r });
      toast(`登録しました(新規の会社${res.companies}・担当者${res.contacts}・商談${res.deals}、既存会社にひもづけ${res.linked})`);
      renderCrm();
    }),
  );
}

// =====================================================
// ④ 商談分析
// =====================================================
async function renderMeeting() {
  const [deals, companies, meetings] = await Promise.all([api("/api/deals"), api("/api/companies"), api("/api/meetings")]);
  const coName = (id) => companies.find((c) => c.id === id)?.name ?? "";
  const dealName = (id) => { const d = deals.find((x) => x.id === id); return d ? `${coName(d.companyId)}|${d.title}` : "(商談未選択)"; };
  const sorted = [...meetings].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const cur = meetings.find((m) => m.id === state.meetingId);

  view.innerHTML = `
    <h2>商談分析</h2>
    <p class="lead">商談の議事録や文字起こしを貼り付けると、要約・BANT・受注確度・次のアクション・<br class="hide-sm" />
      お礼メールまで作成します。結果はワンクリックでCRMに反映できます。</p>

    <div class="grid grid-2">
      <section class="card">
        <h3>議事録を分析する</h3>
        <div class="form-grid">
          <div><label>対象の商談</label><select id="m-deal"><option value="">(商談にひもづけない)</option>
            ${deals.map((d) => `<option value="${d.id}">${esc(coName(d.companyId))}|${esc(d.title)}</option>`).join("")}</select></div>
          <div><label>商談日</label><input type="date" id="m-date" value="${today()}" /></div>
        </div>
        <label>議事録・文字起こし</label>
        <textarea id="m-text" style="min-height:220px" placeholder="例)&#10;営業:本日はありがとうございます。現在の営業報告はどのようにされていますか?&#10;顧客:Excelで日報を出していて、1日30分くらいかかっています…"></textarea>
        <div class="row" style="margin-top:8px"><button class="btn primary" id="m-run">AIで分析</button></div>
      </section>

      <section class="card">
        <h3>分析履歴</h3>
        ${sorted.length ? `<div class="table-wrap"><table><tbody>${sorted.map((m) => `
          <tr class="clickable ${m.id === state.meetingId ? "selected" : ""}" data-id="${m.id}">
            <td style="white-space:nowrap">${esc(m.date)}</td>
            <td>${esc(dealName(m.dealId))}</td>
            <td class="num"><b>${Math.round(m.analysis.winProbability)}%</b>${m.applied ? `<br /><span class="chip ok">反映済</span>` : ""}</td>
          </tr>`).join("")}</tbody></table></div>` : `<p class="empty">まだ分析した商談はありません</p>`}
      </section>
    </div>
    <div id="m-result">${cur ? meetingHtml(cur, dealName(cur.dealId)) : ""}</div>`;

  view.querySelectorAll("tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => { state.meetingId = tr.dataset.id; renderMeeting(); }),
  );
  $("#m-run").addEventListener("click", (e) =>
    busy(e.currentTarget, "分析中…", async () => {
      const m = await api("/api/meetings/analyze", {
        method: "POST",
        body: { dealId: $("#m-deal").value || null, date: $("#m-date").value, transcript: $("#m-text").value },
      });
      state.meetingId = m.id;
      toast("分析が完了しました");
      await renderMeeting();
      $("#m-result").scrollIntoView({ behavior: "smooth" });
    }),
  );
  bindMeetingActions(cur);
}

function meetingHtml(m, dealLabel) {
  const a = m.analysis;
  const bantLabel = { budget: "予算(Budget)", authority: "決裁者(Authority)", need: "必要性(Need)", timeline: "導入時期(Timeline)" };
  const bChip = { 確認済: "ok", 一部確認: "warn", 未確認: "ng" };
  const u = a.crmUpdate;
  return `
    <section class="card" style="margin-top:16px">
      <div class="row between">
        <div><h3 style="margin:0">分析結果:${esc(dealLabel)}</h3><span class="muted">${esc(m.date)} の商談</span></div>
        <div style="text-align:right"><div class="muted">受注確度</div><div style="font-size:1.8rem;font-weight:700;color:var(--accent)">${Math.round(a.winProbability)}%</div></div>
      </div>
      ${a.demo ? `<p class="notice">デモモードの結果です(架空のサンプル)。</p>` : ""}
      <h4>要約</h4><p style="margin:0">${esc(a.summary)}</p>
      <p class="muted" style="margin:6px 0 0">確度の根拠:${esc(a.probabilityReason)}</p>

      <div class="grid grid-2" style="margin-top:4px">
        <div>
          <h4>BANT</h4>
          <div class="table-wrap"><table><tbody>${Object.entries(bantLabel).map(([k, label]) => `
            <tr><td style="white-space:nowrap">${label}</td><td><span class="chip ${bChip[a.bant[k].status]}">${esc(a.bant[k].status)}</span></td><td>${esc(a.bant[k].detail)}</td></tr>`).join("")}</tbody></table></div>
          <h4>顧客の課題</h4>${list(a.customerIssues)}
          <h4>失注リスクの兆候</h4>${list(a.riskSignals)}
        </div>
        <div>
          <h4>次のアクション</h4>
          <div class="table-wrap"><table><tbody>${a.nextActions.map((n) => `<tr><td>${esc(n.task)}</td><td><span class="chip">${esc(n.owner)}</span></td><td style="white-space:nowrap">${esc(n.due)}</td></tr>`).join("")}</tbody></table></div>
          <h4>営業コーチング</h4>
          <p style="margin:0 0 4px"><b>良かった点</b></p>${list(a.coaching.good)}
          <p style="margin:8px 0 4px"><b>改善点</b></p>${list(a.coaching.improve)}
        </div>
      </div>

      <h4>CRMへの反映内容</h4>
      <div class="pre">ステージ:${esc(u.stage)}
確度:${Math.round(a.winProbability)}%
金額:${u.amount ? yen(u.amount) : "変更なし"}
次アクション:${esc(u.nextAction)}(${esc(u.nextActionDate || "期限なし")})</div>
      <div class="row" style="margin-top:8px">
        ${m.dealId ? `<button class="btn primary" id="apply" ${m.applied ? "disabled" : ""}>${m.applied ? "CRMに反映済み" : "CRMに反映する"}</button>` : `<span class="muted">商談にひもづけると、CRMへ反映できます。</span>`}
      </div>

      <h4>お礼・フォローメール</h4>
      <div class="pre"><b>件名:${esc(a.followupEmail.subject)}</b>\n\n${esc(a.followupEmail.body)}</div>
      <div class="row" style="margin-top:8px"><button class="btn small ghost" id="copy-follow">文面をコピー</button></div>
    </section>`;
}

function bindMeetingActions(m) {
  if (!m) return;
  $("#apply")?.addEventListener("click", (e) =>
    busy(e.currentTarget, "反映中…", async () => {
      const r = await api(`/api/meetings/${m.id}/apply`, { method: "POST" });
      if (r.pushed?.ok) toast(`CRMを更新し、${r.pushed.provider}にも反映しました`);
      else if (r.pushed) toast(`CRMは更新しましたが、${r.pushed.provider}への反映に失敗しました:${r.pushed.error}`, true);
      else toast("CRMの商談情報を更新しました");
      renderMeeting();
    }),
  );
  $("#copy-follow")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`件名:${m.analysis.followupEmail.subject}\n\n${m.analysis.followupEmail.body}`);
      toast("メール文面をコピーしました");
    } catch {
      toast("コピーできませんでした", true);
    }
  });
}


// =====================================================
// 管理(管理者・オーナーのみ)
// =====================================================
const ADMIN_TABS = [
  ["settings", "自社サービス"],
  ["integrations", "外部CRM連携"],
  ["members", "メンバー"],
  ["usage", "プラン・利用状況"],
  ["audit", "操作ログ"],
  ["data", "データ管理"],
];

async function renderAdmin() {
  if (!isAdmin()) {
    view.innerHTML = `<p class="card empty">この画面は管理者だけが利用できます。</p>`;
    return;
  }
  const tabs = ADMIN_TABS.filter(([k]) => k !== "data" || isOwner());
  if (!tabs.some(([k]) => k === state.adminTab)) state.adminTab = "settings";
  view.innerHTML = `
    <h2>管理</h2>
    <p class="lead">${esc(META.tenant.name)} の設定です。</p>
    <div class="section-nav">${tabs.map(([k, label]) => `<button class="btn small ${k === state.adminTab ? "primary" : "ghost"}" data-sec="${k}">${label}</button>`).join("")}</div>
    <div id="admin-body"></div>`;
  view.querySelectorAll("[data-sec]").forEach((b) => b.addEventListener("click", () => { state.adminTab = b.dataset.sec; renderAdmin(); }));
  const body = $("#admin-body");
  await ADMIN_RENDER[state.adminTab](body);
}

const ADMIN_RENDER = {
  async settings(body) {
    body.innerHTML = `
      <section class="card">
        <h3>自社の提供サービス</h3>
        <p class="muted" style="margin-top:0">ここに書いた内容をもとに、AIが「提案の切り口」や「開拓プラン」を考えます。<br class="hide-sm" />
          具体的に書くほど精度が上がります。</p>
        <textarea id="offering" style="min-height:120px" maxlength="3000" placeholder="例)営業活動を記録・分析するクラウド型の営業支援サービス。強みは…">${esc(META.settings.offering)}</textarea>
        <div class="row" style="margin-top:8px"><button class="btn primary" id="save">保存</button></div>
      </section>
      <section class="card" style="margin-top:16px">
        <h3>AIの接続状態</h3>
        <p style="margin:0">${META.aiEnabled ? `<span class="chip ok">接続済み</span>` : `<span class="chip warn">デモモード</span> AIのAPIキーが設定されていないため、AIの結果はサンプル表示です。<br />サービスの運営者にお問い合わせください。`}</p>
      </section>`;
    $("#save").addEventListener("click", (e) =>
      busy(e.currentTarget, "保存中", async () => {
        await api("/api/settings", { method: "PUT", body: { offering: $("#offering").value } });
        META.settings.offering = $("#offering").value;
        toast("保存しました");
      }),
    );
  },

  async integrations(body) {
    const list = await api("/api/integrations");
    const guide = {
      salesforce: `Salesforce の「設定 → アプリケーションマネージャー」で接続アプリケーションを作成し、<br class="hide-sm" />
        「OAuth 2.0 クライアントログイン情報フロー」を有効にして、実行ユーザーを指定してください。`,
      hubspot: `HubSpot の「設定 → 連携 → 非公開アプリ」でアプリを作成し、<br class="hide-sm" />
        会社・コンタクト・取引の読み取りと、取引の書き込みの権限(スコープ)を付けてください。`,
    };
    body.innerHTML = `
      <section class="card">
        <h3>外部CRM連携</h3>
        <p class="muted" style="margin-top:0">お使いのCRMから会社・担当者・商談を取り込み、商談分析の結果を書き戻せます。<br class="hide-sm" />
          接続情報は暗号化して保存され、画面には一部を伏せて表示します。</p>
        ${list.map((it) => `
          <div class="integration" data-provider="${it.provider}">
            <div class="row between">
              <h3 style="margin:0">${esc(it.label)}</h3>
              ${it.connected ? `<span class="chip ok">接続済み</span>` : `<span class="chip">未接続</span>`}
            </div>
            <p class="muted" style="margin:6px 0 0">${guide[it.provider] ?? ""}</p>
            <form class="form-grid" data-form>
              ${it.fields.map((f) => `<div><label>${esc(f.label)}</label>
                <input name="${f.key}" ${f.secret ? 'type="password" autocomplete="new-password"' : 'type="text"'}
                  value="${f.secret ? "" : esc(it.config[f.key] ?? "")}" placeholder="${f.secret && it.connected ? `設定済み(${esc(it.config[f.key])})。変更時のみ入力` : esc(f.placeholder ?? "")}" /></div>`).join("")}
            </form>
            <label class="check"><input type="checkbox" data-autopush ${it.options.autoPush ? "checked" : ""} />
              商談分析を「CRMに反映」したとき、${esc(it.label)} の商談にも自動で書き戻す</label>
            <div class="row" style="margin-top:10px">
              <button class="btn primary small" data-act="save">${it.connected ? "更新" : "接続する"}</button>
              ${it.connected ? `
                <button class="btn ghost small" data-act="test">接続テスト</button>
                <button class="btn ghost small" data-act="sync">今すぐ取り込み</button>
                <button class="btn danger small" data-act="delete">接続解除</button>` : ""}
            </div>
            ${it.lastSyncAt ? `<p class="muted" style="margin:8px 0 0">最終取り込み:${fmtDate(it.lastSyncAt)}
              (会社 追加${it.lastResult.companies.added}・更新${it.lastResult.companies.updated} /
              担当者 追加${it.lastResult.contacts.added}・更新${it.lastResult.contacts.updated} /
              商談 追加${it.lastResult.deals.added}・更新${it.lastResult.deals.updated})</p>` : ""}
          </div>`).join("")}
        <p class="muted" style="margin:12px 0 0">ステージの対応:標準のフェーズ(Salesforce)/標準パイプライン(HubSpot)に合わせて自動で変換します。</p>
      </section>`;

    body.querySelectorAll("[data-provider]").forEach((box) => {
      const provider = box.dataset.provider;
      box.querySelectorAll("[data-act]").forEach((btn) =>
        btn.addEventListener("click", () => busy(btn, "", async () => {
          const act = btn.dataset.act;
          if (act === "save") {
            const config = Object.fromEntries(new FormData(box.querySelector("[data-form]")));
            await api(`/api/integrations/${provider}`, { method: "PUT", body: { config, options: { autoPush: box.querySelector("[data-autopush]").checked } } });
            toast("保存しました。「接続テスト」で確認してください");
          } else if (act === "test") {
            await api(`/api/integrations/${provider}/test`, { method: "POST" });
            toast("接続に成功しました");
            return;
          } else if (act === "sync") {
            const r = await api(`/api/integrations/${provider}/sync`, { method: "POST" });
            toast(`取り込み完了:会社${r.companies.added + r.companies.updated}件・担当者${r.contacts.added + r.contacts.updated}件・商談${r.deals.added + r.deals.updated}件`);
          } else if (act === "delete") {
            if (!confirm("接続を解除しますか?(取り込み済みのデータは残ります)")) return;
            await api(`/api/integrations/${provider}`, { method: "DELETE" });
            toast("接続を解除しました");
          }
          META = await api("/api/meta");
          ADMIN_RENDER.integrations(body);
        })),
      );
    });
  },

  async members(body) {
    const users = await api("/api/admin/users");
    body.innerHTML = `
      <section class="card">
        <h3>メンバーを招待</h3>
        <div class="form-grid">
          <div><label>メールアドレス</label><input type="email" id="inv-email" placeholder="name@example.co.jp" /></div>
          <div><label>権限</label><select id="inv-role"><option value="member">メンバー(営業機能を利用)</option>${isOwner() ? `<option value="admin">管理者(設定・メンバー管理も可能)</option>` : ""}</select></div>
        </div>
        <div class="row" style="margin-top:10px"><button class="btn primary" id="inv-run">招待リンクを発行</button></div>
        <div id="inv-link"></div>
      </section>
      <section class="card" style="margin-top:16px">
        <h3>メンバー一覧(${users.length}人)</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>氏名</th><th>メール</th><th>権限</th><th class="hide-sm">最終ログイン</th><th></th></tr></thead>
          <tbody>${users.map((u) => `<tr>
            <td><b>${esc(u.name)}</b>${u.disabled ? ` <span class="chip ng">停止中</span>` : ""}</td>
            <td>${esc(u.email)}</td>
            <td>${u.role !== "owner" && isOwner() && u.id !== META.user.id
              ? `<select data-role="${u.id}" style="width:auto"><option value="member" ${u.role === "member" ? "selected" : ""}>メンバー</option><option value="admin" ${u.role === "admin" ? "selected" : ""}>管理者</option></select>`
              : esc(u.roleLabel)}</td>
            <td class="hide-sm">${u.last_login_at ? fmtDate(u.last_login_at) : "未ログイン"}</td>
            <td class="num">${u.id === META.user.id || (u.role === "owner" && !isOwner()) ? "" : `
              <button class="btn small ghost" data-reset="${u.id}">PW再設定</button>
              <button class="btn small ghost" data-toggle="${u.id}" data-disabled="${u.disabled}">${u.disabled ? "再開" : "停止"}</button>
              <button class="btn small danger" data-remove="${u.id}">削除</button>`}</td>
          </tr>`).join("")}</tbody></table></div>
      </section>`;

    const showLink = (r, note) => {
      const url = `${location.origin}${r.link}`;
      $("#inv-link").innerHTML = `<p class="notice" style="margin-top:12px">${esc(note)}<br />このリンクを本人にだけ送ってください。</p>
        <div class="link-box"><input readonly value="${esc(url)}" id="link-text" /><button class="btn small primary" id="link-copy">コピー</button></div>`;
      $("#link-copy").addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(url); toast("コピーしました"); } catch { $("#link-text").select(); }
      });
    };
    $("#inv-run").addEventListener("click", (e) =>
      busy(e.currentTarget, "発行中", async () => {
        const r = await api("/api/admin/invites", { method: "POST", body: { email: $("#inv-email").value.trim(), role: $("#inv-role").value } });
        showLink(r, `招待リンクを発行しました(有効期限:${r.expiresInDays}日)。`);
      }),
    );
    body.querySelectorAll("[data-role]").forEach((sel) =>
      sel.addEventListener("change", async () => {
        try { await api(`/api/admin/users/${sel.dataset.role}`, { method: "PUT", body: { role: sel.value } }); toast("権限を変更しました"); }
        catch (e) { toast(e.message, true); }
      }),
    );
    body.querySelectorAll("[data-reset]").forEach((b) =>
      b.addEventListener("click", () => busy(b, "", async () => {
        const r = await api(`/api/admin/users/${b.dataset.reset}/reset-link`, { method: "POST" });
        showLink(r, `パスワード再設定リンクを発行しました(有効期限:${r.expiresInHours}時間)。`);
        $("#inv-link").scrollIntoView({ behavior: "smooth" });
      })),
    );
    body.querySelectorAll("[data-toggle]").forEach((b) =>
      b.addEventListener("click", () => busy(b, "", async () => {
        await api(`/api/admin/users/${b.dataset.toggle}`, { method: "PUT", body: { disabled: b.dataset.disabled !== "true" } });
        ADMIN_RENDER.members(body);
      })),
    );
    body.querySelectorAll("[data-remove]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("このメンバーを削除しますか?")) return;
        try { await api(`/api/admin/users/${b.dataset.remove}`, { method: "DELETE" }); ADMIN_RENDER.members(body); }
        catch (e) { toast(e.message, true); }
      }),
    );
  },

  async usage(body) {
    const u = await api("/api/admin/usage");
    const total = u.usage.reduce((s, x) => s + x.count, 0);
    const tokens = u.usage.reduce((s, x) => s + x.input_tokens + x.output_tokens, 0);
    const pct = u.plan.aiPerMonth ? Math.min(100, (total / u.plan.aiPerMonth) * 100) : 0;
    body.innerHTML = `
      <section class="card">
        <div class="row between"><h3 style="margin:0">現在のプラン:${esc(u.plan.label)}</h3>
          ${u.trialEndsAt ? `<span class="chip warn">トライアル終了:${fmtDate(u.trialEndsAt)}</span>` : ""}</div>
        <div class="grid grid-kpi" style="margin-top:12px">
          <div class="kpi"><div class="label">今月のAI利用(${esc(u.month)})</div><div class="value">${total}<small>回${u.plan.aiPerMonth ? ` / ${u.plan.aiPerMonth}回` : "(上限なし)"}</small></div>
            ${u.plan.aiPerMonth ? `<div class="score-bar"><i style="width:${pct}%"></i></div>` : ""}</div>
          <div class="kpi"><div class="label">ユーザー数</div><div class="value">${u.users}<small>人${u.plan.users ? ` / ${u.plan.users}人` : "(上限なし)"}</small></div></div>
          <div class="kpi"><div class="label">今月のAI処理量</div><div class="value">${tokens.toLocaleString("ja-JP")}<small>トークン</small></div></div>
        </div>
        <h4>機能別の利用回数</h4>
        ${u.usage.length ? `<div class="table-wrap"><table><tbody>${u.usage.map((x) => `<tr><td>${esc(x.feature)}</td><td class="num">${x.count}回</td><td class="num muted">${(x.input_tokens + x.output_tokens).toLocaleString("ja-JP")}トークン</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">今月はまだ利用がありません</p>`}
      </section>
      <section class="card" style="margin-top:16px">
        <h3>プラン一覧</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>プラン</th><th>月額(税抜)</th><th>AI利用/月</th><th>ユーザー数</th></tr></thead>
          <tbody>${Object.entries(u.plans).filter(([k]) => k !== "internal").map(([k, p]) => `<tr ${k === u.plan.key ? 'class="selected"' : ""}>
            <td><b>${esc(p.label)}</b></td><td>${p.priceYen === null ? "要相談" : yen(p.priceYen)}</td>
            <td>${p.aiPerMonth ?? "上限なし"}${p.aiPerMonth ? "回" : ""}</td><td>${p.users ?? "上限なし"}${p.users ? "人" : ""}</td></tr>`).join("")}</tbody>
        </table></div>
        <p class="muted" style="margin:8px 0 0">プランの変更は、サービスの運営者にお問い合わせください。</p>
      </section>`;
  },

  async audit(body) {
    const logs = await api("/api/admin/audit");
    body.innerHTML = `
      <section class="card">
        <h3>操作ログ(直近200件)</h3>
        <p class="muted" style="margin-top:0">誰が・いつ・何をしたかを記録しています。情報漏えいの調査などに使えます。</p>
        ${logs.length ? `<div class="table-wrap"><table>
          <thead><tr><th>日時</th><th>操作者</th><th>操作</th><th>内容</th><th class="hide-sm">IP</th></tr></thead>
          <tbody>${logs.map((l) => `<tr><td style="white-space:nowrap">${fmtDate(l.created_at)}</td><td>${esc(l.user_name)}</td><td>${esc(l.action)}</td><td style="max-width:320px">${esc(l.detail)}</td><td class="hide-sm muted">${esc(l.ip)}</td></tr>`).join("")}</tbody>
        </table></div>` : `<p class="empty">記録はまだありません</p>`}
      </section>`;
  },

  async data(body) {
    body.innerHTML = `
      <section class="card">
        <h3>全データのダウンロード</h3>
        <p class="muted" style="margin-top:0">会社・担当者・商談・議事録・メンバー情報を、JSON形式で一括ダウンロードします。<br class="hide-sm" />
          バックアップや、解約時のデータ持ち出しにお使いください。</p>
        <a class="btn ghost" href="/api/admin/export">ダウンロード</a>
      </section>
      <section class="card" style="margin-top:16px;border-color:#f0cccc">
        <h3 style="color:var(--ng)">解約(全データの削除)</h3>
        <p class="muted" style="margin-top:0">すべてのデータとメンバーを完全に削除します。<b>元に戻せません。</b><br class="hide-sm" />
          確認のため、会社名「${esc(META.tenant.name)}」を入力してください。</p>
        <input id="del-name" placeholder="${esc(META.tenant.name)}" />
        <div class="row" style="margin-top:10px"><button class="btn danger" id="del-run">すべて削除して解約する</button></div>
      </section>`;
    $("#del-run").addEventListener("click", (e) =>
      busy(e.currentTarget, "削除中", async () => {
        if (!confirm("本当に削除しますか?この操作は取り消せません。")) return;
        await api("/api/admin/tenant", { method: "DELETE", body: { confirmName: $("#del-name").value } });
        location.hash = "";
        location.reload();
      }),
    );
  },
};

// =====================================================
// ログイン・新規登録・招待の受諾
// =====================================================
let PUBLIC = { appName: "営業AIプラットフォーム", allowSignup: false, firstRun: false };

function showAuth(mode, token) {
  $("#tabs").hidden = true;
  $("#user-area").hidden = true;
  $("#banner").hidden = true;
  const title = { login: "ログイン", signup: PUBLIC.firstRun ? "はじめに管理者アカウントを作成" : "無料トライアルを始める", accept: "アカウントの設定" }[mode];
  view.innerHTML = `
    <div class="auth"><div class="card">
      <h2>${esc(title)}</h2>
      ${mode === "signup" && PUBLIC.firstRun ? `<p class="muted" style="text-align:center">最初に登録した方が「オーナー(管理者)」になります。<br />ほかのメンバーは、ログイン後に招待できます。</p>` : ""}
      <form id="auth-form" novalidate>
        <div id="accept-info"></div>
        ${mode === "signup" ? `<label>会社名</label><input name="companyName" required autocomplete="organization" />` : ""}
        ${mode !== "login" ? `<label>お名前</label><input name="name" required autocomplete="name" id="f-name" />` : ""}
        ${mode !== "accept" ? `<label>メールアドレス</label><input name="email" type="email" required autocomplete="email" />` : ""}
        <label>パスワード${mode !== "login" ? "(10文字以上・英字と数字を含む)" : ""}</label>
        <input name="password" type="password" required autocomplete="${mode === "login" ? "current-password" : "new-password"}" />
        ${mode === "signup" && !PUBLIC.firstRun ? `<label class="check"><input type="checkbox" name="agree" value="1" /><span><a href="/terms.html" target="_blank">利用規約</a>と<a href="/privacy.html" target="_blank">プライバシーポリシー</a>に同意します</span></label>` : ""}
        <button class="btn primary" style="width:100%;margin-top:16px" type="submit">${mode === "login" ? "ログイン" : mode === "signup" ? "登録する" : "設定して始める"}</button>
      </form>
      ${mode === "login" && PUBLIC.allowSignup ? `<p class="switch">アカウントをお持ちでない方は <a href="#" id="to-signup">新規登録</a></p>` : ""}
      ${mode === "signup" && !PUBLIC.firstRun ? `<p class="switch">登録済みの方は <a href="#" id="to-login">ログイン</a></p>` : ""}
      ${mode === "login" ? `<p class="switch muted">パスワードを忘れた場合は、社内の管理者に再設定リンクの発行を依頼してください。</p>` : ""}
    </div></div>`;

  $("#to-signup")?.addEventListener("click", (e) => { e.preventDefault(); showAuth("signup"); });
  $("#to-login")?.addEventListener("click", (e) => { e.preventDefault(); showAuth("login"); });

  if (mode === "accept") {
    api(`/api/auth/invite/${encodeURIComponent(token)}`)
      .then((inv) => {
        $("#accept-info").innerHTML = `<p class="notice">${esc(inv.tenantName)}<br />${inv.kind === "invite" ? "への招待" : "のパスワード再設定"}(${esc(inv.email)})</p>`;
        if (inv.kind === "reset") {
          // パスワード再設定では氏名の入力は不要
          $("#f-name").previousElementSibling.remove();
          $("#f-name").remove();
        }
      })
      .catch((e) => { view.querySelector(".card").innerHTML = `<p class="empty">${esc(e.message)}</p><p class="switch"><a href="/">ログイン画面へ</a></p>`; });
  }

  $("#auth-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector("button[type=submit]");
    const body = Object.fromEntries(new FormData(e.currentTarget));
    body.agree = Boolean(body.agree);
    const url = { login: "/api/auth/login", signup: "/api/auth/signup", accept: "/api/auth/accept" }[mode];
    if (mode === "accept") body.token = token;
    busy(btn, "処理中", async () => {
      await api(url, { method: "POST", body });
      location.hash = "#home";
      await start();
    });
  });
}

// ---------- 画面切り替え ----------
const ROUTES = { home: renderHome, research: renderResearch, enterprise: renderEnterprise, crm: renderCrm, meeting: renderMeeting, admin: renderAdmin };

async function route() {
  if (!META.user) return;
  const name = location.hash.slice(1) || "home";
  const fn = ROUTES[name] ?? renderHome;
  document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === name));
  try {
    await fn();
  } catch (e) {
    view.innerHTML = `<p class="card empty">読み込みに失敗しました:${esc(e.message)}</p>`;
  }
  window.scrollTo(0, 0);
}

function renderBanner() {
  const b = $("#banner");
  const msgs = [];
  if (META.tenant.trialExpired) msgs.push("無料トライアル期間が終了しました。AI機能を使うには、プランの変更が必要です。");
  else if (META.tenant.plan === "trial" && META.tenant.trialEndsAt) msgs.push(`無料トライアル中です(${fmtDate(META.tenant.trialEndsAt)} まで)。`);
  if (META.usage.limit && META.usage.used >= META.usage.limit * 0.8) msgs.push(`今月のAI利用回数:${META.usage.used} / ${META.usage.limit}回`);
  b.hidden = !msgs.length;
  b.innerHTML = msgs.length ? `<p class="notice" style="margin:0">${msgs.map(esc).join("<br />")}</p>` : "";
}

async function start() {
  META = await api("/api/meta");
  document.title = META.appName;
  $("#app-name").textContent = META.appName;
  $("#tabs").hidden = false;
  $("#user-area").hidden = false;
  $("#admin-tab").hidden = !isAdmin();
  $("#user-name").textContent = `${META.user.name}(${META.user.roleLabel})`;
  const badge = $("#mode-badge");
  badge.textContent = META.aiEnabled ? "AI接続中" : "デモモード";
  badge.className = `badge ${META.aiEnabled ? "ai" : "demo"}`;
  renderBanner();
  await route();
}

(async function init() {
  try {
    PUBLIC = await api("/api/public-config");
    document.title = PUBLIC.appName;
    $("#app-name").textContent = PUBLIC.appName;
  } catch {
    toast("サーバーに接続できません", true);
    return;
  }
  $("#logout").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    META = { ...META, user: null };
    location.hash = "";
    showAuth("login");
  });
  window.addEventListener("hashchange", () => {
    const m = location.hash.match(/^#accept=(.+)$/);
    if (m) return showAuth("accept", m[1]);
    route();
  });

  const m = location.hash.match(/^#accept=(.+)$/);
  if (m) return showAuth("accept", m[1]);
  if (PUBLIC.firstRun) return showAuth("signup");
  try {
    const res = await fetch("/api/meta");
    if (res.status === 401) return showAuth("login");
    await start();
  } catch (e) {
    toast(e.message, true);
  }
})();
