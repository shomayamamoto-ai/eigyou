// 動作確認・デモ用の見本データ(会社・人物・数字は、すべて架空です)。
// 画面を見たときに使い方が伝わるよう、商談の各ステージ・受注/失注・
// 商談記録・リサーチ結果までひととおり入れています。
// CRM整備の機能を試せるよう、わざと重複や未入力も混ぜています。
import { localDate } from "./time.js";
import { demoResearch, demoAccountPlan, demoMeeting } from "./demo.js";

export function seed(store, ownerId = null, otherOwnerIds = []) {
  const add = (col, x) => store.insert(col, x);
  const now = new Date();
  const day = (n) => localDate(now, n);
  // 担当者をメンバーに順番に割り振る(メンバーが1人なら全部その人)
  const owners = [ownerId, ...otherOwnerIds].filter(Boolean);
  const owner = (i) => (owners.length ? owners[i % owners.length] : null);

  // ---------- 会社 ----------
  const co = {};
  const companies = [
    ["mirai", "株式会社みらい総合商事", "総合商社", "大手", "商談中", "https://mirai-shoji.example", "既存取引先(あおば製作所)からの紹介。営業企画部が窓口。"],
    ["aoba", "あおば製作所株式会社", "製造業(産業機械)", "大手", "商談中", "https://aoba-mfg.example", "国内に営業拠点が12か所。拠点ごとに管理方法がばらばらとのこと。"],
    ["hikari", "株式会社ひかりフーズ", "食品メーカー", "中堅", "アプローチ中", "https://hikari-foods.example", "展示会で名刺交換。ルート営業が中心。"],
    ["sora", "そらネット通信株式会社", "情報通信", "大手", "商談中", "https://sora-net.example", "法人営業本部が検討。競合ツールと比較中。"],
    ["minato", "みなと物流株式会社", "物流", "中堅", "取引中", "https://minato-logi.example", "昨年度に営業部で導入済み。追加部門への展開を相談中。"],
    ["kaede", "かえで不動産株式会社", "不動産", "中堅", "アプローチ中", "", "Webからの資料請求。"],
    ["tsubasa", "つばさ保険株式会社", "保険", "大手", "未接触", "https://tsubasa-hoken.example", "代理店営業の管理に課題がありそうとの情報(未確認)。"],
    ["wakaba", "わかば薬品株式会社", "医薬品卸", "中堅", "休眠", "", "昨年提案したが、予算の都合で見送り。"],
    ["kirin", "きりん電機株式会社", "電機メーカー", "大手", "未接触", "", ""],
  ];
  for (const [key, name, industry, tier, status, website, notes] of companies) {
    co[key] = add("companies", { name, industry, tier, status, website, notes });
  }
  // CRM整備のデモ用:重複・未入力のデータ
  add("companies", { name: "(株)みらい総合商事", industry: "", tier: "", status: "未接触", website: "", notes: "重複データの例(名刺から別途登録された)" });

  // ---------- 担当者 ----------
  const contacts = [
    ["mirai", "山田 一郎", "営業企画部", "部長", "推進者", "yamada@mirai-shoji.example", "03-0000-0001"],
    ["mirai", "佐藤 花子", "情報システム部", "課長", "影響者", "sato@mirai-shoji", ""], // メール形式の誤り(CRM整備のデモ)
    ["mirai", "高橋 誠", "営業本部", "執行役員 本部長", "決裁者", "takahashi@mirai-shoji.example", ""],
    ["aoba", "鈴木 健", "経営企画室", "室長", "決裁者", "", ""], // 連絡先なし(CRM整備のデモ)
    ["aoba", "伊藤 美咲", "営業統括部", "主任", "推進者", "ito@aoba-mfg.example", "06-0000-0002"],
    ["hikari", "渡辺 大輔", "営業部", "部長", "決裁者", "watanabe@hikari-foods.example", "052-000-0003"],
    ["sora", "中村 由美", "法人営業本部", "企画グループ長", "推進者", "nakamura@sora-net.example", "03-0000-0004"],
    ["sora", "小林 拓也", "情報セキュリティ部", "マネージャー", "影響者", "kobayashi@sora-net.example", ""],
    ["minato", "加藤 直樹", "営業部", "部長", "決裁者", "kato@minato-logi.example", "045-000-0005"],
    ["kaede", "吉田 さくら", "営業推進課", "課長", "推進者", "yoshida@kaede-fudosan.example", ""],
  ];
  for (const [key, name, department, title, role, email, phone] of contacts) {
    add("contacts", { companyId: co[key].id, name, department, title, role, email, phone });
  }

  // ---------- 商談 ----------
  const dl = {};
  const deals = [
    // key, 会社, 案件名, ステージ, 金額, 確度, 次のアクション, 期限(日後), 受注予定(日後)
    ["miraiAll", "mirai", "営業支援ツール 全社導入", "提案", 12000000, 50, "役員向けデモの日程調整", 3, 45],
    ["aobaCrm", "aoba", "営業拠点のCRM統一", "ヒアリング", 8000000, 30, "現状の管理方法のヒアリング(大阪拠点)", 1, 75],
    ["hikariPoc", "hikari", "商談記録の自動化 PoC", "アプローチ", 1500000, 10, "事例資料の送付", -4, 100],
    ["soraCorp", "sora", "法人営業本部への導入", "交渉", 9600000, 70, "セキュリティチェックシートの回答", 0, 20],
    ["minatoAdd", "minato", "カスタマーサポート部門への追加導入", "提案", 3600000, 60, "見積書の再提出", 6, 30],
    ["kaedeTrial", "kaede", "営業推進課でのトライアル", "リード", 900000, 10, "", null, null], // 次のアクション未設定(デモ)
    ["tsubasaNew", "tsubasa", "代理店営業の管理基盤", "リード", null, 5, "紹介者への面談依頼", 9, null], // 金額未入力(デモ)
    ["minatoWon", "minato", "営業部への導入(初回契約)", "受注", 4800000, 100, "", null, -40],
    ["aobaWon", "aoba", "本社営業部の試験導入", "受注", 2400000, 100, "", null, -15],
    ["wakabaLost", "wakaba", "営業日報のデジタル化", "失注", 3000000, 0, "", null, -60],
  ];
  // 受注・失注した商談は、そこまでに通ったステージの経緯も入れる(受注率の補正に使われる)
  const path = {
    minatoWon: ["リード", "アプローチ", "ヒアリング", "提案", "交渉", "受注"],
    aobaWon: ["アプローチ", "ヒアリング", "提案", "受注"],
    wakabaLost: ["リード", "アプローチ", "ヒアリング", "提案", "失注"],
  };
  const history = (key, closeOffset) =>
    path[key]?.map((stage, n, arr) => ({ stage, at: new Date(now.getTime() + (closeOffset - (arr.length - 1 - n) * 14) * 864e5).toISOString() }));
  deals.forEach(([key, cKey, title, stage, amount, probability, nextAction, due, close], i) => {
    dl[key] = add("deals", {
      ownerId: owner(i), companyId: co[cKey].id, title, stage, amount, probability, nextAction,
      nextActionDate: due === null ? "" : day(due),
      closeDate: close === null ? "" : day(close),
      ...(path[key] && { stageHistory: history(key, close ?? 0) }),
    });
  });

  // ---------- 予定が重なった日(「予定の混み具合」のデモ用) ----------
  // 自分の担当で、同じ日に次のアクションが集中している状態を作る
  const busyDay = day(2);
  [
    ["kaede", "物件管理部門への横展開", "アプローチ", 600000, "部門長への紹介依頼"],
    ["hikari", "工場出荷管理との連携", "ヒアリング", 2000000, "現状フローの確認(電話)"],
    ["sora", "代理店ポータルの追加", "リード", 1200000, "要件のたたき台を送付"],
    ["aoba", "大阪拠点の先行導入", "提案", 3000000, "見積書の作成"],
    ["mirai", "子会社への展開", "リード", 2500000, "子会社の窓口を確認"],
  ].forEach(([cKey, title, stage, amount, nextAction]) => {
    add("deals", { ownerId: owner(0), companyId: co[cKey].id, title, stage, amount, probability: null, nextAction, nextActionDate: busyDay, closeDate: day(90) });
  });

  // ---------- リサーチ・開拓プラン(一部の会社は実施済みにしておく) ----------
  for (const key of ["mirai", "sora", "aoba"]) {
    store.update("companies", co[key].id, { research: demoResearch(co[key]) });
  }
  store.update("companies", co.mirai.id, { accountPlan: demoAccountPlan(store.get("companies", co.mirai.id)) });

  // ---------- 商談の記録(同じ商談に2回分 → 経緯をふまえた分析の見本) ----------
  const meet = (dealKey, cKey, dateOffset, variant, applied) =>
    add("meetings", {
      dealId: dl[dealKey].id, companyId: co[cKey].id, date: day(dateOffset),
      transcript: demoMeeting.transcript(variant), analysis: demoMeeting.analysis(variant, day(dateOffset + 7)),
      applied, createdBy: "見本データ",
    });
  meet("miraiAll", "mirai", -21, "first", true);
  meet("miraiAll", "mirai", -6, "second", true);
  meet("soraCorp", "sora", -3, "negotiation", false);

  if (!store.getSettings().offering) {
    store.setSettings({
      offering:
        "営業活動を記録・分析するクラウド型の営業支援サービス。" +
        "商談の議事録からAIが要約・次のアクションを作成し、CRMへの入力を自動化します。" +
        "強みは、既存のCRM(Salesforce・HubSpot)とそのまま連携できる点です。",
    });
  }
}
