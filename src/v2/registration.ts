import {Tasks} from './tasks.js';
import {mutation,event,registerMutation,validateMutationInput,type Envelope} from './mutation.js';
import {input,textInput,revision,type RegisterArgs} from './registration-state.js';
import type {Row} from './schema.js';

export class Registration extends Tasks {
 register(args:RegisterArgs,e:Envelope):Row {return registerMutation(this.db,this.sid,args,e,this.hooks);}
 createConversation(args:{thread_id:string},e:Envelope):Row {
  validateMutationInput(this.db,args,e,()=>{input(args,['thread_id']);textInput(args.thread_id);});
  return mutation(this.db,this.sid,'create_conversation_v2',args,e,at=>{
   const old=this.db.prepare('SELECT conversation_id FROM conversations WHERE scope_id=? AND thread_id=?').get(this.sid,args.thread_id) as Row|undefined;
   const id=old?.conversation_id??Number(this.db.prepare('INSERT INTO conversations(scope_id,thread_id) VALUES(?,?)').run(this.sid,args.thread_id).lastInsertRowid);
   event(this.db,this.sid,'create_conversation_v2',e,at,null,{conversation_id:id,created:!old});
   return {result:{conversation_id:id,created:!old}};
  },this.hooks);
 }
 revokeSession(args:{target_session_id:string;expected_session_revision:number;reason:string;evidence_ref:string},e:Envelope):Row {
  validateMutationInput(this.db,args,e,()=>{input(args,['target_session_id','expected_session_revision','reason','evidence_ref']);textInput(args.target_session_id);textInput(args.reason);textInput(args.evidence_ref);revision(args.expected_session_revision);});
  return mutation(this.db,this.sid,'revoke_session_v2',args,e,at=>{
   const s=this.db.prepare('SELECT * FROM registered_sessions WHERE session_id=? AND scope_id=?').get(args.target_session_id,this.sid) as Row|undefined;
   if(!s)throw new Error('TARGET_NOT_FOUND');
   if(s.revision!==args.expected_session_revision)throw new Error('REVISION_CONFLICT');
   if(!s.active)throw new Error('SESSION_REVOKED');
   this.db.prepare('UPDATE registered_sessions SET active=0,revision=revision+1,revoked_at=? WHERE session_id=?').run(at.now,s.session_id);
   event(this.db,this.sid,'revoke_session_v2',e,at,null,{target_session_id:s.session_id,reason:args.reason,evidence_ref:args.evidence_ref});
   return {result:{session_id:s.session_id,session_revision:s.revision+1,active:false}};
  },this.hooks);
 }
 removeAgent(args:{actor:string;expected_registration_revision:number;reason:string;evidence_ref:string},e:Envelope):Row {
  validateMutationInput(this.db,args,e,()=>{input(args,['actor','expected_registration_revision','reason','evidence_ref']);textInput(args.actor);textInput(args.reason);textInput(args.evidence_ref);revision(args.expected_registration_revision);});
  return mutation(this.db,this.sid,'remove_agent_v2',args,e,at=>{
   const a=this.registration(args.actor,args.expected_registration_revision);
   if(this.db.prepare('SELECT 1 FROM tasks WHERE scope_id=? AND claimed_by=?').get(this.sid,args.actor))throw new Error('TASKS_REQUIRE_RELEASE');
   this.db.prepare('UPDATE agent_registrations SET active=0,revision=revision+1,revoked_at=?,updated_at=? WHERE scope_id=? AND actor=? AND generation=?').run(at.now,at.now,this.sid,args.actor,a.generation);
   this.db.prepare('UPDATE registered_sessions SET active=0,revision=revision+1,revoked_at=? WHERE scope_id=? AND actor=? AND generation=? AND active=1').run(at.now,this.sid,args.actor,a.generation);
   event(this.db,this.sid,'remove_agent_v2',e,at,null,{target_actor:args.actor,reason:args.reason,evidence_ref:args.evidence_ref});
   return {result:{actor:args.actor,registration_revision:a.revision+1,active:false}};
  },this.hooks);
 }
 private registration(actor:string,expected:number):Row {
  const a=this.db.prepare('SELECT * FROM agent_registrations WHERE scope_id=? AND actor=? ORDER BY generation DESC LIMIT 1').get(this.sid,actor) as Row|undefined;
  if(!a)throw new Error('TARGET_NOT_FOUND');
  if(a.revision!==expected)throw new Error('REVISION_CONFLICT');
  if(!a.active)throw new Error('SESSION_REVOKED');return a;
 }
 setAgentStatus(args:{actor:string;expected_registration_revision:number;status:string},e:Envelope):Row {
  validateMutationInput(this.db,args,e,()=>{input(args,['actor','expected_registration_revision','status']);textInput(args.actor);textInput(args.status);revision(args.expected_registration_revision);});
  return mutation(this.db,this.sid,'set_agent_status_v2',args,e,at=>{
   const a=this.registration(args.actor,args.expected_registration_revision);
   this.db.prepare('UPDATE agent_registrations SET status=?,revision=revision+1,updated_at=? WHERE scope_id=? AND actor=? AND generation=?').run(args.status,at.now,this.sid,args.actor,a.generation);
   event(this.db,this.sid,'set_agent_status_v2',e,at,null,{target_actor:args.actor,status:args.status});
   return {result:{actor:args.actor,registration_revision:a.revision+1,status:args.status,recorded_at:at.now,os_liveness:'not_observed'}};
  },this.hooks);
 }
 retireTeam(args:{expected_revision:number;reason:string;evidence_ref:string},e:Envelope):Row {
  validateMutationInput(this.db,args,e,()=>{input(args,['expected_revision','reason','evidence_ref']);revision(args.expected_revision);textInput(args.reason);textInput(args.evidence_ref);});
  return mutation(this.db,this.sid,'retire_team_v2',args,e,at=>{
   const s=this.db.prepare('SELECT * FROM scope_registration_state WHERE scope_id=?').get(this.sid) as Row;
   if(s.revision!==args.expected_revision)throw new Error('REVISION_CONFLICT');
   if(!s.accepting_registrations)throw new Error('REGISTRATION_RETIRED');
   this.db.prepare('UPDATE scope_registration_state SET accepting_registrations=0,revision=revision+1 WHERE scope_id=?').run(this.sid);
   event(this.db,this.sid,'retire_team_v2',e,at,null,{reason:args.reason,evidence_ref:args.evidence_ref});
   return {result:{scope_id:this.sid,registration_state_revision:s.revision+1,accepting_registrations:false,
    notice:'Existing sessions remain usable. After all sessions are revoked, online registration cannot resume. No online reopening API is provided.'}};
  },this.hooks);
 }
}
