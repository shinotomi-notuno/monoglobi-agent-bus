import {z} from 'zod';
const TASK_STATES = [
  "backlog",
  "open",
  "claimed",
  "working",
  "blocked",
  "completed",
  "failed",
  "canceled",
] as const;
const TaskStateEnum = z.enum(TASK_STATES);
const AgentStatusEnum = z.enum(["idle", "working", "blocked", "waiting_review", "sleeping"]);
const TaskModeEnum = z.enum(["investigate_only", "propose_patch", "edit_files", "test_only"]);

// project filter accepts "*" (global) or a project slug or null/omit (default scope)
const ProjectField = z.string().min(1).max(64).nullable().optional();
const ProjectFilterField = z.string().min(1).max(64).optional();
const AreaField = z.string().min(1).max(64).nullable().optional();
const AreaFilterField = z.string().min(1).max(64).optional();
const TeamField = z.string().min(1).max(64).nullable().optional();
const TeamFilterField = z.string().min(1).max(64).optional();

const RegisterInput = z.object({
  name: z.string().min(1).max(64),
  capabilities: z.array(z.string()).max(32).optional(),
  replace: z.boolean().optional(),
  project: ProjectField,
  area: AreaField,
  team: TeamField,
  role: z.string().min(1).max(64).nullable().optional(),
  routing_weight: z.number().int().optional(),
  status: AgentStatusEnum.optional(),
  session_id: z.string().min(1).max(128).nullable().optional(),
});

const RemoveAgentInput = z.object({
  name: z.string().min(1).max(64),
  release_tasks: z.boolean().optional(),
  force: z.boolean().optional(),
});

const DeleteTeamInput = z.object({
  team: z.string().min(1).max(64),
  project: ProjectFilterField,
  area: AreaFilterField,
  release_tasks: z.boolean().optional(),
  force: z.boolean().optional(),
});

const SendInput = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  message: z.string(),
  thread_id: z.string().optional(),
});

const InboxInput = z.object({
  agent: z.string().min(1),
  project: ProjectFilterField,
  area: AreaFilterField,
  team: TeamFilterField,
  thread_id: z.string().min(1).optional(),
  since_id: z.number().int().nonnegative().optional(),
  mark_delivered: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
  wait_s: z.number().int().positive().max(110).optional(),
  claim_s: z.number().int().positive().max(3600).optional(),
});

const InboxPreviewsInput = z.object({
  agent: z.string().min(1),
  project: ProjectFilterField,
  area: AreaFilterField,
  team: TeamFilterField,
  thread_id: z.string().min(1).optional(),
  since_id: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(100).optional(),
  wait_s: z.number().int().positive().max(110).optional(),
  preview_chars: z.number().int().nonnegative().max(4000).optional(),
});

const AckInput = z.object({
  agent: z.string().min(1),
  message_id: z.number().int().positive(),
});

const GetMessageInput = z.object({
  message_id: z.number().int().positive(),
  preview_chars: z.number().int().nonnegative().max(4000).optional(),
  include_content: z.boolean().optional(),
  project: ProjectFilterField,
  area: AreaFilterField,
  team: TeamFilterField,
});

const AskInput = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  question: z.string(),
  timeout_s: z.number().int().positive().max(110).optional(),
  thread_id: z.string().optional(),
});

const AskAsyncInput = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  question: z.string(),
  thread_id: z.string().optional(),
});

const AskBestInput = z.object({
  from: z.string().min(1),
  capability: z.string().min(1),
  question: z.string(),
  timeout_s: z.number().int().positive().max(110).optional(),
  thread_id: z.string().optional(),
  project: ProjectFilterField,
  area: AreaFilterField,
  team: TeamFilterField,
  role: z.string().min(1).max(64).optional(),
});

const SendTeamInput = z.object({
  from: z.string().min(1),
  team: TeamFilterField,
  message: z.string(),
  thread_id: z.string().optional(),
  project: ProjectFilterField,
  area: AreaFilterField,
  include_self: z.boolean().optional(),
});

const AskTeamInput = z.object({
  from: z.string().min(1),
  team: TeamFilterField,
  question: z.string(),
  timeout_s: z.number().int().positive().max(110).optional(),
  thread_id: z.string().optional(),
  project: ProjectFilterField,
  area: AreaFilterField,
  capability: z.string().min(1).optional(),
  role: z.string().min(1).max(64).optional(),
});

const ReplyInput = z.object({
  from: z.string().min(1),
  ask_id: z.number().int().positive(),
  answer: z.string(),
});

const SubscribeInput = z.object({
  agent: z.string().min(1),
  channel: z.string().min(1).max(64),
});

const SendChannelInput = z.object({
  from: z.string().min(1),
  channel: z.string().min(1).max(64),
  message: z.string(),
  thread_id: z.string().optional(),
});

const SubscribersInput = z.object({
  channel: z.string().min(1).max(64),
});

const ThreadInput = z.object({
  thread_id: z.string().min(1),
  limit: z.number().int().positive().max(500).optional(),
});

const WhoisInput = z.object({
  project: ProjectFilterField,
  area: AreaFilterField,
  team: TeamFilterField,
});

const WaitForAgentsInput = z.object({
  names: z.array(z.string().min(1)).min(1),
  project: ProjectFilterField,
  area: AreaFilterField,
  team: TeamFilterField,
  timeout_s: z.number().int().nonnegative().max(110).optional(),
});

const CreateTaskInput = z.object({
  requested_by: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  thread_id: z.string().optional(),
  state: z.enum(["backlog", "open"]).optional(),
  milestone: z.string().min(1).max(120).nullable().optional(),
  priority: z.number().int().optional(),
  cwd: z.string().optional(),
  blocked_on_task_id: z.number().int().positive().optional(),
  project: ProjectField,
  area: AreaField,
  team: TeamField,
  required_capability: z.string().min(1).nullable().optional(),
  mode: TaskModeEnum.optional(),
  expected_output: z.string().nullable().optional(),
  deadline_at: z.number().int().positive().nullable().optional(),
  checkin_at: z.number().int().positive().nullable().optional(),
  final_answer: z.string().nullable().optional(),
  manager_reviewed: z.boolean().optional(),
  file_scope: z.array(z.string()).optional(),
  edit_scope: z.array(z.string()).optional(),
  read_scope: z.array(z.string()).optional(),
  ack_required: z.boolean().optional(),
  review_required: z.boolean().optional(),
  independent_review: z.boolean().optional(),
  changed_files: z.array(z.string()).optional(),
  phase: z.string().nullable().optional(),
  session_id: z.string().min(1).max(128).nullable().optional(),
  allow_conflicts: z.boolean().optional(),
});

const DelegateInput = CreateTaskInput.omit({ requested_by: true, state: true }).extend({
  from: z.string().min(1),
  to_agent: z.string().min(1),
  allow_pending_agent: z.boolean().optional(),
});

const DelegateTeamInput = DelegateInput.omit({ to_agent: true, allow_pending_agent: true }).extend({
  team: TeamFilterField,
  capability: z.string().min(1).optional(),
  role: z.string().min(1).max(64).optional(),
  include_self: z.boolean().optional(),
  max_recipients: z.number().int().positive().max(100).optional(),
});

const ClaimTaskInput = z.object({
  agent: z.string().min(1),
  task_id: z.number().int().positive(),
  allow_conflicts: z.boolean().optional(),
});

const AssignTaskInput = z.object({
  task_id: z.number().int().positive(),
  to_agent: z.string().min(1),
  allow_conflicts: z.boolean().optional(),
  allow_pending_agent: z.boolean().optional(),
});

const ClaimBestTaskInput = z.object({
  agent: z.string().min(1),
  project: ProjectFilterField,
  area: AreaFilterField,
  team: TeamFilterField,
});

const UpdateTaskInput = z.object({
  agent: z.string().min(1),
  task_id: z.number().int().positive(),
  state: TaskStateEnum.optional(),
  milestone: z.string().min(1).max(120).nullable().optional(),
  blocked_reason: z.string().nullable().optional(),
  blocked_on_task_id: z.number().int().positive().nullable().optional(),
  result: z.string().nullable().optional(),
  priority: z.number().int().optional(),
  mode: TaskModeEnum.optional(),
  expected_output: z.string().nullable().optional(),
  deadline_at: z.number().int().positive().nullable().optional(),
  checkin_at: z.number().int().positive().nullable().optional(),
  final_answer: z.string().nullable().optional(),
  manager_reviewed: z.boolean().optional(),
  file_scope: z.array(z.string()).optional(),
  edit_scope: z.array(z.string()).optional(),
  read_scope: z.array(z.string()).optional(),
  ack_required: z.boolean().optional(),
  review_required: z.boolean().optional(),
  independent_review: z.boolean().optional(),
  review_state: z.enum(["none", "pending", "approved", "changes_requested"]).optional(),
  reviewed_by: z.string().min(1).nullable().optional(),
  review_notes: z.string().nullable().optional(),
  changed_files: z.array(z.string()).optional(),
  phase: z.string().nullable().optional(),
  session_id: z.string().min(1).max(128).nullable().optional(),
  allow_conflicts: z.boolean().optional(),
});

const RecordTaskEventInput = z.object({
  by_agent: z.string().min(1),
  task_id: z.number().int().positive(),
  event_type: z.enum(["note", "phase", "progress", "log", "result", "cancel"]).optional(),
  message: z.string().min(1),
  phase: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const ListTaskEventsInput = z.object({
  task_id: z.number().int().positive().optional(),
  by_agent: z.string().min(1).optional(),
  event_type: z.enum(["note", "phase", "progress", "log", "result", "cancel"]).optional(),
  project: ProjectFilterField,
  area: AreaFilterField,
  team: TeamFilterField,
  limit: z.number().int().positive().max(500).optional(),
});

const TaskResultInput = z.object({
  task_id: z.number().int().positive(),
  limit: z.number().int().positive().max(500).optional(),
});

const WaitForTaskInput = z.object({
  task_id: z.number().int().positive(),
  wait_s: z.number().int().nonnegative().max(110).optional(),
  since_updated_at: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const InboxStatusInput = z.object({
  agent: z.string().min(1),
  project: ProjectFilterField,
  area: AreaFilterField,
  team: TeamFilterField,
  thread_id: z.string().min(1).optional(),
  since_id: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const MessageStatusInput = z.object({
  message_id: z.number().int().positive(),
});

const ReplyThreadInput = z.object({
  from: z.string().min(1),
  thread_id: z.string().min(1),
  message: z.string(),
});

const CancelTaskInput = z.object({
  agent: z.string().min(1),
  task_id: z.number().int().positive(),
  reason: z.string().nullable().optional(),
});

const AcknowledgeTaskInput = z.object({
  agent: z.string().min(1),
  task_id: z.number().int().positive(),
  response: z.enum(["claimed", "declined", "blocked"]),
  note: z.string().nullable().optional(),
});

const SubmitReviewInput = z.object({
  reviewer: z.string().min(1),
  task_id: z.number().int().positive(),
  approved: z.boolean(),
  notes: z.string().nullable().optional(),
});

const HandoffTaskInput = z.object({
  from_agent: z.string().min(1),
  task_id: z.number().int().positive(),
  to_agent: z.string().min(1).nullable().optional(),
  reason: z.string().min(1),
  memory: z.string().nullable().optional(),
});

const CheckScopeConflictsInput = z.object({
  file_scope: z.array(z.string()).optional(),
  edit_scope: z.array(z.string()).optional(),
  project: ProjectField,
  area: AreaField,
  team: TeamField,
  exclude_task_id: z.number().int().positive().optional(),
});

const RecordTestResultInput = z.object({
  by_agent: z.string().min(1),
  task_id: z.number().int().positive().nullable().optional(),
  command: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  output_summary: z.string().nullable().optional(),
  git_ref: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  project: ProjectField,
  area: AreaField,
  team: TeamField,
});

const ListTestResultsInput = z.object({
  task_id: z.number().int().positive().optional(),
  by_agent: z.string().min(1).optional(),
  status: z.enum(["passed", "failed", "skipped"]).optional(),
  project: ProjectFilterField,
  area: AreaFilterField,
  team: TeamFilterField,
  limit: z.number().int().positive().max(500).optional(),
});

const SetAgentStatusInput = z.object({
  agent: z.string().min(1),
  status: AgentStatusEnum,
});

const ReleaseTaskInput = z.object({
  agent: z.string().min(1),
  task_id: z.number().int().positive(),
});

const ListTasksInput = z.object({
  state: z.union([TaskStateEnum, z.array(TaskStateEnum)]).optional(),
  milestone: z.string().min(1).max(120).optional(),
  claimed_by: z.string().optional(),
  requested_by: z.string().optional(),
  thread_id: z.string().optional(),
  include_terminal: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
  project: ProjectFilterField,
  area: AreaFilterField,
  team: TeamFilterField,
  required_capability: z.string().min(1).optional(),
  mode: TaskModeEnum.optional(),
  manager_reviewed: z.boolean().optional(),
});

const GetTaskInput = z.object({
  task_id: z.number().int().positive(),
});

const RecentInput = z.object({
  limit: z.number().int().positive().max(500).optional(),
  project: ProjectFilterField,
  area: AreaFilterField,
  team: TeamFilterField,
});

const RecordDecisionInput = z.object({
  by_agent: z.string().min(1),
  decision: z.string().min(1),
  rationale: z.string().nullable().optional(),
  implemented: z.boolean().optional(),
  project: ProjectField,
  area: AreaField,
  team: TeamField,
});

const ListDecisionsInput = z.object({
  project: ProjectFilterField,
  area: AreaFilterField,
  team: TeamFilterField,
  implemented: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const RememberInput = z.object({
  by_agent: z.string().min(1),
  kind: z.string().min(1).max(64),
  content: z.string().min(1),
  agent: z.string().min(1).nullable().optional(),
  project: ProjectField,
  area: AreaField,
  team: TeamField,
  task_id: z.number().int().positive().nullable().optional(),
  thread_id: z.string().min(1).nullable().optional(),
  pinned: z.boolean().optional(),
  supersedes_id: z.number().int().positive().nullable().optional(),
});

const ListMemoriesInput = z.object({
  project: ProjectFilterField,
  area: AreaFilterField,
  team: TeamFilterField,
  agent: z.string().min(1).optional(),
  kind: z.string().min(1).max(64).optional(),
  task_id: z.number().int().positive().optional(),
  thread_id: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
  since: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const PinMemoryInput = z.object({
  memory_id: z.number().int().positive(),
});

const SessionBriefInput = z.object({
  project: ProjectFilterField,
  area: AreaFilterField,
  team: TeamFilterField,
  agent: z.string().min(1).optional(),
  limit: z.number().int().positive().max(50).optional(),
  recent_window_ms: z.number().int().nonnegative().optional(),
});

const TeamBoardInput = z.object({
  team: z.string().min(1).max(64),
  project: ProjectFilterField,
  area: AreaFilterField,
  limit: z.number().int().positive().max(100).optional(),
});

const ActivityInput = z.object({
  project: ProjectFilterField,
  area: AreaFilterField,
  team: TeamFilterField,
  since: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

const NowInput = z.object({
  agent: z.string().min(1),
  task_id: z.number().int().positive().optional(),
  phase: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  status: AgentStatusEnum.optional(),
});


export const legacyInputs:Record<string ,
 z.AnyZodObject>={
 register:RegisterInput.strict() ,
 delete_team:DeleteTeamInput.strict() ,
 send:SendInput.strict() ,
 send_team:SendTeamInput.strict() ,
 ask_best:AskBestInput.strict() ,
 ask_team:AskTeamInput.strict() ,
 send_channel:SendChannelInput.strict() ,
 thread:ThreadInput.strict() ,
 whois:WhoisInput.strict() ,
 directory:WhoisInput.strict() ,
 wait_for_agents:WaitForAgentsInput.strict() ,
 recent:RecentInput.strict() ,
 create_task:CreateTaskInput.strict() ,
 delegate:DelegateInput.strict() ,
 delegate_team:DelegateTeamInput.strict() ,
 set_agent_status:SetAgentStatusInput.strict() ,
 claim_best_task:ClaimBestTaskInput.strict() ,
 check_scope_conflicts:CheckScopeConflictsInput.strict() ,
 record_test_result:RecordTestResultInput.strict() ,
 list_test_results:ListTestResultsInput.strict() ,
 list_task_events:ListTaskEventsInput.strict() ,
 task_result:TaskResultInput.strict() ,
 wait_for_task:WaitForTaskInput.strict() ,
 list_tasks:ListTasksInput.strict() ,
 activity:ActivityInput.strict() ,
 cockpit:SessionBriefInput.strict() ,
 record_decision:RecordDecisionInput.strict() ,
 list_decisions:ListDecisionsInput.strict() ,
 remember:RememberInput.strict() ,
 list_memories:ListMemoriesInput.strict() ,
 pin_memory:PinMemoryInput.strict() ,
 unpin_memory:PinMemoryInput.strict() ,
 session_brief:SessionBriefInput.strict() ,
 project_board:SessionBriefInput.strict() ,
 team_board:TeamBoardInput.strict() ,
 final_report:WhoisInput.strict() ,
 review_gate:WhoisInput.strict() ,
 ack:AckInput.strict() ,
 get_task:GetTaskInput.strict() ,
 why_no_reply:MessageStatusInput.strict() ,
 remove_agent:RemoveAgentInput.strict() ,
 inbox:InboxInput.strict() ,
 inbox_previews:InboxPreviewsInput.strict() ,
 inbox_status:InboxStatusInput.strict() ,
 get_message:GetMessageInput.strict() ,
 ask:AskInput.strict() ,
 ask_async:AskAsyncInput.strict() ,
 reply:ReplyInput.strict() ,
 reply_thread:ReplyThreadInput.strict() ,
 message_status:MessageStatusInput.strict() ,
 subscribe:SubscribeInput.strict() ,
 subscribers:SubscribersInput.strict() ,
 claim_task:ClaimTaskInput.strict() ,
 assign_task:AssignTaskInput.strict() ,
 update_task:UpdateTaskInput.strict() ,
 release_task:ReleaseTaskInput.strict() ,
 acknowledge_task:AcknowledgeTaskInput.strict() ,
 submit_review:SubmitReviewInput.strict() ,
 handoff_task:HandoffTaskInput.strict() ,
 record_task_event:RecordTaskEventInput.strict() ,
 cancel_task:CancelTaskInput.strict() ,
 now:NowInput.strict()};

// Core exports historically have a wider recent/thread limit than MCP.
export const legacyCoreInputs:Record<string,z.AnyZodObject>={...legacyInputs,
 recent:legacyInputs.recent!.extend({limit:z.number().int().optional(),thread_id:z.string().optional(),since_id:z.number().int().nonnegative().optional(),since:z.number().int().nonnegative().optional()}),
 thread:legacyInputs.thread!.extend({limit:z.number().int().optional()}),
 final_report:ListTasksInput.strict(),review_gate:ListTasksInput.strict(),
};
// Preserve legacy core's bounded/clamped numeric options; public MCP schemas
// retain their advertised maxima. Neither surface accepts unknown fields.
for(const [name,schema] of Object.entries(legacyCoreInputs)){
 const shape:z.ZodRawShape={};
 for(const key of ['limit','preview_chars','wait_s','timeout_s'])if(key in schema.shape)shape[key]=z.number().int().safe().optional();
 for(const key of ['project','area','team'])if(key in schema.shape)shape[key]=z.string().nullable().optional();
 legacyCoreInputs[name]=schema.extend(shape).strict();
}
