// 祝日の計算のテスト。内閣府が公表している「国民の祝日」と照合する
import { test } from "node:test";
import assert from "node:assert/strict";
import { holidaysOf, holidayName, isBusinessDay, dayOffReason } from "../lib/holidays.js";

const list = (y) => [...holidaysOf(y).keys()].map((d) => d.slice(5));

test("2025年の祝日(振替休日を含む)", () => {
  assert.deepEqual(list(2025), [
    "01-01", "01-13", "02-11", "02-23", "02-24", "03-20", "04-29", "05-03", "05-04", "05-05", "05-06",
    "07-21", "08-11", "09-15", "09-23", "10-13", "11-03", "11-23", "11-24",
  ]);
});

test("2026年の祝日(振替休日・国民の休日を含む)", () => {
  assert.deepEqual(list(2026), [
    "01-01", "01-12", "02-11", "02-23", "03-20", "04-29", "05-03", "05-04", "05-05", "05-06",
    "07-20", "08-11", "09-21", "09-22", "09-23", "10-12", "11-03", "11-23",
  ]);
  assert.equal(holidayName("2026-09-22"), "国民の休日");
  assert.equal(holidayName("2026-05-06"), "振替休日");
});

test("2027年の祝日", () => {
  assert.deepEqual(list(2027), [
    "01-01", "01-11", "02-11", "02-23", "03-21", "03-22", "04-29", "05-03", "05-04", "05-05",
    "07-19", "08-11", "09-20", "09-23", "10-11", "11-03", "11-23",
  ]);
});

test("東京五輪の年は、特別法で祝日が移動している", () => {
  assert.equal(holidayName("2020-07-24"), "スポーツの日");
  assert.equal(holidayName("2020-10-12"), null);
  assert.equal(holidayName("2021-08-09"), "振替休日", "8/8(日)の山の日の振替");
});

test("営業日の判定:土日・祝日・会社の休業日", () => {
  assert.equal(isBusinessDay("2026-11-23"), false);
  assert.equal(dayOffReason("2026-11-23"), "勤労感謝の日");
  assert.equal(dayOffReason("2026-11-21"), "土曜日");
  assert.equal(isBusinessDay("2026-11-24"), true);
  process.env.COMPANY_HOLIDAYS = "12-30,12-31,2026-08-14";
  try {
    assert.equal(isBusinessDay("2026-12-30"), false);
    assert.equal(isBusinessDay("2027-12-30"), false, "月-日の指定は毎年");
    assert.equal(isBusinessDay("2026-08-14"), false);
    assert.equal(isBusinessDay("2027-08-13"), true, "年月日の指定はその日だけ");
    assert.equal(dayOffReason("2026-12-30"), "会社の休業日");
  } finally {
    delete process.env.COMPANY_HOLIDAYS;
  }
});
