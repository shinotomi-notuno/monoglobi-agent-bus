# Explicit local operation

First install the verified complete root kit as described in install.md using
npm ci --omit=dev. The prefix below is that kit root. Preserve kit checksums.

Configure the client command as the installed prefix's absolute
node_modules/.bin/monoglobi-agent-bus-mcp path, with explicit working directory.
Set AGENT_BUS_V2_DB to the dedicated absolute DB path and AGENT_BUS_V2_SCOPE to
JSON containing project, area and team (explicit nulls where applicable).
Set AGENT_BUS_V2_LEGACY=0 and initially AGENT_BUS_V2_WRITERS=0.
Verify capabilities/read-only status and the actual initialized instance UUID
before approved reconnection with WRITERS=1. The v2 CLI is writer-enabled;
it is not a substitute for the MCP read-only check. Use distinct client connection
names and explicit actor identities. Role labels are not hard RBAC.

Dedicated data directory mode0700; DB, receipt-containing request files and
cursor-key sidecar mode0600. Claim/reply tokens are stored in receipts; cursor
keys are plaintext sidecars. MCP tokens may remain in client context/history.
Never commit or share keys, receipts, DBs or private client transcripts.
Same-OS-user access is the trust boundary. Real-data retention requires separate
acceptance; installing this package does not grant it.

At closeout revoke active Sessions, close each client window, and confirm only
processes matching the exact dedicated DB and installed executable have stopped.
Preserve the complete existing artifact set including any WAL/SHM/markers;
record permissions, ownership and final stopped hashes without secret contents.
Set an explicit retention review date. Do not auto-delete data or clear gates.
Package-prefix removal and data removal are separate operations.
Interrupted or unknown outcomes stay read-only until explicit offline handling.
Actual participant operation is not established by a scripted MCP test.
