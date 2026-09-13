#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) != 0 ]] || { echo '導入を中止しました: rootでは実行しないでください。' >&2; exit 1; }
base="${AB_FIXTURE_TEST:-0}"; if [[ "$base" == 1 && -n "${AB_INSTALL_BASE:-}" ]]; then lock_base="$AB_INSTALL_BASE"; else lock_base="$HOME/.local/share/monoglobi-agent-bus"; fi
if [[ -e "$lock_base" ]]; then [[ ! -L "$lock_base" && $(stat -c '%u' "$lock_base") == $(id -u) && $(stat -c '%a' "$lock_base") =~ ^[0-7]00$ ]] || { echo '導入を中止しました: 管理対象ではない保存先です。' >&2; exit 1; }; else mkdir -p -m 700 "$lock_base"; chmod 700 "$lock_base"; fi
[[ ! -L "$lock_base/.install.lock" ]] || { echo '導入を中止しました: 不正なlockです。' >&2; exit 1; }
exec 9>"$lock_base/.install.lock"
flock -n 9 || { echo '導入を中止しました: 別の導入処理が動いています。終了後に再実行してください。' >&2; exit 1; }
exec node "$(dirname "$0")/installer.mjs" "$@"
