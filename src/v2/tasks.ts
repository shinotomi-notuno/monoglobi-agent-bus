import {activeRecipient} from './registration-state.js';
import {randomUUID} from 'node:crypto';
import {Delivery} from './delivery.js';
import {mutation,event,resolveTaskWait,type Envelope,type ResolveWaitArgs} from './mutation.js';
import {Observation} from './observation.js';
import type {Row} from './schema.js';
import {validateTask} from './task-invariants.js';
import {taskInputs,taskInputError,type TaskOperation} from './task-input.js';
const terminal=['completed','failed','canceled'];
const waitFields=['wait_kind','human_question_id','blocked_reason','blocked_on_task_id'];

const arrays=['file_scope','edit_scope','read_scope','changed_files'];
const booleans=['ack_required','review_required','independent_review','manager_reviewed'];
function fields(o:Row,allowed:string[]){if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!allowed.includes(k)))throw new Error('INVALID_INPUT');}
/** Explicit records and transitions. Every operation uses the same receipt transaction. */
export class Tasks extends Delivery {
 private actor(old:Row,e:Envelope,requesterOnly=false){if(e.actor!==old.requested_by&&(requesterOnly||e.actor!==old.claimed_by))throw new Error('TASK_FORBIDDEN');}
 private known(old:Row){if(old.wait_kind==='unknown')throw new Error('UNKNOWN_WAIT_UNRESOLVED');}
 private recipient(actor:string){if(!activeRecipient(this.db,this.sid,actor))throw new Error('RECIPIENT_SCOPE_MISMATCH');}
 private transition(old:Row,patch:Row,e:Envelope):Row {
  this.known(old);this.actor(old,e);
  if(['review_required','independent_review'].some(k=>Object.hasOwn(patch,k)))this.actor(old,e,true);
  const n={...old,...patch},matrix:Record<string,string[]>={backlog:['backlog','open'],open:['open','backlog','working','blocked','completed','failed'],claimed:['claimed','working','blocked','completed','failed'],working:['working','blocked','completed','failed'],blocked:['blocked','working','completed','failed'],completed:['completed'],failed:['failed'],canceled:['canceled']};
  const unassignedReopen=old.claimed_by===null&&e.actor===old.requested_by&&['claimed','working','blocked'].includes(old.state)&&n.state==='open';
  if(!matrix[old.state]?.includes(n.state)&&!unassignedReopen)throw new Error('TASK_INVALID_TRANSITION');
  // Terminal phase is fixed even on metadata-only/same-state updates.
  if(terminal.includes(n.state)&&Object.hasOwn(patch,'phase')&&patch.phase!==n.state)throw new Error('TASK_INVALID_TRANSITION');
  return n;
 }
 private saveTask(old:Row,n:Row,patch:Row,now:number):Row {
  if(patch.clear_wait===true){
   if(n.state==='blocked'||waitFields.some(k=>Object.hasOwn(patch,k)))throw new Error('INVALID_TASK_WAIT');
   Object.assign(n,{wait_kind:'none',human_question_id:null,blocked_reason:null,blocked_on_task_id:null});
  }
  if(old.state==='blocked'&&n.state!=='blocked'&&patch.clear_wait!==true)throw new Error('CLEAR_WAIT_REQUIRED');
  if(n.state!==old.state){
   if(terminal.includes(n.state)){n.phase=n.state;n.finished_at=now;}
   else if(Object.hasOwn(patch,'phase')===false)n.phase=n.state;
  }
  validateTask(this.db,{...n,scope_id:this.sid});
  // Keys originate solely in the strict schemas or fixed effects below, never SQL input.
  const keys=Object.keys(n).filter(k=>k!=='clear_wait'&&k!=='task_revision'&&k!=='updated_at'&&n[k]!==old[k]);
  const value=(k:string)=>arrays.includes(k)&&Array.isArray(n[k])?JSON.stringify(n[k]):booleans.includes(k)?Number(n[k]):n[k];
  const result=this.db.prepare(`UPDATE tasks SET ${keys.map(k=>`${k}=?,`).join('')}task_revision=task_revision+1,updated_at=? WHERE id=? AND scope_id=? AND task_revision=?`).run(...keys.map(value),now,old.id,this.sid,old.task_revision);
  if(result.changes!==1)throw new Error('REVISION_CONFLICT');
  return {task_id:old.id,task_revision:old.task_revision+1,state:n.state,wait_kind:n.wait_kind};
 }
 private scope():Row{return this.db.prepare('SELECT project,area,team FROM scopes WHERE scope_id=?').get(this.sid) as Row;}
 private recordTarget(table:string,id:number):Row {
  if(['tasks','messages','conversations'].includes(table))return this.target(table as 'tasks',id);
  if(!['memories','decisions','test_results','task_events'].includes(table))throw new Error('INVALID_EVIDENCE_REFERENCE');
  const s=this.scope(),r=this.db.prepare(`SELECT * FROM ${table} WHERE id=? AND project IS ? AND area IS ? AND team IS ?`).get(id,s.project,s.area,s.team) as Row|undefined;
  if(!r)throw new Error('TARGET_NOT_FOUND');return r;
 }
 private references(refs:Row[]):string {
  for(const ref of refs){
   if('table' in ref)this.recordTarget(ref.table,ref.id);
   else if(/[\x00-\x1f\x7f]/.test(ref.artifact_path)||/[\x00-\x20\x7f]/.test(ref.git_ref))throw new Error('INVALID_EVIDENCE_REFERENCE');
  }
  return JSON.stringify(refs);
 }
 private metadata(value:Row):string {
  const json=(v:any):boolean=>v===null||typeof v==='string'||typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v))||(Array.isArray(v)?v.every(json):typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype&&Object.values(v).every(json));
  if(!json(value))throw new Error('INVALID_INPUT');
  const saved=JSON.stringify(value);if(Buffer.byteLength(saved,'utf8')>65536)throw new Error('INVALID_INPUT');return saved;
 }
 private insertRecord(table:'memories'|'decisions'|'task_events'|'test_results',data:Row,e:Envelope,now:number):number {
  const row={...data,...this.scope(),by_agent:e.actor,created_at:now,...(['memories','decisions'].includes(table)?{updated_at:now}:{})};
  return Number(this.db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row)).lastInsertRowid);
 }
 private execute(op:TaskOperation,args:Row,e:Envelope):Row {
  return mutation(this.db,this.sid,op,args,e,at=>{
   const parsed=taskInputs[op].safeParse(args);if(!parsed.success)throw new Error(taskInputError(op,args));const a:Row=Object.fromEntries(Object.entries(parsed.data).filter(([,v])=>v!==undefined));
   for(const key of ['patch','task_patch'])if(a[key])a[key]=Object.fromEntries(Object.entries(a[key]).filter(([,v])=>v!==undefined));
   let result:Row={},taskIds:number[]=[],eventDetails:Row={};
   if(op==='create_task_v2'){
    const {title,...details}=a;
    if(details.phase!==undefined&&details.phase!==null&&terminal.includes(details.phase))throw new Error('TASK_INVALID_TRANSITION');
    const data:Row={...details,title,thread_id:randomUUID(),requested_by:e.actor,state:a.state??'open',priority:a.priority??0,created_at:at.now,updated_at:at.now,...this.scope(),scope_id:this.sid};
    for(const k of arrays)if(k in data)data[k]=JSON.stringify(data[k]);for(const k of booleans)if(k in data)data[k]=Number(data[k]);
    const id=Number(this.db.prepare(`INSERT INTO tasks(${Object.keys(data).join(',')}) VALUES(${Object.keys(data).map(()=>'?').join(',')})`).run(...Object.values(data)).lastInsertRowid);
    result={task_id:id,task_revision:0};taskIds=[id];
   }else if(['record_test_result_v2','record_task_event_v2','record_decision_v2','remember_v2','pin_memory_v2'].includes(op)){
    if(a.task_id!==undefined&&a.task_id!==null){this.target('tasks',a.task_id);taskIds=[a.task_id];}
    if(op==='record_test_result_v2')result={test_result_id:this.insertRecord('test_results',a,e,at.now)};
    if(op==='record_decision_v2')result={decision_id:this.insertRecord('decisions',{...a,implemented:Number(a.implemented),evidence_refs:this.references(a.evidence_refs)},e,at.now)};
    if(op==='record_task_event_v2'){
     const metadata=this.metadata(a.metadata);
     if((a.task_patch!==undefined)!==(a.expected_task_revision!==undefined))throw new Error('INVALID_INPUT');
     if(a.task_patch!==undefined){const old=this.taskForRevision(a);result=this.saveTask(old,this.transition(old,a.task_patch,e),a.task_patch,at.now);}
     result.task_event_id=this.insertRecord('task_events',{task_id:a.task_id,event_type:a.event_type,message:a.message,phase:a.phase??null,metadata},e,at.now);
    }
    if(op==='remember_v2'){
     if(a.kind==='conversation_link')throw new Error('INVALID_INPUT');
     if(a.agent!==undefined&&a.agent!==null&&!this.db.prepare('SELECT 1 FROM agent_registrations WHERE scope_id=? AND actor=?').get(this.sid,a.agent))throw new Error('TARGET_NOT_FOUND');
     const conversation=a.conversation_id===undefined?null:this.target('conversations',a.conversation_id);
     if(a.supersedes_id!==undefined)this.recordTarget('memories',a.supersedes_id);
     const {conversation_id,...data}=a;
     result={memory_id:this.insertRecord('memories',{...data,thread_id:conversation?.thread_id??null,pinned:Number(a.pinned??false)},e,at.now)};
    }
    if(op==='pin_memory_v2'){
     const old=this.recordTarget('memories',a.memory_id);if(old.task_id!==null)taskIds=[old.task_id];
     this.db.prepare('UPDATE memories SET pinned=?,updated_at=? WHERE id=?').run(Number(a.pinned),at.now,a.memory_id);result={memory_id:a.memory_id,pinned:a.pinned};
    }
   }else{
    const old=this.taskForRevision(a);this.known(old);let n={...old},patch:Row={};taskIds=[old.id];
    if(op==='update_task_v2'){patch=a.patch;n=this.transition(old,patch,e);}
    if(op==='claim_task_v2'||op==='assign_task_v2'){
     if(op==='assign_task_v2')this.actor(old,e,true);
     if(old.state!=='open'||old.claimed_by!==null)throw new Error('TASK_NOT_CLAIMABLE');
     const to=op==='claim_task_v2'?e.actor:a.to_agent;this.recipient(to);
     Object.assign(n,{state:'claimed',claimed_by:to,claimed_at:at.now,pending_assignee:null,acknowledged_at:null,acknowledged_by:null});
    }
    if(op==='release_task_v2'){
     this.actor(old,e);if(old.claimed_by===null)throw new Error('TASK_NOT_ASSIGNED');
     if(a.mode==='preserve_state'&&Object.hasOwn(a,'clear_wait'))throw new Error('INVALID_INPUT');
     if(a.mode==='reopen'){if(!['claimed','working','blocked'].includes(old.state))throw new Error('TASK_INVALID_TRANSITION');n.state='open';patch={clear_wait:a.clear_wait};}
     Object.assign(n,{claimed_by:null,claimed_at:null,pending_assignee:null});
    }
    if(op==='acknowledge_task_v2'){
     if(e.actor!==old.claimed_by)throw new Error('TASK_FORBIDDEN');if(old.state!=='claimed')throw new Error('TASK_INVALID_TRANSITION');
     if(a.response!=='blocked'&&waitFields.some(k=>Object.hasOwn(a,k)))throw new Error('INVALID_INPUT');
     if(a.response==='blocked'){for(const k of waitFields)if(k in a)n[k]=a[k];n.state='blocked';}
     if(a.response==='declined')Object.assign(n,{state:'open',claimed_by:null,claimed_at:null,pending_assignee:null});
     Object.assign(n,{acknowledged_at:at.now,acknowledged_by:e.actor});
     if(a.note!==undefined)result.task_event_id=this.insertRecord('task_events',{task_id:old.id,event_type:'note',message:a.note},e,at.now);
    }
    if(op==='submit_review_v2'){
     if(['backlog','open'].includes(old.state))throw new Error('TASK_INVALID_TRANSITION');
     if(old.independent_review&&(e.actor===old.claimed_by||e.actor===old.pending_assignee))throw new Error('REVIEW_SELF_FORBIDDEN');
     Object.assign(n,{review_required:1,review_state:a.approved?'approved':'changes_requested',reviewed_by:e.actor,review_notes:a.notes??null,manager_reviewed:Number(a.approved)});
     eventDetails.review={approved:a.approved,review_required:true,independent_review:!!old.independent_review,review_state:n.review_state,reviewed_by:e.actor,notes:a.notes??null};
    }
    if(op==='handoff_task_v2'){
     this.actor(old,e);if(old.claimed_by===null)throw new Error('TASK_NOT_ASSIGNED');if(!['claimed','working','blocked'].includes(old.state))throw new Error('TASK_INVALID_TRANSITION');
     if(a.to_agent!==null)this.recipient(a.to_agent);
     let refs:string;try{refs=this.references(a.references);}catch{throw new Error('HANDOFF_REFERENCE_INVALID');}
     // Every explicit handoff starts a new assignment acknowledgement, including the same actor.
     Object.assign(n,{state:old.state==='blocked'?'blocked':a.to_agent===null?'open':'claimed',claimed_by:a.to_agent,claimed_at:a.to_agent===null?null:at.now,pending_assignee:null,acknowledged_at:null,acknowledged_by:null});
     result.memory_id=this.insertRecord('memories',{kind:'handoff',content:a.reason,task_id:old.id,agent:a.to_agent,handoff_references:refs},e,at.now);
    }
    if(op==='cancel_task_v2'){
     this.actor(old,e);if(terminal.includes(old.state))throw new Error('TASK_INVALID_TRANSITION');
     Object.assign(n,{state:'canceled',result:a.reason});patch={clear_wait:a.clear_wait};
     result.task_event_id=this.insertRecord('task_events',{task_id:old.id,event_type:'cancel',message:a.reason},e,at.now);
    }
    result={...result,...this.saveTask(old,n,patch,at.now)};
   }
   event(this.db,this.sid,op,e,at,null,{task_ids:taskIds,...result,...eventDetails});return {result};
  },this.hooks);
 }
 private taskForRevision(a:Row):Row {const old=this.target('tasks',a.task_id);if(old.task_revision!==a.expected_task_revision)throw new Error('REVISION_CONFLICT');return old;}
 resolveTaskWait(args:ResolveWaitArgs,e:Envelope):Row{return resolveTaskWait(this.db,this.sid,args,e,this.hooks);}
 createTask(a:Row,e:Envelope){return this.execute('create_task_v2',a,e);}
 updateTask(a:Row,e:Envelope){return this.execute('update_task_v2',a,e);}
 claimTask(a:Row,e:Envelope){return this.execute('claim_task_v2',a,e);}
 assignTask(a:Row,e:Envelope){return this.execute('assign_task_v2',a,e);}
 releaseTask(a:Row,e:Envelope){return this.execute('release_task_v2',a,e);}
 acknowledgeTask(a:Row,e:Envelope){return this.execute('acknowledge_task_v2',a,e);}
 submitReview(a:Row,e:Envelope){return this.execute('submit_review_v2',a,e);}
 handoffTask(a:Row,e:Envelope){return this.execute('handoff_task_v2',a,e);}
 cancelTask(a:Row,e:Envelope){return this.execute('cancel_task_v2',a,e);}
 recordTestResult(a:Row,e:Envelope){return this.execute('record_test_result_v2',a,e);}
 recordTaskEvent(a:Row,e:Envelope){return this.execute('record_task_event_v2',a,e);}
 recordDecision(a:Row,e:Envelope){return this.execute('record_decision_v2',a,e);}
 remember(a:Row,e:Envelope){return this.execute('remember_v2',a,e);}
 pinMemory(a:Row,e:Envelope){return this.execute('pin_memory_v2',a,e);}
 reportError(args:{task_id?:number;message_id?:number;corrects_event_id?:number},e:Envelope,observer:Observation):Row {
  return mutation(this.db,this.sid,'record_error_v2',args,e,at=>{
   fields(args,['task_id','message_id','corrects_event_id']);if(observer.db!==this.db||observer.sid!==this.sid)throw new Error('SESSION_SCOPE_MISMATCH');
   for(const n of Object.values(args))if(!Number.isSafeInteger(n)||n<1)throw new Error('INVALID_INPUT');
   const id=observer.insert(args.corrects_event_id?'ERROR_CORRECTION':'AGENT_REPORTED',args,e,'agent_report',args.corrects_event_id??null);
   event(this.db,this.sid,'record_error',e,at,null,{task_ids:args.task_id?[this.target('tasks',args.task_id).id]:[]});return {result:{error_id:id}};
  },this.hooks);
 }
}
