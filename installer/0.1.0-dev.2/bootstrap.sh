#!/usr/bin/env bash
set -euo pipefail
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
get(){ curl --fail --location --proto '=https' --connect-timeout 10 --max-time 120 -o "$t/$1" "$2"; echo "$3  $t/$1" | sha256sum -c -; }
get manifest.json 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/56485841115d7b3d061c0305355c568c63a2f41f/installer/0.1.0-dev.2/manifest.json' 5b16d97bde1317f0748c886131809ddde0cd665a1d353da661156e300ec5d89b
get installer.mjs 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/6ae5763f49797fdd7996590347f2ee79881fbb69/installer/0.1.0-dev.2/installer.mjs' d92e8e0d30c54c916c66f37e8cb36e002c23f39586c912feb67605e842cae579
get validator.mjs 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/6ae5763f49797fdd7996590347f2ee79881fbb69/installer/0.1.0-dev.2/validator.mjs' 85485f231322cc9d928927d5a7253d8386888d3cda6676375e6f7c7aadd0cd45
get install.sh 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/6ae5763f49797fdd7996590347f2ee79881fbb69/installer/0.1.0-dev.2/install.sh' 995e0f9d55afa24429429cf111ebf0f77ccf8c915e7efb3d77b1f0faefb53f8e
exec bash "$t/install.sh" "$t/manifest.json" "$t/validator.mjs"
