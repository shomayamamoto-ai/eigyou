// 決済(Stripe)。月額のサブスクリプション課金を行います。
//
// 流れ:
//   1. 画面の「申し込む」→ Stripe の決済ページ(Checkout)へ移動
//   2. 支払いが終わると Stripe からこのサーバーへ通知(Webhook)が届く
//   3. 通知の署名を検証したうえで、プランを切り替える
// カード情報は Stripe が預かり、このサーバーには一切保存しません。
import crypto from "node:crypto";
import { PLANS } from "./plans.js";
import { emails } from "./emails.js";

const API = "https://api.stripe.com/v1";

export const billingEnabled = () => Boolean(process.env.STRIPE_SECRET_KEY);

// 販売するプランと、Stripe の価格ID(price_...)の対応
export function priceIdFor(plan) {
  return { standard: process.env.STRIPE_PRICE_STANDARD }[plan] || null;
}
export function planForPrice(priceId) {
  if (priceId && priceId === process.env.STRIPE_PRICE_STANDARD) return "standard";
  return null;
}

// Stripe API はフォーム形式(a[b][0]=c)で送る
function encodeForm(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") encodeForm(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export function createStripe({ fetch = globalThis.fetch, secretKey = process.env.STRIPE_SECRET_KEY } = {}) {
  async function call(method, path, params, idempotencyKey) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }),
      },
      body: params ? encodeForm(params) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(`決済サービスでエラーが発生しました:${data.error?.message ?? res.status}`), { status: 502 });
    }
    return data;
  }

  return {
    createCustomer: ({ tenant, email }) =>
      call("POST", "/customers", { name: tenant.name, email, metadata: { tenant_id: tenant.id } }, `customer-${tenant.id}`),

    createCheckout: ({ customerId, tenant, priceId, appUrl }) =>
      call("POST", "/checkout/sessions", {
        mode: "subscription",
        customer: customerId,
        client_reference_id: tenant.id,
        locale: "ja",
        line_items: [{ price: priceId, quantity: 1 }],
        subscription_data: { metadata: { tenant_id: tenant.id } },
        metadata: { tenant_id: tenant.id },
        allow_promotion_codes: "true",
        ...(process.env.STRIPE_AUTOMATIC_TAX === "true" && { automatic_tax: { enabled: "true" }, customer_update: { address: "auto", name: "auto" } }),
        success_url: `${appUrl}/?billing=success#admin`,
        cancel_url: `${appUrl}/?billing=cancel#admin`,
      }),

    // お支払い方法の変更・請求書の確認・解約ができる Stripe の画面
    createPortal: ({ customerId, appUrl }) =>
      call("POST", "/billing_portal/sessions", { customer: customerId, return_url: `${appUrl}/#admin`, locale: "ja" }),

    cancelSubscription: (subscriptionId) => call("DELETE", `/subscriptions/${encodeURIComponent(subscriptionId)}`),
  };
}

// ---------- Webhook の署名検証(なりすまし防止) ----------
export function verifyWebhook(rawBody, header, secret, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret) throw Object.assign(new Error("STRIPE_WEBHOOK_SECRET が未設定です"), { status: 500 });
  const parts = Object.groupBy(String(header ?? "").split(",").map((p) => p.split("=")), ([k]) => k);
  const t = Number(parts.t?.[0]?.[1]);
  const sigs = (parts.v1 ?? []).map(([, v]) => v);
  if (!t || !sigs.length) throw Object.assign(new Error("署名がありません"), { status: 400 });
  if (Math.abs(nowSec - t) > toleranceSec) throw Object.assign(new Error("署名の有効期限切れです"), { status: 400 });
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw Object.assign(new Error("署名が一致しません"), { status: 400 });
  return JSON.parse(rawBody);
}

// テスト用:正しい署名ヘッダーを作る
export function signWebhook(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

// ---------- Webhook で届いたイベントの処理 ----------
export async function handleStripeEvent(event, { db, mailer, appUrl }) {
  // 同じ通知が2回届いても、1回だけ処理する
  const dup = db.get("SELECT id FROM billing_events WHERE id = ?", event.id);
  if (dup) return { duplicate: true };

  const obj = event.data?.object ?? {};
  const tenantId = obj.metadata?.tenant_id || obj.client_reference_id || obj.subscription_details?.metadata?.tenant_id;
  let tenant = tenantId ? db.getTenant(tenantId) : null;
  if (!tenant && obj.customer) {
    const row = db.get("SELECT id FROM tenants WHERE stripe_customer_id = ?", obj.customer);
    if (row) tenant = db.getTenant(row.id);
  }

  const owners = tenant ? db.all("SELECT * FROM users WHERE tenant_id = ? AND role = 'owner' AND disabled = 0", tenant.id) : [];
  const notify = async (template, extra = {}) => {
    for (const o of owners) {
      await mailer.send({ to: o.email, ...emails[template]({ name: o.name, tenantName: tenant.name, url: `${appUrl}/#admin`, ...extra }) });
    }
  };

  let action = "ignored";
  if (tenant) {
    switch (event.type) {
      case "checkout.session.completed": {
        if (obj.mode !== "subscription") break;
        db.updateTenant(tenant.id, {
          stripe_customer_id: obj.customer,
          stripe_subscription_id: obj.subscription,
          plan: obj.metadata?.plan || "standard",
          trial_ends_at: null,
          billing_status: "active",
        });
        db.audit(tenant.id, null, "有料プラン申し込み", PLANS[obj.metadata?.plan || "standard"].label);
        await notify("subscribed", { planLabel: PLANS[obj.metadata?.plan || "standard"].label });
        action = "subscribed";
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const plan = planForPrice(obj.items?.data?.[0]?.price?.id) ?? tenant.plan;
        if (["active", "trialing"].includes(obj.status)) {
          db.updateTenant(tenant.id, { plan, billing_status: "active", stripe_subscription_id: obj.id, stripe_customer_id: obj.customer, trial_ends_at: null });
          action = "active";
        } else if (obj.status === "past_due") {
          db.updateTenant(tenant.id, { billing_status: "past_due" });
          action = "past_due";
        } else if (["canceled", "unpaid", "incomplete_expired"].includes(obj.status)) {
          db.updateTenant(tenant.id, { plan: "canceled", billing_status: obj.status });
          db.audit(tenant.id, null, "契約終了", obj.status);
          action = "canceled";
        }
        break;
      }
      case "customer.subscription.deleted": {
        db.updateTenant(tenant.id, { plan: "canceled", billing_status: "canceled", stripe_subscription_id: null });
        db.audit(tenant.id, null, "契約終了", "解約");
        await notify("canceled");
        action = "canceled";
        break;
      }
      case "invoice.payment_failed": {
        db.updateTenant(tenant.id, { billing_status: "past_due" });
        db.audit(tenant.id, null, "支払い失敗", obj.id ?? "");
        await notify("paymentFailed");
        action = "payment_failed";
        break;
      }
      case "invoice.paid": {
        if (tenant.billing_status === "past_due") db.updateTenant(tenant.id, { billing_status: "active" });
        action = "paid";
        break;
      }
    }
  }
  db.run("INSERT INTO billing_events (id, type, tenant_id, created_at) VALUES (?, ?, ?, ?)", event.id, event.type, tenant?.id ?? null, new Date().toISOString());
  return { action };
}
