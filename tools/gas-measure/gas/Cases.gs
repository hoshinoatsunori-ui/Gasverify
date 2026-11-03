/**
 * 実測用GAS（Q5：エラー時の文言、Q7：行番号）
 * 業務データには一切触れない。measure.js から scripts.run で呼ばれる。
 * 注意：@line マーカーの行がずれると Q7 の判定が狂うため、貼り付け後に整形しないこと。
 */

// 正常系：戻り値の型がどう返るかを見る
function case_ok() {
  return { ok: true, n: 1, s: 'あ', arr: [1, 2], nested: { a: null } };
}

// コードの誤り：TypeError
function case_typeError() {
  var x = null;
  return x.foo; // @line case_typeError
}

// コードの誤り：ReferenceError
function case_referenceError() {
  return notDefinedVariable + 1; // @line case_referenceError
}

// コードの誤り：Error を throw
function case_throwError() {
  throw new Error('意図的なエラー: case_throwError'); // @line case_throwError
}

// コードの誤り：文字列を throw（Error以外）
function case_throwString() {
  throw '文字列をthrow';
}

// GAS内の権限エラー：マニフェストにないGmailスコープを使う
function case_gmailWithoutScope() {
  return GmailApp.getInboxUnreadCount();
}

// 戻り値：Apps Script固有オブジェクト（Blob）
function case_returnBlob() {
  return Utilities.newBlob('x');
}

// 戻り値：Date
function case_returnDate() {
  return new Date(0);
}

// 戻り値：undefined
function case_returnUndefined() {
}

// 引数：どの型がどう届くか
function case_args(a, b, c) {
  return { a: a, b: b, c: c, types: [typeof a, typeof b, typeof c] };
}

// 末尾が _ のプライベート関数を外から呼べるか
function case_private_() {
  return 'private';
}

// ログ出力（clasp logs での取得確認用）
function case_consoleLog() {
  console.log('log-from-case_consoleLog');
  console.error('error-from-case_consoleLog');
  return 'logged';
}

// 実行時間超過（7分ループ）。--include-slow を付けたときだけ実行される
function case_timeout() {
  var end = Date.now() + 7 * 60 * 1000;
  while (Date.now() < end) {
    Utilities.sleep(1000);
  }
  return 'done';
}
