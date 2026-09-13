import {historicalResult} from './helpers/receipt-result.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {initializeLegacySchema} from '../dist/db.js';
import {migrateStoppedCopy} from './helpers/synthetic-migration.mjs';
import {Tasks} from '../dist/v2/tasks.js';
import {Queries} from '../dist/v2/queries.js';
import {Observation} from '../dist/v2/observation.js';
const scope={project:'p',area:null,team:null},root=mkdtempSync(join(tmpdir(),'ab23-'));let seq=0;
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
async function fixture(blocked=false){
 const source=join(root,`${seq++}-source.db`),path=source.replace('source','target'),db=new Database(source);initializeLegacySchema(db);
 for(const a of ['a','human'])db.prepare('INSERT INTO agents(name,registered_at,last_seen,project,session_id) VALUES(?,1,1,?,?)').run(a,'p',a+'1');
 db.prepare("INSERT INTO tasks(id,title,thread_id,requested_by,state,created_at,updated_at,project) VALUES(1,'work','thread','a','open',1,1,'p')").run();
 db.prepare("INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project,delivered_at) VALUES('a','human','msg','old body','delivered',1,'thread','p',1)").run();db.close();
 const before=hash(source);await migrateStoppedCopy(source,path,true);assert.equal(hash(source),before);
 if(blocked){const seed=new Database(path);const iid=Number(seed.prepare("INSERT INTO migration_issues(source_table,source_id,code,detail) VALUES('tasks',1,'WAIT_UNCLASSIFIED','test fixture')").run().lastInsertRowid);seed.prepare("UPDATE tasks SET state='blocked',wait_kind='unknown',migration_issue_id=? WHERE id=1").run(iid);seed.prepare('UPDATE bus_meta SET ready=0').run();seed.close();}
 let now=9000000000000;const t=new Tasks(path,scope,{now:()=>now}),q=new Queries(path,scope);
 const env=(actor='a')=>({origin_instance_uuid:t.capabilities().instance_uuid,actor,session_id:actor+'1',request_id:randomUUID()});
 return {path,source,t,q,env,setNow:v=>now=v,close:()=>{t.close();q.close();}};
}
const revision=f=>f.t.db.prepare('SELECT task_revision FROM tasks WHERE id=1').get().task_revision;
function update(f,patch,e=f.env()){return f.t.updateTask({task_id:1,expected_task_revision:revision(f),patch},e);}
function pages(fn,limit=500){let cursor;const rows=[];do{const page=fn({limit,cursor});rows.push(...page.items);cursor=page.next_cursor;}while(cursor);return rows;}
const sinks=()=>({db:()=>{throw new Error('db unavailable');},stderr:()=>{throw new Error('stderr unavailable');},file:()=>{throw new Error('file unavailable');}});

test('Task create/update share receipt CAS and preserve technical wait on priority edits',async()=>{
 const f=await fixture(),args={title:'new task'},e=f.env();const n=f.t.createTask(args,e);assert.deepEqual(historicalResult(f.t.createTask(args,e)),historicalResult(n));
 const wait=update(f,{state:'blocked',wait_kind:'technical',blocked_reason:'dependency'});update(f,{priority:9});
 const row=f.t.db.prepare('SELECT * FROM tasks WHERE id=1').get();assert.equal(row.wait_kind,'technical');assert.equal(row.blocked_reason,'dependency');
 assert.throws(()=>f.t.updateTask({task_id:1,expected_task_revision:wait.task_revision,patch:{priority:1}},f.env()),/REVISION_CONFLICT/);
 assert.throws(()=>update(f,{state:'completed'}),/CLEAR_WAIT_REQUIRED/);
 assert.throws(()=>update(f,{blocked_on_task_id:1}),/INVALID_DEPENDENCY/);
 assert.throws(()=>update(f,{project:'other'}),/INVALID_INPUT/);
 assert.throws(()=>update(f,{wait_kind:'unknown'}),/INVALID_INPUT/);
 update(f,{state:'working',clear_wait:true});const resumed=f.t.db.prepare('SELECT * FROM tasks WHERE id=1').get();for(const k of ['human_question_id','blocked_reason','blocked_on_task_id'])assert.equal(resumed[k],null);
 assert.equal(resumed.wait_kind,'none');f.close();
});
test('Human question/reply and wait/resume are separate requests; bounded summary never auto resumes',async()=>{
 const f=await fixture(),qe=f.env(),args={to:'human',content:'secret full question',conversation_id:1,task_id:1};const ask=f.t.ask(args,qe);assert.deepEqual(historicalResult(f.t.ask(args,qe)),historicalResult(ask));
 update(f,{state:'blocked',wait_kind:'human',human_question_id:ask.message_id,blocked_reason:'need input'});
 let s=f.q.statusSummary({task_id:1});assert.equal(s.tasks[0].wait_description,'人への回答待ち');assert.ok(!JSON.stringify(s).includes('secret full question'));
 const link=f.t.listLinks(1).items[0];assert.throws(()=>f.t.correct(link.link_version_id,'remove','remove',f.t.db.prepare('SELECT relation_revision FROM bus_meta').get().relation_revision,f.env()),/HUMAN_WAIT_LINK_REQUIRED/);
 const a=f.t.immediate({limit:1},f.env('human')).items[0],re=f.env('human'),replyArgs={message_id:a.message_id,reply_generation:a.reply_generation,reply_token:a.reply_token,content:'human answer as reported'};
 const reply=f.t.reply(replyArgs,re);assert.deepEqual(historicalResult(f.t.reply(replyArgs,re)),historicalResult(reply));
 s=f.q.statusSummary({task_id:1});assert.equal(s.tasks[0].wait_description,'回答済み・未復帰');assert.equal(s.tasks[0].state,'blocked');assert.equal(s.automatic_resume,false);
 update(f,{state:'working',clear_wait:true});assert.equal(f.q.statusSummary().tasks[0].wait_kind,'none');f.close();
});
test('Human Q must be ask, scoped and related; normal writers cannot resolve unknown',async()=>{
 const f=await fixture();assert.throws(()=>update(f,{state:'blocked',wait_kind:'human',human_question_id:1,blocked_reason:'x'}),/HUMAN_QUESTION_REQUIRED/);
 assert.throws(()=>update(f,{state:'blocked',wait_kind:'human',human_question_id:999,blocked_reason:'x'}),/HUMAN_QUESTION_REQUIRED/);
 const cid=Number(f.t.db.prepare('INSERT INTO conversations(scope_id,thread_id) VALUES(?,?)').run(f.t.sid,'unrelated').lastInsertRowid);
 const ask=f.t.ask({to:'human',content:'question',conversation_id:cid,task_id:null},f.env());
 assert.throws(()=>update(f,{state:'blocked',wait_kind:'human',human_question_id:ask.message_id,blocked_reason:'x'}),/HUMAN_QUESTION_REQUIRED/);
 assert.throws(()=>f.t.db.prepare("UPDATE tasks SET state='blocked',wait_kind='none' WHERE id=1").run(),/INVALID_TASK_WAIT/);f.close();
 const unknown=await fixture(true);assert.equal(unknown.q.statusSummary().tasks[0].wait_description,'待ち種別未確認・要整理');assert.throws(()=>update(unknown,{state:'completed',clear_wait:true}),/MIGRATION_ISSUES_READ_ONLY/);unknown.close();
});
test('status legacy unknown input is quarantined with WAIT_UNCLASSIFIED',async()=>{
 const source=join(root,`${seq++}-legacy-unknown.db`),target=source.replace('legacy-unknown','legacy-unknown-target'),db=new Database(source);initializeLegacySchema(db);db.exec("INSERT INTO agents(name,registered_at,last_seen,project,session_id) VALUES('a',1,1,'p','a1'); INSERT INTO tasks(title,thread_id,requested_by,state,blocked_reason,created_at,updated_at,project) VALUES('work','thread','a','blocked','unknown',1,1,'p'); INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project) VALUES('a','human','msg','old body','delivered',1,'thread','p')");db.close();const before=hash(source);await assert.rejects(()=>migrateStoppedCopy(source,target,true),/MIGRATION_FINAL_AUDIT_FAILED/);assert.equal(hash(source),before);assert.equal(existsSync(target),false);const failure=readdirSync(root).find(x=>x.startsWith(target.split('/').pop()+'.failed-')&&x.endsWith('.failure.json'));assert.ok(failure);const manifest=JSON.parse(readFileSync(join(root,failure),'utf8'));assert.equal(manifest.quarantine_path,`${target}.failed-${manifest.run_id}`);assert.equal(existsSync(manifest.quarantine_path),true);assert.equal(existsSync(target+'.migration.json'),false);const failed=new Database(manifest.quarantine_path,{readonly:true});assert.ok(failed.prepare("SELECT count(*) n FROM migration_issues WHERE code='WAIT_UNCLASSIFIED'").get().n>0);assert.equal(failed.prepare('SELECT count(*) n FROM migration_manifests').get().n,0);assert.equal(failed.prepare('SELECT count(*) n FROM operation_receipts').get().n,0);failed.close();
});
test('two OS process barrier: priority versus explicit resume uses one revision',async()=>{
 const f=await fixture();update(f,{state:'blocked',wait_kind:'technical',blocked_reason:'wait'});const rev=revision(f);
 const workers=[{priority:1},{state:'working',clear_wait:true}].map(patch=>{
  let ready,end;const r=new Promise(x=>ready=x),done=new Promise(x=>end=x);let result;
  const child=fork(resolve('test/helpers/task-worker.mjs'),[],{env:{...process.env,TEST_DELIVERY_CONFIG:JSON.stringify({path:f.path,scope,now:9000000000000,method:'updateTask',args:{task_id:1,expected_task_revision:rev,patch},envelope:f.env()})},silent:true});
  child.on('message',m=>m.ready?ready():result=m);child.on('exit',()=>end(result));return {r,done,go:()=>child.send('go')};
 });await Promise.all(workers.map(w=>w.r));workers.forEach(w=>w.go());const results=await Promise.all(workers.map(w=>w.done));assert.equal(results.filter(r=>r.ok).length,1);assert.ok(results.some(r=>r.code==='REVISION_CONFLICT'));f.close();
});
test('automatic errors after rollback/clock COMMIT omit secrets and do not create success receipts',async()=>{
 const f=await fixture(),observer=new Observation(f.t.db,f.t.sid);observer.start();const secret='PRIVATE_TOKEN_'.repeat(100),e=f.env();
 const count=f.t.db.prepare('SELECT count(*) n FROM operation_receipts').get().n;
 assert.throws(()=>f.t.updateTask({task_id:1,expected_task_revision:0,patch:{state:'blocked',blocked_reason:secret}},e),/INVALID_TASK_WAIT/);
 assert.equal(f.t.db.prepare('SELECT count(*) n FROM operation_receipts').get().n,count);
 const error=f.q.listErrors().items[0];assert.equal(error.code,'INVALID_TASK_WAIT');assert.equal(error.source,'bus');assert.equal(error.request_id,e.request_id);assert.ok(!JSON.stringify(error).includes('PRIVATE_TOKEN'));
 assert.equal(f.t.db.prepare('SELECT lease_clock_ms FROM bus_meta').get().lease_clock_ms,9000000000000);
 f.setNow(8999999999999);update(f,{priority:1});assert.ok(f.q.listErrors().items.some(x=>x.code==='CLOCK_REGRESSION'));
 const report=f.t.reportError({task_id:1},f.env(),observer);const original=f.q.getError(report.error_id);f.t.reportError({task_id:1,corrects_event_id:report.error_id},f.env(),observer);assert.deepEqual(f.q.getError(report.error_id),original);
 observer.stop();f.close();
});
test('DB/stderr/file faults and unclosed epoch preserve partial coverage, never successful empty errors',async()=>{
 const f=await fixture();assert.equal(f.q.listErrors().snapshot.coverage.state,'unobserved');let lines=[];
 const fallback=new Observation(f.t.db,f.t.sid,{db:()=>{throw new Error('full');},stderr:s=>lines.push(s),file:()=>{throw new Error('full');}});fallback.start();
 const r=fallback.record(new Error('arbitrary SECRET input'),{token:'SECRET'},f.env());assert.equal(r.observability,'fallback');assert.ok(!lines.join('').includes('SECRET'));fallback.stop();assert.equal(f.q.listErrors().snapshot.coverage.gaps,1);
 const all=new Observation(f.t.db,f.t.sid,sinks());all.start();assert.equal(all.record(new Error('SECRET'),{},f.env()).observability,'unavailable');
 // Abandon an epoch as a killed process would; a new connection cannot infer OS liveness.
 const reader=new Queries(f.path,scope);assert.ok(reader.listErrors().snapshot.coverage.unclosed_epochs>0);reader.close();
 all.stop();const next=new Observation(f.t.db,f.t.sid);next.start();assert.equal(f.q.listErrors().snapshot.coverage.complete,false);next.stop();
 f.t.db.exec('DROP TABLE error_events');assert.throws(()=>f.q.listErrors());f.close();
});
test('1001 error/event pages freeze high-water/coverage, corrections append, filters/cursors are scoped',async()=>{
 const f=await fixture(),obs=new Observation(f.t.db,f.t.sid);obs.start();
 f.t.db.transaction(()=>{for(let i=0;i<1001;i++)obs.insert('AGENT_REPORTED',{task_id:1},f.env(),'agent_report');})();
 const first=f.q.listErrors({task_id:1,limit:500});assert.equal(first.items.length,500);const upper=first.snapshot.upper_id;
 f.t.reportError({task_id:1,corrects_event_id:1},f.env(),obs);let cursor=first.next_cursor,items=[...first.items];while(cursor){const p=f.q.listErrors({task_id:1,limit:500,cursor});items.push(...p.items);assert.deepEqual(p.snapshot.coverage,first.snapshot.coverage);cursor=p.next_cursor;}
 assert.equal(items.length,1001);assert.ok(items.every(x=>x.event_id<=upper));assert.equal(pages(p=>f.q.listErrors(p)).length,1002);
 assert.throws(()=>f.q.listErrors({limit:500,cursor:first.next_cursor}),/CURSOR_MISMATCH/);
 assert.throws(()=>f.q.listErrors({state:'open'}),/MUTABLE_FILTER_UNSUPPORTED/);
 f.t.db.prepare('INSERT INTO scopes(scope_key,project) VALUES(?,?)').run(JSON.stringify(['other',null,null]),'other');const other=new Queries(f.path,{project:'other',area:null,team:null});assert.throws(()=>other.getError(1),/TARGET_NOT_FOUND/);assert.throws(()=>other.listErrors({cursor:first.next_cursor,limit:500}),/CURSOR_MISMATCH/);other.close();
 f.t.db.transaction(()=>{for(let i=0;i<1001;i++)f.t.db.prepare("INSERT INTO communication_events(scope_id,operation,at,from_agent,task_ids,task_binding,purpose,status,request_id,actor,session_id,details_json) VALUES(?,'fixture',1,'a','[1]','assigned','fixture','recorded',?,'a','a1','{}')").run(f.t.sid,randomUUID());})();
 const page=f.q.listCommunicationEvents({task_id:1,limit:500});assert.equal(page.snapshot.coverage.task_filter_excludes_unknown,true);assert.ok(page.snapshot.coverage.unknown_membership_messages>0);
 assert.ok(pages(p=>f.q.listCommunicationEvents(p)).length>=1001);assert.throws(()=>f.q.listCommunicationEvents({cursor:first.next_cursor,limit:500}),/CURSOR_MISMATCH/);
 obs.stop();f.close();
});
test('new MCP reads advertise precise schema and do not write even on invalid input or read_only',async()=>{
 const f=await fixture(),obs=new Observation(f.t.db,f.t.sid);obs.start();f.t.reportError({task_id:1},f.env(),obs);obs.stop();
 f.t.db.prepare("UPDATE bus_meta SET recovery_state='read_only'").run();const before=hash(f.path),client=new Client({name:'status-test',version:'1'});
 try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/v2/server.js')],env:{...process.env,AGENT_BUS_V2_DB:f.path,AGENT_BUS_V2_SCOPE:JSON.stringify(scope)}}));
  const {tools}=await client.listTools();assert.equal(tools.length,12);assert.deepEqual(tools.find(t=>t.name==='list_errors_v2').inputSchema.properties.source.enum,['bus','agent_report']);
  assert.equal(tools.find(t=>t.name==='status_summary_v2').inputSchema.properties.limit.maximum,100);
  for(const [name,args] of [['list_errors_v2',{}],['get_error_v2',{error_id:1}],['list_communication_events_v2',{}],['status_summary_v2',{task_id:1}]])assert.ok(!(await client.callTool({name,arguments:args})).isError);
  for(const [name,args] of [['status_summary_v2',{limit:101}],['get_error_v2',{error_id:0}],['list_errors_v2',{source:'SECRET'}],['list_errors_v2',{state:'open'}]])assert.equal((await client.callTool({name,arguments:args})).isError,true);
 }finally{await client.close();}
 assert.equal(hash(f.path),before);f.close();
});
test('observer process loss is unclosed coverage; 501 pages survive restart and reject restored instance',async()=>{
 const f=await fixture();
 const child=fork(resolve('test/helpers/observer-worker.mjs'),[],{env:{...process.env,TEST_OBSERVER_CONFIG:JSON.stringify({path:f.path,scope})},silent:true});
 assert.equal(await new Promise(r=>child.on('exit',r)),71);
 const restarted=new Queries(f.path,scope);assert.equal(restarted.listErrors().snapshot.coverage.unclosed_epochs,1);
 const obs=new Observation(f.t.db,f.t.sid);obs.start();f.t.db.transaction(()=>{for(let i=0;i<501;i++)obs.insert('AGENT_REPORTED',{},f.env(),'agent_report');})();
 const first=restarted.listErrors({limit:500});restarted.close();const sameInstance=new Queries(f.path,scope);assert.equal(sameInstance.listErrors({limit:500,cursor:first.next_cursor}).items.length,1);sameInstance.close();obs.stop();
 const next=randomUUID();f.t.db.prepare('UPDATE bus_meta SET instance_uuid=?').run(next);const key=JSON.parse(readFileSync(f.path+'.cursor-key.json'));key.instance=next;writeFileSync(f.path+'.cursor-key.json',JSON.stringify(key));
 const restored=new Queries(f.path,scope);assert.throws(()=>restored.listErrors({limit:500,cursor:first.next_cursor}),/CURSOR_MISMATCH/);restored.close();f.close();
});
test('communication pages retain unknown historical membership while later events and corrections append',async()=>{
 const f=await fixture(),before=f.q.listCommunicationEvents();assert.equal(before.items.length,0);assert.equal(before.snapshot.coverage.historical_communication,'not_reconstructed');
 // A new event on the migrated message must retain unknown, never infer Task 1 from current links.
 f.t.db.prepare("UPDATE messages SET status='pending' WHERE id=1").run();f.t.db.prepare("UPDATE delivery_state SET mode='guarded' WHERE message_id=1").run();
 f.t.immediate({limit:1},f.env('human'));
 const events=f.q.listCommunicationEvents().items;assert.equal(events[0].task_binding,'unknown');assert.equal(JSON.parse(events[0].details_json).binding_coverage,'historical_unobserved');
 assert.equal(f.q.listCommunicationEvents({task_id:1}).items.length,0);assert.equal(f.q.listCommunicationEvents({task_id:1}).snapshot.coverage.task_filter_excludes_unknown,true);
 f.t.db.transaction(()=>{for(let i=0;i<501;i++)f.t.db.prepare("INSERT INTO communication_events(scope_id,operation,at,task_ids,task_binding,purpose,status,request_id,actor,session_id,details_json) VALUES(?,'fixture',1,'[1]','assigned','fixture','recorded',?,'a','a1','{}')").run(f.t.sid,randomUUID());})();
 const first=f.q.listCommunicationEvents({limit:500});const v=f.t.listLinks(1).items[0];f.t.correct(v.link_version_id,'revise','corrected',f.t.db.prepare('SELECT relation_revision FROM bus_meta').get().relation_revision,f.env());
 const tail=f.q.listCommunicationEvents({limit:500,cursor:first.next_cursor});assert.equal(first.items.length+tail.items.length,502);assert.ok(tail.items.every(e=>e.event_id<=first.snapshot.upper_id));f.close();
});
test.after(()=>rmSync(root,{recursive:true,force:true}));
