import { Store } from './store.js';
import { coverage } from './observation.js';
import type { Row } from './schema.js';
type EventPage={cursor?:string;limit?:number;task_id?:number;code?:string;source?:string};
export class Queries extends Store {
 private scan(table:'error_events'|'communication_events',opts:EventPage):Row {
  const allowed=table==='error_events'?['cursor','limit','task_id','code','source']:['cursor','limit','task_id'];
  if(Object.keys(opts).some(k=>!allowed.includes(k)))throw new Error('MUTABLE_FILTER_UNSUPPORTED');
  if(opts.task_id!==undefined)this.target('tasks',opts.task_id);
  const filters:Row={};for(const k of ['task_id','code','source'] as const)if(opts[k]!==undefined)filters[k]=opts[k];
  if(opts.code!==undefined && (typeof opts.code!=='string'||opts.code.length>64))throw new Error('INVALID_INPUT');
  if(opts.source!==undefined&&!['bus','agent_report'].includes(opts.source))throw new Error('INVALID_INPUT');
  const conditions=['scope_id=?','event_id>?','event_id<=?'];
  if(opts.task_id!==undefined)conditions.push('EXISTS(SELECT 1 FROM json_each(task_ids) WHERE value=?)');
  if(opts.code!==undefined)conditions.push('code=?');if(opts.source!==undefined)conditions.push('source=?');
  return this.page(table,opts.task_id??null,{limit:opts.limit,cursor:opts.cursor},(c,n)=>this.db.prepare(`SELECT event_id AS page_id,* FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY event_id LIMIT ?`)
   .all(this.sid,c.last,c.upper,...Object.values(filters),n) as Row[],()=>({upper:(this.db.prepare(`SELECT coalesce(max(event_id),0) n FROM ${table} WHERE scope_id=?`).get(this.sid) as Row).n,
    coverage:{...coverage(this.db,this.sid),task_filter_excludes_unknown:opts.task_id!==undefined,
     unknown_membership_messages:(this.db.prepare("SELECT count(*) n FROM message_bindings b JOIN messages m ON m.id=b.message_id WHERE m.scope_id=? AND b.task_binding='unknown'").get(this.sid) as Row).n,
     historical_communication:'not_reconstructed'}}),filters);
 }
 listErrors(opts:EventPage={}){return this.scan('error_events',opts);}
 listCommunicationEvents(opts:EventPage={}){return this.scan('communication_events',opts);}
 getError(id:number):Row {
  if(!Number.isSafeInteger(id)||id<1)throw new Error('INVALID_INPUT');
  const r=this.db.prepare('SELECT * FROM error_events WHERE event_id=? AND scope_id=?').get(id,this.sid) as Row|undefined;
  if(!r)throw new Error('TARGET_NOT_FOUND');return r;
 }
 statusSummary(opts:{task_id?:number;limit?:number}={}):Row {
  if(Object.keys(opts).some(k=>!['task_id','limit'].includes(k)))throw new Error('INVALID_INPUT');
  const limit=opts.limit??20;if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('INVALID_INPUT');
  if(opts.task_id!==undefined)this.target('tasks',opts.task_id);
  return this.db.transaction(()=>{
   const filter=opts.task_id===undefined?'':' AND id=?',args=opts.task_id===undefined?[this.sid]:[this.sid,opts.task_id];
   const total=(this.db.prepare('SELECT count(*) n FROM tasks WHERE scope_id=?'+filter).get(...args) as Row).n;
   const tasks=(this.db.prepare('SELECT * FROM tasks WHERE scope_id=?'+filter+' ORDER BY id LIMIT ?').all(...args,limit) as Row[]).map(t=>{
    const answer=t.human_question_id===null?null:this.db.prepare('SELECT reply_id FROM ask_answers WHERE ask_id=?').get(t.human_question_id) as Row|undefined;
    const agent=t.claimed_by===null?null:this.db.prepare(`SELECT a.actor AS name,a.role,a.provider,a.status,a.active,a.generation,a.registered_at,a.updated_at,s.session_id,s.active AS session_active,s.registered_at AS session_registered_at,s.revoked_at AS session_revoked_at FROM agent_registrations a LEFT JOIN registered_sessions s USING(scope_id,actor,generation) WHERE a.actor=? AND a.scope_id=? ORDER BY a.generation DESC,s.registered_at DESC,s.session_id LIMIT 1`).get(t.claimed_by,this.sid);
    return {task_id:t.id,title:[...t.title].slice(0,200).join(''),state:t.state,task_revision:t.task_revision,wait_kind:t.wait_kind,
     review_required:!!t.review_required,independent_review:!!t.independent_review,review_state:t.review_state,reviewed_by:t.reviewed_by,review_gate:'not_enforced',
     wait_description:t.wait_kind==='unknown'?'待ち種別未確認・要整理':t.wait_kind==='human'?(answer?'回答済み・未復帰':'人への回答待ち'):t.wait_kind==='technical'?'技術的な待ち':'待ちなし',
     reason:t.blocked_reason===null?null:[...t.blocked_reason].slice(0,200).join(''),human_question_id:t.human_question_id,reply_id:answer?.reply_id??null,migration_issue_id:t.migration_issue_id,
     recorded_agent:agent??null,agent_session_selection:'one_session_from_latest_registration_ordered_by_registered_at_desc_then_session_id; not_all_sessions',agent_liveness:'not_inferred',updated_at:t.updated_at,
     errors:{count:(this.db.prepare('SELECT count(*) n FROM error_events WHERE scope_id=? AND EXISTS(SELECT 1 FROM json_each(task_ids) WHERE value=?)').get(this.sid,t.id) as Row).n,ref:{tool:'list_errors_v2',task_id:t.id},unknown_membership_excluded:true}};
   });
   return {ready:!!(this.db.prepare('SELECT ready FROM bus_meta').get() as Row).ready,tasks,total,truncated:total>limit,body_included:false,observed_at:Date.now(),coverage:coverage(this.db,this.sid),automatic_resume:false};
  })();
 }
}
