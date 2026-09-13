# 完全なroot kitのインストール

`shinotomi-notuno/monoglobi-agent-bus`の検証済みの同じReleaseから、次の**4ファイルすべて**を同じダウンロードディレクトリへ取得してください。

- `monoglobi-agent-bus-0.1.0-dev.1-kit.tar.gz`
- `SHA256SUMS`
- `source-manifest.json`
- `RELEASE-NOTES.md`

Releaseに記載されたソースのcommit・tagと4ファイルを検証記録と照合してください。`SHA256SUMS`は他の3ファイルを検証します。kitとチェックサムの2ファイルだけでは不足し、検証は失敗します。チェックサムだけでは公開者の身元を証明できません。

ダウンロードディレクトリで外側のチェックサムを検証します。

```sh
sha256sum -c SHA256SUMS
```

Linuxファイルシステム上に**新しい専用ディレクトリ**を選び、絶対パスを`AB_KIT_DIR`に設定してください。アプリケーションのリポジトリや既存のインストール先は使用しません。アーカイブ内の一覧を確認し、絶対パス、親ディレクトリへの遡及、リンク、想定外のファイル、複数のルートがあれば展開を中止してください。検証済みのkitだけを展開します。

```sh
mkdir -m 700 "$AB_KIT_DIR"
tar -xzf monoglobi-agent-bus-0.1.0-dev.1-kit.tar.gz -C "$AB_KIT_DIR" --strip-components=1
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
