import Database from 'better-sqlite3';
import {openSync,closeSync,writeFileSync,existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {installSchema,installGuards,scopeId,scopeKey,type Scope,type Row} from './schema.js';

/** Development target creation only. Never overwrite a DB or infer readiness of existing data. */
export function initializeTarget(path:string,scopes:Scope[]):Row {
 if(!Array.isArray(scopes)||!scopes.length)throw new Error('EXPLICIT_SCOPE_REQUIRED');
 for(const scope of scopes)scopeKey(scope);
 path=resolve(path);
 for(const suffix of ['', '-wal','-shm','.cursor-key.json','.migration.json'])if(existsSync(path+suffix))throw new Error('NEW_TARGET_REQUIRED');
 closeSync(openSync(path,'wx',0o600));
 const db=new Database(path);
 try {
  db.transaction(()=>{installSchema(db);for(const scope of scopes)scopeId(db,scope);installGuards(db);db.prepare('UPDATE bus_meta SET ready=1').run();}).immediate();
  const meta=db.prepare('SELECT * FROM bus_meta').get() as Row;
  writeFileSync(path+'.cursor-key.json',JSON.stringify({instance:meta.instance_uuid,key_id:'1',key:randomBytes(32).toString('hex')}),{flag:'wx',mode:0o600});
  return {path,instance_uuid:meta.instance_uuid,schema:meta.schema_version,api_version:meta.api_version,ready:true,production_ready:false};
 }finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try {
  if(process.argv.length!==4)throw new Error('Usage: node dist/v2/initialize.js NEW_DB_PATH JSON_SCOPE_ARRAY');
  process.stdout.write(JSON.stringify(initializeTarget(process.argv[2]!,JSON.parse(process.argv[3]!)))+'\n');
 }catch(error){process.stderr.write((error as Error).message+'\n');process.exitCode=1;}
}
