// 日本の祝日(「国民の祝日に関する法律」に基づく)を計算で求める。
// 外部のデータに頼らないので、ネットにつながらない環境でも使える。
//
// 対象:2000年以降。春分・秋分の日は、国立天文台が前年2月に公表する日付と、
// 一般に使われている近似式で求めた日付が一致する範囲(おおむね2099年まで)を前提にしている。
// 東京五輪(2020・2021年)の祝日の移動のような、特別法による一時的な変更は個別に反映している。
// 将来、法律が改正された場合は、このファイルを更新する必要がある。

const pad = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
// その月の第n月曜日
const nthMonday = (y, m, n) => 1 + ((8 - dow(y, m, 1)) % 7) + (n - 1) * 7;

const springEquinox = (y) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
const autumnEquinox = (y) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

// 特別法による年ごとの例外([追加/変更する日, 名前] と、その年には無い祝日)
const SPECIAL = {
  2019: { add: [["2019-04-30", "国民の休日"], ["2019-05-01", "天皇の即位の日"], ["2019-05-02", "国民の休日"], ["2019-10-22", "即位礼正殿の儀の行われる日"]] },
  2020: { add: [["2020-07-23", "海の日"], ["2020-07-24", "スポーツの日"], ["2020-08-10", "山の日"]], remove: ["海の日", "スポーツの日", "山の日"] },
  2021: { add: [["2021-07-22", "海の日"], ["2021-07-23", "スポーツの日"], ["2021-08-08", "山の日"]], remove: ["海の日", "スポーツの日", "山の日"] },
};

const cache = new Map();

// その年の祝日を Map(日付 → 名前)で返す(振替休日・国民の休日を含む)
export function holidaysOf(year) {
  if (cache.has(year)) return cache.get(year);
  const y = year;
  const list = [
    [ymd(y, 1, 1), "元日"],
    [ymd(y, 1, nthMonday(y, 1, 2)), "成人の日"],
    [ymd(y, 2, 11), "建国記念の日"],
    ...(y >= 2020 ? [[ymd(y, 2, 23), "天皇誕生日"]] : []),
    [ymd(y, 3, springEquinox(y)), "春分の日"],
    [ymd(y, 4, 29), "昭和の日"],
    [ymd(y, 5, 3), "憲法記念日"],
    [ymd(y, 5, 4), "みどりの日"],
    [ymd(y, 5, 5), "こどもの日"],
    [ymd(y, 7, nthMonday(y, 7, 3)), "海の日"],
    ...(y >= 2016 ? [[ymd(y, 8, 11), "山の日"]] : []),
    [ymd(y, 9, nthMonday(y, 9, 3)), "敬老の日"],
    [ymd(y, 9, autumnEquinox(y)), "秋分の日"],
    [ymd(y, 10, nthMonday(y, 10, 2)), y >= 2020 ? "スポーツの日" : "体育の日"],
    [ymd(y, 11, 3), "文化の日"],
    [ymd(y, 11, 23), "勤労感謝の日"],
    ...(y <= 2018 ? [[ymd(y, 12, 23), "天皇誕生日"]] : []),
  ];
  const sp = SPECIAL[y];
  const base = sp?.remove ? list.filter(([, name]) => !sp.remove.includes(name)) : list;
  const map = new Map([...base, ...(sp?.add ?? [])].sort((a, b) => (a[0] < b[0] ? -1 : 1)));

  // 国民の休日:祝日と祝日にはさまれた平日(例:敬老の日と秋分の日の間)
  const next = (date, n) => new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
  for (const date of [...map.keys()]) {
    const mid = next(date, 1);
    const wd = new Date(`${mid}T00:00:00Z`).getUTCDay();
    if (!map.has(mid) && map.has(next(date, 2)) && wd !== 0) map.set(mid, "国民の休日");
  }
  // 振替休日:祝日が日曜日のとき、その後の最初の「祝日でない日」
  for (const date of [...map.keys()].sort()) {
    if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 0) continue;
    let d = next(date, 1);
    while (map.has(d)) d = next(d, 1);
    map.set(d, "振替休日");
  }
  const sorted = new Map([...map].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  cache.set(year, sorted);
  return sorted;
}

// 祝日なら名前を、そうでなければ null を返す
export function holidayName(date) {
  const y = Number(String(date).slice(0, 4));
  if (!(y >= 2000 && y <= 2099)) return null;
  return holidaysOf(y).get(date) ?? null;
}

// 会社独自の休業日(年末年始・夏季休業など)。環境変数 COMPANY_HOLIDAYS に
// 「12-29,12-30,12-31,01-02,01-03」(毎年)や「2026-08-13」(その日だけ)の形で指定できる
function companyHoliday(date) {
  const list = String(process.env.COMPANY_HOLIDAYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.some((x) => x === date || x === date.slice(5));
}

// 営業日か(土日・祝日・会社の休業日を除く)
export function isBusinessDay(date) {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  if (holidayName(date)) return false;
  return !companyHoliday(date);
}

// 休みの理由(画面表示用)
export function dayOffReason(date) {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (wd === 0 || wd === 6) return wd === 0 ? "日曜日" : "土曜日";
  return holidayName(date) ?? (companyHoliday(date) ? "会社の休業日" : null);
}
