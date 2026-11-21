// AIの出力を「うのみにしない」ための検証。
//
// AIは、もっともらしい誤り(ハルシネーション)を出すことがあります。
// そこで、AIが出した内容を元の資料(議事録・名刺の文面・検索で実際に開いたページ)と
// 機械的に突き合わせ、裏づけが取れないものは「未確認」に落とします。
// ここはAIを使わない決まった手順なので、自動テストで正しさを確かめられます。
import { STAGES } from "./crm.js";
import { isDateString } from "./time.js";

// ---------- 文字のゆれを吸収する ----------
// 全角/半角・大文字/小文字・空白・句読点・かっこ類の違いを無視して比べる
export function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　、。,.!?!?「」『』()\[\]【】〈〉《》“”"'‘’…・:;~〜\-ー―—]/g, "");
}

// 引用が、元の文章に実際に含まれているか。
// AIが「…」で中略した引用は、区切った各部分がすべて含まれていれば可とする。
export function quoteFound(source, quote, minLength = 6) {
  const src = normalizeText(source);
  const parts = String(quote ?? "")
    .split(/…+|\.{3,}|(中略)|\(中略\)/)
    .map(normalizeText)
    .filter(Boolean);
  if (!parts.length) return false;
  if (parts.join("").length < minLength) return false;
  return parts.every((p) => src.includes(p));
}

// ---------- 誰の発言か ----------
// 議事録の各行を「顧客の発言」「営業(自社)の発言」「メモ」「不明」に分ける。
// BANT の根拠や金額は、顧客の発言にあるものだけを認める(営業側の説明やメモは根拠にしない)。
const SELLER = /^(営業|営業担当|担当営業|担当|自社|弊社|当社|こちら|sales|セールス|ae|is|fs|私)(\s*[((].*[))])?$/i;
const SPEAKER_RE = /^\s*(?:\[[^\]]*\]\s*)?(?:\d{1,2}:\d{2}(?::\d{2})?\s*)?([^::「」\n]{1,24}?)\s*[::]\s*/;
export function classifyLines(transcript, sellerNames = []) {
  const sellers = new Set(sellerNames.map((n) => normalizeText(n)).filter(Boolean));
  return String(transcript ?? "").split(/\r?\n/).map((raw) => {
    // 文字起こしツールの時刻表示([10:02] や 00:12:34)は、判定の前に取り除く
    const line = raw.normalize("NFKC").trim().replace(/^(\[\s*\d{1,2}:\d{2}(?::\d{2})?\s*\]|\d{1,2}:\d{2}(?::\d{2})?)\s*/, "");
    if (!line) return { kind: "blank", text: "" };
    // (メモ:…)、※…、# … のような行は、発言ではなく記録者のメモ
    if (/^[((\[【※#*]/.test(line) || /^(メモ|memo|note|備考)\s*[::]/i.test(line)) return { kind: "memo", text: line };
    const m = line.match(SPEAKER_RE);
    if (!m) return { kind: "unknown", text: line };
    const speaker = m[1].trim();
    const kind = SELLER.test(speaker) || sellers.has(normalizeText(speaker)) ? "seller" : "customer";
    return { kind, speaker, text: line.slice(m[0].length) };
  });
}

// 話者の書かれた行が1つもない議事録(要約メモなど)では、話者の区別はできないので全体を対象にする
export function customerText(transcript, sellerNames = []) {
  const lines = classifyLines(transcript, sellerNames);
  if (!lines.some((l) => l.kind === "seller" || l.kind === "customer")) return lines.filter((l) => l.kind !== "memo").map((l) => l.text).join("\n");
  return lines.filter((l) => l.kind === "customer" || l.kind === "unknown").map((l) => l.text).join("\n");
}

// 引用が見つかった場所が、誰の発言か("customer" / "seller" / "memo" / null=見つからない)
export function quoteOwner(transcript, quote, sellerNames = []) {
  const lines = classifyLines(transcript, sellerNames);
  for (const kind of ["customer", "unknown", "seller", "memo"]) {
    const text = lines.filter((l) => l.kind === kind).map((l) => l.text).join("\n");
    // 話者の書かれていない行は、顧客の発言として扱う(要約メモ形式の議事録に対応するため)
    if (text && quoteFound(text, quote)) return kind === "unknown" ? "customer" : kind;
  }
  // 行をまたぐ引用は、議事録全体で確認する
  return quoteFound(transcript, quote) ? "customer" : null;
}

// ---------- 金額 ----------
// 文章中の金額表現を「円」の数値にして取り出す(例:1,200万円 → 12000000、1億2千万円 → 120000000)
const UNIT = { 億: 1e8, 千万: 1e7, 百万: 1e6, 万: 1e4, 千: 1e3 };
export function parseAmounts(text) {
  // 桁区切りのカンマ(1,200)だけを取り除く。「300万,2社」のような区切りのカンマは残す
  const s = String(text ?? "").normalize("NFKC").replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  const out = new Set();
  // 「1億2000万円」のように単位が連なる表現を、ひとかたまりとして読む
  const re = /((?:\d+(?:\.\d+)?(?:億|千万|百万|万|千))+)(\d+)?円?|(\d+(?:\.\d+)?)円/g;
  for (const m of s.matchAll(re)) {
    if (m[3]) {
      out.add(Math.round(Number(m[3])));
      continue;
    }
    let total = 0;
    for (const p of m[1].matchAll(/(\d+(?:\.\d+)?)(億|千万|百万|万|千)/g)) total += Number(p[1]) * UNIT[p[2]];
    if (m[2]) total += Number(m[2]);
    out.add(Math.round(total));
  }
  return out;
}

// 1つの金額表現を数値にする(CSVの「1,200万円」「1.2億」「¥500,000」など)。読めなければ null
export function parseAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).normalize("NFKC").replace(/[\s¥\\]/g, "").replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  if (/^-?\d+(\.\d+)?円?$/.test(s)) return Number(s.replace("円", ""));
  const set = parseAmounts(s.endsWith("円") ? s : `${s}円`);
  return set.size === 1 ? [...set][0] : null;
}

// ---------- URL ----------
export function normalizeUrl(u) {
  try {
    const url = new URL(String(u).trim());
    if (!/^https?:$/.test(url.protocol)) return null;
    // 末尾の / や、追跡用のパラメータ・#以降の違いは無視して比べる
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

// =====================================================
// 1. リサーチ:「事実」は、実際に検索で開いたページを出典に持つものだけ
// =====================================================
export function verifyResearch(result, sources = []) {
  const opened = new Set(sources.map((s) => normalizeUrl(s.url)).filter(Boolean));
  const cited = (u) => {
    const n = normalizeUrl(u);
    return Boolean(n && opened.has(n));
  };
  const stats = { factsVerified: 0, factsDowngraded: 0, newsVerified: 0, newsUnverified: 0 };

  const challenges = (result.challenges ?? []).map((c) => {
    if (c.basis !== "事実") return { ...c, sourceUrl: "", verified: false };
    if (cited(c.sourceUrl)) {
      stats.factsVerified++;
      return { ...c, verified: true };
    }
    // 出典が確認できない「事実」は、推測に格下げする
    stats.factsDowngraded++;
    return { ...c, basis: "推測", sourceUrl: "", verified: false, downgraded: true };
  });

  const recentNews = (result.recentNews ?? []).map((n) => {
    const ok = cited(n.sourceUrl);
    ok ? stats.newsVerified++ : stats.newsUnverified++;
    return { ...n, sourceUrl: ok ? n.sourceUrl : "", verified: ok };
  });

  const scaleVerified = cited(result.scaleSourceUrl);
  const website = /^https?:\/\//i.test(result.website ?? "") ? result.website : "";

  return {
    ...result,
    challenges,
    recentNews,
    website,
    scaleSourceUrl: scaleVerified ? result.scaleSourceUrl : "",
    scaleVerified,
    verification: stats,
  };
}

// =====================================================
// 2. 商談分析:BANT は議事録の引用で裏づけ、金額・日付・確度を点検
// =====================================================
const BANT_KEYS = ["budget", "authority", "need", "timeline"];
const BANT_SCORE = { 確認済: 1, 一部確認: 0.5, 未確認: 0 };

// BANT の確認状況から見た、受注確度の上限。
// 「予算も決裁者も未確認なのに確度80%」のような、根拠のない楽観を防ぐ。
export function probabilityCap(bant) {
  const score = BANT_KEYS.reduce((a, k) => a + (BANT_SCORE[bant?.[k]?.status] ?? 0), 0);
  if (score >= 4) return 95;
  if (score >= 3) return 80;
  if (score >= 2) return 60;
  if (score >= 1) return 40;
  return 20;
}

export function verifyMeeting(analysis, transcript, { date, currentStage, sellerNames = [] } = {}) {
  const a = structuredClone(analysis);
  const notes = [];

  // (1) BANT:引用が「顧客の発言」として議事録に実在しない項目は「未確認」に戻す
  let unsupported = 0;
  let notCustomer = 0;
  for (const k of BANT_KEYS) {
    const item = a.bant?.[k];
    if (!item) continue;
    if (item.status === "未確認") {
      item.quote = "";
      continue;
    }
    const owner = quoteOwner(transcript, item.quote, sellerNames);
    if (owner === "customer") {
      item.verified = true;
    } else if (owner === "seller" || owner === "memo") {
      // 営業側の説明や、記録者のメモは、顧客の意思の根拠にならない
      item.originalStatus = item.status;
      item.status = "未確認";
      item.verified = false;
      item.unsupported = true;
      item.quoteSource = owner;
      notCustomer++;
      unsupported++;
    } else {
      item.originalStatus = item.status;
      item.status = "未確認";
      item.quote = "";
      item.verified = false;
      item.unsupported = true;
      unsupported++;
    }
  }
  if (unsupported - notCustomer) notes.push(`BANTの${unsupported - notCustomer}項目は、議事録の中に根拠となる発言を確認できなかったため「未確認」にしました。`);
  if (notCustomer) notes.push(`BANTの${notCustomer}項目は、根拠が営業側の発言やメモだったため「未確認」にしました(顧客の発言だけを根拠にします)。`);

  // (2) 受注確度:0〜100の整数にし、BANTの裏づけに見合う上限をかける
  let p = Math.round(Number(a.winProbability));
  if (!Number.isFinite(p)) p = 0;
  p = Math.min(100, Math.max(0, p));
  const cap = probabilityCap(a.bant);
  if (p > cap) {
    notes.push(`受注確度を ${p}% から ${cap}% に調整しました(BANTの確認状況から見た上限)。`);
    a.probabilityAdjusted = { from: p, to: cap };
    p = cap;
  }
  a.winProbability = p;

  // (3) 金額:議事録に同じ金額が出てこなければ、CRMには自動反映しない
  const u = a.crmUpdate ?? (a.crmUpdate = {});
  if (u.amount !== null && u.amount !== undefined) {
    // 金額も、顧客の発言に出てきたものだけを認める(営業側の「一般的には…」やメモの数字は除く)
    const amounts = parseAmounts(customerText(transcript, sellerNames));
    const n = Math.round(Number(u.amount));
    if (!Number.isFinite(n) || n <= 0) {
      u.amount = null;
    } else {
      u.amount = n;
      u.amountVerified = amounts.has(n);
      if (!u.amountVerified) notes.push(`金額(${n.toLocaleString("ja-JP")}円)は、顧客の発言の中に同じ金額を確認できなかったため、CRMには自動で反映しません。`);
    }
  }

  // (4) 次のアクション期限:正しい日付で、かつ商談日より後のものだけ
  if (u.nextActionDate && (!isDateString(u.nextActionDate) || (isDateString(date) && u.nextActionDate < date))) {
    notes.push("次のアクションの期限が不正(商談日より前、または日付として読めない)だったため、空欄にしました。");
    u.nextActionDate = "";
  }

  // (5) ステージ:決められた選択肢以外は、現在のステージを維持
  if (!STAGES.includes(u.stage)) u.stage = STAGES.includes(currentStage) ? currentStage : "ヒアリング";

  a.verification = { notes, bantUnsupported: unsupported, checked: true };
  return a;
}

// =====================================================
// 3. 取り込み(名刺・署名・メモ):元の文面に無い値は採用しない
// =====================================================
const digits = (s) => String(s ?? "").normalize("NFKC").replace(/\D/g, "");
const LEGAL = /株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|医療法人|学校法人|\(株\)|\(有\)|\(同\)/g;
const core = (name) => normalizeText(String(name ?? "").normalize("NFKC").replace(LEGAL, ""));

export function verifyExtract(result, text) {
  const src = normalizeText(text);
  const plain = String(text ?? "").normalize("NFKC");
  const srcEmails = new Set((plain.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) ?? []).map((e) => e.toLowerCase()));
  // 電話番号らしい数字のかたまり(ハイフン・空白・かっこ区切りを含む)を、桁だけにして集める
  const srcPhones = new Set((plain.match(/\+?\d[\d\-\s()]{7,}\d/g) ?? []).map(digits).filter((d) => d.length >= 9));
  const amounts = parseAmounts(text);
  const removed = [];
  const has = (v) => {
    const n = normalizeText(v);
    return n.length > 0 && src.includes(n);
  };
  const companyOk = (name) => {
    const c = core(name);
    return c.length >= 2 && src.includes(c);
  };

  const companies = (result.companies ?? []).filter((c) => {
    if (companyOk(c.name)) return true;
    removed.push(`会社「${c.name}」`);
    return false;
  }).map((c) => ({ ...c, website: c.website && has(c.website.replace(/^https?:\/\//i, "").replace(/\/$/, "")) ? c.website : "" }));

  const contacts = (result.contacts ?? []).filter((p) => {
    if (has(p.name)) return true;
    removed.push(`担当者「${p.name}」`);
    return false;
  }).map((p) => {
    const out = { ...p };
    // メールアドレスと電話番号は、1文字でも違えば届かないので「完全に同じもの」が文面にあるかで確かめる
    if (out.email && !srcEmails.has(String(out.email).normalize("NFKC").trim().toLowerCase())) { removed.push(`${p.name} のメール`); out.email = ""; }
    if (out.phone && !srcPhones.has(digits(out.phone))) { removed.push(`${p.name} の電話番号`); out.phone = ""; }
    if (out.title && !has(out.title)) out.title = "";
    if (out.department && !has(out.department)) out.department = "";
    if (out.companyName && !companyOk(out.companyName)) out.companyName = "";
    return out;
  });

  const deals = (result.deals ?? []).map((d) => {
    const out = { ...d };
    if (out.amount !== null && out.amount !== undefined && !amounts.has(Math.round(Number(out.amount)))) { removed.push(`商談「${d.title}」の金額`); out.amount = null; }
    if (out.companyName && !companyOk(out.companyName)) out.companyName = "";
    return out;
  });

  return { ...result, companies, contacts, deals, verification: { removed } };
}
