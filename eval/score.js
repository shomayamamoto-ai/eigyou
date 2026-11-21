// 精度の採点(AIを使わない決まった手順なので、自動テストで正しさを確かめられる)
import { companyKey } from "../lib/crm.js";

const BANT = ["budget", "authority", "need", "timeline"];
const normName = (s) => String(s ?? "").normalize("NFKC").replace(/[\s ]/g, "");
const normPhone = (s) => String(s ?? "").normalize("NFKC").replace(/\D/g, "");

// 商談分析1件を採点する
export function scoreMeeting(result, expected) {
  const checks = [];
  for (const k of BANT) {
    const got = result?.bant?.[k]?.status ?? "(なし)";
    checks.push({ item: `BANT:${k}`, ok: got === expected.bant[k], expected: expected.bant[k], got });
  }
  const amount = result?.crmUpdate?.amount ?? null;
  // 議事録で裏づけの取れない金額は、システムがCRMに反映しない。採点も「反映される金額」で行う
  const effective = result?.crmUpdate?.amountVerified === false ? null : amount;
  const okAmounts = [expected.amount, ...(expected.amountAlternatives ?? [])];
  checks.push({ item: "金額", ok: okAmounts.includes(effective), expected: expected.amount, got: effective });
  const p = result?.winProbability;
  const [lo, hi] = expected.probability;
  checks.push({ item: "受注確度", ok: typeof p === "number" && p >= lo && p <= hi, expected: `${lo}〜${hi}%`, got: p });
  return { checks, correct: checks.filter((c) => c.ok).length, total: checks.length };
}

// 取り込み1件を採点する
export function scoreExtract(result, expected) {
  const checks = [];
  const companies = result?.companies ?? [];
  const contacts = result?.contacts ?? [];
  checks.push({
    item: "会社名",
    ok: companies.some((c) => companyKey(c.name) === companyKey(expected.company)),
    expected: expected.company,
    got: companies.map((c) => c.name).join(" / ") || "(なし)",
  });
  const p = contacts.find((x) => normName(x.name).includes(normName(expected.contact.name))) ?? contacts[0];
  checks.push({ item: "氏名", ok: Boolean(p) && normName(p.name).includes(normName(expected.contact.name)), expected: expected.contact.name, got: p?.name ?? "(なし)" });
  checks.push({ item: "メール", ok: (p?.email ?? "").toLowerCase() === expected.contact.email.toLowerCase(), expected: expected.contact.email || "(空欄)", got: p?.email || "(空欄)" });
  checks.push({ item: "電話", ok: normPhone(p?.phone) === normPhone(expected.contact.phone), expected: expected.contact.phone || "(空欄)", got: p?.phone || "(空欄)" });
  return { checks, correct: checks.filter((c) => c.ok).length, total: checks.length };
}

// 全体の集計(項目ごとの正答率も出す)
export function summarize(results) {
  const byItem = new Map();
  let correct = 0;
  let total = 0;
  for (const r of results) {
    correct += r.score.correct;
    total += r.score.total;
    for (const c of r.score.checks) {
      const key = c.item.startsWith("BANT:") ? "BANT" : c.item;
      const v = byItem.get(key) ?? { correct: 0, total: 0 };
      v.total++;
      if (c.ok) v.correct++;
      byItem.set(key, v);
    }
  }
  return {
    correct,
    total,
    accuracy: total ? Math.round((correct / total) * 1000) / 10 : null,
    byItem: Object.fromEntries([...byItem].map(([k, v]) => [k, { ...v, accuracy: Math.round((v.correct / v.total) * 1000) / 10 }])),
  };
}
