'use strict';
/** GAS側ランタイムを vm 上で動かして確認する */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(extra) {
  const sent = [];
  const ctx = vm.createContext({
    MailApp: { sendEmail: (...a) => sent.push(a) },
    UrlFetchApp: { fetch: () => { throw new Error('real fetch'); } },
    ScriptApp: { newTrigger: () => { throw new Error('real trigger'); } },
    Session: { getActiveUser: () => ({ getEmail: () => 'me@example.com' }) },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'runtime', 'gasverify_runtime.js'), 'utf8'), ctx);
  vm.runInContext(extra, ctx);
  return { ctx, sent };
}

test('アサーションの成否と戻り値の形', () => {
  const { ctx } = load(`
    function test_ok() { GV.assertEqual('a', 1, 1); GV.assertTrue('b', true); }
    function test_ng() { GV.assertEqual('a', { x: 1 }, { x: 2 }); }
  `);
  const ok = vm.runInContext('gasverify_invoke("test_ok", { testMode: true })', ctx);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.assertions.length, 2);
  const ng = vm.runInContext('gasverify_invoke("test_ng", { testMode: true })', ctx);
  assert.strictEqual(ng.ok, false);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ng.assertions[0].actual)), { x: 2 });
});

test('テストモードではメール・HTTP・トリガーを実行せず記録する', () => {
  const { ctx, sent } = load(`
    function f() {
      GV.sendMail('a@example.com', 's', 'body');
      GV.stubFetch('api.example.com', { v: 1 });
      var t = GV.fetch('https://api.example.com/x', { method: 'post' }).getContentText();
      GV.createTrigger('job', { everyHours: 1 });
      return t;
    }
  `);
  const r = vm.runInContext('gasverify_invoke("f", { testMode: true })', ctx);
  assert.strictEqual(sent.length, 0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.sideEffects.map((s) => s.type))), ['mail', 'fetch', 'trigger']);
  assert.strictEqual(r.returned, '{"v":1}');
});

test('テストモードでなければ実際に送る', () => {
  const { ctx, sent } = load(`function f() { GV.sendMail('a@example.com', 's', 'b'); }`);
  vm.runInContext('gasverify_invoke("f", { testMode: false })', ctx);
  assert.strictEqual(sent.length, 1);
});

test('assertThrows と、戻り値 ok=false の扱い', () => {
  const { ctx } = load(`
    function t1() { GV.assertThrows('x', function () { throw new Error('金額が見つかりません'); }, '金額'); }
    function t2() { return { ok: false, message: '理由' }; }
  `);
  assert.strictEqual(vm.runInContext('gasverify_invoke("t1", {})', ctx).ok, true);
  const r2 = vm.runInContext('gasverify_invoke("t2", {})', ctx);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.message, '理由');
});

test('存在しない関数は GV_FUNCTION_NOT_FOUND を投げる', () => {
  const { ctx } = load('');
  assert.throws(() => vm.runInContext('gasverify_invoke("nope", {})', ctx), /GV_FUNCTION_NOT_FOUND: nope/);
});

test('引数を渡せる', () => {
  const { ctx } = load('function add(a, b) { return a + b; }');
  assert.strictEqual(vm.runInContext('gasverify_invoke("add", { args: [2, 3] })', ctx).returned, 5);
});

test('F11 console.* と GV.log を記録し、元の console にも出す', () => {
  const printed = [];
  const { ctx } = load(`
    // GAS と同じく console.log は writable=false・configurable=true（2026-11-07実測。代入は無視される）
    var console = { info: function () {}, warn: function () {}, error: function () {} };
    Object.defineProperty(console, 'log', { value: function (m) { __printed.push(m); }, writable: false, configurable: true });
    function test_ng() { console.log('件名', { a: 1 }); console.warn('注意'); GV.log('gv'); GV.assertEqual('x', 1, 2); }
  `.replace('__printed', 'printed'));
  ctx.printed = printed;
  const r = vm.runInContext('gasverify_invoke("test_ng", { testMode: true })', ctx);
  assert.deepStrictEqual(Array.from(r.logs), ['件名 {"a":1}', '[warn] 注意', 'gv']);
  assert.deepStrictEqual(printed, ['件名']);
  // 実行後は元の console に戻る
  vm.runInContext('console.log("after")', ctx);
  assert.deepStrictEqual(printed, ['件名', 'after']);
});

test('F11 例外で終わったらメッセージ末尾に GV_LOGS を付けて同じ例外を投げ直す', () => {
  const { ctx } = load(`
    var console = { log: function () {}, info: function () {}, warn: function () {}, error: function () {} };
    function boom() { console.log('入力', 'abc'); throw new TypeError('x is undefined'); }
    function quiet() { throw new Error('ログなし'); }
  `);
  let e = null;
  try { vm.runInContext('gasverify_invoke("boom", { testMode: true })', ctx); } catch (err) { e = err; }
  assert.strictEqual(e.name, 'TypeError');
  assert.strictEqual(e.message, 'x is undefined\nGV_LOGS:["入力 abc"]');
  e = null;
  try { vm.runInContext('gasverify_invoke("quiet", { testMode: true })', ctx); } catch (err) { e = err; }
  assert.strictEqual(e.message, 'ログなし');
});

test('F11 ログは最大50件・1件500文字に切る', () => {
  const { ctx } = load(`
    function test_many() { for (var i = 0; i < 60; i++) GV.log(i === 0 ? new Array(600).join('a') : 'l' + i); return false; }
  `);
  const r = vm.runInContext('gasverify_invoke("test_many", { testMode: true })', ctx);
  assert.strictEqual(r.logs.length, 51);
  assert.strictEqual(r.logs[0].length, 501);
  assert.strictEqual(r.logs[50], '…(ほか 10 件省略)');
});

test('F11 実行後は console.log の定義（writable=false）も元に戻る', () => {
  const { ctx } = load(`
    var console = {};
    Object.defineProperty(console, 'log', { value: function () {}, writable: false, configurable: true });
    function test_x() { console.log('a'); return false; }
  `);
  vm.runInContext('gasverify_invoke("test_x", { testMode: true })', ctx);
  const d = vm.runInContext('Object.getOwnPropertyDescriptor(console, "log")', ctx);
  assert.strictEqual(d.writable, false);
  assert.strictEqual(vm.runInContext('Object.getOwnPropertyDescriptor(console, "info")', ctx), undefined);
});
