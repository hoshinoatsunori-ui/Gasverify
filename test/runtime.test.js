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
