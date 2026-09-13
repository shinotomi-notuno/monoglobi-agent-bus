import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
import {copyFileSync,existsSync,linkSync,mkdtempSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {initializeTarget} from '../dist/v2/initialize.js';import {detectMissingReceipt,openRecoveredStore,recoverInstance,replaceStoppedTarget} from '../dist/v2/recovery.js';import {Registration} from '../dist/v2/registration.js';
import {initializeLegacySchema} from '../dist/db.js';import {migrateStoppedCopy} from './helpers/synthetic-migration.mjs';
const root=mkdtempSync(join(tmpdir(),'ab25-t03-')),scope={project:'p',area:null,team:null},sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const expected=p=>{const db=new Database(p,{readonly:true}),m=db.prepare('SELECT instance_uuid,schema_version FROM bus_meta').get(),s=JSON.stringify(db.prepare('SELECT scope_key FROM scopes ORDER BY scope_id').all().map(x=>x.scope_key));db.close();return {origin_instance_uuid:m.instance_uuid,schema_version:m.schema_version,scope_json:s,key_fingerprint:createHash('sha256').update(JSON.parse(readFileSync(p+'.cursor-key.json')).key).digest('hex')};};
const receiptEvidence=(path,env)=>{const db=new Database(path,{readonly:true}),r=db.prepare('SELECT input_digest FROM operation_receipts WHERE origin_instance_uuid=? AND actor=? AND request_id=?').get(env.origin_instance_uuid,env.actor,env.request_id);db.close();return {...env,operation:'register_v2',input_digest:r?.input_digest??'missing'};};
const pair=n=>{const target=join(root,`${n}-target.db`),staging=join(root,`${n}-staging.db`);initializeTarget(target,[scope]);initializeTarget(staging,[scope]);return {target,staging};};
const failure=e=>JSON.parse(readFileSync(e.manifest));
test('T03 all four rename boundaries quarantine every surviving DB/key artifact',()=>{for(const nth of [1,2,3,4]){const {target,staging}=pair(`rename-${nth}`),input=[sha(target),sha(staging)],snap=[snapshot(target),snapshot(staging)];let calls=0,err;try{replaceStoppedTarget(target,staging,{writersStopped:true,sidecarHandled:true,rename:(a,b)=>{if(++calls===nth)throw new Error(`IO_${nth}`);renameSync(a,b);}});}catch(e){err=e;}assert.match(err.message,new RegExp(`IO_${nth}`));const m=failure(err);assert.equal(m.secret_included,false);assert.ok(Object.values(m.artifact_paths).every(p=>existsSync(p)));assert.equal(existsSync(target)&&existsSync(target+'.cursor-key.json'),false);const hashes=Object.values(m.artifacts).filter(a=>a.exists).map(a=>a.sha256);assert.deepEqual([m.evidence.before.target.db,m.evidence.before.staging.db],input);assert.ok(Object.values(m.evidence.gates).every(g=>hashes.includes(g.sha256)));checkPreserved(m,snap);}});
test('T03 lock acquisition race leaves inputs unchanged and writer cooperates with replacement lock',()=>{const {target,staging}=pair('lock'),before=[sha(target),sha(staging)],meta=new Database(target,{readonly:true}).prepare('SELECT instance_uuid FROM bus_meta').get();writeFileSync(target+'.replace.lock','other');assert.throws(()=>replaceStoppedTarget(target,staging,{writersStopped:true,sidecarHandled:true}),/RECOVERY_REPLACE_REFUSED/);const r=new Registration(target,scope);assert.throws(()=>r.register({role:'worker',provider:'x',expected_registration_revision:0},{origin_instance_uuid:meta.instance_uuid,actor:'a',session_id:'s',request_id:randomUUID()}),/RECOVERY_REPLACE_REFUSED/);r.close();assert.deepEqual([sha(target),sha(staging)],before);unlinkSync(target+'.replace.lock');});
test('T03 target and staging pre-existing writer transactions refuse replacement unchanged',()=>{for(const held of ['target','staging']){const {target,staging}=pair(`prior-writer-${held}`),before=[sha(target),sha(staging)],writer=new Database(held==='target'?target:staging);writer.pragma('busy_timeout = 0');writer.exec('BEGIN IMMEDIATE');assert.throws(()=>replaceStoppedTarget(target,staging,{writersStopped:true,sidecarHandled:true}),/RECOVERY_REPLACE_REFUSED/);writer.exec('ROLLBACK');writer.close();assert.deepEqual([sha(target),sha(staging)],before);}});
test('T03 audit rejects schema/read-only/map/hash and same-inode inputs before lock',()=>{for(const bad of ['state','map','hash']){const {target,staging}=pair(`audit-${bad}`),a=sha(target),db=new Database(staging);if(bad==='state')db.exec("UPDATE bus_meta SET recovery_state='recovery_read_only'");if(bad==='map'||bad==='hash')db.prepare("INSERT INTO migration_map(source_table,source_id,target_table,target_id,classification,basis,source_path_sha256,source_content_sha256,source_scope_key,target_scope_key,audit_ref) VALUES('x',1,'y',999,'x','x',?,?,'[]','[]','{}')").run('0'.repeat(64),'0'.repeat(64));db.close();const b=sha(staging);assert.throws(()=>replaceStoppedTarget(target,staging,{writersStopped:true,sidecarHandled:true}),/RECOVERY_REPLACE_REFUSED/);assert.equal(sha(target),a);assert.equal(sha(staging),b);}const {target}=pair('inode');assert.throws(()=>replaceStoppedTarget(target,target,{writersStopped:true,sidecarHandled:true}),/RECOVERY_REPLACE_REFUSED/);});
test('T03 cross-device stat branch and sidecar condition are independently rejected',()=>{const {target,staging}=pair('device'),a=sha(target),b=sha(staging);assert.throws(()=>replaceStoppedTarget(target,staging,{writersStopped:true,sidecarHandled:true,stat:p=>({dev:p===target?1:2,ino:p===target?1:2})}),/RECOVERY_REPLACE_REFUSED/);assert.throws(()=>replaceStoppedTarget(target,staging,{writersStopped:true,sidecarHandled:false}),/RECOVERY_REPLACE_REFUSED/);assert.deepEqual([sha(target),sha(staging)],[a,b]);});
test('T03 startup entrypoint fixes read_only through an interrupted replacement state',()=>{const {target}=pair('startup'),e=expected(target);const db=new Database(target);db.exec("UPDATE bus_meta SET ready=0,recovery_state='recovery_read_only'");db.close();const store=openRecoveredStore(target,scope,e);const meta=store.db.prepare('SELECT recovery_state FROM bus_meta').get();assert.equal(meta.recovery_state,'recovery_read_only');store.close();const r=new Registration(target,scope);assert.throws(()=>r.register({role:'worker',provider:'x',expected_registration_revision:0},{origin_instance_uuid:e.origin_instance_uuid,actor:'a',session_id:'s',request_id:randomUUID()}),/RECOVERY_READ_ONLY/);r.close();});
test('T03 receipt evidence validates result, Session, digest, instance, and read-only state',()=>{for(const corrupt of ['delete','null','empty','missing','wrong-session','wrong-digest','wrong-instance']){const path=join(root,`receipt-${corrupt}.db`),meta=initializeTarget(path,[scope]),r=new Registration(path,scope),env={origin_instance_uuid:meta.instance_uuid,actor:'a',session_id:'s',request_id:randomUUID()};r.register({role:'worker',provider:'x',expected_registration_revision:0},env);const e=receiptEvidence(path,env),n=r.db.prepare('SELECT count(*) n FROM operation_receipts').get().n;if(corrupt==='delete')r.db.prepare('DELETE FROM operation_receipts WHERE origin_instance_uuid=? AND actor=? AND request_id=?').run(env.origin_instance_uuid,env.actor,env.request_id);else if(corrupt==='wrong-digest')e.input_digest='0'.repeat(64);else if(corrupt==='wrong-instance')r.db.prepare("UPDATE operation_receipts SET executed_instance_uuid='other' WHERE origin_instance_uuid=? AND actor=? AND request_id=?").run(env.origin_instance_uuid,env.actor,env.request_id);else {const value=corrupt==='null'?'null':corrupt==='empty'?'{}':corrupt==='missing'?JSON.stringify({session_id:'s',registration_revision:1}):JSON.stringify({session_id:'other',registration_revision:1,registration_generation:1});r.db.prepare('UPDATE operation_receipts SET result_json=? WHERE origin_instance_uuid=? AND actor=? AND request_id=?').run(value,env.origin_instance_uuid,env.actor,env.request_id);}r.close();assert.deepEqual(detectMissingReceipt(path,e),{read_only:true,code:'RECOVERY_OUTCOME_UNKNOWN'});const reopen=new Registration(path,scope);assert.throws(()=>reopen.createConversation({thread_id:'x'},{...env,request_id:randomUUID()}),/RECOVERY_OUTCOME_UNKNOWN/);assert.equal(reopen.db.prepare('SELECT count(*) n FROM operation_receipts').get().n,n-(corrupt==='delete'?1:0));reopen.close();}const valid=join(root,'receipt-valid.db'),vm=initializeTarget(valid,[scope]),v=new Registration(valid,scope),ve={origin_instance_uuid:vm.instance_uuid,actor:'a',session_id:'s',request_id:randomUUID()};v.register({role:'worker',provider:'x',expected_registration_revision:0},ve);const validEvidence=receiptEvidence(valid,ve);assert.deepEqual(detectMissingReceipt(valid,validEvidence),{read_only:false,code:null});v.db.exec("UPDATE bus_meta SET ready=0,recovery_state='recovery_read_only'");v.close();assert.deepEqual(detectMissingReceipt(valid,validEvidence),{read_only:true,code:'RECOVERY_IDENTITY_MISMATCH'});});
test('T03 deadline cannot extend the fifteen-minute cap before moving inputs',()=>{const {target,staging}=pair('deadline'),before=[sha(target),sha(staging)];let times=[0,900001];assert.throws(()=>replaceStoppedTarget(target,staging,{writersStopped:true,sidecarHandled:true,clock:()=>times.shift()??900001,deadlineAt:999999999}),/MIGRATION_DEADLINE_EXCEEDED/);assert.deepEqual([sha(target),sha(staging)],before);});
test('T03 normal identity succeeds; missing and damaged sidecars fix read_only',()=>{for(const kind of ['normal','missing','damaged']){const {target}=pair(`identity-${kind}`),e=expected(target);if(kind==='missing')unlinkSync(target+'.cursor-key.json');if(kind==='damaged')writeFileSync(target+'.cursor-key.json','{');const out=recoverInstance(target,e);if(kind==='normal')assert.deepEqual(out,{read_only:false,code:null});else {assert.equal(out.read_only,true);const db=new Database(target,{readonly:true});assert.equal(db.prepare('SELECT recovery_state FROM bus_meta').get().recovery_state,'recovery_read_only');db.close();}}});
test('T03 successful replacement pairs staging DB with its sidecar and keeps backup pair',()=>{const {target,staging}=pair('success'),instance=expected(staging).origin_instance_uuid,out=replaceStoppedTarget(target,staging,{writersStopped:true,sidecarHandled:true});assert.equal(JSON.parse(readFileSync(target+'.cursor-key.json')).instance,instance);assert.ok(existsSync(out.backup));assert.ok(existsSync(out.backup+'.cursor-key.json'));});
test('T03 deadline after backup quarantines both preserved inputs',()=>{const {target,staging}=pair('after-deadline'),before=[sha(target),sha(staging)],snap=[snapshot(target),snapshot(staging)];let times=[0,0,900001],err;try{replaceStoppedTarget(target,staging,{writersStopped:true,sidecarHandled:true,clock:()=>times.shift()??900001});}catch(e){err=e;}assert.match(err.message,/MIGRATION_DEADLINE_EXCEEDED/);const m=failure(err),hashes=Object.values(m.artifacts).filter(a=>a.exists).map(a=>a.sha256);assert.deepEqual([m.evidence.before.target.db,m.evidence.before.staging.db],before);assert.ok(Object.values(m.evidence.gates).every(g=>hashes.includes(g.sha256)));checkPreserved(m,snap);assert.equal(existsSync(target),false);});
test('T03 same-inode alias is refused before replacement',()=>{const {target}=pair('alias'),alias=target+'.alias';linkSync(target,alias);copyFileSync(target+'.cursor-key.json',alias+'.cursor-key.json');assert.throws(()=>replaceStoppedTarget(target,alias,{writersStopped:true,sidecarHandled:true}),/RECOVERY_REPLACE_REFUSED/);unlinkSync(alias);unlinkSync(alias+'.cursor-key.json');});
test('T03 replacement writer gate rejects an actual writer after replacement owns the target',()=>{const {target,staging}=pair('writer-race'),meta=new Database(target,{readonly:true}).prepare('SELECT instance_uuid FROM bus_meta').get(),r=new Registration(target,scope);let gated=false;const out=replaceStoppedTarget(target,staging,{writersStopped:true,sidecarHandled:true,afterWriterGate:()=>{gated=true;assert.throws(()=>r.register({role:'worker',provider:'x',expected_registration_revision:0},{origin_instance_uuid:meta.instance_uuid,actor:'a',session_id:'s',request_id:randomUUID()}),/RECOVERY_REPLACE_REFUSED/);}});assert.equal(gated,true);assert.ok(existsSync(out.target));r.close();});
test('T03 process exit at fourth rename leaves artifacts for a separate recovery process',()=>{const {target,staging}=pair('crash'),e=expected(target),config=JSON.stringify({target,staging});const script=`import {replaceStoppedTarget} from './dist/v2/recovery.js';import {renameSync} from 'node:fs';const c=JSON.parse(process.env.C);let n=0;replaceStoppedTarget(c.target,c.staging,{writersStopped:true,sidecarHandled:true,rename:(a,b)=>{if(++n===4)process.exit(17);renameSync(a,b);}});`;const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env,C:config}});assert.equal(child.status,17);assert.ok(existsSync(target));assert.equal(existsSync(target+'.cursor-key.json'),false);const out=recoverInstance(target,e);assert.equal(out.read_only,true);const db=new Database(target,{readonly:true});assert.equal(db.prepare('SELECT recovery_state FROM bus_meta').get().recovery_state,'recovery_read_only');db.close();assert.throws(()=>openRecoveredStore(target,scope,e),/CURSOR_KEY_UNAVAILABLE/);});
test('T03 process exit at every rename boundary is read-only on a separate recovery entrypoint',()=>{for(const boundary of [1,2,3,4]){const {target,staging}=pair(`crash-${boundary}`),e=expected(target),config=JSON.stringify({target,staging,boundary});const script=`import {replaceStoppedTarget} from './dist/v2/recovery.js';import {renameSync} from 'node:fs';const c=JSON.parse(process.env.C);let n=0;replaceStoppedTarget(c.target,c.staging,{writersStopped:true,sidecarHandled:true,rename:(a,b)=>{renameSync(a,b);if(++n===c.boundary)process.exit(17);}});`;const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env,C:config}});assert.equal(child.status,17);assert.ok(existsSync(target+'.replacement.json'));assert.equal(recoverInstance(target,e).read_only,true);if(existsSync(target)){const db=new Database(target,{readonly:true});assert.notEqual(db.prepare('SELECT recovery_state FROM bus_meta').get().recovery_state,'development_only');db.close();}}});
test('T03 malformed or hash-inconsistent replacement state is unknown and fixes read-only',()=>{for(const kind of ['malformed','hash']){const {target}=pair(`replacement-state-${kind}`),e=expected(target),keyPath=target+'.cursor-key.json';if(kind==='malformed')writeFileSync(target+'.replacement.json','{');else writeFileSync(target+'.replacement.json',JSON.stringify({paths:{target,target_key:keyPath},artifacts:{target:{path:target,sha256:sha(target)},target_key:{path:keyPath,sha256:'0'.repeat(64)}}}));assert.deepEqual(recoverInstance(target,e),{read_only:true,code:'RECOVERY_RENAME_UNKNOWN'});const db=new Database(target,{readonly:true});assert.equal(db.prepare('SELECT recovery_state FROM bus_meta').get().recovery_state,'recovery_read_only');db.close();}});
test('T03 migrated staging audits H01/map reachability and rejects a missing target reference',async()=>{const source=join(root,'audit-source.db'),staging=join(root,'audit-staging.db'),target=join(root,'audit-target.db'),legacy=new Database(source);initializeLegacySchema(legacy);legacy.exec("INSERT INTO agents(name,registered_at,last_seen,project,session_id) VALUES('a',1,1,'p','s'); INSERT INTO tasks(title,thread_id,requested_by,state,created_at,updated_at,project) VALUES('t','thread','a','open',1,1,'p'); INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project) VALUES('a','a','msg','body','pending',1,'thread','p'); INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project) VALUES('a','a','msg','H01','pending',2,NULL,'p'); INSERT INTO memories(by_agent,kind,content,task_id,thread_id,project,created_at,updated_at) VALUES('a','summary','link',NULL,NULL,'p',1,1)");legacy.close();await migrateStoppedCopy(source,staging,true);initializeTarget(target,[scope]);const db=new Database(staging);db.prepare("UPDATE migration_map SET target_id=999 WHERE target_table='conversations'").run();db.close();assert.throws(()=>replaceStoppedTarget(target,staging,{writersStopped:true,sidecarHandled:true}),/RECOVERY_REPLACE_REFUSED/);});

function snapshot(path){
 const db=new Database(path,{readonly:true});
 try{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all()]));}finally{db.close();}
}
function gated(before){
 const out=structuredClone(before);
 for(const m of out.bus_meta){m.ready=0;m.recovery_state='recovery_read_only';}
 return out;
}
function seed(path){
 const r=new Registration(path,scope),env={origin_instance_uuid:expected(path).origin_instance_uuid,actor:'seed',session_id:'seed',request_id:randomUUID()};
 r.register({role:'worker',provider:'x',expected_registration_revision:0},env);
 const conversation=r.createConversation({thread_id:'retained'},{...env,request_id:randomUUID()});
 const task=r.createTask({title:'retained task'},{...env,request_id:randomUUID()});
 r.link(task.task_id,conversation.conversation_id,0,{...env,request_id:randomUUID()});r.close();
}
function checkPreserved(m,snap){
 for(const [i,role] of ['target','staging'].entries()){
  const path=m.artifact_paths[role];
  assert.deepEqual(snapshot(path),gated(snap[i]));
  assert.equal(sha(path),m.evidence.gates[role].sha256);
  assert.equal(sha(m.artifact_paths[role+'_key']),m.evidence.before[role].key);
 }
}
test('B1 durable gate checkpoints and all rename edges preserve data and refuse independent writers',()=>{
 const points=['before_target_gate','target_gated','both_gated',...Array.from({length:4},(_,i)=>['before_rename_'+(i+1),'after_rename_'+(i+1)]).flat(),'verified'];
 for(const point of points){
  const {target,staging}=pair('b1-'+point);seed(target);seed(staging);
  const old={target:new Registration(target,scope),staging:new Registration(staging,scope)};
  const before={target:snapshot(target),staging:snapshot(staging)};
  const pre={target:sha(target),staging:sha(staging)};
  const script=`import {replaceStoppedTarget} from './dist/v2/recovery.js';const c=JSON.parse(process.env.C);replaceStoppedTarget(c.target,c.staging,{writersStopped:true,sidecarHandled:true,checkpoint:p=>{if(p===c.point)process.exit(17);}});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,C:JSON.stringify({target,staging,point})},timeout:15000});
  assert.equal(child.status,17,child.stderr.toString());
  const state=JSON.parse(readFileSync(target+'.replacement.json')),ev=state.evidence;
  assert.deepEqual([ev.before.target.db,ev.before.staging.db],[pre.target,pre.staging]);
  if(['before_target_gate','target_gated','both_gated'].includes(point)){
   assert.ok(existsSync(target)&&existsSync(staging));assert.equal(existsSync(state.paths.backup),false);
  }
  for(const role of ['target','staging']){
   const path=state.paths[role],committed=!!ev.gates[role];
   assert.deepEqual(snapshot(path),committed?gated(before[role]):before[role]);
   assert.equal(sha(path),committed?ev.gates[role].sha256:pre[role]);
   assert.equal(sha(state.paths[role+'_key']),ev.before[role].key);
   if(!committed){old[role].close();continue;}
   assert.throws(()=>old[role].register({role:'worker',provider:'x',expected_registration_revision:0},
    {origin_instance_uuid:before[role].bus_meta[0].instance_uuid,actor:'late',session_id:'late',request_id:randomUUID()}),
    /RECOVERY_READ_ONLY|RECOVERY_REPLACE_REFUSED|readonly/);
   old[role].close();
   const fileHash=sha(path);
   const probe=`import Database from 'better-sqlite3';import {Registration} from './dist/v2/registration.js';import {mutation} from './dist/v2/mutation.js';const c=JSON.parse(process.env.C),db=new Database(c.path),m=db.prepare('SELECT instance_uuid FROM bus_meta').get();let code;try{mutation(db,1,'probe',{}, {origin_instance_uuid:m.instance_uuid,actor:'probe',session_id:'probe',request_id:'probe'},()=>{throw new Error('BUSINESS_CALLED');});}catch(e){code=e.message;}db.close();if(!['RECOVERY_READ_ONLY','RECOVERY_REPLACE_REFUSED'].includes(code))throw new Error(code);try{const r=new Registration(c.path,{project:'p',area:null,team:null});try{r.register({role:'worker',provider:'x',expected_registration_revision:0},{origin_instance_uuid:m.instance_uuid,actor:'probe',session_id:'probe',request_id:'probe'});throw new Error('WRITER_PASSED');}finally{r.close();}}catch(e){if(!['RECOVERY_READ_ONLY','RECOVERY_REPLACE_REFUSED','CURSOR_KEY_UNAVAILABLE'].includes(e.message))throw e;}`;
   const writer=spawnSync(process.execPath,['--input-type=module','-e',probe],{env:{...process.env,C:JSON.stringify({path})},timeout:15000});
   assert.equal(writer.status,0,writer.stderr.toString());assert.equal(sha(path),fileHash);
  }
 }
});
test('B2 actual register and conversation result contracts reject null, wrong types and invalid values',()=>{
 for(const op of ['register_v2','create_conversation_v2']){
  const fields=op==='register_v2'?['registration_revision','registration_generation','session_revision']:['conversation_id'];
  for(const value of [null,'1',0,-1,1.5,Number.MAX_SAFE_INTEGER+1]){
   for(const field of fields){
    const {target}=pair('b2-'+randomUUID()),r=new Registration(target,scope),meta=expected(target),env={origin_instance_uuid:meta.origin_instance_uuid,actor:'a',session_id:'s',request_id:randomUUID()};
    r.register({role:'worker',provider:'x',expected_registration_revision:0},env);
    if(op==='create_conversation_v2'){env.request_id=randomUUID();r.createConversation({thread_id:'thread'},env);}
    const row=r.db.prepare('SELECT * FROM operation_receipts WHERE request_id=?').get(env.request_id),e={...env,operation:op,input_digest:row.input_digest};
    assert.deepEqual(detectMissingReceipt(target,e),{read_only:false,code:null});
    const result=JSON.parse(row.result_json);result[field]=value;
    r.db.prepare('UPDATE operation_receipts SET result_json=? WHERE request_id=?').run(JSON.stringify(result),env.request_id);
    const before=snapshot(target);
    assert.deepEqual(detectMissingReceipt(target,e),{read_only:true,code:'RECOVERY_OUTCOME_UNKNOWN'});
    assert.throws(()=>r.createConversation({thread_id:'blocked'},{...env,request_id:randomUUID()}),/RECOVERY_OUTCOME_UNKNOWN/);
    const after=snapshot(target);before.bus_meta[0].ready=0;before.bus_meta[0].recovery_state='recovery_outcome_unknown';
    assert.deepEqual(after,before);r.close();
   }
  }
 }
});
test('B1 successful activation permits only new target and retains gated backup with matching hashes',()=>{
 const {target,staging}=pair('success-gates');seed(target);seed(staging);
 const before={target:snapshot(target),staging:snapshot(staging)},old=new Registration(target,scope);
 const out=replaceStoppedTarget(target,staging,{writersStopped:true,sidecarHandled:true});
 const evidence=JSON.parse(readFileSync(out.manifest)).evidence;
 assert.deepEqual(snapshot(out.backup),gated(before.target));assert.deepEqual(snapshot(target),before.staging);
 assert.equal(sha(out.backup),evidence.gates.target.sha256);
 assert.equal(sha(out.backup+'.cursor-key.json'),evidence.before.target.key);
 assert.equal(sha(target+'.cursor-key.json'),evidence.before.staging.key);
 const backup=new Registration(out.backup,scope);
 for(const connection of [old,backup]){
  assert.throws(()=>connection.register({role:'worker',provider:'x',expected_registration_revision:0},
   {origin_instance_uuid:before.target.bus_meta[0].instance_uuid,actor:'late',session_id:'late',request_id:randomUUID()}),/RECOVERY_READ_ONLY|readonly/);
  connection.close();
 }
 assert.equal(sha(out.backup),evidence.gates.target.sha256);
 const active=new Registration(target,scope);
 active.register({role:'worker',provider:'x',expected_registration_revision:0},
  {origin_instance_uuid:before.staging.bus_meta[0].instance_uuid,actor:'new',session_id:'new',request_id:randomUUID()});active.close();
});
test('B1 second gate failure keeps only first commit and never renames',()=>{
 const {target,staging}=pair('second-gate-fault');seed(target);seed(staging);
 const db=new Database(staging);
 db.exec("CREATE TRIGGER fail_gate BEFORE UPDATE OF ready ON bus_meta BEGIN SELECT RAISE(ABORT,'GATE_IO'); END");db.close();
 const before={target:snapshot(target),staging:snapshot(staging)},sHash=sha(staging);
 let renames=0;
 assert.throws(()=>replaceStoppedTarget(target,staging,{writersStopped:true,sidecarHandled:true,rename:()=>{renames++;}}),/GATE_IO/);
 assert.equal(renames,0);assert.equal(sha(staging),sHash);
 assert.deepEqual(snapshot(target),gated(before.target));assert.deepEqual(snapshot(staging),before.staging);
 const evidence=JSON.parse(readFileSync(target+'.replacement.json')).evidence;
 assert.equal(sha(target),evidence.gates.target.sha256);assert.equal(evidence.gates.staging,undefined);
});
test('B1 rejects a trigger changing a non-gate bus_meta column before commit',()=>{
 const {target,staging}=pair('gate-column-guard'),db=new Database(target);
 db.exec("CREATE TRIGGER poison_gate AFTER UPDATE OF ready ON bus_meta BEGIN UPDATE bus_meta SET relation_revision=relation_revision+1; END");db.close();
 const before=[sha(target),sha(staging)];
 assert.throws(()=>replaceStoppedTarget(target,staging,{writersStopped:true,sidecarHandled:true}),/RECOVERY_REPLACE_REFUSED/);
 assert.deepEqual([sha(target),sha(staging)],before);
});
test('B2 created flag type and missing fields fail closed',()=>{
 for(const value of [null,0,'true',undefined]){
  const {target}=pair('created-'+randomUUID()),r=new Registration(target,scope),env={origin_instance_uuid:expected(target).origin_instance_uuid,actor:'a',session_id:'s',request_id:randomUUID()};
  r.register({role:'worker',provider:'x',expected_registration_revision:0},env);
  env.request_id=randomUUID();r.createConversation({thread_id:'thread'},env);
  const row=r.db.prepare('SELECT * FROM operation_receipts WHERE request_id=?').get(env.request_id),e={...env,operation:'create_conversation_v2',input_digest:row.input_digest};
  const result=JSON.parse(row.result_json);result.created=value;
  r.db.prepare('UPDATE operation_receipts SET result_json=? WHERE request_id=?').run(JSON.stringify(result),env.request_id);
  assert.equal(detectMissingReceipt(target,e).code,'RECOVERY_OUTCOME_UNKNOWN');r.close();
 }
});
test('B1 migrated source and archived copy remain byte-identical through gate interruption',async()=>{
 const source=join(root,'source-gates.db'),archive=join(root,'source-archive.db'),staging=join(root,'source-staging.db'),target=join(root,'source-target.db');
 const db=new Database(source);initializeLegacySchema(db);db.close();
 copyFileSync(source,archive);const hashes=[sha(source),sha(archive)];
 await migrateStoppedCopy(source,staging,true);initializeTarget(target,[scope]);
 const before={target:snapshot(target),staging:snapshot(staging)};
 assert.throws(()=>replaceStoppedTarget(target,staging,{writersStopped:true,sidecarHandled:true,checkpoint:p=>{if(p==='both_gated')throw new Error('STOP');}}),/STOP/);
 assert.deepEqual([sha(source),sha(archive)],hashes);
 assert.deepEqual(snapshot(target),gated(before.target));assert.deepEqual(snapshot(staging),gated(before.staging));
});
test('B2 conversation reuse and revoked Session preserve valid receipt without enabling writes',()=>{
 const {target}=pair('b2-reuse'),r=new Registration(target,scope),env={origin_instance_uuid:expected(target).origin_instance_uuid,actor:'a',session_id:'s',request_id:randomUUID()};
 r.register({role:'worker',provider:'x',expected_registration_revision:0},env);
 for(const created of [true,false]){
  env.request_id=randomUUID();assert.equal(r.createConversation({thread_id:'thread'},env).created,created);
  const row=r.db.prepare('SELECT * FROM operation_receipts WHERE request_id=?').get(env.request_id),e={...env,operation:'create_conversation_v2',input_digest:row.input_digest};
  const before=sha(target);assert.deepEqual(detectMissingReceipt(target,e),{read_only:false,code:null});assert.equal(sha(target),before);
 }
 const row=r.db.prepare('SELECT * FROM operation_receipts WHERE request_id=?').get(env.request_id),e={...env,operation:'create_conversation_v2',input_digest:row.input_digest};
 r.revokeSession({target_session_id:'s',expected_session_revision:1,reason:'end',evidence_ref:'test'},{...env,request_id:randomUUID()});
 assert.throws(()=>r.createConversation({thread_id:'revoked'},{...env,request_id:randomUUID()}),/SESSION_REVOKED/);
 for(const state of ['recovery_read_only','recovery_outcome_unknown']){
  r.db.prepare('UPDATE bus_meta SET ready=0,recovery_state=?').run(state);
  const before=sha(target);assert.equal(detectMissingReceipt(target,e).read_only,true);assert.equal(sha(target),before);
 }r.close();
});
test('B1 COMMIT-to-state gaps retain gates and recovery records actual committed artifact hashes',()=>{
 for(const point of ['target_commit_before_record','staging_commit_before_record']){
  const {target,staging}=pair('commit-gap-'+point);seed(target);seed(staging);
  const e=expected(target),before={target:snapshot(target),staging:snapshot(staging)},stageHash=sha(staging);
  const script=`import {replaceStoppedTarget} from './dist/v2/recovery.js';const c=JSON.parse(process.env.C);replaceStoppedTarget(c.target,c.staging,{writersStopped:true,sidecarHandled:true,checkpoint:p=>{if(p===c.point)process.exit(17);}});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,C:JSON.stringify({target,staging,point})},timeout:15000});
  assert.equal(child.status,17,child.stderr.toString());
  const tHash=sha(target),sHash=sha(staging);
  assert.deepEqual(snapshot(target),gated(before.target));
  assert.deepEqual(snapshot(staging),point==='target_commit_before_record'?before.staging:gated(before.staging));
  if(point==='target_commit_before_record')assert.equal(sHash,stageHash);
  assert.equal(recoverInstance(target,e).read_only,true);
  const inspection=JSON.parse(readFileSync(target+'.replacement-inspection.json'));
  assert.equal(inspection.artifacts.target.sha256,tHash);assert.equal(inspection.artifacts.staging.sha256,sHash);
  assert.equal(sha(target),tHash);assert.equal(sha(staging),sHash);
  for(const role of point==='target_commit_before_record'?['target']:['target','staging']){
   const path=role==='target'?target:staging,r=new Registration(path,scope),meta=before[role].bus_meta[0];
   assert.throws(()=>r.register({role:'worker',provider:'x',expected_registration_revision:0},{origin_instance_uuid:meta.instance_uuid,actor:'late',session_id:'late',request_id:randomUUID()}),/RECOVERY_READ_ONLY|RECOVERY_REPLACE_REFUSED/);r.close();
  }
  assert.equal(sha(target),tHash);assert.equal(sha(staging),sHash);
 }
});
test('B2 missing digest or instance, mismatched Session and unsupported result contracts remain unknown',()=>{
 for(const defect of ['evidence_missing','saved_digest_empty','instance_empty','session_mismatch','unsupported']){
  const {target}=pair('b2-evidence-'+defect),r=new Registration(target,scope),env={origin_instance_uuid:expected(target).origin_instance_uuid,actor:'a',session_id:'s',request_id:randomUUID()};
  r.register({role:'worker',provider:'x',expected_registration_revision:0},env);
  const e=receiptEvidence(target,env);
  if(defect==='evidence_missing')delete e.input_digest;
  if(defect==='saved_digest_empty')r.db.exec("UPDATE operation_receipts SET input_digest=''");
  if(defect==='instance_empty')r.db.exec("UPDATE operation_receipts SET executed_instance_uuid=''");
  if(defect==='session_mismatch')e.session_id='different';
  if(defect==='unsupported'){e.operation='unsupported_v2';r.db.exec("UPDATE operation_receipts SET operation='unsupported_v2'");}
  const before=snapshot(target);
  assert.deepEqual(detectMissingReceipt(target,e),{read_only:true,code:'RECOVERY_OUTCOME_UNKNOWN'});
  before.bus_meta[0].ready=0;before.bus_meta[0].recovery_state='recovery_outcome_unknown';
  assert.deepEqual(snapshot(target),before);r.close();
 }
});
