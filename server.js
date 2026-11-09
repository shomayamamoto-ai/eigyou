// 営業AIプラットフォーム:Webサーバー
// 起動:npm start → ブラウザで http://localhost:3000 を開く
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./lib/db.js";
import * as ai from "./lib/ai.js";
import {
  STAGES, STATUSES, TIERS, ROLES,
  checkQuality, mergeCompanies, normalizeCompanyName, companyKey,
  priorityScore, parseCsv, toCsv,
} from "./lib/crm.js";
import { seed } from "./lib/seed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const store = new Store(process.env.DATA_FILE || path.join(here, "data", "db.json"));
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(here, "public")));

const COLS = ["companies", "contacts", "deals", "meetings"];
const offering = () => store.data.settings.offering || "";

// 非同期処理のエラーを、画面に出せる形で返す
const h = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error(e);
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    const msg =
      e.status === 401 ? "APIキーが正しくありません(.env を確認してください)"
      : e.status === 429 ? "AIの利用が混み合っています。少し待って再実行してください"
      : e.message || "エラーが発生しました";
    res.status(status).json({ error: msg });
  }
};
const fail = (status, message) => Object.assign(new Error(message), { status });

// ---------- 基本情報 ----------
app.get("/api/meta", (req, res) => {
  res.json({
    aiEnabled: ai.aiEnabled(),
    model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
    options: { STAGES, STATUSES, TIERS, ROLES },
    settings: store.data.settings,
  });
});

app.put("/api/settings", h((req, res) => {
  store.data.settings = { ...store.data.settings, offering: String(req.body.offering ?? "") };
  store.save();
  res.json(store.data.settings);
}));

// ---------- ダッシュボード ----------
app.get("/api/dashboard", (req, res) => {
  const deals = store.list("deals");
  const open = deals.filter((d) => !["受注", "失注"].includes(d.stage));
  const byStage = STAGES.map((s) => {
    const ds = deals.filter((d) => d.stage === s);
    return { stage: s, count: ds.length, amount: ds.reduce((a, d) => a + (Number(d.amount) || 0), 0) };
  });
  const companyName = (id) => store.get("companies", id)?.name ?? "(不明)";
  const upcoming = open
    .filter((d) => d.nextAction)
    .sort((a, b) => (a.nextActionDate || "9999").localeCompare(b.nextActionDate || "9999"))
    .slice(0, 8)
    .map((d) => ({ ...d, companyName: companyName(d.companyId) }));
  const q = checkQuality(store);
  res.json({
    counts: {
      companies: store.list("companies").length,
      contacts: store.list("contacts").length,
      openDeals: open.length,
      meetings: store.list("meetings").length,
      researched: store.list("companies").filter((c) => c.research).length,
      enterprise: store.list("companies").filter((c) => c.tier === "大手").length,
    },
    pipelineAmount: open.reduce((a, d) => a + (Number(d.amount) || 0), 0),
    weightedAmount: open.reduce((a, d) => a + ((Number(d.amount) || 0) * (Number(d.probability) || 0)) / 100, 0),
    byStage,
    upcoming,
    quality: { score: q.score, issueCount: q.issues.length },
  });
});

// ---------- サンプルデータ ----------
app.post("/api/seed", h((req, res) => {
  seed(store);
  res.json({ ok: true });
}));

// ---------- 汎用CRUD ----------
const clean = (col, body) => {
  const b = { ...body };
  if (col === "companies") {
    if (!b.name?.trim()) throw fail(400, "会社名は必須です");
    b.name = normalizeCompanyName(b.name);
  }
  if (col === "contacts" && !b.name?.trim()) throw fail(400, "氏名は必須です");
  if (col === "deals" && !b.title?.trim()) throw fail(400, "案件名は必須です");
  if ("amount" in b) b.amount = b.amount === "" || b.amount === null ? null : Number(b.amount);
  if ("probability" in b) b.probability = b.probability === "" ? null : Number(b.probability);
  return b;
};

app.get("/api/:col", (req, res, next) => {
  if (!COLS.includes(req.params.col)) return next();
  res.json(store.list(req.params.col));
});
app.post("/api/:col", h((req, res) => {
  if (!COLS.includes(req.params.col)) throw fail(404, "Not found");
  res.json(store.insert(req.params.col, clean(req.params.col, req.body)));
}));
app.put("/api/:col/:id", h((req, res) => {
  if (!COLS.includes(req.params.col)) throw fail(404, "Not found");
  const r = store.update(req.params.col, req.params.id, clean(req.params.col, req.body));
  if (!r) throw fail(404, "データが見つかりません");
  res.json(r);
}));
app.delete("/api/:col/:id", h((req, res) => {
  if (!COLS.includes(req.params.col)) throw fail(404, "Not found");
  res.json({ ok: store.remove(req.params.col, req.params.id) });
}));

// ---------- ① リサーチ ----------
app.post("/api/research/:companyId", h(async (req, res) => {
  const c = store.get("companies", req.params.companyId);
  if (!c) throw fail(404, "会社が見つかりません");
  const r = await ai.research(c, offering());
  // 空欄の基本情報だけ、調査結果で補完する(CRM整備にもつながる)
  const patch = { research: r };
  if (!c.industry && r.industry) patch.industry = r.industry;
  if (!c.tier && r.tier) patch.tier = r.tier;
  if (!c.website && r.website) patch.website = r.website;
  res.json(store.update("companies", c.id, patch));
}));

// ---------- ② 大手開拓 ----------
app.get("/api/targets", (req, res) => {
  const list = store.list("companies").map((c) => ({
    ...c,
    score: priorityScore(store, c),
    contactCount: store.list("contacts").filter((p) => p.companyId === c.id).length,
    hasDecisionMaker: store.list("contacts").some((p) => p.companyId === c.id && p.role === "決裁者"),
  }));
  list.sort((a, b) => b.score - a.score);
  res.json(list);
});

app.post("/api/account-plan/:companyId", h(async (req, res) => {
  const c = store.get("companies", req.params.companyId);
  if (!c) throw fail(404, "会社が見つかりません");
  const contacts = store.list("contacts").filter((p) => p.companyId === c.id);
  const deals = store.list("deals").filter((d) => d.companyId === c.id);
  const plan = await ai.accountPlan(c, contacts, deals, offering());
  res.json(store.update("companies", c.id, { accountPlan: plan }));
}));

// ---------- ③ CRM整備 ----------
app.get("/api/crm/quality", (req, res) => res.json(checkQuality(store)));

app.post("/api/crm/fix", h((req, res) => {
  const { fix, ids, value } = req.body;
  if (fix === "normalize") store.update("companies", ids[0], { name: value });
  else if (fix === "merge") mergeCompanies(store, ids);
  else throw fail(400, "この項目は自動修正できません");
  res.json(checkQuality(store));
}));

app.post("/api/crm/extract", h(async (req, res) => {
  const text = String(req.body.text ?? "").trim();
  if (!text) throw fail(400, "テキストを入力してください");
  res.json(await ai.extractCrm(text));
}));

// 抽出結果を登録。同じ会社がすでにあれば、新規作成せず既存にひもづける
function findOrCreateCompany(name, extra = {}) {
  const key = companyKey(name);
  const found = store.list("companies").find((c) => companyKey(c.name) === key);
  if (found) return { company: found, created: false };
  return { company: store.insert("companies", { status: "未接触", ...extra, name: normalizeCompanyName(name) }), created: true };
}

function importRecords({ companies = [], contacts = [], deals = [] }) {
  const result = { companies: 0, contacts: 0, deals: 0, linked: 0 };
  for (const c of companies) {
    if (!c.name) continue;
    const { created } = findOrCreateCompany(c.name, c);
    created ? result.companies++ : result.linked++;
  }
  for (const p of contacts) {
    if (!p.name) continue;
    const { company } = findOrCreateCompany(p.companyName || "会社名不明");
    const { companyName: _n, ...rest } = p;
    const dup = store.list("contacts").find((x) => x.companyId === company.id && x.name === p.name);
    if (dup) store.update("contacts", dup.id, Object.fromEntries(Object.entries(rest).filter(([, v]) => v)));
    else { store.insert("contacts", { ...rest, companyId: company.id }); result.contacts++; }
  }
  for (const d of deals) {
    if (!d.title) continue;
    const { company } = findOrCreateCompany(d.companyName || "会社名不明");
    const { companyName: _n, ...rest } = d;
    const amount = rest.amount === "" || rest.amount === undefined || rest.amount === null ? null : Number(rest.amount);
    const probability = rest.probability ? Number(rest.probability) : null;
    store.insert("deals", { stage: "リード", ...rest, amount, probability, companyId: company.id });
    result.deals++;
  }
  return result;
}

app.post("/api/crm/import", h((req, res) => res.json(importRecords(req.body))));

const CSV_FIELDS = {
  companies: [["name", "会社名"], ["industry", "業種"], ["tier", "企業規模"], ["status", "ステータス"], ["website", "Webサイト"], ["notes", "メモ"]],
  contacts: [["companyName", "会社名"], ["name", "氏名"], ["department", "部署"], ["title", "役職"], ["role", "役割"], ["email", "メール"], ["phone", "電話"]],
  deals: [["companyName", "会社名"], ["title", "案件名"], ["stage", "ステージ"], ["amount", "金額"], ["probability", "確度"], ["nextAction", "次アクション"], ["nextActionDate", "期限"], ["closeDate", "受注予定日"]],
};

app.get("/api/export/:col", (req, res) => {
  const fields = CSV_FIELDS[req.params.col];
  if (!fields) return res.status(404).end();
  const rows = store.list(req.params.col).map((r) =>
    fields.map(([k]) => (k === "companyName" ? store.get("companies", r.companyId)?.name ?? "" : r[k])),
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.col}.csv"`);
  res.send(toCsv([fields.map(([, label]) => label), ...rows]));
});

app.post("/api/import/:col", h((req, res) => {
  const fields = CSV_FIELDS[req.params.col];
  if (!fields) throw fail(404, "Not found");
  const [header, ...rows] = parseCsv(String(req.body.csv ?? ""));
  if (!header) throw fail(400, "CSVが空です");
  // 見出し(日本語ラベル または 英字キー)から列を対応づける
  const idx = fields.map(([k, label]) => header.findIndex((h) => h.trim() === label || h.trim() === k));
  const items = rows.map((r) => Object.fromEntries(fields.map(([k], i) => [k, idx[i] >= 0 ? r[idx[i]]?.trim() ?? "" : ""])));
  res.json(importRecords({ [req.params.col]: items }));
}));

// ---------- ④ 商談分析 ----------
app.post("/api/meetings/analyze", h(async (req, res) => {
  const { dealId, transcript, date } = req.body;
  if (!String(transcript ?? "").trim()) throw fail(400, "議事録を入力してください");
  const deal = dealId ? store.get("deals", dealId) : null;
  const company = deal ? store.get("companies", deal.companyId) : null;
  const analysis = await ai.analyzeMeeting({ transcript, company, deal, date });
  const meeting = store.insert("meetings", {
    dealId: deal?.id ?? null,
    companyId: company?.id ?? null,
    date: date || new Date().toISOString().slice(0, 10),
    transcript,
    analysis,
    applied: false,
  });
  res.json(meeting);
}));

// 分析結果をCRM(商談)に反映 → サイクルが回る
app.post("/api/meetings/:id/apply", h((req, res) => {
  const m = store.get("meetings", req.params.id);
  if (!m) throw fail(404, "議事録が見つかりません");
  if (!m.dealId) throw fail(400, "この議事録は商談にひもづいていません");
  const u = m.analysis.crmUpdate;
  const patch = {
    stage: u.stage,
    probability: Math.round(m.analysis.winProbability),
    nextAction: u.nextAction,
    ...(u.nextActionDate && { nextActionDate: u.nextActionDate }),
    ...(u.amount && { amount: u.amount }),
  };
  const deal = store.update("deals", m.dealId, patch);
  store.update("meetings", m.id, { applied: true });
  const company = store.get("companies", deal.companyId);
  if (company && company.status !== "取引中") {
    store.update("companies", company.id, { status: deal.stage === "受注" ? "取引中" : "商談中" });
  }
  res.json(deal);
}));

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`営業AIプラットフォーム起動:http://localhost:${port}`);
  console.log(ai.aiEnabled() ? "AIモード:Claude API に接続します" : "デモモード:ANTHROPIC_API_KEY が未設定のため、AI結果はサンプルを表示します");
});
