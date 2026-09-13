import type Database from 'better-sqlite3';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Row } from './schema.js';
const observers=new WeakMap<Database.Database,Observation>();
const codes=new Set(['REVIEW_SELF_FORBIDDEN','HANDOFF_REFERENCE_INVALID','TASK_FORBIDDEN','TASK_INVALID_TRANSITION','TASK_FIELD_REQUIRES_WRAPPER','TASK_NOT_CLAIMABLE','TASK_NOT_ASSIGNED','SESSION_REVOKED','ALREADY_REGISTERED','REGISTRATION_RETIRED','REGISTRATION_METADATA_MISMATCH','TASKS_REQUIRE_RELEASE','SCOPE_NOT_FOUND','IMMUTABLE_SESSION','IMMUTABLE_REGISTRATION','IMMUTABLE_REGISTRATION_SCOPE','WAIT_NOT_UNCLASSIFIED','EVIDENCE_REFERENCE_REQUIRED','INVALID_EVIDENCE_REFERENCE','WAIT_RESOLUTION_INTEGRITY','HUMAN_WAIT_LINK_REQUIRED','CURSOR_MISMATCH','INVALID_LIMIT','INVALID_CHUNK_SIZE','CONVERSATION_NOT_IN_CONTEXT','MUTABLE_FILTER_UNSUPPORTED','INVALID_CORRECTION','INVALID_INPUT','INVALID_ENVELOPE','TASK_BINDING_REQUIRED','TASK_SCOPE_MISMATCH','INVALID_TASK_WAIT','REVISION_CONFLICT','UNKNOWN_WAIT_UNRESOLVED','CLEAR_WAIT_REQUIRED','TARGET_NOT_FOUND','MESSAGE_NOT_FOUND','SESSION_SCOPE_MISMATCH','SESSION_MISMATCH','RECIPIENT_MISMATCH','RECIPIENT_SCOPE_MISMATCH','STALE_CLAIM','LEASE_EXPIRED','TOKEN_REQUIRED','STALE_REPLY_AUTH','ALREADY_ANSWERED','REQUEST_ID_REUSE','MIGRATION_ISSUES_READ_ONLY','RECOVERY_READ_ONLY','RECOVERY_OUTCOME_UNKNOWN','ASK_REPLY_REQUIRES_AUTHORITY','MESSAGE_BINDING_MISSING','CLOCK_REGRESSION','AGENT_REPORTED','ERROR_CORRECTION','LINK_EXISTS','INVALID_UNKNOWN_ISSUE','INVALID_DEPENDENCY','HUMAN_QUESTION_REQUIRED','IMMUTABLE_SCOPE','INTERNAL_ERROR']);
export function safeCode(error:unknown):string {
 const e=error as Row;const code=typeof e?.code==='string'?e.code:e?.message;
 return codes.has(code)?code:/^SQLITE_(BUSY|IOERR|FULL|READONLY|CANTOPEN|CORRUPT|CONSTRAINT)(_[A-Z]+)?$/.test(code??'')?code:'INTERNAL_ERROR';
}
export type Sinks={db?:()=>void;stderr?:(line:string)=>void;file?:(line:string)=>void};
export type Diagnostic={observability:'recorded'|'fallback'|'unavailable'|'suppressed';error_id?:number};
export class Observation {
 private epoch:number|null=null;
 private gap=false;
 constructor(readonly db:Database.Database,readonly sid:number,readonly sinks:Sinks={}){}
 start():number {
  const meta=this.db.prepare('SELECT * FROM bus_meta').get() as Row;
  if(!meta.ready||meta.recovery_state!=='development_only')throw new Error('RECOVERY_READ_ONLY');
  if(this.epoch!==null)throw new Error('OBSERVER_ALREADY_STARTED');
  this.epoch=Number(this.db.prepare("INSERT INTO logging_epochs(scope_id,started_at,state) VALUES(?,?,'open')").run(this.sid,Date.now()).lastInsertRowid);
  observers.set(this.db,this);return this.epoch;
 }
 stop():void {
  try {if(this.epoch!==null)this.db.prepare("UPDATE logging_epochs SET ended_at=?,state=? WHERE epoch_id=?").run(Date.now(),this.gap?'gap':'closed',this.epoch);}
  finally {observers.delete(this.db);this.epoch=null;}
 }
 private data(code:string,args:Row,e:Row,source:string,corrects:number|null=null):Row {
  const requested=args.task_id??args.taskId,mid=args.message_id;
  const task=Number.isSafeInteger(requested)?this.db.prepare('SELECT id FROM tasks WHERE id=? AND scope_id=?').get(requested,this.sid) as Row|undefined:undefined;
  const message=Number.isSafeInteger(mid)?this.db.prepare('SELECT m.id,b.task_ids,b.task_binding FROM messages m JOIN message_bindings b ON b.message_id=m.id WHERE m.id=? AND m.scope_id=?').get(mid,this.sid) as Row|undefined:undefined;
  return {scope_id:this.sid,code,source,at:Date.now(),request_id:typeof e.request_id==='string'&&/^[a-f0-9-]{36}$/i.test(e.request_id)?e.request_id:null,
   request_ref:typeof e.request_id==='string'?createHash('sha256').update(e.request_id).digest('hex'):null,
   target_type:task?'tasks':message?'messages':null,target_id:task?.id??message?.id??null,unknown_reason:task||message?null:'not_supplied_or_not_visible',
   task_ids:task?JSON.stringify([task.id]):message?.task_ids??'[]',task_binding:task?'assigned':message?.task_binding??'unknown',
   retryable:code.startsWith('SQLITE_BUSY')||code.startsWith('SQLITE_IOERR')?1:0,
   summary:source==='agent_report'?'Agent reported an issue; interpretation is not verified.':`Bus diagnostic: ${code}`,
   details_ref:task?JSON.stringify({table:'tasks',id:task.id}):message?JSON.stringify({table:'messages',id:message.id}):null,
   epoch_id:this.epoch,corrects_event_id:corrects};
 }
 insert(code:string,args:Row,e:Row,source:'bus'|'agent_report'='bus',corrects:number|null=null):number {
  if(this.epoch===null)throw new Error('OBSERVER_NOT_STARTED');
  const c=safeCode({code});const data=this.data(c,args,e,source,corrects);
  if(corrects!==null && !this.db.prepare('SELECT 1 FROM error_events WHERE event_id=? AND scope_id=?').get(corrects,this.sid))throw new Error('TARGET_NOT_FOUND');
  this.sinks.db?.();
  return Number(this.db.prepare(`INSERT INTO error_events(${Object.keys(data).join(',')}) VALUES(${Object.keys(data).map(()=>'?').join(',')})`).run(...Object.values(data)).lastInsertRowid);
 }
 record(error:unknown,args:Row={},e:Row={}):Diagnostic {
  const code=safeCode(error);
  try {
   const meta=this.db.prepare('SELECT ready,recovery_state FROM bus_meta').get() as Row;
   if(!meta.ready||meta.recovery_state!=='development_only')return this.fallback(code,'suppressed');
   return {observability:'recorded',error_id:this.db.transaction(()=>this.insert(code,args,e)).immediate()};
  }catch{return this.fallback(code);}
 }
 private fallback(code:string,mode?:'suppressed'):Diagnostic {
  this.gap=true;const line=JSON.stringify({source:'bus',code,observability:'unavailable',coverage:'gap',at:Date.now()})+'\n';let saved=false;
  try{(this.sinks.stderr??(s=>process.stderr.write(s)))(line);saved=true;}catch{}
  try{(this.sinks.file??(s=>appendFileSync(this.db.name+'.errors.jsonl',s,{mode:0o600})))(line);saved=true;}catch{}
  return {observability:mode??(saved?'fallback':'unavailable')};
 }
}
export function observeFailure(db:Database.Database,error:unknown,args:Row,e:Row):Diagnostic {
 return observers.get(db)?.record(error,args,e)??{observability:'unavailable'};
}
export function observeClock(db:Database.Database,args:Row,e:Row):Diagnostic {
 return observeFailure(db,{code:'CLOCK_REGRESSION'},args,e);
}
export function coverage(db:Database.Database,sid:number):Row {
 const r=db.prepare("SELECT count(*) epochs,coalesce(sum(state='open'),0) unclosed_epochs,coalesce(sum(state='gap'),0) gaps FROM logging_epochs WHERE scope_id=?").get(sid) as Row;
 const intervals=db.prepare('SELECT epoch_id,started_at,ended_at,state FROM logging_epochs WHERE scope_id=? ORDER BY epoch_id DESC LIMIT 10').all(sid);
 return {...r,intervals,intervals_truncated:r.epochs>10,zero_means:'zero_saved_matches_not_zero_incidents',state:r.epochs?'partial':'unobserved',complete:false,scope:'instrumented_writer_calls_only',before_first_epoch:'unobserved',read_only_and_external_tools:'not_observed',unclosed_means:'active_or_interrupted_not_inferred'};
}
