import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {BusError,type BusErrorCode} from '../util/errors.js';
import {schemaVersion,scopeKey,type Scope,type Row} from './schema.js';
import {legacyReads} from './legacy-reads.js';
import {legacyInputs,legacyCoreInputs} from './legacy-input.js';
import {Queries} from './queries.js';
export const legacyGroups={
 maintain:['inbox_status','inbox_previews','get_message','message_status','why_no_reply','thread','whois','directory','wait_for_agents','recent','check_scope_conflicts','list_test_results','list_task_events','task_result','wait_for_task','list_tasks','activity','get_task','list_decisions','list_memories'],
 delegate:['inbox','cockpit','now','project_board','team_board','session_brief','final_report','review_gate'],
 reject:['register','remove_agent','send','ack','ask_async','reply','reply_thread','create_task','claim_task','set_agent_status','assign_task','update_task','release_task','acknowledge_task','submit_review','handoff_task','record_test_result','record_task_event','cancel_task','record_decision','remember','pin_memory','unpin_memory'],
 disabled:['delete_team','ask','ask_best','send_team','ask_team','subscribe','unsubscribe','send_channel','subscribers','delegate','delegate_team','sleep_agent','wake_agent','claim_best_task'],
};
export const legacyNames=Object.values(legacyGroups).flat();
export const legacyPublished=[...legacyGroups.maintain,...legacyGroups.delegate,...legacyGroups.reject];
const replacements:Record<string,string>={register:'register_v2',remove_agent:'remove_agent_v2',send:'send_message_v2',ack:'ack_v2',inbox:'claim_messages_v2 / receive_immediate_v2',ask_async:'ask_async_v2',reply:'reply_v2 / transfer_reply_authority_v2',reply_thread:'send_message_v2',unpin_memory:'pin_memory_v2',delete_team:'retire_team_v2'};
Object.assign(replacements,{
 inbox_status:'preview_messages_v2',inbox_previews:'preview_messages_v2',get_message:'get_message_v2',message_status:'get_message_v2',why_no_reply:'get_message_v2',thread:'list_thread_messages_v2',recent:'list_conversations_v2 / list_thread_messages_v2',get_task:'task_context_v2',task_result:'task_context_v2',wait_for_task:'task_context_v2',list_tasks:'list_tasks_v2',activity:'list_communication_events_v2',
 whois:'whois',directory:'directory',wait_for_agents:'wait_for_agents',check_scope_conflicts:'check_scope_conflicts',list_decisions:'list_decisions',list_memories:'list_memories',list_test_results:'list_test_results',list_task_events:'list_task_events',
 cockpit:'status_summary_v2',now:'status_summary_v2',project_board:'status_summary_v2',team_board:'status_summary_v2',session_brief:'task_context_v2',final_report:'status_summary_v2',review_gate:'status_summary_v2',
 ask:'ask_async_v2',ask_best:'ask_async_v2',ask_team:'ask_async_v2',send_team:'send_message_v2',send_channel:'send_message_v2',subscribe:'send_message_v2',unsubscribe:'send_message_v2',subscribers:'directory',delegate:'create_task_v2 / send_message_v2',delegate_team:'create_task_v2 / send_message_v2',sleep_agent:'set_agent_status_v2',wake_agent:'set_agent_status_v2',claim_best_task:'list_tasks_v2 / claim_task_v2',
});
export const replacement=(name:string)=>replacements[name]??(legacyGroups.reject.includes(name)?name+'_v2':'v2_capabilities');
const readMethods:Record<string,string>={inbox_status:'inboxStatus',inbox_previews:'inboxPreviews',get_message:'getMessage',message_status:'messageStatus',why_no_reply:'whyNoReply',thread:'threadMessages',whois:'whois',directory:'directory',wait_for_agents:'waitForAgents',recent:'recentMessages',check_scope_conflicts:'checkScopeConflicts',list_test_results:'listTestResults',list_task_events:'listTaskEvents',task_result:'taskResult',wait_for_task:'waitForTask',list_tasks:'listTasks',activity:'activityTimeline',get_task:'getTask',list_decisions:'listDecisions',list_memories:'listMemories',cockpit:'cockpit',project_board:'projectBoard',team_board:'teamBoard',session_brief:'sessionBrief',final_report:'finalReport',review_gate:'reviewGate'};
function fail(code:BusErrorCode,name:string,details:Row={}):never {throw new BusError(code,`${code}: use ${replacement(name)} with an explicit v2 request`,details,replacement(name));}
export function legacyError(e:unknown):Row {return e instanceof BusError?{code:e.code,details:e.details??{},replacement:e.replacement??null}:{code:'INTERNAL_ERROR',details:{},replacement:null};}
/** Opens no writer/observer and only prepares scoped SELECT statements. */
export class LegacyAdapter {
 readonly db:Database.Database;
 private readonly scope:Scope|null;
 private readonly sid:number|null;
 private readonly reads:ReturnType<typeof legacyReads>;
 constructor(readonly path:string,scope:unknown){
  this.db=new Database(path,{readonly:true,fileMustExist:true});
  try{
   const m=this.db.prepare('SELECT schema_version FROM bus_meta').get() as Row;if(m.schema_version!==schemaVersion)throw new BusError('UNSUPPORTED_SCHEMA','UNSUPPORTED_SCHEMA');
   let s:Scope|null=null,id:number|null=null;
   try{const key=scopeKey(scope as Scope),row=this.db.prepare('SELECT * FROM scopes WHERE scope_key=?').get(key) as Row|undefined;if(row){s={project:row.project,area:row.area,team:row.team};id=row.scope_id;}}catch{}
   this.scope=s;this.sid=id;
   this.reads=legacyReads(()=>({prepare:sql=>this.select(sql)}),()=>Math.max(Date.now(),(this.db.prepare('SELECT lease_clock_ms FROM bus_meta').get() as Row).lease_clock_ms));
  }catch(e){this.db.close();throw e;}
 }
 close(){this.db.close();}
 private checkScope(name:string,args:Row){
  if(this.sid===null||this.scope===null)fail('SCOPE_UNRESOLVED',name);
  for(const k of ['project','area','team'] as const)if(args[k]!==undefined&&(args[k]==='*'||args[k]!==this.scope[k]))fail('SCOPE_UNRESOLVED',name);
 }
 private integrity(){
  for(const t of ['tasks','messages'])if(this.db.prepare(`SELECT 1 FROM ${t} x JOIN scopes s USING(scope_id) WHERE x.scope_id=? AND (x.project IS NOT s.project OR x.area IS NOT s.area OR x.team IS NOT s.team) LIMIT 1`).get(this.sid))fail('SCOPE_INTEGRITY','list_tasks');
 }
 private select(sql:string){
  if(!/^SELECT\b/i.test(sql.trim()))throw new Error('READ_PROJECTION_ONLY');
  // Source-owned SELECT text only. CTEs bind every legacy table access to the
  // connection scope; SQL identifiers and scope IDs never come from requests.
  const sid=this.sid!;
  const scope=`project IS (SELECT project FROM main.scopes WHERE scope_id=${sid}) AND area IS (SELECT area FROM main.scopes WHERE scope_id=${sid}) AND team IS (SELECT team FROM main.scopes WHERE scope_id=${sid})`;
  const ctes=[`tasks AS (SELECT * FROM main.tasks WHERE scope_id=${sid})`,...['memories','decisions','test_results','task_events'].map(t=>`${t} AS (SELECT * FROM main.${t} WHERE ${scope})`),
   `messages AS (SELECT m.id,m.from_agent,m.to_agent,m.kind,m.content,m.reply_to,m.status,m.created_at,m.delivered_at,m.replied_at,m.thread_id,d.deadline AS claim_deadline,s.actor AS claimed_by,m.channel,m.project,m.area,m.team,m.priority FROM main.messages m LEFT JOIN main.delivery_state d ON d.message_id=m.id LEFT JOIN main.registered_sessions s ON s.session_id=d.holder_session WHERE m.scope_id=${sid})`,
   `agents AS (SELECT a.actor AS name,l.capabilities,a.registered_at,l.last_seen,(a.status='sleeping') AS paused,sc.project,sc.area,sc.team,a.role,l.routing_weight,a.status,(SELECT session_id FROM main.registered_sessions rs WHERE rs.scope_id=a.scope_id AND rs.actor=a.actor AND rs.generation=a.generation ORDER BY rs.registered_at DESC,rs.session_id LIMIT 1) AS session_id,CASE WHEN a.active=0 THEN a.revoked_at ELSE NULL END AS removed_at,l.bus_version,NULL AS listening_until FROM main.agent_registrations a JOIN main.scopes sc USING(scope_id) JOIN main.agents l ON l.name=a.actor WHERE a.scope_id=${sid} AND a.generation=(SELECT max(b.generation) FROM main.agent_registrations b WHERE b.scope_id=a.scope_id AND b.actor=a.actor))`];
  return this.db.prepare('WITH '+ctes.join(',')+' '+sql);
 }
 private ack(args:unknown):never {
  const parsed=legacyInputs.ack!.safeParse(args);if(!parsed.success||!parsed.data.agent.trim()||!Number.isSafeInteger(parsed.data.message_id))fail('INVALID_INPUT','ack');const a=parsed.data;
  // Registration existence precedes connection-scope resolution (K01).
  if(!this.db.prepare('SELECT 1 FROM agent_registrations WHERE actor=?').get(a.agent))fail('AGENT_NOT_FOUND','ack');
  this.checkScope('ack',{});
  if(!this.db.prepare('SELECT 1 FROM agent_registrations WHERE actor=? AND scope_id=?').get(a.agent,this.sid))fail('AGENT_NOT_FOUND','ack');
  const m=this.db.prepare('SELECT id,to_agent FROM messages WHERE id=? AND scope_id=?').get(a.message_id,this.sid) as Row|undefined;
  if(!m)fail('MESSAGE_NOT_FOUND','ack');if(m.to_agent!==a.agent)fail('RECIPIENT_MISMATCH','ack');
  const d=this.db.prepare('SELECT mode FROM delivery_state WHERE message_id=?').get(m.id) as Row|undefined;
  if(d&&['guarded','legacy_terminal'].includes(d.mode))fail('LEGACY_ACK_DISABLED','ack',{mode:d.mode,notice:d.mode==='legacy_terminal'?'legacy_terminal cannot be acknowledged':'use explicit v2 claim authority'});
  fail('DELIVERY_STATE_INVALID','ack');
 }
 call(name:string,args:unknown={},core=false):any {
  if(!legacyNames.includes(name)||legacyGroups.disabled.includes(name))fail('LEGACY_TOOL_DISABLED',name);
  if(name==='ack')return this.ack(args);
  if(legacyGroups.reject.includes(name))fail('UPGRADE_REQUIRED',name);
  if(name==='inbox'&&((args as Row)?.mark_delivered!==false||(args as Row)?.claim_s!==undefined))fail('UPGRADE_REQUIRED',name);
  const p=(core?legacyCoreInputs:legacyInputs)[name]?.safeParse(args);if(!p?.success)fail('INVALID_INPUT',name);const a=p.data;
  if(name==='inbox'&&(a.mark_delivered!==false||a.claim_s!==undefined))fail('UPGRADE_REQUIRED',name);
  this.checkScope(name,a);this.integrity();
  if(name==='now'){
   const agent=this.reads.directory().find(x=>x.name===a.agent)??null;if(!agent)fail('AGENT_NOT_FOUND',name);
   return {agent,task:a.task_id===undefined?null:this.reads.getTask(a.task_id),event:null,suggested_next_actions:['Read only: use set_agent_status_v2 and update_task_v2 for explicit changes.'],...this.summary(a)};
  }
  if(name==='inbox'){
   return this.reads.previewInbox(a as any);
  }
  const method=(this.reads as any)[readMethods[name]!];
  const value=name==='get_task'?method(a.task_id):name==='why_no_reply'?method(a.message_id):name==='thread'?method(a.thread_id,a.limit):name==='task_result'?method(a.task_id,a.limit):method(a);
  if(value instanceof Promise)return value;
  return legacyGroups.delegate.includes(name)?{...value,...this.summary(a)}:value;
 }
 private summary(a:Row):Row {
  const q=new Queries(this.path,this.scope!);try{return {v2_summary:q.statusSummary({...(a.task_id!==undefined?{task_id:a.task_id}:{}),limit:Math.min(a.limit??20,100)}),coverage:'bounded legacy projection; not complete enumeration; legacy last_seen is historical, not OS liveness',automatic_action:false};}finally{q.close();}
 }
}
/** Environment-owned old entrypoint bridge; does not call getDb or create directories. */
export function legacyPath():string|null {
 const path=process.env.AGENT_BUS_V2_DB??join(process.env.AGENT_BUS_DIR||join(homedir(),'.agent-bus'),'bus.db');if(!existsSync(path))return null;
 const db=new Database(path,{readonly:true,fileMustExist:true});try{return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bus_meta'").get()?path:null;}finally{db.close();}
}
export function legacyCore(name:string,args:unknown):{handled:boolean;value?:any}{
 const path=legacyPath();if(!path)return {handled:false};let scope:unknown=null;try{scope=JSON.parse(process.env.AGENT_BUS_V2_SCOPE??'null');}catch{}
 const adapter=new LegacyAdapter(path,scope);try{const value=adapter.call(name,args,true);if(value instanceof Promise)return {handled:true,value:value.finally(()=>adapter.close())};adapter.close();return {handled:true,value};}catch(e){adapter.close();throw e;}
}
