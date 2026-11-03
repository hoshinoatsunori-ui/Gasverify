function test_parseAmount_halfwidthYen() {
  GV.assertEqual('半角¥とカンマ', 1200, parseAmount('お支払い金額 ¥1,200'));
  GV.assertEqual('空白入り', 300, parseAmount('¥ 300'));
}

function test_parseAmount_fullwidthYen() {
  GV.assertEqual('全角￥', 1200, parseAmount('お支払い金額 ￥1,200'));
}

function test_parseAmount_noAmount() {
  GV.assertThrows('金額なし', function () { parseAmount('お支払いは承認されませんでした'); }, '金額が見つかりません');
}

function test_notifyTotal_sendsOneMailInTestMode() {
  var total = notifyTotal(['¥100', '¥250'], 'me@example.com');
  GV.assertEqual('合計', 350, total);
  GV.assertEqual('テストモード', true, GV.isTestMode());
}
