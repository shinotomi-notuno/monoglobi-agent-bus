# Monoglobi Agent Bus

Customized local MCP message bus derived from MustaphaSteph/agent-bus.
Development distribution 0.1.0-dev.1, schema 2.4-dev.2; production_ready=false.
Not an official upstream release. No automatic repair, production migration,
plugin installation or stable-schema promise is provided.

See [installation](docs/install.md), [operations](docs/operations.md),
[offline recovery](docs/recovery.md), LICENSE, NOTICE and provenance.json.
Initial validation targets WSL2 Linux x64 / Node 22.17.0 / npm 11.19.1.
Other platforms and actual Codex/Claude participant connections with this
distribution are not yet verified. Package engine range is not a support matrix.

Acquire all four assets from the same reviewed Release into one download directory:
monoglobi-agent-bus-0.1.0-dev.1-kit.tar.gz, SHA256SUMS, source-manifest.json and
RELEASE-NOTES.md. Match the Release's source commit/tag and these four assets.
Keep all four files together for sha256sum -c SHA256SUMS. Verify the archive,
extract into a new dedicated directory, verify its CHECKSUMS, then run
npm ci --omit=dev there and use its node_modules/.bin. The enclosed tgz is not
a supported standalone installer. Do not use upstream latest, npm link or plugins.
GitHub source snapshot contains no internal development history.
