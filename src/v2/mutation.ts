import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {existsSync} from 'node:fs';
import { observeFailure,observeClock } from './observation.js';
import {validateTask} from './task-invariants.js';
import { binding } from './binding.js';
import {apiVersion,type Row} from './schema.js';
import {identity,activeSession,registerBusiness,input,textInput,revision,type RegisterArgs} from './registration-state.js';
export type Envelope={origin_instance_uuid:string;actor:string;session_id:string;request_id:string};
export type Hooks={now?:()=>number;fault?:(point:'locked'|'before_commit'|'after_commit')=>void};
export type Outcome={result:Row;secret?:Row};
export const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
export function canonical(v:any):string {
  if(v===null || typeof v!=='object')return JSON.stringify(v);
  if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
  return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
}
export function session(db:Database.Database,sid:number,e:Pick<Envelope,'actor'|'session_id'>) {
  if(!identity(db,sid,e))throw new Error('SESSION_SCOPE_MISMATCH');
  if(!activeSession(db,sid,e))throw new Error('SESSION_REVOKED');
}
export function clock(db:Database.Database,hooks:Hooks={}):Row {
  const saved=(db.prepare('SELECT lease_clock_ms FROM bus_meta').get() as Row).lease_clock_ms;
  const host=(hooks.now??Date.now)();if(!Number.isSafeInteger(host)||host<0)throw new Error('INVALID_CLOCK');
  return {now:Math.max(saved,host),clock_basis:'max(persisted,host_utc_ms); update-decision-time',clock_regressed:host<saved};
}
export function event(db:Database.Database,sid:number,op:string,e:Envelope,at:Row,messageId:number|null,extra:Row={}) {
  const m=messageId===null?null:db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as Row;
  const membership=m?binding(db,m.id):null;
  const taskIds=membership?JSON.parse(membership.task_ids):extra.task_ids??[];
  db.prepare('INSERT INTO communication_events(scope_id,operation,at,from_agent,to_agent,task_ids,task_binding,purpose,status,message_id,request_id,actor,session_id,details_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(sid,op,at.now,m?.from_agent??e.actor,m?.to_agent??null,JSON.stringify(taskIds),membership?.task_binding??(taskIds.length?'assigned':'unassigned'),m?.message_purpose??op,m?.status??'recorded',messageId,e.request_id,e.actor,e.session_id,JSON.stringify({...extra,...(membership?{binding_basis:membership.basis,binding_coverage:membership.coverage,binding_evidence:JSON.parse(membership.evidence_json)}:{}),clock_regressed:at.clock_regressed}));
}
/** Same-instance receipts. Hook injection is library/test-only, never an MCP argument. */
export function mutation(db:Database.Database,sid:number,op:string,args:Row,e:Envelope,fn:(at:Row)=>Outcome,hooks:Hooks={},present:(o:Outcome,at:Row)=>Row=o=>o.result):Row {
  return run(db,sid,op,args,e,fn,hooks,present);
}
/** Fixed classifier only: neither operation nor business callback is supplied by its caller. */
export function resolveTaskWait(db:Database.Database,sid:number,args:ResolveWaitArgs,e:Envelope,hooks:Hooks={}):Row {
  return run(db,sid,'resolve_task_wait_v2',args,e,at=>classifyWait(db,sid,args,e,at),hooks,
    out=>({...out.result,current_ready:!!(db.prepare('SELECT ready FROM bus_meta').get() as Row).ready}),
    out=>{out.result.ready_at_classification=reassessReady(db);});
}
export function validateMutationInput(db:Database.Database,args:Row,e:Envelope,validate:()=>void):void {
  try{validate();}catch(error){if(error&&typeof error==='object')Object.assign(error,observeFailure(db,error,args??{},e??{}));throw error;}
}
/** Only this fixed operation admits a new identity. */
export function registerMutation(db:Database.Database,sid:number,args:RegisterArgs,e:Envelope,hooks:Hooks={}):Row {
  validateMutationInput(db,args,e,()=>{input(args,['role','provider','expected_registration_revision']);textInput(args.role);textInput(args.provider);revision(args.expected_registration_revision,0);});
  return run(db,sid,'register_v2',args,e,at=>{
    const result=registerBusiness(db,sid,args,e,at.now);
    event(db,sid,'register_v2',e,at,null,{registration_generation:result.registration_generation,registration_revision:result.registration_revision});
    return {result};
  },hooks,o=>o.result,undefined,true);
}
function run(db:Database.Database,sid:number,op:string,args:Row,e:Envelope,fn:(at:Row)=>Outcome,hooks:Hooks,present:(o:Outcome,at:Row)=>Row,finalize?:(out:Outcome)=>void,bootstrap=false):Row {
  if(existsSync(db.name+'.replace.lock'))throw new Error('RECOVERY_REPLACE_REFUSED');
  if(!e||typeof e!=='object'||Array.isArray(e)||Object.keys(e).some(k=>!['origin_instance_uuid','actor','session_id','request_id'].includes(k))){const error=new Error('INVALID_ENVELOPE');Object.assign(error,observeFailure(db,error,args??{},e??{}));throw error;}
  for(const k of ['origin_instance_uuid','actor','session_id','request_id'] as const)if(typeof e[k]!=='string'||!e[k].trim()){const error=new Error('INVALID_ENVELOPE');Object.assign(error,observeFailure(db,error,args,e));throw error;}
  const digest=sha(canonical({api:apiVersion,operation:op,args,scope_id:sid,session_id:e.session_id}));
  for(let attempt=0;attempt<3;attempt++) {
    let committed=false,regressed=false;
    try {
      const result=db.transaction(()=>{
        if(existsSync(db.name+'.replace.lock')||existsSync(db.name+'.replacement.json'))throw new Error('RECOVERY_REPLACE_REFUSED');
        hooks.fault?.('locked');
        const meta=db.prepare('SELECT * FROM bus_meta').get() as Row;
        if(e.origin_instance_uuid!==meta.instance_uuid)throw new Error('RECOVERY_OUTCOME_UNKNOWN');
        if(meta.recovery_state==='recovery_outcome_unknown')throw new Error('RECOVERY_OUTCOME_UNKNOWN');
        if(meta.recovery_state!=='development_only')throw new Error('RECOVERY_READ_ONLY');
        const savedIdentity=identity(db,sid,e);
        if(!savedIdentity && (!bootstrap || db.prepare('SELECT 1 FROM registered_sessions WHERE session_id=?').get(e.session_id)))throw new Error('SESSION_SCOPE_MISMATCH');
        if(!db.prepare('SELECT 1 FROM scopes WHERE scope_id=?').get(sid))throw new Error('SCOPE_NOT_FOUND');
        const old=db.prepare('SELECT * FROM operation_receipts WHERE origin_instance_uuid=? AND actor=? AND request_id=?').get(e.origin_instance_uuid,e.actor,e.request_id) as Row|undefined;
        if(old && old.input_digest!==digest)throw new Error('REQUEST_ID_REUSE');
        if(!old && (!bootstrap || savedIdentity) && !activeSession(db,sid,e))throw new Error('SESSION_REVOKED');
        if(!meta.ready && !finalize)throw new Error('MIGRATION_ISSUES_READ_ONLY');
        const at=clock(db,hooks);regressed=at.clock_regressed;
        db.prepare('UPDATE bus_meta SET lease_clock_ms=?').run(at.now);
        // Keep observed time outside the business savepoint. Return errors only after its COMMIT.
        try {
          const value=db.transaction(()=>{
            const response=(out:Outcome,replayed:boolean)=>{
              const active=activeSession(db,sid,e);
              const value=present({result:structuredClone(out.result),secret:active?out.secret:{}},at);
              if(!active)for(const item of value.items??[]){
                delete item.token;delete item.reply_token;
                if(item.generation!==undefined)item.lease_valid=false;
                if(item.reply_generation!==undefined)item.authority_valid=false;
              }
              return {...value,replayed,session_active_now:active};
            };
            if(old)return response({result:JSON.parse(old.result_json),secret:JSON.parse(old.secret_json)},true);
            const out=fn(at);
            db.prepare('INSERT INTO operation_receipts(origin_instance_uuid,actor,request_id,executed_instance_uuid,operation,input_digest,result_json,committed_at,secret_json) VALUES(?,?,?,?,?,?,?,?,?)')
              .run(e.origin_instance_uuid,e.actor,e.request_id,meta.instance_uuid,op,digest,JSON.stringify(out.result),at.now,JSON.stringify(out.secret??{}));
            if(finalize){
              finalize(out);
              db.prepare('UPDATE operation_receipts SET result_json=? WHERE origin_instance_uuid=? AND actor=? AND request_id=?').run(JSON.stringify(out.result),e.origin_instance_uuid,e.actor,e.request_id);
            }
            hooks.fault?.('before_commit');
            return response(out,false);
          })();
          return {ok:true as const,value};
        }catch(error) {
          // Some SQLite storage failures abort the whole transaction, not just a savepoint.
          if(!db.inTransaction)throw error;
          return {ok:false as const,error};
        }
      }).immediate();
      const clockDiagnostic=regressed?observeClock(db,args,e):null;
      if(!result.ok)throw result.error;
      committed=true;hooks.fault?.('after_commit');return clockDiagnostic?{...result.value,clock_observability:clockDiagnostic.observability}:result.value;
    }catch(error) {
      if(!committed && (error as Row).code==='SQLITE_BUSY' && attempt<2)continue;
      const diagnostic=observeFailure(db,error,args,e);
      if(error && typeof error==='object')Object.assign(error,diagnostic);
      throw error;
    }
  }
  throw new Error('SQLITE_BUSY');
}

export type ResolveWaitArgs={task_id:number;expected_task_revision:number;issue_id:number;
 wait_kind:'technical'|'human';blocked_reason:string;human_question_id?:number|null;blocked_on_task_id?:number|null;
 evidence_refs:{table:'tasks'|'messages'|'migration_issues';id:number}[]};
function fail():never {throw new Error('WAIT_RESOLUTION_INTEGRITY');}
/** Internal fixed business operation; callers enter via mutation.resolveTaskWait. */
function classifyWait(db:Database.Database,sid:number,args:ResolveWaitArgs,e:Envelope,at:Row):Outcome {
 if(Object.keys(args).some(k=>!['task_id','expected_task_revision','issue_id','wait_kind','blocked_reason','human_question_id','blocked_on_task_id','evidence_refs'].includes(k)) ||
  !Number.isSafeInteger(args.task_id)||args.task_id<1||!Number.isSafeInteger(args.issue_id)||args.issue_id<1||
  !Number.isSafeInteger(args.expected_task_revision)||args.expected_task_revision<0)throw new Error('INVALID_INPUT');
 const old=db.prepare('SELECT * FROM tasks WHERE id=? AND scope_id=?').get(args.task_id,sid) as Row|undefined;
 if(!old)throw new Error('TARGET_NOT_FOUND');
 if(old.task_revision!==args.expected_task_revision)throw new Error('REVISION_CONFLICT');
 const issue=db.prepare("SELECT * FROM migration_issues WHERE issue_id=? AND source_table='tasks' AND source_id=? AND code='WAIT_UNCLASSIFIED'").get(args.issue_id,old.id) as Row|undefined;
 if(old.state!=='blocked'||old.wait_kind!=='unknown'||old.migration_issue_id!==args.issue_id||!issue||db.prepare('SELECT 1 FROM task_wait_resolutions WHERE issue_id=? OR task_id=?').get(args.issue_id,old.id))throw new Error('WAIT_NOT_UNCLASSIFIED');
 if(!Array.isArray(args.evidence_refs)||!args.evidence_refs.length||args.evidence_refs.length>16)throw new Error('EVIDENCE_REFERENCE_REQUIRED');
 for(const ref of args.evidence_refs){
  if(!ref||Object.keys(ref).some(k=>!['table','id'].includes(k))||!Number.isSafeInteger(ref.id)||ref.id<1)throw new Error('INVALID_EVIDENCE_REFERENCE');
  if(ref.table==='migration_issues'){if(ref.id!==issue.issue_id)throw new Error('INVALID_EVIDENCE_REFERENCE');}
  else if(!['tasks','messages'].includes(ref.table)||!db.prepare(`SELECT 1 FROM ${ref.table} WHERE id=? AND scope_id=?`).get(ref.id,sid))throw new Error('INVALID_EVIDENCE_REFERENCE');
 }
 const next={...old,wait_kind:args.wait_kind,blocked_reason:args.blocked_reason,
  human_question_id:args.human_question_id??null,blocked_on_task_id:args.blocked_on_task_id??null,
  task_revision:old.task_revision+1,updated_at:at.now};
 validateTask(db,next);
 const changed=db.prepare('UPDATE tasks SET wait_kind=?,blocked_reason=?,human_question_id=?,blocked_on_task_id=?,task_revision=?,updated_at=? WHERE id=? AND scope_id=? AND task_revision=?')
  .run(next.wait_kind,next.blocked_reason,next.human_question_id,next.blocked_on_task_id,next.task_revision,at.now,old.id,sid,old.task_revision);
 if(changed.changes!==1)throw new Error('REVISION_CONFLICT');
 event(db,sid,'resolve_task_wait_v2',e,at,null,{task_ids:[old.id],issue_id:issue.issue_id,task_revision:next.task_revision,wait_kind:next.wait_kind,evidence_refs:args.evidence_refs});
 const eventId=(db.prepare('SELECT last_insert_rowid() id').get() as Row).id;
 const resolutionId=Number(db.prepare('INSERT INTO task_wait_resolutions(issue_id,task_id,scope_id,task_revision,before_json,after_json,input_json,evidence_json,origin_instance_uuid,actor,session_id,request_id,at,event_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(issue.issue_id,old.id,sid,next.task_revision,JSON.stringify({task:old,issue}),JSON.stringify(next),JSON.stringify(args),JSON.stringify(args.evidence_refs),e.origin_instance_uuid,e.actor,e.session_id,e.request_id,at.now,eventId).lastInsertRowid);
 return {result:{task_id:old.id,task_revision:next.task_revision,state:'blocked',wait_kind:next.wait_kind,issue_id:issue.issue_id,resolution_id:resolutionId,classification_succeeded:true}};
}
/** All scopes, inside the same business SAVEPOINT after the new receipt insert. */
function reassessReady(db:Database.Database):boolean {
 if((db.pragma('foreign_key_check') as Row[]).length)fail();
 const tasks=db.prepare('SELECT * FROM tasks').all() as Row[],issues=db.prepare('SELECT * FROM migration_issues').all() as Row[];
 const resolved=new Set<number>();
 for(const r of db.prepare('SELECT * FROM task_wait_resolutions').all() as Row[]){
  const t=tasks.find(t=>t.id===r.task_id),i=issues.find(i=>i.issue_id===r.issue_id);
  const before=JSON.parse(r.before_json),after=JSON.parse(r.after_json),args=JSON.parse(r.input_json);
  const receipt=db.prepare('SELECT * FROM operation_receipts WHERE origin_instance_uuid=? AND actor=? AND request_id=?').get(r.origin_instance_uuid,r.actor,r.request_id) as Row|undefined;
  const audit=db.prepare('SELECT * FROM communication_events WHERE event_id=?').get(r.event_id) as Row|undefined;
  if(!t||!i||i.code!=='WAIT_UNCLASSIFIED'||i.source_table!=='tasks'||i.source_id!==t.id||t.migration_issue_id!==i.issue_id||t.scope_id!==r.scope_id||t.task_revision<r.task_revision||t.wait_kind==='unknown'||
   canonical(before.issue)!==canonical(i)||before.task.id!==t.id||before.task.scope_id!==r.scope_id||before.task.state!=='blocked'||before.task.wait_kind!=='unknown'||before.task.migration_issue_id!==i.issue_id||before.task.task_revision+1!==r.task_revision||
   after.id!==t.id||after.scope_id!==r.scope_id||after.state!=='blocked'||!['technical','human'].includes(after.wait_kind)||after.task_revision!==r.task_revision||
   args.task_id!==t.id||args.issue_id!==i.issue_id||args.expected_task_revision!==before.task.task_revision||args.wait_kind!==after.wait_kind||args.blocked_reason!==after.blocked_reason||
   (args.human_question_id??null)!==after.human_question_id||(args.blocked_on_task_id??null)!==after.blocked_on_task_id||canonical(args.evidence_refs)!==canonical(JSON.parse(r.evidence_json))||
   !receipt||receipt.committed_at!==r.at||receipt.operation!=='resolve_task_wait_v2'||receipt.executed_instance_uuid!==r.origin_instance_uuid||receipt.input_digest!==sha(canonical({api:apiVersion,operation:'resolve_task_wait_v2',args,scope_id:r.scope_id,session_id:r.session_id}))||
   !audit||audit.operation!=='resolve_task_wait_v2'||audit.scope_id!==r.scope_id||audit.actor!==r.actor||audit.session_id!==r.session_id||audit.request_id!==r.request_id||audit.at!==r.at||canonical(JSON.parse(audit.task_ids))!==canonical([t.id]))fail();
  const details=JSON.parse(audit.details_json);
  if(details.issue_id!==i.issue_id||details.task_revision!==r.task_revision||details.wait_kind!==after.wait_kind||canonical(details.evidence_refs)!==canonical(args.evidence_refs))fail();
  const expectedAfter={...before.task,wait_kind:args.wait_kind,blocked_reason:args.blocked_reason,human_question_id:args.human_question_id??null,blocked_on_task_id:args.blocked_on_task_id??null,task_revision:r.task_revision,updated_at:r.at};
  if(canonical(expectedAfter)!==canonical(after))fail();
  const result=JSON.parse(receipt.result_json);
  if(result.state!=='blocked'||result.resolution_id!==r.resolution_id||result.task_id!==t.id||result.task_revision!==r.task_revision||result.issue_id!==i.issue_id||result.wait_kind!==after.wait_kind||result.classification_succeeded!==true)fail();
  // Later normal transitions may change the Task; the immutable classification remains historical.
  if(t.task_revision===r.task_revision && canonical(t)!==canonical(after))fail();
  resolved.add(i.issue_id);
 }
 for(const t of tasks){
  if(!db.prepare('SELECT 1 FROM scopes WHERE scope_id=? AND project IS ? AND area IS ? AND team IS ?').get(t.scope_id,t.project,t.area,t.team))fail();
  if(t.wait_kind==='unknown'){
   if(t.state!=='blocked'||t.human_question_id!==null||!issues.some(i=>i.issue_id===t.migration_issue_id&&i.code==='WAIT_UNCLASSIFIED'&&i.source_table==='tasks'&&i.source_id===t.id))fail();
   if(t.blocked_on_task_id!==null && !tasks.some(d=>d.id===t.blocked_on_task_id&&d.id!==t.id&&d.scope_id===t.scope_id))fail();
  }else validateTask(db,t);
 }
 if(db.prepare(`SELECT 1 FROM messages m LEFT JOIN scopes s ON s.scope_id=m.scope_id LEFT JOIN conversations c ON c.conversation_id=m.conversation_id
   WHERE s.scope_id IS NULL OR s.project IS NOT m.project OR s.area IS NOT m.area OR s.team IS NOT m.team OR c.scope_id IS NOT m.scope_id OR (m.thread_id IS NOT NULL AND c.thread_id IS NOT m.thread_id) LIMIT 1`).get())fail();
 if(db.prepare(`SELECT 1 FROM task_conversation_versions v JOIN tasks t ON t.id=v.task_id JOIN conversations c ON c.conversation_id=v.conversation_id WHERE t.scope_id<>c.scope_id LIMIT 1`).get())fail();
 if(db.prepare(`SELECT 1 FROM messages m JOIN messages q ON q.id=m.reply_to WHERE m.scope_id IS NOT q.scope_id LIMIT 1`).get())fail();
 if(db.prepare(`SELECT 1 FROM ask_answers a JOIN messages q ON q.id=a.ask_id JOIN messages r ON r.id=a.reply_id WHERE q.kind<>'ask' OR r.kind<>'reply' OR r.reply_to IS NOT q.id OR q.scope_id IS NOT r.scope_id LIMIT 1`).get())fail();
 const ready=issues.every(i=>resolved.has(i.issue_id))&&!tasks.some(t=>t.wait_kind==='unknown');
 db.prepare('UPDATE bus_meta SET ready=?').run(Number(ready));return ready;
}
