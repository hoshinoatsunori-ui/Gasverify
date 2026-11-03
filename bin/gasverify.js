#!/usr/bin/env node
'use strict';
/**
 * gasverify — Claude Codeが生成したGASを push・実行・判定まで自動で回すCLI
 *
 *   gasverify init [--script <ID>]           設定ファイルとClaude Code連携ファイルを作る
 *   gasverify login [--profile p]            ブラウザで承認（必要なスコープはマニフェストから決める）
 *   gasverify logout [--profile p]           トークンを削除
 *   gasverify doctor [--fix]                 準備状況を検査（--fix は権限を広げない下準備のみ自動実行）
 *   gasverify push [--force]                 src/ と test/ をGASへ反映
 *   gasverify run <関数名> [--args '[...]'] [--live]   関数を実行（既定はテストモード＝副作用なし）
 *   gasverify test [--filter 文字列]          test_ 関数を実行して合否を集計
 *   gasverify verify [--filter 文字列]        push → test を一括実行（Claude Codeは原則これだけ使う）
 *
 * 終了コード：0 成功 / 1 コードの誤り / 2 準備不足 / 3 実行基盤障害
 * 標準出力：診断書JSON（1回の実行につき1つ）、標準エラー：人向けの要約
 */
const { CATEGORY } = require('../lib/errors');
const { fromGvError } = require('../lib/classify');
const { emit, finalize } = require('../lib/report');
const commands = require('../lib/commands');

function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (['fix', 'force', 'live', 'help'].includes(key)) opts[key] = true;
      else if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else opts[key] = true;
    } else opts._.push(a);
  }
  return opts;
}

const HELP = require('fs').readFileSync(__filename, 'utf8').split('\n').slice(3, 15).map((l) => l.replace(/^ \* ?/, '')).join('\n');

(async () => {
  const opts = parse(process.argv.slice(2));
  const cmd = opts._[0];
  if (!cmd || opts.help || cmd === 'help') {
    process.stderr.write(HELP + '\n');
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === 'run') opts.fn = opts._[1];
  const handler = commands[cmd];
  let diag;
  if (!handler) {
    diag = { command: cmd, exitCode: 1, reason: 'unknown_command', message: `不明なコマンド: ${cmd}`, next: 'gasverify help で使い方を確認してください' };
  } else {
    try {
      diag = await handler(opts);
    } catch (e) {
      diag = Object.assign({ command: cmd }, fromGvError(e));
      if (!diag.runId) diag = finalize(null, diag);
    }
  }
  if (!diag.category) diag.category = CATEGORY[diag.exitCode];
  emit(diag);
  process.exit(diag.exitCode);
})();
