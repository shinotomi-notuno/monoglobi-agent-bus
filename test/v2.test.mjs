import {historicalResult} from './helpers/receipt-result.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {initializeLegacySchema} from '../dist/db.js';
import {migrateStoppedCopy} from './helpers/synthetic-migration.mjs';
import {Store} from '../dist/v2/store.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const scope={project:'p',area:null,team:null};
const root=mkdtempSync(join(tmpdir(),'ab-v2-'));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
let seq=0;
function fixture(count=1,mutate=()=>{}) {
 const source=join(root,`${seq++}-old.db`),target=source.replace('-old','-new');
 const db=new Database(source);initializeLegacySchema(db);
 db.prepare('INSERT INTO agents(name,registered_at,last_seen,project,session_id) VALUES(?,?,?,?,?)').run('a',1,1,'p','s-a');
 db.prepare("INSERT INTO tasks(title,thread_id,requested_by,state,created_at,updated_at,project) VALUES('task','thread','a','open',1,1,'p')").run();
 const msg=db.prepare("INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project) VALUES('a','a','msg',?,'pending',?,'thread','p')");
 db.transaction(()=>{for(let i=0;i<count;i++)msg.run(`本文😀é-${i}`,i%2?1:0);})();db.pragma('foreign_keys=OFF');mutate(db);db.close();return {source,target};
}
async function ready(count=1,mutate) {
 const f=fixture(count,mutate),before=sha(f.source);const report=await migrateStoppedCopy(f.source,f.target,true);
 assert.equal(sha(f.source),before);assert.equal(report.ready,true,JSON.stringify(report));
 return {...f,store:new Store(f.target,scope)};
}
function env(s,id=randomUUID()){return {origin_instance_uuid:s.capabilities().instance_uuid,actor:'a',session_id:'s-a',request_id:id};}
function rev(s){return s.db.prepare('SELECT relation_revision FROM bus_meta').get().relation_revision;}
function addConversation(s,thread){return Number(s.db.prepare('INSERT INTO conversations(scope_id,thread_id) VALUES(?,?)').run(s.sid,thread).lastInsertRowid);}
function allPages(fn,limit=100){let cur;const result=[];do{const p=fn({limit,...(cur?{cursor:cur}:{})});result.push(...p.items);cur=p.next_cursor;}while(cur);return result;}

test('migration preserves IDs, immutable content and source; NULL/empty scope separate',async()=>{
 const {store:s}=await ready(3,db=>{
  db.prepare("INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project,area) VALUES('a','a','msg','empty','delivered',1,'empty','p','')").run();
 });
 assert.equal(s.db.prepare('SELECT count(*) n FROM scopes').get().n,2);
 assert.equal(s.listMessages(1).items.length,3);
 assert.throws(()=>s.db.prepare("UPDATE messages SET team='changed' WHERE id=4").run(),/IMMUTABLE_SCOPE/);
 assert.throws(()=>s.db.prepare("UPDATE messages SET content='changed' WHERE id=1").run(),/IMMUTABLE_MESSAGE/);
 assert.throws(()=>s.db.prepare('DELETE FROM tasks WHERE id=1').run(),/IMMUTABLE/);
 s.close();
});
test('bad/mixed/unassigned references yield ready=false, no silently valid links',async()=>{
 const f=fixture(1,db=>{
  db.prepare("INSERT INTO memories(by_agent,kind,content,task_id,thread_id,project,created_at,updated_at) VALUES('a','conversation_link','bad',999,'missing','p',1,1)").run();
  db.prepare("INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project,area) VALUES('a','a','msg','noise','pending',1,'thread','p','other')").run();
 });
 const before=sha(f.source);await assert.rejects(()=>migrateStoppedCopy(f.source,f.target,true),/MIGRATION_FINAL_AUDIT_FAILED/);assert.equal(sha(f.source),before);assert.equal(existsSync(f.target),false);const failure=readdirSync(root).find(x=>x.startsWith(f.target.split('/').pop()+'.failed-')&&x.endsWith('.failure.json'));assert.ok(failure);const manifest=JSON.parse(readFileSync(join(root,failure),'utf8'));assert.equal(manifest.quarantine_path,`${f.target}.failed-${manifest.run_id}`);assert.equal(existsSync(manifest.quarantine_path),true);assert.equal(existsSync(f.target+'.migration.json'),false);const failed=new Database(manifest.quarantine_path,{readonly:true});assert.ok(failed.prepare("SELECT count(*) n FROM migration_issues WHERE code='MIXED_THREAD_SCOPE'").get().n>0);assert.ok(failed.prepare("SELECT count(*) n FROM migration_issues WHERE code='TASK_NOT_FOUND'").get().n>0);assert.equal(failed.prepare('SELECT count(*) n FROM migration_manifests').get().n,0);assert.equal(failed.prepare('SELECT count(*) n FROM operation_receipts').get().n,0);failed.close();
});
test('duplicates map to one relation and retain source memory records',async()=>{
 const {store:s}=await ready(1,db=>{
  const stmt=db.prepare("INSERT INTO memories(by_agent,kind,content,task_id,thread_id,project,created_at,updated_at) VALUES('a','conversation_link','ref',1,'thread','p',1,1)");stmt.run();stmt.run();
 });
 assert.equal(s.listLinks(1).items.length,1);assert.equal(s.db.prepare("SELECT count(*) n FROM migration_map WHERE classification='deduplicated'").get().n,2);s.close();
});
test('blocked unclassified wait is unknown and remains read-only',async()=>{
 const f=fixture(1,db=>db.prepare("UPDATE tasks SET state='blocked',blocked_reason='uncertain'").run());
 const before=sha(f.source);await assert.rejects(()=>migrateStoppedCopy(f.source,f.target,true),/MIGRATION_FINAL_AUDIT_FAILED/);assert.equal(sha(f.source),before);assert.equal(existsSync(f.target),false);const failure=readdirSync(root).find(x=>x.startsWith(f.target.split('/').pop()+'.failed-')&&x.endsWith('.failure.json'));assert.ok(failure);const manifest=JSON.parse(readFileSync(join(root,failure),'utf8'));assert.equal(manifest.quarantine_path,`${f.target}.failed-${manifest.run_id}`);assert.equal(existsSync(manifest.quarantine_path),true);assert.equal(existsSync(f.target+'.migration.json'),false);const failed=new Database(manifest.quarantine_path,{readonly:true});assert.ok(failed.prepare("SELECT count(*) n FROM migration_issues WHERE code='WAIT_UNCLASSIFIED'").get().n>0);assert.equal(failed.prepare("SELECT wait_kind FROM tasks WHERE id=1").get().wait_kind,'unknown');assert.equal(failed.prepare('SELECT count(*) n FROM migration_manifests').get().n,0);assert.equal(failed.prepare('SELECT count(*) n FROM operation_receipts').get().n,0);failed.close();
});
test('relations enforce scope, existence, current uniqueness, request id operation digest',async()=>{
 const {store:s}=await ready();const c=addConversation(s,'new');
 assert.throws(()=>s.link(999,c,rev(s),env(s)),/TARGET_NOT_FOUND/);
 const e=env(s),expected=rev(s);const result=s.link(1,c,expected,e);assert.deepEqual(historicalResult(s.link(1,c,expected,e)),historicalResult(result));
 assert.throws(()=>s.correct(result.link_version_id,'revise','note',rev(s),e),/REQUEST_ID_REUSE/);
 assert.throws(()=>s.link(1,c,rev(s),env(s)),/LINK_EXISTS/);
 assert.throws(()=>s.db.prepare('UPDATE conversations SET scope_id=999 WHERE conversation_id=?').run(c),/IMMUTABLE/);s.close();
});
test('1001 links paginate at fixed revision while corrections and additions proceed',async()=>{
 const {store:s}=await ready();for(let i=0;i<1000;i++)s.link(1,addConversation(s,`c${i}`),rev(s),env(s));
 let p=s.listLinks(1,{limit:500}),out=[...p.items];
 const old=s.db.prepare('SELECT max(link_version_id) n FROM task_conversation_versions').get().n;
 s.correct(old,'remove','removed during scan',rev(s),env(s));s.link(1,addConversation(s,'later'),rev(s),env(s));
 while(p.next_cursor){p=s.listLinks(1,{limit:500,cursor:p.next_cursor});out.push(...p.items);}
 assert.equal(out.length,1001);assert.equal(new Set(out.map(x=>x.page_id)).size,1001);assert.ok(out.some(x=>x.link_version_id===old));s.close();
});
test('long correction chain has no depth cap; old-version edits and cycles rejected',async()=>{
 const {store:s}=await ready();let id=s.listLinks(1).items[0].link_version_id;
 for(let i=0;i<1001;i++)id=s.correct(id,'revise',`note${i}`,rev(s),env(s)).link_version_id;
 assert.equal(s.listLinks(1).items[0].link_version_id,id);
 assert.throws(()=>s.db.prepare('UPDATE task_conversation_versions SET previous_version_id=? WHERE link_version_id=1').run(id),/IMMUTABLE/);
 assert.throws(()=>s.correct(1,'revise','stale',rev(s),env(s)),/NOT_CURRENT/);s.close();
});
test('atomic replacement rolls back on duplicate and pairs old/new in one receipt',async()=>{
 const {store:s}=await ready();const old=s.listLinks(1).items[0].link_version_id,c=addConversation(s,'replace');
 const r=s.replace(old,1,c,'correction',rev(s),env(s));assert.equal(s.listLinks(1).items[0].link_version_id,r.link_version_id);
 assert.throws(()=>s.replace(r.link_version_id,1,c,'duplicate',rev(s),env(s)),/LINK_EXISTS/);assert.equal(s.listLinks(1).items.length,1);s.close();
});
test('501/1001 history, later append exclusion, metadata only, UTF8 chunks reconstruct hash',async()=>{
 for(const n of [0,1,500,501,1001]) {
  // zero history is an explicitly registered empty conversation.
  const {store:s}=await ready(Math.max(n,1));const cid=n?1:addConversation(s,'empty');
  assert.equal(allPages(p=>s.listMessages(cid,p)).length,n);
  if(n){const first=s.listMessages(cid,{limit:1});assert.equal(first.body_included,false);assert.equal(first.items[0].content,undefined);
    let part=s.getMessage(1,{max_bytes:4}),text=part.text;while(part.next_cursor){part=s.getMessage(1,{max_bytes:4,body_cursor:part.next_cursor});text+=part.text;}
    assert.equal(text,'本文😀é-0');assert.equal(createHash('sha256').update(text).digest('hex'),part.body_sha256);
  }s.close();
 }
});
test('cursor restart, tamper, query/limit/scope/instance mismatch and mutable filters',async()=>{
 const {store:s,target}=await ready(501);const first=s.listMessages(1,{limit:500});s.close();
 const next=new Store(target,scope);assert.equal(next.listMessages(1,{limit:500,cursor:first.next_cursor}).items.length,1);
 assert.throws(()=>next.listMessages(1,{limit:1,cursor:first.next_cursor}),/CURSOR_MISMATCH/);
 assert.throws(()=>next.listMessages(1,{limit:500,cursor:first.next_cursor+'x'}),/CURSOR_MISMATCH/);
 assert.throws(()=>next.listTasks({state:'open'}),/MUTABLE_FILTER/);
 const other=addConversation(next,'other');assert.throws(()=>next.listMessages(other,{limit:500,cursor:first.next_cursor}),/CURSOR_MISMATCH/);
 next.close();const key=JSON.parse(readFileSync(target+'.cursor-key.json'));key.instance='different';writeFileSync(target+'.cursor-key.json',JSON.stringify(key));
 assert.throws(()=>new Store(target,scope),/CURSOR_KEY_UNAVAILABLE/);
});
test('legacy core refuses v2 DB before migration/heartbeat; source remains usable',async()=>{
 const {store:s,target,source}=await ready();s.close();const before=sha(target);
 // paths helper uses directory/bus.db; fixture copies are named explicitly.
 const dir=mkdtempSync(join(root,'legacy-'));writeFileSync(join(dir,'bus.db'),readFileSync(target));
 const result=spawnSync(process.execPath,['--input-type=module','-e',`import {deleteTeam} from './dist/bus.js';deleteTeam({team:'x',force:true});`],{cwd:resolve('.'),env:{...process.env,AGENT_BUS_DIR:dir}});
 assert.notEqual(result.status,0);assert.match(result.stderr.toString(),/LEGACY_TOOL_DISABLED/);assert.equal(sha(target),before);
});
test('two OS processes competing at same relation revision: exactly one commit',async()=>{
 const {store:s,target}=await ready();const c=addConversation(s,'race'),v=rev(s),origin=s.capabilities().instance_uuid;s.close();
 const script=`import {Store} from './dist/v2/store.js';const s=new Store(process.argv[1],${JSON.stringify(scope)});try{console.log(JSON.stringify(s.link(1,Number(process.argv[2]),Number(process.argv[3]),{origin_instance_uuid:process.argv[4],actor:'a',session_id:'s-a',request_id:process.argv[5]})))}catch(e){console.log(e.message)}finally{s.close()}`;
 const run=()=>new Promise(resolveResult=>{const p=spawn(process.execPath,['--input-type=module','-e',script,target,String(c),String(v),origin,randomUUID()]);let out='';p.stdout.on('data',x=>out+=x);p.on('exit',code=>resolveResult({code,out}));});
 const results=await Promise.all([run(),run()]);assert.equal(results.filter(x=>x.out.startsWith('{')).length,1);assert.ok(results.some(x=>/LINK_EXISTS|REVISION_CONFLICT/.test(x.out)));
});
test('MCP development manifest exposes bounded reads, no unfinished writers',async()=>{
 const {store:s,target}=await ready(501);s.close();const c=new Client({name:'test',version:'1'});
 try {
  await c.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/v2/server.js')],env:{...process.env,AGENT_BUS_V2_DB:target,AGENT_BUS_V2_SCOPE:JSON.stringify(scope)}}));
  const list=await c.listTools();assert.equal(list.tools.length,12);assert.ok(!list.tools.some(x=>/ack|claim|reply|send/.test(x.name)));
  const r=await c.callTool({name:'task_context_v2',arguments:{task_id:1}});assert.ok(!r.isError);const data=JSON.parse(r.content[0].text);assert.equal(data.body_included,false);assert.equal(JSON.stringify(data).includes('本文'),false);
  const invalid=await c.callTool({name:'list_tasks_v2',arguments:{state:'open'}});assert.equal(invalid.isError,true);
 }finally{await c.close();}
});
test('task context fixes both link and message high-water, excludes later body and unrelated conversation',async()=>{
 const {store:s}=await ready(501);const opened=s.openTaskContext(1);
 s.db.prepare("INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project,scope_id,conversation_id) VALUES('a','a','msg','later','pending',1,'thread','p',?,1)").run(s.sid);
 assert.equal(allPages(p=>s.listMessages(1,{...p,context_token:opened.context_token})).length,501);
 assert.equal(allPages(p=>s.listMessages(1,p)).length,502);
 const other=addConversation(s,'outside');s.link(1,other,rev(s),env(s));
 assert.throws(()=>s.listMessages(other,{context_token:opened.context_token}),/CONVERSATION_NOT_IN_CONTEXT/);
 assert.equal(s.listLinks(1,{context_token:opened.context_token}).items.length,1);s.close();
});
test('legal all-NULL scope remains distinct and writable; key loss never silently resets',async()=>{
 const f=fixture(1,db=>{db.exec('UPDATE tasks SET project=NULL; UPDATE messages SET project=NULL; UPDATE agents SET project=NULL');});
 const r=await migrateStoppedCopy(f.source,f.target,true);assert.equal(r.ready,true);
 const s=new Store(f.target,{project:null,area:null,team:null});assert.equal(s.listLinks(1).items.length,1);
 assert.throws(()=>s.link(1,999,rev(s),env(s)),/TARGET_NOT_FOUND/);s.close();
 rmSync(f.target+'.cursor-key.json');assert.throws(()=>new Store(f.target,{project:null,area:null,team:null}),/CURSOR_KEY_UNAVAILABLE/);
});
test('task context excludes pinned memories from another scope even with same task ID',async()=>{
 const {store:s}=await ready(1,db=>{
  const insert=db.prepare("INSERT INTO memories(by_agent,kind,content,task_id,project,pinned,created_at,updated_at) VALUES('a','summary',?,1,?,1,1,1)");
  insert.run('local summary','p');insert.run('foreign scope summary','elsewhere');
 });
 assert.deepEqual(s.taskContext(1).context.map(x=>x.summary),['local summary']);s.close();
});
test('P01 MCP published numeric bounds match runtime at IDs and page/chunk boundaries',async()=>{
 const {store:s,target}=await ready();
 s.db.prepare("INSERT INTO error_events(scope_id,code,source,at,task_ids,task_binding,retryable,summary) VALUES(?,'INTERNAL_ERROR','bus',1,'[]','unknown',0,'fixture')").run(s.sid);s.close();const c=new Client({name:'bounds-test',version:'1'});
 try {
  await c.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/v2/server.js')],env:{...process.env,AGENT_BUS_V2_DB:target,AGENT_BUS_V2_SCOPE:JSON.stringify(scope)}}));
  const {tools}=await c.listTools();
  for(const tool of tools) {
   const props=tool.inputSchema.properties;
   const base=Object.fromEntries(Object.keys(props).filter(k=>k.endsWith('_id')).map(k=>[k,1]));
   for(const [key,prop] of Object.entries(props)) {
    if(prop.type!=='integer')continue;
    const min=key==='max_bytes'?4:1;
    const max=key==='max_bytes'?65536:key==='limit'?(tool.name==='status_summary_v2'?100:500):undefined;
    assert.equal(prop.minimum,min,tool.name+':'+key);assert.equal(prop.maximum,max);
    for(const value of [min-1,min,min+0.5,...(max===undefined?[]:[max,max+1])]) {
     const result=await c.callTool({name:tool.name,arguments:{...base,[key]:value}});
     const valid=Number.isInteger(value)&&value>=min&&(max===undefined||value<=max);
     assert.equal(!result.isError,valid,`${tool.name} ${key}=${value}`);
     if(!valid)assert.equal(JSON.parse(result.content[0].text).code,'INVALID_INPUT');
    }
   }
  }
 }finally{await c.close();}
});
test('P02 unknown requires matching Task wait issue on INSERT/UPDATE and issue changes',async()=>{
 const f=fixture();const before=sha(f.source);await migrateStoppedCopy(f.source,f.target,true);assert.equal(sha(f.source),before);const seed=new Database(f.target);const iid=Number(seed.prepare("INSERT INTO migration_issues(source_table,source_id,code,detail) VALUES('tasks',1,'WAIT_UNCLASSIFIED','test fixture')").run().lastInsertRowid);seed.prepare("UPDATE tasks SET state='blocked',wait_kind='unknown',migration_issue_id=? WHERE id=1").run(iid);seed.prepare('UPDATE bus_meta SET ready=0').run();seed.close();
 const s=new Store(f.target,scope);const task=s.db.prepare('SELECT * FROM tasks WHERE id=1').get();
 assert.equal(task.wait_kind,'unknown');assert.equal(s.capabilities().schema,'2.4-dev.2');assert.equal(s.capabilities().ready,false);
 const issue=s.db.prepare('SELECT * FROM migration_issues WHERE issue_id=?').get(task.migration_issue_id);
 assert.equal(issue.source_table,'tasks');assert.equal(issue.source_id,1);assert.equal(issue.code,'WAIT_UNCLASSIFIED');
 const mk=(table,id,code)=>Number(s.db.prepare("INSERT INTO migration_issues(source_table,source_id,code,detail) VALUES(?,?,?,'test')").run(table,id,code).lastInsertRowid);
 const wrongTable=mk('messages',1,'WAIT_UNCLASSIFIED'),wrongTask=mk('tasks',999,'WAIT_UNCLASSIFIED'),wrongCode=mk('tasks',1,'WAIT_STATE_MISMATCH');
 for(const iid of [null,999999,wrongTable,wrongTask,wrongCode])assert.throws(()=>s.db.prepare('UPDATE tasks SET migration_issue_id=? WHERE id=1').run(iid),/INVALID_UNKNOWN_ISSUE/);
 const insert=s.db.prepare("INSERT INTO tasks(id,title,thread_id,requested_by,state,created_at,updated_at,project,scope_id,wait_kind,migration_issue_id) VALUES(2,'new','new-thread','a','blocked',1,1,'p',?,'unknown',?)");
 for(const iid of [null,999999,task.migration_issue_id,wrongTable,wrongTask,wrongCode])assert.throws(()=>insert.run(s.sid,iid),/INVALID_UNKNOWN_ISSUE/);
 const valid=mk('tasks',2,'WAIT_UNCLASSIFIED');insert.run(s.sid,valid);
 s.db.prepare("UPDATE tasks SET state='open',wait_kind='none',migration_issue_id=NULL WHERE id=2").run();
 assert.throws(()=>s.db.prepare("UPDATE tasks SET state='blocked',wait_kind='unknown' WHERE id=2").run(),/INVALID_UNKNOWN_ISSUE/);
 s.db.prepare("UPDATE tasks SET state='blocked',wait_kind='unknown',migration_issue_id=? WHERE id=2").run(valid);
 s.db.prepare("UPDATE tasks SET title='still blocked' WHERE id=1").run();
 for(const sql of ["DELETE FROM migration_issues WHERE issue_id=?","UPDATE migration_issues SET source_id=999 WHERE issue_id=?","UPDATE migration_issues SET source_table='messages' WHERE issue_id=?","UPDATE migration_issues SET code='other' WHERE issue_id=?","UPDATE migration_issues SET issue_id=999999 WHERE issue_id=?"])
  assert.throws(()=>s.db.prepare(sql).run(task.migration_issue_id),/REFERENCED_UNKNOWN_ISSUE/);
 assert.throws(()=>s.db.prepare("INSERT OR REPLACE INTO migration_issues(issue_id,source_table,source_id,code,detail) VALUES(?,'messages',1,'WAIT_UNCLASSIFIED','replacement')").run(task.migration_issue_id),/REFERENCED_UNKNOWN_ISSUE/);
 s.db.prepare("UPDATE migration_issues SET detail='more evidence' WHERE issue_id=?").run(task.migration_issue_id);
 assert.equal(s.taskContext(1).task.wait_kind,'unknown');assert.equal(s.capabilities().ready,false);
 assert.throws(()=>s.link(1,1,rev(s),env(s)),/READ_ONLY/);
 // A freshly created test copy emulates an older development version; no saved DB is upgraded.
 s.db.prepare("UPDATE bus_meta SET schema_version='2.1-dev.2'").run();s.close();
 assert.throws(()=>new Store(f.target,scope),/UNSUPPORTED_SCHEMA/);
});
test('P02 legacy unknown input is quarantined with WAIT_UNCLASSIFIED',async()=>{
 const f=fixture(1,db=>db.prepare("UPDATE tasks SET state='blocked'").run()),before=sha(f.source);await assert.rejects(()=>migrateStoppedCopy(f.source,f.target,true),/MIGRATION_FINAL_AUDIT_FAILED/);assert.equal(sha(f.source),before);assert.equal(existsSync(f.target),false);const failure=readdirSync(root).find(x=>x.startsWith(f.target.split('/').pop()+'.failed-')&&x.endsWith('.failure.json'));assert.ok(failure);const manifest=JSON.parse(readFileSync(join(root,failure),'utf8'));assert.equal(manifest.quarantine_path,`${f.target}.failed-${manifest.run_id}`);assert.equal(existsSync(manifest.quarantine_path),true);assert.equal(existsSync(f.target+'.migration.json'),false);const failed=new Database(manifest.quarantine_path,{readonly:true});assert.ok(failed.prepare("SELECT count(*) n FROM migration_issues WHERE code='WAIT_UNCLASSIFIED'").get().n>0);assert.equal(failed.prepare('SELECT count(*) n FROM migration_manifests').get().n,0);assert.equal(failed.prepare('SELECT count(*) n FROM operation_receipts').get().n,0);failed.close();
});
test('P03 direct Store and MCP reject unknown listing options',async()=>{
 const {store:s,target}=await ready();
 for(const options of [{state:'open'},{typo:1}]) {
  assert.throws(()=>s.listLinks(1,options),/MUTABLE_FILTER_UNSUPPORTED/);
  assert.throws(()=>s.listConversations(options),/MUTABLE_FILTER_UNSUPPORTED/);
 }
 assert.throws(()=>s.listConversations({context_token:'not supported'}),/MUTABLE_FILTER_UNSUPPORTED/);
 assert.equal(s.listLinks(1,{limit:1}).items.length,1);assert.equal(s.listConversations({limit:1}).items.length,1);s.close();
 const c=new Client({name:'filter-test',version:'1'});
 try {
  await c.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/v2/server.js')],env:{...process.env,AGENT_BUS_V2_DB:target,AGENT_BUS_V2_SCOPE:JSON.stringify(scope)}}));
  for(const [name,args] of [['list_task_conversations_v2',{task_id:1}],['list_conversations_v2',{}]]) {
   for(const extra of [{state:'open'},{typo:1}]) {
    const result=await c.callTool({name,arguments:{...args,...extra}});
    assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).code,'INVALID_INPUT');
   }
  }
 }finally{await c.close();}
});
test.after(()=>rmSync(root,{recursive:true,force:true}));
