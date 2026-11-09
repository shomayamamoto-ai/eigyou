// 外部CRM連携の共通処理(取り込み・書き戻し・接続情報の保存)
import { createHubspotClient, DEFAULT_STAGE_MAP as HS_MAP, FIELDS as HS_FIELDS } from "./hubspot.js";
import { createSalesforceClient, DEFAULT_STAGE_MAP as SF_MAP, FIELDS as SF_FIELDS } from "./salesforce.js";
import { encrypt, decrypt, mask } from "../secrets.js";
import { companyKey, normalizeCompanyName } from "../crm.js";

export const PROVIDERS = {
  salesforce: { label: "Salesforce", fields: SF_FIELDS, stageMap: SF_MAP, create: createSalesforceClient },
  hubspot: { label: "HubSpot", fields: HS_FIELDS, stageMap: HS_MAP, create: createHubspotClient },
};

const DEFAULT_OPTIONS = { autoPush: true };

export function getIntegration(db, tenantId, provider) {
  const row = db.get("SELECT * FROM integrations WHERE tenant_id = ? AND provider = ?", tenantId, provider);
  if (!row) return null;
  return {
    provider,
    config: decrypt(row.config_enc),
    options: { ...DEFAULT_OPTIONS, ...JSON.parse(row.options || "{}") },
    lastSyncAt: row.last_sync_at,
    lastResult: row.last_result ? JSON.parse(row.last_result) : null,
  };
}

// 画面表示用(秘密の値は伏せる)
export function describeIntegrations(db, tenantId) {
  return Object.entries(PROVIDERS).map(([key, p]) => {
    const it = getIntegration(db, tenantId, key);
    return {
      provider: key,
      label: p.label,
      fields: p.fields,
      connected: Boolean(it),
      config: it ? Object.fromEntries(p.fields.map((f) => [f.key, f.secret ? mask(it.config[f.key]) : it.config[f.key] ?? ""])) : {},
      options: it?.options ?? DEFAULT_OPTIONS,
      lastSyncAt: it?.lastSyncAt ?? null,
      lastResult: it?.lastResult ?? null,
    };
  });
}

export function saveIntegration(db, tenantId, provider, config, options = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw Object.assign(new Error("未対応の連携先です"), { status: 400 });
  const prev = getIntegration(db, tenantId, provider);
  // 秘密の項目が空欄なら、前回の値を引き継ぐ(画面には伏せ字しか出さないため)
  const merged = {};
  for (const f of p.fields) {
    const v = String(config?.[f.key] ?? "").trim();
    merged[f.key] = v || prev?.config?.[f.key] || "";
    if (f.required && !merged[f.key]) throw Object.assign(new Error(`「${f.label}」を入力してください`), { status: 400 });
  }
  try {
    p.create(merged); // 形式チェック(URLなど)
  } catch (e) {
    throw Object.assign(e, { status: 400 });
  }
  const opts = { ...DEFAULT_OPTIONS, ...(prev?.options ?? {}), ...options };
  db.run(
    `INSERT INTO integrations (tenant_id, provider, config_enc, options) VALUES (?, ?, ?, ?)
     ON CONFLICT(tenant_id, provider) DO UPDATE SET config_enc = excluded.config_enc, options = excluded.options`,
    tenantId, provider, encrypt(merged), JSON.stringify(opts),
  );
}

export function deleteIntegration(db, tenantId, provider) {
  db.run("DELETE FROM integrations WHERE tenant_id = ? AND provider = ?", tenantId, provider);
}

export function clientFor(db, tenantId, provider, deps) {
  const it = getIntegration(db, tenantId, provider);
  if (!it) throw Object.assign(new Error(`${PROVIDERS[provider]?.label ?? provider} と接続されていません`), { status: 400 });
  return { client: PROVIDERS[provider].create(it.config, deps), integration: it };
}

// 外部CRM → 本システム へ取り込む。
// 外部IDで照合して「あれば更新、なければ追加」。会社は名前のゆれも吸収して既存データにひもづける。
export async function importFromProvider(store, client, stageMap) {
  const src = await client.fetchAll(stageMap);
  const provider = client.provider;
  const result = { companies: { added: 0, updated: 0 }, contacts: { added: 0, updated: 0 }, deals: { added: 0, updated: 0 } };

  const index = (col) => {
    const byExt = new Map();
    for (const r of store.list(col)) if (r.external?.source === provider) byExt.set(r.external.id, r);
    return byExt;
  };

  // 1. 会社
  const companiesByExt = index("companies");
  const companiesByKey = new Map(store.list("companies").map((c) => [companyKey(c.name), c]));
  const extToLocal = new Map();
  for (const c of src.companies) {
    const external = { source: provider, id: c.externalId };
    const existing = companiesByExt.get(c.externalId) ?? companiesByKey.get(companyKey(c.name));
    const data = { name: normalizeCompanyName(c.name), industry: c.industry, website: c.website, tier: c.tier };
    let rec;
    if (existing) {
      // 外部側が空欄の項目では、こちらの値を消さない
      const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v));
      rec = store.update("companies", existing.id, { ...patch, external });
      result.companies.updated++;
    } else {
      rec = store.insert("companies", { ...data, status: "未接触", notes: "", external });
      companiesByKey.set(companyKey(rec.name), rec);
      result.companies.added++;
    }
    extToLocal.set(c.externalId, rec.id);
  }

  const ensureCompany = (extCompanyId) => {
    if (extCompanyId && extToLocal.has(extCompanyId)) return extToLocal.get(extCompanyId);
    let other = store.list("companies").find((c) => c.name === "(会社未設定)");
    other ??= store.insert("companies", { name: "(会社未設定)", status: "未接触", notes: "外部CRMで会社がひもづいていないデータ" });
    return other.id;
  };

  // 2. 担当者・3. 商談
  for (const [col, items] of [["contacts", src.contacts], ["deals", src.deals]]) {
    const byExt = index(col);
    for (const x of items) {
      const { externalId, externalCompanyId, ...data } = x;
      const external = { source: provider, id: externalId };
      const companyId = ensureCompany(externalCompanyId);
      const existing = byExt.get(externalId);
      if (existing) {
        const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== "" && v !== null && v !== undefined));
        store.update(col, existing.id, { ...patch, companyId, external });
        result[col].updated++;
      } else {
        store.insert(col, { ...(col === "contacts" ? { role: "不明" } : { probability: null }), ...data, companyId, external });
        result[col].added++;
      }
    }
  }
  return result;
}

// 本システム → 外部CRM へ商談を書き戻す
export async function pushDeal(client, deal, stageMap) {
  if (deal.external?.source !== client.provider) {
    throw Object.assign(new Error(`この商談は ${client.label} から取り込んだものではないため、書き戻せません`), { status: 400 });
  }
  return client.updateDeal(deal.external.id, deal, stageMap);
}
