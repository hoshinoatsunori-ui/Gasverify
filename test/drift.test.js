'use strict';
/** push 前の差分確認（lib/drift.js） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const drift = require('../lib/drift');

const cfg = () => ({ scriptId: 'S1', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gv-drift-')) });
const js = (name, source) => ({ name, type: 'SERVER_JS', source });
const manifest = (obj) => ({ name: 'appsscript', type: 'JSON', source: JSON.stringify(obj) });

test('正規化：改行コード・行末の空白・末尾の改行、JSONのキー順は違いとみなさない', () => {
  assert.strictEqual(drift.fingerprint(js('a', 'x\r\ny  \n\n')), drift.fingerprint(js('a', 'x\ny')));
  assert.strictEqual(drift.fingerprint(manifest({ a: 1, b: [1, { c: 2, d: 3 }] })), drift.fingerprint({ type: 'JSON', source: '{\n "b": [1, {"d":3,"c":2}],\n "a": 1\n}' }));
  assert.notStrictEqual(drift.fingerprint(js('a', 'x')), drift.fingerprint(js('a', 'y')));
});

test('初回（記録なし）：同じなら通し、手元と違う既存ファイルとGAS側だけのファイルは止める', () => {
  const c = cfg();
  assert.strictEqual(drift.checkDrift(c, [js('A', '1')], [js('A', '1')]).ok, true);
  const d = drift.checkDrift(c, [js('A', '1')], [js('A', '2'), js('Old', '')]);
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.basis, 'local');
  assert.deepStrictEqual(d.modified, ['A.SERVER_JS']);
  assert.deepStrictEqual(d.remoteOnly, ['Old.SERVER_JS']);
});

test('記録あり：手元が進んでいても GAS 側が前回 push のままなら通す', () => {
  const c = cfg();
  drift.saveSnapshot(c, [js('A', 'v1')], 'me@example.com');
  assert.strictEqual(drift.checkDrift(c, [js('A', 'v2')], [js('A', 'v1')]).ok, true);
});

test('記録あり：前回 push したファイルを手元で消しただけなら通す。GAS 側で変わっていれば止める', () => {
  const c = cfg();
  drift.saveSnapshot(c, [js('A', 'v1'), js('Tmp', 't')], 'me@example.com');
  assert.strictEqual(drift.checkDrift(c, [js('A', 'v1')], [js('A', 'v1'), js('Tmp', 't')]).ok, true);
  const d = drift.checkDrift(c, [js('A', 'v1')], [js('A', 'v1'), js('Tmp', 'edited')]);
  assert.strictEqual(d.ok, false);
  assert.deepStrictEqual(d.remoteOnly, ['Tmp.SERVER_JS']);
  // 前回 push に無く GAS 側で足されたファイルは止める
  assert.deepStrictEqual(drift.checkDrift(c, [js('A', 'v1')], [js('A', 'v1'), js('New', 'n')]).remoteOnly, ['New.SERVER_JS']);
});

test('記録あり：GAS 側で変更・削除されたら止める。手元に取り込めば通す', () => {
  const c = cfg();
  drift.saveSnapshot(c, [js('A', 'v1'), js('B', 'b')], 'me@example.com');
  const d = drift.checkDrift(c, [js('A', 'v2'), js('B', 'b')], [js('A', 'edited')]);
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.basis, 'last_push');
  assert.deepStrictEqual(d.modified, ['A.SERVER_JS']);
  assert.deepStrictEqual(d.removed, ['B.SERVER_JS']);
  // 取り込み後（A を GAS 側と同じに、B の削除も受け入れ）
  assert.strictEqual(drift.checkDrift(c, [js('A', 'edited')], [js('A', 'edited')]).ok, true);
});

test('GAS 側の内容は src ではなく .gasverify/remote/ に保存する', () => {
  const c = cfg();
  const dir = drift.saveRemoteCopy(c, [js('sub/A', 'a'), manifest({ x: 1 }), { name: 'Page', type: 'HTML', source: '<p>' }], 'stamp');
  assert.ok(dir.startsWith(path.join(c.stateDir, 'remote')));
  for (const f of ['sub/A.js', 'appsscript.json', 'Page.html']) assert.ok(fs.existsSync(path.join(dir, f)), f);
});
