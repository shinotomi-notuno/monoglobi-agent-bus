# Monoglobi Agent Bus

[MustaphaSteph/agent-bus](https://github.com/MustaphaSteph/agent-bus)を基に改修した、ローカルで動作するMCPメッセージバスです。

開発版 **0.1.0-dev.2**、スキーマ **2.4-dev.2** を配布しています。`production_ready=false`（本番運用向けの準備は未完了）です。元プロジェクトの公式リリースではありません。自動修復、本番環境への移行、プラグインとしてのインストール、スキーマの安定性は提供・保証していません。

## ドキュメント

- [インストール手順](docs/install.md)
- [運用手順](docs/operations.md)
- [オフライン復旧手順](docs/recovery.md)
- [ライセンス](LICENSE)・[第三者の権利表示](NOTICE)・[ソースの由来と構成](provenance.json)

手順書は日本語です。ライセンス・第三者の権利表示は原文を保持しています。

## 動作確認環境

初期検証は **WSL2 Linux x64 / Node.js 22.17.0 / npm 11.19.1** で実施しています。

その他の環境、およびこの配布版を使ったCodex・Claudeの実際の参加者接続は未検証です。`package.json`の`engines`に記載したバージョン範囲は、動作確認済み環境の一覧を意味しません。

## インストール

WSL2 の Linux x64 で、Node.js 22.17.0 と npm 11.19.1 を用意してから、次の**1コマンド**をコピーして実行してください。bootstrap を完全に取得して SHA256 を照合した後にだけ実行します。親シェルの環境変数は変更せず、過去の試験用設定を子シェルから除去します。

```sh
env -u AB_FIXTURE_TEST -u AB_FIXTURE_URL -u AB_INSTALL_BASE -u AB_TEST_FAIL_STAGE -u AB_TEST_HTTP -u AB_TEST_NPM_REGISTRY bash -c 'set -euo pipefail; t=$(mktemp -d); trap '\''rm -rf "$t"'\'' EXIT; curl --fail --location --proto "=https" --connect-timeout 10 --max-time 120 --output "$t/bootstrap.sh" "https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/021356d8603f53f41be4bfcf7a96d2213140f8f0/installer/0.1.0-dev.2/bootstrap.sh"; echo "297e7de01c2b9e617ff452177198579092861a5ff932500989d927b6cdb2de44  $t/bootstrap.sh" | sha256sum -c -; bash "$t/bootstrap.sh"'
```

成功時は完了メッセージと導入先を表示します。続けて、承認済みの新しい専用ディレクトリでデータ接続の準備を行ってください。接続設定は[運用手順](docs/operations.md)と[インストール手順](docs/install.md#データの準備)に従います。

ネットワークやnpmの失敗後に消してよいのは、`~/.local/share/monoglobi-agent-bus/.work` 内の失敗した作業領域だけです。DB、鍵、既存の導入先は削除しません。

手動で確認しながら導入する場合は、[インストール手順](docs/install.md#手動導入の補助手順)を使用してください。同梱のtgzを単独でインストールする方法、`npm link`、プラグインによる導入は使用しないでください。

GitHubで公開しているソースのスナップショットに、内部の開発履歴は含まれていません。
