'use strict';
/** 判定表（設計書9.3）を 2026-11-03 の実測応答で確認する */
const test = require('node:test');
const assert = require('node:assert');
const { classify, jsErrorType, extractRequiredPermissions } = require('../lib/classify');

const execErr = (errorType, msg, stack = []) => ({
  http: 200,
  data: { done: true, error: { code: 3, message: msg, details: [{ errorType, errorMessage: msg, scriptStackTraceElements: stack }] } },
});

test('C01 TypeError は 1、例外種別はメッセージ先頭から取る', () => {
  const c = classify(Object.assign(execErr('USER_ERROR', "TypeError: Cannot read properties of null (reading 'foo')", [{ function: 'case_typeError', lineNumber: 15 }]), { fn: 'case_typeError' }));
  assert.strictEqual(c.exitCode, 1);
  assert.strictEqual(c.error.type, 'TypeError');
  assert.deepStrictEqual(c.stack, [{ function: 'case_typeError', line: 15 }]);
});

test('C04 文字列の throw も 1', () => {
  assert.strictEqual(classify(execErr('USER_ERROR', '文字列をthrow')).exitCode, 1);
});

test('C05 GAS内の権限不足は 2、必要スコープを抜き出す', () => {
  const msg = 'Exception: Specified permissions are not sufficient to perform the action. Required permissions: (https://mail.google.com/ || https://www.googleapis.com/auth/gmail.readonly)';
  const c = classify(execErr('USER_ERROR', msg));
  assert.strictEqual(c.exitCode, 2);
  assert.strictEqual(c.reason, 'script_scope_missing');
  assert.deepStrictEqual(c.requiredPermissions, ['https://mail.google.com/', 'https://www.googleapis.com/auth/gmail.readonly']);
});

test('H01 関数なし：ローカルにあれば push 漏れ(2)、なければ 1', () => {
  const r = execErr('FUNCTION_NOT_FOUND', 'Script function not found: foo');
  assert.strictEqual(classify(Object.assign({}, r, { fn: 'foo', funcMap: { foo: { file: 'a', line: 1 } } })).exitCode, 2);
  assert.strictEqual(classify(Object.assign({}, r, { fn: 'foo', funcMap: {} })).exitCode, 1);
});

test('ランタイム未反映（gasverify_invoke が無い）は 2', () => {
  const c = classify(Object.assign(execErr('FUNCTION_NOT_FOUND', 'Script function not found: gasverify_invoke'), { fn: 'gasverify_invoke' }));
  assert.strictEqual(c.exitCode, 2);
  assert.strictEqual(c.reason, 'runtime_not_pushed');
});

test('H07 コードが1つもないプロジェクト（2026-11-07実測）は未push(2)', () => {
  const c = classify(Object.assign(execErr('USER_ERROR', "We're sorry, a server error occurred while reading from storage. Error code NOT_FOUND."), { fn: 'gasverify_ping' }));
  assert.strictEqual(c.exitCode, 2);
  assert.strictEqual(c.reason, 'runtime_not_pushed');
});

test('code=10（SCRIPT_TIMEOUT）は 1', () => {
  const r = { http: 200, data: { error: { code: 10, message: 'Exceeded maximum execution time', details: [{ errorType: 'SCRIPT_TIMEOUT', errorMessage: 'Exceeded maximum execution time' }] } } };
  assert.strictEqual(classify(r).reason, 'timeout');
});

test('C06 Blob の戻り値（[native code]）は 1', () => {
  const r = { http: 200, data: { response: { result: { getName: 'function () { [native code] }' } } } };
  assert.strictEqual(classify(r).exitCode, 1);
});

test('C07/C00 正常は 0', () => {
  assert.strictEqual(classify({ http: 200, data: { response: { result: '1970-01-01T00:00:00Z' } } }).exitCode, 0);
});

test('C10 末尾 _ の関数の 403 は 1、それ以外の 403 は 2', () => {
  const r = { http: 403, data: { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED', errors: [{ reason: 'forbidden' }] } } };
  assert.strictEqual(classify(Object.assign({}, r, { fn: 'case_private_' })).exitCode, 1);
  assert.strictEqual(classify(Object.assign({}, r, { fn: 'case_ok' })).exitCode, 2);
});

test('H04 401 は 2（再ログイン）', () => {
  assert.strictEqual(classify({ http: 401, data: { error: { status: 'UNAUTHENTICATED' } } }).reason, 'auth_invalid');
});

test('H02 500 は 3（再試行対象）', () => {
  assert.strictEqual(classify({ http: 500, data: { error: { status: 'INTERNAL', errors: [{ reason: 'backendError' }] } } }).exitCode, 3);
});

test('API無効（推定）は 2', () => {
  const r = { http: 403, data: { error: { message: 'Apps Script API has not been used in project 1 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } } };
  assert.strictEqual(classify(r).reason, 'api_disabled');
});

test('通信例外は 3', () => {
  assert.strictEqual(classify({ http: null, exception: 'ECONNRESET' }).exitCode, 3);
});

test('補助関数', () => {
  assert.strictEqual(jsErrorType('ReferenceError: x is not defined'), 'ReferenceError');
  assert.strictEqual(jsErrorType('Exception: foo'), 'Exception');
  assert.strictEqual(jsErrorType('文字列'), null);
  assert.deepStrictEqual(extractRequiredPermissions('no perms'), []);
});

test('F11 例外メッセージ末尾の GV_LOGS を取り出し、メッセージと例外種別は元のまま', () => {
  const c = classify(execErr('USER_ERROR', 'TypeError: x is undefined\nGV_LOGS:["入力 abc","[warn] 注意"]', [{ function: 'f', lineNumber: 3 }]));
  assert.strictEqual(c.exitCode, 1);
  assert.strictEqual(c.message, 'TypeError: x is undefined');
  assert.strictEqual(c.error.type, 'TypeError');
  assert.deepStrictEqual(c.logs, ['入力 abc', '[warn] 注意']);
  // 読めない GV_LOGS はメッセージのまま扱う
  const broken = classify(execErr('USER_ERROR', 'Error: a\nGV_LOGS:["切れ'));
  assert.strictEqual(broken.logs, undefined);
  assert.match(broken.message, /GV_LOGS/);
});
