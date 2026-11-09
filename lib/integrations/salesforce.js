// Salesforce 連携(REST API)
// 接続方法:Salesforce の「接続アプリケーション」で
//   OAuth 2.0 クライアントログイン情報フロー(Client Credentials Flow)を有効にし、
//   実行ユーザーを設定したうえで、コンシューマー鍵・秘密を登録します。
// 実行ユーザーには 取引先・取引先責任者・商談 の参照権限と、商談の編集権限が必要です。
const API_VERSION = "v61.0";

// Salesforce 標準の商談フェーズ ⇔ 本システムのステージ
export const DEFAULT_STAGE_MAP = {
  import: {
    Prospecting: "アプローチ",
    Qualification: "ヒアリング",
    "Needs Analysis": "ヒアリング",
    "Value Proposition": "提案",
    "Id. Decision Makers": "提案",
    "Perception Analysis": "提案",
    "Proposal/Price Quote": "提案",
    "Negotiation/Review": "交渉",
    "Closed Won": "受注",
    "Closed Lost": "失注",
  },
  export: {
    リード: "Prospecting",
    アプローチ: "Prospecting",
    ヒアリング: "Qualification",
    提案: "Proposal/Price Quote",
    交渉: "Negotiation/Review",
    受注: "Closed Won",
    失注: "Closed Lost",
  },
};

export const FIELDS = [
  { key: "instanceUrl", label: "組織のURL", placeholder: "https://yourcompany.my.salesforce.com", required: true },
  { key: "clientId", label: "コンシューマー鍵", required: true },
  { key: "clientSecret", label: "コンシューマーの秘密", secret: true, required: true },
];

const tierFromEmployees = (n) => {
  const v = Number(n);
  if (!v) return "";
  return v >= 1000 ? "大手" : v >= 100 ? "中堅" : "中小";
};

export function createSalesforceClient(config, { fetch = globalThis.fetch } = {}) {
  for (const f of FIELDS) if (f.required && !config?.[f.key]) throw new Error(`Salesforce の「${f.label}」が未設定です`);
  const base = String(config.instanceUrl).replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+\.(salesforce\.com|force\.com)$/i.test(base)) {
    // 任意のURLへ秘密情報を送らないよう、Salesforce のドメインに限定する
    throw new Error("組織のURLは https://〜.my.salesforce.com の形式で入力してください");
  }
  let token = null;
  let instance = base;

  async function auth() {
    const res = await fetch(`${base}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: config.clientId, client_secret: config.clientSecret }),
    });
    if (!res.ok) throw Object.assign(new Error(`Salesforce:認証に失敗しました(HTTP ${res.status})。鍵・秘密と、接続アプリの設定を確認してください`), { status: 502 });
    const data = await res.json();
    token = data.access_token;
    if (data.instance_url) instance = data.instance_url.replace(/\/+$/, "");
  }

  async function call(method, urlPath, body, retry = true) {
    if (!token) await auth();
    const res = await fetch(`${instance}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && retry) {
      token = null;
      return call(method, urlPath, body, false);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw Object.assign(new Error(`Salesforce:HTTP ${res.status} ${text.slice(0, 200)}`), { status: 502 });
    }
    return res.status === 204 ? null : res.json();
  }

  async function query(soql, maxPages = 50) {
    const out = [];
    let next = `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
    for (let i = 0; next && i < maxPages; i++) {
      const data = await call("GET", next);
      out.push(...(data.records ?? []));
      next = data.done ? null : data.nextRecordsUrl;
    }
    return out;
  }

  return {
    provider: "salesforce",
    label: "Salesforce",
    async test() {
      await call("GET", `/services/data/${API_VERSION}/limits`);
      return true;
    },
    async fetchAll(stageMap = DEFAULT_STAGE_MAP.import) {
      const [accounts, contacts, opps] = await Promise.all([
        query("SELECT Id, Name, Industry, Website, NumberOfEmployees FROM Account ORDER BY LastModifiedDate DESC LIMIT 5000"),
        query("SELECT Id, FirstName, LastName, Email, Phone, Title, Department, AccountId FROM Contact ORDER BY LastModifiedDate DESC LIMIT 10000"),
        query("SELECT Id, Name, Amount, StageName, CloseDate, NextStep, Probability, AccountId FROM Opportunity ORDER BY LastModifiedDate DESC LIMIT 5000"),
      ]);
      return {
        companies: accounts.map((a) => ({
          externalId: a.Id,
          name: a.Name || "(名称未設定)",
          industry: a.Industry || "",
          website: a.Website || "",
          tier: tierFromEmployees(a.NumberOfEmployees),
        })),
        contacts: contacts.map((c) => ({
          externalId: c.Id,
          externalCompanyId: c.AccountId ?? null,
          name: [c.LastName, c.FirstName].filter(Boolean).join(" ") || "(氏名未設定)",
          email: c.Email || "",
          phone: c.Phone || "",
          title: c.Title || "",
          department: c.Department || "",
        })),
        deals: opps.map((o) => ({
          externalId: o.Id,
          externalCompanyId: o.AccountId ?? null,
          title: o.Name || "(案件名未設定)",
          amount: o.Amount ?? null,
          stage: stageMap[o.StageName] ?? "リード",
          probability: o.Probability ?? null,
          closeDate: o.CloseDate || "",
          nextAction: o.NextStep || "",
        })),
      };
    },
    async updateDeal(externalId, deal, stageMap = DEFAULT_STAGE_MAP.export) {
      const fields = {};
      if (stageMap[deal.stage]) fields.StageName = stageMap[deal.stage];
      if (deal.amount) fields.Amount = deal.amount;
      if (deal.closeDate) fields.CloseDate = deal.closeDate;
      if (deal.nextAction) fields.NextStep = String(deal.nextAction).slice(0, 255); // NextStep は255文字まで
      if (deal.probability !== null && deal.probability !== undefined) fields.Probability = deal.probability;
      await call("PATCH", `/services/data/${API_VERSION}/sobjects/Opportunity/${encodeURIComponent(externalId)}`, fields);
      return fields;
    },
  };
}
