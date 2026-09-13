# 0.1.0-dev.2 の導入

WSL2 の Linux x64 で実行します。必要環境は Node.js 22.17.0、npm 11.19.1、`curl`、`sha256sum`です。次の1コマンドは、固定commitのbootstrapをHTTPSで取得し、完全取得とSHA256一致の後だけ実行します。試験用の環境変数は子シェルだけで取り除くため、親シェルの設定は変わりません。

```sh
env -u AB_FIXTURE_TEST -u AB_FIXTURE_URL -u AB_INSTALL_BASE -u AB_TEST_FAIL_STAGE -u AB_TEST_HTTP -u AB_TEST_NPM_REGISTRY bash -c 'set -euo pipefail; t=$(mktemp -d); trap '\''rm -rf "$t"'\'' EXIT; curl --fail --location --proto "=https" --connect-timeout 10 --max-time 120 --output "$t/bootstrap.sh" "https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/021356d8603f53f41be4bfcf7a96d2213140f8f0/installer/0.1.0-dev.2/bootstrap.sh"; echo "297e7de01c2b9e617ff452177198579092861a5ff932500989d927b6cdb2de44  $t/bootstrap.sh" | sha256sum -c -; bash "$t/bootstrap.sh"'
```

成功時は完了メッセージと導入先が表示されます。接続用のDBと鍵は導入とは別に、承認済みの新しい専用ディレクトリで準備します。[運用手順](operations.md)と下記の「データの準備」を参照してください。

失敗時は `~/.local/share/monoglobi-agent-bus/.work` 内の該当作業領域だけを片付けます。DB、鍵、既存の導入先は削除しません。

## 手動導入の補助手順

自動bootstrapの各検証を確認しながら行う必要がある場合だけ、検証済みReleaseから `monoglobi-agent-bus-0.1.0-dev.2-kit.tar.gz`、`SHA256SUMS`、`source-manifest.json`、`RELEASE-NOTES.md` を同じディレクトリへ取得します。`SHA256SUMS`で他の3ファイルを照合してから、Linuxファイルシステム上の新しい専用ディレクトリへ展開します。

```sh
sha256sum -c SHA256SUMS
mkdir -m 700 "$AB_KIT_DIR"
tar -xzf monoglobi-agent-bus-0.1.0-dev.2-kit.tar.gz -C "$AB_KIT_DIR" --strip-components=1
cd "$AB_KIT_DIR"
sha256sum -c CHECKSUMS
npm ci --omit=dev
```

このインストール先の`node_modules/.bin`にある次のコマンドを使用します。

- `monoglobi-agent-bus-mcp`
- `monoglobi-agent-bus-init`
- `monoglobi-agent-bus-recover`
- `monoglobi-agent-bus-v2`

`package.json`、`package-lock.json`、tgz、チェックサムを一緒に保持してください。導入先のroot lockと`overrides`で、検証済みの実行時依存バージョンを固定します。`esbuild`のoverrideは残っていますが、実行時依存には追加されません。相対的な`file:`参照を使用するのは同梱tgzだけです。

`npm ci`を、tgz単独のインストール、`npm install/update`、`npm link`、`npx latest`、プラグインのインストールに置き換えないでください。検証したnpmでは、tgz単独の導入で検証済みの依存構成を維持できませんでした。パッケージのshrinkwrapはソースのビルド用lockであり、利用者の導入先に置くroot lockとは異なります。更新時は別途レビュー後、新しいディレクトリへkit全体を導入してください。導入エラーを解消するためにlockを書き換えないでください。

## 動作確認環境

初期実測環境はWSL2 Linux x64、glibc 2.39、Node.js 22.17.0 / npm 11.19.1です。ネイティブアドオンのビルド済みバイナリを取得できるかは、プラットフォームとNode ABIに依存します。ネットワーク接続が必要です。ライフサイクルスクリプトをすべて無効にしないでください。

ソースからのビルドへ切り替わる場合、Python、make、C/C++ツールが必要になることがあります。これらのツールがある環境でビルド済みバイナリの導入に成功しても、ツールのない環境での動作を証明したことにはなりません。他のOS・アーキテクチャ・npmバージョンは未検証です。`engines`の範囲は動作確認済み環境の一覧ではありません。

## ソースからの開発

検証済みのスナップショットで、`npm ci`、`npm run build`、`npm run typecheck`、`npm run test:v2`を使用してください。ソースの`npm-shrinkwrap.json`がビルド用lockです。

## データの準備

データの準備はインストールとは別の作業です。承認済みの新しい専用ディレクトリを権限`0700`で使用してください。`monoglobi-agent-bus-init`には`NEW_DB_PATH`と`JSON_SCOPE_ARRAY`を渡し、DBと鍵の権限が`0600`であることを確認します。本番データや保全済み試行のパスは使用しないでください。

[運用手順](operations.md)と[復旧手順](recovery.md)も参照してください。インストールだけでは参加者の接続や実データ移行の承認は成立しません。第三者依存の対応表と原文は[third-party.json](third-party.json)と[NOTICE](../NOTICE)にあり、元の[LICENSE](../LICENSE)を保持しています。
