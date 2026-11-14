// 日付の共通処理。
// サーバーの時計は世界標準時(UTC)のことが多く、そのまま使うと
// 日本では朝9時まで「前日」扱いになってしまう。
// そのため「今日」「今月」は、必ず指定のタイムゾーンで計算する。
export const TIMEZONE = () => process.env.APP_TIMEZONE || "Asia/Tokyo";

// YYYY-MM-DD(sv-SE ロケールは ISO 形式で日付を返す)
export function localDate(d = new Date(), offsetDays = 0) {
  const t = new Date(d.getTime() + offsetDays * 864e5);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TIMEZONE(), year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
}

export const localMonth = (d = new Date()) => localDate(d).slice(0, 7);

export function localHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE(), hour: "2-digit", hourCycle: "h23" }).format(d));
}

export const isDateString = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
