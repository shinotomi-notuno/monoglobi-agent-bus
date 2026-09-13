import {z} from 'zod';
import {guardNormalStartup} from './recovery-entry.js';
import {LegacyAdapter,legacyGroups,legacyPublished,legacyError,replacement} from './legacy-adapter.js';
import {legacyInputs} from './legacy-input.js';
import {BusError} from '../util/errors.js';
import {taskInputs,taskInputError} from './task-input.js';
import {Queries} from './queries.js';
import {Registration} from './registration.js';
import {Observation,safeCode} from './observation.js';
import type {Scope,Row} from './schema.js';
export type Tool={name:string;description:string;schema:z.AnyZodObject;write:boolean;legacy?:boolean;call:(a:any)=>any};
const id=z.number().int().min(1),rev=z.number().int().min(0),str=z.string().min(1).regex(/\S/);
const envelope=z.object({origin_instance_uuid:str,actor:str,session_id:str,request_id:str}).strict();
const page=z.object({cursor:z.string().optional(),limit:z.number().int().min(1).max(500).optional()}).strict();
const contextPage=page.extend({context_token:z.string().optional()});
const reason={reason:str,evidence_ref:str};
const pending:string[]=[];
/** One definition list drives dispatch, JSON schema and the published manifest. */
export class ToolRuntime {
 readonly reader:Queries;
 readonly writer:Registration;
 readonly observer:Observation;
 readonly tools:Tool[];
 private legacyAdapter?:LegacyAdapter;
 private observing=false;
 private suppressCloseWrites=false;
 private closed=false;
 constructor(path:string,scope:Scope,readonly writersEnabled=false,readonly legacyEnabled=false){
  if(writersEnabled)guardNormalStartup(path);
  this.reader=new Queries(path,scope);
  try{this.writer=new Registration(path,scope);}catch(e){this.reader.close();throw e;}
  this.observer=new Observation(this.writer.db,this.writer.sid);
  const q=this.reader,w=this.writer;
  const read=(name:string,description:string,schema:z.AnyZodObject,call:(a:any)=>Row):Tool=>({name,description,schema,call,write:false});
  const write=(name:string,description:string,shape:z.ZodRawShape,call:(a:any,e:any)=>Row):Tool=>({name,description,schema:z.object({...shape,envelope}).strict(),write:true,call:a=>{const {envelope:e,...args}=a;return call(args,e);}});
  this.tools=[
   read('list_errors_v2','Scoped error pages with partial coverage.',page.extend({task_id:id.optional(),code:z.string().max(64).optional(),source:z.enum(['bus','agent_report']).optional()}),a=>q.listErrors(a)),
   read('get_error_v2','One scoped structured error.',z.object({error_id:id}).strict(),a=>q.getError(a.error_id)),
   read('list_communication_events_v2','Saved membership, not current task links.',page.extend({task_id:id.optional()}),a=>q.listCommunicationEvents(a)),
   read('status_summary_v2','Bounded status with saved Agent update time and one representative Session; no OS liveness.',z.object({task_id:id.optional(),limit:id.max(100).optional()}).strict(),a=>q.statusSummary(a)),
   read('open_task_context','Pin references without reading bodies.',z.object({task_id:id}).strict(),a=>q.openTaskContext(a.task_id)),
   read('task_context_v2','Bounded summary and references.',z.object({task_id:id}).strict(),a=>q.taskContext(a.task_id)),
   read('v2_capabilities','Actual public tools and remaining development boundaries.',z.object({}).strict(),()=>this.capabilities()),
   read('list_tasks_v2','Task metadata page; fetch only needed pages.',page,a=>q.listTasks(a)),
   read('list_conversations_v2','Conversation metadata page.',page,a=>q.listConversations(a)),
   read('list_task_conversations_v2','Links at fixed revision.',contextPage.extend({task_id:id}),a=>{const {task_id,...p}=a;return q.listLinks(task_id,p);}),
   read('list_thread_messages_v2','Explicit conversation metadata.',contextPage.extend({conversation_id:id}),a=>{const {conversation_id,...p}=a;return q.listMessages(conversation_id,p);}),
   read('get_message_v2','Explicit UTF-8 body chunk.',z.object({message_id:id,body_cursor:z.string().optional(),max_bytes:id.min(4).max(65536).optional()}).strict(),a=>q.getMessage(a.message_id,a)),
  ];
  if(legacyEnabled){
   this.legacyAdapter=new LegacyAdapter(path,scope);
   this.tools.push(...legacyPublished.map(name=>({name,description:`Legacy ${Object.entries(legacyGroups).find(([,names])=>names.includes(name))![0]}; bounded scoped compatibility, no writes. Replacement: ${replacement(name)}.`,schema:legacyInputs[name]!,write:false,legacy:true,call:(a:any)=>this.legacyAdapter!.call(name,a)})));
  }
  if(!writersEnabled)return;
  this.tools.push(
   read('preview_messages_v2','No delivery or lease update; no secrets.',z.object({envelope,limit:id.max(500).optional()}).strict(),a=>w.preview(a.envelope,a.limit)),
   write('register_v2','Explicit self-registration; never restores prior authority.',{role:str,provider:str,expected_registration_revision:rev},(a,e)=>w.register(a,e)),
   write('create_conversation_v2','Register an empty explicit thread in this scope.',{thread_id:str},(a,e)=>w.createConversation(a,e)),
   write('revoke_session_v2','Explicit Session revocation; lease and Task unchanged.',{target_session_id:str,expected_session_revision:id,...reason},(a,e)=>w.revokeSession(a,e)),
   write('remove_agent_v2','Retire registration after all Task ownership references are released.',{actor:str,expected_registration_revision:id,...reason},(a,e)=>w.removeAgent(a,e)),
   write('set_agent_status_v2','Record status; no OS liveness or automatic notification.',{actor:str,expected_registration_revision:id,status:str},(a,e)=>w.setAgentStatus(a,e)),
   write('retire_team_v2','Close registration; after all Sessions are revoked online registration cannot resume.',{expected_revision:id,...reason},(a,e)=>w.retireTeam(a,e)),
   write('send_message_v2','Send to an explicit recipient with immutable Task membership.',{to:str,content:str,conversation_id:id,task_id:id.nullable(),reply_to:id.optional()},(a,e)=>w.send(a,e)),
   write('ask_async_v2','Save question; Task waiting is a separate explicit request.',{to:str,content:str,conversation_id:id,task_id:id.nullable()},(a,e)=>w.ask(a,e)),
   write('claim_messages_v2','Lease pending messages; save request identity before calling.',{lease_ms:id.min(1000).max(300000),limit:id.max(500)},(a,e)=>w.claim(a,e)),
   write('receive_immediate_v2','Confirm delivery before processing; receipt handles response loss.',{limit:id.max(500)},(a,e)=>w.immediate(a,e)),
   write('ack_v2','Confirm the current claim generation and token.',{message_id:id,generation:rev,token:str.nullable()},(a,e)=>w.ack(a,e)),
   write('reply_v2','Answer with current claim or independent reply authority.',{message_id:id,content:str,generation:rev.optional(),token:str.nullable().optional(),reply_generation:rev.optional(),reply_token:str.nullable().optional()},(a,e)=>w.reply(a,e)),
   write('transfer_reply_authority_v2','Explicit successor authority with prior-holder evidence.',{message_id:id,new_session_id:str,expected_reply_generation:rev,prior_holder_session:str.nullable(),termination_evidence_ref:str},(a,e)=>w.transfer(a,e)),
   write('create_task_v2','Create an explicit open/backlog Task; no automatic assignment, conflict checks or messages.',taskInputs.create_task_v2.shape,(a,e)=>w.createTask(a,e)),
   write('update_task_v2','Actor and revision checked Task patch; ownership uses dedicated wrappers.',taskInputs.update_task_v2.shape,(a,e)=>w.updateTask(a,e)),
   write('claim_task_v2','Claim an unassigned open Task.',taskInputs.claim_task_v2.shape,(a,e)=>w.claimTask(a,e)),
   write('assign_task_v2','Requester assigns an explicit active recipient.',taskInputs.assign_task_v2.shape,(a,e)=>w.assignTask(a,e)),
   write('release_task_v2','Explicit ownership release preserving state or reopening; no terminal reopen.',taskInputs.release_task_v2.shape,(a,e)=>w.releaseTask(a,e)),
   write('acknowledge_task_v2','Holder records acknowledgement, decline or explicit waiting.',taskInputs.acknowledge_task_v2.shape,(a,e)=>w.acknowledgeTask(a,e)),
   write('submit_review_v2','Record review only; no completion gate or model independence guarantee.',taskInputs.submit_review_v2.shape,(a,e)=>w.submitReview(a,e)),
   write('handoff_task_v2','Explicit assignment handoff with structured references; artifact syntax only.',taskInputs.handoff_task_v2.shape,(a,e)=>w.handoffTask(a,e)),
   write('cancel_task_v2','Explicit Task cancellation with atomic reason event.',taskInputs.cancel_task_v2.shape,(a,e)=>w.cancelTask(a,e)),
   write('record_test_result_v2','Store an actor test report; execution is not verified by Bus.',taskInputs.record_test_result_v2.shape,(a,e)=>w.recordTestResult(a,e)),
   write('record_task_event_v2','Append event with optional actor/revision checked Task patch; metadata UTF-8 limit 64 KiB.',taskInputs.record_task_event_v2.shape,(a,e)=>w.recordTaskEvent(a,e)),
   write('record_decision_v2','Record explicit decision state/evidence; artifact syntax only, no inferred agreement.',taskInputs.record_decision_v2.shape,(a,e)=>w.recordDecision(a,e)),
   write('remember_v2','Store scoped memory with explicit references; no inferred conversation links.',taskInputs.remember_v2.shape,(a,e)=>w.remember(a,e)),
   write('pin_memory_v2','Change only memory pin and update time.',taskInputs.pin_memory_v2.shape,(a,e)=>w.pinMemory(a,e)),
   write('link_conversation_v2','Link Task and Conversation with relation CAS.',{task_id:id,conversation_id:id,expected_relation_revision:rev},(a,e)=>w.link(a.task_id,a.conversation_id,a.expected_relation_revision,e)),
   write('correct_link_v2','Append a relation correction or remove a link.',{link_version_id:id,action:z.enum(['revise','remove']),reason:str,expected_relation_revision:rev},(a,e)=>w.correct(a.link_version_id,a.action,a.reason,a.expected_relation_revision,e)),
   write('replace_link_v2','Replace a relation with same-scope targets.',{link_version_id:id,new_task_id:id,new_conversation_id:id,reason:str,expected_relation_revision:rev},(a,e)=>w.replace(a.link_version_id,a.new_task_id,a.new_conversation_id,a.reason,a.expected_relation_revision,e)),
   write('resolve_task_wait_v2','Dedicated evidence-backed unknown classifier; no general readiness bypass.',{task_id:id,expected_task_revision:rev,issue_id:id,wait_kind:z.enum(['technical','human']),blocked_reason:str,human_question_id:id.nullable().optional(),blocked_on_task_id:id.nullable().optional(),evidence_refs:z.array(z.object({table:z.enum(['tasks','messages','migration_issues']),id}).strict()).min(1).max(16)},(a,e)=>w.resolveTaskWait(a,e)),
   write('record_error_v2','Record structured agent report, not an external tool observation.',{task_id:id.optional(),message_id:id.optional(),corrects_event_id:id.optional()},(a,e)=>w.reportError(a,e,this.observer)),
  );
 }
 capabilities():Row {
  const c=this.reader.capabilities();
  return {...c,transport:this.writersEnabled?'development-writers-enabled':'read-only-tools',
   public_tools:this.tools.map(t=>({name:t.name,mutation:t.write,input_schema:jsonSchema(t.schema)})),
   pending_tools:pending,
   legacy_compatibility:{enabled:this.legacyEnabled,published:this.legacyEnabled?legacyPublished:[],categories:legacyGroups,scope:'explicit connection; wildcard or differing/null filters rejected; omitted uses connection',enumeration:'bounded; not complete'},
   unavailable:['recovery',...(!this.legacyEnabled?['legacy-compatibility']:[]),...(!this.writersEnabled?['mcp-writers']:[])],
   library_only:this.writersEnabled?[]:c.library_only,
   task_update_boundary:'explicit assignment only; no capability, conflict, pending-assignment automation; review records do not gate completion',production_ready:false};
 }
 call(name:string,args:unknown):any {
  const tool=this.tools.find(t=>t.name===name);if(!tool){this.noMutationShutdown();throw new Error('UNKNOWN_TOOL');}
  if(tool.legacy){this.noMutationShutdown();return tool.call(args??{});}
  if(name==='preview_messages_v2')this.noMutationShutdown();
  if(tool.write)this.suppressCloseWrites=false;
  if(tool.write&&!this.observing){
   const meta=this.writer.db.prepare('SELECT ready,recovery_state FROM bus_meta').get() as Row;
   if(meta.ready&&meta.recovery_state==='development_only'){this.observer.start();this.observing=true;}
  }
  let input:any;
  try{input=tool.schema.parse(args??{});}catch{
   const error=new Error(taskInputError(name,args));
   if(tool.write)Object.assign(error,this.observer.record(error));
   throw error;
  }
  return tool.call(input);
 }
 error(error:unknown):Row {if(error instanceof BusError)return legacyError(error);const e=error as Row;return {code:e.message==='UNKNOWN_TOOL'?'UNKNOWN_TOOL':safeCode(e),observability:e.observability??'unavailable',...(e.error_id?{error_id:e.error_id}:{})};}
 noMutationShutdown(){this.suppressCloseWrites=true;}
 close(){if(this.closed)return;this.closed=true;try{
  const meta=this.writer.db.prepare('SELECT ready,recovery_state FROM bus_meta').get() as Row;
  // A changed recovery/readiness gate must not be reopened by shutdown bookkeeping.
  // Retain the open epoch as incomplete coverage in read_only or after a
  // no-mutation legacy/preview/unknown request, including a mixed writer session.
  if(this.observing&&!this.suppressCloseWrites&&meta.ready&&meta.recovery_state==='development_only')this.observer.stop();
 }finally{this.legacyAdapter?.close();this.writer.close();this.reader.close();}}
}
/** Exact recursive schema conversion for the intentionally small public Zod subset. */
export function jsonSchema(s:z.ZodTypeAny):any {
 if(s instanceof z.ZodOptional)return jsonSchema(s.unwrap());
 if(s instanceof z.ZodNullable)return {anyOf:[jsonSchema(s.unwrap()),{type:'null'}]};
 if(s instanceof z.ZodObject){const properties:Row={},required:string[]=[];for(const [k,v] of Object.entries(s.shape) as [string,z.ZodTypeAny][]){properties[k]=jsonSchema(v);if(!(v instanceof z.ZodOptional))required.push(k);}return {type:'object',properties,required,additionalProperties:false};}
 if(s instanceof z.ZodArray)return {type:'array',items:jsonSchema(s.element),...(s._def.minLength?{minItems:s._def.minLength.value}:{}),...(s._def.maxLength?{maxItems:s._def.maxLength.value}:{})};
 if(s instanceof z.ZodUnion)return {anyOf:s.options.map(jsonSchema)};
 if(s instanceof z.ZodRecord)return {type:'object',additionalProperties:jsonSchema(s._def.valueType)};
 if(s instanceof z.ZodUnknown)return {};
 if(s instanceof z.ZodEnum)return {type:'string',enum:s.options};
 if(s instanceof z.ZodBoolean)return {type:'boolean'};
 if(s instanceof z.ZodNumber)return {type:s.isInt?'integer':'number',...(s.minValue!==null?{minimum:s.minValue}:{}),...(s.maxValue!==null?{maximum:s.maxValue}:{})};
 if(s instanceof z.ZodString){const regex=s._def.checks.find(c=>c.kind==='regex');return {type:'string',...(s.minLength!==null?{minLength:s.minLength}:{}),...(s.maxLength!==null?{maxLength:s.maxLength}:{}),...(regex&&regex.kind==='regex'?{pattern:regex.regex.source}:{})};}
 throw new Error('UNSUPPORTED_PUBLIC_SCHEMA');
}
