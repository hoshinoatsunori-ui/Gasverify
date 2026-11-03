'use strict';
/**
 * 診断書（設計書9.4）と実行履歴（F10）
 *  - 標準出力：1回の実行につき1つのJSON（AI向け）
 *  - 標準エラー：人向けの要約
 */
const fs = require('fs');
const path = require('path');
const { CATEGORY } = require('./errors');

function runId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** スタックの先頭（最も深い呼び出し）から、ローカルにある関数の位置を取る */
function locate(stack, funcMap, root) {
  for (const s of stack || []) {
    const m = funcMap[s.function];
    if (m) return { file: path.relative(root, m.file).split(path.sep).join('/'), line: s.line, function: s.function };
  }
  return null;
}

function finalize(cfg, diag) {
  diag.exitCode = diag.exitCode || 0;
  diag.category = CATEGORY[diag.exitCode];
  diag.profile = cfg ? cfg.profileName : undefined;
  diag.account = diag.account || undefined;
  diag.runId = diag.runId || runId();
  if (cfg) {
    try {
      const dir = path.join(cfg.stateDir, 'runs');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${diag.runId}.json`), JSON.stringify(diag, null, 2));
    } catch (e) {
      // 履歴の保存失敗は本体の判定に影響させない
    }
  }
  return diag;
}

function printHuman(diag) {
  const icon = { 0: 'OK', 1: 'NG(コード)', 2: 'NG(準備)', 3: 'NG(基盤)' }[diag.exitCode];
  const lines = [`[gasverify] ${icon} ${diag.command}${diag.account ? `  account=${diag.account}` : ''}  profile=${diag.profile || '-'}`];
  if (diag.summary) lines.push(`  ${diag.summary}`);
  for (const w of diag.warnings || []) lines.push(`  警告 ${w.where}: ${w.message}`);
  for (const t of diag.failedTests || []) {
    lines.push(`  失敗 ${t.name}${t.location ? ` @ ${t.location.file}:${t.location.line}` : ''}: ${t.message}`);
    for (const a of t.failedAssertions || []) lines.push(`    - ${a.label}: expected=${JSON.stringify(a.expected)} actual=${JSON.stringify(a.actual)}`);
  }
  if (diag.exitCode !== 0 && diag.message && !(diag.failedTests || []).length) lines.push(`  ${diag.message}`);
  if (diag.next) lines.push(`  次: ${diag.next}`);
  process.stderr.write(lines.join('\n') + '\n');
}

function emit(diag) {
  printHuman(diag);
  process.stdout.write(JSON.stringify(diag, null, 2) + '\n');
}

module.exports = { finalize, emit, locate, runId };
