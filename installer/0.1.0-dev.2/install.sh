#!/usr/bin/env bash
set -euo pipefail
base="${AB_FIXTURE_TEST:-0}"; if [[ "$base" == 1 && -n "${AB_INSTALL_BASE:-}" ]]; then lock_base="$AB_INSTALL_BASE"; else lock_base="$HOME/.local/share/monoglobi-agent-bus"; fi
mkdir -p -m 700 "$lock_base"
exec 9>"$lock_base/.install.lock"
flock -n 9 || { echo '導入を中止しました: 別の導入処理が動いています。終了後に再実行してください。' >&2; exit 1; }
exec node "$(dirname "$0")/installer.mjs" "$@"
