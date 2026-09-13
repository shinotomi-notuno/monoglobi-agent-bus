import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,statSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fork,spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {initializeTarget} from '../dist/v2/initialize.js';
import {Registration} from '../dist/v2/registration.js';
import {migrateStoppedCopy} from './helpers/synthetic-migration.mjs';
import {initializeLegacySchema} from '../dist/db.js';
import {Observation} from '../dist/v2/observation.js';
import {apiVersion,schemaVersion} from '../dist/v2/schema.js';
const scope={project:'p',area:null,team:null},other={project:'p',area:'',team:null};
const root=mkdtempSync(join(tmpdir(),'ab24-'));let seq=0;
const regArgs=(rev=0,role='techlead',provider='codex')=>({role,provider,expected_registration_revision:rev});
const reason={reason:'explicit retirement',evidence_ref:'artifact:operator-record'};
function fresh(empty=false){
 const path=join(root,`${seq++}.db`);initializeTarget(path,[scope,other]);
 const s=new Registration(path,scope,{now:()=>10000});
 const env=(actor='a',session_id=actor+'1',request_id=randomUUID())=>({actor,session_id,request_id,origin_instance_uuid:s.capabilities().instance_uuid});
 if(!empty){s.register(regArgs(),env());s.register(regArgs(0,'reviewer','claude'),env('b'));}
 const conv=()=>s.createConversation({thread_id:'thread'},env()).conversation_id;
 const send=(ask=true)=>s[ask?'ask':'send']({to:'b',content:'question',task_id:null,conversation_id:conv()},env()).message_id;
 return {path,s,env,conv,send};
}
const counts=s=>Object.fromEntries(['agents','agent_registrations','registered_sessions','conversations','operation_receipts','communication_events','messages','ask_answers'].map(t=>[t,s.db.prepare(`SELECT count(*) n FROM ${t}`).get().n]));
const delivery=s=>s.db.prepare('SELECT * FROM delivery_state ORDER BY message_id').all();
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const revoke=(sid,rev=1)=>({target_session_id:sid,expected_session_revision:rev,...reason});
const remove=(actor,rev=1)=>({actor,expected_registration_revision:rev,...reason});
function worker(f,action,gate){
 let ready,locked,started,done;const r=new Promise(x=>ready=x),l=new Promise(x=>locked=x),st=new Promise(x=>started=x),end=new Promise(x=>done=x);
 const child=fork(resolve('test/helpers/registration-worker.mjs'),[],{env:{...process.env,AB24_CONFIG:JSON.stringify({path:f.path,scope,...action,gate})},silent:true});let result;
 child.on('message',m=>{if(m.ready)ready();else if(m.locked)locked();else if(m.started)started();else result=m;});
 child.on('exit',code=>done(result??{exit:code}));
 return {r,l,st,end,go:()=>child.send('go')};
}
async function ordered(f,first,second){
 const gate=join(root,`gate-${seq++}`),a=worker(f,first,gate),b=worker(f,second);
 await Promise.all([a.r,b.r]);a.go();await a.l;b.go();await b.st;writeFileSync(gate,'go');return Promise.all([a.end,b.end]);
}

test('new target CLI, fixture-free registration/conversation and scoped operation; refuses existing target',()=>{
 const f=fresh(true);assert.equal(f.s.db.prepare('SELECT count(*) n FROM agents').get().n,0);assert.equal(counts(f.s).registered_sessions,0);
 const e=f.env(),r=f.s.register(regArgs(),e);assert.equal(r.registration_revision,1);assert.equal(r.replayed,false);assert.equal(r.session_active_now,true);
 assert.equal(f.s.capabilities().api_version,apiVersion);assert.equal(f.s.capabilities().schema,schemaVersion);assert.equal(f.s.capabilities().production_ready,false);
 assert.equal(f.s.db.prepare('SELECT api_version FROM bus_meta').get().api_version,apiVersion);
 assert.equal(f.s.db.prepare('SELECT role FROM agent_registrations').get().role,'techlead');
 const c=f.conv();assert.ok(c>0);assert.equal(f.s.db.prepare('SELECT count(*) n FROM messages').get().n,0);
 f.s.createTask({title:'new'},f.env());const before=hash(f.path);assert.throws(()=>initializeTarget(f.path,[scope]),/NEW_TARGET/);assert.equal(hash(f.path),before);
 assert.equal(statSync(f.path).mode&0o777,0o600);assert.equal(statSync(f.path+'.cursor-key.json').mode&0o777,0o600);f.s.close();
 const cli=spawnSync(process.execPath,['dist/v2/initialize.js',join(root,'cli.db'),JSON.stringify([scope])],{encoding:'utf8'});assert.equal(cli.status,0);assert.equal(JSON.parse(cli.stdout).ready,true);
});
test('registration CAS, role/provider consistency, replay before duplicate/revision; global Session identity',()=>{
 const f=fresh(true),e=f.env(),first=f.s.register(regArgs(),e),n=counts(f.s);
 assert.equal(f.s.register(regArgs(),e).replayed,true);assert.deepEqual(counts(f.s),n);
 assert.throws(()=>f.s.register(regArgs(1),e),/REQUEST_ID_REUSE/);
 assert.throws(()=>f.s.register(regArgs(1),f.env()),/ALREADY_REGISTERED/);
 assert.throws(()=>f.s.register(regArgs(0),f.env('a','a2')),/REVISION_CONFLICT/);
 assert.throws(()=>f.s.register(regArgs(1,'developer'),f.env('a','a2')),/METADATA_MISMATCH/);
 assert.equal(f.s.register(regArgs(1),f.env('a','a2')).registration_revision,2);
 const o=new Registration(f.path,other);assert.throws(()=>o.register(regArgs(),f.env()),/SESSION_SCOPE_MISMATCH/);o.close();
 assert.throws(()=>f.s.register(regArgs(),f.env('b','a1')),/SESSION_SCOPE_MISMATCH/);
 assert.equal(first.registration_generation,1);f.s.close();
});
test('registration rejects invalid identity, args, scope; Conversation dedup has its own receipt/event',()=>{
 const f=fresh();
 for(const bad of [null,'',' ']){assert.throws(()=>f.s.register({...regArgs(),role:bad},f.env('x','x1')),/INVALID/);assert.throws(()=>f.s.register(regArgs(),f.env('x',bad)),/INVALID/);assert.throws(()=>f.s.createConversation({thread_id:bad},f.env()),/INVALID/);}
 assert.throws(()=>f.s.register({...regArgs(),skip_ready:true},f.env('x','x1')),/INVALID/);
 assert.throws(()=>new Registration(f.path,{...scope,team:'*'}),/INVALID_SCOPE/);
 const e=f.env(),args={thread_id:'same'},c=f.s.createConversation(args,e),n=counts(f.s);
 assert.equal(f.s.createConversation(args,e).replayed,true);assert.deepEqual(counts(f.s),n);
 const again=f.s.createConversation(args,f.env());assert.equal(again.created,false);assert.equal(again.conversation_id,c.conversation_id);assert.equal(counts(f.s).communication_events,n.communication_events+1);
 const o=new Registration(f.path,other,{now:()=>10000}),oe=f.env('a','a-other');o.register(regArgs(),oe);assert.notEqual(o.createConversation(args,{...oe,request_id:randomUUID()}).conversation_id,c.conversation_id);o.close();
 assert.throws(()=>f.s.db.prepare('DELETE FROM conversations WHERE conversation_id=?').run(c.conversation_id),/IMMUTABLE/);f.s.close();
});
test('self revoke replay reports post-operation inactive; new actions fail and failed bootstrap cannot reopen identity',()=>{
 const f=fresh(),e=f.env(),a=revoke('a1'),n=counts(f.s);
 const out=f.s.revokeSession(a,e);assert.equal(out.session_active_now,false);assert.equal(out.replayed,false);
 assert.equal(f.s.revokeSession(a,e).replayed,true);assert.equal(counts(f.s).operation_receipts,n.operation_receipts+1);
 assert.throws(()=>f.s.createTask({title:'forbidden'},f.env()),/SESSION_REVOKED/);
 assert.throws(()=>f.s.revokeSession({...a,reason:'changed'},e),/REQUEST_ID_REUSE/);
 assert.throws(()=>f.s.register(regArgs(1),f.env()),/SESSION_REVOKED/);
 const b=f.s.register(regArgs(1),f.env('a','a2'));assert.equal(b.registration_revision,2);assert.equal(f.s.db.prepare("SELECT active FROM registered_sessions WHERE session_id='a1'").get().active,0);f.s.close();
});
test('claim and ack receipts lose secrets after revoke; Message lease and reply state remain unchanged',()=>{
 for(const method of ['claim','immediate','ack','transfer']){
  const f=fresh();const id=f.send();let args,e=f.env('b'),out;
  if(method==='claim')args={limit:1,lease_ms:1000};
  if(method==='immediate')args={limit:1};
  if(method==='ack'){const c=f.s.claim({limit:1,lease_ms:1000},f.env('b')).items[0];args={message_id:id,generation:c.generation,token:c.token};}
  if(method==='transfer'){f.s.immediate({limit:1},f.env('b'));args={message_id:id,new_session_id:'b1',expected_reply_generation:1,prior_holder_session:'b1',termination_evidence_ref:'artifact:end'};}
  out=f.s[method](args,e);const state=delivery(f.s),n=counts(f.s);f.s.revokeSession(revoke('b1'),f.env());
  assert.deepEqual(delivery(f.s),state);const replay=f.s[method](args,e);assert.equal(replay.replayed,true);assert.equal(replay.session_active_now,false);
  const item=replay.items[0];assert.equal(item.token,undefined);assert.equal(item.reply_token,undefined);assert.equal(item.lease_valid??item.authority_valid,false);
  assert.equal(counts(f.s).messages,n.messages);assert.throws(()=>f.s[method](args,f.env('b')),/SESSION_REVOKED/);f.s.close();
 }
});
test('Agent generation, same-name re-registration and explicit transfer never revive old authority',()=>{
 const f=fresh();const id=f.send(),e=f.env('b'),ack=f.s.immediate({limit:1},e).items[0],state=delivery(f.s);
 f.s.removeAgent(remove('b'),f.env());const r=f.s.register(regArgs(2,'developer','codex'),f.env('b','b2'));assert.equal(r.registration_generation,2);assert.equal(r.registration_revision,3);
 assert.deepEqual(delivery(f.s),state);assert.equal(f.s.immediate({limit:1},e).items[0].authority_valid,false);
 assert.throws(()=>f.s.reply({message_id:id,content:'bad',reply_generation:ack.reply_generation,reply_token:ack.reply_token},f.env('b','b2')),/STALE_REPLY_AUTH/);
 const auth=f.s.transfer({message_id:id,new_session_id:'b2',expected_reply_generation:1,prior_holder_session:'b1',termination_evidence_ref:'artifact:end'},f.env('b','b2')).items[0];
 f.s.reply({message_id:id,content:'answer',reply_generation:auth.reply_generation,reply_token:auth.reply_token},f.env('b','b2'));
 assert.equal(f.s.db.prepare('SELECT count(*) n FROM ask_answers').get().n,1);f.s.close();
});
test('inactive question sender rejects reply atomically, new Session permits same previously unsuccessful request',()=>{
 const f=fresh(),id=f.send(),auth=f.s.immediate({limit:1},f.env('b')).items[0];f.s.revokeSession(revoke('a1'),f.env('b'));
 const e=f.env('b'),args={message_id:id,content:'answer',reply_generation:auth.reply_generation,reply_token:auth.reply_token},before=counts(f.s),state=delivery(f.s);
 assert.throws(()=>f.s.reply(args,e),/RECIPIENT_SCOPE_MISMATCH/);assert.deepEqual(counts(f.s),before);assert.deepEqual(delivery(f.s),state);
 f.s.register(regArgs(1),f.env('a','a2'));const result=f.s.reply(args,e);f.s.revokeSession(revoke('a2'),f.env('b'));assert.equal(f.s.reply(args,e).reply_id,result.reply_id);f.s.close();
});
test('all Task states prevent remove while assigned; explicit release preserves Human/technical waiting',()=>{
 const f=fresh();
 for(const state of ['completed','canceled','blocked']){
  const t=f.s.createTask({title:'assigned'},f.env()).task_id;
  f.s.assignTask({task_id:t,expected_task_revision:0,to_agent:'b'},f.env());
  if(state==='canceled')f.s.cancelTask({task_id:t,expected_task_revision:1,reason:'end'},f.env());
  else f.s.updateTask({task_id:t,expected_task_revision:1,patch:state==='blocked'?{state,wait_kind:'technical',blocked_reason:'wait'}:{state}},f.env());
  assert.throws(()=>f.s.removeAgent(remove('b'),f.env()),/TASKS_REQUIRE_RELEASE/);
  f.s.releaseTask({task_id:t,expected_task_revision:2,mode:'preserve_state'},f.env());
  assert.equal(f.s.db.prepare('SELECT wait_kind FROM tasks WHERE id=?').get(t).wait_kind,state==='blocked'?'technical':'none');
 }
 f.s.removeAgent(remove('b'),f.env());const t=f.s.createTask({title:'unassigned'},f.env()).task_id;
 assert.throws(()=>f.s.assignTask({task_id:t,expected_task_revision:0,to_agent:'b'},f.env()),/RECIPIENT_SCOPE_MISMATCH/);f.s.close();
});
test('retire only closes registration, permits replay and existing operations, and explains all-revoked consequence',()=>{
 const f=fresh(true),e=f.env();f.s.register(regArgs(),e);const c=f.conv(),before=f.s.db.prepare('SELECT * FROM scopes').all();
 const r=f.s.retireTeam({expected_revision:1,...reason},f.env());assert.match(r.notice,/online registration cannot resume/);
 assert.equal(f.s.register(regArgs(),e).replayed,true);assert.throws(()=>f.s.register(regArgs(1),f.env('a','a2')),/REGISTRATION_RETIRED/);
 f.s.createTask({title:'still allowed'},f.env());f.s.revokeSession(revoke('a1'),f.env());assert.throws(()=>f.s.register(regArgs(1),f.env('a','a2')),/REGISTRATION_RETIRED/);
 assert.deepEqual(f.s.db.prepare('SELECT * FROM scopes').all(),before);assert.equal(f.s.db.prepare('SELECT conversation_id FROM conversations').get().conversation_id,c);f.s.close();
});
test('ready/read_only cannot be bypassed by bootstrap or successful receipt; preview has no updates',()=>{
 const f=fresh(),e=f.env(),args={thread_id:'saved'};f.s.createConversation(args,e);const h=hash(f.path);f.s.preview(f.env());assert.equal(hash(f.path),h);
 f.s.db.prepare('UPDATE bus_meta SET ready=0').run();
 assert.throws(()=>f.s.register(regArgs(),f.env('x','x1')),/MIGRATION_ISSUES_READ_ONLY/);assert.throws(()=>f.s.createConversation(args,e),/MIGRATION_ISSUES_READ_ONLY/);
 f.s.db.prepare("UPDATE bus_meta SET ready=1,recovery_state='recovery_read_only'").run();const before=hash(f.path);
 assert.throws(()=>f.s.register(regArgs(),f.env('x','x1')),/RECOVERY_READ_ONLY/);assert.throws(()=>f.s.createConversation(args,e),/RECOVERY_READ_ONLY/);assert.equal(hash(f.path),before);f.s.close();
});
test('registration/session invariants and observer errors do not expose input secrets',()=>{
 const f=fresh(),observer=new Observation(f.s.db,f.s.sid);observer.start();
 assert.throws(()=>f.s.register({...regArgs(),role:''},f.env('x','x1')),/INVALID_INPUT/);assert.equal(f.s.db.prepare('SELECT code FROM error_events ORDER BY event_id DESC').get().code,'INVALID_INPUT');
 f.s.revokeSession(revoke('a1'),f.env('b'));assert.throws(()=>f.s.createTask({title:'PRIVATE-TOKEN'},f.env()),/SESSION_REVOKED/);
 assert.equal(f.s.db.prepare('SELECT code FROM error_events ORDER BY event_id DESC').get().code,'SESSION_REVOKED');assert.ok(!JSON.stringify(f.s.db.prepare('SELECT * FROM error_events').all()).includes('PRIVATE-TOKEN'));
 assert.throws(()=>f.s.db.exec("UPDATE registered_sessions SET active=1 WHERE session_id='a1'"),/IMMUTABLE/);
 assert.throws(()=>f.s.db.exec("UPDATE agent_registrations SET provider='other'"),/IMMUTABLE/);
 assert.throws(()=>f.s.db.exec("DELETE FROM registered_sessions"),/IMMUTABLE/);observer.stop();f.s.close();
});

test('barrier registration same revision has exactly one winner; duplicate same request has one receipt',async()=>{
 for(const same of [false,true]){
  const f=fresh(true),e=f.env(),a={method:'register',args:regArgs(),envelope:e},b={...a,envelope:same?e:f.env('a','a2')};
  const results=await ordered(f,a,b);assert.equal(results[0].ok,true);assert.equal(results[1].ok,same);
  if(same)assert.equal(results[1].result.replayed,true);else assert.equal(results[1].code,'REVISION_CONFLICT');
  assert.equal(counts(f.s).registered_sessions,1);assert.equal(counts(f.s).operation_receipts,1);f.s.close();
 }
});
test('barrier revoke versus claim/ack/reply/transfer: both lock orders preserve historical success and reject new authority',async()=>{
 for(const method of ['claim','ack','reply','transfer'])for(const revokeFirst of [false,true]){
  const f=fresh(),id=f.send();let args;
  if(method==='claim')args={limit:1,lease_ms:1000};
  else if(method==='ack'){const c=f.s.claim({limit:1,lease_ms:1000},f.env('b')).items[0];args={message_id:id,generation:c.generation,token:c.token};}
  else{const c=f.s.immediate({limit:1},f.env('b')).items[0];args=method==='reply'?{message_id:id,reply_generation:c.reply_generation,reply_token:c.reply_token,content:'answer'}:{message_id:id,new_session_id:'b1',expected_reply_generation:1,prior_holder_session:'b1',termination_evidence_ref:'artifact:end'};}
  const op={method,args,envelope:f.env('b')},rev={method:'revokeSession',args:revoke('b1'),envelope:f.env()};
  const results=await ordered(f,...(revokeFirst?[rev,op]:[op,rev]));assert.equal(results[0].ok,true);assert.equal(results[1].ok,!revokeFirst);
  if(revokeFirst)assert.equal(results[1].code,'SESSION_REVOKED');else{const r=f.s[method](args,op.envelope);assert.equal(r.session_active_now,false);for(const item of r.items??[]){assert.equal(item.token,undefined);assert.equal(item.reply_token,undefined);}}
  f.s.close();
 }
});
test('barrier remove versus assignment and retire versus register both orders',async()=>{
 for(const removeFirst of [false,true]){
  const f=fresh(),t=f.s.createTask({title:'work'},f.env()).task_id;
  const rem={method:'removeAgent',args:remove('b'),envelope:f.env()},assign={method:'assignTask',args:{task_id:t,expected_task_revision:0,to_agent:'b'},envelope:f.env()};
  const r=await ordered(f,...(removeFirst?[rem,assign]:[assign,rem]));assert.equal(r[0].ok,true);assert.equal(r[1].ok,false);assert.equal(r[1].code,removeFirst?'RECIPIENT_SCOPE_MISMATCH':'TASKS_REQUIRE_RELEASE');f.s.close();
 }
 for(const retireFirst of [false,true]){
  const f=fresh(),ret={method:'retireTeam',args:{expected_revision:1,...reason},envelope:f.env()},reg={method:'register',args:regArgs(1),envelope:f.env('a','a2')};
  const r=await ordered(f,...(retireFirst?[ret,reg]:[reg,ret]));assert.equal(r[0].ok,true);assert.equal(r[1].ok,!retireFirst);if(retireFirst)assert.equal(r[1].code,'REGISTRATION_RETIRED');f.s.close();
 }
});
test('process exit before/after commit: bootstrap/conversation/revoke atomic and same-request recovery',async()=>{
 for(const method of ['register','createConversation','revokeSession'])for(const exitAt of ['before_commit','after_commit']){
  const f=fresh(method==='register'),args=method==='register'?regArgs():method==='createConversation'?{thread_id:'fault'}:revoke('a1'),e=f.env(),before=counts(f.s);
  const w=worker(f,{method,args,envelope:e,exitAt});await w.r;w.go();assert.equal((await w.end).exit,71);
  const post=counts(f.s);assert.equal(post.operation_receipts-before.operation_receipts,exitAt==='before_commit'?0:1);
  if(exitAt==='before_commit')assert.deepEqual(post,before);
  const out=f.s[method](args,e);assert.equal(out.replayed,exitAt==='after_commit');const once=counts(f.s);assert.equal(f.s[method](args,e).replayed,true);assert.deepEqual(counts(f.s),once);f.s.close();
 }
});
test('migration duplicate Session IDs preserves original records and issues, does not rename or activate either',async()=>{
 const source=join(root,'duplicate-source.db'),target=join(root,'duplicate-target.db'),db=new Database(source);initializeLegacySchema(db);
 for(const name of ['a','b'])db.prepare("INSERT INTO agents(name,registered_at,last_seen,project,session_id) VALUES(?,1,1,'p','same')").run(name);db.close();const before=hash(source);
 await assert.rejects(()=>migrateStoppedCopy(source,target,true),/MIGRATION_FINAL_AUDIT_FAILED/);assert.equal(hash(source),before);assert.equal(existsSync(target),false);const failure=readdirSync(root).find(x=>x.startsWith('duplicate-target.db.failed-')&&x.endsWith('.failure.json'));assert.ok(failure);const manifest=JSON.parse(readFileSync(join(root,failure),'utf8'));assert.equal(manifest.quarantine_path,`${target}.failed-${manifest.run_id}`);assert.equal(existsSync(manifest.quarantine_path),true);assert.equal(existsSync(target+'.migration.json'),false);const failed=new Database(manifest.quarantine_path,{readonly:true});assert.equal(failed.prepare("SELECT count(*) n FROM migration_issues WHERE code='SESSION_ID_CONFLICT'").get().n,2);assert.deepEqual(failed.prepare("SELECT session_id FROM agents ORDER BY name").all(),[{session_id:'same'},{session_id:'same'}]);assert.equal(failed.prepare('SELECT count(*) n FROM registered_sessions').get().n,0);assert.equal(failed.prepare('SELECT count(*) n FROM migration_manifests').get().n,0);assert.equal(failed.prepare('SELECT count(*) n FROM operation_receipts').get().n,0);failed.close();
});

test('status and self remove return current inactivity without changing historical metadata',()=>{
 const f=fresh(),status=f.s.setAgentStatus({actor:'a',expected_registration_revision:1,status:'sleeping'},f.env());assert.equal(status.registration_revision,2);assert.equal(status.os_liveness,'not_observed');
 const row=f.s.db.prepare("SELECT * FROM agent_registrations WHERE actor='a'").get();assert.equal(row.status,'sleeping');assert.equal(row.updated_at,10000);
 const e=f.env(),args=remove('a',2),out=f.s.removeAgent(args,e);assert.equal(out.session_active_now,false);assert.equal(f.s.removeAgent(args,e).replayed,true);
 f.s.register(regArgs(3,'developer','claude'),f.env('a','a2'));const rows=f.s.db.prepare("SELECT * FROM agent_registrations WHERE actor='a' ORDER BY generation").all();
 assert.equal(rows[0].provider,'codex');assert.equal(rows[0].active,0);assert.equal(rows[1].provider,'claude');assert.equal(rows[1].revision,4);
 assert.equal(f.s.removeAgent(args,e).session_active_now,false);f.s.close();
});
test('barrier same-thread Conversation creation records one object and two distinct successful requests',async()=>{
 const f=fresh(),a={method:'createConversation',args:{thread_id:'parallel'},envelope:f.env()},b={...a,envelope:f.env()};
 const r=await ordered(f,a,b);assert.equal(r[0].ok,true);assert.equal(r[1].ok,true);assert.equal(r[0].result.created,true);assert.equal(r[1].result.created,false);assert.equal(r[0].result.conversation_id,r[1].result.conversation_id);assert.equal(counts(f.s).conversations,1);f.s.close();
});
test('registration event/receipt failure rolls back all registration and legacy name-anchor effects',()=>{
 for(const table of ['communication_events','operation_receipts']){
  const f=fresh(true),before=counts(f.s);f.s.db.exec(`CREATE TRIGGER injected BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'INJECTED_WRITE'); END;`);
  assert.throws(()=>f.s.register(regArgs(),f.env()),/INJECTED_WRITE/);assert.deepEqual(counts(f.s),before);f.s.close();
 }
});
