function test_checkAmount_returnsAmount() {
  GV.assertEqual('半角¥', 1200, checkAmount('お支払い金額 ¥1,200').amount);
}

function test_doGet_returnsForm() {
  var html = doGet().getContent();
  GV.assertTrue('入力欄', html.indexOf('data-testid="receipt-text"') >= 0);
  GV.assertTrue('結果欄', html.indexOf('data-testid="result"') >= 0);
}
