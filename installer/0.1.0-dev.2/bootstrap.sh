#!/usr/bin/env bash
set -euo pipefail
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
get(){ curl --fail --location --proto '=https' --connect-timeout 10 --max-time 120 -o "$t/$1" "$2"; echo "$3  $t/$1" | sha256sum -c -; }
get manifest.json 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/81f046f13ea563c8c8a2e4e7989fbae6bb470764/installer/0.1.0-dev.2/manifest.json' 2aa5bb6662beaad73dcbf0e7b51b371d7acd030a6ab65498c865e1940a4c3fc6
get installer.mjs 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/de8e7976b82030be53b96a4614e9f91c971daf94/installer/0.1.0-dev.2/installer.mjs' 31c740404746a5414a1bcf415392636740f80b7d3f75366dfa78334f572d9370
get validator.mjs 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/de8e7976b82030be53b96a4614e9f91c971daf94/installer/0.1.0-dev.2/validator.mjs' 85485f231322cc9d928927d5a7253d8386888d3cda6676375e6f7c7aadd0cd45
get install.sh 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/de8e7976b82030be53b96a4614e9f91c971daf94/installer/0.1.0-dev.2/install.sh' c96d8b149e6316ee2dc9400eb30149331a467825ecdc6d4ef174b3cc18166eac
exec bash "$t/install.sh" "$t/manifest.json" "$t/validator.mjs"
