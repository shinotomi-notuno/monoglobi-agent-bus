# オフラインでの復旧

[インストール手順](install.md)に従い、完全なkit・チェックサム・`npm ci --omit=dev`で導入した検証済みのコマンドを使用してください。復旧のためにtgzを単独インストールしないでください。

## 実行前の準備と計画

最初にすべての書込みプロセスを特定して停止し、DB・鍵・マーカーのファイル一式を保全してください。

コマンドは`monoglobi-agent-bus-recover inspect PLAN_JSON_FILE`または`monoglobi-agent-bus-recover replace PLAN_JSON_FILE`です。MCPには公開されず、通常起動時にも自動実行されません。

障害発生前の信頼できる期待値を渡してください。破損したDBから推測した値は使用しません。厳密な計画スキーマは公開ソースの[src/v2/recovery-cli.ts](../src/v2/recovery-cli.ts)にあります。

- 共通項目：`writersStopped:true`、`sidecarHandled:true`、`deadlineAt`（エポックミリ秒）。
- `target`：`path`、`expected`、`receipts`を含みます。`replace`には同じ構造の`staging`も必要です。
- `expected`：`origin_instance_uuid`、`schema_version`、`scope_json`（スコープキー配列をシリアライズした文字列）、`key_fingerprint`（SHA256）。
- 各receipt参照：`origin_instance_uuid`、`actor`、`session_id`、`request_id`、`operation`、`input_digest`。

これらの信頼すべき値を捏造したり、トークンを追加したりしないでください。

## 終了コードと復旧中の扱い

終了コード`64`は入力不正、`2`は失敗・読取専用、`0`は指定した検査または置換の完了を示します。`0`でも本番運用の準備完了を意味しません。

結果が不明でも業務操作の再送は許可されません。ゲートと途中のファイルをすべて保持し、`ready`や`recovery_state`を手動変更しないでください。

置換ではrename前に両コピーのゲートをコミットし、片方だけコミットされた状態も保持します。利用可能にできるのは整合した新しいtargetだけで、バックアップは書込み禁止のままです。通常起動時も永続化された復旧ゲートに従う必要があります。

## 移行との区別

既存データの移行は別工程です。この版で受け入れるのは、コピー前のソースハッシュを持つ、確認済みの新規合成試験データに限ります。実際の過去データの移行は対象外です。インストール済みパッケージを以前の版に戻しても、DBスキーマや復旧ゲートは元に戻りません。
