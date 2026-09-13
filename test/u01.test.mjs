import {historicalResult} from './helpers/receipt-result.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {initializeLegacySchema} from '../dist/db.js';
import {migrateStoppedCopy} from './helpers/synthetic-migration.mjs';
import {Tasks} from '../dist/v2/tasks.js';
import {Queries} from '../dist/v2/queries.js';
import {mutation} from '../dist/v2/mutation.js';
import {Observation} from '../dist/v2/observation.js';
const scope={project:'p',area:null,team:null},other={...scope,project:'other'},root=mkdtempSync(join(tmpdir(),'ab-u01-'));let seq=0;
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function legacyFixture({count=1,foreign=false,blocked=true}={}){
 const source=join(root,`${seq++}-source.db`),path=source.replace('source','target'),db=new Database(source);initializeLegacySchema(db);
 for(const project of ['p','other'])for(const a of ['a','human'])db.prepare('INSERT INTO agents(name,registered_at,last_seen,project,session_id) VALUES(?,1,1,?,?)').run(project==='p'?a:a+'-other',project,project==='p'?a+'1':a+'-other1');
 for(let id=1;id<=count;id++)db.prepare("INSERT INTO tasks(id,title,thread_id,requested_by,state,blocked_reason,created_at,updated_at,project) VALUES(?,'work',?,'a',?,?,1,1,?)").run(id,'thread'+id,blocked?'blocked':'open',blocked?'original reason '+id:null,foreign&&id===count?'other':'p');
 for(const [thread,project] of [['thread1','p'],['unrelated','p'],['foreign-thread','other']])db.prepare("INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project,delivered_at) VALUES('a','human','ask','original Q','delivered',1,?,?,1)").run(thread,project);
 for(let id=2;id<=count;id++)db.prepare("INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project,delivered_at) VALUES('a','human','msg','task reference','delivered',1,?,?,1)").run('thread'+id,foreign&&id===count?'other':'p');
 db.close();return {source,path};
}
async function fixture({count=1,foreign=false,extraIssue=false}={}){
 const {source,path}=legacyFixture({count,foreign,blocked:false});const sourceHash=hash(source);await migrateStoppedCopy(source,path,true);assert.equal(hash(source),sourceHash);
 const setup=new Database(path);for(let id=1;id<=count;id++){const iid=Number(setup.prepare("INSERT INTO migration_issues(source_table,source_id,code,detail) VALUES('tasks',?,'WAIT_UNCLASSIFIED',?)").run(id,'Human/technical classification needs evidence; not inferred').lastInsertRowid);setup.prepare("UPDATE tasks SET state='blocked',blocked_reason=?,wait_kind='unknown',migration_issue_id=? WHERE id=?").run('original reason '+id,iid,id);}setup.prepare('UPDATE bus_meta SET ready=0').run();setup.close();
 const t=new Tasks(path,scope,{now:()=>9000000000000}),q=new Queries(path,scope);
 assert.deepEqual(t.db.prepare('SELECT code FROM migration_issues').all().map(x=>x.code),Array(count).fill('WAIT_UNCLASSIFIED'));
 if(extraIssue)t.db.prepare("INSERT INTO migration_issues(source_table,source_id,code,detail) VALUES('memories',99,'UNSUPPORTED_REFERENCE','original extra issue')").run();
 const env=(over={})=>({origin_instance_uuid:t.capabilities().instance_uuid,actor:'a',session_id:'a1',request_id:randomUUID(),...over});
 const args=(id=1,over={})=>{const issue=t.db.prepare('SELECT migration_issue_id id FROM tasks WHERE id=?').get(id).id;return {task_id:id,expected_task_revision:0,issue_id:issue,wait_kind:'technical',blocked_reason:'verified dependency',evidence_refs:[{table:'migration_issues',id:issue}],...over};};
 const manifest=hash(path+'.migration.json');
 return {path,source,t,q,env,args,close:()=>{assert.equal(hash(source),sourceHash);assert.equal(hash(path+'.migration.json'),manifest);t.close();q.close();}};
}
async function isolationFixture(options={}){
 const {source,path}=legacyFixture({...options,blocked:true}),before=hash(source);let err;try{await migrateStoppedCopy(source,path,true);}catch(e){err=e;}assert.match(err?.message??'',/MIGRATION_FINAL_AUDIT_FAILED/);assert.equal(existsSync(path),false);assert.equal(hash(source),before);const failed=readdirSync(root).find(x=>x.startsWith(path.split('/').pop()+'.failed-')&&x.endsWith('.failure.json'));assert.ok(failed);const manifest=JSON.parse(readFileSync(join(root,failed),'utf8'));assert.equal(manifest.quarantine_path,`${path}.failed-${manifest.run_id}`);assert.equal(existsSync(manifest.quarantine_path),true);assert.equal(manifest.code,'MIGRATION_FINAL_AUDIT_FAILED');assert.equal(existsSync(path+'.migration.json'),false);const target=new Database(manifest.quarantine_path,{readonly:true});assert.equal(target.prepare("SELECT count(*) n FROM migration_issues WHERE code='WAIT_UNCLASSIFIED'").get().n,options.count??1);assert.equal(target.prepare('SELECT count(*) n FROM migration_manifests').get().n,0);assert.equal(target.prepare('SELECT count(*) n FROM operation_receipts').get().n,0);target.close();return manifest;
}
const business=f=>Object.fromEntries(['tasks','migration_issues','task_wait_resolutions','communication_events','operation_receipts'].map(table=>[table,f.t.db.prepare('SELECT * FROM '+table).all()]));
const resolveWait=(f,args=f.args(),e=f.env())=>f.t.resolveTaskWait(args,e);
function worker(f,args,e,{exitAt,now=9000000000000}={}){
 let ready,done,result;const r=new Promise(x=>ready=x),end=new Promise(x=>done=x);
 const child=fork(resolve('test/helpers/task-worker.mjs'),[],{env:{...process.env,TEST_DELIVERY_CONFIG:JSON.stringify({path:f.path,scope,now,method:'resolveTaskWait',args,envelope:e,exitAt})},silent:true});
 child.on('message',m=>m.ready?ready():result=m);child.on('exit',code=>done({code,...result}));
 return {r,end,go:()=>child.send('go')};
}
test('U01 technical preserves original issue/reason, remains blocked; live ready and restart agree',async()=>{
 const f=await fixture(),before=business(f),e=f.env(),args=f.args();assert.equal(f.t.capabilities().ready,false);
 const out=resolveWait(f,args,e);assert.equal(out.ready_at_classification,true);assert.equal(out.current_ready,true);assert.equal(out.state,'blocked');
 assert.equal(f.q.statusSummary().ready,true);assert.equal(f.q.statusSummary().tasks[0].wait_kind,'technical');assert.equal(f.t.capabilities().ready,true);
 assert.deepEqual(business(f).migration_issues,before.migration_issues);
 const resolution=f.t.db.prepare('SELECT * FROM task_wait_resolutions').get();assert.deepEqual(JSON.parse(resolution.before_json).task,before.tasks[0]);assert.equal(JSON.parse(resolution.before_json).task.blocked_reason,'original reason 1');
 const reopened=new Tasks(f.path,scope,{now:()=>9000000000000});assert.equal(reopened.capabilities().ready,true);assert.deepEqual(historicalResult(reopened.resolveTaskWait(args,e)),historicalResult(out));reopened.close();
 assert.throws(()=>resolveWait(f,f.args(1,{expected_task_revision:1})),/WAIT_NOT_UNCLASSIFIED/);
 assert.throws(()=>resolveWait(f,{...args,blocked_reason:'changed'},e),/REQUEST_ID_REUSE/);
 assert.throws(()=>f.t.updateTask({task_id:1,expected_task_revision:1,patch:{state:'working'}},f.env()),/CLEAR_WAIT_REQUIRED/);
 f.t.updateTask({task_id:1,expected_task_revision:1,patch:{state:'working',clear_wait:true}},f.env());assert.deepEqual(historicalResult(resolveWait(f,args,e)),historicalResult(out));
 for(const sql of ["UPDATE migration_issues SET detail='tampered'",'DELETE FROM migration_issues','UPDATE task_wait_resolutions SET at=0','DELETE FROM task_wait_resolutions',"INSERT OR REPLACE INTO migration_issues SELECT * FROM migration_issues",'INSERT OR REPLACE INTO task_wait_resolutions SELECT * FROM task_wait_resolutions'])assert.throws(()=>f.t.db.exec(sql),/IMMUTABLE|INVALID_WAIT_RESOLUTION/);f.close();
});
test('U01 human requires existing scoped related ask; evidence is bounded structured references',async()=>{
 const f=await fixture(),before=business(f);
 for(const human_question_id of [null,999,2,3])assert.throws(()=>resolveWait(f,f.args(1,{wait_kind:'human',human_question_id})),/HUMAN_QUESTION_REQUIRED/);
 for(const evidence_refs of [[],null,Array(17).fill({table:'tasks',id:1}),[{table:'messages',id:3}],[{table:'tasks',id:1,body:'secret'}],[{table:'secret',id:1}]])assert.throws(()=>resolveWait(f,f.args(1,{evidence_refs})),/EVIDENCE_REFERENCE/);
 for(const patch of [{wait_kind:'unknown'},{wait_kind:'none'},{blocked_reason:''},{blocked_on_task_id:1},{state:'completed'}])assert.throws(()=>resolveWait(f,f.args(1,patch)),/INVALID/);
 assert.deepEqual(business(f),before);
 const out=resolveWait(f,f.args(1,{wait_kind:'human',human_question_id:1,evidence_refs:[{table:'messages',id:1}]}));assert.equal(out.current_ready,true);assert.equal(f.q.statusSummary().tasks[0].wait_description,'人への回答待ち');f.close();
});
test('U01 partial classifications keep ready false; same receipt reports historical and current ready separately',async()=>{
 const f=await fixture({count:2}),original=business(f),e=f.env(),args=f.args(),a=resolveWait(f,args,e);
 assert.equal(a.ready_at_classification,false);assert.equal(a.current_ready,false);assert.deepEqual(business(f).tasks[1],original.tasks[1]);assert.deepEqual(historicalResult(resolveWait(f,args,e)),historicalResult(a));
 assert.throws(()=>resolveWait(f,{...args,blocked_reason:'changed'},e),/REQUEST_ID_REUSE/);
 assert.throws(()=>f.t.updateTask({task_id:1,expected_task_revision:1,patch:{priority:1}},e),/REQUEST_ID_REUSE/);
 // Move the classified Task forward only once the whole DB is ready.
 const b=resolveWait(f,f.args(2));assert.equal(b.current_ready,true);
 const replay=resolveWait(f,args,e);assert.equal(replay.ready_at_classification,false);assert.equal(replay.current_ready,true);assert.equal(f.q.statusSummary().ready,true);f.close();
});
test('U01 other-scope unknown and other issue types keep DB-wide ready false',async()=>{
 const f=await fixture({count:2,foreign:true,extraIssue:true}),before=business(f);resolveWait(f);
 assert.equal(f.t.capabilities().ready,false);assert.deepEqual(business(f).tasks[1],before.tasks[1]);
 const foreign=new Tasks(f.path,other);const out=foreign.resolveTaskWait(f.args(2),f.env({actor:'a-other',session_id:'a-other1'}));assert.equal(out.current_ready,false);assert.equal(foreign.capabilities().ready,false);foreign.close();
 assert.deepEqual(business(f).migration_issues,before.migration_issues);f.close();
});
test('U01 dedicated gate rejects normal writers, arbitrary operation reuse, recovery/origin/session/scope and observer bypass',async()=>{
 const f=await fixture(),before=business(f);
 assert.throws(()=>f.t.createTask({title:'new',wait_kind:'unknown'},f.env()),/MIGRATION_ISSUES_READ_ONLY/);
 assert.throws(()=>f.t.updateTask({task_id:1,expected_task_revision:0,patch:{state:'completed',clear_wait:true}},f.env()),/MIGRATION_ISSUES_READ_ONLY/);
 assert.throws(()=>f.t.ask({to:'human',content:'new Q',conversation_id:1,task_id:1},f.env()),/MIGRATION_ISSUES_READ_ONLY/);
 assert.throws(()=>f.t.reply({message_id:1,reply_generation:1,reply_token:'x',content:'answer'},f.env()),/MIGRATION_ISSUES_READ_ONLY/);
 assert.throws(()=>mutation(f.t.db,f.t.sid,'resolve_task_wait_v2',{},f.env(),()=>{throw Error('BYPASS');}),/MIGRATION_ISSUES_READ_ONLY/);
 assert.throws(()=>new Observation(f.t.db,f.t.sid).start(),/READ_ONLY/);
 for(const over of [{origin_instance_uuid:randomUUID()},{session_id:'wrong'},{actor:'not-registered'}])assert.throws(()=>resolveWait(f,f.args(),f.env(over)),/RECOVERY_OUTCOME_UNKNOWN|SESSION_SCOPE_MISMATCH/);
 const foreign=new Tasks(f.path,other);assert.throws(()=>foreign.resolveTaskWait(f.args(),f.env({actor:'a-other',session_id:'a-other1'})),/TARGET_NOT_FOUND/);foreign.close();
 f.t.db.exec("UPDATE bus_meta SET recovery_state='recovery_read_only'");assert.throws(()=>resolveWait(f),/RECOVERY_READ_ONLY/);assert.deepEqual(business(f),before);f.close();
});
for(const table of ['task_wait_resolutions','communication_events','operation_receipts'])test(`U01 ${table} insert failure rolls back all business/ready while retaining observed clock`,async()=>{
 const f=await fixture(),before=business(f);f.t.db.exec(`CREATE TRIGGER inject_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'INJECTED_STORAGE'); END`);
 let err;try{resolveWait(f);}catch(e){err=e;}assert.match(err.message,/INJECTED_STORAGE/);assert.equal(err.observability,'unavailable');assert.deepEqual(business(f),before);assert.equal(f.t.capabilities().ready,false);assert.equal(f.t.db.prepare('SELECT lease_clock_ms FROM bus_meta').get().lease_clock_ms,9000000000000);
 f.t.db.exec('DROP TRIGGER inject_failure');assert.equal(resolveWait(f).current_ready,true);f.close();
});
test('U01 ready-check integrity and SQL failures roll back classification and never publish ready',async()=>{
 for(const failure of ['dependency','query','receipt-update','ready-update','resolution-record','foreign-key','human-link','foreign-reply']){
  const f=await fixture({count:2});
  if(failure==='dependency'){f.t.db.exec('DROP TRIGGER task_wait_update');f.t.db.prepare('UPDATE tasks SET blocked_on_task_id=id WHERE id=2').run();}
  if(failure==='foreign-key'){f.t.db.pragma('foreign_keys=OFF');f.t.db.exec("UPDATE tasks SET requested_by='missing' WHERE id=2");f.t.db.pragma('foreign_keys=ON');}
  if(failure==='human-link'){f.t.db.exec('DROP TRIGGER task_wait_update');f.t.db.exec("UPDATE tasks SET wait_kind='human',human_question_id=1 WHERE id=2");}
  if(failure==='foreign-reply'){f.t.db.exec('DROP TRIGGER message_immutable');f.t.db.exec('UPDATE messages SET reply_to=3 WHERE id=1');}
  if(failure==='query')f.t.db.exec('DROP TABLE ask_answers');
  if(failure==='receipt-update')f.t.db.exec("CREATE TRIGGER bad_receipt BEFORE UPDATE ON operation_receipts BEGIN SELECT RAISE(ABORT,'INJECTED_FINAL_RECEIPT'); END");
  if(failure==='ready-update')f.t.db.exec("CREATE TRIGGER bad_ready BEFORE UPDATE OF ready ON bus_meta BEGIN SELECT RAISE(ABORT,'INJECTED_READY'); END");
  if(failure==='resolution-record'){
   resolveWait(f);f.t.db.exec('DROP TRIGGER resolution_update');f.t.db.exec("UPDATE task_wait_resolutions SET input_json=json_set(input_json,'$.blocked_reason','tampered')");
  }
  const before=business(f);assert.throws(()=>resolveWait(f,f.args(failure==='resolution-record'?2:1)),/WAIT_RESOLUTION_INTEGRITY|HUMAN_QUESTION_REQUIRED|no such table|INJECTED/);assert.deepEqual(business(f),before);assert.equal(f.t.capabilities().ready,false);f.close();
 }
});
test('U01 two OS processes classify one revision/issue exactly once',async()=>{
 const f=await fixture(),ws=[worker(f,f.args(),f.env()),worker(f,f.args(1,{blocked_reason:'second'}),f.env())];await Promise.all(ws.map(w=>w.r));ws.forEach(w=>w.go());const result=await Promise.all(ws.map(w=>w.end));assert.equal(result.filter(r=>r.ok).length,1);assert.ok(result.some(r=>r.code==='REVISION_CONFLICT'));assert.equal(business(f).task_wait_resolutions.length,1);assert.equal(business(f).operation_receipts.length,1);f.close();
});
for(const exitAt of ['before_commit','after_commit'])test(`U01 OS exit ${exitAt}: restart and same-ID retry are atomic`,async()=>{
 const f=await fixture({count:2}),e=f.env(),args=f.args(),before=business(f),w=worker(f,args,e,{exitAt});await w.r;w.go();assert.equal((await w.end).code,71);
 if(exitAt==='before_commit')assert.deepEqual(business(f),before);else assert.equal(business(f).task_wait_resolutions.length,1);
 const reopened=new Tasks(f.path,scope);const out=reopened.resolveTaskWait(args,e);assert.equal(out.current_ready,false);assert.equal(out.task_revision,1);assert.equal(business(f).task_wait_resolutions.length,1);assert.equal(business(f).operation_receipts.length,1);reopened.close();f.close();
});
test('U01 foreign-scope last classification changes existing and new connection ready',async()=>{
 const f=await fixture({count:2,foreign:true});resolveWait(f);assert.equal(f.q.statusSummary().ready,false);
 const otherWriter=new Tasks(f.path,other,{now:()=>9000000000000});assert.equal(otherWriter.resolveTaskWait(f.args(2),f.env({actor:'a-other',session_id:'a-other1'})).current_ready,true);
 assert.equal(f.q.statusSummary().ready,true);assert.equal(f.t.capabilities().ready,true);const fresh=new Queries(f.path,scope);assert.equal(fresh.capabilities().ready,true);fresh.close();otherWriter.close();f.close();
});
test('U01 same request from two OS processes returns one successful classification',async()=>{
 const f=await fixture({count:2}),e=f.env(),ws=[worker(f,f.args(),e),worker(f,f.args(),e)];await Promise.all(ws.map(w=>w.r));ws.forEach(w=>w.go());const results=await Promise.all(ws.map(w=>w.end));assert.ok(results.every(r=>r.ok));assert.deepEqual(historicalResult(results[0].result),historicalResult(results[1].result));assert.equal(business(f).operation_receipts.length,1);assert.equal(business(f).task_wait_resolutions.length,1);f.close();
});
test('U01 finite BUSY, clock reversal after rejection, and rejected replay authentication',async()=>{
 const f=await fixture({count:2});let attempts=0;
 const busy=new Tasks(f.path,scope,{fault:p=>{if(p==='locked'){attempts++;throw Object.assign(new Error('busy'),{code:'SQLITE_BUSY'});}}});
 assert.throws(()=>busy.resolveTaskWait(f.args(),f.env()),/busy/);assert.equal(attempts,3);busy.close();
 assert.throws(()=>resolveWait(f,f.args(1,{issue_id:f.args(2).issue_id})),/WAIT_NOT_UNCLASSIFIED/);
 const lower=new Tasks(f.path,scope,{now:()=>8999999999999}),e=f.env(),out=lower.resolveTaskWait(f.args(),e);assert.equal(out.clock_observability,'unavailable');assert.equal(f.t.db.prepare('SELECT lease_clock_ms FROM bus_meta').get().lease_clock_ms,9000000000000);
 assert.throws(()=>lower.resolveTaskWait(f.args(),{...e,session_id:'wrong'}),/SESSION_SCOPE_MISMATCH/);
 f.t.db.exec("UPDATE bus_meta SET recovery_state='recovery_read_only'");assert.throws(()=>lower.resolveTaskWait(f.args(),e),/RECOVERY_READ_ONLY/);
 lower.close();f.close();
});
test.after(()=>rmSync(root,{recursive:true,force:true}));

// These are migration quarantine fixtures, not fault/clock/concurrency tests.
// Preserve every fixture; the historical labels below only identify their origin.
for(const [index,[,input]] of [
 ['U01 technical isolation',{count:1}],['U01 human isolation',{count:1}],['U01 partial isolation',{count:2}],['U01 other-scope isolation',{count:2,foreign:true}],['U01 writer-gate isolation',{count:1}],['U01 task_wait_resolutions fault isolation',{count:1}],['U01 communication_events fault isolation',{count:1}],['U01 operation_receipts fault isolation',{count:1}],['U01 ready-check isolation',{count:2}],['U01 concurrent classification isolation',{count:1}],['U01 before_commit isolation',{count:2}],['U01 after_commit isolation',{count:2}],['U01 foreign last isolation',{count:2,foreign:true}],['U01 replay isolation',{count:2}],['U01 clock isolation',{count:2}],['U24 revoked Session isolation',{count:1}]
].entries())test(`T02 U01 migration quarantine fixture ${index+1}: count=${input.count}, foreign=${!!input.foreign}`,async()=>{const m=await isolationFixture(input);assert.equal(m.secret_included,false);});

test('U24 revoked Session may replay a classified receipt while not ready, but cannot classify new work',async()=>{
 const {Registration}=await import('../dist/v2/registration.js');
 const f=await fixture(),args=f.args(),e=f.env(),out=resolveWait(f,args,e);
 const reg=new Registration(f.path,scope,{now:()=>9000000000000});
 reg.revokeSession({target_session_id:'a1',expected_session_revision:1,reason:'explicit end',evidence_ref:'artifact:end'},f.env());
 // A later unresolved issue changes current readiness; the historical classification remains valid.
 reg.db.prepare("INSERT INTO migration_issues(source_table,source_id,code,detail) VALUES('messages',NULL,'LATER_ISSUE','fixture')").run();reg.db.exec('UPDATE bus_meta SET ready=0');
 const replay=reg.resolveTaskWait(args,e);assert.equal(replay.replayed,true);assert.equal(replay.session_active_now,false);assert.equal(replay.ready_at_classification,true);assert.equal(replay.current_ready,false);assert.equal(replay.resolution_id,out.resolution_id);
 const n=reg.db.prepare('SELECT count(*) n FROM operation_receipts').get().n;
 assert.throws(()=>reg.resolveTaskWait(args,f.env()),/SESSION_REVOKED/);assert.equal(reg.db.prepare('SELECT count(*) n FROM operation_receipts').get().n,n);
 reg.db.exec("UPDATE bus_meta SET recovery_state='recovery_read_only'");assert.throws(()=>reg.resolveTaskWait(args,e),/RECOVERY_READ_ONLY/);reg.close();f.close();
});
