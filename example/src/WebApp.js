/**
 * サンプル：領収書の本文を貼り付けて金額を確かめる画面（10A章の画面確認用）
 * 画面確認はテスト用URL（末尾 /dev）で行う。本番URL（末尾 /exec）は使わない
 */

/** 画面を返す */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('領収書の金額確認');
}

/** 画面から google.script.run で呼ばれる。本文から金額を取り出して返す */
function checkAmount(text) {
  return { amount: parseAmount(text) };
}
