import { randomBytes } from 'node:crypto';
import {activeRecipient} from './registration-state.js';
import { saveBinding } from './binding.js';
import { Store } from './store.js';
import type { Row,Scope } from './schema.js';
import { mutation,session,clock,event,sha,type Envelope,type Hooks,type Outcome } from './mutation.js';
function num(n:number,min=1,max=Number.MAX_SAFE_INTEGER) {if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('INVALID_INPUT');return n;}
function str(s:string) {if(typeof s!=='string'||!s.trim())throw new Error('INVALID_INPUT');return s;}
function keys(o:Row,allowed:string[]) {if(Object.keys(o).some(k=>!allowed.includes(k)))throw new Error('INVALID_INPUT');}
const token=()=>randomBytes(32).toString('hex');
export class Delivery extends Store {
  constructor(path:string,scope:Scope,readonly hooks:Hooks={}){super(path,scope);}
  private message(id:number,e:Envelope):Row {
    const m=this.db.prepare('SELECT * FROM messages WHERE id=? AND scope_id=?').get(num(id),this.sid) as Row|undefined;
    if(!m)throw new Error('MESSAGE_NOT_FOUND');
    if(m.to_agent!==e.actor)throw new Error('RECIPIENT_MISMATCH');return m;
  }
  private state(id:number):Row {
    const d=this.db.prepare('SELECT * FROM delivery_state WHERE message_id=?').get(id) as Row|undefined;
    if(!d)throw new Error('DELIVERY_STATE_INVALID');return d;
  }
  private run(op:string,args:Row,e:Envelope,fn:(at:Row)=>Outcome):Row {
    return mutation(this.db,this.sid,op,args,e,fn,this.hooks,(out,at)=>{
      const result=JSON.parse(JSON.stringify(out.result));
      for(const item of result.items??[]) {
        const m=this.db.prepare('SELECT * FROM messages WHERE id=?').get(item.message_id) as Row;
        const d=this.state(item.message_id),secret=out.secret?.[item.message_id];
        if(item.generation!==undefined) {
          item.lease_valid=m.status==='pending'&&d.mode==='guarded'&&d.generation===item.generation&&d.holder_session===e.session_id&&d.deadline>at.now&&!!secret?.token&&d.token_hash===sha(secret.token);
          if(item.lease_valid)item.token=secret.token;
        }
        if(item.reply_generation!==undefined) {
          item.authority_valid=m.status==='delivered'&&d.mode==='guarded'&&d.reply_generation===item.reply_generation&&d.reply_holder_session===e.session_id&&!!secret?.reply_token&&d.reply_token_hash===sha(secret.reply_token);
          if(item.authority_valid)item.reply_token=secret.reply_token;
        }
      }
      return {...result,clock_basis:at.clock_basis,clock_regressed:at.clock_regressed};
    });
  }
  private checked(result:{changes:number}) {if(result.changes!==1)throw new Error('CONCURRENT_UPDATE');}
  private save(kind:'msg'|'ask'|'reply',to:string,content:string,cid:number,taskId:number|null,replyTo:number|null,e:Envelope,at:Row):number {
    str(to);str(content);
    const c=this.db.prepare('SELECT c.*,s.project,s.area,s.team FROM conversations c JOIN scopes s USING(scope_id) WHERE conversation_id=? AND scope_id=?').get(num(cid),this.sid) as Row|undefined;
    if(!c)throw new Error('CONVERSATION_NOT_FOUND');
    if(!activeRecipient(this.db,this.sid,to))throw new Error('RECIPIENT_SCOPE_MISMATCH');
    if(taskId!==null) {
      if(!this.db.prepare('SELECT 1 FROM tasks WHERE id=? AND scope_id=?').get(num(taskId),this.sid))throw new Error('TASK_SCOPE_MISMATCH');
      if(!this.db.prepare('SELECT 1 FROM task_conversation_versions WHERE task_id=? AND conversation_id=? AND ended_rev IS NULL').get(taskId,cid)) {
        this.db.prepare('UPDATE bus_meta SET relation_revision=relation_revision+1').run();
        const rev=(this.db.prepare('SELECT relation_revision FROM bus_meta').get() as Row).relation_revision;
        this.db.prepare('INSERT INTO task_conversation_versions(task_id,conversation_id,born_rev,reason,actor) VALUES(?,?,?,?,?)').run(taskId,cid,rev,'communication',e.actor);
        event(this.db,this.sid,'link_conversation',e,at,null,{task_ids:[taskId],conversation_id:cid});
      }
    }
    if(replyTo!==null) {
      const q=this.db.prepare('SELECT * FROM messages WHERE id=? AND scope_id=? AND conversation_id=?').get(num(replyTo),this.sid,cid) as Row|undefined;
      if(!q)throw new Error('REPLY_TARGET_NOT_FOUND');
      if(q.kind==='ask'&&kind!=='reply')throw new Error('ASK_REPLY_REQUIRES_AUTHORITY');
    }
    const id=Number(this.db.prepare(`INSERT INTO messages(from_agent,to_agent,kind,content,reply_to,status,created_at,thread_id,project,area,team,scope_id,conversation_id,message_purpose)
      VALUES(?,?,?,?,?,'pending',?,?,?,?,?,?,?,?)`).run(e.actor,to,kind,content,replyTo,at.now,c.thread_id,c.project,c.area,c.team,this.sid,cid,kind).lastInsertRowid);
    this.db.prepare("INSERT INTO delivery_state(message_id,mode) VALUES(?,'guarded')").run(id);
    saveBinding(this.db,id,taskId,kind==='reply'?replyTo:null);return id;
  }
  send(args:{to:string;content:string;conversation_id:number;task_id:number|null;reply_to?:number},e:Envelope,ask=false):Row {
    return this.run(ask?'ask_async_v2':'send_message_v2',args,e,at=>{
      keys(args,['to','content','conversation_id','task_id','reply_to']);
      if(!Object.hasOwn(args,'task_id'))throw new Error('TASK_BINDING_REQUIRED');
      const id=this.save(ask?'ask':'msg',args.to,args.content,args.conversation_id,args.task_id,args.reply_to??null,e,at);
      event(this.db,this.sid,ask?'ask':'send',e,at,id);return {result:{message_id:id}};
    });
  }
  ask(args:{to:string;content:string;conversation_id:number;task_id:number|null},e:Envelope){return this.send(args,e,true);}
  preview(e:Envelope,limit=100):Row {
    num(limit,1,500);session(this.db,this.sid,e);
    return this.db.transaction(()=>{
      const at=clock(this.db,this.hooks);
      const items=(this.db.prepare(`SELECT m.id AS message_id,m.kind,m.status,d.deadline,d.token_hash FROM messages m JOIN delivery_state d ON d.message_id=m.id
        WHERE m.scope_id=? AND m.to_agent=? AND m.status='pending' ORDER BY m.id LIMIT ?`).all(this.sid,e.actor,limit) as Row[])
        .map(({token_hash,...m})=>({...m,lease_active:!!token_hash&&m.deadline>at.now}));
      return {items,body_included:false,clock_basis:at.clock_basis};
    })();
  }
  private replyAuthority(id:number,sessionId:string):Row {
    const t=token();
    this.checked(this.db.prepare('UPDATE delivery_state SET reply_generation=reply_generation+1,reply_holder_session=?,reply_token_hash=? WHERE message_id=?').run(sessionId,sha(t),id));
    return {reply_generation:this.state(id).reply_generation,reply_token:t};
  }
  claim(args:{lease_ms:number;limit:number},e:Envelope){return this.receive(args,e,false);}
  immediate(args:{limit:number},e:Envelope){return this.receive(args,e,true);}
  private receive(args:{lease_ms?:number;limit:number},e:Envelope,immediate:boolean):Row {
    return this.run(immediate?'receive_immediate_v2':'claim_messages_v2',args,e,at=>{
      keys(args,immediate?['limit']:['limit','lease_ms']);num(args.limit,1,500);if(!immediate)num(args.lease_ms!,1000,300000);
      const ids=this.db.prepare(`SELECT m.id,m.kind FROM messages m JOIN delivery_state d ON d.message_id=m.id
        WHERE m.scope_id=? AND m.to_agent=? AND m.status='pending' AND d.mode='guarded'
        AND (d.token_hash IS NULL OR d.deadline<=?) ORDER BY m.id LIMIT ?`).all(this.sid,e.actor,at.now,args.limit) as Row[];
      const items:Row[]=[],secret:Row={};
      for(const m of ids) {
        const t=immediate?null:token();
        const changed=this.db.prepare(`UPDATE delivery_state SET generation=generation+1,token_hash=?,holder_session=?,deadline=?
          WHERE message_id=? AND mode='guarded' AND (token_hash IS NULL OR deadline<=?)
          AND EXISTS(SELECT 1 FROM messages WHERE id=? AND status='pending' AND scope_id=? AND to_agent=?)`)
          .run(t?sha(t):null,immediate?null:e.session_id,immediate?null:at.now+args.lease_ms!,m.id,at.now,m.id,this.sid,e.actor);
        if(changed.changes!==1)continue;
        const d=this.state(m.id);const item:Row={message_id:m.id};
        if(immediate) {
          this.checked(this.db.prepare("UPDATE messages SET status='delivered',delivered_at=? WHERE id=? AND status='pending'").run(at.now,m.id));
          this.db.prepare("UPDATE delivery_state SET completed_generation=generation,completion_kind='immediate' WHERE message_id=?").run(m.id);
          if(m.kind==='ask') {const a=this.replyAuthority(m.id,e.session_id);item.reply_generation=a.reply_generation;secret[m.id]={reply_token:a.reply_token};}
        }else {Object.assign(item,{generation:d.generation,deadline:d.deadline});secret[m.id]={token:t};}
        items.push(item);event(this.db,this.sid,immediate?'receive_immediate':'claim',e,at,m.id);
      }
      if(!items.length)event(this.db,this.sid,immediate?'receive_immediate_empty':'claim_empty',e,at,null);
      return {result:{items},secret};
    });
  }
  private claimAuthority(m:Row,d:Row,args:Row,e:Envelope,at:Row) {
    if(d.mode!=='guarded')throw new Error('LEGACY_READ_ONLY');
    if(m.status!=='pending'||d.generation!==args.generation)throw new Error('STALE_CLAIM');
    if(d.holder_session!==e.session_id)throw new Error('SESSION_MISMATCH');
    if(d.deadline===null||d.deadline<=at.now)throw new Error('LEASE_EXPIRED');
    if(typeof args.token!=='string'||!args.token||d.token_hash!==sha(args.token))throw new Error('TOKEN_REQUIRED');
  }
  ack(args:{message_id:number;generation:number;token:string|null},e:Envelope):Row {
    return this.run('ack_v2',args,e,at=>{
      keys(args,['message_id','generation','token']);
      const m=this.message(args.message_id,e),d=this.state(m.id);this.claimAuthority(m,d,args,e,at);
      this.checked(this.db.prepare("UPDATE messages SET status='delivered',delivered_at=? WHERE id=? AND status='pending'").run(at.now,m.id));
      this.checked(this.db.prepare("UPDATE delivery_state SET completed_generation=generation,completion_kind='ack',token_hash=NULL,holder_session=NULL,deadline=NULL WHERE message_id=? AND generation=?").run(m.id,args.generation));
      const item:Row={message_id:m.id},secret:Row={};
      if(m.kind==='ask') {const a=this.replyAuthority(m.id,e.session_id);item.reply_generation=a.reply_generation;secret[m.id]={reply_token:a.reply_token};}
      event(this.db,this.sid,'ack',e,at,m.id);return {result:{items:[item]},secret};
    });
  }
  reply(args:{message_id:number;content:string;generation?:number;token?:string|null;reply_generation?:number;reply_token?:string|null},e:Envelope):Row {
    return this.run('reply_v2',args,e,at=>{
      keys(args,['message_id','content','generation','token','reply_generation','reply_token']);str(args.content);
      const m=this.message(args.message_id,e),d=this.state(m.id);
      if(m.kind!=='ask')throw new Error('ASK_REQUIRED');
      if(m.status==='answered'||m.replied_at!==null||this.db.prepare('SELECT 1 FROM messages WHERE reply_to=? AND kind=\'reply\'').get(m.id))throw new Error('ALREADY_ANSWERED');
      if(m.status==='pending')this.claimAuthority(m,d,args,e,at);
      else if(d.mode!=='guarded'||d.reply_generation!==args.reply_generation||d.reply_holder_session!==e.session_id||typeof args.reply_token!=='string'||!args.reply_token||d.reply_token_hash!==sha(args.reply_token))throw new Error('STALE_REPLY_AUTH');
      const id=this.save('reply',m.from_agent,args.content,m.conversation_id,null,m.id,e,at);
      this.db.prepare('INSERT INTO ask_answers VALUES(?,?)').run(m.id,id);
      this.checked(this.db.prepare("UPDATE messages SET status='answered',replied_at=?,delivered_at=coalesce(delivered_at,?) WHERE id=? AND status=? AND replied_at IS NULL").run(at.now,at.now,m.id,m.status));
      this.checked(this.db.prepare("UPDATE delivery_state SET completed_generation=generation,completion_kind='reply',token_hash=NULL,holder_session=NULL,deadline=NULL,reply_token_hash=NULL WHERE message_id=?").run(m.id));
      event(this.db,this.sid,'reply_created',e,at,id);event(this.db,this.sid,'answered',e,at,m.id);
      return {result:{message_id:m.id,reply_id:id}};
    });
  }
  transfer(args:{message_id:number;new_session_id:string;expected_reply_generation:number;prior_holder_session:string|null;termination_evidence_ref:string},e:Envelope):Row {
    return this.run('transfer_reply_authority_v2',args,e,at=>{
    keys(args,['message_id','new_session_id','expected_reply_generation','prior_holder_session','termination_evidence_ref']);
    str(args.termination_evidence_ref);num(args.expected_reply_generation,0);if(args.new_session_id!==e.session_id)throw new Error('SESSION_MISMATCH');
      const m=this.message(args.message_id,e),d=this.state(m.id);
      if(m.kind!=='ask')throw new Error('ASK_REQUIRED');
      if(m.status==='answered'||m.replied_at!==null||this.db.prepare("SELECT 1 FROM messages WHERE reply_to=? AND kind='reply'").get(m.id))throw new Error('ALREADY_ANSWERED');
      if(m.status!=='delivered')throw new Error('NOT_DELIVERED');
      if(!['guarded','legacy_terminal'].includes(d.mode))throw new Error('DELIVERY_STATE_INVALID');
      if(d.reply_generation!==args.expected_reply_generation||d.reply_holder_session!==args.prior_holder_session)throw new Error('STALE_REPLY_AUTH');
      const t=token();
      this.checked(this.db.prepare("UPDATE delivery_state SET mode='guarded',reply_generation=reply_generation+1,reply_holder_session=?,reply_token_hash=? WHERE message_id=? AND reply_generation=? AND reply_holder_session IS ?").run(e.session_id,sha(t),m.id,args.expected_reply_generation,args.prior_holder_session));
      event(this.db,this.sid,'transfer_reply_authority',e,at,m.id,{prior_holder_session:args.prior_holder_session,termination_evidence_ref:args.termination_evidence_ref});
      return {result:{items:[{message_id:m.id,reply_generation:this.state(m.id).reply_generation}]},secret:{[m.id]:{reply_token:t}}};
    });
  }
}
