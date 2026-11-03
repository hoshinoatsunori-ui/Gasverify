/**
 * サンプル：領収書メールの本文から金額を取り出し、通知する
 * ※動作確認用に、わざと不具合を1つ残してある（全角の「￥」に未対応）。
 *   gasverify verify で終了コード1になり、Claude Code に /gas-verify で直させる練習に使う。
 */

/** 本文中の「¥1,200」のような表記から金額（数値）を取り出す */
function parseAmount(text) {
  var m = String(text).match(/¥\s*([\d,]+)/);
  if (!m) {
    throw new Error('金額が見つかりません: ' + text);
  }
  return Number(m[1].replace(/,/g, ''));
}

/** 金額の合計を計算して、自分宛てに通知する */
function notifyTotal(texts, to) {
  var total = 0;
  for (var i = 0; i < texts.length; i++) {
    total += parseAmount(texts[i]);
  }
  GV.sendMail(to, '領収書の合計', '合計: ' + total + ' 円');
  return total;
}
