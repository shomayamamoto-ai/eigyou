// CRM整備:AIを使わず、ルールで機械的に
// チェックできる項目をまとめたモジュール。
// (重複・未入力・形式エラー・放置案件など)

import { localDate } from "./time.js";

export const STAGES = ["リード", "アプローチ", "ヒアリング", "提案", "交渉", "受注", "失注"];
export const STATUSES = ["未接触", "アプローチ中", "商談中", "取引中", "休眠"];
export const TIERS = ["大手", "中堅", "中小"];
export const ROLES = ["決裁者", "推進者", "影響者", "利用者", "不明"];

// 会社名のゆれ(株式会社/(株)/全角半角/空白)をそろえて比較用キーにする
export function companyKey(name = "") {
  return String(name)
    .normalize("NFKC")
    .replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)|\(同\)/g, "")
    .replace(/[\s・.,、。]/g, "")
    .toLowerCase();
}

// 表記をそろえる:(株)→株式会社、全角英数→半角、前後の空白削除
export function normalizeCompanyName(name = "") {
  let s = String(name).normalize("NFKC").trim().replace(/\s+/g, " ");
  s = s.replace(/^\(株\)\s*/, "株式会社").replace(/\s*\(株\)$/, "株式会社");
  s = s.replace(/^\(有\)\s*/, "有限会社").replace(/\s*\(有\)$/, "有限会社");
  return s;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+\-() ]{9,}$/;

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
        message: `会社の重複の可能性:${list.map((c) => c.name).join(" / ")}`,
        fix: "merge",
      });
    }
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
  for (const p of contacts) {
    if (p.email && !EMAIL_RE.test(p.email)) {
      issues.push({ type: "format", severity: "medium", target: "contacts", ids: [p.id], message: `${p.name}:メールアドレスの形式が不正(${p.email})` });
    }
    if (p.phone && !PHONE_RE.test(String(p.phone).normalize("NFKC"))) {
      issues.push({ type: "format", severity: "low", target: "contacts", ids: [p.id], message: `${p.name}:電話番号の形式を確認してください(${p.phone})` });
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
  const [keepId, ...dropIds] = ids;
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

// 大手開拓の優先度スコア(0〜100)。ルールベースの目安
export function priorityScore(store, company) {
  let s = 0;
  if (company.tier === "大手") s += 35;
  else if (company.tier === "中堅") s += 20;
  else s += 10;
  if (company.research) s += 15;
  if (company.accountPlan) s += 10;
  const contacts = store.list("contacts").filter((p) => p.companyId === company.id);
  if (contacts.some((p) => p.role === "決裁者")) s += 20;
  else if (contacts.some((p) => p.role === "推進者")) s += 10;
  const deals = store.list("deals").filter((d) => d.companyId === company.id && !["受注", "失注"].includes(d.stage));
  if (deals.length) s += 20;
  return Math.min(100, s);
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
