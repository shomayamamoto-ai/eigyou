// CRM整備:AIを使わず、ルールで機械的に
// チェックできる項目をまとめたモジュール。
// (重複・未入力・形式エラー・放置案件など)

import { localDate } from "./time.js";

export const STAGES = ["リード", "アプローチ", "ヒアリング", "提案", "交渉", "受注", "失注"];
export const STATUSES = ["未接触", "アプローチ中", "商談中", "取引中", "休眠"];
export const TIERS = ["大手", "中堅", "中小"];
export const ROLES = ["決裁者", "推進者", "影響者", "利用者", "不明"];

// 進行中の商談で、確度が未入力のときに使う「ステージごとの標準の確度」(%)
export const STAGE_PROBABILITY = { リード: 5, アプローチ: 10, ヒアリング: 25, 提案: 50, 交渉: 70, 受注: 100, 失注: 0 };
// rates:stageWinRates() で求めた「自社の実績から補正した確度」。なければ標準値を使う
export function dealProbability(d, rates) {
  const p = d?.probability;
  if (p !== null && p !== undefined && p !== "" && Number.isFinite(Number(p))) return Number(p);
  const r = rates?.[d?.stage];
  return r ? r.rate : STAGE_PROBABILITY[d?.stage] ?? 0;
}

// ステージごとの「実際の受注率」を、終わった商談(受注・失注)の実績から求める。
// 件数が少ないうちは実績だけだと大きくぶれるため、標準値と混ぜて計算する
// (標準値を「PRIOR 件ぶんの架空の実績」とみなす。実績が増えるほど実績の割合が大きくなる)。
const PRIOR = 5;
const OPEN_STAGES = ["リード", "アプローチ", "ヒアリング", "提案", "交渉"];
export function stageWinRates(deals) {
  const closed = deals.filter((d) => ["受注", "失注"].includes(d.stage));
  const out = {};
  for (const stage of OPEN_STAGES) {
    let n = 0;
    let won = 0;
    for (const d of closed) {
      const passed = Array.isArray(d.stageHistory) ? d.stageHistory.some((h) => h.stage === stage) : false;
      if (!passed) continue;
      n++;
      if (d.stage === "受注") won++;
    }
    const base = STAGE_PROBABILITY[stage] / 100;
    const rate = Math.round(((won + PRIOR * base) / (n + PRIOR)) * 100);
    out[stage] = { stage, standard: STAGE_PROBABILITY[stage], observed: n ? Math.round((won / n) * 100) : null, samples: n, won, rate };
  }
  return out;
}

// 会社名のゆれ(法人格・全角半角・空白・記号・英語の Co., Ltd. など)をそろえて、比較用のキーにする
const LEGAL_JA = /株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|医療法人|学校法人|\(株\)|\(有\)|\(同\)|\(合\)/g;
const LEGAL_EN = /\b(co\.?,?\s*ltd\.?|company,?\s*limited|corporation|corp\.?|incorporated|inc\.?|limited|ltd\.?|k\.?k\.?|llc)\b/gi; // 「ホールディングス」は別会社(持株会社)のことが多いので、取り除かない
export function companyKey(name = "") {
  return String(name)
    .normalize("NFKC")
    .replace(LEGAL_JA, "")
    .replace(LEGAL_EN, "")
    .replace(/[\s・.,、。&'’\-ー―()\[\]]/g, "")
    .toLowerCase();
}

// カタカナ → ひらがな(「ミライ商事」と「みらい商事」を同じ読みとして比べるため)
const toHiragana = (s) => s.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// 拠点名(支店・営業所など)を取り除いた、本体の名前
const BRANCH = /(東京|大阪|名古屋|福岡|札幌|仙台|横浜|京都|神戸|広島|埼玉|千葉|北海道|東北|関東|中部|関西|中国|四国|九州|東日本|西日本|第[一二三四五1-5])?(本社|本店|支社|支店|営業所|事業所|工場|出張所)$/;
const stripBranch = (key) => key.replace(BRANCH, "");

const hostOf = (url) => {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

// 2つの文字列が「1文字だけ違う」か(挿入・削除・置換のどれか1回)
export function oneEditApart(a, b) {
  if (a === b) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (l.length - s.length > 1) return false;
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.length === l.length ? s.slice(i + 1) === l.slice(i + 1) : s.slice(i) === l.slice(i + 1);
}

// 「完全に同じ会社」とまでは言えないが、同じ会社の可能性がある組を探す。理由も返す
export function findSimilarCompanies(companies) {
  const items = companies.map((c) => {
    const key = companyKey(c.name);
    return { c, key, kana: toHiragana(key), base: stripBranch(key), host: hostOf(c.website ?? "") };
  }).filter((x) => x.key);
  const pairs = [];
  const seen = new Set();
  const add = (x, y, reason) => {
    if (x.key === y.key) return; // 完全一致は、別のチェック(重複)で扱う
    const id = [x.c.id, y.c.id].sort().join("|");
    if (seen.has(id)) return;
    seen.add(id);
    pairs.push({ ids: [x.c.id, y.c.id], names: [x.c.name, y.c.name], reason });
  };
  // 件数が多くても速く終わるよう、まずは「同じ値でまとめる」方法で探す
  const groupBy = (fn, reason, ok = () => true) => {
    const m = new Map();
    for (const x of items) {
      const k = fn(x);
      if (!k) continue;
      (m.get(k) ?? m.set(k, []).get(k)).push(x);
    }
    for (const g of m.values()) {
      for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) if (ok(g[i], g[j])) add(g[i], g[j], reason);
    }
  };
  groupBy((x) => x.host, "Webサイトが同じ");
  groupBy((x) => x.kana, "ひらがな・カタカナの違いだけ");
  groupBy((x) => (x.base.length >= 2 ? x.base : ""), "同じ会社の別拠点の可能性", (a, b) => a.base !== a.key || b.base !== b.key);
  // 1文字違い(入力ミスの可能性)。総当たりになるため、件数が多いときは省く
  if (items.length <= 1500) {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        // 短い名前は偶然の一致が多いので、5文字以上に限る
        if (Math.min(a.key.length, b.key.length) >= 5 && oneEditApart(a.key, b.key)) add(a, b, "1文字だけ違う(入力ミスの可能性)");
      }
    }
  }
  return pairs;
}

// ---------- メールアドレス・電話番号 ----------
const DOMAIN_TYPOS = {
  "gmail.con": "gmail.com", "gmail.co": "gmail.com", "gmial.com": "gmail.com", "gamil.com": "gmail.com", "gmai.com": "gmail.com", "gmail.cm": "gmail.com",
  "yahoo.co.jo": "yahoo.co.jp", "yaho.co.jp": "yahoo.co.jp", "yahoo.cojp": "yahoo.co.jp", "yahoo.co.pj": "yahoo.co.jp",
  "hotmial.com": "hotmail.com", "hotmail.con": "hotmail.com", "outlook.con": "outlook.com", "outlok.com": "outlook.com", "icloud.con": "icloud.com",
};
const EMAIL_STRICT = /^[a-z0-9._%+\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)*\.[a-z]{2,}$/i;

// メールアドレスを点検する。{ valid, suggestion(直した候補。なければ null) }
export function checkEmail(email) {
  const raw = String(email ?? "");
  // 全角文字・前後の空白・「,」と「.」の打ち間違いを直してみる
  let fixed = raw.normalize("NFKC").trim().replace(/\s+/g, "").replace(/,/g, ".").replace(/\.{2,}/g, ".").replace(/^mailto:/i, "");
  const at = fixed.lastIndexOf("@");
  if (at > 0) {
    let domain = fixed.slice(at + 1).toLowerCase().replace(/\.cojp$/, ".co.jp").replace(/\.nejp$/, ".ne.jp").replace(/\.orjp$/, ".or.jp");
    domain = DOMAIN_TYPOS[domain] ?? domain;
    fixed = `${fixed.slice(0, at)}@${domain}`;
  }
  const valid = EMAIL_STRICT.test(raw);
  const fixedValid = EMAIL_STRICT.test(fixed);
  return { valid: valid && fixed === raw, suggestion: fixedValid && fixed !== raw ? fixed : null };
}

// 電話番号を点検する(日本の番号を想定)。{ valid, suggestion }
export function checkPhone(phone) {
  const raw = String(phone ?? "");
  const half = raw.normalize("NFKC").trim().replace(/[ー−―‐]/g, "-").replace(/\s+/g, "");
  const d = half.replace(/\D/g, "");
  const intl = half.startsWith("+");
  // 国内:0から始まる10〜11桁 / 国際:+に続く9〜15桁
  const valid = intl ? d.length >= 9 && d.length <= 15 : /^0\d{9,10}$/.test(d);
  if (!valid) return { valid: false, suggestion: null };
  return { valid: true, suggestion: half !== raw ? half : null };
}

const personKey = (name) => String(name ?? "").normalize("NFKC").replace(/[\s ]/g, "").toLowerCase();

// 表記をそろえる:(株)→株式会社、全角英数→半角、前後の空白削除
export function normalizeCompanyName(name = "") {
  let s = String(name).normalize("NFKC").trim().replace(/\s+/g, " ");
  s = s.replace(/^\(株\)\s*/, "株式会社").replace(/\s*\(株\)$/, "株式会社");
  s = s.replace(/^\(有\)\s*/, "有限会社").replace(/\s*\(有\)$/, "有限会社");
  return s;
}


export function checkQuality(store, today = new Date()) {
  const issues = [];
  const companies = store.list("companies");
  const contacts = store.list("contacts");
  const deals = store.list("deals");
  const todayStr = localDate(today);

  // 1. 会社の重複
  const groups = new Map();
  for (const c of companies) {
    const k = companyKey(c.name);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  for (const list of groups.values()) {
    if (list.length > 1) {
      issues.push({
        type: "duplicate",
        severity: "high",
        target: "companies",
        ids: list.map((c) => c.id),
        message: `会社の重複:${list.map((c) => c.name).join(" / ")}`,
        fix: "merge",
      });
    }
  }
  // 1-2. 「同じ会社かもしれない」組(人が確認してから統合する)
  for (const pair of findSimilarCompanies(companies)) {
    issues.push({
      type: "similar",
      severity: "medium",
      target: "companies",
      ids: pair.ids,
      message: `同じ会社の可能性(${pair.reason}):${pair.names.join(" / ")}`,
      fix: "merge",
      needsReview: true,
    });
  }

  // 2. 会社名の表記ゆれ・未入力項目
  for (const c of companies) {
    const norm = normalizeCompanyName(c.name);
    if (norm !== c.name) {
      issues.push({
        type: "format",
        severity: "low",
        target: "companies",
        ids: [c.id],
        message: `会社名の表記ゆれ:「${c.name}」→「${norm}」`,
        fix: "normalize",
        value: norm,
      });
    }
    const missing = [];
    if (!c.industry) missing.push("業種");
    if (!c.tier) missing.push("企業規模");
    if (missing.length) {
      issues.push({
        type: "missing",
        severity: "medium",
        target: "companies",
        ids: [c.id],
        message: `${c.name}:未入力 → ${missing.join("、")}(リサーチで自動補完できます)`,
      });
    }
    if (!c.website) {
      issues.push({ type: "missing", severity: "low", target: "companies", ids: [c.id], message: `${c.name}:Webサイトが未入力` });
    }
    if (!contacts.some((p) => p.companyId === c.id)) {
      issues.push({
        type: "missing",
        severity: "medium",
        target: "companies",
        ids: [c.id],
        message: `${c.name}:担当者が1人も登録されていません`,
      });
    }
  }

  // 3. 担当者の形式チェック・孤立データ
  // 3-0. 担当者の重複(同じメールアドレス、または同じ会社で同じ氏名)
  const dupContacts = new Map();
  for (const p of contacts) {
    const keys = [];
    if (p.email) keys.push(`email:${String(p.email).normalize("NFKC").trim().toLowerCase()}`);
    if (personKey(p.name)) keys.push(`name:${p.companyId}:${personKey(p.name)}`);
    for (const k of keys) (dupContacts.get(k) ?? dupContacts.set(k, []).get(k)).push(p);
  }
  const reported = new Set();
  for (const [k, group] of dupContacts) {
    if (group.length < 2) continue;
    const id = group.map((p) => p.id).sort().join("|");
    if (reported.has(id)) continue;
    reported.add(id);
    issues.push({
      type: "duplicate",
      severity: "high",
      target: "contacts",
      ids: group.map((p) => p.id),
      message: `担当者の重複${k.startsWith("email:") && new Set(group.map((p) => personKey(p.name))).size > 1 ? "の可能性(メールアドレスが同じ。共有アドレスなら別の人です)" : k.startsWith("email:") ? "(メールアドレスが同じ)" : "(同じ会社で氏名が同じ)"}:${group.map((p) => p.name).join(" / ")}`,
      // 氏名が違う人どうしは、共有アドレス(sales@ など)の可能性があるので、人が確認してから統合する
      ...(k.startsWith("email:") && new Set(group.map((p) => personKey(p.name))).size > 1 && { needsReview: true, severity: "medium" }),
      fix: "merge-contacts",
    });
  }

  for (const p of contacts) {
    if (p.email) {
      const e = checkEmail(p.email);
      if (!e.valid) {
        issues.push({
          type: "format", severity: "medium", target: "contacts", ids: [p.id],
          message: e.suggestion ? `${p.name}:メールアドレスの入力ミスの可能性「${p.email}」→「${e.suggestion}」` : `${p.name}:メールアドレスの形式が不正(${p.email})`,
          ...(e.suggestion && { fix: "fix-email", value: e.suggestion }),
        });
      }
    }
    if (p.phone) {
      const t = checkPhone(p.phone);
      if (!t.valid) {
        issues.push({ type: "format", severity: "low", target: "contacts", ids: [p.id], message: `${p.name}:電話番号の桁数・形式を確認してください(${p.phone})` });
      } else if (t.suggestion) {
        issues.push({ type: "format", severity: "low", target: "contacts", ids: [p.id], message: `${p.name}:電話番号の表記をそろえます「${p.phone}」→「${t.suggestion}」`, fix: "fix-phone", value: t.suggestion });
      }
    }
    if (!p.email && !p.phone) {
      issues.push({ type: "missing", severity: "medium", target: "contacts", ids: [p.id], message: `${p.name}:連絡先(メール・電話)が未登録` });
    }
    if (!companies.some((c) => c.id === p.companyId)) {
      issues.push({ type: "orphan", severity: "high", target: "contacts", ids: [p.id], message: `${p.name}:ひもづく会社が存在しません` });
    }
  }

  // 4. 商談の放置・未入力
  for (const d of deals) {
    if (["受注", "失注"].includes(d.stage)) continue;
    if (!d.nextAction) {
      issues.push({ type: "stale", severity: "high", target: "deals", ids: [d.id], message: `商談「${d.title}」:次のアクションが未設定` });
    } else if (d.nextActionDate && d.nextActionDate < todayStr) {
      issues.push({ type: "stale", severity: "high", target: "deals", ids: [d.id], message: `商談「${d.title}」:次アクション期限切れ(${d.nextActionDate})` });
    }
    if (d.closeDate && d.closeDate < todayStr) {
      issues.push({ type: "stale", severity: "medium", target: "deals", ids: [d.id], message: `商談「${d.title}」:受注予定日(${d.closeDate})を過ぎています。予定日の見直しか、受注・失注の登録を` });
    }
    if (!d.amount) {
      issues.push({ type: "missing", severity: "low", target: "deals", ids: [d.id], message: `商談「${d.title}」:金額が未入力` });
    }
  }

  // 品質スコア:重大度ごとに減点(100点満点)
  const weight = { high: 5, medium: 2, low: 1 };
  const records = companies.length + contacts.length + deals.length;
  const penalty = issues.reduce((s, i) => s + weight[i.severity], 0);
  // 全レコードが「重要」1件ずつ抱えている状態を0点とする
  const score = records === 0 ? 100 : Math.max(0, Math.round(100 - (penalty / (records * weight.high)) * 100));

  const order = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return { score, issues };
}

// 重複した会社を1つにまとめる(先頭を残し、担当者・商談・議事録を付け替え)
export function mergeCompanies(store, ids) {
  // 同じIDが重複して渡されても、統合先を消してしまわないようにする
  const [keepId, ...dropIds] = [...new Set(ids)];
  const keep = store.get("companies", keepId);
  if (!keep) throw new Error("統合先の会社が見つかりません");
  const patch = {};
  for (const dropId of dropIds) {
    const drop = store.get("companies", dropId);
    if (!drop) continue;
    // 空欄だけ、統合元の値で埋める
    for (const [k, v] of Object.entries(drop)) {
      if (["id", "createdAt", "updatedAt", "name"].includes(k)) continue;
      const cur = patch[k] ?? keep[k];
      if ((cur === undefined || cur === "" || cur === null) && v) patch[k] = v;
    }
    for (const col of ["contacts", "deals", "meetings"]) {
      for (const r of store.list(col)) if (r.companyId === dropId) store.update(col, r.id, { companyId: keepId });
    }
    store.remove("companies", dropId);
  }
  return store.update("companies", keepId, { ...patch, name: normalizeCompanyName(keep.name) });
}

// 重複した担当者を1人にまとめる(先頭を残し、空欄をほかの人の値で埋める)
export function mergeContacts(store, ids) {
  const [keepId, ...dropIds] = [...new Set(ids)];
  const keep = store.get("contacts", keepId);
  if (!keep) throw new Error("統合先の担当者が見つかりません");
  const patch = {};
  for (const dropId of dropIds) {
    const drop = store.get("contacts", dropId);
    if (!drop) continue;
    for (const [k, v] of Object.entries(drop)) {
      if (["id", "createdAt", "updatedAt", "name", "companyId"].includes(k)) continue;
      const cur = patch[k] ?? keep[k];
      if ((cur === undefined || cur === "" || cur === null || cur === "不明") && v) patch[k] = v;
    }
    store.remove("contacts", dropId);
  }
  return store.update("contacts", keepId, patch);
}

// 大手開拓の優先度スコア(0〜100)と、その内訳。
// 「なぜこの順位なのか」を説明できるよう、加点・減点の理由も返す。
export function priorityDetail(store, company, { contacts, deals, meetings, today = new Date() } = {}) {
  contacts ??= store.list("contacts");
  deals ??= store.list("deals");
  meetings ??= store.list("meetings");
  const reasons = [];
  const add = (label, points) => { if (points) reasons.push({ label, points }); };

  add(`企業規模:${company.tier || "未設定"}`, { 大手: 30, 中堅: 18, 中小: 8 }[company.tier] ?? 5);

  const mine = contacts.filter((p) => p.companyId === company.id);
  if (mine.some((p) => p.role === "決裁者")) add("決裁者と接点がある", 20);
  else if (mine.some((p) => p.role === "推進者")) add("推進者と接点がある", 10);
  else if (mine.length) add("担当者を登録済み", 4);

  const myDeals = deals.filter((d) => d.companyId === company.id);
  const open = myDeals.filter((d) => !["受注", "失注"].includes(d.stage));
  if (open.length) {
    const stagePts = { 交渉: 20, 提案: 16, ヒアリング: 12, アプローチ: 8, リード: 5 };
    const best = open.reduce((a, d) => ((stagePts[d.stage] ?? 0) > (stagePts[a.stage] ?? 0) ? d : a), open[0]);
    add(`進行中の商談(${best.stage || "リード"})`, stagePts[best.stage] ?? 5);
    const total = open.reduce((a, d) => a + (Number(d.amount) || 0), 0);
    add(`商談の金額:${Math.round(total / 10000).toLocaleString("ja-JP")}万円`, total >= 1e7 ? 10 : total >= 3e6 ? 6 : total > 0 ? 3 : 0);
  }
  if (myDeals.some((d) => d.stage === "受注")) add("受注実績がある(追加提案の余地)", 5);
  else if (!open.length && myDeals.some((d) => d.stage === "失注")) add("過去に失注(再提案は慎重に)", -8);

  if (company.research) add("リサーチ済み", 8);
  if (company.accountPlan) add("開拓プランあり", 5);

  const since = localDate(today, -30);
  if (meetings.some((m) => m.companyId === company.id && (m.date || "") >= since)) add("直近30日に商談あり", 7);
  if (company.status === "休眠") add("休眠中", -5);

  const score = Math.min(100, Math.max(0, reasons.reduce((a, r) => a + r.points, 0)));
  return { score, reasons };
}

export function priorityScore(store, company, ctx) {
  return priorityDetail(store, company, ctx).score;
}

// CSV(ダブルクォート対応の簡易パーサ)
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function toCsv(rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Excelで文字化けしないようBOMを付ける
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
}
