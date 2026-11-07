# 領収書の金額確認（画面確認のシナリオ）

対象: gasverify.config.json の devUrl（末尾 /dev）。本番の /exec は開かない
前提: `gasverify verify` を先に通す（全角￥の不具合が残っていれば、手順2で画面にもエラーが出る）

1. data-testid=receipt-text に「お支払い金額 ¥1,200」を入力し、data-testid=check を押す
   期待: data-testid=result に「金額: 1200 円」、data-testid=error は空
2. data-testid=receipt-text を「お支払い金額 ￥1,200」（全角￥）に替え、data-testid=check を押す
   期待: data-testid=result に「金額: 1200 円」、data-testid=error は空、コンソールに error がない
3. data-testid=receipt-text を「お支払いは承認されませんでした」に替え、data-testid=check を押す
   期待: data-testid=error に「エラー: 金額が見つかりません」を含む文言

後確認: なし（この画面はデータを書き込まない）
