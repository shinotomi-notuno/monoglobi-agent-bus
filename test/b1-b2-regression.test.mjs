import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {initializeTarget} from '../dist/v2/initialize.js';
import {Registration} from '../dist/v2/registration.js';
import {detectMissingReceipt} from '../dist/v2/recovery.js';
const scope={project:'p',area:null,team:null};
test('B1 Coordinator reproduction: first rename crash must reject staging registration',()=>{
 const root=mkdtempSync(join(tmpdir(),'ab-b1-repro-')),target=join(root,'target.db'),staging=join(root,'staging.db');
 initializeTarget(target,[scope]);const meta=initializeTarget(staging,[scope]);
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import {replaceStoppedTarget} from './dist/v2/recovery.js';import {renameSync} from 'node:fs';const c=JSON.parse(process.env.C);replaceStoppedTarget(c.target,c.staging,{writersStopped:true,sidecarHandled:true,rename:(a,b)=>{renameSync(a,b);process.exit(17);}});`],
  {env:{...process.env,C:JSON.stringify({target,staging})},timeout:15000});
 assert.equal(child.status,17,child.stderr.toString());
 const r=new Registration(staging,scope);
 try{assert.throws(()=>r.register({role:'worker',provider:'x',expected_registration_revision:0},
  {origin_instance_uuid:meta.instance_uuid,actor:'late',session_id:'late',request_id:randomUUID()}),/RECOVERY_READ_ONLY|RECOVERY_REPLACE_REFUSED/);
 }finally{r.close();}
});
test('B2 Coordinator reproduction: null registration revisions are outcome unknown',()=>{
 const root=mkdtempSync(join(tmpdir(),'ab-b2-repro-')),target=join(root,'target.db'),meta=initializeTarget(target,[scope]);
 const r=new Registration(target,scope),env={origin_instance_uuid:meta.instance_uuid,actor:'a',session_id:'s',request_id:randomUUID()};
 try{
  r.register({role:'worker',provider:'x',expected_registration_revision:0},env);
  const row=r.db.prepare('SELECT * FROM operation_receipts WHERE request_id=?').get(env.request_id);
  r.db.prepare('UPDATE operation_receipts SET result_json=? WHERE request_id=?')
   .run(JSON.stringify({registration_revision:null,registration_generation:null,session_id:'s'}),env.request_id);
  assert.deepEqual(detectMissingReceipt(target,{...env,operation:'register_v2',input_digest:row.input_digest}),
   {read_only:true,code:'RECOVERY_OUTCOME_UNKNOWN'});
 }finally{r.close();}
});
