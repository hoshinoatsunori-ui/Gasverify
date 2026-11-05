# gasverify 開発ガイド（Claude Code 向け）

Claude Code が生成した GAS を push → テスト実行 → 判定 → 診断書まで自動で回す Node.js 製 CLI。
仕様の正本は `docs/design.md`（要件定義・基本設計書）。迷ったら設計書の章番号で判断し、変えたら設計書も直す。

## 構成

| パス | 役割 |
| --- | --- |
| `bin/gasverify.js` | 引数解析とコマンド振り分け。終了コードで終わる |
| `lib/commands.js` | init / login / logout / doctor / push / run / test / verify |
| `lib/classify.js` | scripts.run 応答 → 終了コードの判定表（設計書9.3） |
| `lib/api.js` | Apps Script API 呼び出し（push は projects.updateContent、実行は scripts.run＋再試行） |
| `lib/auth.js` | OAuth（プロファイルごとに `~/.gasverify/<profile>/`） |
| `lib/files.js` | push 対象の収集、関数対応表、テスト発見、静的検査 |
| `lib/drift.js` | push前の差分確認。前回pushの指紋を `.gasverify/last-push/` に保存し、GAS側の変更を検出 |
| `lib/report.js` | 診断書 JSON と実行履歴 `.gasverify/runs/` |
| `runtime/gasverify_runtime.js` | GAS 側ランタイム（GV）。push 時に自動追加 |
| `templates/` | `gasverify init` が利用者のプロジェクトに置く CLAUDE.md・コマンド・settings |
| `example/` | わざと不具合（全角￥未対応）を残したサンプル |
| `tools/gas-probe`, `tools/gas-measure` | 導入可否確認（Q1〜Q3）と応答実測（Q5・Q7）のキット |
| `test/` | node:test。`mock-gas-server.js` が実測に合わせた模擬 Apps Script API |

## 守ること

- **終了コードの意味を変えない**：0 成功 / 1 コードの誤り / 2 準備不足 / 3 実行基盤。複数混在時は 2 > 3 > 1 > 0
- **判定は実測に基づく**：`classify.js` を変えるときは、実測の根拠（ケースID）か公式ドキュメントを添える。推定はコメントで「未実測」と明記する
- **安全策を弱めない**：許可リスト外の拒否、push前の差分確認（GAS側にしかない変更を消さない）、スコープの自動追加禁止、テストモード既定
- 外部依存は `googleapis` と `@google-cloud/local-auth` のみ。増やす場合は理由を README に書く
- 出力：標準出力は1回の実行につき診断書 JSON を1つ、人向けの要約は標準エラー
- 文言（メッセージ・next）は日本語

## テスト

```
npm install
npm test        # 37件。模擬サーバー相手の通しを含む（実際の Google には接続しない）
```

- e2e テストは模擬サーバーと同じプロセスで動くため、CLI は必ず非同期（execFile）で呼ぶ。spawnSync を使うとサーバーが応答できずに止まる
- 判定ロジックを変えたら `test/classify.test.js` に実測ケースを追加する

## 実測で分かった Apps Script API の挙動（2026-11-03、個人Gmail）

- GAS内の例外は HTTP 200＋`error.code=3`、`errorType` は一律 `USER_ERROR`。JS の例外種別はメッセージ先頭から取る
- スタックの行番号は各ファイル内の行と一致。ファイル名は返らない
- 権限不足は USER_ERROR のまま「Specified permissions are not sufficient」で区別
- 存在しない関数は `FUNCTION_NOT_FOUND`、末尾 `_` の関数は 403、誤ったスクリプトIDは 500
- スクリプトIDで呼ぶと devMode=false でも最新コードが動いた（head デプロイ扱いと推定）
- Blob を返してもエラーにならず `[native code]` 文字列が届く
- `local-auth` と `googleapis` は別版の google-auth-library を使う。資格情報は googleapis 側の OAuth2 に移し替える
- 外部＋テスト中アプリは基本スコープ以外でテストユーザー登録が必須

## 未実装・未確認（優先順）

1. 実際の Google での通し確認（example で verify → 終了コード1 → 修正 → 0）
2. F11 ログ取得（console.log）
3. 未実測ケース：C12 実行時間超過（code=10 の想定）、H06 Apps Script API 無効時
4. 10A章 Web アプリ画面確認（Claude in Chrome）、Q9 iframe 内の読み取り。デプロイ機能を足す場合は、新しいデプロイを作らず既存のデプロイIDを更新する（新しいデプロイはURLが変わり、配布先が止まる）
5. work プロファイル（会社アカウント。Q1・Q2・Q11 の社内確認待ち）
6. F12 カバレッジ簡易計測
