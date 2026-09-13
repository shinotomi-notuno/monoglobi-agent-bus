// Read projections adapted from the fixed legacy functions; no legacy getDb access.
import type {MessageKind,MessageStatus,MessagePriority,AgentRole,AgentStatus,TaskMode,MemoryKind,TaskReviewState,TaskAckResponse,TestResultStatus,TaskEventType,Agent,Message,MessagePreview,Subscription,RegisterOptions,RegisterScopeSummary,RegisteredAgent,WhoisOptions,AgentDirectoryEntry,WaitForAgentsOptions,WaitForAgentsResult,SendOptions,InboxOptions,InboxPreviewOptions,GetMessageOptions,GetMessageResult,AckOptions,InboxStatusOptions,InboxStatus,AskOptions,AskAsyncResult,ReplyOptions,ReplyThreadOptions,MessageStatusOptions,MessageStatusResult,AskBestOptions,SubscribeOptions,SendChannelOptions,SendTeamOptions,AskTeamOptions,RecentMessagesOptions,MessagePageOptions,MessagePagePreview,MessagePageResult,MessageThreadResult,TaskState,Task,ScopeConflict,CheckScopeConflictsOptions,CreateTaskOptions,ClaimTaskOptions,UpdateTaskOptions,ReleaseTaskOptions,RemoveAgentOptions,RemoveAgentResult,DeleteTeamOptions,DeleteTeamResult,ListTasksOptions,AssignTaskOptions,DelegateOptions,DelegateResult,DelegateTeamOptions,DelegateTeamResult,ClaimBestTaskOptions,AcknowledgeTaskOptions,SubmitReviewOptions,HandoffTaskOptions,TaskEvent,RecordTaskEventOptions,ListTaskEventsOptions,TaskResult,WaitForTaskOptions,WaitForTaskResult,CancelTaskOptions,CancelTaskResult,Decision,TestResult,RecordDecisionOptions,ListDecisionsOptions,RecordTestResultOptions,ListTestResultsOptions,Memory,RememberOptions,ListMemoriesOptions,SessionBriefOptions,SessionBrief,ProjectBoard,TeamBoardOptions,ActivityItem,ActivityOptions,Cockpit,ScopeTeamSummary,ScopeProjectSummary,ScopesResult,TimeseriesOptions,TimeseriesResult,AgentNowOptions,AgentNowResult,FinalReport,ReviewGateReport} from '../bus.js';
import {BusError} from '../util/errors.js';
import {now,sleep} from '../util/time.js';
import type {Row} from './schema.js';
interface AgentRow {
  name: string;
  capabilities: string;
  registered_at: number;
  last_seen: number;
  paused: number;
  project: string | null;
  area: string | null;
  team: string | null;
  role: AgentRole | null;
  routing_weight: number;
  status: AgentStatus;
  session_id: string | null;
  removed_at: number | null;
  bus_version: string | null;
  listening_until: number | null;
}
interface MessageRow {
  id: number;
  from_agent: string;
  to_agent: string;
  kind: MessageKind;
  content: string;
  reply_to: number | null;
  status: MessageStatus;
  created_at: number;
  delivered_at: number | null;
  replied_at: number | null;
  thread_id: string | null;
  claim_deadline: number | null;
  claimed_by: string | null;
  channel: string | null;
  project: string | null;
  area: string | null;
  team: string | null;
  priority: MessagePriority;
}
interface BlockingAskInfo {
  id: number;
  status: MessageStatus;
  age_s: number;
  thread_id: string | null;
  claim_deadline: number | null;
  claimed_by: string | null;
}
interface TeamSelectionOptions {
  from: string;
  team?: string;
  project?: string;
  area?: string;
  include_self?: boolean;
  capability?: string;
  role?: AgentRole;
}
interface TeamSelection {
  team: string;
  candidates: AgentDirectoryEntry[];
  recipients: AgentDirectoryEntry[];
  skipped: Array<{
    agent: string;
    reason: "self" | "paused" | "stale" | "capability_mismatch" | "role_mismatch" | "over_limit";
    presence: AgentDirectoryEntry["presence"];
    age_s: number;
  }>;
}
interface TaskRow {
  id: number;
  title: string;
  description: string | null;
  thread_id: string;
  requested_by: string;
  claimed_by: string | null;
  state: TaskState;
  milestone: string | null;
  priority: number;
  cwd: string | null;
  blocked_reason: string | null;
  blocked_on_task_id: number | null;
  result: string | null;
  created_at: number;
  updated_at: number;
  claimed_at: number | null;
  finished_at: number | null;
  project: string | null;
  area: string | null;
  team: string | null;
  required_capability: string | null;
  mode: TaskMode;
  expected_output: string | null;
  deadline_at: number | null;
  checkin_at: number | null;
  final_answer: string | null;
  manager_reviewed: number;
  file_scope: string;
  edit_scope: string;
  read_scope: string;
  ack_required: number;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
  review_required: number;
  independent_review: number;
  review_state: TaskReviewState;
  reviewed_by: string | null;
  review_notes: string | null;
  changed_files: string;
  pending_assignee: string | null;
  phase: string | null;
  session_id: string | null;
}
interface TaskEventRow {
  id: number;
  task_id: number;
  by_agent: string;
  event_type: TaskEventType;
  message: string;
  phase: string | null;
  metadata: string;
  project: string | null;
  area: string | null;
  team: string | null;
  created_at: number;
}
interface DecisionRow {
  id: number;
  by_agent: string;
  decision: string;
  rationale: string | null;
  implemented: number;
  project: string | null;
  area: string | null;
  team: string | null;
  created_at: number;
  updated_at: number;
}
interface TestResultRow {
  id: number;
  by_agent: string;
  task_id: number | null;
  command: string;
  status: TestResultStatus;
  output_summary: string | null;
  git_ref: string | null;
  cwd: string | null;
  project: string | null;
  area: string | null;
  team: string | null;
  created_at: number;
}
interface MemoryRow {
  id: number;
  by_agent: string;
  agent: string | null;
  kind: MemoryKind;
  content: string;
  project: string | null;
  area: string | null;
  team: string | null;
  task_id: number | null;
  thread_id: string | null;
  pinned: number;
  supersedes_id: number | null;
  created_at: number;
  updated_at: number;
}
interface ScopeBucketOrder {
  attention: number;
  agents_online: number;
  active_tasks: number;
  project?: string | null;
  team?: string | null;
}
export function legacyReads(readDb:()=>{prepare:(sql:string)=>any},deliveryNow:()=>number=now) {
const PROJECT_WILDCARD='*',AREA_WILDCARD='*',TEAM_WILDCARD='*',MAX_INBOX_WAIT_S=110,POLL_INTERVAL_MS=50,TASK_STALE_THRESHOLD_MS=300000;
const ACTIVE_TASK_STATES=['claimed','working','blocked'],DEADLINE_ATTENTION_STATES=['open','claimed','working','blocked'],CHECKIN_ATTENTION_STATES=['claimed','working','blocked'],TERMINAL_TASK_STATES=['completed','failed','canceled'];
function requireAgent(name:string):Agent { const row=readDb().prepare('SELECT * FROM agents WHERE name=? AND removed_at IS NULL').get(name);if(!row)throw new BusError('AGENT_NOT_FOUND','AGENT_NOT_FOUND');return toAgent(row); }
function toAgent(row: AgentRow): Agent {
  return {
    name: row.name,
    capabilities: JSON.parse(row.capabilities) as string[],
    registered_at: row.registered_at,
    last_seen: row.last_seen,
    paused: row.paused === 1,
    project: row.project,
    area: row.area,
    team: row.team,
    role: row.role,
    routing_weight: row.routing_weight,
    status: row.status,
    session_id: row.session_id,
    removed_at: row.removed_at,
    bus_version: row.bus_version,
    listening_until: row.listening_until,
  };
}

function toTaskEvent(row: TaskEventRow): TaskEvent {
  return {
    ...row,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

function toDecision(row: DecisionRow): Decision {
  return {
    ...row,
    implemented: row.implemented === 1,
  };
}

function toTestResult(row: TestResultRow): TestResult {
  return { ...row };
}

function toMemory(row: MemoryRow): Memory {
  return {
    ...row,
    pinned: row.pinned === 1,
  };
}

function whois(opts: WhoisOptions = {}): Agent[] {
  const db = readDb();
  const where: string[] = ["removed_at IS NULL"];
  const params: unknown[] = [];
  if (opts.project !== undefined && opts.project !== PROJECT_WILDCARD) {
    validateProject(opts.project);
    where.push("(project = ? OR project IS NULL)");
    params.push(opts.project);
  }
  if (opts.area !== undefined && opts.area !== AREA_WILDCARD) {
    validateArea(opts.area);
    where.push("(area = ? OR area IS NULL)");
    params.push(opts.area);
  }
  if (opts.team !== undefined && opts.team !== TEAM_WILDCARD) {
    validateTeam(opts.team);
    where.push("team = ?");
    params.push(opts.team);
  }
  const rows = db
    .prepare(
      `SELECT * FROM agents${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
         ORDER BY last_seen DESC`,
    )
    .all(...params) as AgentRow[];
  return rows.map(toAgent);
}

function directory(opts: WhoisOptions = {}): AgentDirectoryEntry[] {
  const agents = whois(opts);
  const db = readDb();
  const activeRows = db
    .prepare(
      `SELECT claimed_by, id
         FROM tasks
        WHERE claimed_by IS NOT NULL
          AND state IN ('claimed','working','blocked')
        ORDER BY updated_at DESC`,
    )
    .all() as { claimed_by: string; id: number }[];
  const activeByAgent = new Map<string, number>();
  for (const row of activeRows) {
    if (!activeByAgent.has(row.claimed_by)) activeByAgent.set(row.claimed_by, row.id);
  }
  const ts = now();
  return agents.map((agent) => {
    const age_s = Math.max(0, Math.round((ts - agent.last_seen) / 1000));
    const listening = agent.listening_until !== null && agent.listening_until > ts && !agent.paused;
    const presence =
      agent.paused
        ? "paused"
        : age_s < 60
          ? "online"
          : age_s < 300
            ? "idle"
            : "stale";
    return {
      ...agent,
      presence,
      presence_basis:'legacy_saved_last_seen; not OS liveness',
      age_s,
      listening,
      active_task_id: activeByAgent.get(agent.name) ?? null,
    };
  });
}

async function waitForAgents(opts: WaitForAgentsOptions): Promise<WaitForAgentsResult> {
  if (!Array.isArray(opts.names) || opts.names.length === 0) {
    throw new BusError("INVALID_INPUT", "names must be a non-empty array");
  }
  for (const name of opts.names) validateName(name);
  if (opts.project !== undefined && opts.project !== PROJECT_WILDCARD) validateProject(opts.project);
  validateArea(opts.area);
  validateTeam(opts.team);
  const timeout = Math.min(Math.max(opts.timeout_s ?? 60, 0), MAX_INBOX_WAIT_S);
  const deadline = now() + timeout * 1000;
  let latest = inspectAgents(opts);
  while ((latest.missing.length > 0 || latest.stale.length > 0 || latest.wrong_scope.length > 0) && now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    latest = inspectAgents(opts);
  }
  return latest;
}

function inspectAgents(opts: WaitForAgentsOptions): WaitForAgentsResult {
  const expected = new Set(opts.names);
  const all = directory({ project: PROJECT_WILDCARD, area: AREA_WILDCARD, team: TEAM_WILDCARD }).filter((agent) => expected.has(agent.name));
  const byName = new Map(all.map((agent) => [agent.name, agent]));
  const missing = opts.names.filter((name) => !byName.has(name));
  const wrong_scope: WaitForAgentsResult["wrong_scope"] = [];
  const stale: AgentDirectoryEntry[] = [];
  const ready: AgentDirectoryEntry[] = [];
  for (const agent of all) {
    const projectWrong = opts.project !== undefined && opts.project !== PROJECT_WILDCARD && agent.project !== opts.project;
    const areaWrong = opts.area !== undefined && opts.area !== AREA_WILDCARD && agent.area !== opts.area;
    const teamWrong = opts.team !== undefined && opts.team !== TEAM_WILDCARD && agent.team !== opts.team;
    if (projectWrong || areaWrong || teamWrong) {
      wrong_scope.push({
        name: agent.name,
        project: agent.project,
        area: agent.area,
        team: agent.team,
        expected_project: opts.project === undefined || opts.project === PROJECT_WILDCARD ? null : opts.project,
        expected_area: opts.area === undefined || opts.area === AREA_WILDCARD ? null : opts.area,
        expected_team: opts.team === undefined || opts.team === TEAM_WILDCARD ? null : opts.team,
      });
    } else if (agent.presence === "stale" || agent.presence === "paused") {
      stale.push(agent);
    } else {
      ready.push(agent);
    }
  }
  return { ready, missing, stale, wrong_scope };
}

async function inboxPreviews(opts: InboxPreviewOptions): Promise<MessagePreview[]> {
  validateName(opts.agent);
  validateProject(opts.project);
  validateArea(opts.area);
  if (opts.team !== undefined && opts.team !== TEAM_WILDCARD) validateTeam(opts.team);
  const agent = requireAgent(opts.agent);

  if (agent.paused) return [];

  const immediate = readInboxPreviews(opts);
  if (immediate.length > 0 || !opts.wait_s) return immediate;

  const waitMs = Math.min(opts.wait_s, MAX_INBOX_WAIT_S) * 1000;
  const deadline = now() + waitMs;

  while (now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const fresh = readInboxPreviews(opts);
    if (fresh.length > 0) return fresh;
  }
  return [];
}

function getMessage(opts: GetMessageOptions): GetMessageResult {
  const row = getMessageRow(opts.message_id);
  assertMessageInScope(row, {
    project: opts.project,
    area: opts.area,
    team: opts.team,
  });
  const previewOnly = opts.include_content === false || opts.preview_chars !== undefined;
  const message = previewOnly ? toMessagePreview(row, opts.preview_chars) : toMessage(row);
  return {
    message,
    full_content_included: !previewOnly,
    suggested_next_actions: [
      row.kind === "ask"
        ? `answer with reply_v2 and explicit reply authority for message_id=${row.id}`
        : `this is kind=${row.kind}; continue the conversation with reply_thread(thread_id="${row.thread_id ?? ""}", ...) or send(..., thread_id="${row.thread_id ?? ""}")`,
      row.thread_id ? `read related context with thread(thread_id="${row.thread_id}")` : "message has no thread id",
    ],
  };
}

function inboxStatus(opts: InboxStatusOptions): InboxStatus {
  validateName(opts.agent);
  validateProject(opts.project);
  validateArea(opts.area);
  if (opts.team !== undefined && opts.team !== TEAM_WILDCARD) validateTeam(opts.team);
  requireAgent(opts.agent);

  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const ts = deliveryNow();
  const filters: string[] = [];
  const filterParams: unknown[] = [];
  if (opts.project !== undefined && opts.project !== PROJECT_WILDCARD) {
    filters.push("project = ?");
    filterParams.push(opts.project);
  }
  if (opts.area !== undefined && opts.area !== AREA_WILDCARD) {
    filters.push("area = ?");
    filterParams.push(opts.area);
  }
  if (opts.team !== undefined && opts.team !== TEAM_WILDCARD) {
    filters.push("team = ?");
    filterParams.push(opts.team);
  }
  if (opts.thread_id !== undefined) {
    filters.push("thread_id = ?");
    filterParams.push(opts.thread_id);
  }
  if (opts.since_id !== undefined) {
    filters.push("id > ?");
    filterParams.push(opts.since_id);
  }
  const filterWhere = filters.length === 0 ? "" : ` AND ${filters.join(" AND ")}`;
  const unreadParams = [opts.agent, ts, ...filterParams, limit];
  const deliveredParams = [opts.agent, ...filterParams, limit];
  const lastParams = [opts.agent, ...filterParams];
  const unread = readDb()
    .prepare(
      `SELECT * FROM messages
        WHERE to_agent = ?
          AND status = 'pending'
          AND (claim_deadline IS NULL OR claim_deadline <= ?)
          ${filterWhere}
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(...unreadParams) as MessageRow[];
  const inFlight = readDb()
    .prepare(
      `SELECT * FROM messages
        WHERE to_agent = ?
          AND status = 'pending'
          AND claim_deadline IS NOT NULL
          AND claim_deadline > ?
          ${filterWhere}
        ORDER BY claim_deadline ASC, id ASC
        LIMIT ?`,
    )
    .all(...unreadParams) as MessageRow[];
  const delivered = readDb()
    .prepare(
      `SELECT * FROM messages
        WHERE to_agent = ?
          AND status IN ('delivered','answered')
          ${filterWhere}
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(...deliveredParams) as MessageRow[];
  const last = readDb()
    .prepare(`SELECT * FROM messages WHERE to_agent = ?${filterWhere} ORDER BY id DESC LIMIT 1`)
    .get(...lastParams) as MessageRow | undefined;
  const nextClaim = inFlight.reduce<number | null>(
    (best, row) => row.claim_deadline !== null && (best === null || row.claim_deadline < best) ? row.claim_deadline : best,
    null,
  );
  const summary =
    unread.length > 0
      ? `${unread.length} unread message(s)`
      : inFlight.length > 0
        ? `no unread messages; ${inFlight.length} message(s) currently claimed/in-flight`
        : delivered.length > 0
          ? `no unread messages; ${delivered.length} recent delivered/answered message(s), last message #${last?.id ?? delivered[0]?.id} was ${last?.status ?? delivered[0]?.status}`
        : last
          ? `no unread messages; last message #${last.id} was ${last.status}`
          : "no messages for this agent";
  return {
    agent: opts.agent,
    unread: unread.map(toMessage),
    in_flight: inFlight.map(toMessage),
    delivered_recent: delivered.reverse().map(toMessage),
    last_message: last ? toMessage(last) : null,
    next_claim_deadline: nextClaim,
    summary,
  };
}

function messageStatus(opts: MessageStatusOptions): MessageStatusResult {
  const message = toMessage(getMessageRow(opts.message_id));
  const replyRow = readDb()
    .prepare("SELECT * FROM messages WHERE reply_to = ? AND kind = 'reply' ORDER BY id ASC LIMIT 1")
    .get(message.id) as MessageRow | undefined;
  const recipient = directory({ project: PROJECT_WILDCARD, area: AREA_WILDCARD })
    .find((agent) => agent.name === message.to_agent) ?? null;
  const taskRow = readDb()
    .prepare("SELECT * FROM tasks WHERE id IN (SELECT value FROM json_each((SELECT task_ids FROM main.message_bindings WHERE message_id=?))) ORDER BY updated_at DESC LIMIT 1")
    .get(message.id) as TaskRow | undefined;
  const relatedTask = taskRow ? toTask(taskRow, lastSeenMap()) : null;
  const diagnostics: string[] = [];
  const suggested: string[] = [];
  const ts = deliveryNow();
  if (message.kind === "ask" && !replyRow) {
    diagnostics.push("ask has no reply yet");
    suggested.push(`check inbox_status for ${message.to_agent}`);
  }
  if (message.status === "pending" && message.claim_deadline !== null && message.claim_deadline > ts) {
    diagnostics.push(`message is claimed by ${message.claimed_by ?? "unknown"} until ${message.claim_deadline}`);
    suggested.push("wait for the claim to expire, or inspect the claiming session");
  } else if (message.status === "pending") {
    diagnostics.push("message is unread or claim has expired");
    suggested.push(`ask ${message.to_agent} to check inbox`);
  }
  if (message.status === "delivered" && message.kind === "ask" && !replyRow) {
    diagnostics.push("ask was delivered but not answered");
  }
  if (message.status === "answered") diagnostics.push("ask was answered");
  if (recipient === null) {
    diagnostics.push(`recipient ${message.to_agent} is not registered`);
    suggested.push("check directory or register/start the recipient agent");
  } else {
    diagnostics.push(`recipient is ${recipient.status}/${recipient.presence}, seen ${recipient.age_s}s ago`);
    if (recipient.paused) suggested.push(`resume ${recipient.name}`);
    if (recipient.presence === "stale") suggested.push(`start or wake ${recipient.name}, or reassign related work`);
  }
  if (relatedTask) {
    diagnostics.push(`thread is linked to task #${relatedTask.id} (${relatedTask.state})`);
    suggested.push(`check task_result for task #${relatedTask.id}`);
  }
  if (suggested.length === 0) suggested.push("read the thread for context");
  return {
    message,
    reply: replyRow ? toMessage(replyRow) : null,
    recipient,
    related_task: relatedTask,
    diagnostics,
    suggested_next_actions: [...new Set(suggested)],
  };
}

function whyNoReply(messageId: number): MessageStatusResult {
  const result = messageStatus({ message_id: messageId });
  if (result.reply !== null) return result;
  if (result.message.kind !== "ask") {
    result.diagnostics.push("message is not an ask; no reply is expected by protocol");
  }
  return result;
}

function recentMessages(arg: number | RecentMessagesOptions = 100): Message[] {
  const opts: RecentMessagesOptions = typeof arg === "number" ? { limit: arg } : arg;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);

  const db = readDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.since_id !== undefined) {
    where.push("id > ?");
    params.push(opts.since_id);
  }
  if (opts.since !== undefined) {
    where.push("created_at >= ?");
    params.push(opts.since);
  }
  if (opts.project !== undefined && opts.project !== PROJECT_WILDCARD) {
    validateProject(opts.project);
    where.push("(project = ? OR project IS NULL)");
    params.push(opts.project);
  }
  if (opts.area !== undefined && opts.area !== AREA_WILDCARD) {
    validateArea(opts.area);
    where.push("(area = ? OR area IS NULL)");
    params.push(opts.area);
  }
  if (opts.team !== undefined && opts.team !== TEAM_WILDCARD) {
    validateTeam(opts.team);
    where.push("team = ?");
    params.push(opts.team);
  }
  if (opts.thread_id !== undefined) {
    where.push("thread_id = ?");
    params.push(opts.thread_id);
  }
  const rows = db
    .prepare(
      `SELECT * FROM messages${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
         ORDER BY id DESC
         LIMIT ?`,
    )
    .all(...params, limit) as MessageRow[];
  return rows.reverse().map(toMessage);
}

function threadMessages(threadId: string, limit = 200): Message[] {
  const rows = readDb()
    .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY id ASC LIMIT ?")
    .all(threadId, Math.min(Math.max(limit, 1), 1000)) as MessageRow[];
  return rows.map(toMessage);
}

function checkScopeConflicts(opts: CheckScopeConflictsOptions): ScopeConflict[] {
  if (opts.project !== undefined && opts.project !== null && opts.project !== PROJECT_WILDCARD) {
    validateProject(opts.project);
  }
  validateArea(opts.area);
  validateTeam(opts.team);
  const requestedScope = opts.edit_scope ?? opts.file_scope ?? [];
  if (!requestedScope.every((value) => typeof value === "string")) {
    throw new BusError("INVALID_INPUT", "edit_scope/file_scope must be an array of strings");
  }
  const scope = requestedScope.filter((value) => value.trim().length > 0);
  if (scope.length === 0) return [];

  const where = ["state IN ('claimed','working','blocked')", "mode IN ('edit_files','propose_patch')", "edit_scope != '[]'"];
  const params: unknown[] = [];
  if (opts.project !== undefined && opts.project !== null && opts.project !== PROJECT_WILDCARD) {
    where.push("project = ?");
    params.push(opts.project);
  }
  if (opts.area !== undefined && opts.area !== null && opts.area !== AREA_WILDCARD) {
    where.push("area = ?");
    params.push(opts.area);
  }
  if (opts.team !== undefined && opts.team !== null && opts.team !== TEAM_WILDCARD) {
    where.push("team = ?");
    params.push(opts.team);
  }
  if (opts.exclude_task_id !== undefined) {
    where.push("id != ?");
    params.push(opts.exclude_task_id);
  }
  const rows = readDb()
    .prepare(`SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`)
    .all(...params) as TaskRow[];
  const conflicts: ScopeConflict[] = [];
  for (const row of rows) {
    const otherScope = JSON.parse(row.edit_scope) as string[];
    for (const requested of scope) {
      const overlap = otherScope.find((existing) => scopesOverlap(requested, existing));
      if (overlap) {
        conflicts.push({
          task_id: row.id,
          title: row.title,
          claimed_by: row.claimed_by,
          state: row.state,
          overlapping_scope: overlap,
        });
        break;
      }
    }
  }
  return conflicts;
}

function listTasks(opts: ListTasksOptions = {}): Task[] {
  const db = readDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.state !== undefined) {
    const states = Array.isArray(opts.state) ? opts.state : [opts.state];
    if (states.length === 0) return [];
    where.push(`state IN (${states.map(() => "?").join(",")})`);
    params.push(...states);
  } else if (opts.include_terminal !== true) {
    where.push(`state NOT IN ('completed','failed','canceled')`);
  }
  if (opts.project !== undefined && opts.project !== PROJECT_WILDCARD) {
    validateProject(opts.project);
    // Scoped: only this project. NULL tasks are hidden until project='*'.
    where.push("project = ?");
    params.push(opts.project);
  }
  if (opts.area !== undefined && opts.area !== AREA_WILDCARD) {
    validateArea(opts.area);
    // Scoped: only this area. NULL-area tasks are hidden until area='*'.
    where.push("area = ?");
    params.push(opts.area);
  }
  if (opts.team !== undefined && opts.team !== TEAM_WILDCARD) {
    validateTeam(opts.team);
    where.push("team = ?");
    params.push(opts.team);
  }
  if (opts.required_capability !== undefined) {
    where.push("required_capability = ?");
    params.push(opts.required_capability);
  }
  if (opts.mode !== undefined) {
    validateTaskMode(opts.mode);
    where.push("mode = ?");
    params.push(opts.mode);
  }
  if (opts.milestone !== undefined) {
    validateMilestone(opts.milestone);
    where.push("milestone = ?");
    params.push(opts.milestone);
  }
  if (opts.manager_reviewed !== undefined) {
    where.push("manager_reviewed = ?");
    params.push(opts.manager_reviewed ? 1 : 0);
  }
  if (opts.claimed_by !== undefined) {
    where.push("claimed_by = ?");
    params.push(opts.claimed_by);
  }
  if (opts.requested_by !== undefined) {
    where.push("requested_by = ?");
    params.push(opts.requested_by);
  }
  if (opts.thread_id !== undefined) {
    where.push("thread_id = ?");
    params.push(opts.thread_id);
  }

  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const sql = `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
                ORDER BY priority DESC, created_at ASC
                LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as TaskRow[];
  const seen = lastSeenMap();
  return rows.map((r) => toTask(r, seen));
}

function getTask(id: number): Task {
  const row = getTaskRow(id);
  return toTask(row, lastSeenMap());
}

function listTaskEvents(opts: ListTaskEventsOptions = {}): TaskEvent[] {
  if (opts.project !== undefined && opts.project !== PROJECT_WILDCARD) validateProject(opts.project);
  if (opts.area !== undefined && opts.area !== AREA_WILDCARD) validateArea(opts.area);
  if (opts.team !== undefined && opts.team !== TEAM_WILDCARD) validateTeam(opts.team);
  validateTaskEventType(opts.event_type);
  if (opts.by_agent !== undefined) validateName(opts.by_agent);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.task_id !== undefined) {
    where.push("task_id = ?");
    params.push(opts.task_id);
  }
  if (opts.by_agent !== undefined) {
    where.push("by_agent = ?");
    params.push(opts.by_agent);
  }
  if (opts.event_type !== undefined) {
    where.push("event_type = ?");
    params.push(opts.event_type);
  }
  if (opts.project !== undefined && opts.project !== PROJECT_WILDCARD) {
    where.push("project = ?");
    params.push(opts.project);
  }
  if (opts.area !== undefined && opts.area !== AREA_WILDCARD) {
    where.push("area = ?");
    params.push(opts.area);
  }
  if (opts.team !== undefined && opts.team !== TEAM_WILDCARD) {
    where.push("team = ?");
    params.push(opts.team);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = readDb()
    .prepare(`SELECT * FROM task_events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as TaskEventRow[];
  return rows.reverse().map(toTaskEvent);
}

function taskResult(taskId: number, limit = 100): TaskResult {
  const task = getTask(taskId);
  const bounded = Math.min(Math.max(limit, 1), 500);
  return {
    task,
    events: listTaskEvents({ task_id: taskId, limit: bounded }),
    test_results: listTestResults({ task_id: taskId, limit: bounded }),
    memories: listMemories({ task_id: taskId, limit: bounded }),
    messages: (readDb().prepare("SELECT * FROM messages WHERE id IN (SELECT b.message_id FROM main.message_bindings b WHERE EXISTS(SELECT 1 FROM json_each(b.task_ids) WHERE value=?)) ORDER BY id ASC LIMIT ?").all(taskId,bounded) as MessageRow[]).map(toMessage),
  };
}

async function waitForTask(opts: WaitForTaskOptions): Promise<WaitForTaskResult> {
  const waitMs = Math.min(Math.max(opts.wait_s ?? 110, 0), MAX_INBOX_WAIT_S) * 1000;
  const startTask = getTask(opts.task_id);
  const since = opts.since_updated_at ?? startTask.updated_at;
  const deadline = now() + waitMs;
  let timedOut = false;

  while (true) {
    const current = getTask(opts.task_id);
    const result = taskResult(opts.task_id, opts.limit ?? 50);
    const latestEvent = result.events.at(-1) ?? null;
    const latestMessage = result.messages.at(-1) ?? null;
    const latestTestResult = result.test_results.at(-1) ?? null;
    const hasActivity =
      current.updated_at > since ||
      (latestEvent !== null && latestEvent.created_at > since) ||
      (latestMessage !== null && latestMessage.created_at > since) ||
      (latestTestResult !== null && latestTestResult.created_at > since) ||
      TERMINAL_TASK_STATES.includes(current.state);
    if (hasActivity || waitMs === 0) {
      return decorateWaitForTask(result, timedOut);
    }
    if (now() >= deadline) {
      timedOut = true;
      return decorateWaitForTask(result, timedOut);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function decorateWaitForTask(result: TaskResult, timedOut: boolean): WaitForTaskResult {
  const holder = result.task.claimed_by
    ? directory({ project: PROJECT_WILDCARD, area: AREA_WILDCARD }).find((agent) => agent.name === result.task.claimed_by) ?? null
    : null;
  const latestEvent = result.events.at(-1) ?? null;
  const latestMessage = result.messages.at(-1) ?? null;
  const latestTestResult = result.test_results.at(-1) ?? null;
  const suggested: string[] = [];
  if (timedOut) suggested.push("No task update before timeout; check holder presence or project_board.");
  if (result.task.pending_assignee) suggested.push(`Historical pending assignee ${result.task.pending_assignee}; use explicit assign_task_v2 after registration.`);
  if (result.task.ack_required && result.task.acknowledged_at === null) suggested.push("Task still needs acknowledgement.");
  if (result.task.state === "blocked") suggested.push("Resolve blocker or reassign/release the task.");
  if (result.task.stale === true) suggested.push("Holder appears stale; consider handoff_task or release_task.");
  if (result.task.review_required && result.task.review_state !== "approved") suggested.push("Review is not approved; completion remains an explicit actor decision.");
  if (TERMINAL_TASK_STATES.includes(result.task.state)) suggested.push("Task is terminal; inspect task_result/final_report.");
  if (suggested.length === 0) suggested.push("Continue waiting or inspect latest task events.");
  return {
    ...result,
    timed_out: timedOut,
    holder,
    latest_event: latestEvent,
    latest_message: latestMessage,
    latest_test_result: latestTestResult,
    suggested_next_actions: suggested,
  };
}

function listDecisions(opts: ListDecisionsOptions = {}): Decision[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.project !== undefined && opts.project !== PROJECT_WILDCARD) {
    validateProject(opts.project);
    where.push("(project = ? OR project IS NULL)");
    params.push(opts.project);
  }
  if (opts.area !== undefined && opts.area !== AREA_WILDCARD) {
    validateArea(opts.area);
    where.push("(area = ? OR area IS NULL)");
    params.push(opts.area);
  }
  if (opts.team !== undefined && opts.team !== TEAM_WILDCARD) {
    validateTeam(opts.team);
    where.push("team = ?");
    params.push(opts.team);
  }
  if (opts.implemented !== undefined) {
    where.push("implemented = ?");
    params.push(opts.implemented ? 1 : 0);
  }
  if (opts.since !== undefined) {
    where.push("created_at >= ?");
    params.push(opts.since);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = readDb()
    .prepare(
      `SELECT * FROM decisions${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
         ORDER BY id DESC
         LIMIT ?`,
    )
    .all(...params, limit) as DecisionRow[];
  return rows.reverse().map(toDecision);
}

function listTestResults(opts: ListTestResultsOptions = {}): TestResult[] {
  if (opts.project !== undefined && opts.project !== PROJECT_WILDCARD) validateProject(opts.project);
  if (opts.area !== undefined && opts.area !== AREA_WILDCARD) validateArea(opts.area);
  if (opts.team !== undefined && opts.team !== TEAM_WILDCARD) validateTeam(opts.team);
  validateTestResultStatus(opts.status);
  if (opts.by_agent !== undefined) validateName(opts.by_agent);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.task_id !== undefined) {
    where.push("task_id = ?");
    params.push(opts.task_id);
  }
  if (opts.by_agent !== undefined) {
    where.push("by_agent = ?");
    params.push(opts.by_agent);
  }
  if (opts.status !== undefined) {
    where.push("status = ?");
    params.push(opts.status);
  }
  if (opts.project !== undefined && opts.project !== PROJECT_WILDCARD) {
    where.push("project = ?");
    params.push(opts.project);
  }
  if (opts.area !== undefined && opts.area !== AREA_WILDCARD) {
    where.push("area = ?");
    params.push(opts.area);
  }
  if (opts.team !== undefined && opts.team !== TEAM_WILDCARD) {
    where.push("team = ?");
    params.push(opts.team);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = readDb()
    .prepare(`SELECT * FROM test_results${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, limit) as TestResultRow[];
  return rows.map(toTestResult);
}

function listMemories(opts: ListMemoriesOptions = {}): Memory[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.project !== undefined && opts.project !== PROJECT_WILDCARD) {
    validateProject(opts.project);
    where.push("(project = ? OR project IS NULL)");
    params.push(opts.project);
  }
  if (opts.area !== undefined && opts.area !== AREA_WILDCARD) {
    validateArea(opts.area);
    where.push("(area = ? OR area IS NULL)");
    params.push(opts.area);
  }
  if (opts.team !== undefined && opts.team !== TEAM_WILDCARD) {
    validateTeam(opts.team);
    where.push("team = ?");
    params.push(opts.team);
  }
  if (opts.agent !== undefined) {
    validateName(opts.agent);
    where.push("(agent = ? OR by_agent = ?)");
    params.push(opts.agent, opts.agent);
  }
  if (opts.kind !== undefined) {
    validateMemoryKind(opts.kind);
    where.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.task_id !== undefined) {
    where.push("task_id = ?");
    params.push(opts.task_id);
  }
  if (opts.thread_id !== undefined) {
    where.push("thread_id = ?");
    params.push(opts.thread_id);
  }
  if (opts.pinned !== undefined) {
    where.push("pinned = ?");
    params.push(opts.pinned ? 1 : 0);
  }
  if (opts.since !== undefined) {
    where.push("created_at >= ?");
    params.push(opts.since);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = readDb()
    .prepare(
      `SELECT * FROM memories${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
         ORDER BY id DESC
         LIMIT ?`,
    )
    .all(...params, limit) as MemoryRow[];
  return rows.reverse().map(toMemory);
}

function sessionBrief(opts: SessionBriefOptions = {}): SessionBrief {
  if (opts.agent !== undefined) validateName(opts.agent);
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const recentWindowMs = Math.min(Math.max(opts.recent_window_ms ?? 7 * 24 * 60 * 60 * 1000, 0), 365 * 24 * 60 * 60 * 1000);
  const ts = now();
  const recentSince = recentWindowMs === 0 ? ts + 1 : ts - recentWindowMs;
  const scope = { project: opts.project, area: opts.area, team: opts.team };
  const activeAgents = directory(scope).filter((agent) => agent.presence !== "stale");
  const tasks = listTasks({ ...scope, include_terminal: false, limit: 500 });
  const backlogTasks = tasks.filter((task) => task.state === "backlog").slice(0, limit);
  const openTasks = tasks.filter((task) => task.state === "open").slice(0, limit);
  const blockedTasks = tasks.filter((task) => task.state === "blocked").slice(0, limit);
  const staleTasks = tasks.filter((task) => task.stale === true).slice(0, limit);
  const recentDecisions = listDecisions({ ...scope, since: recentSince, limit });
  const pinnedMemories = listMemories({ ...scope, agent: opts.agent, pinned: true, limit: 10 })
    .slice()
    .sort((a, b) => {
      const rank = (m: Memory): number => m.kind === "handoff" ? 0 : m.kind === "risk" ? 1 : 2;
      return rank(a) - rank(b) || b.created_at - a.created_at;
    });
  const recentMemories = listMemories({ ...scope, agent: opts.agent, pinned: false, since: recentSince, limit });
  const recent = recentMessages({ ...scope, since: recentSince, limit });
  const suggested: string[] = [];
  if (blockedTasks.length > 0) suggested.push("Review blocked tasks and record the unblocker or release/reassign ownership.");
  if (staleTasks.length > 0) suggested.push("Check stale task holders before continuing or reassigning their work.");
  if (openTasks.length > 0) suggested.push("Assign or claim the highest-priority open task with an explicit mode and file scope.");
  if (backlogTasks.length > 0 && openTasks.length === 0) suggested.push("Promote a backlog item to open when the team is ready to work it.");
  if (pinnedMemories.length === 0 && recentMemories.length === 0) suggested.push("Record a handoff, risk, or todo memory before ending the session.");
  if (activeAgents.length === 0) suggested.push("Register or wake the agents needed for this project/area.");

  return {
    project: opts.project ?? null,
    area: opts.area ?? null,
    team: opts.team ?? null,
    agent: opts.agent ?? null,
    active_agents: activeAgents.slice(0, limit),
    backlog_tasks: backlogTasks,
    open_tasks: openTasks,
    blocked_tasks: blockedTasks,
    stale_tasks: staleTasks,
    recent_decisions: recentDecisions,
    pinned_memories: pinnedMemories,
    recent_memories: recentMemories,
    recent_messages: recent,
    suggested_next_actions: suggested,
  };
}

function projectBoard(opts: SessionBriefOptions = {}): ProjectBoard {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const scope = { project: opts.project, area: opts.area, team: opts.team };
  const agents = directory(scope).slice(0, limit);
  const tasks = listTasks({ ...scope, include_terminal: false, limit: 500 });
  const backlogTasks = tasks.filter((task) => task.state === "backlog").slice(0, limit);
  const openTasks = tasks.filter((task) => task.state === "open").slice(0, limit);
  const activeTasks = tasks.filter((task) => ["claimed", "working"].includes(task.state)).slice(0, limit);
  const blockedTasks = tasks.filter((task) => task.state === "blocked").slice(0, limit);
  const waitingReview = tasks
    .filter((task) => task.review_required && task.review_state === "pending")
    .slice(0, limit);
  const waitingAck = tasks
    .filter((task) => task.ack_required && task.acknowledged_at === null && (task.pending_assignee !== null || task.claimed_by !== null))
    .slice(0, limit);
  const staleTasks = tasks.filter((task) => task.stale === true).slice(0, limit);
  const ts = now();
  const overdueTasks = tasks
    .filter((task) => task.deadline_at !== null && task.deadline_at < ts && DEADLINE_ATTENTION_STATES.includes(task.state))
    .map((task) => ({ ...task, overdue: true }))
    .slice(0, limit);
  const checkinDueTasks = tasks
    .filter((task) => task.checkin_at !== null && task.checkin_at < ts && CHECKIN_ATTENTION_STATES.includes(task.state))
    .map((task) => ({ ...task, checkin_due: true }))
    .slice(0, limit);
  const scopeConflicts = tasks
    .filter((task) => task.edit_scope.length > 0 && (task.state === "claimed" || task.state === "working" || task.state === "blocked"))
    .map((task) => ({
      task_id: task.id,
      title: task.title,
      conflicts: checkScopeConflicts({
        edit_scope: task.edit_scope,
        project: task.project,
        area: task.area,
        team: task.team,
        exclude_task_id: task.id,
      }),
    }))
    .filter((row) => row.conflicts.length > 0)
    .slice(0, limit);
  const pinnedRisks = listMemories({ ...scope, kind: "risk", pinned: true, limit });
  const pinnedHandoffs = listMemories({ ...scope, kind: "handoff", pinned: true, limit });
  const suggested: string[] = [];
  if (scopeConflicts.length > 0) suggested.push("Resolve overlapping edit_scope before allowing more edits.");
  if (overdueTasks.length > 0) suggested.push("Review overdue tasks and update deadlines, blockers, or ownership.");
  if (checkinDueTasks.length > 0) suggested.push("Ask task holders for due check-ins or record current progress.");
  if (waitingAck.length > 0) suggested.push("Follow up with agents who have not acknowledged assigned work.");
  if (blockedTasks.length > 0) suggested.push("Review blocked tasks and update blockers or release ownership.");
  if (waitingReview.length > 0) suggested.push("Assign a verifier to pending review tasks.");
  if (staleTasks.length > 0) suggested.push("Check stale task holders and reassign or release if needed.");
  if (openTasks.length > 0) suggested.push("Assign or claim open tasks with explicit mode and file_scope.");
  return {
    agents,
    backlog_tasks: backlogTasks,
    open_tasks: openTasks,
    active_tasks: activeTasks,
    blocked_tasks: blockedTasks,
    waiting_review: waitingReview,
    stale_tasks: staleTasks,
    overdue_tasks: overdueTasks,
    checkin_due_tasks: checkinDueTasks,
    waiting_acknowledgement: waitingAck,
    scope_conflicts: scopeConflicts,
    pinned_risks: pinnedRisks,
    pinned_handoffs: pinnedHandoffs,
    suggested_next_actions: suggested,
  };
}

function teamBoard(opts: TeamBoardOptions): ProjectBoard {
  validateTeam(opts.team);
  return projectBoard({ ...opts, team: opts.team });
}

function activityTimeline(opts: ActivityOptions = {}): ActivityItem[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const scope = { project: opts.project, area: opts.area, team: opts.team };
  const since = opts.since ?? 0;
  const items: ActivityItem[] = [];

  for (const message of recentMessages({ ...scope, limit })) {
    if (message.created_at < since) continue;
    items.push({
      source: "message",
      at: message.created_at,
      id: message.id,
      summary: `${message.from_agent} ${message.kind === "ask" ? "asked" : message.kind === "reply" ? "replied to" : "messaged"} ${message.to_agent}: ${message.content}`,
      message,
    });
  }
  for (const event of listTaskEvents({ ...scope, limit })) {
    if (event.created_at < since) continue;
    items.push({
      source: "task_event",
      at: event.created_at,
      id: event.id,
      summary: `${event.by_agent} ${event.event_type} task #${event.task_id}${event.phase ? ` -> ${event.phase}` : ""}: ${event.message}`,
      event,
    });
  }
  for (const result of listTestResults({ ...scope, limit })) {
    if (result.created_at < since) continue;
    items.push({
      source: "test_result",
      at: result.created_at,
      id: result.id,
      summary: `${result.by_agent} recorded ${result.status} test${result.task_id ? ` for task #${result.task_id}` : ""}: ${result.command}${result.output_summary ? ` - ${result.output_summary}` : ""}`,
      test_result: result,
    });
  }
  for (const decision of listDecisions({ ...scope, limit })) {
    if (decision.created_at < since) continue;
    items.push({
      source: "decision",
      at: decision.created_at,
      id: decision.id,
      summary: `${decision.by_agent} decided: ${decision.decision}${decision.rationale ? ` - ${decision.rationale}` : ""}`,
      decision,
    });
  }
  for (const memory of listMemories({ ...scope, since, limit })) {
    items.push({
      source: "memory",
      at: memory.created_at,
      id: memory.id,
      summary: `${memory.by_agent} remembered [${memory.kind}]: ${memory.content}`,
      memory,
    });
  }

  return items
    .sort((a, b) => a.at - b.at || sourceOrder(a.source) - sourceOrder(b.source) || a.id - b.id)
    .slice(-limit);
}

function cockpit(opts: SessionBriefOptions = {}): Cockpit {
  const board = projectBoard(opts);
  const waitingOn: string[] = [];
  const ready: string[] = [];
  const blockers: string[] = [];

  for (const task of board.waiting_acknowledgement) {
    waitingOn.push(`task #${task.id} acknowledgement from ${task.pending_assignee ?? task.claimed_by ?? "assignee"}: ${task.title}`);
  }
  for (const task of board.waiting_review) {
    waitingOn.push(`task #${task.id} review: ${task.title}`);
  }
  for (const task of board.blocked_tasks) {
    blockers.push(`task #${task.id} blocked${task.blocked_reason ? `: ${task.blocked_reason}` : ""}`);
  }
  for (const task of board.overdue_tasks) {
    blockers.push(`task #${task.id} overdue: ${task.title}`);
  }
  for (const task of board.stale_tasks) {
    blockers.push(`task #${task.id} stale holder ${task.claimed_by ?? "unknown"}: ${task.title}`);
  }
  for (const task of board.checkin_due_tasks) {
    waitingOn.push(`task #${task.id} check-in due from ${task.claimed_by ?? task.pending_assignee ?? "holder"}: ${task.title}`);
  }
  for (const row of board.scope_conflicts) {
    blockers.push(`task #${row.task_id} edit scope overlaps ${row.conflicts.map((conflict) => `#${conflict.task_id}`).join(", ")}`);
  }
  const completedNeedsReview = listTasks({
    project: opts.project,
    area: opts.area,
    team: opts.team,
    state: "completed",
    include_terminal: true,
    manager_reviewed: false,
    limit: opts.limit ?? 50,
  });
  for (const task of completedNeedsReview) {
    ready.push(`task #${task.id} completed, needs manager review: ${task.title}`);
  }
  for (const task of board.open_tasks) {
    ready.push(`task #${task.id} open: ${task.title}`);
  }

  const suggested = [...board.suggested_next_actions];
  if (ready.some((item) => item.includes("completed, needs manager review"))) {
    suggested.push("Review completed tasks and set manager_reviewed when accepted.");
  }
  if (waitingOn.length === 0 && blockers.length === 0 && ready.length === 0) {
    suggested.push("No immediate manager action; check activity for recent discussion.");
  }

  return {
    waiting_on: waitingOn,
    ready,
    blockers,
    suggested_next_actions: suggested,
    board,
  };
}

function finalReport(opts: ListTasksOptions = {}): FinalReport {
  const tasks = listTasks({ ...opts, include_terminal: true, limit: opts.limit ?? 500 });
  const testResults = listTestResults({ project: opts.project, area: opts.area, team: opts.team, limit: 100 });
  const implemented = tasks
    .filter((task) => task.state === "completed")
    .map((task) => task.title);
  const notImplemented = tasks
    .filter((task) => task.state !== "backlog" && task.state !== "completed" && task.state !== "canceled")
    .map((task) => task.title);
  const knownRisks = tasks
    .filter((task) => task.blocked_reason !== null || task.state === "failed" || task.stale === true)
    .map((task) => `#${task.id} ${task.title}${task.blocked_reason ? `: ${task.blocked_reason}` : ""}`);
  const testsPassed = tasks
    .filter((task) => task.mode === "test_only" && task.state === "completed")
    .map((task) => task.final_answer ?? task.result ?? task.title);
  for (const result of testResults.filter((row) => row.status === "passed")) {
    testsPassed.push(`${result.command}${result.output_summary ? ` - ${result.output_summary}` : ""}${result.git_ref ? ` @${result.git_ref}` : ""}${result.cwd ? ` cwd=${result.cwd}` : ""}`);
  }
  const manualTestsNeeded = tasks
    .filter((task) => task.state !== "backlog" && (task.state !== "completed" || task.manager_reviewed === false || (task.review_required && task.review_state !== "approved")))
    .map((task) => task.title);
  const warnings = finalReportWarnings(opts, tasks);
  const safe = notImplemented.length === 0 && knownRisks.length === 0 && manualTestsNeeded.length === 0;
  return {
    implemented,
    not_implemented: notImplemented,
    known_risks: knownRisks,
    tests_passed: testsPassed,
    test_results: testResults,
    manual_tests_needed: manualTestsNeeded,
    warnings,
    safe_to_commit: safe,
    safe_to_push: safe,
    safe_to_deploy: false,
  };
}

function reviewGate(opts: ListTasksOptions = {}): ReviewGateReport {
  const board = projectBoard(opts);
  const report = finalReport(opts);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (board.active_tasks.length > 0) blockers.push(`${board.active_tasks.length} active task(s) still running`);
  if (board.blocked_tasks.length > 0) blockers.push(`${board.blocked_tasks.length} blocked task(s)`);
  if (board.waiting_review.length > 0) blockers.push(`${board.waiting_review.length} task(s) waiting for review`);
  if (board.waiting_acknowledgement.length > 0) warnings.push(`${board.waiting_acknowledgement.length} task(s) waiting for acknowledgement`);
  if (board.overdue_tasks.length > 0) blockers.push(`${board.overdue_tasks.length} overdue task(s)`);
  if (board.checkin_due_tasks.length > 0) warnings.push(`${board.checkin_due_tasks.length} task(s) due for check-in`);
  if (board.stale_tasks.length > 0) warnings.push(`${board.stale_tasks.length} stale task holder(s)`);
  if (board.scope_conflicts.length > 0) blockers.push(`${board.scope_conflicts.length} edit scope conflict(s)`);
  warnings.push(...report.warnings);
  if (!report.safe_to_commit) blockers.push("final_report says safe_to_commit=false");
  if (!report.safe_to_push) blockers.push("final_report says safe_to_push=false");
  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    final_report: report,
    board,
  };
}

function validateProject(project: string | null | undefined): void {
  validateScopeName("project", project);
}

function validateArea(area: string | null | undefined): void {
  if (area === AREA_WILDCARD) return;
  validateScopeName("area", area);
}

function validateTeam(team: string | null | undefined): void {
  if (team === TEAM_WILDCARD) return;
  validateScopeName("team", team);
}

function validateName(name: string): void {
  if (typeof name !== "string" || name.length === 0 || name.length > 64) {
    throw new BusError("INVALID_INPUT", "name must be 1-64 chars");
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    throw new BusError("INVALID_INPUT", "name may only contain letters, digits, _ . -");
  }
}

function readPreviewInbox(opts: InboxOptions): Message[] {
  const db = readDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const since = opts.since_id ?? 0;
  const ts = deliveryNow();
  const teamFilter = opts.team !== undefined && opts.team !== TEAM_WILDCARD ? opts.team : null;
  const where = [
    "to_agent = ?",
    "id > ?",
    "status = 'pending'",
    "(claim_deadline IS NULL OR claim_deadline <= ?)",
  ];
  const params: unknown[] = [opts.agent, since, ts];
  if (opts.project !== undefined && opts.project !== PROJECT_WILDCARD) {
    where.push("project = ?");
    params.push(opts.project);
  }
  if (opts.area !== undefined && opts.area !== AREA_WILDCARD) {
    where.push("area = ?");
    params.push(opts.area);
  }
  if (teamFilter !== null) {
    where.push("team = ?");
    params.push(teamFilter);
  }
  if (opts.thread_id !== undefined) {
    where.push("thread_id = ?");
    params.push(opts.thread_id);
  }

  const rows = db
    .prepare(
      `SELECT * FROM messages
         WHERE ${where.join("\n           AND ")}
         ORDER BY CASE priority
           WHEN 'urgent' THEN 3
           WHEN 'high' THEN 2
           WHEN 'normal' THEN 1
           ELSE 0
         END DESC, id ASC
         LIMIT ?`,
    )
    .all(...params, limit) as MessageRow[];

  return rows.map(toMessage);
}
async function previewInbox(opts:InboxOptions):Promise<Message[]> {
 if(requireAgent(opts.agent).paused)return [];
 const deadline=now()+Math.min(opts.wait_s??0,110)*1000;
 while(true){const rows=readPreviewInbox(opts);if(rows.length||now()>=deadline)return rows;await sleep(POLL_INTERVAL_MS);}
}
function readInboxPreviews(opts: InboxPreviewOptions): MessagePreview[] {
  const db = readDb();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const since = opts.since_id ?? 0;
  const ts = deliveryNow();
  const teamFilter = opts.team !== undefined && opts.team !== TEAM_WILDCARD ? opts.team : null;
  const where = [
    "to_agent = ?",
    "id > ?",
    "status = 'pending'",
    "(claim_deadline IS NULL OR claim_deadline <= ?)",
  ];
  const params: unknown[] = [opts.agent, since, ts];
  if (opts.project !== undefined && opts.project !== PROJECT_WILDCARD) {
    where.push("project = ?");
    params.push(opts.project);
  }
  if (opts.area !== undefined && opts.area !== AREA_WILDCARD) {
    where.push("area = ?");
    params.push(opts.area);
  }
  if (teamFilter !== null) {
    where.push("team = ?");
    params.push(teamFilter);
  }
  if (opts.thread_id !== undefined) {
    where.push("thread_id = ?");
    params.push(opts.thread_id);
  }
  const rows = db
    .prepare(
      `SELECT * FROM messages
         WHERE ${where.join("\n           AND ")}
         ORDER BY CASE priority
           WHEN 'urgent' THEN 3
           WHEN 'high' THEN 2
           WHEN 'normal' THEN 1
           ELSE 0
         END DESC, id ASC
         LIMIT ?`,
    )
    .all(...params, limit) as MessageRow[];
  return rows.map((row) => toMessagePreview(row, opts.preview_chars));
}

function getMessageRow(id: number): MessageRow {
  const row = readDb()
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(id) as MessageRow | undefined;
  if (!row) throw new BusError("MESSAGE_NOT_FOUND", `no message with id ${id}`);
  return row;
}

function assertMessageInScope(
  row: MessageRow,
  scope: { project?: string; area?: string; team?: string },
): void {
  validateProject(scope.project);
  validateArea(scope.area);
  validateTeam(scope.team);
  const mismatches: string[] = [];
  if (scope.project !== undefined && scope.project !== PROJECT_WILDCARD && row.project !== scope.project) {
    mismatches.push(`project=${row.project ?? "none"}`);
  }
  if (scope.area !== undefined && scope.area !== AREA_WILDCARD && row.area !== scope.area) {
    mismatches.push(`area=${row.area ?? "none"}`);
  }
  if (scope.team !== undefined && scope.team !== TEAM_WILDCARD && row.team !== scope.team) {
    mismatches.push(`team=${row.team ?? "none"}`);
  }
  if (mismatches.length > 0) {
    const expected = [
      scope.project !== undefined && scope.project !== PROJECT_WILDCARD ? `project=${scope.project}` : null,
      scope.area !== undefined && scope.area !== AREA_WILDCARD ? `area=${scope.area}` : null,
      scope.team !== undefined && scope.team !== TEAM_WILDCARD ? `team=${scope.team}` : null,
    ].filter(Boolean).join(", ");
    throw new BusError(
      "MESSAGE_NOT_FOUND",
      `message ${row.id} is outside requested scope (${expected}); actual ${mismatches.join(", ")}`,
    );
  }
}

function toMessagePreview(row: MessageRow, previewChars = 300): MessagePreview {
  const message = toMessage(row);
  const { content, ...withoutContent } = message;
  return {
    ...withoutContent,
    ...previewContent(content, Math.min(Math.max(previewChars, 0), 4000)),
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    kind: row.kind,
    content: row.content,
    reply_to: row.reply_to,
    status: row.status,
    created_at: row.created_at,
    delivered_at: row.delivered_at,
    replied_at: row.replied_at,
    thread_id: row.thread_id ?? "",
    claim_deadline: row.claim_deadline,
    claimed_by: row.claimed_by,
    channel: row.channel,
    project: row.project,
    area: row.area,
    team: row.team,
    priority: row.priority,
  };
}

function toTask(row: TaskRow, lastSeenByAgent?: Map<string, number>): Task {
  const task: Task = {
    id: row.id,
    title: row.title,
    description: row.description,
    thread_id: row.thread_id,
    requested_by: row.requested_by,
    claimed_by: row.claimed_by,
    state: row.state,
    milestone: row.milestone,
    priority: row.priority,
    cwd: row.cwd,
    blocked_reason: row.blocked_reason,
    blocked_on_task_id: row.blocked_on_task_id,
    result: row.result,
    created_at: row.created_at,
    updated_at: row.updated_at,
    claimed_at: row.claimed_at,
    finished_at: row.finished_at,
    project: row.project,
    area: row.area,
    team: row.team,
    required_capability: row.required_capability,
    mode: row.mode,
    expected_output: row.expected_output,
    deadline_at: row.deadline_at,
    checkin_at: row.checkin_at,
    final_answer: row.final_answer,
    manager_reviewed: row.manager_reviewed === 1,
    file_scope: JSON.parse(row.file_scope) as string[],
    edit_scope: JSON.parse(row.edit_scope) as string[],
    read_scope: JSON.parse(row.read_scope) as string[],
    ack_required: row.ack_required === 1,
    acknowledged_at: row.acknowledged_at,
    acknowledged_by: row.acknowledged_by,
    review_required: row.review_required === 1,
    independent_review: row.independent_review === 1,
    review_state: row.review_state,
    reviewed_by: row.reviewed_by,
    review_notes: row.review_notes,
    changed_files: JSON.parse(row.changed_files) as string[],
    pending_assignee: row.pending_assignee,
    phase: row.phase,
    session_id: row.session_id,
  };
  if (
    lastSeenByAgent &&
    row.claimed_by &&
    ACTIVE_TASK_STATES.includes(row.state)
  ) {
    const lastSeen = lastSeenByAgent.get(row.claimed_by);
    if (lastSeen !== undefined) {
      task.stale = now() - lastSeen > TASK_STALE_THRESHOLD_MS;
    }
  }
  return Object.assign(task,{wait_kind:(row as unknown as Row).wait_kind,human_question_id:(row as unknown as Row).human_question_id,task_revision:(row as unknown as Row).task_revision,stale_basis:'legacy_saved_last_seen; not OS liveness'});
}

function lastSeenMap(): Map<string, number> {
  const rows = readDb()
    .prepare("SELECT name, last_seen FROM agents")
    .all() as { name: string; last_seen: number }[];
  return new Map(rows.map((r) => [r.name, r.last_seen]));
}

function scopesOverlap(a: string, b: string): boolean {
  const left = scopeBase(a);
  const right = scopeBase(b);
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function validateTaskMode(mode: TaskMode | undefined): void {
  if (mode === undefined) return;
  if (!["investigate_only", "propose_patch", "edit_files", "test_only"].includes(mode)) {
    throw new BusError("INVALID_INPUT", "mode must be investigate_only, propose_patch, edit_files, or test_only");
  }
}

function validateMilestone(milestone: string | null | undefined): void {
  if (milestone === undefined || milestone === null) return;
  if (typeof milestone !== "string" || milestone.length === 0 || milestone.length > 120) {
    throw new BusError("INVALID_INPUT", "milestone must be 1-120 chars or null");
  }
}

function getTaskRow(id: number): TaskRow {
  const row = readDb()
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(id) as TaskRow | undefined;
  if (!row) throw new BusError("TASK_NOT_FOUND", `no task with id ${id}`);
  return row;
}

function validateTaskEventType(eventType: TaskEventType | undefined): void {
  if (eventType === undefined) return;
  if (!["note", "phase", "progress", "log", "result", "cancel"].includes(eventType)) {
    throw new BusError("INVALID_INPUT", "event_type must be note, phase, progress, log, result, or cancel");
  }
}

function validateTestResultStatus(status: TestResultStatus | undefined): void {
  if (status === undefined) return;
  if (!["passed", "failed", "skipped"].includes(status)) {
    throw new BusError("INVALID_INPUT", "status must be passed, failed, or skipped");
  }
}

function validateMemoryKind(kind: string): void {
  if (typeof kind !== "string" || kind.length === 0 || kind.length > 64) {
    throw new BusError("INVALID_INPUT", "kind must be 1-64 chars");
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(kind)) {
    throw new BusError("INVALID_INPUT", "kind may only contain letters, digits, _ . -");
  }
}

function sourceOrder(source: ActivityItem["source"]): number {
  switch (source) {
    case "message":
      return 0;
    case "task_event":
      return 1;
    case "test_result":
      return 2;
    case "decision":
      return 3;
    case "memory":
      return 4;
  }
}

function finalReportWarnings(opts: ListTasksOptions, tasks: Task[]): string[] {
  const implementationTasks = tasks.filter((task) =>
    task.state === "completed" &&
    (task.mode === "edit_files" || task.mode === "propose_patch")
  );
  if (implementationTasks.length < 2) return [];
  const decisions = listDecisions({ project: opts.project, area: opts.area, team: opts.team, limit: 1 });
  const memories = listMemories({ project: opts.project, area: opts.area, team: opts.team, limit: 1 });
  if (decisions.length > 0 || memories.length > 0) return [];
  return [
    `${implementationTasks.length} completed implementation/proposal task(s), but no decisions or memories exist in this scope; briefs may lack reusable context. Record decisions, lessons, risks, or handoff notes when they are transferable.`,
  ];
}

function validateScopeName(kind: "project" | "area" | "team" | "role", value: string | null | undefined): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw new BusError("INVALID_INPUT", `${kind} must be 1-64 chars or omitted`);
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) {
    throw new BusError(
      "INVALID_INPUT",
      `${kind} may only contain letters, digits, _ . -`,
    );
  }
}

function previewContent(content: string, previewChars: number): { content_preview: string; content_length: number; truncated: boolean } {
  const contentLength = content.length;
  const truncated = contentLength > previewChars;
  return {
    content_preview: truncated ? content.slice(0, previewChars) : content,
    content_length: contentLength,
    truncated,
  };
}

function scopeBase(pattern: string): string {
  const trimmed = pattern.trim().replace(/^\.\/+/, "");
  const wildcard = trimmed.search(/[*?[{]/);
  const raw = wildcard >= 0 ? trimmed.slice(0, wildcard) : trimmed;
  const slash = raw.lastIndexOf("/");
  if (wildcard >= 0) return raw.slice(0, slash + 1);
  return raw.endsWith("/") ? raw : raw;
}
return {previewInbox,whois,directory,waitForAgents,inboxPreviews,getMessage,inboxStatus,messageStatus,whyNoReply,recentMessages,threadMessages,checkScopeConflicts,listTasks,getTask,listTaskEvents,taskResult,waitForTask,listDecisions,listTestResults,listMemories,sessionBrief,projectBoard,teamBoard,activityTimeline,cockpit,finalReport,reviewGate};
}
