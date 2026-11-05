'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig, assertAllowed, CONFIG_NAME } = require('./config');
const { GvError } = require('./errors');
const auth = require('./auth');
const files = require('./files');
const api = require('./api');
const { classify, fromGvError } = require('./classify');
const { finalize, locate, runId } = require('./report');
const drift = require('./drift');

let googleCache;
function google() {
  if (!googleCache) googleCache = require('googleapis').google;
  return googleCache;
}

const INVOKE = 'gasverify_invoke';

// ---------------------------------------------------------------- 共通
function context(opts) {
  const cfg = loadConfig(opts);
  return cfg;
}

function clientFor(cfg) {
  const { client, token } = auth.getClient(google(), cfg);
  return { client, account: token.email || '' };
}

function worst(codes) {
  // 2（準備不足）> 3（基盤）> 1（コード）> 0：準備不足が混ざっていればコードに触らせない
  if (codes.includes(2)) return 2;
  if (codes.includes(3)) return 3;
  if (codes.includes(1)) return 1;
  return 0;
}

// ---------------------------------------------------------------- init
function init(opts) {
  const root = path.resolve(opts.cwd || process.cwd());
  const created = [];
  const skipped = [];
  const write = (rel, content) => {
    const p = path.join(root, rel);
    if (fs.existsSync(p)) {
      skipped.push(rel);
      return;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    created.push(rel);
  };
  const scriptId = opts.script || 'ここにスクリプトID';
  write(CONFIG_NAME, JSON.stringify({
    defaultProfile: 'personal',
    srcDir: 'src',
    testDir: 'test',
    retry: 2,
    sameTestFailLimit: 5,
    profiles: { personal: { scriptId, allowedScriptIds: [scriptId] } },
  }, null, 2) + '\n');
  write('src/appsscript.json', JSON.stringify({
    timeZone: 'Asia/Tokyo', runtimeVersion: 'V8', exceptionLogging: 'STACKDRIVER',
    oauthScopes: ['https://www.googleapis.com/auth/userinfo.email'],
    executionApi: { access: 'MYSELF' },
  }, null, 2) + '\n');
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });

  const tdir = path.join(__dirname, '..', 'templates');
  const claudeMd = fs.readFileSync(path.join(tdir, 'CLAUDE.md'), 'utf8');
  if (fs.existsSync(path.join(root, 'CLAUDE.md'))) write('CLAUDE.gasverify.md', claudeMd);
  else write('CLAUDE.md', claudeMd);
  write('.claude/commands/gas-verify.md', fs.readFileSync(path.join(tdir, 'gas-verify.md'), 'utf8'));
  write('.claude/settings.json', fs.readFileSync(path.join(tdir, 'settings.json'), 'utf8'));

  const gi = path.join(root, '.gitignore');
  const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!/^\.gasverify\/?$/m.test(giText)) {
    fs.writeFileSync(gi, giText + (giText && !giText.endsWith('\n') ? '\n' : '') + '.gasverify/\ncredentials.json\n');
    created.push('.gitignore（追記）');
  }
  return {
    command: 'init', exitCode: 0, created, skipped,
    summary: `作成 ${created.length} 件、既存のためスキップ ${skipped.length} 件`,
    next: `credentials.json を ${path.join('~', '.gasverify', 'personal', 'credentials.json')} に置き、gasverify login を実行してください`,
  };
}

// ---------------------------------------------------------------- login / logout
async function login(opts) {
  const cfg = context(opts);
  let scopes;
  const warnings = [];
  try {
    scopes = auth.requiredScopes(files.readManifest(cfg));
  } catch (e) {
    scopes = auth.requiredScopes(null);
    warnings.push({ where: 'appsscript.json', message: 'マニフェストが読めないため基本スコープだけで承認します' });
  }
  process.stderr.write(`ブラウザで承認してください（プロファイル: ${cfg.profileName}）\n  スコープ: ${scopes.join(', ')}\n`);
  const email = await auth.login(google(), cfg, scopes);
  return { command: 'login', exitCode: 0, account: email, scopes, warnings, summary: `${email} でログインしました（${cfg.profileName}）` };
}

function logout(opts) {
  const cfg = context(opts);
  const removed = auth.logout(cfg);
  return { command: 'logout', exitCode: 0, summary: removed ? `プロファイル ${cfg.profileName} のトークンを削除しました` : '削除するトークンはありません' };
}

// ---------------------------------------------------------------- doctor
async function doctor(opts) {
  const checks = [];
  const add = (name, ok, detail, next) => checks.push({ name, ok, detail, next });
  let cfg;
  try {
    cfg = context(opts);
    add('設定ファイル', true, `${cfg.file}（profile=${cfg.profileName}）`);
  } catch (e) {
    const c = fromGvError(e);
    add('設定ファイル', false, c.message, c.next);
    return { command: 'doctor', exitCode: 2, checks, next: c.next };
  }
  const step = (name, fn) => {
    try {
      const detail = fn();
      add(name, true, detail);
      return true;
    } catch (e) {
      const c = fromGvError(e);
      add(name, false, c.message, c.next);
      return false;
    }
  };
  step('スクリプトID（許可リスト）', () => { assertAllowed(cfg); return cfg.scriptId; });
  let manifest = null;
  step('マニフェスト', () => { manifest = files.readManifest(cfg); return `oauthScopes ${((manifest.oauthScopes) || []).length} 件`; });
  step('OAuthクライアント', () => { auth.readClientKeys(cfg); return cfg.credentialsPath; });

  let client = null;
  let account = '';
  const tokenOk = step('ログイン', () => {
    const r = clientFor(cfg);
    client = r.client;
    account = r.account;
    return account;
  });
  if (tokenOk) {
    const missing = auth.missingScopes(auth.readToken(cfg), auth.requiredScopes(manifest));
    if (missing.length) add('スコープ', false, `不足: ${missing.join(', ')}`, `gasverify login --profile ${cfg.profileName} で再承認してください（追加のスコープは人が承認すること）`);
    else add('スコープ', true, 'マニフェストとpushに必要なスコープはすべて承認済み');
  }

  let pushNeeded = false;
  if (client && checks.every((c) => c.ok)) {
    const p = await api.getProject(google(), client, cfg);
    if (p.http === 200) add('Apps Script API（プロジェクト取得）', true, p.data && p.data.title ? `プロジェクト名: ${p.data.title}` : 'OK');
    else {
      const c = classify(Object.assign({}, p, { fn: '' }));
      add('Apps Script API（プロジェクト取得）', false, c.message, c.next);
    }
    if (checks.every((c) => c.ok)) {
      const r = await api.runFunction(google(), client, cfg, { invoke: 'gasverify_ping', fn: 'gasverify_ping', funcMap: {} });
      if (r.exitCode === 0) add('実行（gasverify_ping）', true, `実行ユーザー: ${(r.result && r.result.user) || '?'} / ${r.ms}ms`);
      else if (r.reason === 'runtime_not_pushed' || r.reason === 'function_not_found') {
        pushNeeded = true;
        add('実行（gasverify_ping）', false, 'ランタイムが未反映です', 'gasverify push を実行してください（doctor --fix で自動実行）');
      } else add('実行（gasverify_ping）', false, r.message, r.next);
    }
  }

  // --fix：権限を広げない下準備だけ自動で行う（F07）
  if (opts.fix && pushNeeded && checks.filter((c) => !c.ok).length === 1) {
    const pr = await push(Object.assign({}, opts, { quiet: true }));
    add('自動修復: push', pr.exitCode === 0, pr.summary || pr.message, pr.next);
    if (pr.exitCode === 0) checks.splice(checks.findIndex((c) => c.name === '実行（gasverify_ping）'), 1);
  }

  const failed = checks.filter((c) => !c.ok);
  return finalize(cfg, {
    command: 'doctor', exitCode: failed.length ? 2 : 0, account, checks,
    summary: failed.length ? `${failed.length} 件の準備不足があります` : '準備はすべて整っています',
    next: failed.length ? failed[0].next : undefined,
  });
}

// ---------------------------------------------------------------- push
async function push(opts) {
  const cfg = context(opts);
  assertAllowed(cfg);
  const { files: list } = files.collectPushFiles(cfg);
  const warnings = files.staticChecks(cfg, list);
  const { client, account } = clientFor(cfg);
  const missing = auth.missingScopes(auth.readToken(cfg), [auth.SCOPE_PROJECTS]);
  if (missing.length) {
    throw new GvError(2, 'push_scope_missing', 'push に必要なスコープ（script.projects）が承認されていません', `gasverify login --profile ${cfg.profileName} を実行してください`);
  }

  // push は GAS 側を置き換えるため、GAS 側にしかない変更があれば止める（lib/drift.js）
  if (!opts.force) {
    const cur = await api.getContent(google(), client, cfg);
    if (cur.http !== 200) {
      const c = classify(Object.assign({}, cur, { fn: '' }));
      return finalize(cfg, Object.assign({ command: 'push', account, warnings }, c, { raw: cur.data }));
    }
    const remoteFiles = (cur.data && cur.data.files) || [];
    const d = drift.checkDrift(cfg, list, remoteFiles);
    if (!d.ok) {
      const stamp = runId();
      const saved = drift.saveRemoteCopy(cfg, remoteFiles, stamp);
      const label = (k) => k.replace(/\.SERVER_JS$/, '.gs').replace(/\.HTML$/, '.html').replace(/\.JSON$/, '.json');
      const parts = [];
      if (d.remoteOnly.length) parts.push(`GAS側にだけあるファイル: ${d.remoteOnly.map(label).join(', ')}`);
      if (d.modified.length) parts.push(`${d.basis === 'last_push' ? '前回のpush後にGAS側で変更されたファイル' : '手元と内容が違うファイル（初回のため新旧を判断できない）'}: ${d.modified.map(label).join(', ')}`);
      if (d.removed.length) parts.push(`GAS側で削除されたファイル: ${d.removed.map(label).join(', ')}`);
      return finalize(cfg, {
        command: 'push', exitCode: 2, account, reason: 'remote_changed', warnings,
        remoteOnly: d.remoteOnly.map(label), remoteModified: d.modified.map(label), remoteRemoved: d.removed.map(label),
        basis: d.basis, lastPushedAt: d.lastPushedAt,
        remoteCopy: path.relative(cfg.root, saved).split(path.sep).join('/'),
        message: `push すると GAS 側の変更が消えます。${parts.join('。')}`,
        next: `GAS側の内容を ${path.relative(cfg.root, saved).split(path.sep).join('/')} に保存しました。手元の src と比べ、必要な変更を手元に取り込んでから再度 push してください（取り込めば自動で通ります）。GAS側の変更を捨てる場合は、人が確認したうえで gasverify push --force を実行してください`,
      });
    }
  }

  const res = await api.pushFiles(google(), client, cfg, list);
  if (res.http === 200) {
    fs.mkdirSync(cfg.stateDir, { recursive: true });
    fs.writeFileSync(path.join(cfg.stateDir, 'funcmap.json'), JSON.stringify(files.buildFuncMap(list), null, 2));
    drift.saveSnapshot(cfg, list, account);
    return finalize(cfg, {
      command: 'push', exitCode: 0, account, warnings,
      pushed: list.map((f) => `${f.name}.${f.type === 'JSON' ? 'json' : f.type === 'HTML' ? 'html' : 'gs'}`),
      summary: `${list.length} ファイルを反映しました（ランタイム含む）`,
    });
  }
  if (res.http === 400) {
    const msg = (res.data && res.data.error && res.data.error.message) || '構文エラー';
    return finalize(cfg, { command: 'push', exitCode: 1, account, warnings, reason: 'syntax_error', message: `GASが反映を拒否しました: ${msg}`, next: 'メッセージにある箇所の構文エラーを直してください', raw: res.data });
  }
  const c = classify(Object.assign({}, res, { fn: '' }));
  return finalize(cfg, Object.assign({ command: 'push', account, warnings }, c, { raw: res.data }));
}

// ---------------------------------------------------------------- pull
/** GAS 側の内容を .gasverify/remote/<日時>/ に取ってきて、手元との違いを一覧にする（手元の src は上書きしない） */
async function pull(opts) {
  const cfg = context(opts);
  assertAllowed(cfg);
  const { files: list } = files.collectPushFiles(cfg);
  const { client, account } = clientFor(cfg);
  const cur = await api.getContent(google(), client, cfg);
  if (cur.http !== 200) {
    const c = classify(Object.assign({}, cur, { fn: '' }));
    return finalize(cfg, Object.assign({ command: 'pull', account }, c, { raw: cur.data }));
  }
  const remoteFiles = (cur.data && cur.data.files) || [];
  const saved = drift.saveRemoteCopy(cfg, remoteFiles, runId());
  const localMap = new Map(list.map((f) => [`${f.name}.${f.type}`, f]));
  const remoteMap = new Map(remoteFiles.map((f) => [`${f.name}.${f.type}`, f]));
  const differs = [];
  for (const [k, rf] of remoteMap) {
    const lf = localMap.get(k);
    if (!lf) differs.push({ file: k, state: 'remote_only' });
    else if (drift.fingerprint(lf) !== drift.fingerprint(rf)) differs.push({ file: k, state: 'different', local: path.relative(cfg.root, lf.local).split(path.sep).join('/') });
  }
  for (const k of localMap.keys()) if (!remoteMap.has(k)) differs.push({ file: k, state: 'local_only' });
  const rel = path.relative(cfg.root, saved).split(path.sep).join('/');
  return finalize(cfg, {
    command: 'pull', exitCode: 0, account, remoteCopy: rel, differs,
    summary: differs.length ? `GAS側の内容を ${rel} に保存しました。手元と違うファイル ${differs.length} 件` : `GAS側と手元は同じ内容です（${rel} に保存）`,
    next: differs.length ? `${rel} と手元のファイルを比べ、残すべき変更を手元に取り込んでください` : undefined,
  });
}

// ---------------------------------------------------------------- run
async function run(opts) {
  const cfg = context(opts);
  assertAllowed(cfg);
  const fn = opts.fn;
  if (!fn) throw new GvError(1, 'function_required', '実行する関数名がありません', 'gasverify run <関数名> [--args \'[...]\'] の形で指定してください');
  let args = [];
  if (opts.args) {
    try {
      args = JSON.parse(opts.args);
      if (!Array.isArray(args)) args = [args];
    } catch (e) {
      throw new GvError(1, 'args_invalid', `--args がJSONとして読めません: ${e.message}`, '--args \'["文字列", 123]\' のようにJSON配列で指定してください');
    }
  }
  const { files: list } = files.collectPushFiles(cfg);
  const funcMap = files.buildFuncMap(list);
  const { client, account } = clientFor(cfg);
  const live = !!opts.live;
  const r = live
    ? await api.runFunction(google(), client, cfg, { invoke: fn, fn, params: args, funcMap })
    : await api.runFunction(google(), client, cfg, { invoke: INVOKE, fn, params: [fn, { testMode: true, args }], funcMap });
  const diag = { command: 'run', function: fn, testMode: !live, account, exitCode: r.exitCode, reason: r.reason, message: r.message, next: r.next, ms: r.ms };
  if (r.exitCode === 0) {
    const res = live ? r.result : (r.result || {});
    diag.result = live ? res : res.returned;
    if (!live) {
      diag.sideEffects = res.sideEffects || [];
      diag.logs = res.logs || [];
    }
    diag.summary = `${fn} を実行しました（${r.ms}ms${live ? '、本番モード' : '、テストモード'}）`;
  } else {
    diag.error = r.error;
    diag.location = locate(r.stack, funcMap, cfg.root);
    diag.stack = r.stack;
    diag.requiredPermissions = r.requiredPermissions;
  }
  return finalize(cfg, diag);
}

// ---------------------------------------------------------------- test
function loadFailCounts(cfg) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cfg.stateDir, 'failcount.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveFailCounts(cfg, counts) {
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.stateDir, 'failcount.json'), JSON.stringify(counts, null, 2));
}

async function test(opts) {
  const cfg = context(opts);
  assertAllowed(cfg);
  const { files: list } = files.collectPushFiles(cfg);
  const funcMap = files.buildFuncMap(list);
  const tests = files.findTests(cfg, list, opts.filter);
  const warnings = files.staticChecks(cfg, list);
  if (!tests.length) {
    return finalize(cfg, { command: 'test', exitCode: 1, reason: 'no_tests', warnings, message: `テスト関数がありません（${path.relative(cfg.root, cfg.testDir)}/ の test_ で始まる関数）`, next: 'テスト規約に沿って test_ 関数を書いてください' });
  }
  const { client, account } = clientFor(cfg);
  const call = (name) => api.runFunction(google(), client, cfg, { invoke: INVOKE, fn: name, params: [name, { testMode: true }], funcMap });

  const passed = [];
  const failed = [];
  const allSideEffects = [];
  const codes = [];
  let stopped = null;

  const runHook = async (name) => {
    if (!funcMap[name]) return true;
    const r = await call(name);
    if (r.exitCode !== 0) {
      codes.push(r.exitCode);
      failed.push({ name, reason: r.reason, message: `${name} が失敗: ${r.message}`, next: r.next, error: r.error, location: locate(r.stack, funcMap, cfg.root) });
      return false;
    }
    return true;
  };

  if (await runHook('gv_setup')) {
    for (const name of tests) {
      const r = await call(name);
      if (r.exitCode === 2 || r.exitCode === 3) {
        codes.push(r.exitCode);
        stopped = { name, exitCode: r.exitCode, reason: r.reason, message: r.message, next: r.next, error: r.error };
        break;
      }
      if (r.exitCode === 1) {
        codes.push(1);
        failed.push({ name, reason: r.reason, message: r.message, next: r.next, error: r.error, stack: r.stack, location: locate(r.stack, funcMap, cfg.root), requiredPermissions: r.requiredPermissions });
        continue;
      }
      const res = r.result || {};
      for (const s of res.sideEffects || []) allSideEffects.push(Object.assign({ test: name }, s));
      if (res.ok) {
        passed.push({ name, ms: r.ms, assertions: (res.assertions || []).length });
        codes.push(0);
      } else {
        codes.push(1);
        const fa = (res.assertions || []).filter((a) => !a.pass);
        failed.push({
          name, reason: res.reason || 'assertion_failed',
          message: res.message || (fa.length ? `${fa.length} 件のアサーションが不一致` : 'テストが ok=false を返しました'),
          failedAssertions: fa, logs: res.logs, location: funcMap[name] ? { file: path.relative(cfg.root, funcMap[name].file).split(path.sep).join('/'), line: funcMap[name].line, function: name } : null,
          next: '期待値ではなく実装を直してください（期待値を変える場合は理由を人に報告して承認を得ること）',
        });
      }
    }
    if (!stopped) await runHook('gv_teardown');
  }

  // 同じテストの連続失敗回数（設計書10章：5回で停止して人に判断を仰ぐ）
  const counts = loadFailCounts(cfg);
  for (const p of passed) delete counts[p.name];
  const stuck = [];
  for (const f of failed) {
    counts[f.name] = (counts[f.name] || 0) + 1;
    f.consecutiveFailures = counts[f.name];
    if (counts[f.name] >= cfg.sameTestFailLimit) stuck.push(f.name);
  }
  saveFailCounts(cfg, counts);

  const exitCode = worst(codes);
  const total = tests.length;
  let next;
  if (stopped) next = stopped.next;
  else if (stuck.length) next = `${stuck.join(', ')} が ${cfg.sameTestFailLimit} 回連続で失敗しています。修正を止めて、仕様の解釈を人に確認してください`;
  else if (failed.length) next = failed[0].next;
  return finalize(cfg, {
    command: opts.command || 'test', exitCode, account,
    summary: stopped ? `${stopped.name} の実行で中断（${stopped.message}）` : `${total} 件中 ${passed.length} 件成功、${failed.length} 件失敗`,
    passed, failedTests: failed, stopped, stopLoop: stuck.length > 0, stuckTests: stuck,
    sideEffects: allSideEffects, warnings, next,
    message: stopped ? stopped.message : undefined,
  });
}

// ---------------------------------------------------------------- verify
async function verify(opts) {
  const p = await push(Object.assign({}, opts));
  if (p.exitCode !== 0) {
    p.command = 'verify';
    p.summary = `push の段階で停止: ${p.message || ''}`;
    return p;
  }
  const t = await test(Object.assign({}, opts, { command: 'verify' }));
  t.warnings = p.warnings && p.warnings.length ? p.warnings : t.warnings;
  t.pushed = p.pushed;
  return t;
}

module.exports = { init, login, logout, doctor, push, pull, run, test, verify };
