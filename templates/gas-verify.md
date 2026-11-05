---
description: GASの変更を push してテストし、失敗したら診断書をもとに修正して再確認する
---

`gasverify verify` を実行し、CLAUDE.md の「動作確認の手順」に従って結果を判断してください。

- 終了コード1：診断書の `failedTests` を読み、`location` の箇所と `failedAssertions` の差分から実装を修正して、再度 `gasverify verify` を実行する
- 終了コード2で `reason` が `remote_changed`：GAS側にしかない変更がある。`remoteCopy` の保存先と手元の `src` を比べて差分を報告し、取り込むかどうかを人に確認する（勝手に `--force` しない）
- 終了コード2（それ以外）：コードは変更しない。`gasverify doctor --fix` を1回だけ実行し、解消しなければ `next` を人への依頼事項としてまとめて止まる
- 終了コード3：少し待って最大2回まで再実行し、解消しなければ報告して止まる
- `stopLoop: true` が出たら修正を止め、仕様の確認を求める

最後に、通ったテスト、変更したファイル、`sideEffects`（テストモードで止めた副作用）を短く報告してください。

$ARGUMENTS
