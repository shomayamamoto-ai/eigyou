// 動作確認用のサンプルデータ(すべて架空の会社・人物です)。
// CRM整備の機能を試せるよう、わざと重複や未入力を混ぜています。
export function seed(store) {
  const add = (col, x) => store.insert(col, x);
  const today = new Date();
  const day = (n) => new Date(today.getTime() + n * 864e5).toISOString().slice(0, 10);

  const a = add("companies", { name: "株式会社みらい総合商事", industry: "総合商社", tier: "大手", status: "商談中", website: "", notes: "既存取引先からの紹介" });
  const b = add("companies", { name: "あおば製作所株式会社", industry: "製造業(産業機械)", tier: "大手", status: "アプローチ中", website: "", notes: "" });
  const c = add("companies", { name: "株式会社ひかりフーズ", industry: "食品", tier: "中堅", status: "未接触", website: "", notes: "展示会で名刺交換" });
  add("companies", { name: "(株)みらい総合商事", industry: "", tier: "", status: "未接触", website: "", notes: "重複データの例" });

  add("contacts", { companyId: a.id, name: "山田 一郎", department: "営業企画部", title: "部長", role: "推進者", email: "yamada@example.com", phone: "03-0000-0001" });
  add("contacts", { companyId: a.id, name: "佐藤 花子", department: "情報システム部", title: "課長", role: "影響者", email: "sato@example", phone: "" });
  add("contacts", { companyId: b.id, name: "鈴木 健", department: "経営企画室", title: "室長", role: "決裁者", email: "", phone: "" });

  add("deals", { companyId: a.id, title: "営業支援ツール全社導入", stage: "提案", amount: 12000000, probability: 50, nextAction: "役員向けデモの日程調整", nextActionDate: day(3), closeDate: day(60) });
  add("deals", { companyId: b.id, title: "工場営業部門のCRM刷新", stage: "ヒアリング", amount: null, probability: 20, nextAction: "", nextActionDate: "", closeDate: "" });
  add("deals", { companyId: c.id, title: "商談記録の自動化PoC", stage: "アプローチ", amount: 1500000, probability: 10, nextAction: "資料送付", nextActionDate: day(-5), closeDate: "" });

  if (!store.getSettings().offering) {
    store.setSettings({ offering: "営業活動を記録・分析するクラウド型の営業支援サービス(CRM・商談記録の自動化)" });
  }
}
