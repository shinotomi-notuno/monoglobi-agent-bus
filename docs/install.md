# Install the complete root kit

Acquire all FOUR assets from the same reviewed Release of
shinotomi-notuno/monoglobi-agent-bus into the SAME download directory:

- monoglobi-agent-bus-0.1.0-dev.1-kit.tar.gz
- SHA256SUMS
- source-manifest.json
- RELEASE-NOTES.md

Match the source commit/tag recorded in that Release and all four assets to the
review record. SHA256SUMS checks the other three files; downloading just the kit
and checksum file is incomplete and must fail. Checksums alone do not establish
publisher identity.

From the download directory verify the outer archive:

```sh
sha256sum -c SHA256SUMS
```

Choose a NEW dedicated directory on the Linux filesystem, not the application
repo or an existing installation. Set AB_KIT_DIR to its absolute path. Inspect
the archive listing; reject absolute paths, parent traversal, links, unexpected
files or multiple roots. Extract only the verified kit:

```sh
mkdir -m 700 "$AB_KIT_DIR"
tar -xzf monoglobi-agent-bus-0.1.0-dev.1-kit.tar.gz -C "$AB_KIT_DIR" --strip-components=1
cd "$AB_KIT_DIR"
sha256sum -c CHECKSUMS
npm ci --omit=dev
```

Use this root's node_modules/.bin/monoglobi-agent-bus-mcp,
monoglobi-agent-bus-init, monoglobi-agent-bus-recover and monoglobi-agent-bus-v2.
Keep package.json/package-lock.json/tgz/checksums together. Root lock and overrides
fix evaluated runtime versions. The esbuild override is retained but does not add
esbuild to runtime. Only the enclosed tgz uses a relative file: reference.

Do not replace npm ci with standalone tgz installation, npm install/update,
npm link, npx latest or plugin installation. Standalone tgz install did not keep
the evaluated tree with the tested npm. Package shrinkwrap is the source/build
lock, not the consumer root lock. Updates replace the complete kit in a new
directory after separate review; never edit its lock to resolve install errors.

Initial measured environment: WSL2 Linux x64, glibc2.39, Node22.17.0/npm11.19.1.
Prebuilt native addon availability depends on platform and Node ABI. Network is
needed; do not disable all lifecycle scripts. Fallback compilation may require
Python, make and C/C++ tools. Prebuilt success on a host with these tools does not
prove a toolchain-free host works. Other OS/arch/npm versions are unverified.
Engine range is not a support matrix.

Source developers use the reviewed snapshot, npm ci, npm run build, npm run
typecheck and npm run test:v2. Source npm-shrinkwrap.json is the build lock.

Data setup is separate: use an approved new dedicated mode0700 directory.
monoglobi-agent-bus-init takes NEW_DB_PATH and JSON_SCOPE_ARRAY; verify DB/key
mode0600. Never use production or preserved pilot paths. See operations.md and
recovery.md. Installation does not establish participant connections or approve
real-data migration. Third-party correspondence and texts: docs/third-party.json
and NOTICE, with the original LICENSE retained.
