#!/usr/bin/env node
/** Offline administration only. Expectations are supplied by the operator's
 * trusted pre-incident record, never derived from the damaged target. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {z} from 'zod';
import {scopeKey} from './schema.js';
import {recoverInstance,detectMissingReceipt,replaceStoppedTarget} from './recovery.js';
import {recoveryEntryError} from './recovery-entry.js';
const text=z.string().min(1).regex(/\S/),digest=z.string().regex(/^[a-f0-9]{64}$/);
const expected=z.object({origin_instance_uuid:text,schema_version:text,scope_json:text,key_fingerprint:digest}).strict()
 .refine(e=>{try{const keys=JSON.parse(e.scope_json);return Array.isArray(keys)&&keys.length>0&&new Set(keys).size===keys.length&&keys.every(k=>{if(typeof k!=='string')return false;const a=JSON.parse(k);return Array.isArray(a)&&a.length===3&&scopeKey({project:a[0],area:a[1],team:a[2]})===k;});}catch{return false;}},'INVALID_SCOPE_RECORD');
const receipt=z.object({origin_instance_uuid:text,actor:text,session_id:text,request_id:text,operation:text,input_digest:digest}).strict();
const target=z.object({path:text,expected,receipts:z.array(receipt).max(1000)}).strict()
 .refine(t=>t.receipts.every(r=>r.origin_instance_uuid===t.expected.origin_instance_uuid),'INCONSISTENT_ORIGIN');
const common={writersStopped:z.literal(true),sidecarHandled:z.literal(true),deadlineAt:z.number().int().safe().nonnegative()};
const inspect=z.object({...common,target}).strict();
const replace=z.object({...common,target,staging:target}).strict();
type Target=z.infer<typeof target>;
const started=Date.now();
function check(t:Target,deadline:number){
 if(Date.now()>deadline)throw new Error('MIGRATION_DEADLINE_EXCEEDED');
 const state=recoverInstance(t.path,t.expected);
 if(state.read_only)return state;
 for(const evidence of t.receipts){
  if(Date.now()>deadline)throw new Error('MIGRATION_DEADLINE_EXCEEDED');
  const outcome=detectMissingReceipt(t.path,evidence);if(outcome.read_only)return outcome;
 }
 if(Date.now()>deadline)throw new Error('MIGRATION_DEADLINE_EXCEEDED');
 return state;
}
try{
 const [command,file,...extra]=process.argv.slice(2);
 if(!file||extra.length||!['inspect','replace'].includes(command??''))throw new Error('INVALID_INPUT');
 // Strictly validate the WHOLE document before touching any database.
 const parsed=(command==='inspect'?inspect:replace).safeParse(JSON.parse(readFileSync(file,'utf8')));
 if(!parsed.success)throw new Error('INVALID_INPUT');
 const plan=parsed.data as z.infer<typeof inspect>&{staging?:Target},deadline=Math.min(plan.deadlineAt,started+900000);
 if(command==='replace'&&plan.staging&&resolve(plan.target.path)===resolve(plan.staging.path))throw new Error('INVALID_INPUT');
 const first=check(plan.target,deadline);
 if(first.read_only){process.stdout.write(JSON.stringify(first)+'\n');process.exitCode=2;}
 else if(command==='inspect')process.stdout.write(JSON.stringify({read_only:false,code:null,production_ready:false})+'\n');
 else if(plan.staging){
  const second=check(plan.staging,deadline);
  if(second.read_only){process.stdout.write(JSON.stringify(second)+'\n');process.exitCode=2;}
  else {
   const result=replaceStoppedTarget(plan.target.path,plan.staging.path,{writersStopped:true,sidecarHandled:true,deadlineAt:deadline});
   process.stdout.write(JSON.stringify({read_only:false,code:null,production_ready:false,...result})+'\n');
  }
 }
}catch(error){
 const code=recoveryEntryError(error);
 process.stdout.write(JSON.stringify({read_only:true,code})+'\n');
 process.exitCode=code==='INVALID_INPUT'?64:2;
}
