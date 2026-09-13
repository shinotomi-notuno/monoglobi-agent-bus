import Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,fsyncSync,existsSync,openSync,readFileSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {schemaVersion,type Row,type Scope} from './schema.js';
import {Store} from './store.js';
import {auditMigration} from './migrate.js';

export type RecoveryExpectation={origin_instance_uuid:string;schema_version:string;scope_json:string;key_fingerprint:string};
export type ReplacementOptions={writersStopped:boolean;sidecarHandled:boolean;clock?:()=>number;deadlineAt?:number;rename?:(from:string,to:string)=>void;stat?:(path:string)=>{dev:number;ino:number};afterWriterGate?:()=>void;checkpoint?:(stage:string)=>void};
export type ReceiptEvidence={origin_instance_uuid:string;actor:string;session_id:string;request_id:string;operation:string;input_digest:string};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const keyPath=(path:string)=>path+'.cursor-key.json';
const fileHash=(path:string)=>existsSync(path)?hash(readFileSync(path)):'';
const key=(path:string)=>JSON.parse(readFileSync(keyPath(path),'utf8')) as Row;
const auditRun=(db:Database.Database,path:string)=>{
 const runs=db.prepare('SELECT * FROM migration_runs').all() as Row[];
 const maps=(db.prepare('SELECT count(*) n FROM migration_map').get() as Row).n;
 const manifests=db.prepare('SELECT * FROM migration_manifests').all() as Row[];
 if(!runs.length&&!maps&&!manifests.length)return;
 if(runs.length!==1||runs[0]!.status!=='ready'||manifests.length!==1||manifests[0]!.run_id!==runs[0]!.run_id||
   manifests[0]!.source_hash!==runs[0]!.source_hash||!existsSync(runs[0]!.source_path)||!auditMigration(runs[0]!.source_path,path).ok)
   throw new Error('RECOVERY_REPLACE_REFUSED');
};
const auditTarget=(path:string)=>{const db=new Database(path,{readonly:true});try{const meta=db.prepare('SELECT instance_uuid,schema_version,ready,recovery_state FROM bus_meta').get() as Row|undefined;if(!meta||meta.schema_version!==schemaVersion||meta.ready!==1||meta.recovery_state!=='development_only'||(db.pragma('foreign_key_check') as Row[]).length)throw new Error('RECOVERY_REPLACE_REFUSED'); auditRun(db,path);const rows=db.prepare('SELECT source_table,source_id,target_table,target_id,source_path_sha256,source_content_sha256 FROM migration_map').all() as Row[];const unique=new Set(rows.map(r=>`${r.source_table}:${r.source_id}:${r.target_table}:${r.target_id}`));const run=db.prepare("SELECT source_path FROM migration_runs WHERE status='ready' ORDER BY started_at DESC LIMIT 1").get() as Row|undefined;const keys:Record<string,string>={tasks:'id',messages:'id',conversations:'conversation_id',task_conversation_versions:'link_version_id'};if(unique.size!==rows.length||rows.some(r=>![r.source_path_sha256,r.source_content_sha256].every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)))||rows.some(r=>!keys[r.target_table]||!db.prepare(`SELECT 1 FROM ${r.target_table} WHERE ${keys[r.target_table]}=?`).get(r.target_id))||(rows.length>0&&!run))throw new Error('RECOVERY_REPLACE_REFUSED');if(run&&(!existsSync(run.source_path)||!auditMigration(run.source_path,path).ok))throw new Error('RECOVERY_REPLACE_REFUSED');const sidecar=key(path);if(sidecar.instance!==meta.instance_uuid||typeof sidecar.key!=='string'||!/^[a-f0-9]{64}$/.test(sidecar.key))throw new Error('RECOVERY_REPLACE_REFUSED');return meta;}finally{db.close();}};
const manifest=(run_id:string,stage:string,code:string,paths:Record<string,string>)=>{const artifacts=Object.fromEntries(Object.entries(paths).map(([name,path])=>[name,{path,exists:existsSync(path),sha256:fileHash(path)}]));return {run_id,fault_stage:stage,code,artifacts,secret_included:false};};
const preserve=(stage:string,code:string,paths:Record<string,string>)=>{
 const run_id=randomUUID(),moved:Record<string,string>={},aliases=new Map<string,string>();
 for(const [name,path] of Object.entries(paths)){
  if(aliases.has(path)){moved[name]=aliases.get(path)!;continue;}
  if(existsSync(path)){const next=path+'.failed-'+run_id;renameSync(path,next);aliases.set(path,next);moved[name]=next;}
 }
 const record=manifest(run_id,stage,code,{...paths,...moved});
 const anchor=Object.values(moved)[0]??Object.values(paths)[0];
 writeFileSync(anchor+'.failure.json',JSON.stringify({...record,quarantine_path:anchor,artifact_paths:moved})+'\n',{mode:0o600});
 return {quarantine:anchor,manifest:anchor+'.failure.json',moved};
};
/** An interrupted replacement is never resumed automatically.  Validate its
 * state only to make the retained artifacts auditable before fixing read-only. */
const replacementStateIsConsistent=(path:string):boolean=>{
 try{
  const state=JSON.parse(readFileSync(path+'.replacement.json','utf8')) as Row;
  if(state.evidence?.candidates){
   const ev=state.evidence,found:Row={};
   for(const role of ['target','staging']){
    for(const suffix of ['', '_key']){
     const name=role+suffix,candidates=ev.candidates[name];
     if(!Array.isArray(candidates)||candidates.length!==2)return false;
     for(const candidate of candidates){
      if(typeof candidate!=='string'||resolve(candidate)!==candidate||dirname(candidate)!==dirname(path))return false;
      if(!existsSync(candidate))continue;
      const sha256=fileHash(candidate),expected=suffix?ev.before?.[role]?.key:ev.gates?.[role]?.sha256??ev.before?.[role]?.db;
      let committed=false;
      if(sha256!==expected&&!suffix){
       // A crash may occur after SQLite COMMIT but before its file hash is saved.
       // Verify the durable gate AND every other column before recording that hash.
       const db=new Database(candidate,{readonly:true,fileMustExist:true});
       try{
        const meta=db.prepare('SELECT ready,recovery_state FROM bus_meta').get() as Row;
        committed=meta.ready===0&&meta.recovery_state==='recovery_read_only'&&contentDigest(db)===ev[role]?.content;
       }finally{db.close();}
      }
      if(sha256===expected||committed){found[name]={path:candidate,sha256,commit_recovered:committed};break;}
     }
     if(!found[name])return false;
    }
   }
   saveState(path+'.replacement-inspection.json',{run_id:ev.run_id,stage:ev.stage,artifacts:found,secret_included:false});
   return true;
  }
  const paths=state.paths as Row,artifacts=state.artifacts as Row;
  if(!paths||typeof paths!=='object'||Array.isArray(paths)||!artifacts||typeof artifacts!=='object'||Array.isArray(artifacts)||
    !Object.keys(paths).length||Object.keys(paths).length!==Object.keys(artifacts).length)return false;
  return Object.entries(paths).every(([name,candidate])=>{
   const artifact=artifacts[name] as Row|undefined;
   if(typeof candidate!=='string'||!artifact||artifact.path!==candidate||typeof artifact.sha256!=='string')return false;
   if(!candidate)return artifact.sha256==='';
   return resolve(candidate)===candidate&&dirname(candidate)===dirname(path)&&/^[a-f0-9]{64}$/.test(artifact.sha256)&&fileHash(candidate)===artifact.sha256;
  });
 }catch{return false;}
};

/** Explicit recovery startup entrypoint: establish state before normal Store construction. */
export function openRecoveredStore(path:string,scope:Scope,expected:RecoveryExpectation):Store {recoverInstance(path,expected);return new Store(path,scope);}
/** Persist read-only for identity, key, scope, schema, and already-uncertain states. */
export function recoverInstance(path:string,expected:RecoveryExpectation):Row {
 path=resolve(path);
 const interrupted=existsSync(path+'.replacement.json');
 if(existsSync(path+'.replace.lock')&&!interrupted)throw new Error('RECOVERY_REPLACE_REFUSED');
 const replacementStateValid=!interrupted||replacementStateIsConsistent(path);
 if(!existsSync(path))return {read_only:true,code:'RECOVERY_RENAME_UNKNOWN'};
 const db=new Database(path,{fileMustExist:true});
 try{
  db.pragma('busy_timeout=0');
  return db.transaction(()=>{
   const meta=db.prepare('SELECT instance_uuid,schema_version,ready,recovery_state FROM bus_meta').get() as Row;
   const scopes=JSON.stringify((db.prepare('SELECT scope_key FROM scopes ORDER BY scope_id').all() as Row[]).map(x=>x.scope_key));
   let fingerprint='';
   try{const k=key(path);if(k.instance===meta.instance_uuid&&typeof k.key==='string'&&/^[a-f0-9]{64}$/.test(k.key))fingerprint=hash(k.key);}catch{/* fixed read-only below */}
   const unknown=meta.recovery_state==='recovery_outcome_unknown';
   if(interrupted||meta.ready!==1||meta.recovery_state!=='development_only'||meta.instance_uuid!==expected.origin_instance_uuid||meta.schema_version!==expected.schema_version||scopes!==expected.scope_json||fingerprint!==expected.key_fingerprint){
    if(meta.recovery_state==='development_only')db.prepare("UPDATE bus_meta SET ready=0,recovery_state='recovery_read_only'").run();
    return {read_only:true,code:unknown?'RECOVERY_OUTCOME_UNKNOWN':interrupted&&!replacementStateValid?'RECOVERY_RENAME_UNKNOWN':'RECOVERY_IDENTITY_MISMATCH'};
   }
   return {read_only:false,code:null};
  }).exclusive();
 }finally{db.close();}
}
export function markRecoveryOutcomeUnknown(path:string):Row {const db=new Database(resolve(path));try{db.prepare("UPDATE bus_meta SET ready=0,recovery_state='recovery_outcome_unknown'").run();return {read_only:true,code:'RECOVERY_OUTCOME_UNKNOWN'};}finally{db.close();}}
/** Marks uncertainty only when a supplied, prior operation's receipt is missing or malformed. */
export function detectMissingReceipt(path:string,evidence:ReceiptEvidence):Row {
 const db=new Database(resolve(path));
 try{
  const r=db.prepare('SELECT * FROM operation_receipts WHERE origin_instance_uuid=? AND actor=? AND request_id=?')
   .get(evidence.origin_instance_uuid,evidence.actor,evidence.request_id) as Row|undefined;
  const positive=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>0;
  let valid=!!r&&r.operation===evidence.operation&&/^[a-f0-9]{64}$/.test(evidence.input_digest??'')&&
   r.input_digest===evidence.input_digest&&r.executed_instance_uuid===evidence.origin_instance_uuid;
  try{
   if(r){
    const result=JSON.parse(r.result_json),secret=JSON.parse(r.secret_json);
    const object=(v:unknown)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
    valid=valid&&object(result)&&object(secret);
    if(evidence.operation==='register_v2')
     valid=valid&&positive(result?.registration_revision)&&positive(result?.registration_generation)&&
      positive(result?.session_revision)&&result?.actor===evidence.actor&&result?.session_id===evidence.session_id;
    else if(evidence.operation==='create_conversation_v2')
     valid=valid&&positive(result?.conversation_id)&&typeof result?.created==='boolean';
    else valid=false; // Unimplemented result contracts are outcome-unknown.
    valid=valid&&!!db.prepare('SELECT 1 FROM communication_events WHERE operation=? AND actor=? AND session_id=? AND request_id=? AND at=?')
     .get(evidence.operation,evidence.actor,evidence.session_id,evidence.request_id,r.committed_at);
   }
  }catch{valid=false;}
  if(!valid)return markRecoveryOutcomeUnknown(path);
  const meta=db.prepare('SELECT recovery_state FROM bus_meta').get() as Row;
  if(meta.recovery_state!=='development_only')return {read_only:true,code:meta.recovery_state==='recovery_outcome_unknown'?'RECOVERY_OUTCOME_UNKNOWN':'RECOVERY_IDENTITY_MISMATCH'};
  return {read_only:false,code:null};
 }finally{db.close();}
}


/** Hash all tables, including every bus_meta column except the two gate values.
 * Only digests are persisted; snapshots never expose receipt secrets or bodies. */
function contentDigest(db:Database.Database):string {
 const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all() as Row[];
 return hash(JSON.stringify(tables.map(t=>{
  const rows=db.prepare('SELECT * FROM "'+t.name.replaceAll('"','""')+'"').all() as Row[];
  for(const row of rows)if(t.name==='bus_meta'){row.ready=0;row.recovery_state='recovery_read_only';}
  return {schema:t,rows:rows.map(r=>JSON.stringify(r)).sort()};
 })));
}
function saveState(path:string,value:Row):void {
 const tmp=path+'.tmp',fd=openSync(tmp,'w',0o600);
 try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 renameSync(tmp,path);
}
function closeGate(db:Database.Database|undefined):void {
 if(!db)return;
 try{if(db.inTransaction)db.exec('ROLLBACK');}finally{db.close();}
}
/** Both copies are audited before either durable gate commits.
 * DELETE-journal only; no live SQLite connection is renamed. */
export function replaceStoppedTarget(target:string,staging:string,options:ReplacementOptions):Row {
 target=resolve(target);staging=resolve(staging);
 const {writersStopped,sidecarHandled,clock=()=>Date.now(),rename=renameSync,stat=statSync,
  afterWriterGate,checkpoint=()=>{}}=options;
 const lock=target+'.replace.lock',state=target+'.replacement.json',run_id=randomUUID();
 const refused=()=>{throw new Error('RECOVERY_REPLACE_REFUSED');};
 if(!writersStopped||!sidecarHandled||target===staging||dirname(target)!==dirname(staging)||
  !existsSync(target)||!existsSync(staging)||existsSync(lock)||existsSync(state)||
  stat(target).dev!==stat(staging).dev||stat(target).ino===stat(staging).ino)refused();
 for(const path of [target,staging])if(['-wal','-shm','-journal'].some(s=>existsSync(path+s)))refused();
 const started=clock(),limit=Math.min(options.deadlineAt??started+900000,started+900000);
 if(clock()>limit)throw new Error('MIGRATION_DEADLINE_EXCEEDED');
 const before={target:{db:fileHash(target),key:fileHash(keyPath(target))},
  staging:{db:fileHash(staging),key:fileHash(keyPath(staging))}};
 auditTarget(target);auditTarget(staging);
 const backup=target+'.backup-'+run_id;
 const paths:Record<string,string>={target,target_key:keyPath(target),staging,staging_key:keyPath(staging),backup,backup_key:keyPath(backup)};
 const evidence:Row={run_id,before,gates:{},history:[],candidates:{
  target:[target,backup],target_key:[keyPath(target),keyPath(backup)],
  staging:[staging,target],staging_key:[keyPath(staging),keyPath(target)]}};
 let fd:number|undefined,a:Database.Database|undefined,b:Database.Database|undefined,renaming=false;
 const save=(stage:string)=>{
  evidence.stage=stage;
  evidence.history.push({stage,paths:{...paths},hashes:Object.fromEntries(Object.entries(paths).map(([n,p])=>[n,fileHash(p)]))});
  saveState(state,{paths,evidence,artifacts:Object.fromEntries(Object.entries(paths).map(([n,p])=>[n,{path:p,sha256:fileHash(p)}]))});
 };
 try{
  fd=openSync(lock,'wx',0o600);
  a=new Database(target);b=new Database(staging);
  for(const db of [a,b]){
   db.pragma('busy_timeout=0');
   if(db.pragma('journal_mode',{simple:true})!=='delete')refused();
   try{db.exec('BEGIN EXCLUSIVE');}catch{refused();}
  }
  for(const [role,path,db] of [['target',target,a],['staging',staging,b]] as const){
   if(fileHash(path)!==before[role].db||fileHash(keyPath(path))!==before[role].key)refused();
   evidence[role]={content:contentDigest(db)};
  }
  save('audited');checkpoint('before_target_gate');
  a.prepare("UPDATE bus_meta SET ready=0,recovery_state='recovery_read_only'").run();
  if(contentDigest(a)!==evidence.target.content)refused();
  a.exec('COMMIT');a.close();a=undefined;
  checkpoint('target_commit_before_record');
  evidence.gates.target={path:target,sha256:fileHash(target)};
  save('target_gated');checkpoint('target_gated');
  b.prepare("UPDATE bus_meta SET ready=0,recovery_state='recovery_read_only'").run();
  if(contentDigest(b)!==evidence.staging.content)refused();
  b.exec('COMMIT');b.close();b=undefined;
  checkpoint('staging_commit_before_record');
  evidence.gates.staging={path:staging,sha256:fileHash(staging)};
  save('both_gated');checkpoint('both_gated');afterWriterGate?.();
  const verify=(role:'target'|'staging',path:string)=>{
   if(fileHash(path)!==evidence.gates[role].sha256||fileHash(keyPath(path))!==before[role].key)refused();
   const db=new Database(path,{readonly:true});
   try{const meta=db.prepare('SELECT ready,recovery_state FROM bus_meta').get() as Row;
    if(meta.ready!==0||meta.recovery_state!=='recovery_read_only'||contentDigest(db)!==evidence[role].content)refused();
   }finally{db.close();}
  };
  verify('target',target);verify('staging',staging);
  renaming=true;
  const moves=[['target',target,backup],['target_key',keyPath(target),keyPath(backup)],
   ['staging',staging,target],['staging_key',keyPath(staging),keyPath(target)]];
  for(let i=0;i<moves.length;i++){
   const [role,from,to]=moves[i]! as [string,string,string];
   save('before_rename_'+(i+1));checkpoint('before_rename_'+(i+1));
   rename(from,to);paths[role]=to;
   save('after_rename_'+(i+1));checkpoint('after_rename_'+(i+1));
   if(i===1&&clock()>limit)throw new Error('MIGRATION_DEADLINE_EXCEEDED');
  }
  verify('target',backup);verify('staging',target);
  if(!replacementStateIsConsistent(state.slice(0,-'.replacement.json'.length)))refused();
  checkpoint('verified');
  verify('target',backup);verify('staging',target);
  if(!replacementStateIsConsistent(target))refused();
  if(clock()>limit)throw new Error('MIGRATION_DEADLINE_EXCEEDED');
  const final=new Database(target);
  try{final.transaction(()=>{
   if(contentDigest(final)!==evidence.staging.content)refused();
   final.prepare("UPDATE bus_meta SET ready=1,recovery_state='development_only'").run();
  }).immediate();}finally{final.close();}
  save('activated');checkpoint('activated');
  saveState(target+'.replacement-completed.json',{paths,evidence});
  unlinkSync(state);
  return {target,backup,sidecar:keyPath(target),manifest:target+'.replacement-completed.json'};
 }catch(error){
  closeGate(a);a=undefined;closeGate(b);b=undefined;
  if(!renaming)throw error;
  // A supplied rename can move a file and then throw. Locate every surviving
  // role by its committed hash rather than relying on the last saved path.
  if(evidence.stage==='activated'&&existsSync(target)){
   const db=new Database(target);
   try{db.prepare("UPDATE bus_meta SET ready=0,recovery_state='recovery_read_only'").run();}
   finally{db.close();}
   evidence.gates.staging={path:target,sha256:fileHash(target)};
  }
  for(const role of ['target','staging']){
   for(const suffix of ['', '_key']){
    const expected=suffix?before[role as 'target'|'staging'].key:evidence.gates[role].sha256;
    const candidate=(evidence.candidates[role+suffix] as string[]).find(p=>existsSync(p)&&fileHash(p)===expected);
    if(candidate)paths[role+suffix]=candidate;
   }
  }
  const e=error instanceof Error?error:new Error('RECOVERY_RENAME_UNKNOWN');
  const kept=preserve('rename',e.message,{...paths,replacement_state:state});
  // Persist both audit and committed hashes alongside the relocated artifact paths.
  const m=JSON.parse(readFileSync(kept.manifest,'utf8'));
  saveState(kept.manifest,{...m,evidence});
  throw Object.assign(e,kept);
 }finally{
  closeGate(a);closeGate(b);
  if(fd!==undefined){closeSync(fd);unlinkSync(lock);}
 }
}
