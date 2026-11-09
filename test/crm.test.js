import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../lib/db.js";
import { companyKey, normalizeCompanyName, checkQuality, mergeCompanies, parseCsv, toCsv, priorityScore } from "../lib/crm.js";
import { seed } from "../lib/seed.js";

const tmpStore = () => {
  const db = new Database(":memory:");
  return db.forTenant(db.createTenant({ name: "テスト社" }).id);
};

test("会社名のゆれを同一視する", () => {
  assert.equal(companyKey("株式会社ABC"), companyKey("(株)ABC"));
  assert.equal(companyKey("ABC 株式会社"), companyKey("ABC株式会社"));
  assert.notEqual(companyKey("ABC"), companyKey("ABD"));
});

test("(株)を株式会社に直す", () => {
  assert.equal(normalizeCompanyName("(株)みらい"), "株式会社みらい");
  assert.equal(normalizeCompanyName("みらい(株)"), "みらい株式会社");
  assert.equal(normalizeCompanyName("  ABC  "), "ABC");
});

test("重複を検出し、統合すると担当者が付け替わる", () => {
  const s = tmpStore();
  seed(s);
  const q = checkQuality(s);
  const dup = q.issues.find((i) => i.fix === "merge");
  assert.ok(dup, "重複が検出される");
  const dropId = dup.ids[1];
  s.insert("contacts", { companyId: dropId, name: "テスト", email: "t@example.com" });
  mergeCompanies(s, dup.ids);
  assert.equal(s.list("companies").length, 3);
  assert.ok(s.list("contacts").every((p) => s.get("companies", p.companyId)));
  assert.ok(!checkQuality(s).issues.some((i) => i.fix === "merge"));
});

test("期限切れの次アクションを検出する", () => {
  const s = tmpStore();
  const c = s.insert("companies", { name: "株式会社A", industry: "x", tier: "大手" });
  s.insert("deals", { companyId: c.id, title: "案件", stage: "提案", amount: 1, nextAction: "連絡", nextActionDate: "2000-01-01" });
  assert.ok(checkQuality(s).issues.some((i) => i.type === "stale"));
});

test("CSVの往復(カンマ・改行・引用符を含む)", () => {
  const rows = [["会社名", "メモ"], ["A,B", '言った"こと"\n改行']];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test("大手で決裁者と商談がある会社は優先度が高い", () => {
  const s = tmpStore();
  const big = s.insert("companies", { name: "大手社", tier: "大手" });
  const small = s.insert("companies", { name: "小規模社", tier: "中小" });
  s.insert("contacts", { companyId: big.id, name: "X", role: "決裁者" });
  s.insert("deals", { companyId: big.id, title: "t", stage: "提案" });
  assert.ok(priorityScore(s, big) > priorityScore(s, small));
});
