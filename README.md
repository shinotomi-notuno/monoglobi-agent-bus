# Monoglobi Agent Bus

[MustaphaSteph/agent-bus](https://github.com/MustaphaSteph/agent-bus)を基に改修した、ローカルで動作するMCPメッセージバスです。

開発版 **0.1.0-dev.1**、スキーマ **2.4-dev.2** を配布しています。`production_ready=false`（本番運用向けの準備は未完了）です。元プロジェクトの公式リリースではありません。自動修復、本番環境への移行、プラグインとしてのインストール、スキーマの安定性は提供・保証していません。

## ドキュメント

- [インストール手順](docs/install.md)
- [運用手順](docs/operations.md)
- [オフライン復旧手順](docs/recovery.md)
- [ライセンス](LICENSE)・[第三者の権利表示](NOTICE)・[ソースの由来と構成](provenance.json)

リンク先の手順書は英語です。

## 動作確認環境

初期検証は **WSL2 Linux x64 / Node.js 22.17.0 / npm 11.19.1** で実施しています。

その他の環境、およびこの配布版を使ったCodex・Claudeの実際の参加者接続は未検証です。`package.json`の`engines`に記載したバージョン範囲は、動作確認済み環境の一覧を意味しません。

## インストール

[Release一覧](https://github.com/shinotomi-notuno/monoglobi-agent-bus/releases)から、検証済みの同じリリースに添付された次の**4ファイルすべて**を、同じダウンロードディレクトリへ取得してください。

- `monoglobi-agent-bus-0.1.0-dev.1-kit.tar.gz`
- `SHA256SUMS`
- `source-manifest.json`
- `RELEASE-NOTES.md`

Releaseに記載されたソースのcommit・tagと、取得した4ファイルの対応を確認してください。4ファイルを同じ場所に置いたまま、次のコマンドでチェックサムを検証します。

```sh
sha256sum -c SHA256SUMS
```

続いて[インストール手順](docs/install.md)に従い、検証したアーカイブを新しい専用ディレクトリへ展開してください。展開先で内側のチェックサムを検証し、依存パッケージをインストールします。

```sh
sha256sum -c CHECKSUMS
npm ci --omit=dev
```

コマンドは、そのインストール先の`node_modules/.bin`にあるものを使用してください。

同梱のtgzを単独でインストールする方法はサポートしていません。元プロジェクトの最新版、`npm link`、プラグインによる導入は使用しないでください。

GitHubで公開しているソースのスナップショットに、内部の開発履歴は含まれていません。
