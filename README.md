# gasverify v0.2.0

Claude Code が書いた GAS を、**push → テスト実行 → 判定 → 診断書**まで自動で回す CLI。
Claude Code は `gasverify verify` の終了コードを見て、自分でコードを直すか、人に依頼して止まるかを決める。

| 終了コード | 意味 | Claude Code の動き |
| --- | --- | --- |
| 0 | 全テスト成功 | 完了報告 |
| 1 | コードの誤り | 診断書の箇所を直して再実行 |
| 2 | 準備不足 | コードに触らず `doctor --fix`、だめなら人に依頼 |
| 3 | 実行基盤の障害 | 待って再実行、続けば報告 |

対象：自宅PC・個人Gmail（personal プロファイル）のみ。会社アカウント（work）での利用は 2026-11-07 にいったん中止した（設計書1章の方針変更）。

## 1. 準備（初回のみ・15分）

gas-probe で使った Cloud プロジェクト（gasverify-poc）と OAuth クライアントをそのまま使う。

1. **Node.js 20 以上**（確認済みの環境は v24）
2. **Apps Script API のユーザー設定をオン**：https://script.google.com/home/usersettings
   （push に必要。関数の実行だけなら不要だが、gasverify は push もするので必須）
3. **OAuth クライアントを配置**：`tools/gas-probe` で使った `credentials.json` を次の場所にコピー
   - Windows：`%USERPROFILE%\.gasverify\personal\credentials.json`
4. **OAuth 同意画面のテストユーザー**に自分のアドレスが入っていることを確認（済みのはず）
5. **確認用の GAS を1本用意**：新しく作るのがおすすめ（`script.new` → 「プロジェクトの設定」で手順2のプロジェクト番号に紐付け → 「デプロイ」→「新しいデプロイ」→「API実行可能ファイル」）。
   ※ push は GAS 側の内容を**ローカルの内容で置き換える**。既存の GAS を使う場合、GAS 側にだけあるファイルがあれば push の前に止まって知らせる。

## 2. インストール

```
cd gasverify
npm install
npm link            # どこからでも gasverify コマンドが使えるようになる
```

## 3. サンプルで動作確認（10分）

`example/` には「全角の￥を読めない」という不具合をわざと残した領収書処理が入っている。

```
cd example
（gasverify.config.json の scriptId と allowedScriptIds を確認用GASのスクリプトIDに書き換える）
gasverify login        # ブラウザで承認（script.projects、メール送信のスコープを含む）
gasverify doctor --fix # 準備を検査。ランタイム未反映なら自動で push
gasverify verify       # 6件中5件成功・1件失敗、終了コード1になれば正常
```

続けて、このフォルダで Claude Code を起動し、`/gas-verify` と入力する。
Claude Code が診断書を読んで `src/Receipt.js` を直し、`verify` が終了コード0になるまで回せば成功。

Webアプリの画面確認（10A章）も試す場合は、GASエディタの「デプロイ」→「デプロイをテスト」で表示される末尾 `/dev` のURLを、`gasverify.config.json` のプロファイルに `"devUrl"` として足し、Claude Code で `/gas-verify-web` と入力する（Claude in Chrome が必要）。シナリオは `test/e2e/check-amount.md`。

## 4. 自分のプロジェクトで使う

```
cd <プロジェクト>
gasverify init --script <スクリプトID>
gasverify login
gasverify doctor --fix
```

`init` は次を作る（既存のファイルは上書きしない）。

| ファイル | 内容 |
| --- | --- |
| `gasverify.config.json` | プロファイル、スクリプトID、許可リスト |
| `src/appsscript.json` | マニフェスト（スコープを増やしたら `gasverify login` で再承認） |
| `CLAUDE.md` | Claude Code 向けの手順・テスト規約・禁止事項（既存の場合は `CLAUDE.gasverify.md`） |
| `.claude/commands/gas-verify.md` | `/gas-verify` コマンド |
| `.claude/commands/gas-verify-web.md` | `/gas-verify-web` コマンド（Webアプリの画面確認。プロファイルに `devUrl` を設定して使う） |
| `.claude/settings.json` | gasverify は許可、login・push --force・設定変更は確認、clasp の push/deploy は禁止 |

## 5. テストの書き方（要点）

```js
// test/test_Receipt.js
function test_parseAmount_fullwidthYen() {
  GV.assertEqual('全角￥', 1200, parseAmount('お支払い金額 ￥1,200'));
}
```

- `test/` に置き、`test_` で始める。末尾を `_` にしない（外から呼べない）
- 前後処理は `gv_setup()` / `gv_teardown()`
- 本体のメール送信・外部HTTP・トリガー作成は `GV.sendMail` / `GV.fetch` / `GV.createTrigger` を使う。テスト中は実行されず、診断書の `sideEffects` に記録だけ残る

## 6. コマンド

```
gasverify help
```

| コマンド | 内容 |
| --- | --- |
| `verify [--filter 文字列]` | push → test。Claude Code は原則これだけ使う |
| `test [--filter 文字列]` | push せずにテストだけ |
| `run <関数> [--args '[...]']` | 関数を1つ実行（テストモード）。`--live` で副作用ありの本番実行 |
| `push [--force]` | 反映。GAS側にしかない変更（エディタでの修正、GAS側だけのファイル）があると止まり、GAS側の内容を `.gasverify/remote/` に保存する。手元に取り込めば通る。`--force` はGAS側の変更を捨てて上書き |
| `pull` | GAS側の内容を `.gasverify/remote/<日時>/` に取り、手元との違いを一覧（手元の `src` は上書きしない） |
| `doctor [--fix]` | 設定・ログイン・スコープ・API・実行を順に検査 |
| `login` / `logout` | 承認・トークン削除（`~/.gasverify/<profile>/token.json`） |

診断書（標準出力のJSON）と実行履歴は `.gasverify/runs/` に保存される。

## 7. 基本設計からの変更点と未実装

- **push は clasp ではなく Apps Script API を直接使う**：clasp の別ログインを不要にし、プロファイルごとの認証を1つにまとめるため
- **前後処理の関数名を `gv_setup` / `gv_teardown` に変更**：末尾 `_` の関数は外から呼べない（実測C10）
- **push前の差分確認（v0.2.0）**：push は GAS 側を置き換えるため、エディタで直された分が消える。前回 push の内容と GAS 側を比べ、変わっていれば止める（たか田氏の記事「Claude Code×GAS ～claspを入れろ～」第5章の考え方を取り入れた）
- **ログ取得（F11）は Cloud Logging を使わない**：ランタイムが実行中の `console.*` と `GV.log` を記録し、失敗したテストの診断書の `logs` に添付する。追加のスコープが不要で、反映の遅れもないため
- **Webアプリ画面確認（10A章）は座標とスクリーンショットで行う**：GAS の画面は別ドメインの iframe の中にあり、Claude in Chrome でも要素・コンソールを読めない（Q9実測）。結果は画面上の文言で判定する
- **会社利用は中止**：work プロファイルは仕組みだけ残し、動作は確認しない。personal での未実装はなし
- 自動テスト（`npm test`、49件）は模擬APIサーバーで実施。実際の Google との通しは 2026-11-07 に実施済み

## 8. 開発者向け

```
npm test   # 判定ロジック・ファイル収集・GAS側ランタイム・模擬サーバーでの通し（49件）
```

- 要件定義・基本設計書：[docs/design.md](docs/design.md)
- 開発の決まりと実測で分かった挙動：[CLAUDE.md](CLAUDE.md)
- 導入可否の確認キット：[tools/gas-probe](tools/gas-probe/README.md)、応答の実測キット：[tools/gas-measure](tools/gas-measure/README_measure.md)
