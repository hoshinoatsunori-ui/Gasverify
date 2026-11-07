'use strict';
/**
 * CLIを子プロセスで動かし、模擬APIサーバーを相手に通しで確認する
 * サンプル（example/）の「全角￥未対応」の不具合を検出 → 修正 → 成功、までの流れを再現する
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { startMockServer } = require('./mock-gas-server');

const BIN = path.join(__dirname, '..', 'bin', 'gasverify.js');
const SCRIPT_ID = '1abcDEFghiJKLmnoPQRstuVWXyz0123456789abcdefGHIJKLmnopqrs';

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-proj-'));
  // example で実際に verify した状態（.gasverify の失敗回数など）は持ち込まない
  fs.cpSync(path.join(__dirname, '..', 'example'), proj, { recursive: true, filter: (src) => path.basename(src) !== '.gasverify' });
  const cfgPath = path.join(proj, 'gasverify.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.profiles.personal = { scriptId: SCRIPT_ID, allowedScriptIds: [SCRIPT_ID] };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const pdir = path.join(home, 'personal');
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, 'credentials.json'), JSON.stringify({ installed: { client_id: 'id', client_secret: 'sec' } }));
  const scopes = ['https://www.googleapis.com/auth/script.projects', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/script.send_mail'];
  fs.writeFileSync(path.join(pdir, 'token.json'), JSON.stringify({ email: 'tester@example.com', credentials: { access_token: 'tok', refresh_token: 'r', expiry_date: Date.now() + 3600e3, scope: scopes.join(' ') } }));
  return { home, proj };
}

// 模擬サーバーが同じプロセスで動くため、子プロセスは非同期で待つ（同期だとサーバーが応答できない）
function cli(env, cwd, ...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd, env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: 60000 }, (err, stdout, stderr) => {
      let diag = null;
      try {
        diag = JSON.parse(stdout);
      } catch (e) {
        diag = { parseError: stdout };
      }
      resolve({ code: err ? err.code : 0, diag, stderr });
    });
  });
}

test('verify の通し：検出 → 修正 → 成功', async (t) => {
  const mock = await startMockServer({ scriptId: SCRIPT_ID, initialFiles: [] });
  t.after(() => mock.close());
  const { home, proj } = setup();
  const env = { GASVERIFY_HOME: home, GASVERIFY_ROOT_URL: mock.url, GASVERIFY_RETRY_WAIT_MS: '10' };

  // doctor：ランタイム未反映を検出 → --fix で push して解消
  let r = await cli(env, proj, 'doctor');
  assert.strictEqual(r.code, 2, r.stderr);
  assert.ok(r.diag.checks.some((c) => !c.ok && /ランタイム/.test(c.detail)));
  r = await cli(env, proj, 'doctor', '--fix');
  assert.strictEqual(r.code, 0, r.stderr);

  // verify：全角￥のテストだけ失敗し、終了コード1
  r = await cli(env, proj, 'verify');
  assert.strictEqual(r.code, 1, r.stderr);
  assert.match(r.diag.summary, /4 件中 3 件成功、1 件失敗/);
  const f = r.diag.failedTests[0];
  assert.strictEqual(f.name, 'test_parseAmount_fullwidthYen');
  // 期待値ではなく実装（parseAmount）の例外箇所が指される
  assert.deepStrictEqual([f.location.file, f.location.line], ['src/Receipt.js', 11]);
  assert.strictEqual(f.error.type, 'Error');
  assert.strictEqual(f.consecutiveFailures, 1);
  // テストモードなのでメールは送られず、記録だけ残る
  assert.strictEqual(mock.state.sentMail.length, 0);
  assert.deepStrictEqual(r.diag.sideEffects.map((s) => `${s.test}:${s.type}`), ['test_notifyTotal_sendsOneMailInTestMode:mail']);

  // 修正して再実行 → 0
  const file = path.join(proj, 'src', 'Receipt.js');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('/¥\\s*([\\d,]+)/', '/[¥￥]\\s*([\\d,]+)/'));
  r = await cli(env, proj, 'verify');
  assert.strictEqual(r.code, 0, r.stderr + JSON.stringify(r.diag));
  assert.strictEqual(r.diag.passed.length, 4);
  assert.ok(fs.readdirSync(path.join(proj, '.gasverify', 'runs')).length >= 4);
});

test('run：テストモードで戻り値と副作用を返す。--args も渡る', async (t) => {
  const mock = await startMockServer({ scriptId: SCRIPT_ID });
  t.after(() => mock.close());
  const { home, proj } = setup();
  const env = { GASVERIFY_HOME: home, GASVERIFY_ROOT_URL: mock.url };
  await cli(env, proj, 'push');
  const r = await cli(env, proj, 'run', 'notifyTotal', '--args', '[["¥10","¥20"],"me@example.com"]');
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.diag.result, 30);
  assert.strictEqual(r.diag.sideEffects[0].dryRun, true);
  assert.strictEqual(mock.state.sentMail.length, 0);
});

test('doctor --fix の自動pushが差分確認で止まったら、その案内を next にする', async (t) => {
  // clasp create 直後の想定：GAS側には初期マニフェストだけがある
  const mock = await startMockServer({ scriptId: SCRIPT_ID, initialFiles: [{ name: 'appsscript', type: 'JSON', source: '{"timeZone":"America/New_York","runtimeVersion":"V8"}' }] });
  t.after(() => mock.close());
  const { home, proj } = setup();
  const env = { GASVERIFY_HOME: home, GASVERIFY_ROOT_URL: mock.url };

  const r = await cli(env, proj, 'doctor', '--fix');
  assert.strictEqual(r.code, 2, r.stderr);
  assert.strictEqual(mock.state.pushes, 0);
  assert.match(r.diag.summary, /1 件の準備不足/);
  assert.match(r.diag.next, /push --force/);
});

test('安全策：許可リスト外・リモートだけのファイル・構文エラー', async (t) => {
  const mock = await startMockServer({ scriptId: SCRIPT_ID, initialFiles: [{ name: 'Old', type: 'SERVER_JS', source: 'function old() {}' }] });
  t.after(() => mock.close());
  const { home, proj } = setup();
  const env = { GASVERIFY_HOME: home, GASVERIFY_ROOT_URL: mock.url };

  // リモートにだけあるファイルは消さずに止める
  let r = await cli(env, proj, 'push');
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.diag.reason, 'remote_changed');
  assert.deepStrictEqual(r.diag.remoteOnly, ['Old.gs']);
  assert.strictEqual(mock.state.pushes, 0);
  r = await cli(env, proj, 'push', '--force');
  assert.strictEqual(r.code, 0, r.stderr);

  // 構文エラーは 1
  fs.writeFileSync(path.join(proj, 'src', 'Broken.js'), 'function x( {');
  r = await cli(env, proj, 'push');
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.diag.reason, 'syntax_error');
  fs.unlinkSync(path.join(proj, 'src', 'Broken.js'));

  // 許可リスト外は API を呼ぶ前に 2
  const cfgPath = path.join(proj, 'gasverify.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.profiles.personal.allowedScriptIds = ['other'];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const before = mock.state.runs.length;
  r = await cli(env, proj, 'verify');
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.diag.reason, 'script_not_allowed');
  assert.strictEqual(mock.state.runs.length, before);
});

test('基盤障害の再試行・API無効・未ログイン', async (t) => {
  const mock = await startMockServer({ scriptId: SCRIPT_ID, mode: {} });
  t.after(() => mock.close());
  const { home, proj } = setup();
  const env = { GASVERIFY_HOME: home, GASVERIFY_ROOT_URL: mock.url, GASVERIFY_RETRY_WAIT_MS: '10' };
  await cli(env, proj, 'push');

  mock.mode.flaky = 2; // 2回503のあと成功
  let r = await cli(env, proj, 'run', 'parseAmount', '--args', '["¥5"]');
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.diag.result, 5);

  mock.mode.apiDisabled = true;
  r = await cli(env, proj, 'test');
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.diag.stopped.reason, 'api_disabled');
  mock.mode.apiDisabled = false;

  fs.unlinkSync(path.join(home, 'personal', 'token.json'));
  r = await cli(env, proj, 'test');
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.diag.reason, 'not_logged_in');
});

test('同じテストが5回連続で失敗すると stopLoop', async (t) => {
  const mock = await startMockServer({ scriptId: SCRIPT_ID });
  t.after(() => mock.close());
  const { home, proj } = setup();
  const env = { GASVERIFY_HOME: home, GASVERIFY_ROOT_URL: mock.url };
  await cli(env, proj, 'push');
  let r;
  for (let i = 0; i < 5; i++) r = await cli(env, proj, 'test', '--filter', 'fullwidth');
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.diag.stopLoop, true);
  assert.deepStrictEqual(r.diag.stuckTests, ['test_parseAmount_fullwidthYen']);
});

test('push前の差分確認：エディタでの変更を消さずに止め、取り込めば通る', async (t) => {
  const mock = await startMockServer({ scriptId: SCRIPT_ID });
  t.after(() => mock.close());
  const { home, proj } = setup();
  const env = { GASVERIFY_HOME: home, GASVERIFY_ROOT_URL: mock.url };

  // 初回 push（GAS側は空）→ 記録が残る
  let r = await cli(env, proj, 'push');
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(proj, '.gasverify', 'last-push', `${SCRIPT_ID}.json`)));

  // 改行コードだけの違いは変更とみなさない
  const receipt = mock.state.files.find((f) => f.name === 'Receipt');
  receipt.source = receipt.source.replace(/\n/g, '\r\n') + '\n\n';
  r = await cli(env, proj, 'push');
  assert.strictEqual(r.code, 0, r.stderr);

  // GASエディタで1行直された想定
  const edited = mock.state.files.find((f) => f.name === 'Receipt');
  edited.source = edited.source.replace('/¥\\s*([\\d,]+)/', '/[¥￥]\\s*([\\d,]+)/');
  const pushesBefore = mock.state.pushes;
  r = await cli(env, proj, 'verify');
  assert.strictEqual(r.code, 2, r.stderr);
  assert.strictEqual(r.diag.reason, 'remote_changed');
  assert.deepStrictEqual(r.diag.remoteModified, ['Receipt.gs']);
  assert.strictEqual(r.diag.basis, 'last_push');
  assert.strictEqual(mock.state.pushes, pushesBefore); // 上書きしていない
  const saved = path.join(proj, r.diag.remoteCopy, 'Receipt.js');
  assert.match(fs.readFileSync(saved, 'utf8'), /\[¥￥\]/);

  // pull：手元の src は変えずに違いを一覧
  r = await cli(env, proj, 'pull');
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(r.diag.differs.map((x) => `${x.file}:${x.state}`), ['Receipt.SERVER_JS:different']);
  assert.doesNotMatch(fs.readFileSync(path.join(proj, 'src', 'Receipt.js'), 'utf8'), /\[¥￥\]/);

  // GAS側の変更を手元に取り込めば、そのまま push できる
  fs.writeFileSync(path.join(proj, 'src', 'Receipt.js'), fs.readFileSync(saved, 'utf8'));
  r = await cli(env, proj, 'verify');
  assert.strictEqual(r.code, 0, r.stderr + JSON.stringify(r.diag));
});

test('push前の差分確認：初回は手元と違う既存ファイルで止まる。--force で上書き', async (t) => {
  const mock = await startMockServer({ scriptId: SCRIPT_ID, initialFiles: [{ name: 'Receipt', type: 'SERVER_JS', source: 'function parseAmount() { return 0; }' }] });
  t.after(() => mock.close());
  const { home, proj } = setup();
  const env = { GASVERIFY_HOME: home, GASVERIFY_ROOT_URL: mock.url };
  let r = await cli(env, proj, 'push');
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.diag.basis, 'local');
  assert.deepStrictEqual(r.diag.remoteModified, ['Receipt.gs']);
  r = await cli(env, proj, 'push', '--force');
  assert.strictEqual(r.code, 0, r.stderr);
  r = await cli(env, proj, 'push');
  assert.strictEqual(r.code, 0, r.stderr);
});

test('init：設定とClaude Code連携ファイルを作る', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-init-'));
  const r = await cli({}, dir, 'init', '--script', SCRIPT_ID);
  assert.strictEqual(r.code, 0, r.stderr);
  for (const f of ['gasverify.config.json', 'src/appsscript.json', 'CLAUDE.md', '.claude/commands/gas-verify.md', '.claude/settings.json', '.gitignore']) {
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'gasverify.config.json'), 'utf8'));
  assert.deepStrictEqual(cfg.profiles.personal.allowedScriptIds, [SCRIPT_ID]);
});
