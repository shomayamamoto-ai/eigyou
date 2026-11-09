import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../lib/db.js";
import { aiBlockedReason } from "../lib/plans.js";

test("テナントAのストアからテナントBのデータは見えない・変更できない", () => {
  const db = new Database(":memory:");
  const a = db.forTenant(db.createTenant({ name: "A社" }).id);
  const b = db.forTenant(db.createTenant({ name: "B社" }).id);
  const rec = b.insert("companies", { name: "B社の顧客" });
  assert.equal(a.list("companies").length, 0);
  assert.equal(a.get("companies", rec.id), null);
  assert.equal(a.update("companies", rec.id, { name: "乗っ取り" }), null);
  assert.equal(a.remove("companies", rec.id), false);
  assert.equal(b.get("companies", rec.id).name, "B社の顧客");
});

test("テナント削除で関連データもすべて消える", () => {
  const db = new Database(":memory:");
  const t = db.createTenant({ name: "解約社" });
  db.forTenant(t.id).insert("companies", { name: "x" });
  db.deleteTenant(t.id);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM records").n, 0);
});

test("トライアルのAI上限・期限切れ", () => {
  const db = new Database(":memory:");
  const t = db.createTenant({ name: "試用社", plan: "trial" });
  assert.equal(aiBlockedReason(db, t), null);
  for (let i = 0; i < 30; i++) db.addUsage(t.id, "リサーチ", { input: 10, output: 5 });
  assert.match(aiBlockedReason(db, t), /上限/);
  const expired = db.updateTenant(t.id, { trial_ends_at: "2000-01-01T00:00:00.000Z" });
  assert.match(aiBlockedReason(db, expired), /終了/);
  assert.equal(aiBlockedReason(db, db.createTenant({ name: "社内", plan: "internal" })), null);
});
