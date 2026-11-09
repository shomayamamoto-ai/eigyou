// HubSpot 連携(CRM API v3)
// 接続方法:HubSpot の「非公開アプリ(Private App)」のアクセストークン。
// 必要な権限(スコープ):
//   crm.objects.companies.read / crm.objects.contacts.read
//   crm.objects.deals.read / crm.objects.deals.write
const BASE = "https://api.hubapi.com";

// HubSpot の標準パイプラインの取引ステージ ⇔ 本システムのステージ
export const DEFAULT_STAGE_MAP = {
  import: {
    appointmentscheduled: "アプローチ",
    qualifiedtobuy: "ヒアリング",
    presentationscheduled: "提案",
    decisionmakerboughtin: "提案",
    contractsent: "交渉",
    closedwon: "受注",
    closedlost: "失注",
  },
  export: {
    リード: "appointmentscheduled",
    アプローチ: "appointmentscheduled",
    ヒアリング: "qualifiedtobuy",
    提案: "presentationscheduled",
    交渉: "contractsent",
    受注: "closedwon",
    失注: "closedlost",
  },
};

export const FIELDS = [
  { key: "accessToken", label: "アクセストークン(非公開アプリ)", secret: true, required: true },
];

const tierFromEmployees = (n) => {
  const v = Number(n);
  if (!v) return "";
  return v >= 1000 ? "大手" : v >= 100 ? "中堅" : "中小";
};

export function createHubspotClient(config, { fetch = globalThis.fetch } = {}) {
  if (!config?.accessToken) throw new Error("HubSpot のアクセストークンが未設定です");

  async function call(method, urlPath, body) {
    const res = await fetch(`${BASE}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const msg = res.status === 401 ? "トークンが無効です" : res.status === 403 ? "権限(スコープ)が不足しています" : `HTTP ${res.status}`;
      throw Object.assign(new Error(`HubSpot:${msg} ${text.slice(0, 200)}`), { status: 502 });
    }
    return res.status === 204 ? null : res.json();
  }

  async function listAll(object, properties, associations, maxPages = 50) {
    const out = [];
    let after;
    for (let i = 0; i < maxPages; i++) {
      const q = new URLSearchParams({ limit: "100", properties: properties.join(",") });
      if (associations) q.set("associations", associations);
      if (after) q.set("after", after);
      const data = await call("GET", `/crm/v3/objects/${object}?${q}`);
      out.push(...(data.results ?? []));
      after = data.paging?.next?.after;
      if (!after) break;
    }
    return out;
  }

  const firstCompany = (r) => r.associations?.companies?.results?.[0]?.id ?? null;

  return {
    provider: "hubspot",
    label: "HubSpot",
    async test() {
      await call("GET", "/crm/v3/objects/companies?limit=1");
      return true;
    },
    // 外部CRMのデータを、本システムの形に変換して返す
    async fetchAll(stageMap = DEFAULT_STAGE_MAP.import) {
      const [companies, contacts, deals] = await Promise.all([
        listAll("companies", ["name", "industry", "domain", "website", "numberofemployees"]),
        listAll("contacts", ["firstname", "lastname", "email", "phone", "jobtitle"], "companies"),
        listAll("deals", ["dealname", "amount", "dealstage", "closedate", "hs_next_step"], "companies"),
      ]);
      return {
        companies: companies.map((c) => ({
          externalId: c.id,
          name: c.properties.name || "(名称未設定)",
          industry: c.properties.industry || "",
          website: c.properties.website || (c.properties.domain ? `https://${c.properties.domain}` : ""),
          tier: tierFromEmployees(c.properties.numberofemployees),
        })),
        contacts: contacts.map((p) => ({
          externalId: p.id,
          externalCompanyId: firstCompany(p),
          name: [p.properties.lastname, p.properties.firstname].filter(Boolean).join(" ") || p.properties.email || "(氏名未設定)",
          email: p.properties.email || "",
          phone: p.properties.phone || "",
          title: p.properties.jobtitle || "",
          department: "",
        })),
        deals: deals.map((d) => ({
          externalId: d.id,
          externalCompanyId: firstCompany(d),
          title: d.properties.dealname || "(案件名未設定)",
          amount: d.properties.amount ? Number(d.properties.amount) : null,
          stage: stageMap[d.properties.dealstage] ?? "リード",
          closeDate: d.properties.closedate ? d.properties.closedate.slice(0, 10) : "",
          nextAction: d.properties.hs_next_step || "",
        })),
      };
    },
    // 商談分析の結果を HubSpot の取引に書き戻す
    async updateDeal(externalId, deal, stageMap = DEFAULT_STAGE_MAP.export) {
      const properties = {};
      if (stageMap[deal.stage]) properties.dealstage = stageMap[deal.stage];
      if (deal.amount) properties.amount = String(deal.amount);
      if (deal.closeDate) properties.closedate = deal.closeDate;
      if (deal.nextAction) properties.hs_next_step = deal.nextAction;
      await call("PATCH", `/crm/v3/objects/deals/${encodeURIComponent(externalId)}`, { properties });
      return properties;
    },
  };
}
