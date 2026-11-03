# GAS自動動作確認：導入可否チェック手順（Q1〜Q3）

試用用のGASを1本動かし、どこで止まるかで判定する。業務データには触れない。所要時間は30〜60分程度の見込み。

## 判定表

| 確認項目 | 確認方法 | OK | NG（管理者に確認すること） |
| --- | --- | --- | --- |
| Q3 ユーザー設定のApps Script API | 手順1 → 手順9の `clasp push` | トグルをオンにでき、pushが通る | トグルを変更できない／pushが拒否される |
| Q1-a 標準Cloudプロジェクトの作成 | 手順2 | プロジェクトを作成できる | 作成画面で権限エラー |
| Q1-b GASへの紐付け | 手順6 | プロジェクト番号への変更が成功する | 「スクリプトオーナーの組織外」という趣旨のエラー |
| Q2 自作OAuthクライアントの承認 | 手順8 | 承認画面を通過できる | ブロックされた旨の画面が出る |
| Q1・Q2の通し確認 | 手順8 | `exitCode: 0` と自分のメールアドレスが返る | `exitCode: 2` の内容に従う |

## 手順

1. **Q3**：https://script.google.com/home/usersettings で「Google Apps Script API」をオンにする。
   - この設定は clasp push など「スクリプトを作成・変更する」操作に必要。scripts.run による関数実行だけなら不要（公式ドキュメント記載）。
2. **Q1-a**：Google Cloudコンソール（https://console.cloud.google.com/）で新規プロジェクトを作成する。名前は例：`gasverify-poc`。
   - 組織（会社ドメイン）の配下に作成されているかを、作成画面の「場所」で確認する。
3. 作成したプロジェクトで **Apps Script API を有効化**する（「APIとサービス」→「ライブラリ」→ Apps Script API）。
4. **OAuth同意画面**を設定する。ユーザーの種類は「内部」を選ぶ。
   - 「内部」を選べない場合は、プロジェクトが組織の外に作られている可能性がある。
5. 「認証情報」→「OAuthクライアントIDを作成」→ アプリケーションの種類は **デスクトップアプリ**。JSONをダウンロードし、`credentials.json` として `gas_probe.js` と同じフォルダに置く。
6. **Q1-b**：https://script.new で新規のスタンドアロンGASを作成する。
   - `Code.gs` の内容を貼り付ける。
   - 「プロジェクトの設定」で「appsscript.json をエディタで表示」をオンにし、同梱の `appsscript.json` の内容で置き換える。
   - 「プロジェクトの設定」→「Google Cloud Platform（GCP）プロジェクト」→「プロジェクトを変更」→ 手順2のプロジェクト番号を入力する。
7. 「デプロイ」→「新しいデプロイ」→ 種類「API実行可能ファイル」→ アクセスできるユーザー「自分のみ」でデプロイする。スクリプトIDは「プロジェクトの設定」でコピーしておく。
8. **Q2＋通し確認**：
   ```
   npm install googleapis @google-cloud/local-auth
   node gas_probe.js --script <スクリプトID>
   ```
   ブラウザで承認画面が開く。結果はJSONで表示される。
9. **Q3の最終確認（任意）**：clasp で同じスクリプトを clone して push してみる。通れば Q3 はOK。
   ```
   npm install -g @google/clasp
   clasp login
   clasp clone <スクリプトID>
   clasp push
   ```

## 実業務のスコープでQ2を確かめる（推奨）

組織が「信頼していないアプリ」に対して、リスクの高いスコープ（Gmail・ドライブ全体など）だけを制限している場合は、手順8が通っても実業務のGASで止まる。実際に使うスコープでも確認する。

1. `appsscript.json` の `oauthScopes` に `https://www.googleapis.com/auth/gmail.readonly` を追加して保存する。
2. 次のコマンドを実行する（devModeのため再デプロイは不要）。
   ```
   node gas_probe.js --script <スクリプトID> --fn pingGmail --scopes https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/gmail.readonly
   ```

## 後片付け

- 確認が終わったら、確認用GASのデプロイを削除する。
- `credentials.json` と、生成されたトークンは共有しない。
