import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,existsSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {initializeTarget} from '../dist/v2/initialize.js';
import {Registration} from '../dist/v2/registration.js';
const root=mkdtempSync(join(tmpdir(),'ab25-r01-')),scope={project:'r01',area:null,team:null};
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const query=(p,sql)=>{const db=new Database(p,{readonly:true,fileMustExist:true});try{return db.prepare(sql).all();}finally{db.close();}};
const write=(p,data)=>writeFileSync(p,JSON.stringify(data),{mode:0o600});
const trusted=p=>{const meta=initializeTarget(p,[scope]);return {path:p,expected:{origin_instance_uuid:meta.instance_uuid,schema_version:meta.schema,scope_json:JSON.stringify([JSON.stringify(['r01',null,null])]),key_fingerprint:createHash('sha256').update(JSON.parse(readFileSync(p+'.cursor-key.json')).key).digest('hex')},receipts:[]};};
const pair=()=>{const dir=mkdtempSync(join(root,'case-'));return {writersStopped:true,sidecarHandled:true,deadlineAt:Date.now()+900000,target:trusted(join(dir,'target.db')),staging:trusted(join(dir,'staging.db'))};};
function admin(plan,command='inspect',fault){
 const file=join(root,randomUUID()+'.json');write(file,plan);
 const r=spawnSync(process.execPath,[...(fault?['--import',resolve('test/helpers/recovery-entry-fault.mjs')]:[]),resolve('dist/v2/recovery-cli.js'),command,file],{encoding:'utf8',timeout:20000,env:{...process.env,...(fault?{R01_TEST_FAULT:fault}:{})}});
 return {...r,value:r.stdout.trim()?JSON.parse(r.stdout):null};
}
const inspection=p=>({writersStopped:p.writersStopped,sidecarHandled:p.sidecarHandled,deadlineAt:p.deadlineAt,target:p.target});
const envelope=t=>({origin_instance_uuid:t.expected.origin_instance_uuid,actor:'new-'+randomUUID(),session_id:randomUUID(),request_id:randomUUID()});
const args=t=>({role:'worker',provider:'test',expected_registration_revision:0,envelope:envelope(t)});
function cli(t,a=args(t)){
 const file=join(root,randomUUID()+'.json');write(file,a);
 return spawnSync(process.execPath,[resolve('dist/v2/cli.js'),t.path,JSON.stringify(scope),'register_v2',file],{encoding:'utf8',timeout:20000});
}
async function mcp(t){
 const client=new Client({name:'R01-process-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/v2/server.js')],env:{...process.env,AGENT_BUS_V2_DB:t.path,AGENT_BUS_V2_SCOPE:JSON.stringify(scope),AGENT_BUS_V2_WRITERS:'1'},stderr:'pipe'});
 let stderr='';transport.stderr?.on('data',x=>{stderr+=x;});
 try{await client.connect(transport,{timeout:5000});const result=await client.callTool({name:'register_v2',arguments:args(t)});return {ok:!result.isError,code:result.isError?JSON.parse(result.content[0].text).code:null};}
 catch{return {ok:false,code:stderr.match(/RECOVERY_[A-Z_]+|CURSOR_KEY_UNAVAILABLE|SQLITE_CANTOPEN/)?.[0]??'TRANSPORT_ERROR'};}
 finally{await client.close();}
}
const counts=p=>existsSync(p)?query(p,'SELECT (SELECT count(*) FROM agents) agents,(SELECT count(*) FROM tasks) tasks,(SELECT count(*) FROM messages) messages,(SELECT count(*) FROM operation_receipts) receipts'):null;
async function denied(t){const before=counts(t.path);assert.equal(cli(t).status,1);const r=await mcp(t);assert.equal(r.ok,false);assert.match(r.code,/^(RECOVERY_[A-Z_]+|CURSOR_KEY_UNAVAILABLE|SQLITE_CANTOPEN)$/);assert.deepEqual(counts(t.path),before);}
test('R01 inspect and replacement are executable commands; only new target starts writers',async()=>{
 const p=pair(),ok=admin(inspection(p));assert.equal(ok.status,0);assert.equal(ok.value.read_only,false);
 const r=admin(p,'replace');assert.equal(r.status,0);assert.equal(r.value.production_ready,false);
 const newTarget={...p.staging,path:p.target.path};assert.equal(admin({...inspection(p),target:newTarget}).status,0);
 assert.equal(cli(newTarget).status,0);assert.equal((await mcp(newTarget)).ok,true);
 await denied({...p.target,path:r.value.backup});
 assert.equal(query(r.value.backup,'SELECT ready FROM bus_meta')[0].ready,0);
});
test('R01 invalid documents refuse before any DB/gate change; no raw secret output',()=>{
 const p=pair(),before=[sha(p.target.path),sha(p.staging.path)];
 for(const mutate of [x=>delete x.target.expected,x=>x.target.receipts=null,x=>x.writersStopped=false,x=>x.sidecarHandled='true',x=>x.target.expected.key_fingerprint=null,x=>x.target.expected.scope_json='["bad"]',x=>x.target.extra='DO_NOT_PRINT_SECRET',x=>x.target.receipts=[{origin_instance_uuid:'different',actor:'a',session_id:'s',request_id:'r',operation:'register_v2',input_digest:'a'.repeat(64)}]]){
  const plan=structuredClone(p);mutate(plan);const r=admin(plan,'replace');assert.equal(r.status,64);assert.equal(r.value.code,'INVALID_INPUT');assert.ok(!r.stdout.includes('DO_NOT_PRINT_SECRET'));assert.deepEqual([sha(p.target.path),sha(p.staging.path)],before);
 }
});
for(const changed of ['origin_instance_uuid','schema_version','scope_json','key_fingerprint'])test(`R01 trusted ${changed} mismatch fixes gate and ordinary CLI/MCP refuse`,async()=>{
 const p=pair(),plan=inspection(p);plan.target.expected[changed]=changed==='scope_json'?JSON.stringify([JSON.stringify(['other',null,null])]):changed==='key_fingerprint'?'0'.repeat(64):'different';
 const r=admin(plan);assert.equal(r.status,2);assert.equal(r.value.code,'RECOVERY_IDENTITY_MISMATCH');await denied(p.target);
});
for(const damage of ['missing','malformed','wrong-instance'])test(`R01 ${damage} key sidecar is refused without disclosure`,async()=>{
 const p=pair(),key=p.target.path+'.cursor-key.json';
 if(damage==='missing')unlinkSync(key);else if(damage==='malformed')writeFileSync(key,'PRIVATE_KEY_NOT_LOGGED',{mode:0o600});else{const k=JSON.parse(readFileSync(key));k.instance='other';write(key,k);}
 const r=admin(inspection(p));assert.equal(r.status,2);assert.equal(r.value.code,'RECOVERY_IDENTITY_MISMATCH');assert.ok(!r.stdout.includes('PRIVATE_KEY'));await denied(p.target);
});
function withReceipt(){const p=pair(),t=p.target,e=envelope(t),s=new Registration(t.path,scope);s.register({role:'worker',provider:'test',expected_registration_revision:0},e);s.close();const row=query(t.path,'SELECT input_digest FROM operation_receipts')[0];t.receipts=[{...e,operation:'register_v2',input_digest:row.input_digest}];return p;}
test('R01 trusted prior receipt passes; missing or malformed receipt fixes outcome unknown',async()=>{
 for(const damage of ['none','missing','malformed','digest']){
  const p=withReceipt();
  if(damage==='missing')p.target.receipts[0].request_id='not-committed';
  if(damage==='digest')p.target.receipts[0].input_digest='0'.repeat(64);
  if(damage==='malformed'){const db=new Database(p.target.path);db.exec("UPDATE operation_receipts SET result_json='null'");db.close();}
  const r=admin(inspection(p));assert.equal(r.status,damage==='none'?0:2);
  if(damage!=='none'){assert.equal(r.value.code,'RECOVERY_OUTCOME_UNKNOWN');await denied(p.target);}
 }
});
test('R01 existing read-only is never cleared by valid evidence',async()=>{
 const p=withReceipt(),db=new Database(p.target.path);db.exec("UPDATE bus_meta SET ready=0,recovery_state='recovery_read_only'");db.close();
 assert.equal(admin(inspection(p)).status,2);await denied(p.target);
});
test('R01 pre-existing lock, prior writer, deadline and raw input errors refuse safely',()=>{
 for(const kind of ['lock','writer','deadline']){
  const p=pair(),before=[sha(p.target.path),sha(p.staging.path)];let db;
  if(kind==='lock')writeFileSync(p.target.path+'.replace.lock','held');
  if(kind==='writer'){db=new Database(p.staging.path);db.exec('BEGIN IMMEDIATE');}
  if(kind==='deadline')p.deadlineAt=0;
  try{const r=admin(p,'replace');assert.equal(r.status,2);assert.equal(r.value.code,kind==='deadline'?'MIGRATION_DEADLINE_EXCEEDED':'RECOVERY_REPLACE_REFUSED');}finally{db?.exec('ROLLBACK');db?.close();}
  assert.deepEqual([sha(p.target.path),sha(p.staging.path)],before);
 }
 const file=join(root,'malformed.json');writeFileSync(file,'SECRET_BAD_JSON');const r=spawnSync(process.execPath,[resolve('dist/v2/recovery-cli.js'),'inspect',file],{encoding:'utf8'});assert.equal(r.status,64);assert.ok(!r.stdout.includes('SECRET_BAD_JSON'));
});
for(const when of ['before','after'])for(let n=1;n<=4;n++)test(`R01 actual recovery CLI killed ${when} rename ${n}; fresh recovery and normal processes refuse`,async()=>{
 const p=pair(),r=admin(p,'replace',`${when}_${n}`);assert.equal(r.signal,'SIGKILL');
 const dir=join(p.target.path,'..'),dbs=readdirSync(dir).filter(x=>x.includes('.db')&&!x.includes('.json')&&!x.endsWith('.lock')).map(x=>join(dir,x));
 const before=dbs.map(sha),keyHashes=readdirSync(dir).filter(x=>x.endsWith('.cursor-key.json')).map(x=>[join(dir,x),sha(join(dir,x))]);
 // Ordinary startup must reject WITHOUT first running the recovery CLI.
 await denied(p.target);await denied(p.staging);
 const recovered=admin(inspection(p));assert.equal(recovered.status,2);assert.equal(recovered.value.read_only,true);
 await denied(p.target);await denied(p.staging);
 for(const path of dbs){assert.equal(query(path,'SELECT ready FROM bus_meta')[0].ready,0);await denied({...p.target,path});}
 assert.deepEqual(dbs.map(sha),before);assert.deepEqual(keyHashes.map(([p])=>[p,sha(p)]),keyHashes);
});
test('R01 unfinished activation marker and malformed state reject ordinary startup without admin',async()=>{
 for(const state of ['{}','broken']){const p=pair();writeFileSync(p.target.path+'.replacement.json',state);const before=counts(p.target.path);await denied(p.target);const r=admin(inspection(p));assert.equal(r.status,2);assert.equal(r.value.code,'RECOVERY_RENAME_UNKNOWN');assert.deepEqual(counts(p.target.path),before);}
});
