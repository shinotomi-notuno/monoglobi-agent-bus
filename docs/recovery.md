# Offline recovery only

Use the verified root kit's installed bin after following install.md (complete
kit, checksums, npm ci --omit=dev). Do not install the tgz separately for recovery.

Stop and identify all writers and preserve the DB/key/marker artifact set first.
The command is monoglobi-agent-bus-recover inspect PLAN_JSON_FILE or replace
PLAN_JSON_FILE. It is not exposed as MCP and does not run on normal startup.
Supply trusted pre-incident expectations, never expectations inferred from the
damaged DB. The strict plan schema is in src/v2/recovery-cli.ts (public source).
Common fields: writersStopped:true, sidecarHandled:true, deadlineAt (epoch ms).
target contains path, expected and receipts; replace also requires staging of
the same shape. expected contains origin_instance_uuid, schema_version,
scope_json (serialized scope-key array), key_fingerprint (SHA256). Each receipt
reference contains origin_instance_uuid, actor, session_id, request_id,
operation and input_digest. Do not invent these trusted values or add tokens.

Exit64 means invalid input, exit2 means failure/read-only, exit0 means the
requested inspection/replacement completed, not production readiness.
Unknown outcomes do not authorize resending business operations. Retain gates
and all intermediate artifacts. Do not change ready/recovery_state manually.
Replacement commits both copy gates before rename; partial gate commitment is
preserved. Only the new consistent target can be made available; backup remains
write-blocked. Normal startup must still respect the persistent recovery gate.

Existing-data migration is separate: this version accepts only confirmed new
synthetic fixtures with pre-copy source hash, not real historical data migration.
Reverting the installed package does not revert the DB schema or recovery gates.
