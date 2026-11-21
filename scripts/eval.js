// AIの精度を測るコマンド
//   npm run eval            … 商談分析と取り込みの両方
//   npm run eval -- meeting … 商談分析だけ
//   npm run eval -- extract … 取り込みだけ
//
// 正解つきの問題集(eval/cases.js)をAIに解かせ、正解とどれだけ一致したかを表示します。
// AIのAPIキー(ANTHROPIC_API_KEY)が必要で、実行するとAPIの利用料がかかります
// (問題数ぶん、AIを呼び出します。目安は1回の実行で数十円〜百円程度)。
// 結果は data/eval/ に保存されるので、プロンプトを直す前後で比べられます。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiEnabled, analyzeMeeting, extractCrm } from "../lib/ai.js";
import { meetingCases, extractCases } from "../eval/cases.js";
import { scoreMeeting, scoreExtract, summarize } from "../eval/score.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const which = process.argv[2] ?? "all";

if (!aiEnabled()) {
  console.log("ANTHROPIC_API_KEY が設定されていないため、精度の測定は実行できません。");
  console.log(".env にAPIキーを設定してから、もう一度実行してください。");
  process.exit(1);
}

const tokens = { input: 0, output: 0 };
const onUsage = (u) => { tokens.input += u.input; tokens.output += u.output; };

async function run(cases, fn, scorer) {
  const out = [];
  for (const c of cases) {
    process.stdout.write(`  ${c.id} … `);
    try {
      const result = await fn(c);
      const score = scorer(result, c.expected);
      out.push({ id: c.id, title: c.title, score, result });
      console.log(`${score.correct}/${score.total}`);
      for (const ch of score.checks.filter((x) => !x.ok)) console.log(`      × ${ch.item}:正解「${ch.expected}」 → AI「${ch.got}」`);
    } catch (e) {
      console.log(`エラー:${e.message}`);
      out.push({ id: c.id, title: c.title, error: e.message, score: { checks: [], correct: 0, total: 0 } });
    }
  }
  return out;
}

const report = { at: new Date().toISOString(), model: process.env.CLAUDE_MODEL || "claude-opus-5-5" };
if (which === "all" || which === "meeting") {
  console.log("\n■ 商談分析");
  const rs = await run(meetingCases, (c) => analyzeMeeting({ transcript: c.transcript, date: c.date }, onUsage), scoreMeeting);
  report.meeting = { summary: summarize(rs), results: rs };
}
if (which === "all" || which === "extract") {
  console.log("\n■ 取り込み(名刺・署名・メモ)");
  const rs = await run(extractCases, (c) => extractCrm(c.text, onUsage), scoreExtract);
  report.extract = { summary: summarize(rs), results: rs };
}
report.tokens = tokens;

console.log("\n■ 結果");
for (const k of ["meeting", "extract"]) {
  if (!report[k]) continue;
  const s = report[k].summary;
  console.log(`  ${k === "meeting" ? "商談分析" : "取り込み"}:${s.correct}/${s.total}(${s.accuracy}%)`);
  for (const [item, v] of Object.entries(s.byItem)) console.log(`    ${item}:${v.correct}/${v.total}(${v.accuracy}%)`);
}
console.log(`  使用トークン:入力 ${tokens.input.toLocaleString()}・出力 ${tokens.output.toLocaleString()}`);

const dir = path.join(process.env.DATA_DIR || path.join(here, "..", "data"), "eval");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `eval-${report.at.replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`\n詳しい結果を保存しました:${file}`);
