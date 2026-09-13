export type BusErrorCode =
  | "UPGRADE_REQUIRED" | "LEGACY_TOOL_DISABLED" | "LEGACY_ACK_DISABLED" | "SCOPE_UNRESOLVED" | "AGENT_NOT_FOUND" | "RECIPIENT_MISMATCH" | "DELIVERY_STATE_INVALID" | "UNSUPPORTED_SCHEMA" | "SCOPE_INTEGRITY"
  | "NAME_TAKEN"
  | "UNKNOWN_AGENT"
  | "ASK_TIMEOUT"
  | "ASK_CYCLE"
  | "ASK_NOT_FOUND"
  | "ASK_RECIPIENT_UNAVAILABLE"
  | "MESSAGE_NOT_FOUND"
  | "THREAD_NOT_FOUND"
  | "TEAM_NOT_FOUND"
  | "AGENT_HAS_ACTIVE_TASKS"
  | "TEAM_HAS_ACTIVE_TASKS"
  | "INVALID_INPUT"
  | "TASK_NOT_FOUND"
  | "TASK_INVALID_TRANSITION"
  | "TASK_NOT_CLAIMABLE"
  | "TASK_FORBIDDEN"
  | "TASK_SCOPE_CONFLICT"
  | "TASK_REVIEW_REQUIRED"
  | "REVIEW_SELF_FORBIDDEN";

export class BusError extends Error {
  readonly code: BusErrorCode;
  constructor(code: BusErrorCode, message: string, readonly details?: Record<string, unknown>, readonly replacement?: string) {
    super(message);
    this.code = code;
    this.name = "BusError";
  }
}
