# scripts.run 実測キット（Q5：エラー時の文言、Q7：行番号）

わざとエラーを起こして、Googleが返す応答をそのまま記録する。結果から「コードの誤り（終了コード1）／準備不足（2）／実行基盤（3）」の判定表を作る。前回 `exitCode: 0` まで通した個人Gmailの確認用GASをそのまま使う。

## 準備（5分）

1. このzipの中身を、前回の **gas-probe フォルダにそのまま展開**する。`measure.js` と `gas` フォルダが `gas_probe.js` の隣に来ればよい（credentials.json と node_modules は共用）。
2. 確認用GASのエディタを開き、ファイルを2つ追加する。
   - 「＋」→「スクリプト」で `Cases` を作り、`gas/Cases.gs` の中身を貼り付ける
   - 同じく `LineCheck` を作り、`gas/LineCheck.gs` の中身を貼り付ける
   - 既存の `Code.gs`（ping）は残したままでよい
3. `appsscript.json` を `gas/appsscript.json` の中身で置き換える（スコープが1つ増える）。
4. 保存する。**再デプロイはしない**（H03は「デプロイ済みの古い版には新しい関数がない」状態を測るため）。
5. 貼り付けた後に自動整形をかけない。行番号の照合（Q7）がずれる。

## 実行

```
node measure.js --script <スクリプトID>
```

- ブラウザの承認が最大2回出る（通常のスコープ用と、わざとスコープを減らしたH05用）。どちらも許可する。2回目以降は `.tokens/` に保存したトークンを使うため承認は出ない。
- 終わると `results/measure-<日時>.md` と `.json` ができる。**`.md` の中身を貼ってもらえれば判定表を作る。**

## 追加の実測（任意）

| 内容 | コマンド | 所要時間 |
| --- | --- | --- |
| 実行時間超過（C12） | `node measure.js --script <ID> --only C12_timeout` | 約7分 |
| Apps Script API 無効時（H06） | 下の手順 | 10分程度 |
| ログ取得（C11） | `clasp logs`（claspでcloneしたフォルダで） | 1分 |

**H06 の手順**
1. Cloudコンソールで、確認用プロジェクトの Apps Script API を「無効にする」
2. 数分待ってから `node measure.js --script <ID> --only H06_api_disabled`
3. 終わったら Apps Script API を必ず「有効」に戻す

## ケース一覧

| ID | 内容 | 期待分類 |
| --- | --- | --- |
| C00 | 正常終了（戻り値の形） | 0 |
| C01〜C04 | TypeError、ReferenceError、Errorのthrow、文字列のthrow | 1 |
| C05 | マニフェストにないGmailを使う（GAS内の権限エラー） | 2 |
| C06〜C08 | Blob・Date・undefined を返す（どう届くかの観察） | - |
| C09 | 引数（文字列・数値・オブジェクト）の受け渡し | 0 |
| C10 | 末尾が `_` の関数を外から呼ぶ | - |
| C11 | console.log の出力 | 0 |
| C12 | 7分ループ（--only で実行） | 1 |
| L01・L02 | 2つ目のファイルでの行番号（直接・入れ子） | 1 |
| H01 | 存在しない関数名 | 1 |
| H02 | 間違ったスクリプトID | 2 |
| H03 | devMode=false（デプロイ済みの古い版を実行） | 2 |
| H04 | 無効なトークン | 2 |
| H05 | マニフェストより狭いスコープのトークン | 2 |
| H06 | Apps Script API 無効（手動。2026-11-07実測：run・pull・push すべて 403 SERVICE_DISABLED） | 2 |
| H08 | ユーザー設定で Apps Script API をオフ（手動。2026-11-07実測：push だけ 403、run は通る） | 2 |

「期待分類」はこちらの予想。実測結果と食い違ったものが、判定表で特に注意すべき点になる。

## 後片付け

- `.tokens/` と `credentials.json` は共有しない。
- 実測が終わったら、`appsscript.json` のスコープを戻すか、確認用GASごと削除してよい。
