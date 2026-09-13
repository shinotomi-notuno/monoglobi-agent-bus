import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { installSchema, installGuards, scopeId, scopeKey, type Row, type Scope } from './schema.js';

const confirmationSchema = z.object({
  kind: z.literal('new_synthetic_fixture'), generator: z.string().regex(/^[a-zA-Z0-9_.:/-]{1,160}$/),
  source_path: z.string().min(1), source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  old_secrets_absent: z.literal(true),
}).strict();
export type MigrationConfirmation = z.infer<typeof confirmationSchema>;
export type MigrationOptions = { inputConfirmation?: MigrationConfirmation; faultAt?: string; now?: number; clock?: () => number; deadlineAt?: number };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, Object.keys(value as object).sort())).digest('hex');

/** Read-only audit for a completed rehearsal. It never repairs either database. */
export function auditMigration(sourcePath: string, targetPath: string): Row {
  const source = new Database(resolve(sourcePath), {readonly:true, fileMustExist:true});
  const target = new Database(resolve(targetPath), {readonly:true, fileMustExist:true});
  const issues: Row[] = [];
  try {
    const mapRows = target.prepare('SELECT * FROM migration_map ORDER BY source_table,source_id,target_table,target_id').all() as Row[];
    const checkSource = (table:string) => {
      const rows = source.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Row[];
      for (const row of rows) {
        const matches = mapRows.filter(m=>m.source_table===table && m.source_id===row.id);
        if (!matches.length) issues.push({code:'MAP_MISSING',source_table:table,source_id:row.id});
        for (const m of matches) {
          if (m.source_path_sha256!==createHash('sha256').update(resolve(sourcePath)).digest('hex')) issues.push({code:'SOURCE_PATH_HASH_MISMATCH',source_table:table,source_id:row.id});
          if (m.source_content_sha256!==digest(row)) issues.push({code:'SOURCE_HASH_MISMATCH',source_table:table,source_id:row.id});
        }
      }
    };
    checkSource('tasks'); checkSource('messages');
    const runs=target.prepare('SELECT * FROM migration_runs').all() as Row[];
    const meta=target.prepare('SELECT * FROM bus_meta').get() as Row;
    const scopes=JSON.stringify((target.prepare('SELECT scope_key FROM scopes ORDER BY scope_id').all() as Row[]).map(x=>x.scope_key));
    if(runs.length!==1 || runs.some(r=>r.status!=='ready'||r.issue_count!==0||r.source_path!==resolve(sourcePath)||
      r.source_hash!==createHash('sha256').update(readFileSync(sourcePath)).digest('hex')||r.origin_instance_uuid!==meta.instance_uuid||r.target_schema!==meta.schema_version||r.scope_json!==scopes))
      issues.push({code:'MIGRATION_RUN_MISMATCH'});
    // Invert from source NULL rows: an ordinary Message map cannot substitute for provenance.
    for(const msg of source.prepare('SELECT * FROM messages WHERE thread_id IS NULL').all() as Row[]) {
      const matches=mapRows.filter(m=>m.source_table==='messages'&&m.source_id===msg.id&&m.target_table==='conversations');
      const sk=scopeKey(msg as Scope);
      const tm=target.prepare('SELECT * FROM messages WHERE id=?').get(msg.id) as Row|undefined;
      const m=matches[0];
      const conv=m?target.prepare('SELECT * FROM conversations WHERE conversation_id=?').get(m.target_id) as Row|undefined:undefined;
      const targetScope=conv?target.prepare('SELECT scope_key FROM scopes WHERE scope_id=?').get(conv.scope_id) as Row|undefined:undefined;
      let ref:Row={};try{ref=JSON.parse(m?.audit_ref??'{}');}catch{/* fail below */}
      if(matches.length!==1||!m||m.classification!=='synthetic_conversation'||m.basis!=='source_thread_null'||
        m.source_path_sha256!==createHash('sha256').update(resolve(sourcePath)).digest('hex')||m.source_content_sha256!==digest(msg)||
        m.source_scope_key!==sk||m.target_scope_key!==sk||targetScope?.scope_key!==sk||!tm||tm.thread_id!==null||
        tm.conversation_id!==conv?.conversation_id||tm.scope_id!==conv?.scope_id||
        conv?.thread_id!==`urn:agentbus:migrated:${msg.id}:${createHash('sha256').update(resolve(sourcePath)).digest('hex')}`||
        ref?.table!=='messages'||ref?.id!==msg.id||ref?.scope!==sk)
        issues.push({code:'H01_AUDIT_UNREACHABLE',source_id:msg.id});
    }
    const duplicate = target.prepare(`SELECT source_table,source_id,target_table,target_id,count(*) n FROM migration_map
      GROUP BY source_table,source_id,target_table,target_id HAVING n>1`).all() as Row[];
    for (const row of duplicate) issues.push({code:'MAP_DUPLICATE',...row});
    const issueCount = (target.prepare('SELECT count(*) n FROM migration_issues').get() as Row).n;
    if (issueCount) issues.push({code:'MIGRATION_ISSUE_PRESENT',count:issueCount});
    for (const m of mapRows) {
      if (m.source_scope_key!==m.target_scope_key && m.target_scope_key!=='') issues.push({code:'SCOPE_MISMATCH',source_id:m.source_id});
      const sourceTables=['tasks','messages','memories'];
      const keys:Record<string,string>={tasks:'id',messages:'id',conversations:'conversation_id',task_conversation_versions:'link_version_id'};
      const original=sourceTables.includes(m.source_table)?source.prepare(`SELECT * FROM ${m.source_table} WHERE id=?`).get(m.source_id) as Row|undefined:undefined;
      const dest=keys[m.target_table]?target.prepare(`SELECT * FROM ${m.target_table} WHERE ${keys[m.target_table]}=?`).get(m.target_id) as Row|undefined:undefined;
      if(!original||!dest||m.source_path_sha256!==createHash('sha256').update(resolve(sourcePath)).digest('hex')||m.source_content_sha256!==digest(original)||m.source_scope_key!==scopeKey(original as Scope))
        issues.push({code:'MAP_ORIGIN_MISMATCH',source_id:m.source_id});
      if (m.classification==='synthetic_conversation') {
        const msg=source.prepare('SELECT * FROM messages WHERE id=?').get(m.source_id) as Row|undefined;
        const conv=target.prepare('SELECT * FROM conversations WHERE conversation_id=?').get(m.target_id) as Row|undefined;
        if (!msg || msg.thread_id!==null || !conv) issues.push({code:'H01_AUDIT_UNREACHABLE',source_id:m.source_id,target_id:m.target_id});
      }
    }
    return {ok:issues.length===0,issues,map_count:mapRows.length};
  } finally { source.close(); target.close(); }
}

export async function migrateStoppedCopy(source: string, target: string, writersStopped: boolean, options: MigrationOptions = {}): Promise<Row> {
  source=resolve(source);target=resolve(target);
  const runId=randomUUID();
  const clock=options.clock??(()=>Date.now());
  const startedAt=options.now??clock();
  const deadlineAt=options.deadlineAt??(startedAt+15*60*1000);
  let stage='preflight';
  let sourceHash='';
  let src:any;
  const deadline=()=>{ if(clock()>deadlineAt){ const e=new Error('MIGRATION_DEADLINE_EXCEEDED'); (e as any).code='MIGRATION_DEADLINE_EXCEEDED'; (e as any).faultStage=stage; throw e; } };
  const failManifest=(quarantine:string,error:unknown)=>({run_id:runId,source_hash:sourceHash,fault_stage:(error as any)?.faultStage??stage,quarantine_path:quarantine,failed_at:clock(),code:typeof (error as any)?.code==='string' ? (error as any).code : 'MIGRATION_FAILED',secret_included:false});
  if (!writersStopped || source===target || existsSync(target) || existsSync(target+'.cursor-key.json')) throw new Error('STOPPED_NEW_COPY_REQUIRED');
  const parsed=confirmationSchema.safeParse(options.inputConfirmation);
  if(!parsed.success||parsed.data.source_path!==source)throw new Error('MIGRATION_INPUT_UNCONFIRMED');
  sourceHash=createHash('sha256').update(readFileSync(source)).digest('hex');
  if(parsed.data.source_sha256!==sourceHash)throw new Error('MIGRATION_INPUT_HASH_MISMATCH');
  src=new Database(source,{readonly:true,fileMustExist:true});
  // Known secret-bearing fields are prohibited, not sanitized. This is not free-text detection.
  try {
    for(const {name} of src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Row[]) {
      const quoted='"'+name.replaceAll('"','""')+'"';
      for(const col of src.prepare(`PRAGMA table_info(${quoted})`).all() as Row[]) {
        if(/token|secret|credential|private_key|api_key|encryption_key/i.test(col.name)) {
          const c='"'+col.name.replaceAll('"','""')+'"';
          if(src.prepare(`SELECT 1 FROM ${quoted} WHERE ${c} IS NOT NULL AND CAST(${c} AS TEXT)<>'' LIMIT 1`).get())throw new Error('MIGRATION_INPUT_FORBIDDEN');
        }
      }
    }
    if(createHash('sha256').update(readFileSync(source)).digest('hex')!==parsed.data.source_sha256)
      throw new Error('MIGRATION_INPUT_HASH_MISMATCH');
  }catch(error){src.close();throw error;}
  try {
    deadline(); stage='source-validation';
    if (src.prepare("SELECT 1 FROM sqlite_master WHERE name='bus_meta'").get()) throw new Error('LEGACY_SOURCE_REQUIRED');
    // Require the known baseline schema, never use this to upgrade arbitrary old DBs.
    for (const [t,c] of [['tasks','milestone'],['messages','claim_deadline'],['memories','supersedes_id']]) {
      if (!(src.prepare(`PRAGMA table_info(${t})`).all() as Row[]).some(x=>x.name===c)) throw new Error('UNSUPPORTED_SOURCE_SCHEMA');
    }
    await src.backup(target);
    chmodSync(target,0o600);
  } catch (error) {
    try { src.close(); } catch { /* preserve original error */ }
    const quarantine=target+'.failed-'+runId;
    try { if(existsSync(target)) renameSync(target,quarantine); } catch { /* preserve original error */ }
    try { writeFileSync(quarantine+'.failure.json',JSON.stringify(failManifest(quarantine,error),null,2)+'\n',{flag:'w',mode:0o600}); } catch { /* preserve original error */ }
    throw error;
  }
  const db=new Database(target);
  try {
    deadline(); stage='schema-install';
    const report=db.transaction(()=>{
      installSchema(db);
      db.prepare(`INSERT INTO migration_runs(run_id,source_path,source_hash,source_schema,target_path,target_schema,origin_instance_uuid,scope_json,started_at,status)
        VALUES(?,?,?,?,?,?,?,?,?,'running')`).run(runId,source,sourceHash,'legacy-copy',target,'2.4-dev.2',null,null,startedAt);
      if(options.faultAt==='after_run') throw new Error('MIGRATION_FAULT_AFTER_RUN');
      const issue=(table:string,id:number|null,code:string,detail:string)=>Number(db.prepare(
        'INSERT INTO migration_issues(source_table,source_id,code,detail) VALUES(?,?,?,?)').run(table,id,code,detail).lastInsertRowid);
      const sourceRow=(table:string,id:number)=>src.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Row|undefined;
      const map=(table:string,id:number,to:string,tid:number,classification:string,basis='legacy_preserved',scope:Scope|null=null,audit:Row={})=>{
        const row=sourceRow(table,id);
        const sk=scope?scopeKey(scope):'';
        return db.prepare(`INSERT INTO migration_map(source_table,source_id,target_table,target_id,classification,basis,source_path_sha256,source_content_sha256,source_scope_key,target_scope_key,audit_ref)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(table,id,to,tid,classification,basis,createHash('sha256').update(source).digest('hex'),row?digest(row):'',sk,sk,JSON.stringify(audit));
      };
      const agents=db.prepare('SELECT * FROM agents WHERE session_id IS NOT NULL').all() as Row[];
      const counts=new Map<string,number>();for(const a of agents)counts.set(a.session_id,(counts.get(a.session_id)??0)+1);
      for(const a of agents){
        const sid=scopeId(db,a as Scope);
        if(counts.get(a.session_id)!==1||typeof a.session_id!=='string'||!a.session_id.trim()){
          issue('agents',null,'SESSION_ID_CONFLICT',JSON.stringify({name:a.name,session_id:a.session_id,scope_id:sid}));continue;
        }
        db.prepare('INSERT INTO agent_registrations VALUES(?,?,1,1,1,?,?,?, ?,NULL,?)').run(sid,a.name,a.role??'legacy-unspecified',a.provider??'legacy-unspecified','legacy-registered',a.registered_at,a.last_seen);
        db.prepare('INSERT INTO registered_sessions(actor,session_id,scope_id,generation,registered_at) VALUES(?,?,?,1,?)').run(a.name,a.session_id,sid,a.registered_at);
      }
      const tasks=db.prepare('SELECT * FROM tasks ORDER BY id').all() as Row[];
      const messages=db.prepare('SELECT * FROM messages ORDER BY id').all() as Row[];
      const conv=(s:Scope,thread:string)=>{
        const sid=scopeId(db,s);
        db.prepare('INSERT OR IGNORE INTO conversations(scope_id,thread_id) VALUES(?,?)').run(sid,thread);
        return db.prepare('SELECT * FROM conversations WHERE scope_id=? AND thread_id=?').get(sid,thread) as Row;
      };
      const mixed=new Map<string,Set<string>>();
      for (const m of messages) if(m.thread_id!==null) {
        const set=mixed.get(m.thread_id)??new Set<string>();set.add(scopeKey(m as Scope));mixed.set(m.thread_id,set);
      }
      for(const [thread,scopes] of mixed) if(scopes.size>1) issue('messages',null,'MIXED_THREAD_SCOPE',thread);
      for(const t of tasks) {
        stage='task-transform'; deadline();
        const sid=scopeId(db,t as Scope);
        db.prepare('UPDATE tasks SET scope_id=? WHERE id=?').run(sid,t.id);
        map('tasks',t.id,'tasks',t.id,'preserved','legacy_row',t as Scope,{table:'tasks',id:t.id});
        if(options.faultAt==='after_task_map') throw new Error('MIGRATION_FAULT_AFTER_TASK_MAP');
        if(t.state==='blocked') {
          const iid=issue('tasks',t.id,'WAIT_UNCLASSIFIED','Human/technical classification needs evidence; not inferred');
          db.prepare("UPDATE tasks SET wait_kind='unknown',migration_issue_id=? WHERE id=?").run(iid,t.id);
        } else if(t.blocked_reason!==null || t.blocked_on_task_id!==null) issue('tasks',t.id,'WAIT_STATE_MISMATCH','Nonblocked task has wait fields');
      }
      for(const m of messages) {
        stage='message-transform'; deadline();
        const thread=m.thread_id??`urn:agentbus:migrated:${m.id}:${createHash('sha256').update(source).digest('hex')}`;
        if(m.thread_id===null && messages.some(x=>x.thread_id===thread)) throw new Error('SYNTHETIC_THREAD_COLLISION');
        const c=conv(m as Scope,thread);
        if(m.thread_id===null && options.faultAt!=='omit_synthetic_map') map('messages',m.id,'conversations',c.conversation_id,'synthetic_conversation','source_thread_null',m as Scope,{table:'messages',id:m.id,scope:scopeKey(m as Scope)});
        db.prepare('UPDATE messages SET scope_id=?,conversation_id=?,message_purpose=? WHERE id=?').run(c.scope_id,c.conversation_id,m.kind,m.id);
        db.prepare('INSERT INTO delivery_state(message_id,mode) VALUES(?,?)').run(m.id,m.status==='pending'?'guarded':'legacy_terminal');
        if(options.faultAt!=='omit_message_map' || m.id!==1) map('messages',m.id,'messages',m.id,'preserved','legacy_row',m as Scope,{table:'messages',id:m.id,conversation_id:c.conversation_id});
        if(options.faultAt==='after_message_map') throw new Error('MIGRATION_FAULT_AFTER_MESSAGE_MAP');
        if(m.reply_to!==null) {
          const original=messages.find(x=>x.id===m.reply_to);
          if(!original || scopeKey(original as Scope)!==scopeKey(m as Scope)) issue('messages',m.id,'INVALID_REPLY','Missing or cross-scope original');
        }
      }
      for(const q of messages.filter(m=>m.kind==='ask')) {
        const answers=messages.filter(m=>m.reply_to===q.id && m.kind==='reply');
        if(answers.length>1 || (q.status==='answered')!==(answers.length===1) || (q.replied_at!==null)!==(q.status==='answered'))
          issue('messages',q.id,'ANSWER_STATE_MISMATCH','Legacy answer closure requires resolution');
        else if(answers.length===1)db.prepare('INSERT INTO ask_answers VALUES(?,?)').run(q.id,answers[0]!.id);
      }
      const refs=db.prepare("SELECT * FROM memories WHERE kind='conversation_link' ORDER BY id").all() as Row[];
      // Task's original primary thread is also a source relationship.
      const link=(table:string,id:number,tid:number|null,thread:string|null,s:Scope)=>{
        const task=db.prepare('SELECT * FROM tasks WHERE id=?').get(tid??-1) as Row|undefined;
        if(!task) {issue(table,id,'TASK_NOT_FOUND','Unassigned reference');return;}
        if(thread===null || (mixed.get(thread)?.size??0)>1) {issue(table,id,'THREAD_UNRESOLVED',String(thread));return;}
        const c=db.prepare('SELECT * FROM conversations WHERE scope_id=? AND thread_id=?').get(task.scope_id,thread) as Row|undefined;
        if(scopeKey(task as Scope)!==scopeKey(s)) {issue(table,id,'SCOPE_MISMATCH','Task/reference scope differs');return;}
        if(!c) {issue(table,id,'CONVERSATION_NOT_FOUND',thread);return;}
        let row=db.prepare('SELECT * FROM task_conversation_versions WHERE task_id=? AND conversation_id=? AND ended_rev IS NULL').get(tid,c.conversation_id) as Row|undefined;
        const duplicate=!!row;
        if(!row) {
          db.prepare('UPDATE bus_meta SET relation_revision=relation_revision+1').run();
          const rev=(db.prepare('SELECT relation_revision FROM bus_meta').get() as Row).relation_revision;
          const result=db.prepare('INSERT INTO task_conversation_versions(task_id,conversation_id,born_rev,reason,actor) VALUES(?,?,?,?,?)').run(tid,c.conversation_id,rev,'legacy import','migration');
          row={link_version_id:Number(result.lastInsertRowid)};
        }
        map(table,id,'task_conversation_versions',row.link_version_id,duplicate?'deduplicated':'valid','conversation_link',s,{table,id});
      };
      for(const t of tasks) if(t.thread_id!==null) link('tasks',t.id,t.id,t.thread_id,t as Scope);
      for(const m of refs) {
        if(m.supersedes_id!==null) {issue('memories',m.id,'LEGACY_CORRECTION_UNRESOLVED','General memory supersession is not a validated relation chain');continue;}
        link('memories',m.id,m.task_id,m.thread_id,m as Scope);
      }
      // Unknown relation-like memory kinds are not silently treated as valid links.
      for(const m of db.prepare("SELECT * FROM memories WHERE kind<>'conversation_link' AND thread_id IS NOT NULL").all() as Row[])
        issue('memories',m.id,'UNCLASSIFIED_REFERENCE_KIND',m.kind);
      // Current migration links are evidence candidates, never reconstructed send-time ownership.
      for(const m of messages) {
        const links=db.prepare('SELECT task_id,link_version_id FROM task_conversation_versions WHERE conversation_id=(SELECT conversation_id FROM messages WHERE id=?) AND ended_rev IS NULL ORDER BY task_id').all(m.id);
        db.prepare("INSERT INTO message_bindings VALUES(?,'[]','unknown','migration_snapshot','historical_unobserved',?)")
          .run(m.id,JSON.stringify({source_table:'messages',source_id:m.id,migration_links:links}));
      }
      for(const violation of db.pragma('foreign_key_check') as Row[]) issue(violation.table,violation.rowid,'FOREIGN_KEY',JSON.stringify(violation));
      installGuards(db);
      const issues=db.prepare('SELECT * FROM migration_issues ORDER BY issue_id').all();
      const origin=(db.prepare('SELECT instance_uuid FROM bus_meta').get() as Row).instance_uuid;
      const scopes=(db.prepare('SELECT scope_key FROM scopes ORDER BY scope_id').all() as Row[]).map(x=>x.scope_key);
      db.prepare('UPDATE migration_runs SET origin_instance_uuid=?,scope_json=?,issue_count=?,status=?,finished_at=? WHERE run_id=?')
        .run(origin,JSON.stringify(scopes),issues.length,issues.length===0?'ready':'blocked',clock(),runId);
      db.prepare('UPDATE bus_meta SET ready=?').run(issues.length===0?1:0);
      return {ready:issues.length===0,issues,counts:{tasks:tasks.length,messages:messages.length,reference_memories:refs.length},source,target,input_confirmation:parsed.data};
    }).immediate();
    db.close();
    stage='final-audit'; deadline();
    const audited=auditMigration(source,target);
    if(!audited.ok) { const e=new Error('MIGRATION_FINAL_AUDIT_FAILED'); (e as any).code='MIGRATION_FINAL_AUDIT_FAILED'; (e as any).faultStage=stage; (e as any).audit=audited; throw e; }
    const meta=new Database(target); const metaRow=meta.prepare('SELECT * FROM bus_meta').get() as Row; meta.close();
    writeFileSync(target+'.cursor-key.json',JSON.stringify({instance:metaRow.instance_uuid,key_id:'1',key:randomBytes(32).toString('hex')}),{flag:'wx',mode:0o600});
    const targetHash=createHash('sha256').update(readFileSync(target)).digest('hex');
    const manifest={...report,run_id:runId,source_hash:sourceHash,target_hash:targetHash,schema:metaRow.schema_version,h01_audit:audited};
    const mdb=new Database(target); mdb.transaction(()=>mdb.prepare('INSERT INTO migration_manifests(run_id,source_hash,target_hash,manifest_json,created_at) VALUES(?,?,?,?,?)').run(runId,sourceHash,targetHash,JSON.stringify(manifest),clock()))(); mdb.close();
    writeFileSync(target+'.migration.json',JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    src?.close();
    return manifest;
  } catch (error) {
    try { src?.close(); } catch { /* preserve original error */ }
    try { db.close(); } catch { /* preserve original error */ }
    const quarantine=target+'.failed-'+runId;
    try { if(existsSync(target)) renameSync(target,quarantine); } catch { /* preserve original error */ }
    try { writeFileSync(quarantine+'.failure.json',JSON.stringify(failManifest(quarantine,error),null,2)+'\n',{flag:'w',mode:0o600}); } catch { /* preserve original error */ }
    throw error;
  } finally { try { db.close(); } catch { /* already closed */ } }
}
