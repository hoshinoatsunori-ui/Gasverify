# GAS開発ルール（gasverify）

このプロジェクトは Google Apps Script（GAS）を `src/` に、テストを `test/` に置く。
コードを変更したら、完了と言う前に必ず `gasverify verify` を実行して結果で判断する。

## 動作確認の手順

1. `gasverify verify` を実行する（push → テスト実行まで一括）
2. 終了コードで次の行動を決める

| 終了コード | 意味 | やること |
| --- | --- | --- |
| 0 | 全テスト成功 | 完了。通ったテストと変更点を報告する |
| 1 | コードの誤り | 標準出力の診断書JSONの `failedTests[].location`・`failedAssertions`・`logs`（実行中の console.log / GV.log）を読み、実装を直して再度 verify |
| 2 | 準備不足 | **コードは触らない**。`gasverify doctor --fix` を1回だけ実行。解消しなければ `next` の内容を人に依頼して停止 |
| 3 | 実行基盤の障害 | 30秒ほど待って最大2回再実行。解消しなければ人に報告して停止 |

- 診断書の `stopLoop: true` は、同じテストが5回連続で失敗した印。修正を止め、仕様の解釈を人に確認する
- 失敗を消すためにテストの期待値を変えてはいけない。変える必要がある場合は理由を報告し、人の承認を得る

## テストの書き方

- テストは `test/` に置き、関数名は `test_` で始める。**末尾を `_` にしない**（外部から呼べない）
- 診断書の `untested` は、テストから名前が一度も出てこない `src/` の公開関数の一覧。失敗ではないが、本体の関数を足したらテストも足す
- 引数なしで呼べるようにする。結果は `GV.assertEqual` / `GV.assertTrue` / `GV.assertThrows` で確認する
- 前準備・後片付けが必要なら `gv_setup()` / `gv_teardown()` を定義する（テスト全体の前後に1回ずつ）
- 戻り値に Blob などApps Script固有のオブジェクトを含めない

```js
function test_parseAmount_fullwidthYen() {
  GV.assertEqual('全角￥', 1200, parseAmount('￥1,200'));
  GV.assertEqual('半角¥', 1200, parseAmount('¥1,200'));
  GV.assertThrows('数字なし', function () { parseAmount('なし'); }, '金額');
}
```

## 本体コードの決まり

- メール送信・外部HTTP・トリガー作成は**必ず** `GV.sendMail` / `GV.fetch` / `GV.createTrigger` を使う。
  `MailApp.sendEmail` などを直接呼ぶと、テスト時に本当に実行されてしまう（verify の警告に出る）
- テストで外部HTTPの応答が必要なら `GV.stubFetch('api.example.com', { ... })` を使う
- 件数の多い処理は `limit` 引数を受け付け、6分の実行時間制限に収める
- スプレッドシートやフォルダのIDは本体コードに直書きせず、引数か設定から受け取る（テスト用データに差し替えるため）
- 設定（シートID・シート名・送り先など）はファイルの先頭の定数にまとめる
- 列は番号で決め打ちせず、1行目の見出しの名前で探す（相手がシートに列を足すと、番号では別の列を読んでしまう）
- 普通の JavaScript で書く（TypeScript は push 時に変換されない）

## GAS側との差分

- `gasverify push` / `verify` は、GAS側にしかない変更（エディタで直された分）を見つけると終了コード2で止まり、GAS側の内容を `.gasverify/remote/<日時>/` に保存する
- そのときは手元の `src` とその保存先を比べ、残すべき変更を手元に取り込んでから再実行する（取り込めば自動で通る）。GAS側の変更を捨てるかどうかは人に確認する
- 手元と GAS 側の違いだけ見たいときは `gasverify pull`（手元の `src` は上書きしない）

## やってはいけないこと

- `appsscript.json` の `oauthScopes` を勝手に増やす（増やす場合は理由を報告し、人が `gasverify login` で承認する）
- `gasverify.config.json` の `allowedScriptIds` を変更する
- `gasverify push --force`、`gasverify run --live` を人の指示なしに使う
- GASのエディタでコードを直す、`clasp pull` で手元の `src` を上書きする
- 本番スクリプトを対象にする
