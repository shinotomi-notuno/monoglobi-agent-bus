import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {initializeLegacySchema} from '../dist/db.js';
import {initializeTarget} from '../dist/v2/initialize.js';
import {migrateStoppedCopy as raw,auditMigration} from '../dist/v2/migrate.js';
import {migrateStoppedCopy,confirmation} from './helpers/synthetic-migration.mjs';
process.umask(0o077);
const scope={project:'p',area:null,team:null},hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const q=(p,sql)=>{const db=new Database(p,{readonly:true});try{return db.prepare(sql).all();}finally{db.close();}};
const edit=(p,sql)=>{const db=new Database(p);try{
 // Deliberately corrupted copies only; normal migration never disables guards.
 if(sql.includes("status='completed'"))db.pragma('ignore_check_constraints=ON');
 if(sql==='DELETE FROM migration_runs')db.pragma('foreign_keys=OFF');
 if(sql.startsWith('UPDATE messages SET conversation_id'))for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='messages'").all())db.exec('DROP TRIGGER "'+name+'"');
 db.exec(sql);
}finally{db.close();}};
function fixture(project='p'){
 const dir=mkdtempSync('/tmp/ab-t06-fix-'),source=join(dir,'source.db'),staging=join(dir,'staging.db'),target=join(dir,'target.db');
 const db=new Database(source);initializeLegacySchema(db);
 db.exec("INSERT INTO agents(name,registered_at,last_seen,project,session_id) VALUES('a',1,1,'p','s'); INSERT INTO tasks(title,thread_id,requested_by,state,created_at,updated_at,project) VALUES('t','thread','a','open',1,1,'p'); INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project) VALUES('a','a','msg','normal','pending',1,'thread','p'); INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project) VALUES('a','a','msg','synthetic','pending',2,NULL,'p');");
 for(const t of ['agents','tasks','messages'])db.prepare(`UPDATE ${t} SET project=?`).run(project);db.close();
 return {dir,source,staging,target};
}
function trusted(path){const meta=q(path,'SELECT * FROM bus_meta')[0];return {path,expected:{origin_instance_uuid:meta.instance_uuid,schema_version:meta.schema_version,scope_json:JSON.stringify(q(path,'SELECT scope_key FROM scopes ORDER BY scope_id').map(x=>x.scope_key)),key_fingerprint:createHash('sha256').update(JSON.parse(readFileSync(path+'.cursor-key.json')).key).digest('hex')},receipts:[]};}
async function pair(){const f=fixture();await migrateStoppedCopy(f.source,f.staging,true);initializeTarget(f.target,[scope]);return {...f,plan:{writersStopped:true,sidecarHandled:true,deadlineAt:Date.now()+900000,target:trusted(f.target),staging:trusted(f.staging)}};}
function admin(f,fault){const file=join(f.dir,'plan.json');writeFileSync(file,JSON.stringify(f.plan));const r=spawnSync(process.execPath,[...(fault?['--import',resolve('test/helpers/recovery-entry-fault.mjs')]:[]),resolve('dist/v2/recovery-cli.js'),'replace',file],{encoding:'utf8',timeout:15000,env:{...process.env,R01_TEST_FAULT:fault??''}});return {...r,value:r.stdout.trim()?JSON.parse(r.stdout):null};}
const args=t=>({role:'worker',provider:'test',expected_registration_revision:0,envelope:{origin_instance_uuid:t.expected.origin_instance_uuid,actor:randomUUID(),session_id:randomUUID(),request_id:randomUUID()}});
function cli(t){const p=t.path+'.request.json';writeFileSync(p,JSON.stringify(args(t)));return spawnSync(process.execPath,[resolve('dist/v2/cli.js'),t.path,JSON.stringify(scope),'register_v2',p],{encoding:'utf8',timeout:15000});}
async function mcp(t){const client=new Client({name:'t06',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/v2/server.js')],env:{...process.env,AGENT_BUS_V2_DB:t.path,AGENT_BUS_V2_SCOPE:JSON.stringify(scope),AGENT_BUS_V2_WRITERS:'1'},stderr:'pipe'});try{await client.connect(transport,{timeout:5000});const r=await client.callTool({name:'register_v2',arguments:args(t)});return !r.isError;}finally{await client.close();}}
test('G1/G2 normal migration -> actual replace CLI -> normal CLI and MCP',async()=>{
 const f=await pair(),before=hash(f.source);assert.equal(auditMigration(f.source,f.staging).ok,true);
 assert.equal(q(f.staging,'SELECT status FROM migration_runs')[0].status,'ready');
 const r=admin(f);assert.equal(r.status,0, r.stdout);const t={...f.plan.staging,path:f.target};
 assert.equal(cli(t).status,0);assert.equal(await mcp(t),true);
 assert.equal(q(f.target,'SELECT count(*) n FROM operation_receipts')[0].n,2);
 assert.equal(q(f.target,'SELECT count(*) n FROM messages')[0].n,2);
 assert.equal(q(r.value.backup,'SELECT ready FROM bus_meta')[0].ready,0);assert.equal(cli({...f.plan.target,path:r.value.backup}).status,1);assert.equal(hash(f.source),before);
});
for(const [name,sql] of Object.entries({blocked:"UPDATE migration_runs SET status='blocked'",completed:"UPDATE migration_runs SET status='completed'",missing_run:'DELETE FROM migration_runs',bad_source_hash:"UPDATE migration_runs SET source_hash='bad'",bad_map:'UPDATE migration_map SET target_id=999 WHERE classification=\'synthetic_conversation\'',missing_synthetic:"DELETE FROM migration_map WHERE classification='synthetic_conversation'"}))test(`G1 migrated CLI rejects single ${name}`,async()=>{
 const f=await pair();edit(f.staging,sql);const before=[hash(f.source),hash(f.target),hash(f.staging),hash(f.staging+'.cursor-key.json')];
 const r=admin(f);assert.equal(r.status,2);assert.equal(r.value.code,'RECOVERY_REPLACE_REFUSED');assert.deepEqual([hash(f.source),hash(f.target),hash(f.staging),hash(f.staging+'.cursor-key.json')],before);assert.equal(existsSync(f.target+'.replacement.json'),false);
});
test('G2 missing synthetic during migration quarantines with no published target or success manifest',async()=>{
 const f=fixture(),before=hash(f.source);await assert.rejects(()=>migrateStoppedCopy(f.source,f.staging,true,{faultAt:'omit_synthetic_map'}),/MIGRATION_FINAL_AUDIT_FAILED/);
 assert.equal(hash(f.source),before);assert.equal(existsSync(f.staging),false);assert.equal(existsSync(f.staging+'.migration.json'),false);
 const name=readdirSync(f.dir).find(x=>x.endsWith('.failure.json'));assert.ok(name);const m=JSON.parse(readFileSync(join(f.dir,name)));assert.equal(m.code,'MIGRATION_FINAL_AUDIT_FAILED');assert.equal(q(m.quarantine_path,'SELECT count(*) n FROM operation_receipts')[0].n,0);
});
const damage={missing:"DELETE FROM migration_map WHERE classification='synthetic_conversation'",basis:"UPDATE migration_map SET basis='other' WHERE classification='synthetic_conversation'",classification:"UPDATE migration_map SET classification='preserved' WHERE target_table='conversations'",path_hash:"UPDATE migration_map SET source_path_sha256='bad' WHERE classification='synthetic_conversation'",content_hash:"UPDATE migration_map SET source_content_sha256='bad' WHERE classification='synthetic_conversation'",scope:"UPDATE migration_map SET source_scope_key='other',target_scope_key='other' WHERE classification='synthetic_conversation'",target_message:'UPDATE messages SET conversation_id=1 WHERE id=2',duplicate:"CREATE TABLE mc AS SELECT * FROM migration_map; DROP TABLE migration_map; ALTER TABLE mc RENAME TO migration_map; INSERT INTO migration_map SELECT * FROM migration_map WHERE classification='synthetic_conversation'"};
for(const [name,sql] of Object.entries(damage))test(`G2 read-only audit rejects isolated ${name}`,async()=>{
 const f=fixture();await migrateStoppedCopy(f.source,f.staging,true);assert.equal(auditMigration(f.source,f.staging).ok,true);edit(f.staging,sql);const before=[hash(f.source),hash(f.staging),hash(f.staging+'.cursor-key.json')];
 assert.equal(auditMigration(f.source,f.staging).ok,false);assert.deepEqual([hash(f.source),hash(f.staging),hash(f.staging+'.cursor-key.json')],before);assert.equal(q(f.staging,'SELECT ready FROM bus_meta')[0].ready,1);assert.equal(q(f.staging,'SELECT count(*) n FROM operation_receipts')[0].n,0);
});
test('G2 distinct source/scope same numeric ID has isolated provenance; swapped map rejected',async()=>{
 const a=fixture('p'),b=fixture('q');await migrateStoppedCopy(a.source,a.staging,true);await migrateStoppedCopy(b.source,b.staging,true);
 assert.equal(auditMigration(a.source,a.staging).ok,true);assert.equal(auditMigration(b.source,b.staging).ok,true);assert.equal(auditMigration(a.source,b.staging).ok,false);
 const row=q(b.staging,"SELECT * FROM migration_map WHERE classification='synthetic_conversation'")[0];
 const db=new Database(a.staging);db.prepare("UPDATE migration_map SET source_path_sha256=?,source_content_sha256=?,source_scope_key=?,target_scope_key=?,audit_ref=? WHERE classification='synthetic_conversation'").run(row.source_path_sha256,row.source_content_sha256,row.source_scope_key,row.target_scope_key,row.audit_ref);db.close();assert.equal(auditMigration(a.source,a.staging).ok,false);
});
for(const fault of ['after_1','after_2','after_3','after_4'])test(`G1 migrated CLI interruption ${fault} retains gates and business`,async()=>{
 const f=await pair(),sourceHash=hash(f.source),r=admin(f,fault);assert.equal(r.signal,'SIGKILL');assert.equal(hash(f.source),sourceHash);assert.ok(existsSync(f.target+'.replacement.json'));
 const dbs=readdirSync(f.dir).filter(x=>x==='target.db'||x==='staging.db'||/^target.db.backup-/.test(x)&&!x.endsWith('.json'));
 let messages=0;for(const name of dbs){const p=join(f.dir,name);assert.equal(q(p,'SELECT ready FROM bus_meta')[0].ready,0);assert.equal(q(p,'SELECT count(*) n FROM operation_receipts')[0].n,0);messages+=q(p,'SELECT count(*) n FROM messages')[0].n;assert.equal(cli({...f.plan.staging,path:p}).status,1);}assert.equal(messages,2);
 const state=JSON.parse(readFileSync(f.target+'.replacement.json'));
 // A kill after rename precedes its state update: resolve preserved roles by hash,
 // not the stale path recorded before the interrupted rename.
 for(const name of dbs)assert.ok(Object.values(state.evidence.gates).some(g=>g.sha256===hash(join(f.dir,name))));
 for(const role of ['target','staging'])assert.ok(readdirSync(f.dir).filter(x=>x.endsWith('.cursor-key.json')).some(x=>hash(join(f.dir,x))===state.evidence.before[role].key));
});
for(const kind of ['missing','wrong_type','incomplete','hash','path','real','forbidden'])test(`G3 ${kind} refuses before copying`,async()=>{
 const f=fixture();if(kind==='forbidden')edit(f.source,"ALTER TABLE messages ADD COLUMN secret_token TEXT; UPDATE messages SET secret_token='SYNTHETIC_PROHIBITED' WHERE id=2");
 const c=confirmation(f.source);if(kind==='wrong_type')c.old_secrets_absent='true';if(kind==='incomplete')delete c.generator;if(kind==='hash')c.source_sha256='0'.repeat(64);if(kind==='path')c.source_path=f.source+'-other';if(kind==='real')c.kind='inspected_real_data';
 const before=hash(f.source);await assert.rejects(()=>raw(f.source,f.staging,true,kind==='missing'?{}:{inputConfirmation:c}),/MIGRATION_INPUT_(UNCONFIRMED|HASH_MISMATCH|FORBIDDEN)/);assert.equal(hash(f.source),before);assert.deepEqual(readdirSync(f.dir),['source.db']);
});
test('G3 permitted synthetic content preserved, output and success/failure manifests exclude sentinel',async()=>{
 for(const fault of [undefined,'omit_synthetic_map']){const f=fixture(),sentinel='SYNTHETIC_CONTENT_'+randomUUID();const db=new Database(f.source);db.prepare('UPDATE messages SET content=? WHERE id=2').run(sentinel);db.close();const c=confirmation(f.source),before=hash(f.source);let output;
 try{output=await raw(f.source,f.staging,true,{inputConfirmation:c,faultAt:fault});}catch(e){assert.equal(fault,'omit_synthetic_map');output={code:e.message};}
 assert.ok(!JSON.stringify(output).includes(sentinel));assert.equal(hash(f.source),before);
 for(const file of readdirSync(f.dir).filter(x=>x.endsWith('.json')))assert.ok(!readFileSync(join(f.dir,file),'utf8').includes(sentinel));
 if(!fault){assert.equal(q(f.staging,'SELECT content FROM messages WHERE id=2')[0].content,sentinel);assert.deepEqual(output.input_confirmation,c);}
 }
});
