#!/usr/bin/env bash
set -euo pipefail
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
get(){ curl --fail --location --proto '=https' --connect-timeout 10 --max-time 120 -o "$t/$1" "$2"; echo "$3  $t/$1" | sha256sum -c -; }
get manifest.json 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/addc61a70c944755cd53c733bd8c2eadb2d3bb97/installer/0.1.0-dev.2/manifest.json' 82c69fc8a3f2bd004d366f4f8acdc67a854cbd11bac436e868decf3f960161c9
get installer.mjs 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/b48f27dcfdc9225cd497be88982045666197f1a3/installer/0.1.0-dev.2/installer.mjs' da5d164d9ac3fc8567da5e52832131c3ba96c223e7c5dea58cde6cb82ee66d61
get validator.mjs 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/b48f27dcfdc9225cd497be88982045666197f1a3/installer/0.1.0-dev.2/validator.mjs' b4c02b8f0c571d95a11d54f68409b6f0970b856a0fe29ed9e31c7571927f277f
get install.sh 'https://raw.githubusercontent.com/shinotomi-notuno/monoglobi-agent-bus/b48f27dcfdc9225cd497be88982045666197f1a3/installer/0.1.0-dev.2/install.sh' 995e0f9d55afa24429429cf111ebf0f77ccf8c915e7efb3d77b1f0faefb53f8e
exec bash "$t/install.sh" "$t/manifest.json" "$t/validator.mjs"
