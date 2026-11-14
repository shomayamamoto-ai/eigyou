// Claude API を使う「AI部分」をまとめたモジュール。
// APIキーが未設定のときは、画面の動作確認ができるよう
// 「デモ用のサンプル結果」を返します(内容は架空です)。
import Anthropic from "@anthropic-ai/sdk";
import { STAGES, ROLES, TIERS } from "./crm.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

export const aiEnabled = () =>
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let client = null;
const getClient = () => (client ??= new Anthropic());

// ---------- JSONスキーマを書きやすくする小道具 ----------
const str = (description) => ({ type: "string", ...(description && { description }) });
const num = (description) => ({ type: "number", ...(description && { description }) });
const nullable = (s) => ({ anyOf: [s, { type: "null" }] });
const arr = (items, description) => ({ type: "array", items, ...(description && { description }) });
const enm = (values, description) => ({ type: "string", enum: values, ...(description && { description }) });
const obj = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const SYSTEM = `あなたは日本のBtoB営業を支援する、経験豊富な営業企画・インサイドセールスの専門家です。
- 出力はすべて自然でビジネスに使える日本語で書きます。
- 事実と推測をはっきり分けます。確認できない情報は「不明」や「推測」と明記し、作り話をしません。
- 営業担当がそのまま次の行動に移せる、具体的な内容にします。`;

// ---------- Claude 呼び出しの共通処理 ----------
async function callClaude({ prompt, schema, webSearch = false, effort = "medium", onUsage }) {
  const messages = [{ role: "user", content: prompt }];
  const params = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort, format: { type: "json_schema", schema } },
    // 安全フィルタで断られた場合は、APIが自動で別モデルに切り替えて再実行する
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    ...(webSearch && { tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }] }),
  };

  let response;
  // Web検索などサーバー側ツールが長引くと pause_turn で一度止まるので、続きを依頼する
  for (let i = 0; i < 5; i++) {
    response = await getClient().beta.messages.create({ ...params, messages });
    // 利用量(トークン数)を記録 → テナントごとの原価把握・料金プランの上限管理に使う
    onUsage?.({ input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 });
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }

  if (response.stop_reason === "refusal") {
    throw new Error("AIがこの依頼への回答を控えました。入力内容を見直してください。");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("回答が長すぎて途中で切れました。入力を短くして再実行してください。");
  }

  const texts = response.content.filter((b) => b.type === "text").map((b) => b.text);
  const sources = collectSources(response.content);
  for (const t of [texts.at(-1), texts.join("")]) {
    const parsed = tryParseJson(t);
    if (parsed) return { result: parsed, sources };
  }
  throw new Error("AIの回答を読み取れませんでした。もう一度お試しください。");
}

function tryParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(text.slice(s, e + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Web検索で実際に参照したページ(出典)を集める
function collectSources(content) {
  const seen = new Map();
  for (const b of content) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (r.url && !seen.has(r.url)) seen.set(r.url, r.title || r.url);
    }
    if (b.type === "text" && Array.isArray(b.citations)) {
      for (const c of b.citations) if (c.url && !seen.has(c.url)) seen.set(c.url, c.title || c.url);
    }
  }
  return [...seen].map(([url, title]) => ({ url, title }));
}

const companyBrief = (c) =>
  [
    `会社名:${c.name}`,
    c.industry && `業種:${c.industry}`,
    c.tier && `規模:${c.tier}`,
    c.website && `Webサイト:${c.website}`,
    c.notes && `メモ:${c.notes}`,
  ]
    .filter(Boolean)
    .join("\n");

// =====================================================
// 1. リサーチ
// =====================================================
const researchSchema = obj({
  summary: str("会社の概要を3〜4文で"),
  business: arr(str(), "主な事業・製品"),
  scale: str("売上・従業員数など規模感。出典がなければ「不明」"),
  industry: str("業種(短く)"),
  tier: enm(TIERS, "企業規模の区分"),
  website: str("公式サイトURL。不明なら空文字"),
  recentNews: arr(obj({ date: str("YYYY-MM や YYYY-MM-DD"), title: str(), point: str("営業的な意味合い") })),
  challenges: arr(obj({ text: str(), basis: enm(["事実", "推測"]) }), "想定される経営・業務課題"),
  opportunities: arr(str(), "自社サービスを提案できる切り口"),
  keyQuestions: arr(str(), "初回商談で聞くべき質問"),
});

export async function research(company, offering, onUsage) {
  if (!aiEnabled()) return demo.research(company);
  const prompt = `次の企業について、営業の事前準備として調査してください。
Web検索で公式サイト・IR資料・プレスリリース・ニュースを確認し、事実には根拠を持たせてください。

${companyBrief(company)}

自社(売り手)の提供サービス:${offering || "未設定(一般的なBtoBソリューションとして考える)"}

課題は、事実(出典で確認できたもの)と推測(あなたの仮説)を basis で区別してください。`;
  const { result, sources } = await callClaude({ prompt, schema: researchSchema, webSearch: true, effort: "medium", onUsage });
  return { ...result, sources, generatedAt: new Date().toISOString(), demo: false };
}

// =====================================================
// 2. 大手開拓(アカウントプラン)
// =====================================================
const accountPlanSchema = obj({
  whyNow: str("この会社を今攻めるべき理由"),
  decisionProcess: str("意思決定プロセスの仮説(稟議・関与部門など)"),
  keyPersons: arr(
    obj({
      position: str("部署・役職"),
      role: enm(ROLES),
      concerns: str("この人が気にしていること"),
      approach: str("アプローチ方法"),
    }),
  ),
  entryPoints: arr(str(), "接点を作る入り口(紹介、イベント、既存取引など)"),
  steps: arr(obj({ phase: str(), action: str(), timing: str(), kpi: str() })),
  email: obj({ subject: str(), body: str("初回アプローチメール本文。差出人名は【氏名】のままでよい") }),
  risks: arr(obj({ risk: str(), countermeasure: str() })),
});

export async function accountPlan(company, contacts, deals, offering, onUsage) {
  if (!aiEnabled()) return demo.accountPlan(company);
  const prompt = `大手企業の新規開拓(アカウントベースドマーケティング)の計画を立ててください。

## 対象企業
${companyBrief(company)}

## 事前リサーチ
${company.research ? JSON.stringify(company.research, null, 1) : "なし"}

## 登録済みの担当者
${contacts.length ? contacts.map((p) => `- ${p.name}(${p.department || ""} ${p.title || ""} / ${p.role || "不明"})`).join("\n") : "なし"}

## 進行中の商談
${deals.length ? deals.map((d) => `- ${d.title}:${d.stage} / ${d.amount || "金額未定"}円`).join("\n") : "なし"}

## 自社の提供サービス
${offering || "未設定"}

大手企業は関係者が多く、稟議に時間がかかる前提で、複数部門への多面的なアプローチを設計してください。`;
  const { result } = await callClaude({ prompt, schema: accountPlanSchema, effort: "high", onUsage });
  return { ...result, generatedAt: new Date().toISOString(), demo: false };
}

// =====================================================
// 3. CRM整備(メモ・名刺・メール署名からの取り込み)
// =====================================================
const extractSchema = obj({
  companies: arr(obj({ name: str(), industry: str(), tier: enm(TIERS), website: str(), notes: str() })),
  contacts: arr(
    obj({
      companyName: str(),
      name: str(),
      title: str(),
      department: str(),
      email: str(),
      phone: str(),
      role: enm(ROLES),
    }),
  ),
  deals: arr(obj({ companyName: str(), title: str(), amount: nullable(num()), stage: enm(STAGES), nextAction: str() })),
});

export async function extractCrm(text, onUsage) {
  if (!aiEnabled()) return demo.extract(text);
  const prompt = `次のテキスト(名刺、メール署名、営業メモなど)から、CRMに登録する情報を抜き出してください。
- 書かれていない項目は空文字にし、推測で埋めないでください(tier と role と stage は最も近いものを選ぶ)。
- 会社名は「株式会社」などの法人格を正式な位置に付けて表記をそろえてください。

---
${text}
---`;
  const { result } = await callClaude({ prompt, schema: extractSchema, effort: "low", onUsage });
  return { ...result, demo: false };
}

// =====================================================
// 4. 商談分析
// =====================================================
const bantItem = obj({ status: enm(["確認済", "一部確認", "未確認"]), detail: str() });
const meetingSchema = obj({
  summary: str("商談の要約(5文以内)"),
  customerIssues: arr(str(), "顧客が話した課題"),
  bant: obj({ budget: bantItem, authority: bantItem, need: bantItem, timeline: bantItem }),
  winProbability: num("受注確度(0〜100)"),
  probabilityReason: str(),
  riskSignals: arr(str(), "失注につながりそうな兆候"),
  nextActions: arr(obj({ task: str(), owner: enm(["自社", "顧客"]), due: str("YYYY-MM-DD または 目安") })),
  coaching: obj({ good: arr(str()), improve: arr(str()) }),
  crmUpdate: obj({
    stage: enm(STAGES),
    amount: nullable(num("話に出た金額(円)。出ていなければ null")),
    nextAction: str(),
    nextActionDate: str("YYYY-MM-DD。不明なら空文字"),
  }),
  followupEmail: obj({ subject: str(), body: str() }),
});

export async function analyzeMeeting({ transcript, company, deal, date, history = [] }, onUsage) {
  if (!aiEnabled()) return demo.meeting();
  const prompt = `次の商談の議事録(または文字起こし)を分析してください。

## 商談情報
- 会社:${company?.name ?? "不明"}
- 案件:${deal?.title ?? "不明"}(現在のステージ:${deal?.stage ?? "不明"})
- 商談日:${date || "不明"}(日付の計算はこの日を基準にする)

## これまでの商談の経緯(古い分析結果。新しい順)
${history.length ? history.map((h) => `- ${h.date}:${h.summary}(当時の確度 ${Math.round(h.winProbability ?? 0)}%/予定していた次のアクション:${(h.nextActions ?? []).join("、") || "なし"})`).join("\n") : "なし(今回が初回の記録)"}

## 今回の議事録
${transcript}

BANT(予算・決裁者・必要性・導入時期)は、議事録で確認できた事実だけを根拠に判定してください。
コーチングは営業担当者の話し方・質問の質について、具体的な場面を挙げて書いてください。
経緯がある場合は、前回予定していた次のアクションが実行されたか、確度が上がった・下がった理由も要約とリスクに反映してください。`;
  const { result } = await callClaude({ prompt, schema: meetingSchema, effort: "high", onUsage });
  return { ...result, generatedAt: new Date().toISOString(), demo: false };
}

// =====================================================
// デモ用サンプル(APIキー未設定時)
// =====================================================
const DEMO_NOTE = "【デモ】APIキー未設定のため、画面確認用のサンプル文を表示しています。実際の調査結果ではありません。";

const demo = {
  research(c) {
    return {
      summary: `${DEMO_NOTE} ${c.name}は(サンプル)国内で事業を展開する企業という想定です。`,
      business: ["(サンプル)主力事業A", "(サンプル)新規事業B"],
      scale: "不明(デモ)",
      industry: c.industry || "未設定",
      tier: c.tier || "大手",
      website: c.website || "",
      recentNews: [{ date: "----", title: "(サンプル)中期経営計画でDX推進を発表", point: "業務効率化の予算が付きやすい時期と推測" }],
      challenges: [
        { text: "(サンプル)営業活動の属人化", basis: "推測" },
        { text: "(サンプル)顧客データが部門ごとに分散", basis: "推測" },
      ],
      opportunities: ["(サンプル)営業データの一元管理", "(サンプル)商談記録の自動化"],
      keyQuestions: ["現在の営業管理はどのツールで行っていますか?", "今期、営業部門で最も優先度の高い課題は何ですか?"],
      sources: [],
      generatedAt: new Date().toISOString(),
      demo: true,
    };
  },
  accountPlan(c) {
    return {
      whyNow: `${DEMO_NOTE}(サンプル)${c.name}は新たな投資計画を進めている想定のため、今が接点づくりの好機です。`,
      decisionProcess: "(サンプル)現場部門が起案 → 情報システム部門が評価 → 役員会で決裁、という流れを想定。",
      keyPersons: [
        { position: "営業企画部 部長", role: "推進者", concerns: "営業生産性の向上", approach: "業界事例を添えたセミナー招待" },
        { position: "情報システム部 部長", role: "影響者", concerns: "セキュリティ・既存システムとの連携", approach: "技術資料と導入実績の提示" },
        { position: "営業本部長(執行役員)", role: "決裁者", concerns: "売上目標の達成", approach: "推進者経由で経営インパクトを提示" },
      ],
      entryPoints: ["既存取引先からの紹介", "業界カンファレンスでの名刺交換", "ホワイトペーパー経由の問い合わせ"],
      steps: [
        { phase: "1. 接点づくり", action: "推進者候補へ事例付きでアプローチ", timing: "1〜2か月目", kpi: "面談2件" },
        { phase: "2. 課題の共有", action: "ヒアリングと現状診断レポートの提出", timing: "3か月目", kpi: "課題合意" },
        { phase: "3. 提案・稟議支援", action: "部門横断で提案、稟議資料の作成を支援", timing: "4〜6か月目", kpi: "PoC合意" },
      ],
      email: {
        subject: `【ご相談】${c.name}様の営業生産性向上について`,
        body: `${c.name}\n営業企画部 ご担当者様\n\n突然のご連絡失礼いたします。【会社名】の【氏名】と申します。\n(以下、デモ用のサンプル文面です)\n\n貴社と同じ業界の企業様で、営業記録の自動化により\n報告業務を削減した事例がございます。\n15分ほどオンラインで情報交換のお時間をいただけないでしょうか。\n\n何卒よろしくお願いいたします。`,
      },
      risks: [{ risk: "(サンプル)稟議が長期化する", countermeasure: "小規模なPoCから始め、早期に成果を示す" }],
      generatedAt: new Date().toISOString(),
      demo: true,
    };
  },
  extract(text) {
    // デモ:メール・電話・会社名らしき行だけを機械的に拾う
    const email = text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0] ?? "";
    const phone = text.match(/0\d{1,4}-\d{1,4}-\d{3,4}/)?.[0] ?? "";
    const companyLine = text.split(/\n/).find((l) => /株式会社|\(株\)|有限会社|合同会社/.test(l))?.trim() ?? "サンプル株式会社";
    const nameLine = text.split(/\n/).map((l) => l.trim()).find((l) => l && l !== companyLine && !l.includes("@") && !/\d{2,}/.test(l)) ?? "サンプル 太郎";
    return {
      companies: [{ name: companyLine, industry: "", tier: "中堅", website: "", notes: "デモ取り込み" }],
      contacts: [{ companyName: companyLine, name: nameLine, title: "", department: "", email, phone, role: "不明" }],
      deals: [],
      demo: true,
    };
  },
  meeting() {
    const d = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    return {
      summary: `${DEMO_NOTE}(サンプル)顧客は営業報告の手間に課題を感じており、来期からの導入を検討中。`,
      customerIssues: ["(サンプル)日報作成に1日30分かかっている", "(サンプル)案件状況が上長に見えない"],
      bant: {
        budget: { status: "一部確認", detail: "(サンプル)来期予算で検討との発言あり、金額は未確認" },
        authority: { status: "未確認", detail: "(サンプル)決裁者は未特定" },
        need: { status: "確認済", detail: "(サンプル)報告業務の削減ニーズが明確" },
        timeline: { status: "一部確認", detail: "(サンプル)来期(4月)開始を希望" },
      },
      winProbability: 40,
      probabilityReason: "(サンプル)ニーズは明確だが、決裁者と予算が未確認のため。",
      riskSignals: ["(サンプル)競合他社も比較検討中"],
      nextActions: [
        { task: "導入事例と概算見積を送付", owner: "自社", due: d },
        { task: "決裁者との面談を設定", owner: "顧客", due: "2週間以内" },
      ],
      coaching: {
        good: ["(サンプル)課題を数字で確認できていた"],
        improve: ["(サンプル)決裁プロセスを質問できていない。「最終的にどなたがご判断されますか?」と確認する"],
      },
      crmUpdate: { stage: "ヒアリング", amount: null, nextAction: "導入事例と概算見積を送付", nextActionDate: d },
      followupEmail: {
        subject: "本日の打ち合わせのお礼",
        body: "本日はお時間をいただき、ありがとうございました。\n(以下、デモ用のサンプル文面です)\nお話しいただいた課題をふまえ、事例と概算見積をお送りします。",
      },
      generatedAt: new Date().toISOString(),
      demo: true,
    };
  },
};
