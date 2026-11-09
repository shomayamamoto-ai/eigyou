// 営業AIプラットフォーム:画面のふるまい(フレームワークなしの素のJavaScript)
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
let META = { options: { STAGES: [], STATUSES: [], TIERS: [], ROLES: [] }, settings: {} };
const state = { researchId: null, planId: null, crmTab: "companies", meetingId: null };

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
        <button class="btn primary" id="seed">サンプルデータを入れる</button>
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
      ${companies.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.industry)}</td><td>${esc(c.tier)}</td><td>${esc(c.status)}</td>
        <td class="num"><button class="btn small ghost" data-edit="companies" data-id="${c.id}">編集</button> <button class="btn small danger" data-del="companies" data-id="${c.id}">削除</button></td></tr>`).join("")}</tbody></table>`,
    contacts: () => `<table><thead><tr><th>氏名</th><th>会社</th><th>部署・役職</th><th>役割</th><th>連絡先</th><th></th></tr></thead><tbody>
      ${contacts.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td>${esc(coName(p.companyId))}</td><td>${esc(p.department)} ${esc(p.title)}</td><td>${esc(p.role)}</td>
        <td>${esc(p.email)}<br />${esc(p.phone)}</td>
        <td class="num"><button class="btn small ghost" data-edit="contacts" data-id="${p.id}">編集</button> <button class="btn small danger" data-del="contacts" data-id="${p.id}">削除</button></td></tr>`).join("")}</tbody></table>`,
    deals: () => `<table><thead><tr><th>案件</th><th>会社</th><th>ステージ</th><th>金額</th><th>確度</th><th>次アクション</th><th></th></tr></thead><tbody>
      ${deals.map((d) => `<tr><td><b>${esc(d.title)}</b></td><td>${esc(coName(d.companyId))}</td><td>${stageChip(d.stage)}</td>
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
      await api(`/api/meetings/${m.id}/apply`, { method: "POST" });
      toast("CRMの商談情報を更新しました");
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
// 設定
// =====================================================
async function renderSettings() {
  META = await api("/api/meta");
  view.innerHTML = `
    <h2>設定</h2>
    <section class="card">
      <h3>自社の提供サービス</h3>
      <p class="muted" style="margin-top:0">ここに書いた内容をもとに、AIが「提案の切り口」や「開拓プラン」を考えます。<br class="hide-sm" />
        具体的に書くほど精度が上がります。</p>
      <textarea id="offering" style="min-height:100px" placeholder="例)営業活動を記録・分析するクラウド型の営業支援サービス。強みは…">${esc(META.settings.offering)}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn primary" id="save">保存</button></div>
    </section>
    <section class="card" style="margin-top:16px">
      <h3>AIの接続状態</h3>
      <p>${META.aiEnabled ? `<span class="chip ok">接続済み</span> モデル:${esc(META.model)}` : `<span class="chip warn">デモモード</span> APIキーが設定されていません`}</p>
      ${META.aiEnabled ? "" : `<p class="muted">実際にAIを使うには、サーバーのフォルダにある <code>.env.example</code> を <code>.env</code> という名前でコピーし、<br class="hide-sm" />
        <code>ANTHROPIC_API_KEY=</code> の後ろにAPIキーを書いてから、サーバーを再起動してください。</p>`}
    </section>`;
  $("#save").addEventListener("click", (e) =>
    busy(e.currentTarget, "保存中", async () => {
      await api("/api/settings", { method: "PUT", body: { offering: $("#offering").value } });
      toast("保存しました");
    }),
  );
}

// ---------- 画面切り替え ----------
const ROUTES = { home: renderHome, research: renderResearch, enterprise: renderEnterprise, crm: renderCrm, meeting: renderMeeting, settings: renderSettings };

async function route() {
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

(async function init() {
  try {
    META = await api("/api/meta");
    const b = $("#mode-badge");
    b.textContent = META.aiEnabled ? "AI接続中" : "デモモード";
    b.className = `badge ${META.aiEnabled ? "ai" : "demo"}`;
  } catch (e) {
    toast("サーバーに接続できません", true);
  }
  window.addEventListener("hashchange", route);
  route();
})();
