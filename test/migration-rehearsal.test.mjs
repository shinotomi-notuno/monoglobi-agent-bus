import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {initializeLegacySchema} from '../dist/db.js';
import {auditMigration} from '../dist/v2/migrate.js';
import {migrateStoppedCopy} from './helpers/synthetic-migration.mjs';

const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'ab25-t02-')),source=join(dir,'source.db'),target=join(dir,'target.db');
  const db=new Database(source);initializeLegacySchema(db);
  db.exec("INSERT INTO agents(name,registered_at,last_seen,project,session_id) VALUES('a',1,1,'p','s-a');");
  db.exec("INSERT INTO tasks(title,thread_id,requested_by,state,created_at,updated_at,project) VALUES('work','task-thread','a','open',1,1,'p');");
  db.exec("INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project) VALUES('a','a','msg','task body','pending',1,'task-thread','p');");
  db.exec("INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project) VALUES('a','a','msg','H01 body','pending',2,NULL,'p');");
  db.exec("INSERT INTO memories(by_agent,kind,content,task_id,thread_id,project,created_at,updated_at) VALUES('a','summary','link',NULL,NULL,'p',1,1);");
  db.close();return {dir,source,target};
}

test('T02 copy-only records run/manifest, H01 provenance and audit reachability',async()=>{
  const f=fixture(),before=hash(f.source),report=await migrateStoppedCopy(f.source,f.target,true);
  assert.equal(hash(f.source),before);assert.equal(report.ready,true,JSON.stringify(report));
  const db=new Database(f.target,{readonly:true});
  assert.equal(db.prepare('SELECT count(*) n FROM migration_runs').get().n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM migration_manifests').get().n,1);
  const h=db.prepare("SELECT * FROM migration_map WHERE classification='synthetic_conversation'").get();
  assert.ok(h);assert.equal(h.source_table,'messages');assert.equal(h.basis,'source_thread_null');
  assert.equal(h.source_scope_key,h.target_scope_key);assert.match(h.source_content_sha256,/^[a-f0-9]{64}$/);assert.ok(JSON.parse(h.audit_ref).table);
  assert.equal(db.prepare('SELECT count(*) n FROM messages WHERE thread_id IS NULL AND conversation_id IS NOT NULL').get().n,1);db.close();
  assert.deepEqual(auditMigration(f.source,f.target),{ok:true,issues:[],map_count:5});
});

test('T02 audit detects source hash drift, missing map and scope mismatch without repair',async()=>{
  const f=fixture();await migrateStoppedCopy(f.source,f.target,true);
  let db=new Database(f.target);db.prepare("DELETE FROM migration_map WHERE source_table='tasks'").run();db.prepare("UPDATE migration_map SET target_scope_key='[\\\"other\\\",null,null]' WHERE source_table='messages' AND target_table='messages'").run();db.close();
  db=new Database(f.source);db.prepare("UPDATE messages SET content='tampered' WHERE id=1").run();db.close();
  const audit=auditMigration(f.source,f.target);assert.ok(audit.issues.some(x=>x.code==='MAP_MISSING'));assert.ok(audit.issues.some(x=>x.code==='SOURCE_HASH_MISMATCH'));assert.ok(audit.issues.some(x=>x.code==='SCOPE_MISMATCH'));
});

test('T02 duplicate map is rejected and each transformed row is transactionally paired',async()=>{
  const f=fixture();await migrateStoppedCopy(f.source,f.target,true);const db=new Database(f.target);
  const row=db.prepare("SELECT * FROM migration_map WHERE source_table='messages' AND target_table='messages'").get();
  assert.throws(()=>db.prepare(`INSERT INTO migration_map(source_table,source_id,target_table,target_id,classification,basis,source_path_sha256,source_content_sha256,source_scope_key,target_scope_key,audit_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(row.source_table,row.source_id,row.target_table,row.target_id,'duplicate','x',row.source_path_sha256,row.source_content_sha256,row.source_scope_key,row.target_scope_key,'{}'),/UNIQUE/);db.close();
});

test('T02 mid-transform fault quarantines incomplete target and preserves input',async()=>{
  const f=fixture(),before=hash(f.source);await assert.rejects(()=>migrateStoppedCopy(f.source,f.target,true,{faultAt:'after_message_map'}),/MIGRATION_FAULT_AFTER_MESSAGE_MAP/);
  assert.equal(hash(f.source),before);assert.equal(readdirSync(f.dir).some(x=>x.startsWith('target.db.failed-')),true);assert.equal(readdirSync(f.dir).includes('target.db'),false);assert.equal(readdirSync(f.dir).includes('target.db.migration.json'),false);
});

test('H01-01 normal thread maps to the existing scoped Conversation',async()=>{
  const f=fixture();const r=await migrateStoppedCopy(f.source,f.target,true);assert.equal(r.ready,true);assert.ok(r.h01_audit.ok);
});
test('H01-02 NULL thread creates a synthetic Conversation with provenance',async()=>{
  const f=fixture();const r=await migrateStoppedCopy(f.source,f.target,true);assert.equal(r.ready,true);assert.equal(r.h01_audit.ok,true);
  const db=new Database(f.target,{readonly:true});const row=db.prepare("SELECT classification,basis,source_path_sha256,source_content_sha256 FROM migration_map WHERE classification='synthetic_conversation'").get();assert.equal(row.basis,'source_thread_null');assert.match(row.source_path_sha256,/^[a-f0-9]{64}$/);assert.match(row.source_content_sha256,/^[a-f0-9]{64}$/);db.close();
});
test('H01-03 cross-scope same thread is rejected and quarantined',async()=>{
  const f=fixture();const db=new Database(f.source);db.prepare("UPDATE messages SET project='other' WHERE id=1").run();db.close();await assert.rejects(()=>migrateStoppedCopy(f.source,f.target,true),/MIGRATION_FINAL_AUDIT_FAILED/);assert.equal(existsSync(f.target),false);const q=readdirSync(f.dir).find(x=>x.includes('.failed-')&&x.endsWith('.failure.json'));assert.ok(q);const m=JSON.parse(readFileSync(join(f.dir,q),'utf8'));assert.equal(m.secret_included,false);assert.equal(m.fault_stage,'final-audit');
});
test('H01-04 missing map is detected by final audit',async()=>{
  const f=fixture();await assert.rejects(()=>migrateStoppedCopy(f.source,f.target,true,{faultAt:'omit_message_map'}),/MIGRATION_FINAL_AUDIT_FAILED/);assert.equal(existsSync(f.target),false);
});
test('H01-05 duplicate map is reported by audit',async()=>{
  const f=fixture();await migrateStoppedCopy(f.source,f.target,true);const db=new Database(f.target);db.exec('CREATE TABLE migration_map_copy AS SELECT * FROM migration_map; DROP TABLE migration_map; ALTER TABLE migration_map_copy RENAME TO migration_map;');const row=db.prepare("SELECT * FROM migration_map WHERE source_table='messages' AND target_table='messages'").get();db.prepare('INSERT INTO migration_map SELECT * FROM migration_map WHERE source_table=? AND source_id=? LIMIT 1').run(row.source_table,row.source_id);db.close();const a=auditMigration(f.source,f.target);assert.ok(a.issues.some(x=>x.code==='MAP_DUPLICATE'));
});
test('H01-06 source/content hash differences are separately surfaced',async()=>{
  const f=fixture();await migrateStoppedCopy(f.source,f.target,true);let db=new Database(f.target);db.prepare("UPDATE migration_map SET source_path_sha256='bad' WHERE source_table='tasks'").run();db.close();db=new Database(f.source);db.prepare("UPDATE messages SET content='changed' WHERE id=1").run();db.close();const a=auditMigration(f.source,f.target);assert.ok(a.issues.some(x=>x.code==='SOURCE_PATH_HASH_MISMATCH'));assert.ok(a.issues.some(x=>x.code==='SOURCE_HASH_MISMATCH'));
});
test('H01-07 unsupported conversion produces an issue and quarantine',async()=>{
  const f=fixture();const db=new Database(f.source);db.prepare("INSERT INTO memories(by_agent,kind,content,task_id,thread_id,project,created_at,updated_at) VALUES('a','unknown_kind','x',NULL,'task-thread','p',1,1)").run();db.close();await assert.rejects(()=>migrateStoppedCopy(f.source,f.target,true),/MIGRATION_FINAL_AUDIT_FAILED/);assert.equal(existsSync(f.target),false);
});
test('H01-08 mid-transform failure preserves a non-secret failure manifest',async()=>{
  const f=fixture();await assert.rejects(()=>migrateStoppedCopy(f.source,f.target,true,{faultAt:'after_message_map'}),/MIGRATION_FAULT_AFTER_MESSAGE_MAP/);const q=readdirSync(f.dir).find(x=>x.endsWith('.failure.json'));assert.ok(q);const m=JSON.parse(readFileSync(join(f.dir,q),'utf8'));assert.ok(m.run_id&&m.source_hash&&m.quarantine_path&&m.fault_stage);assert.equal(m.secret_included,false);
});
test('T02 deadline is injectable through clock and leaves only quarantine',async()=>{
  const f=fixture();let n=0;await assert.rejects(()=>migrateStoppedCopy(f.source,f.target,true,{clock:()=>++n,deadlineAt:1}),/MIGRATION_DEADLINE_EXCEEDED/);assert.equal(existsSync(f.target),false);assert.ok(readdirSync(f.dir).some(x=>x.endsWith('.failure.json')));
});
