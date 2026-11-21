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

// 形式だけでなく、実在する日付か(2月30日などを除く)まで確かめる
export const isDateString = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

// いろいろな書き方の日付を YYYY-MM-DD にそろえる(CSVの取り込み用)。読めなければ ""
// 例:2026/1/5、2026.01.05、2026年1月5日、令和8年1月5日、20260105
export function parseDateLoose(value) {
  if (value === null || value === undefined) return "";
  let s = String(value).normalize("NFKC").trim();
  if (!s) return "";
  if (isDateString(s)) return s;
  const era = s.match(/^(令和|平成|R|H)\s*(\d{1,2}|元)\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?$/i);
  let y, m, d;
  if (era) {
    const base = /^(令和|R)$/i.test(era[1]) ? 2018 : 1988;
    y = base + (era[2] === "元" ? 1 : Number(era[2]));
    m = Number(era[3]);
    d = Number(era[4]);
  } else {
    const g = s.match(/^(\d{4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?(?:\s.*)?$/) ?? s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!g) return "";
    [y, m, d] = [Number(g[1]), Number(g[2]), Number(g[3])];
  }
  const out = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  // 2月30日のような、存在しない日付は採用しない
  const dt = new Date(`${out}T00:00:00Z`);
  return isDateString(out) && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d ? out : "";
}
