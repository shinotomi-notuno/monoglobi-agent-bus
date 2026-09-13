import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { scopeKey, schemaVersion, type Scope, type Row } from './schema.js';

import { mutation, event, type Envelope } from './mutation.js';
type Page={cursor?:string;limit?:number;context_token?:string};
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
function stable(v:any):string {
  if(v===null || typeof v!=='object') return JSON.stringify(v);
  if(Array.isArray(v)) return '['+v.map(stable).join(',')+']';
  return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';
}
function integer(n:number) {if(!Number.isSafeInteger(n)||n<1) throw new Error('INVALID_INPUT');return n;}
export class Store {
  readonly db:Database.Database;
  readonly sid:number;
  private meta:Row;
  private key:Row;
  constructor(readonly path:string, scope:Scope) {
    this.db=new Database(path,{fileMustExist:true});
    try {
      this.db.pragma('foreign_keys=ON');this.db.pragma('busy_timeout=3000');
      this.meta=this.db.prepare('SELECT * FROM bus_meta WHERE singleton=1').get() as Row;
      if(this.meta?.schema_version!==schemaVersion) throw new Error('UNSUPPORTED_SCHEMA');
      try { this.key=JSON.parse(readFileSync(path+'.cursor-key.json','utf8')); } catch { throw new Error('CURSOR_KEY_UNAVAILABLE'); }
      if(this.key.instance!==this.meta.instance_uuid || !/^[a-f0-9]{64}$/.test(this.key.key)) throw new Error('CURSOR_KEY_UNAVAILABLE');
      const s=this.db.prepare('SELECT scope_id FROM scopes WHERE scope_key=?').get(scopeKey(scope)) as Row|undefined;
      if(!s) throw new Error('SCOPE_NOT_FOUND');this.sid=s.scope_id;
    } catch(e) {this.db.close();throw e;}
  }
  close(){this.db.close();}
  capabilities(){const meta=this.db.prepare('SELECT * FROM bus_meta').get() as Row;return {schema:meta.schema_version,api_version:meta.api_version,instance_uuid:meta.instance_uuid,stage:'development-only',ready:!!meta.ready,
    implemented:['errors-read','communication-events-read','status-summary','scopes','relation-versions','targeted-cursors','utf8-chunks'],
    library_only:['formal-registration','registration-revocation','conversation-registration','unknown-wait-resolution','task-transitions','human-wait','delivery','reply-authority','same-instance-receipts','success-events'],
    unavailable:['mcp-writers','recovery','legacy-compatibility'],
    production_ready:false};}
  protected target(table:'tasks'|'conversations'|'messages',id:number):Row {
    const key=table==='conversations'?'conversation_id':'id';
    const r=this.db.prepare(`SELECT * FROM ${table} WHERE ${key}=? AND scope_id=?`).get(integer(id),this.sid) as Row|undefined;
    if(!r) throw new Error('TARGET_NOT_FOUND');return r;
  }
  private sign(data:Row):string {
    const body=Buffer.from(stable(data)).toString('base64url');
    return body+'.'+createHmac('sha256',Buffer.from(this.key.key,'hex')).update(body).digest('base64url');
  }
  private decode(cursor:string,query:Row):Row {
    if(typeof cursor!=='string'||cursor.length>8192) throw new Error('CURSOR_MISMATCH');
    const [body,sig,...rest]=cursor.split('.');if(!body||!sig||rest.length) throw new Error('CURSOR_MISMATCH');
    const wanted=createHmac('sha256',Buffer.from(this.key.key,'hex')).update(body).digest();
    const got=Buffer.from(sig,'base64url');if(got.length!==wanted.length||!timingSafeEqual(got,wanted))throw new Error('CURSOR_MISMATCH');
    const data=JSON.parse(Buffer.from(body,'base64url').toString());
    if(data.instance!==this.meta.instance_uuid || data.epoch!==this.meta.cursor_epoch || data.key_id!==this.key.key_id || data.query!==stable(query))throw new Error('CURSOR_MISMATCH');
    return data;
  }
  protected page(kind:string,target:number|null,opts:Page,fetch:(c:Row,n:number)=>Row[],initial:()=>Row,filters:Row={}) {
    const limit=opts.limit??100;integer(limit);if(limit>500)throw new Error('INVALID_LIMIT');
    const query={kind,target,scope_id:this.sid,limit,filters,context_token:opts.context_token??null};
    return this.db.transaction(()=>{
      const state=opts.cursor?this.decode(opts.cursor,query):{instance:this.meta.instance_uuid,epoch:this.meta.cursor_epoch,key_id:this.key.key_id,query:stable(query),last:0,...initial()};
      const all=fetch(state,limit+1),hasMore=all.length>limit,items=all.slice(0,limit);
      return {items,next_cursor:hasMore?this.sign({...state,last:items.at(-1)!.page_id}):null,has_more:hasMore,
        snapshot:{upper_id:state.upper,relation_revision:state.rev??null,...(state.coverage?{coverage:state.coverage}:{})},state_consistency:'current-per-page',body_included:false};
    })();
  }
  listTasks(opts:Page & {state?:unknown;owner?:unknown}={}) {
    if(Object.keys(opts).some(k=>!['limit','cursor'].includes(k)))throw new Error('MUTABLE_FILTER_UNSUPPORTED');
    return this.page('tasks',null,opts,(c,n)=>this.db.prepare('SELECT id AS page_id,id,title,state,claimed_by,updated_at,wait_kind FROM tasks WHERE scope_id=? AND id>? AND id<=? ORDER BY id LIMIT ?').all(this.sid,c.last,c.upper,n) as Row[],()=>({upper:(this.db.prepare('SELECT coalesce(max(id),0) AS n FROM tasks WHERE scope_id=?').get(this.sid) as Row).n}));
  }
  listConversations(opts:Page={}) {
    if(Object.keys(opts).some(k=>!['limit','cursor'].includes(k)))throw new Error('MUTABLE_FILTER_UNSUPPORTED');
    return this.page('conversations',null,opts,(c,n)=>this.db.prepare('SELECT conversation_id AS page_id,conversation_id,thread_id FROM conversations WHERE scope_id=? AND conversation_id>? AND conversation_id<=? ORDER BY conversation_id LIMIT ?').all(this.sid,c.last,c.upper,n) as Row[],()=>({upper:(this.db.prepare('SELECT coalesce(max(conversation_id),0) AS n FROM conversations WHERE scope_id=?').get(this.sid) as Row).n}));
  }
  listLinks(taskId:number,opts:Page={}) {
    if(Object.keys(opts).some(k=>!['limit','cursor','context_token'].includes(k)))throw new Error('MUTABLE_FILTER_UNSUPPORTED');
    this.target('tasks',taskId);
    const ctx=opts.context_token?this.decode(opts.context_token,{kind:'context',scope_id:this.sid}):null;
    if(ctx && ctx.task_id!==taskId)throw new Error('CURSOR_MISMATCH');
    return this.page('links',taskId,opts,(c,n)=>this.db.prepare(`SELECT v.link_version_id AS page_id,v.*,c.thread_id FROM task_conversation_versions v JOIN conversations c USING(conversation_id)
      WHERE v.task_id=? AND v.link_version_id>? AND v.link_version_id<=? AND v.born_rev<=? AND (v.ended_rev IS NULL OR v.ended_rev>?) ORDER BY v.link_version_id LIMIT ?`)
      .all(taskId,c.last,c.upper,c.rev,c.rev,n) as Row[],()=>({upper:ctx?.links_upper??(this.db.prepare('SELECT coalesce(max(link_version_id),0) AS n FROM task_conversation_versions').get() as Row).n,
        rev:ctx?.rev??(this.db.prepare('SELECT relation_revision FROM bus_meta').get() as Row).relation_revision}));
  }
  listMessages(conversationId:number,opts:Page={}) {
    if(Object.keys(opts).some(k=>!['limit','cursor','context_token'].includes(k)))throw new Error('MUTABLE_FILTER_UNSUPPORTED');
    this.target('conversations',conversationId);
    const ctx=opts.context_token?this.decode(opts.context_token,{kind:'context',scope_id:this.sid}):null;
    if(ctx && !this.db.prepare('SELECT 1 FROM task_conversation_versions WHERE task_id=? AND conversation_id=? AND born_rev<=? AND (ended_rev IS NULL OR ended_rev>?)').get(ctx.task_id,conversationId,ctx.rev,ctx.rev))throw new Error('CONVERSATION_NOT_IN_CONTEXT');
    const result=this.page('messages',conversationId,opts,(c,n)=>this.db.prepare(`SELECT id AS page_id,id,from_agent,to_agent,kind,message_purpose,status,created_at,reply_to,content
      FROM messages WHERE conversation_id=? AND id>? AND id<=? ORDER BY id LIMIT ?`).all(conversationId,c.last,c.upper,n) as Row[],()=>({upper:ctx?.messages_upper??(this.db.prepare('SELECT coalesce(max(id),0) AS n FROM messages').get() as Row).n}));
    result.items=result.items.map(({content,...m})=>({...m,body_bytes:Buffer.byteLength(content),body_sha256:hash(content),preview:[...content].slice(0,80).join(''),body_ref:{tool:'get_message_v2',message_id:m.id}}));
    return result;
  }
  getMessage(id:number,opts:{body_cursor?:string;max_bytes?:number}={}) {
    const row=this.target('messages',id),body=Buffer.from(row.content,'utf8');
    const max=opts.max_bytes??4096;integer(max);if(max<4||max>65536)throw new Error('INVALID_CHUNK_SIZE');
    const query={kind:'body',id,scope_id:this.sid,max_bytes:max,hash:hash(body)};
    const start=opts.body_cursor?this.decode(opts.body_cursor,query).offset:0;
    let end=Math.min(body.length,start+max);
    while(end<body.length && (body[end]!&0xc0)===0x80)end--;
    return {id,offset:start,end_offset:end,total_bytes:body.length,body_sha256:hash(body),text:body.subarray(start,end).toString('utf8'),
      next_cursor:end<body.length?this.sign({instance:this.meta.instance_uuid,epoch:this.meta.cursor_epoch,key_id:this.key.key_id,query:stable(query),offset:end}):null};
  }
  openTaskContext(taskId:number) {
    return this.db.transaction(()=>{
      const overview=this.taskContext(taskId);
      return {...overview,context_token:this.sign({instance:this.meta.instance_uuid,epoch:this.meta.cursor_epoch,key_id:this.key.key_id,
        query:stable({kind:'context',scope_id:this.sid}),task_id:taskId,rev:overview.relation_revision,
        links_upper:(this.db.prepare('SELECT coalesce(max(link_version_id),0) n FROM task_conversation_versions').get() as Row).n,
        messages_upper:(this.db.prepare('SELECT coalesce(max(id),0) n FROM messages').get() as Row).n})};
    })();
  }
  taskContext(taskId:number) {
    return this.db.transaction(()=>{
      const task=this.target('tasks',taskId);
      const refs=this.db.prepare("SELECT id,kind,content,thread_id FROM memories WHERE task_id=? AND project IS ? AND area IS ? AND team IS ? AND pinned=1 AND kind IN ('summary','decision','artifact') ORDER BY id DESC LIMIT 11").all(taskId,task.project,task.area,task.team) as Row[];
      return {task:{id:task.id,title:task.title,state:task.state,wait_kind:task.wait_kind},
        context:refs.slice(0,10).map(r=>({memory_id:r.id,kind:r.kind,summary:[...r.content].slice(0,200).join(''),source:'agent-authored memory; not approval evidence'})),
        truncated:refs.length>10,body_included:false,
        next:{tool:'list_task_conversations_v2',task_id:taskId},
        relation_revision:(this.db.prepare('SELECT relation_revision FROM bus_meta').get() as Row).relation_revision};
    })();
  }
  private checkHumanLink(versionId:number):void {
    if(this.db.prepare("SELECT 1 FROM task_conversation_versions v JOIN tasks t ON t.id=v.task_id JOIN messages q ON q.id=t.human_question_id WHERE v.link_version_id=? AND t.wait_kind='human' AND q.conversation_id=v.conversation_id").get(versionId))throw new Error('HUMAN_WAIT_LINK_REQUIRED');
  }
  replace(versionId:number,newTaskId:number,newConversationId:number,reason:string,expected:number,e:Envelope):Row {
    return this.mutate('replace_link',{versionId,newTaskId,newConversationId,reason,expected},e,()=>{
      if(typeof reason!=='string'||!reason.trim())throw new Error('INVALID_CORRECTION');
      this.checkHumanLink(versionId);
      const old=this.db.prepare('SELECT * FROM task_conversation_versions WHERE link_version_id=?').get(integer(versionId)) as Row|undefined;
      if(!old||old.ended_rev!==null)throw new Error('NOT_CURRENT_VERSION');
      this.target('tasks',old.task_id);this.target('tasks',newTaskId);this.target('conversations',newConversationId);
      if(this.db.prepare('SELECT 1 FROM task_conversation_versions WHERE task_id=? AND conversation_id=? AND ended_rev IS NULL').get(newTaskId,newConversationId))throw new Error('LINK_EXISTS');
      const rev=this.revision(expected);
      this.db.prepare('UPDATE task_conversation_versions SET ended_rev=? WHERE link_version_id=?').run(rev,versionId);
      const row=this.db.prepare('INSERT INTO task_conversation_versions(task_id,conversation_id,born_rev,reason,actor) VALUES(?,?,?,?,?)').run(newTaskId,newConversationId,rev,reason,e.actor);
      return {previous_version_id:versionId,link_version_id:Number(row.lastInsertRowid),revision:rev};
    });
  }
  private mutate(operation:string,args:Row,e:Envelope,fn:()=>Row):Row {
    return mutation(this.db,this.sid,operation,args,e,at=>{
      const result=fn();
      event(this.db,this.sid,operation,e,at,null,{task_ids:[...new Set([args.taskId,args.newTaskId,
        args.versionId?(this.db.prepare('SELECT task_id FROM task_conversation_versions WHERE link_version_id=?').get(args.versionId) as Row)?.task_id:undefined].filter(x=>x!==undefined))]});
      return {result};
    });
  }

  private revision(expected:number):number {
    if(!Number.isSafeInteger(expected)||expected<0)throw new Error('INVALID_REVISION');
    const r=this.db.prepare('UPDATE bus_meta SET relation_revision=relation_revision+1 WHERE relation_revision=?').run(expected);
    if(r.changes!==1)throw new Error('REVISION_CONFLICT');return expected+1;
  }
  link(taskId:number,conversationId:number,expected:number,e:Envelope):Row {
    return this.mutate('link_conversation',{taskId,conversationId,expected},e,()=>{
      this.target('tasks',taskId);this.target('conversations',conversationId);
      if(this.db.prepare('SELECT 1 FROM task_conversation_versions WHERE task_id=? AND conversation_id=? AND ended_rev IS NULL').get(taskId,conversationId))throw new Error('LINK_EXISTS');
      const rev=this.revision(expected);
      const r=this.db.prepare('INSERT INTO task_conversation_versions(task_id,conversation_id,born_rev,reason,actor) VALUES(?,?,?,?,?)').run(taskId,conversationId,rev,'linked',e.actor);
      return {link_version_id:Number(r.lastInsertRowid),revision:rev};
    });
  }
  correct(versionId:number,action:'revise'|'remove',reason:string,expected:number,e:Envelope):Row {
    return this.mutate('correct_link',{versionId,action,reason,expected},e,()=>{
      if(!['revise','remove'].includes(action)||typeof reason!=='string'||!reason.trim())throw new Error('INVALID_CORRECTION');
      if(action==='remove')this.checkHumanLink(versionId);
      const old=this.db.prepare('SELECT * FROM task_conversation_versions WHERE link_version_id=?').get(integer(versionId)) as Row|undefined;
      if(!old)throw new Error('LINK_NOT_FOUND');this.target('tasks',old.task_id);
      if(old.ended_rev!==null)throw new Error('NOT_CURRENT_VERSION');
      const rev=this.revision(expected);
      if(this.db.prepare('UPDATE task_conversation_versions SET ended_rev=? WHERE link_version_id=? AND ended_rev IS NULL').run(rev,versionId).changes!==1)throw new Error('REVISION_CONFLICT');
      const next=action==='revise'?Number(this.db.prepare('INSERT INTO task_conversation_versions(task_id,conversation_id,born_rev,previous_version_id,reason,actor) VALUES(?,?,?,?,?,?)').run(old.task_id,old.conversation_id,rev,versionId,reason,e.actor).lastInsertRowid):null;
      return {previous_version_id:versionId,link_version_id:next,revision:rev};
    });
  }
}
