import {Registration} from '../dist/v2/registration.js';
import {historicalResult} from './helpers/receipt-result.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {initializeLegacySchema} from '../dist/db.js';
import {migrateStoppedCopy} from './helpers/synthetic-migration.mjs';
import {Delivery} from '../dist/v2/delivery.js';
const scope={project:'p',area:null,team:null},root=mkdtempSync(join(tmpdir(),'ab22-'));
const same=(a,b)=>assert.equal(createHash('sha256').update(JSON.stringify(historicalResult(a))).digest('hex'),createHash('sha256').update(JSON.stringify(historicalResult(b))).digest('hex'));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
let sequence=0;
async function fixture(legacy=false) {
 const source=join(root,`${sequence++}-source.db`),path=source.replace('source','target');
 const db=new Database(source);initializeLegacySchema(db);
 for(const a of ['a','b'])db.prepare('INSERT INTO agents(name,registered_at,last_seen,project,session_id) VALUES(?,1,1,?,?)').run(a,'p',a+'1');
 db.prepare("INSERT INTO tasks(id,title,thread_id,requested_by,state,created_at,updated_at,project) VALUES(1,'work','thread','a','open',1,1,'p')").run();
 db.prepare("INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project,delivered_at) VALUES('a','b',?,'fixture',?,1,'thread','p',?)").run(legacy?'ask':'msg',legacy?'delivered':'delivered',1);
 db.close();const before=hash(source),m=await migrateStoppedCopy(source,path,true);assert.equal(m.ready,true);assert.equal(hash(source),before);
 let now=10000;const d=new Delivery(path,scope,{now:()=>now});
 const reg=new Registration(path,scope,{now:()=>10000});
 for(const [session_id,revision] of [['b2',1],['b3',2]])reg.register({role:'legacy-unspecified',provider:'legacy-unspecified',expected_registration_revision:revision},{origin_instance_uuid:reg.capabilities().instance_uuid,actor:'b',session_id,request_id:randomUUID()});reg.close();
 const env=(actor='b',session_id=actor+'1',request_id=randomUUID())=>({origin_instance_uuid:d.capabilities().instance_uuid,actor,session_id,request_id});
 const send=(ask=false)=>d[ask?'ask':'send']({to:'b',content:'new body',conversation_id:1,task_id:1},env('a')).message_id;
 return {path,source,d,env,send,setNow:t=>now=t};
}
function claim(f){return f.d.claim({limit:1,lease_ms:1000},f.env()).items[0];}
const ackArgs=x=>({message_id:x.message_id,generation:x.generation,token:x.token});
const replyArgs=x=>({message_id:x.message_id,reply_generation:x.reply_generation,reply_token:x.reply_token,content:'answer'});
const transferArgs=(id,g=1,holder='b1',target='b2')=>({message_id:id,new_session_id:target,expected_reply_generation:g,prior_holder_session:holder,termination_evidence_ref:'checkpoint:predecessor-ended'});
function counts(d){return Object.fromEntries(['messages','message_bindings','operation_receipts','communication_events','ask_answers'].map(t=>[t,d.db.prepare(`SELECT count(*) n FROM ${t}`).get().n]));}
function worker(config,onPoint=()=>{}) {
 let readyResolve,endResolve;const ready=new Promise(r=>readyResolve=r),ended=new Promise(r=>endResolve=r);
 const child=fork(resolve('test/helpers/delivery-worker.mjs'),[],{env:{...process.env,TEST_DELIVERY_CONFIG:JSON.stringify({scope,now:10000,...config})},silent:true});
 let result,stderr='';child.stderr.on('data',v=>stderr+=v);
 child.on('message',m=>{if(m.ready)readyResolve();else if(m.point)onPoint(m.point);else result=m;});
 child.on('exit',code=>{readyResolve();endResolve(result??{exit:code,stderr});});
 return {ready,ended,go:()=>child.send('go')};
}
async function race(f,actions){const jobs=actions.map(a=>worker({path:f.path,...a}));await Promise.all(jobs.map(j=>j.ready));jobs.forEach(j=>j.go());return Promise.all(jobs.map(j=>j.ended));}

test('send/ask atomically bind scope, relation, event and idempotent receipt; bypass rejected',async()=>{
 const f=await fixture(),{d}=f;const e=f.env('a');const args={to:'b',content:'question',conversation_id:1,task_id:1};
 const q=d.ask(args,e);const saved=counts(d);same(d.ask(args,e),q);same(counts(d),saved);
 assert.throws(()=>d.send(args,e),/REQUEST_ID_REUSE/);
 assert.throws(()=>d.send({...args,reply_to:q.message_id},f.env('a')),/ASK_REPLY_REQUIRES_AUTHORITY/);
 assert.throws(()=>d.send({...args,task_id:999},f.env('a')),/TASK_SCOPE/);
 assert.throws(()=>d.send({...args,to:'missing'},f.env('a')),/RECIPIENT_SCOPE/);
 const c=Number(d.db.prepare('INSERT INTO conversations(scope_id,thread_id) VALUES(?,?)').run(d.sid,'second').lastInsertRowid);
 d.send({...args,conversation_id:c},f.env('a'));
 assert.equal(d.listLinks(1).items.length,2);
 const ev=d.db.prepare("SELECT * FROM communication_events WHERE message_id=? AND operation='ask'").get(q.message_id);
 same(JSON.parse(ev.task_ids),[1]);assert.equal(ev.task_binding,'assigned');assert.equal(ev.from_agent,'a');assert.equal(ev.to_agent,'b');assert.equal(ev.purpose,'ask');assert.equal(ev.status,'pending');
 assert.equal(statSync(f.path).mode&0o777,0o600);d.close();
});
test('barrier: four processes claim/claim/immediate/immediate commit a single acquisition; preview is read-only',async()=>{
 const f=await fixture();f.send(true);const before=hash(f.path);f.d.preview(f.env());assert.equal(hash(f.path),before);
 const results=await race(f,['claim','claim','immediate','immediate'].map((method,i)=>({method,args:method==='claim'?{limit:1,lease_ms:1000}:{limit:1},envelope:f.env('b',i%2?'b2':'b1')})));
 assert.ok(results.every(r=>r.ok),JSON.stringify(results.map(r=>r.code)));assert.equal(results.reduce((n,r)=>n+r.result.items.length,0),1);f.d.close();
});
test('lease boundaries, stale generation/session/scope/null token and clock changes',async()=>{
 const f=await fixture();const id=f.send();const x=claim(f);
 assert.throws(()=>f.d.ack({...ackArgs(x),token:null},f.env()),/TOKEN_REQUIRED/);
 assert.throws(()=>f.d.ack(ackArgs(x),f.env('b','b2')),/SESSION_MISMATCH/);
 assert.throws(()=>f.d.ack(ackArgs(x),f.env('a')),/RECIPIENT_MISMATCH/);
 assert.throws(()=>f.d.ack(ackArgs(x),f.env('b','unregistered')),/SESSION_SCOPE/);
 f.d.db.prepare('INSERT INTO scopes(scope_key,project) VALUES(?,?)').run(JSON.stringify(['other',null,null]),'other');
 const other=new Delivery(f.path,{project:'other',area:null,team:null},{now:()=>10000});
 assert.throws(()=>other.ack(ackArgs(x),f.env()),/SESSION_SCOPE/);
 const regOther=new Registration(f.path,{project:'other',area:null,team:null},{now:()=>10000});
 const otherEnv=f.env('b','b-other');regOther.register({role:'test',provider:'test',expected_registration_revision:0},otherEnv);regOther.close();
 assert.throws(()=>other.ack(ackArgs(x),{...otherEnv,request_id:randomUUID()}),/MESSAGE_NOT_FOUND/);other.close();
 f.setNow(10999);assert.equal(f.d.claim({limit:1,lease_ms:1000},f.env('b','b2')).items.length,0);
 f.setNow(11000);assert.throws(()=>f.d.ack(ackArgs(x),f.env()),/LEASE_EXPIRED/);
 const y=claim(f);assert.equal(y.generation,2);assert.throws(()=>f.d.ack(ackArgs(x),f.env()),/STALE_CLAIM/);
 f.setNow(10900);const ack=f.d.ack(ackArgs(y),f.env());assert.equal(ack.clock_regressed,true);assert.equal(f.d.db.prepare('SELECT status FROM messages WHERE id=?').get(id).status,'delivered');
 f.send();const z=claim(f);f.setNow(999999);assert.throws(()=>f.d.ack(ackArgs(z),f.env()),/LEASE_EXPIRED/);f.d.close();
});
test('pending answer is atomic; delivered answer uses independent authority; replays never revive transferred authority',async()=>{
 const f=await fixture();const q=f.send(true),c=claim(f),re=f.env();const a={message_id:q,generation:c.generation,token:c.token,content:'answer'};
 const r=f.d.reply(a,re),n=counts(f.d);same(f.d.reply(a,re),r);same(counts(f.d),n);
 assert.throws(()=>f.d.reply(a,f.env()),/ALREADY_ANSWERED/);
 const q2=f.send(true),c2=claim(f),ae=f.env(),ack=f.d.ack(ackArgs(c2),ae).items[0];
 const te=f.env('b','b2'),t=f.d.transfer(transferArgs(q2),te).items[0];
 const old=f.d.ack(ackArgs(c2),ae).items[0];assert.equal(old.authority_valid,false);assert.equal(old.reply_token,undefined);
 assert.throws(()=>f.d.reply(replyArgs(ack),f.env()),/STALE_REPLY_AUTH/);
 same(f.d.transfer(transferArgs(q2),te).items[0],t);
 f.d.reply(replyArgs(t),f.env('b','b2'));const done=f.d.transfer(transferArgs(q2),te).items[0];assert.equal(done.authority_valid,false);assert.equal(done.reply_token,undefined);
 const receipts=f.d.db.prepare('SELECT result_json FROM operation_receipts').all();assert.ok(receipts.every(r=>!r.result_json.includes(c.token)&&!r.result_json.includes(ack.reply_token)));
 assert.equal(f.d.db.prepare('SELECT count(*) n FROM ask_answers').get().n,2);f.d.close();
});
test('legacy delivered ask requires explicit evidence transfer and retains original Q timestamps',async()=>{
 const f=await fixture(true),before=f.d.db.prepare('SELECT * FROM messages WHERE id=1').get();
 assert.throws(()=>f.d.reply({message_id:1,content:'no authority'},f.env()),/STALE_REPLY_AUTH/);
 assert.throws(()=>f.d.transfer({...transferArgs(1,0,null),termination_evidence_ref:''},f.env('b','b2')),/INVALID_INPUT/);
 const t=f.d.transfer(transferArgs(1,0,null),f.env('b','b2')).items[0];assert.equal(t.reply_generation,1);
 const after=f.d.db.prepare('SELECT * FROM messages WHERE id=1').get();same(after,before);
 f.d.reply(replyArgs(t),f.env('b','b2'));assert.throws(()=>f.d.transfer(transferArgs(1,1,'b2','b3'),f.env('b','b3')),/ALREADY_ANSWERED/);f.d.close();
});
test('barrier: transfer/transfer and transfer/reply preserve one current authority or one answer',async()=>{
 for(const competing of ['transfer','reply']) {
  const f=await fixture();const q=f.send(true);const c=claim(f);const a=f.d.ack(ackArgs(c),f.env()).items[0];
  const actions=[{method:'transfer',args:transferArgs(q),envelope:f.env('b','b2')},competing==='transfer'?{method:'transfer',args:transferArgs(q,1,'b1','b3'),envelope:f.env('b','b3')}:{method:'reply',args:replyArgs(a),envelope:f.env()}];
  const result=await race(f,actions);assert.equal(result.filter(x=>x.ok).length,1);assert.ok(result.some(x=>['STALE_REPLY_AUTH','ALREADY_ANSWERED'].includes(x.code)));f.d.close();
 }
});
test('barrier: ack versus pending reply, and simultaneous replies, create at most one answer',async()=>{
 for(const kind of ['ack','reply']) {
  const f=await fixture(),q=f.send(true),c=claim(f);const args={...ackArgs(c),content:'answer'};
  const result=await race(f,[{method:kind,args:kind==='ack'?ackArgs(c):args,envelope:f.env()},{method:'reply',args,envelope:f.env()}]);
  assert.equal(result.filter(x=>x.ok).length,1);assert.ok(f.d.db.prepare('SELECT count(*) n FROM ask_answers WHERE ask_id=?').get(q).n<=1);f.d.close();
 }
});
test('claim retry is same allocation only; registration/Task changes do not release lease; old origin rejected',async()=>{
 const f=await fixture();f.send();const e=f.env(),args={limit:1,lease_ms:1000},r=f.d.claim(args,e),x=r.items[0];
 f.d.db.prepare("UPDATE agents SET session_id='b2' WHERE name='b'").run();f.d.db.prepare("UPDATE tasks SET claimed_by='b' WHERE id=1").run();
 assert.equal(f.d.claim(args,f.env('b','b2')).items.length,0);same(f.d.claim(args,e),r);
 f.setNow(11000);claim(f);const old=f.d.claim(args,e);assert.equal(old.items[0].lease_valid,false);assert.equal(old.items[0].token,undefined);
 assert.throws(()=>f.d.claim(args,{...f.env(),origin_instance_uuid:'old'}),/RECOVERY_OUTCOME_UNKNOWN/);
 assert.throws(()=>f.d.claim(args,{...e,session_id:'b2'}),/REQUEST_ID_REUSE/);
 assert.equal(x.generation,1);f.d.close();
});
test('OS process exit before/after COMMIT: send/claim/ack/reply retry converges with original IDs and counts',async()=>{
 for(const method of ['send','claim','ack','reply'])for(const exitAt of ['before_commit','after_commit']) {
  const f=await fixture();let args,e=f.env();
  if(method==='send'){e=f.env('a');args={to:'b',content:'crash test',conversation_id:1,task_id:1};}
  else {const q=f.send(method==='reply'||method==='ack');if(method==='claim')args={limit:1,lease_ms:1000};else {const c=claim(f);args=method==='ack'?ackArgs(c):{...ackArgs(c),content:'answer'};}}
  const pre=counts(f.d);const w=worker({path:f.path,method,args,envelope:e,exitAt});await w.ready;w.go();assert.equal((await w.ended).exit,71);
  const post=counts(f.d);if(exitAt==='before_commit')same(post,pre);assert.equal(post.operation_receipts-pre.operation_receipts,exitAt==='after_commit'?1:0);
  const result=f.d[method](args,e),once=counts(f.d);if(exitAt==='after_commit')same(once,post);same(f.d[method](args,e),result);same(counts(f.d),once);
  assert.equal(once.operation_receipts-pre.operation_receipts,1);assert.equal(once.messages-pre.messages,['send','reply'].includes(method)?1:0);
  if(method==='ack')assert.ok(f.d.reply(replyArgs(result.items[0]),f.env()).reply_id);f.d.close();
 }
});
test('BUSY is bounded, injected IO before/after commit remains uncertain until same request retry',async()=>{
 const f=await fixture();const busy=new Delivery(f.path,scope,{now:()=>10000});busy.db.pragma('busy_timeout=1');let attempts=0;
 const blocked=new Delivery(f.path,scope,{now:()=>10000,fault:p=>{if(p==='locked')attempts++;}});blocked.db.pragma('busy_timeout=1');
 f.d.db.exec('BEGIN IMMEDIATE');try{assert.throws(()=>blocked.claim({limit:1,lease_ms:1000},f.env()),/locked/);assert.equal(attempts,0);}finally{f.d.db.exec('ROLLBACK');blocked.close();busy.close();}
 let retries=0;const bounded=new Delivery(f.path,scope,{fault:p=>{if(p==='locked'){retries++;throw Object.assign(new Error('busy injected'),{code:'SQLITE_BUSY'});}}});
 assert.throws(()=>bounded.claim({limit:1,lease_ms:1000},f.env()),/busy injected/);assert.equal(retries,3);bounded.close();
 for(const point of ['before_commit','after_commit']) {
  const e=f.env('a'),args={to:'b',content:'io',conversation_id:1,task_id:1},pre=counts(f.d);
  const d=new Delivery(f.path,scope,{now:()=>10000,fault:p=>{if(p===point)throw Object.assign(new Error('IO injected'),{code:'SQLITE_IOERR'});}});
  assert.throws(()=>d.send(args,e),/IO injected/);d.close();assert.equal(counts(f.d).operation_receipts-pre.operation_receipts,point==='after_commit'?1:0);
  const r=f.d.send(args,e);same(f.d.send(args,e),r);assert.equal(counts(f.d).messages-pre.messages,1);
 }f.d.close();
});
test('clock sampled after IMMEDIATE lock and decision can precede delayed COMMIT past expiry',async()=>{
 const f=await fixture();f.send();const c=claim(f),file=join(root,'clock-'+sequence);writeFileSync(file,'10999');
 f.d.db.exec('BEGIN IMMEDIATE');const w=worker({path:f.path,method:'ack',args:ackArgs(c),envelope:f.env(),clockFile:file});await w.ready;w.go();
 await new Promise(r=>setTimeout(r,100));writeFileSync(file,'11000');f.d.db.exec('ROLLBACK');assert.equal((await w.ended).code,'LEASE_EXPIRED');
 f.setNow(11000);const fresh=claim(f);writeFileSync(file,'11999');
 const reader=new Database(f.path);reader.exec('BEGIN');reader.prepare('SELECT * FROM messages').all();
 const delayed=worker({path:f.path,method:'ack',args:ackArgs(fresh),envelope:f.env(),clockFile:file,notifyCommit:true},()=>{
  writeFileSync(file,'13000');setTimeout(()=>reader.exec('ROLLBACK'),100);
 });await delayed.ready;delayed.go();assert.equal((await delayed.ended).ok,true);reader.close();f.d.close();
});
test('zero update returns no claim; event failure rolls back message/relation/receipt; related writers share envelope rules',async()=>{
 const f=await fixture(),q=f.send();
 f.d.db.exec("CREATE TRIGGER ignore_claim BEFORE UPDATE ON delivery_state BEGIN SELECT RAISE(IGNORE); END");
 assert.equal(claim(f),undefined);assert.equal(f.d.db.prepare('SELECT generation FROM delivery_state WHERE message_id=?').get(q).generation,0);
 f.d.db.exec('DROP TRIGGER ignore_claim');
 const cid=Number(f.d.db.prepare('INSERT INTO conversations(scope_id,thread_id) VALUES(?,?)').run(f.d.sid,'atomic-event').lastInsertRowid);
 const before=counts(f.d),revision=f.d.db.prepare('SELECT relation_revision FROM bus_meta').get().relation_revision;
 f.d.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON communication_events BEGIN SELECT RAISE(ABORT,'EVENT_UNAVAILABLE'); END");
 assert.throws(()=>f.d.send({to:'b',content:'must rollback',conversation_id:cid,task_id:1},f.env('a')),/EVENT_UNAVAILABLE/);
 same(counts(f.d),before);assert.equal(f.d.db.prepare('SELECT relation_revision FROM bus_meta').get().relation_revision,revision);
 f.d.db.exec('DROP TRIGGER fail_event');
 const e=f.env('a'),r=f.d.link(1,cid,revision,e);same(f.d.link(1,cid,revision,e),r);
 assert.throws(()=>f.d.correct(r.link_version_id,'remove','reason',r.revision,e),/REQUEST_ID_REUSE/);
 assert.throws(()=>f.d.link(1,cid,revision,{...f.env('a'),session_id:''}),/INVALID_ENVELOPE/);
 assert.equal(f.d.db.prepare("SELECT count(*) n FROM communication_events WHERE operation='link_conversation' AND request_id=?").get(e.request_id).n,1);
 f.d.db.prepare("UPDATE bus_meta SET recovery_state='read_only'").run();
 assert.throws(()=>f.d.claim({limit:1,lease_ms:1000},f.env()),/RECOVERY_READ_ONLY/);f.d.close();
});
test('immediate ask replay and multiple explicit transfers never resurrect old reply tokens',async()=>{
 const f=await fixture(),id=f.send(true),e=f.env();
 const r=f.d.immediate({limit:1},e);assert.equal(r.items[0].reply_generation,1);assert.equal(r.items[0].authority_valid,true);
 const n=counts(f.d);same(f.d.immediate({limit:1},e),r);same(counts(f.d),n);
 const e2=f.env('b','b2'),a2=f.d.transfer(transferArgs(id),e2);
 const a3=f.d.transfer(transferArgs(id,2,'b2','b3'),f.env('b','b3'));
 const stale=f.d.transfer(transferArgs(id),e2);assert.equal(stale.items[0].authority_valid,false);assert.equal(stale.items[0].reply_token,undefined);
 const old=f.d.immediate({limit:1},e);assert.equal(old.items[0].authority_valid,false);assert.equal(old.items[0].reply_token,undefined);
 assert.throws(()=>f.d.reply(replyArgs(a2.items[0]),f.env('b','b2')),/STALE_REPLY_AUTH/);
 f.d.reply(replyArgs(a3.items[0]),f.env('b','b3'));
 const token=r.items[0].reply_token;
 assert.ok(!JSON.stringify(f.d.db.prepare('SELECT * FROM communication_events').all()).includes(token));f.d.close();
});
test('legacy inconsistent answer closure remains read-only and blocks authority transfer',async()=>{
 const f=await fixture(true);f.d.close();
 const old=new Database(f.source);old.prepare('UPDATE messages SET replied_at=3 WHERE id=1').run();old.close();
 const target=f.path+'-inconsistent',before=hash(f.source);await assert.rejects(()=>migrateStoppedCopy(f.source,target,true),/MIGRATION_FINAL_AUDIT_FAILED/);assert.equal(hash(f.source),before);assert.equal(existsSync(target),false);const failure=readdirSync(root).find(x=>x.startsWith(target.split('/').pop()+'.failed-')&&x.endsWith('.failure.json'));assert.ok(failure);const manifest=JSON.parse(readFileSync(join(root,failure),'utf8'));assert.equal(manifest.quarantine_path,`${target}.failed-${manifest.run_id}`);assert.equal(existsSync(manifest.quarantine_path),true);assert.equal(existsSync(target+'.migration.json'),false);const failed=new Database(manifest.quarantine_path,{readonly:true});assert.ok(failed.prepare("SELECT count(*) n FROM migration_issues WHERE code='ANSWER_STATE_MISMATCH'").get().n>0);assert.equal(failed.prepare('SELECT count(*) n FROM migration_manifests').get().n,0);assert.equal(failed.prepare('SELECT count(*) n FROM operation_receipts').get().n,0);failed.close();
});
function task(f,id) {
 f.d.db.prepare("INSERT INTO tasks(id,title,thread_id,requested_by,state,created_at,updated_at,project,scope_id) VALUES(?,? ,?,'a','open',1,1,'p',?)").run(id,'task-'+id,'task-thread-'+id,f.d.sid);
}
function revision(f){return f.d.db.prepare('SELECT relation_revision FROM bus_meta').get().relation_revision;}
function removeLink(f,tid=1){const v=f.d.listLinks(tid).items[0];f.d.correct(v.link_version_id,'remove','corrected',revision(f),f.env('a'));}
function events(f,id){return f.d.db.prepare('SELECT * FROM communication_events WHERE message_id=? ORDER BY event_id').all(id);}
function membership(f,id){return f.d.db.prepare('SELECT * FROM message_bindings WHERE message_id=?').get(id);}
test('P01 explicit Task/null snapshots survive multiple links, removal, replacement and claim/ack/immediate',async()=>{
 const f=await fixture();f.setNow(9000000000000);task(f,2);task(f,3);f.d.link(2,1,revision(f),f.env('a'));
 const ids=[1,2,null].map(task_id=>f.d.send({to:'b',content:'fixed membership',conversation_id:1,task_id},f.env('a')).message_id);
 const first=ids.map(id=>events(f,id)[0]);same(first.map(e=>JSON.parse(e.task_ids)),[[1],[2],[]]);assert.equal(first[2].task_binding,'unassigned');
 removeLink(f);const old=f.d.listLinks(2).items[0];f.d.replace(old.link_version_id,3,1,'different Task',revision(f),f.env('a'));
 const ce=f.env(),args={limit:1,lease_ms:1000},c=f.d.claim(args,ce).items[0];const ae=f.env();f.d.ack(ackArgs(c),ae);
 const before=counts(f.d);f.d.claim(args,ce);f.d.ack(ackArgs(c),ae);same(counts(f.d),before);
 f.d.immediate({limit:10},f.env());
 for(let i=0;i<ids.length;i++) {
  const es=events(f,ids[i]);same(es[0],first[i]);for(const e of es){assert.equal(e.task_ids,first[i].task_ids);assert.equal(e.task_binding,first[i].task_binding);assert.equal(JSON.parse(e.details_json).binding_coverage,'creation_recorded');}
 }
 assert.throws(()=>f.d.db.prepare("UPDATE message_bindings SET task_ids='[]' WHERE message_id=?").run(ids[0]),/IMMUTABLE_MESSAGE_BINDING/);
 assert.throws(()=>f.d.db.prepare('DELETE FROM message_bindings WHERE message_id=?').run(ids[0]),/IMMUTABLE_MESSAGE_BINDING/);
 assert.throws(()=>f.d.db.prepare("INSERT OR REPLACE INTO message_bindings SELECT * FROM message_bindings WHERE message_id=?").run(ids[0]),/IMMUTABLE_MESSAGE_BINDING/);
 assert.throws(()=>f.d.db.prepare("UPDATE communication_events SET task_ids='[]' WHERE event_id=?").run(first[0].event_id),/IMMUTABLE_EVENT/);f.d.close();
});
test('P01 pending/delivered Reply inherits ask snapshot across corrections and explicit transfer',async()=>{
 for(const delivered of [false,true]) {
  const f=await fixture();f.setNow(9000000000000);const id=f.send(true),original=membership(f,id),c=claim(f);
  const auth=delivered?f.d.ack(ackArgs(c),f.env()).items[0]:c;
  removeLink(f);task(f,2);f.d.link(2,1,revision(f),f.env('a'));
  const current=delivered?f.d.transfer(transferArgs(id),f.env('b','b2')).items[0]:auth;
  const args=delivered?replyArgs(current):{...ackArgs(current),content:'answer'},e=delivered?f.env('b','b2'):f.env();
  const r=f.d.reply(args,e),n=counts(f.d);f.d.reply(args,e);same(counts(f.d),n);
  const reply=membership(f,r.reply_id);assert.equal(reply.task_ids,original.task_ids);assert.equal(reply.task_binding,original.task_binding);assert.equal(reply.basis,'reply_inherited');assert.equal(JSON.parse(reply.evidence_json).ask_id,id);
  for(const m of [id,r.reply_id])for(const ev of events(f,m))same(JSON.parse(ev.task_ids),[1]);f.d.close();
 }
});
test('P01 migration without send event records unknown historical coverage and separate immutable candidates',async()=>{
 const f=await fixture(true);f.setNow(9000000000000);const b=membership(f,1);
 assert.equal(events(f,1).length,0);same(JSON.parse(b.task_ids),[]);assert.equal(b.task_binding,'unknown');assert.equal(b.coverage,'historical_unobserved');
 same(JSON.parse(b.evidence_json).migration_links.map(x=>x.task_id),[1]);removeLink(f);same(membership(f,1),b);
 const a=f.d.transfer(transferArgs(1,0,null),f.env('b','b2')).items[0],r=f.d.reply(replyArgs(a),f.env('b','b2'));
 for(const id of [1,r.reply_id])for(const ev of events(f,id)){assert.equal(ev.task_binding,'unknown');same(JSON.parse(ev.task_ids),[]);assert.equal(JSON.parse(ev.details_json).binding_coverage,'historical_unobserved');}
 const empty=f.d.send({to:'b',content:'explicit null',conversation_id:1,task_id:null},f.env('a')).message_id;
 assert.equal(membership(f,empty).task_binding,'unassigned');f.d.close();
});
test('P01 binding/event write failures roll back Message, snapshot, relation and receipt together',async()=>{
 const f=await fixture();f.setNow(9000000000000);
 const cid=Number(f.d.db.prepare('INSERT INTO conversations(scope_id,thread_id) VALUES(?,?)').run(f.d.sid,'membership-rollback').lastInsertRowid);
 for(const table of ['message_bindings','communication_events']) {
  const n=counts(f.d),v=revision(f);f.d.db.exec(`CREATE TRIGGER fail_snapshot BEFORE INSERT ON ${table} ${table==='communication_events'?'WHEN NEW.message_id IS NOT NULL':''} BEGIN SELECT RAISE(ABORT,'BINDING_SAVE_FAILED'); END`);
  assert.throws(()=>f.d.send({to:'b',content:'rollback',conversation_id:cid,task_id:1},f.env('a')),/BINDING_SAVE_FAILED/);
  same(counts(f.d),n);assert.equal(revision(f),v);f.d.db.exec('DROP TRIGGER fail_snapshot');
 }
 f.d.close();
});
test('P02 expired claim receipt stays invalid after backward clock and OS process restart',async()=>{
 const f=await fixture();f.send();const e=f.env(),args={limit:1,lease_ms:1000},first=f.d.claim(args,e);f.setNow(10999);
 assert.equal(f.d.claim(args,e).items[0].token,first.items[0].token);
 f.setNow(11000);const expired=f.d.claim(args,e).items[0];assert.equal(expired.lease_valid,false);assert.equal(expired.token,undefined);
 assert.equal(f.d.db.prepare('SELECT lease_clock_ms FROM bus_meta').get().lease_clock_ms,11000);
 f.setNow(10001);const old=f.d.claim(args,e).items[0];assert.equal(old.lease_valid,false);assert.equal(old.token,undefined);
 const ae=f.env();f.d.close();const w=worker({path:f.path,method:'claim',args,envelope:e,now:10001});await w.ready;w.go();const r=await w.ended;
 assert.equal(r.ok,true);assert.equal(r.result.items[0].lease_valid,false);assert.equal(r.result.items[0].token,undefined);
 const ack=worker({path:f.path,method:'ack',args:ackArgs(first.items[0]),envelope:ae,now:10001});await ack.ready;ack.go();assert.equal((await ack.ended).code,'LEASE_EXPIRED');
});
test('P02 rejected ack and rolled-back operation persist clock without success receipts/events',async()=>{
 for(const operation of ['expired_ack','rollback']) {
  const f=await fixture();f.send();const c=claim(f),e=f.env(),args=ackArgs(c),n=counts(f.d);
  if(operation==='expired_ack'){f.setNow(11000);assert.throws(()=>f.d.ack(args,e),/LEASE_EXPIRED/);}
  else {const faulty=new Delivery(f.path,scope,{now:()=>11000,fault:p=>{if(p==='before_commit')throw Object.assign(new Error('IO injected'),{code:'SQLITE_IOERR'});}});
   assert.throws(()=>faulty.send({to:'b',content:'not committed',conversation_id:1,task_id:1},f.env('a')),/IO injected/);faulty.close();}
  same(counts(f.d),n);assert.equal(f.d.db.prepare('SELECT lease_clock_ms FROM bus_meta').get().lease_clock_ms,11000);
  f.setNow(10001);for(const request of [e,f.env()])assert.throws(()=>f.d.ack(args,request),/LEASE_EXPIRED/);
  const restartEnvelope=f.env();f.d.close();const w=worker({path:f.path,method:'ack',args,envelope:restartEnvelope,now:10001});await w.ready;w.go();assert.equal((await w.ended).code,'LEASE_EXPIRED');
 }
});
test('P02 preview/read_only remain byte-unchanged; COMMIT BUSY never returns an unpersisted expiration result',async()=>{
 const f=await fixture();f.send();const e=f.env(),args={limit:1,lease_ms:1000};f.d.claim(args,e);f.setNow(11000);
 let before=hash(f.path);assert.equal(f.d.preview(f.env()).items[0].lease_active,false);assert.equal(hash(f.path),before);
 f.d.db.prepare("UPDATE bus_meta SET recovery_state='read_only'").run();before=hash(f.path);
 assert.throws(()=>f.d.claim(args,e),/RECOVERY_READ_ONLY/);f.d.preview(f.env());assert.equal(hash(f.path),before);
 f.d.db.prepare("UPDATE bus_meta SET recovery_state='development_only'").run();
 const reader=new Database(f.path);reader.exec('BEGIN');reader.prepare('SELECT * FROM messages').all();f.d.db.pragma('busy_timeout=1');
 assert.throws(()=>f.d.claim(args,e),/locked/);reader.exec('ROLLBACK');reader.close();
 // Only the retry with durable clock COMMIT may report expired.
 const result=f.d.claim(args,e).items[0];assert.equal(result.lease_valid,false);assert.equal(result.token,undefined);
 f.setNow(10001);assert.equal(f.d.claim(args,e).items[0].lease_valid,false);f.d.close();
});
test.after(()=>rmSync(root,{recursive:true,force:true}));
