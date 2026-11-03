'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const files = require('../lib/files');

function project(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-files-'));
  for (const [rel, content] of Object.entries(layout)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return { root, srcDir: path.join(root, 'src'), testDir: path.join(root, 'test') };
}

const MANIFEST = JSON.stringify({ timeZone: 'Asia/Tokyo', oauthScopes: [] });

test('push対象の収集・関数対応表・テスト発見', () => {
  const cfg = project({
    'src/appsscript.json': MANIFEST,
    'src/Main.js': 'function a() {}\n\nfunction b() {\n  return 1;\n}\n',
    'src/ui/Page.html': '<p>x</p>',
    'test/test_Main.js': 'function test_a() {}\nfunction helper() {}\nfunction test_b() {}\n',
  });
  const { files: list } = files.collectPushFiles(cfg);
  const names = list.map((f) => `${f.name}:${f.type}`);
  assert.deepStrictEqual(names, ['appsscript:JSON', 'Main:SERVER_JS', 'ui/Page:HTML', 'test_Main:SERVER_JS', 'gasverify_runtime:SERVER_JS']);
  const map = files.buildFuncMap(list);
  assert.strictEqual(map.b.line, 3);
  assert.ok(map.gasverify_invoke);
  assert.deepStrictEqual(files.findTests(cfg, list), ['test_a', 'test_b']);
  assert.deepStrictEqual(files.findTests(cfg, list, '_b'), ['test_b']);
});

test('同名ファイルの衝突は準備不足で止める', () => {
  const cfg = project({ 'src/appsscript.json': MANIFEST, 'src/A.js': '', 'test/A.gs': '' });
  assert.throws(() => files.collectPushFiles(cfg), (e) => e.exitCode === 2 && e.reason === 'duplicate_file');
});

test('マニフェストが無ければ準備不足', () => {
  const cfg = project({ 'src/A.js': '' });
  assert.throws(() => files.collectPushFiles(cfg), (e) => e.exitCode === 2 && e.reason === 'manifest_missing');
});

test('静的検査：副作用APIの直接呼び出しと末尾_のテスト関数を警告', () => {
  const cfg = project({
    'src/appsscript.json': MANIFEST,
    'src/Main.js': 'function a() {\n  MailApp.sendEmail("x", "s", "b");\n  UrlFetchApp.fetch("u"); // gasverify-allow-direct\n}\n',
    'test/t.js': 'function test_x_() {}\n',
  });
  cfg.root = path.dirname(cfg.srcDir);
  const { files: list } = files.collectPushFiles(cfg);
  const w = files.staticChecks(cfg, list);
  assert.deepStrictEqual(w.map((x) => `${x.rule}@${x.where}`), ['direct_side_effect@src/Main.js:2', 'private_test@test/t.js:1']);
});
