// 料金プランの定義。
// 価格・上限は仮の値です。販売時は、AIの原価(利用状況画面のトークン数)を
// 見ながら調整してください。null は「上限なし」。
export const PLANS = {
  internal: { label: "社内利用", priceYen: 0, aiPerMonth: null, users: null, crmSync: true },
  trial: { label: "無料トライアル(14日間)", priceYen: 0, aiPerMonth: 30, users: 3, crmSync: true },
  standard: { label: "スタンダード", priceYen: 30000, aiPerMonth: 500, users: 20, crmSync: true },
  enterprise: { label: "エンタープライズ", priceYen: null, aiPerMonth: null, users: null, crmSync: true },
};

export function planOf(tenant) {
  return PLANS[tenant?.plan] ?? PLANS.trial;
}

export function trialExpired(tenant) {
  return tenant?.plan === "trial" && tenant.trial_ends_at && tenant.trial_ends_at < new Date().toISOString();
}

// AIを使ってよいか(上限・トライアル期限)を確認。だめなら理由を返す
export function aiBlockedReason(db, tenant) {
  if (trialExpired(tenant)) return "無料トライアル期間が終了しました。プランの変更をご検討ください。";
  const limit = planOf(tenant).aiPerMonth;
  if (limit === null) return null;
  const used = db.usageOf(tenant.id).reduce((s, u) => s + u.count, 0);
  if (used >= limit) return `今月のAI利用回数の上限(${limit}回)に達しました。来月まで待つか、プランの変更をご検討ください。`;
  return null;
}

export function userLimitReached(db, tenant) {
  const limit = planOf(tenant).users;
  return limit !== null && db.listUsers(tenant.id).length >= limit;
}
