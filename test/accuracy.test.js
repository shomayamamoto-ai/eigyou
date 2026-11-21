// 「精度」に関わる判定のテスト。AIを使わない決まった手順なので、結果を厳密に確かめられる。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { quoteFound, parseAmounts, parseAmount, verifyResearch, verifyMeeting, verifyExtract, probabilityCap } from "../lib/verify.js";
import { companyKey, findSimilarCompanies, oneEditApart, checkEmail, checkPhone, checkQuality, priorityDetail, dealProbability, mergeContacts } from "../lib/crm.js";
import { parseDateLoose } from "../lib/time.js";
import { Database } from "../lib/db.js";
import { initSecrets } from "../lib/secrets.js";
import { createApp } from "../lib/app.js";

process.env.APP_ENCRYPTION_KEY = "e".repeat(64);
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ALLOW_SIGNUP;
initSecrets({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "eigyou-")) });

const TRANSCRIPT = `営業:本日はありがとうございます。現在の課題を教えてください。
山田部長:日報の作成に、1人あたり1日30分はかかっています。
営業:ご予算の目安はございますか。
山田部長:予算は年間1,200万円程度を想定しています。最終的には高橋本部長の承認が必要です。
営業:導入時期はいかがでしょうか。
山田部長:来期から使い始めたいですね。`;

// ---------- 引用の照合 ----------
test("引用:議事録に実在する発言だけを根拠として認める", () => {
  assert.ok(quoteFound(TRANSCRIPT, "予算は年間1,200万円程度を想定しています"));
  assert.ok(quoteFound(TRANSCRIPT, "予算は年間1,200万円程度を想定しています。"), "全角数字・句読点の違いは許容");
  assert.ok(quoteFound(TRANSCRIPT, "日報の作成に…1日30分はかかっています"), "中略は各部分が実在すれば可");
  assert.ok(!quoteFound(TRANSCRIPT, "予算は年間2,000万円を確保しています"), "作られた発言は不可");
  assert.ok(!quoteFound(TRANSCRIPT, "予算は潤沢にあると言っていた"), "言い換え・要約は不可");
  assert.ok(!quoteFound(TRANSCRIPT, "です"), "短すぎる引用は根拠にしない");
  assert.ok(!quoteFound(TRANSCRIPT, ""));
});

// ---------- 金額の読み取り ----------
test("金額:いろいろな書き方を円に直す", () => {
  assert.deepEqual([...parseAmounts("年間1,200万円程度")], [12000000]);
  assert.deepEqual([...parseAmounts("1億2000万円の投資")], [120000000]);
  assert.deepEqual([...parseAmounts("月額50万円、初期費用は300,000円")].sort((a, b) => a - b), [300000, 500000]);
  assert.deepEqual([...parseAmounts("1.5億円")], [150000000]);
  assert.deepEqual([...parseAmounts("30分かかります。3人です。")], [], "金額でない数字は拾わない");
  assert.equal(parseAmount("1,200万円"), 12000000);
  assert.equal(parseAmount("¥500,000"), 500000);
  assert.equal(parseAmount("1.2億"), 120000000);
  assert.equal(parseAmount(4800000), 4800000);
  assert.equal(parseAmount("未定"), null);
  assert.equal(parseAmount(""), null);
});

// ---------- 商談分析の検証 ----------
const analysis = (over = {}) => ({
  summary: "x",
  bant: {
    budget: { status: "確認済", detail: "年間1,200万円", quote: "予算は年間1,200万円程度を想定しています" },
    authority: { status: "確認済", detail: "高橋本部長", quote: "最終的には高橋本部長の承認が必要です" },
    need: { status: "確認済", detail: "日報の負担", quote: "日報の作成に、1人あたり1日30分はかかっています" },
    timeline: { status: "一部確認", detail: "来期", quote: "来期から使い始めたいですね" },
  },
  winProbability: 65,
  crmUpdate: { stage: "提案", amount: 12000000, nextAction: "デモ", nextActionDate: "2026-12-01" },
  ...over,
});

test("商談分析:根拠がそろっていれば、そのまま通す", () => {
  const r = verifyMeeting(analysis(), TRANSCRIPT, { date: "2026-11-20" });
  assert.equal(r.winProbability, 65);
  assert.equal(r.crmUpdate.amount, 12000000);
  assert.equal(r.crmUpdate.amountVerified, true);
  assert.ok(Object.values(r.bant).every((b) => b.verified));
  assert.deepEqual(r.verification.notes, []);
});

test("商談分析:議事録にない根拠を挙げたBANTは「未確認」に戻し、確度も下げる", () => {
  const a = analysis({ winProbability: 90 });
  a.bant.budget.quote = "予算は5,000万円を確保済みです"; // 議事録にない発言
  a.bant.authority.quote = "決裁者は私です"; // 議事録にない発言
  const r = verifyMeeting(a, TRANSCRIPT, { date: "2026-11-20" });
  assert.equal(r.bant.budget.status, "未確認");
  assert.equal(r.bant.budget.unsupported, true);
  assert.equal(r.bant.authority.status, "未確認");
  assert.equal(r.bant.need.status, "確認済");
  // 残った根拠は「必要性(確認済)+時期(一部確認)」= 1.5 → 上限40%
  assert.equal(r.winProbability, 40);
  assert.deepEqual(r.probabilityAdjusted, { from: 90, to: 40 });
  assert.equal(r.verification.bantUnsupported, 2);
});

test("商談分析:議事録に出てこない金額は、CRMに自動反映しない", () => {
  const r = verifyMeeting(analysis({ crmUpdate: { stage: "提案", amount: 14400000, nextAction: "x", nextActionDate: "" } }), TRANSCRIPT, {});
  assert.equal(r.crmUpdate.amountVerified, false);
  assert.match(r.verification.notes.join(), /自動で反映しません/);
});

test("商談分析:不正な日付・ステージ・確度を直す", () => {
  const r = verifyMeeting(
    analysis({ winProbability: 250, crmUpdate: { stage: "ほぼ決まり", amount: null, nextAction: "x", nextActionDate: "2026-11-01" } }),
    TRANSCRIPT, { date: "2026-11-20", currentStage: "ヒアリング" },
  );
  assert.equal(r.winProbability, 80, "100超は丸め、BANTの上限(3.5点 → 80%)も適用");
  assert.equal(r.crmUpdate.nextActionDate, "", "商談日より前の期限は採用しない");
  assert.equal(r.crmUpdate.stage, "ヒアリング", "選択肢にないステージは現状維持");
});

test("確度の上限は、BANTの確認状況に応じて決まる", () => {
  const b = (...s) => Object.fromEntries(["budget", "authority", "need", "timeline"].map((k, i) => [k, { status: s[i] }]));
  assert.equal(probabilityCap(b("未確認", "未確認", "未確認", "未確認")), 20);
  assert.equal(probabilityCap(b("確認済", "未確認", "未確認", "未確認")), 40);
  assert.equal(probabilityCap(b("確認済", "確認済", "未確認", "未確認")), 60);
  assert.equal(probabilityCap(b("確認済", "確認済", "確認済", "一部確認")), 80);
  assert.equal(probabilityCap(b("確認済", "確認済", "確認済", "確認済")), 95);
});

// ---------- リサーチの検証 ----------
test("リサーチ:実際に開いたページを出典に持たない「事実」は、推測に格下げする", () => {
  const sources = [{ url: "https://www.example.co.jp/ir/plan/", title: "中期経営計画" }, { url: "https://news.example.com/a?id=1", title: "記事" }];
  const r = verifyResearch({
    scale: "売上高 100億円(2025年度)", scaleSourceUrl: "https://example.co.jp/ir/plan",
    website: "javascript:alert(1)",
    challenges: [
      { text: "DXを重点施策に掲げている", basis: "事実", sourceUrl: "https://example.co.jp/ir/plan" }, // www・末尾/の違いは同じページ
      { text: "人手不足が深刻", basis: "事実", sourceUrl: "https://made-up.example/report" }, // AIが作ったURL
      { text: "出典なしの事実", basis: "事実", sourceUrl: "" },
      { text: "属人化の可能性", basis: "推測", sourceUrl: "https://example.co.jp/ir/plan" },
    ],
    recentNews: [
      { date: "2026-10", title: "新工場を開設", point: "x", sourceUrl: "https://news.example.com/a" },
      { date: "2026-09", title: "裏づけのないニュース", point: "x", sourceUrl: "https://nowhere.example/x" },
    ],
  }, sources);
  assert.deepEqual(r.challenges.map((c) => c.basis), ["事実", "推測", "推測", "推測"]);
  assert.equal(r.challenges[0].verified, true);
  assert.equal(r.challenges[1].downgraded, true);
  assert.equal(r.challenges[3].sourceUrl, "", "推測には出典を付けない");
  assert.deepEqual(r.recentNews.map((n) => n.verified), [true, false]);
  assert.equal(r.scaleVerified, true);
  assert.equal(r.website, "", "http(s)以外のURLは採用しない");
  assert.deepEqual(r.verification, { factsVerified: 1, factsDowngraded: 2, newsVerified: 1, newsUnverified: 1 });
});

// ---------- 取り込みの検証 ----------
test("取り込み:元の文面にない値(AIが補った値)は取り除く", () => {
  const text = "株式会社テスト工業\n営業部 部長\n田中 次郎\ntanaka@test-kogyo.example\nTEL 03-1111-2222\n来月、500万円の案件を検討";
  const r = verifyExtract({
    companies: [{ name: "テスト工業株式会社", website: "https://test-kogyo.example" }, { name: "株式会社まぼろし商事", website: "" }],
    contacts: [
      { companyName: "株式会社テスト工業", name: "田中 次郎", title: "部長", department: "営業部", email: "tanaka@test-kogyo.example", phone: "03-1111-2222", role: "決裁者" },
      { companyName: "株式会社テスト工業", name: "田中次郎", title: "社長", department: "", email: "jiro.tanaka@test-kogyo.example", phone: "090-0000-0000", role: "不明" },
      { companyName: "", name: "存在しない 太郎", title: "", department: "", email: "", phone: "", role: "不明" },
    ],
    deals: [{ companyName: "株式会社テスト工業", title: "新規案件", amount: 5000000 }, { companyName: "別会社", title: "別案件", amount: 9000000 }],
  }, text);
  assert.deepEqual(r.companies.map((c) => c.name), ["テスト工業株式会社"], "法人格の位置の違いは同じ会社とみなす");
  assert.equal(r.contacts.length, 2, "文面にいない人物は登録しない");
  assert.equal(r.contacts[0].email, "tanaka@test-kogyo.example");
  assert.equal(r.contacts[1].email, "", "文面にないメールは空欄");
  assert.equal(r.contacts[1].phone, "", "文面にない電話番号は空欄");
  assert.equal(r.contacts[1].title, "", "文面にない役職は空欄");
  assert.equal(r.deals[0].amount, 5000000);
  assert.equal(r.deals[1].amount, null);
  assert.equal(r.deals[1].companyName, "");
  assert.ok(r.verification.removed.length >= 4);
});

// ---------- 重複・類似の検出 ----------
test("会社名:法人格・英語表記・記号の違いを同じ会社とみなす", () => {
  const same = ["株式会社ABC商事", "(株)ABC商事", "㈱ABC商事", "ABC商事 株式会社", "ABC商事", "ABC・商事", "ABC商事 Co., Ltd."];
  for (const n of same) assert.equal(companyKey(n), companyKey(same[0]), n);
  assert.equal(companyKey("Sample Inc."), companyKey("SAMPLE"));
  assert.notEqual(companyKey("ABC商事"), companyKey("ABC物産"));
});

test("似ている会社を、理由つきで見つける(完全一致は対象外)", () => {
  const cs = [
    { id: "1", name: "株式会社ミライ商事", website: "" },
    { id: "2", name: "みらい商事株式会社", website: "" },
    { id: "3", name: "あおば製作所株式会社", website: "https://www.aoba.example/" },
    { id: "4", name: "AOBA Manufacturing", website: "aoba.example" },
    { id: "5", name: "そらネット通信株式会社", website: "" },
    { id: "6", name: "そらネット通信株式会社 大阪支店", website: "" },
    { id: "7", name: "ひかりフーズ株式会社", website: "" },
    { id: "8", name: "ひかりフース株式会社", website: "" },
    { id: "9", name: "まったく別の会社", website: "" },
    { id: "10", name: "東京支店", website: "" },
  ];
  const pairs = findSimilarCompanies(cs);
  const reason = (a, b) => pairs.find((p) => p.ids.includes(a) && p.ids.includes(b))?.reason;
  assert.match(reason("1", "2"), /ひらがな・カタカナ/);
  assert.match(reason("3", "4"), /Webサイトが同じ/);
  assert.match(reason("5", "6"), /別拠点/);
  assert.match(reason("7", "8"), /1文字だけ違う/);
  assert.equal(pairs.filter((p) => p.ids.includes("9")).length, 0, "無関係な会社は巻き込まない");
  assert.equal(pairs.filter((p) => p.ids.includes("10")).length, 0);
  assert.equal(pairs.length, 4);
  assert.ok(oneEditApart("abcde", "abxde") && oneEditApart("abcde", "abcd") && !oneEditApart("abcde", "abxye") && !oneEditApart("abc", "abc"));
});

test("メールアドレス:よくある入力ミスを見つけて、直す候補を出す", () => {
  assert.deepEqual(checkEmail("taro@example.co.jp"), { valid: true, suggestion: null });
  assert.equal(checkEmail("taro@gmail.con").suggestion, "taro@gmail.com");
  assert.equal(checkEmail("taro@gmial.com").suggestion, "taro@gmail.com");
  assert.equal(checkEmail("taro@example,co.jp").suggestion, "taro@example.co.jp");
  assert.equal(checkEmail("\uff54\uff41\uff52\uff4f\uff20example.co.jp").suggestion, "taro@example.co.jp", "全角を半角に");
  assert.equal(checkEmail(" taro@example.cojp ").suggestion, "taro@example.co.jp");
  assert.deepEqual(checkEmail("sato@mirai-shoji"), { valid: false, suggestion: null }, "直せないものは候補を出さない");
  assert.deepEqual(checkEmail("メールなし"), { valid: false, suggestion: null });
});

test("電話番号:桁数を確認し、表記をそろえる", () => {
  assert.deepEqual(checkPhone("03-1234-5678"), { valid: true, suggestion: null });
  assert.equal(checkPhone("03ー1234ー5678").suggestion, "03-1234-5678");
  assert.equal(checkPhone("090 1234 5678").suggestion, "09012345678");
  assert.equal(checkPhone("+81-3-1234-5678").valid, true);
  assert.equal(checkPhone("03-1234-567").valid, false, "桁が足りない");
  assert.equal(checkPhone("1234").valid, false);
});

test("日付:いろいろな書き方を読み取り、存在しない日付は採用しない", () => {
  assert.equal(parseDateLoose("2026/1/5"), "2026-01-05");
  assert.equal(parseDateLoose("2026年1月5日"), "2026-01-05");
  assert.equal(parseDateLoose("2026.01.05"), "2026-01-05");
  assert.equal(parseDateLoose("20260105"), "2026-01-05");
  assert.equal(parseDateLoose("令和8年1月5日"), "2026-01-05");
  assert.equal(parseDateLoose("R8.1.5"), "2026-01-05");
  assert.equal(parseDateLoose("2026/1/5 10:00"), "2026-01-05");
  assert.equal(parseDateLoose("2026/2/30"), "", "2月30日は存在しない");
  assert.equal(parseDateLoose("来週"), "");
  assert.equal(parseDateLoose(""), "");
});

// ---------- 優先度・見込み ----------
const tmpStore = () => { const db = new Database(":memory:"); return db.forTenant(db.createTenant({ name: "t" }).id); };

test("優先度:点数の内訳(理由)が出て、合計と一致する", () => {
  const s = tmpStore();
  const big = s.insert("companies", { name: "大手A", tier: "大手", research: { summary: "x" } });
  s.insert("contacts", { companyId: big.id, name: "決裁 太郎", role: "決裁者" });
  s.insert("deals", { companyId: big.id, title: "d", stage: "交渉", amount: 12000000 });
  const lost = s.insert("companies", { name: "中小B", tier: "中小", status: "休眠" });
  s.insert("deals", { companyId: lost.id, title: "d2", stage: "失注", amount: 1 });
  const a = priorityDetail(s, big);
  assert.equal(a.score, a.reasons.reduce((x, r) => x + r.points, 0));
  assert.ok(a.reasons.some((r) => r.label.includes("決裁者")) && a.reasons.some((r) => r.label.includes("交渉")));
  const b = priorityDetail(s, lost);
  assert.ok(b.reasons.some((r) => r.points < 0), "失注・休眠は減点");
  assert.ok(a.score > b.score && b.score >= 0);
});

test("確度が未入力の商談は、ステージごとの標準値で見込みを計算する", () => {
  assert.equal(dealProbability({ stage: "提案", probability: null }), 50);
  assert.equal(dealProbability({ stage: "交渉", probability: "" }), 70);
  assert.equal(dealProbability({ stage: "提案", probability: 0 }), 0, "0%と入力されていれば0%を尊重");
  assert.equal(dealProbability({ stage: "提案", probability: 80 }), 80);
});

test("担当者の重複:同じメール・同じ氏名を見つけ、空欄を埋めて1人にまとめる", () => {
  const s = tmpStore();
  const c = s.insert("companies", { name: "A社", industry: "x", tier: "大手", website: "https://a.example" });
  const p1 = s.insert("contacts", { companyId: c.id, name: "山田 一郎", email: "yamada@a.example", phone: "", role: "不明" });
  const p2 = s.insert("contacts", { companyId: c.id, name: "山田一郎", email: "", phone: "03-1234-5678", role: "決裁者" });
  s.insert("contacts", { companyId: c.id, name: "別人", email: "YAMADA@a.example" });
  const dups = checkQuality(s).issues.filter((i) => i.fix === "merge-contacts");
  assert.equal(dups.length, 2, "氏名が同じ組と、メールが同じ組");
  mergeContacts(s, [p1.id, p2.id]);
  const merged = s.get("contacts", p1.id);
  assert.equal(merged.phone, "03-1234-5678");
  assert.equal(merged.role, "決裁者", "「不明」は、分かっている値で上書きする");
  assert.equal(s.get("contacts", p2.id), null);
});

// ---------- 画面からの操作 ----------
let server, base;
before(async () => {
  const db = new Database(":memory:");
  server = createApp({ db, deps: { mailer: { enabled: true, send: async () => ({ ok: true }) } } }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
let cookie = "";
const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...(cookie && { Cookie: cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const t = await res.text();
  let data; try { data = JSON.parse(t); } catch { data = t; }
  return { status: res.status, data };
};

test("CSV:ほかのツールの見出し・言い回し・金額や日付の書き方でも正しく取り込む", async () => {
  await call("POST", "/api/auth/signup", { companyName: "精度社", name: "o", email: "o@acc.example", password: "Password123" });
  const csv = [
    "取引先名,商談名,フェーズ,見込金額,受注確度,次のステップ,完了予定日,社内メモ",
    "㈱インポート商会,基幹連携,見積提出,\"1,200万円\",60%,見積の再提出,2026/12/25,不要な列",
    "インポート商会 株式会社,追加ライセンス,クロージング,¥800000,,契約書の確認,令和8年12月1日,",
  ].join("\n");
  const r = await call("POST", "/api/import/deals", { csv });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.deals, 2);
  assert.equal(r.data.companies + r.data.linked >= 0, true);
  assert.deepEqual(r.data.unmatched, ["社内メモ"], "読み取れなかった列を知らせる");
  const deals = (await call("GET", "/api/deals")).data;
  const d1 = deals.find((d) => d.title === "基幹連携");
  assert.deepEqual([d1.stage, d1.amount, d1.probability, d1.nextAction, d1.closeDate], ["提案", 12000000, 60, "見積の再提出", "2026-12-25"]);
  const d2 = deals.find((d) => d.title === "追加ライセンス");
  assert.deepEqual([d2.stage, d2.amount, d2.closeDate], ["交渉", 800000, "2026-12-01"]);
  assert.equal(d1.companyId, d2.companyId, "㈱ と 株式会社(後ろ)は同じ会社");
  assert.equal((await call("GET", "/api/companies")).data.length, 1);

  const bad = await call("POST", "/api/import/contacts", { csv: "列A,列B\n1,2\n" });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /「氏名」の列が見つかりません/);
});

test("自動修正は、画面から送られた値ではなくサーバーで計算した値を使う", async () => {
  const co = (await call("GET", "/api/companies")).data[0];
  const p = await call("POST", "/api/contacts", { companyId: co.id, name: "入力 ミス", email: "miss@gmail.con", phone: "03ー1234ー5678" });
  const q = (await call("GET", "/api/crm/quality")).data;
  const emailIssue = q.issues.find((i) => i.fix === "fix-email");
  assert.ok(emailIssue && q.issues.some((i) => i.fix === "fix-phone"));
  // 悪意のある値を送っても、採用されない
  await call("POST", "/api/crm/fix", { ...emailIssue, value: "attacker@evil.example" });
  await call("POST", "/api/crm/fix", { fix: "fix-phone", ids: [p.data.id] });
  const fixed = (await call("GET", "/api/contacts")).data.find((x) => x.id === p.data.id);
  assert.equal(fixed.email, "miss@gmail.com");
  assert.equal(fixed.phone, "03-1234-5678");
});

test("レポート:確度が未入力の商談も、ステージの標準値で見込みに入る", async () => {
  const r = (await call("GET", "/api/reports")).data;
  // 基幹連携 1,200万×60% + 追加ライセンス 80万×70%(交渉の標準値)
  assert.equal(r.summary.weighted, 12000000 * 0.6 + 800000 * 0.7);
  assert.equal(r.summary.noProbabilityCount, 1);
});

test("優先度の理由が、一覧と詳細の両方で返る", async () => {
  const t = (await call("GET", "/api/targets")).data[0];
  assert.ok(Array.isArray(t.scoreReasons) && t.scoreReasons.length > 0);
  const d = (await call("GET", `/api/company-detail/${t.id}`)).data;
  assert.equal(d.score, t.score);
  assert.deepEqual(d.scoreReasons, t.scoreReasons);
});

// ---------- 受注率の補正・遅延・二重登録 ----------
import { stageWinRates, STAGE_PROBABILITY } from "../lib/crm.js";

test("ステージの移り変わりを記録する", () => {
  const s = tmpStore();
  const d = s.insert("deals", { companyId: "c", title: "t", stage: "リード" });
  assert.deepEqual(d.stageHistory.map((h) => h.stage), ["リード"]);
  s.update("deals", d.id, { stage: "提案" });
  s.update("deals", d.id, { amount: 1 }); // ステージ以外の更新では記録しない
  s.update("deals", d.id, { stage: "提案" }); // 同じステージへの更新も記録しない
  const after = s.update("deals", d.id, { stage: "受注" });
  assert.deepEqual(after.stageHistory.map((h) => h.stage), ["リード", "提案", "受注"]);
});

test("受注率の補正:実績が少ないうちは標準値に近く、多いほど実績に近づく", () => {
  const closed = (stage, path) => ({ stage, stageHistory: path.map((p) => ({ stage: p })) });
  // 実績なし → 標準値のまま
  assert.equal(stageWinRates([]).提案.rate, STAGE_PROBABILITY.提案);
  // 提案を通った2件がどちらも受注 → 実績100%だが、件数が少ないので (2 + 5×0.5)/(2+5) ≒ 64%
  const few = stageWinRates([closed("受注", ["提案", "受注"]), closed("受注", ["提案", "受注"])]);
  assert.deepEqual([few.提案.samples, few.提案.observed, few.提案.rate], [2, 100, 64]);
  // 提案を通った40件のうち10件受注 → 実績25%に近い (10 + 2.5)/(45) ≒ 28%
  const many = stageWinRates([
    ...Array.from({ length: 10 }, () => closed("受注", ["提案", "受注"])),
    ...Array.from({ length: 30 }, () => closed("失注", ["提案", "失注"])),
  ]);
  assert.equal(many.提案.rate, 28);
  assert.equal(many.交渉.samples, 0, "交渉を通っていない商談は、交渉の実績に数えない");
  assert.equal(many.交渉.rate, STAGE_PROBABILITY.交渉);
});

test("受注予定日を過ぎた進行中の商談は「遅延」として知らせ、月別見込みから外す", async () => {
  const co = (await call("GET", "/api/companies")).data[0];
  await call("POST", "/api/deals", { companyId: co.id, title: "遅れている案件", stage: "交渉", amount: 5000000, probability: 70, nextAction: "x", nextActionDate: "2099-01-01", closeDate: "2020-01-01" });
  const r = (await call("GET", "/api/reports")).data;
  assert.equal(r.slipped.count, 1);
  assert.equal(r.slipped.total, 5000000);
  assert.ok(r.attention.some((a) => a.title === "遅れている案件" && a.reason.includes("受注予定日を過ぎています")));
  assert.equal(r.stageRates.length, 5);
  const q = (await call("GET", "/api/crm/quality")).data;
  assert.ok(q.issues.some((i) => i.message.includes("遅れている案件") && i.message.includes("受注予定日")));
});

test("会社の二重登録を防ぐ:同名は確認を求め、似た会社は候補として知らせる", async () => {
  const before = (await call("GET", "/api/companies")).data;
  const name = before[0].name; // インポート商会
  const dup = await call("POST", "/api/companies", { name: `(株)${name.replace(/株式会社/g, "")}` });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.existingId, before[0].id);
  const forced = await call("POST", "/api/companies", { name: `(株)${name.replace(/株式会社/g, "")}`, allowDuplicate: true });
  assert.equal(forced.status, 200, "確認のうえなら登録できる");
  const sim = (await call("GET", `/api/companies/similar?name=${encodeURIComponent("いんぽーと商会")}`)).data;
  assert.ok(sim.length === 0 || sim.every((x) => x.reason), "理由つきで返す");
  const sim2 = (await call("GET", `/api/companies/similar?name=${encodeURIComponent("インポート商会 大阪支店")}`)).data;
  assert.ok(sim2.some((x) => /別拠点/.test(x.reason)), JSON.stringify(sim2));
});
