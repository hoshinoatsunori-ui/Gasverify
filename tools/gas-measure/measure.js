#!/usr/bin/env node
/**
 * measure.js — scripts.run のエラー応答を実測し、判定表（Q5）と行番号（Q7）の材料を集める
 *
 * 使い方（gas-probe フォルダで。credentials.json と node_modules を共用）
 *   node measure.js --script <スクリプトID>                 全ケース（7分かかる case_timeout は除く）
 *   node measure.js --script <スクリプトID> --include-slow  case_timeout も含める
 *   node measure.js --script <スクリプトID> --only H5_api_disabled   1ケースだけ
 *
 * 出力
 *   results/measure-<日時>.json  生データ（すべての応答をそのまま保存）
 *   results/measure-<日時>.md    判定表の下書き（これを貼ってもらえれば判定表を作る）
 *
 * 認証
 *   初回だけブラウザで承認する（スコープ2種類ぶん、最大2回）。トークンは .tokens/ に保存して再利用する。
 *   .tokens/ と credentials.json は共有しないこと。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

const scriptId = arg('script');
const credsPath = path.resolve(arg('creds', './credentials.json'));
const only = arg('only');
const includeSlow = has('include-slow');
const rootUrl = process.env.GAS_MEASURE_ROOT_URL; // テスト用（通常は未設定）

if (!scriptId || /^\d+$/.test(scriptId)) {
  console.error('--script にはGASの「スクリプトID」（英数字の長いID）を指定してください');
  process.exit(2);
}

const SCOPE_EMAIL = 'https://www.googleapis.com/auth/userinfo.email';
const SCOPE_FETCH = 'https://www.googleapis.com/auth/script.external_request';
const FULL = [SCOPE_EMAIL, SCOPE_FETCH]; // マニフェストと同じ
const MIN = [SCOPE_EMAIL];               // マニフェストより狭い（E6用）

// 期待分類: 1=コードの誤り 2=準備不足 3=実行基盤 0=成功 '-'=観察のみ
const CASES = [
  { id: 'C00_ok', fn: 'case_ok', expect: 0, note: '戻り値の形' },
  { id: 'C01_typeError', fn: 'case_typeError', expect: 1 },
  { id: 'C02_referenceError', fn: 'case_referenceError', expect: 1 },
  { id: 'C03_throwError', fn: 'case_throwError', expect: 1 },
  { id: 'C04_throwString', fn: 'case_throwString', expect: 1, note: 'Error以外をthrow' },
  { id: 'C05_gmailWithoutScope', fn: 'case_gmailWithoutScope', expect: 2, note: 'GAS内の権限エラー' },
  { id: 'C06_returnBlob', fn: 'case_returnBlob', expect: '-', note: '固有オブジェクトの戻り値' },
  { id: 'C07_returnDate', fn: 'case_returnDate', expect: '-' },
  { id: 'C08_returnUndefined', fn: 'case_returnUndefined', expect: '-' },
  { id: 'C09_args', fn: 'case_args', params: ['文字', 123, { k: [1, true, null] }], expect: 0, note: '引数の受け渡し' },
  { id: 'C10_private', fn: 'case_private_', expect: '-', note: '末尾_の関数' },
  { id: 'C11_consoleLog', fn: 'case_consoleLog', expect: 0, note: 'ログはclasp logsで別途確認' },
  { id: 'C12_timeout', fn: 'case_timeout', expect: 1, slow: true, note: '7分ループ' },
  { id: 'L01_line_direct', fn: 'line_direct', expect: 1, note: 'Q7' },
  { id: 'L02_line_nested', fn: 'line_nested', expect: 1, note: 'Q7（入れ子）' },
  { id: 'H01_noSuchFunction', fn: 'case_doesNotExist', expect: 1, note: '存在しない関数名' },
  { id: 'H02_wrongScriptId', fn: 'case_ok', wrongScript: true, expect: 2 },
  { id: 'H03_notDevMode', fn: 'case_ok', devMode: false, expect: 2, note: 'デプロイ済み版に関数がない' },
  { id: 'H04_invalidToken', fn: 'case_ok', badToken: true, expect: 2 },
  { id: 'H05_tokenScopeShort', fn: 'case_ok', scopes: MIN, expect: 2, note: 'トークンのスコープ不足' },
  { id: 'H06_api_disabled', fn: 'case_ok', manual: true, expect: 2,
    note: 'Cloudコンソールで Apps Script API を無効化してから --only で実行し、終わったら有効に戻す' },
];

// ---------- 認証（スコープの組ごとにトークンを保存して再利用） ----------
async function getAuth(google, scopes) {
  const keys = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  const k = keys.installed || keys.web;
  const client = new google.auth.OAuth2(k.client_id, k.client_secret);
  const key = crypto.createHash('sha1').update(scopes.slice().sort().join(' ')).digest('hex').slice(0, 10);
  const file = path.join('.tokens', `${key}.json`);
  fs.mkdirSync('.tokens', { recursive: true });
  client.on('tokens', (t) => {
    const merged = Object.assign({}, client.credentials, t);
    fs.writeFileSync(file, JSON.stringify(merged));
  });
  if (fs.existsSync(file)) {
    client.setCredentials(JSON.parse(fs.readFileSync(file, 'utf8')));
    return client;
  }
  const { authenticate } = require('@google-cloud/local-auth');
  console.error(`ブラウザで承認してください（スコープ: ${scopes.join(', ')}）`);
  const localAuth = await authenticate({ keyfilePath: credsPath, scopes });
  // local-auth と googleapis は別バージョンの認証ライブラリを使うため移し替える
  client.setCredentials(localAuth.credentials);
  fs.writeFileSync(file, JSON.stringify(localAuth.credentials));
  return client;
}

// ---------- 1ケース実行 ----------
async function runCase(google, c, authFull) {
  let auth = authFull;
  if (c.scopes) auth = await getAuth(google, c.scopes);
  if (c.badToken) {
    auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: 'invalid-token-for-measure', expiry_date: Date.now() + 3600e3 });
  }
  const id = c.wrongScript ? scriptId.slice(0, -4) + 'XXXX' : scriptId;
  const opts = { version: 'v1', auth };
  if (rootUrl) opts.rootUrl = rootUrl;
  const script = google.script(opts);
  const body = { function: c.fn, devMode: c.devMode === undefined ? true : c.devMode };
  if (c.params) body.parameters = c.params;

  const t0 = Date.now();
  const rec = { id: c.id, fn: c.fn, expect: c.expect, note: c.note || '', request: body };
  try {
    const res = await script.scripts.run({ scriptId: id, requestBody: body });
    rec.http = res.status;
    rec.data = res.data;
  } catch (e) {
    rec.http = e.response ? e.response.status : null;
    rec.data = e.response ? e.response.data : null;
    if (!e.response) rec.exception = String(e && e.message);
  }
  rec.ms = Date.now() - t0;
  return rec;
}

// ---------- 結果の要約 ----------
function summarize(rec) {
  const d = rec.data || {};
  const out = { kind: '', status: '', type: '', message: '', stack: '', result: '' };
  if (d.error && d.error.details && d.error.details[0] && d.error.details[0].errorType !== undefined) {
    // HTTPは200、GAS内で例外（ExecutionError）
    const x = d.error.details[0];
    out.kind = 'ExecutionError';
    out.status = `code=${d.error.code} ${d.error.message || ''}`;
    out.type = x.errorType || '';
    out.message = x.errorMessage || '';
    out.stack = (x.scriptStackTraceElements || []).map((s) => `${s.function}:${s.lineNumber}`).join(' < ');
  } else if (d.error) {
    // HTTPレベルの拒否
    out.kind = 'HTTP error';
    out.status = `${d.error.status || ''} ${d.error.code || ''}`.trim();
    const reasons = (d.error.details || []).map((x) => x.reason).filter(Boolean);
    const errs = (d.error.errors || []).map((x) => x.reason).filter(Boolean);
    out.type = [...reasons, ...errs].join(',');
    out.message = d.error.message || '';
  } else if (d.response) {
    out.kind = 'OK';
    out.result = JSON.stringify(d.response.result);
  } else if (rec.exception) {
    out.kind = 'exception';
    out.message = rec.exception;
  }
  return out;
}

function lineMarkers() {
  // gas/*.gs の「// @line 関数名」を探し、関数名→{file,line} を作る
  const dir = path.join(__dirname, 'gas');
  const map = {};
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.gs'))) {
    fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
      const m = line.match(/\/\/ @line (\S+)/);
      if (m) map[m[1]] = { file: f, line: i + 1 };
    });
  }
  return map;
}

const esc = (s) => String(s === undefined ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 160);

function writeReport(records) {
  fs.mkdirSync('results', { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const base = path.join('results', `measure-${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(records, null, 2));

  const L = [];
  L.push(`# scripts.run 実測結果（${new Date().toLocaleString('ja-JP')}）`, '');
  L.push('期待分類：0=成功 1=コードの誤り 2=準備不足 3=実行基盤 -=観察のみ', '');
  L.push('| ケース | 期待 | HTTP | 種別 | status | errorType/reason | errorMessage | stack | 戻り値 | ms |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of records) {
    const s = summarize(r);
    L.push(`| ${r.id} | ${r.expect} | ${r.http} | ${s.kind} | ${esc(s.status)} | ${esc(s.type)} | ${esc(s.message)} | ${esc(s.stack)} | ${esc(s.result)} | ${r.ms} |`);
  }

  // Q7：行番号の照合
  const marks = lineMarkers();
  L.push('', '## Q7 行番号の照合', '');
  L.push('| ケース | 関数 | ローカルのファイル:行 | GASが返した行 | 一致 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const r of records) {
    const x = r.data && r.data.error && r.data.error.details && r.data.error.details[0];
    for (const s of (x && x.scriptStackTraceElements) || []) {
      const m = marks[s.function];
      if (!m) continue;
      L.push(`| ${r.id} | ${s.function} | ${m.file}:${m.line} | ${s.lineNumber} | ${m.line === s.lineNumber ? 'OK' : 'ずれ'} |`);
    }
  }
  fs.writeFileSync(`${base}.md`, L.join('\n') + '\n');
  return base;
}

// ---------- メイン ----------
(async () => {
  let google;
  try {
    ({ google } = require('googleapis'));
  } catch (e) {
    console.error('npm install googleapis @google-cloud/local-auth を先に実行してください');
    process.exit(2);
  }

  let targets = CASES.filter((c) => (only ? c.id === only || c.fn === only : !c.manual && (includeSlow || !c.slow)));
  if (only && targets.length === 0) {
    console.error(`ケース ${only} が見つかりません。ID一覧: ${CASES.map((c) => c.id).join(', ')}`);
    process.exit(2);
  }
  const manual = targets.find((c) => c.manual);
  if (manual) console.error(`手動ケース: ${manual.note}`);

  const authFull = await getAuth(google, FULL);
  const records = [];
  for (const c of targets) {
    process.stderr.write(`${c.id} ... `);
    const rec = await runCase(google, c, authFull);
    records.push(rec);
    process.stderr.write(`HTTP ${rec.http} ${summarize(rec).kind} (${rec.ms}ms)\n`);
  }
  const base = writeReport(records);
  console.log(`\n結果: ${base}.md（判定表の下書き） / ${base}.json（生データ）`);
})();
