#!/usr/bin/env bash
set -euo pipefail
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
get(){ curl --fail --location --proto '=https' --connect-timeout 10 --max-time 120 -o "$t/$1" "$2"; echo "$3  $t/$1" | sha256sum -c -; }
get manifest.json 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/c48f1ddeb07f3bc5d5350aca91f53c4b08a10eff/installer/0.1.0-dev.2/manifest.json' 8587b73d57a0e65b166a521e96677930a504b9cc597848369ab411bc9336089c
get installer.mjs 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/de8e7976b82030be53b96a4614e9f91c971daf94/installer/0.1.0-dev.2/installer.mjs' 31c740404746a5414a1bcf415392636740f80b7d3f75366dfa78334f572d9370
get validator.mjs 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/de8e7976b82030be53b96a4614e9f91c971daf94/installer/0.1.0-dev.2/validator.mjs' 85485f231322cc9d928927d5a7253d8386888d3cda6676375e6f7c7aadd0cd45
get install.sh 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/de8e7976b82030be53b96a4614e9f91c971daf94/installer/0.1.0-dev.2/install.sh' c96d8b149e6316ee2dc9400eb30149331a467825ecdc6d4ef174b3cc18166eac
exec bash "$t/install.sh" "$t/manifest.json" "$t/validator.mjs"
