#!/usr/bin/env bash
set -euo pipefail
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
get(){ curl --fail --location --proto '=https' --connect-timeout 10 --max-time 120 -o "$t/$1" "$2"; echo "$3  $t/$1" | sha256sum -c -; }
get manifest.json 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/e3bd4ea0345f3a464edd8b1c1f960e82dd6e3190/installer/0.1.0-dev.2/manifest.json' 3573b82f19e8497d2048ce45d67dd7247e453a4293b437c12de83e506557d72e
get installer.mjs 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/d6a40e9ae6ec1e36d01248f41df21299b1cc5538/installer/0.1.0-dev.2/installer.mjs' 31c740404746a5414a1bcf415392636740f80b7d3f75366dfa78334f572d9370
get validator.mjs 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/d6a40e9ae6ec1e36d01248f41df21299b1cc5538/installer/0.1.0-dev.2/validator.mjs' 85485f231322cc9d928927d5a7253d8386888d3cda6676375e6f7c7aadd0cd45
get install.sh 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/d6a40e9ae6ec1e36d01248f41df21299b1cc5538/installer/0.1.0-dev.2/install.sh' df08c21a4a09c5deefa784b3844a19bb4e69c1a8e22685f1211c5bc128e44879
exec bash "$t/install.sh" "$t/manifest.json" "$t/validator.mjs"
