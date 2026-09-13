import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {initializeTarget} from '../dist/v2/initialize.js';
import {Registration} from '../dist/v2/registration.js';
import {Queries} from '../dist/v2/queries.js';
import {ToolRuntime} from '../dist/v2/tool-runtime.js';
import {initializeLegacySchema} from '../dist/db.js';
import {migrateStoppedCopy} from './helpers/synthetic-migration.mjs';
import Database from 'better-sqlite3';
const root=mkdtempSync(join(tmpdir(),'ab24-public-')),scope={project:'p',area:null,team:null};let seq=0;
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
async function connect(path,enabled=true){const client=new Client({name:'T03a-sdk',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/v2/server.js')],env:{...process.env,AGENT_BUS_V2_DB:path,AGENT_BUS_V2_SCOPE:JSON.stringify(scope),AGENT_BUS_V2_WRITERS:enabled?'1':'0'}}));return client;}
async function fixture(){const path=join(root,`${seq++}.db`),meta=initializeTarget(path,[scope,{...scope,project:'other'}]),client=await connect(path);
 const env=(actor='a',session_id=actor+'1',request_id=randomUUID())=>({origin_instance_uuid:meta.instance_uuid,actor,session_id,request_id});
 const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});const value=JSON.parse(r.content[0].text);assert.ok(!r.isError,JSON.stringify(value));return value;};
 const bad=async(name,args,code)=>{const r=await client.callTool({name,arguments:args});assert.equal(r.isError,true);const value=JSON.parse(r.content[0].text);assert.equal(value.code,code);return value;};
 const register=(actor='a',session_id=actor+'1',revision=0)=>call('register_v2',{role:'worker',provider:'test',expected_registration_revision:revision,envelope:env(actor,session_id)});
 return {path,meta,client,env,call,bad,register};}
const counts=db=>Object.fromEntries(['tasks','messages','operation_receipts','communication_events'].map(t=>[t,db.prepare(`SELECT count(*) n FROM ${t}`).get().n]));

test('F24-T02-01 Agent updated_at reflects status update, representative Session is labeled',()=>{
 const path=join(root,`${seq++}.db`),meta=initializeTarget(path,[scope]);let now=1000;const s=new Registration(path,scope,{now:()=>now}),q=new Queries(path,scope);
 const e=(session_id='s')=>({origin_instance_uuid:meta.instance_uuid,actor:'a',session_id,request_id:randomUUID()});
 s.register({role:'techlead',provider:'codex',expected_registration_revision:0},e());const task=s.createTask({title:'work'},e());s.assignTask({task_id:task.task_id,expected_task_revision:0,to_agent:'a'},e());
 now=2000;s.setAgentStatus({actor:'a',expected_registration_revision:1,status:'working'},e());
 let row=q.statusSummary({task_id:task.task_id}).tasks[0];assert.equal(row.recorded_agent.updated_at,2000);assert.equal(row.recorded_agent.registered_at,1000);assert.equal(row.agent_liveness,'not_inferred');assert.match(row.agent_session_selection,/not_all_sessions/);assert.equal(row.recorded_agent.last_seen,undefined);
 now=3000;s.register({role:'techlead',provider:'codex',expected_registration_revision:2},e('second'));row=q.statusSummary({task_id:task.task_id}).tasks[0];assert.equal(row.recorded_agent.session_id,'second');assert.equal(row.recorded_agent.session_registered_at,3000);assert.equal(row.recorded_agent.updated_at,3000);q.close();s.close();
});
test('SDK manifest contains exact recursive schemas, optional writer mode and no pending wrappers',async()=>{
 const f=await fixture();try{const list=await f.client.listTools(),caps=await f.call('v2_capabilities');assert.equal(list.tools.length,45);assert.equal(caps.production_ready,false);assert.deepEqual(caps.pending_tools,[]);assert.ok(!caps.unavailable.includes('mcp-writers'));
 for(const tool of list.tools)assert.deepEqual(tool.inputSchema,caps.public_tools.find(x=>x.name===tool.name).input_schema);
 const update=list.tools.find(x=>x.name==='update_task_v2').inputSchema;assert.equal(update.properties.patch.additionalProperties,false);assert.equal(update.properties.patch.properties.claimed_by,undefined);assert.equal(update.properties.envelope.additionalProperties,false);
 assert.deepEqual(list.tools.find(x=>x.name==='send_message_v2').inputSchema.properties.task_id.anyOf,[{type:'integer',minimum:1},{type:'null'}]);
 const evidence=list.tools.find(x=>x.name==='resolve_task_wait_v2').inputSchema.properties.evidence_refs;assert.equal(evidence.minItems,1);assert.equal(evidence.maxItems,16);assert.equal(evidence.items.additionalProperties,false);
 await assert.rejects(()=>f.client.callTool({name:'unimplemented_tool',arguments:{}}),e=>e.code===-32602&&e.data.tool==='unimplemented_tool');
 }finally{await f.client.close();}
 const before=hash(f.path),r=await connect(f.path,false);try{assert.equal((await r.listTools()).tools.length,12);const caps=JSON.parse((await r.callTool({name:'v2_capabilities',arguments:{}})).content[0].text);assert.ok(caps.unavailable.includes('mcp-writers'));}finally{await r.close();}assert.equal(hash(f.path),before);
});
test('SDK formal registration through direct consultation and Human wait/answer/explicit resume, replay across reconnect',async()=>{
 const f=await fixture();try{
 await f.register();await f.register('b');await f.register('human');
 const task=await f.call('create_task_v2',{title:'work',envelope:f.env()}),conv=await f.call('create_conversation_v2',{thread_id:'thread',envelope:f.env()});
 const askArgs={to:'b',content:'technical consultation',task_id:task.task_id,conversation_id:conv.conversation_id,envelope:f.env()};const ask=await f.call('ask_async_v2',askArgs);
 // Successful response deliberately ignored; reconnect and retry the saved request identity.
 await f.client.close();f.client=await connect(f.path);const replay=JSON.parse((await f.client.callTool({name:'ask_async_v2',arguments:askArgs})).content[0].text);assert.equal(replay.message_id,ask.message_id);assert.equal(replay.replayed,true);
 // helper captures initial client; use the reopened transport for the remaining sequence.
 const call=async(name,args)=>{const r=await f.client.callTool({name,arguments:args});assert.ok(!r.isError,r.content[0].text);return JSON.parse(r.content[0].text);};
 const preview=await call('preview_messages_v2',{envelope:f.env('b')});assert.equal(preview.items.length,1);assert.equal(preview.items[0].token,undefined);
 const c=(await call('claim_messages_v2',{lease_ms:1000,limit:1,envelope:f.env('b')})).items[0];
 const a=(await call('ack_v2',{message_id:c.message_id,generation:c.generation,token:c.token,envelope:f.env('b')})).items[0];
 await call('reply_v2',{message_id:ask.message_id,reply_generation:a.reply_generation,reply_token:a.reply_token,content:'technical answer',envelope:f.env('b')});
 const human=await call('ask_async_v2',{...askArgs,to:'human',content:'PM question',envelope:f.env()});
 await call('update_task_v2',{task_id:task.task_id,expected_task_revision:0,patch:{state:'blocked',wait_kind:'human',blocked_reason:'PM decision',human_question_id:human.message_id},envelope:f.env()});
 const h=(await call('receive_immediate_v2',{limit:1,envelope:f.env('human')})).items[0];await call('reply_v2',{message_id:h.message_id,reply_generation:h.reply_generation,reply_token:h.reply_token,content:'PM answer recorded by agent',envelope:f.env('human')});
 let summary=await call('status_summary_v2',{task_id:task.task_id});assert.equal(summary.tasks[0].wait_description,'回答済み・未復帰');assert.equal(summary.tasks[0].state,'blocked');
 await call('update_task_v2',{task_id:task.task_id,expected_task_revision:1,patch:{state:'working',clear_wait:true},envelope:f.env()});summary=await call('status_summary_v2',{task_id:task.task_id});assert.equal(summary.tasks[0].wait_kind,'none');
 }finally{await f.client.close();}
});
test('SDK strict input, scope/origin/identity/revision validation and structured Errors preserve business state',async()=>{
 const f=await fixture();try{await f.register();const taskEnvelope=f.env(),task=await f.call('create_task_v2',{title:'work',envelope:taskEnvelope}),s=new Registration(f.path,scope),before=counts(s.db);
 await f.bad('create_task_v2',{title:'different',envelope:taskEnvelope},'REQUEST_ID_REUSE');
 await f.bad('create_conversation_v2',{thread_id:'different-operation',envelope:taskEnvelope},'REQUEST_ID_REUSE');
 await f.bad('update_task_v2',{task_id:task.task_id,expected_task_revision:0,patch:{claimed_by:'a'},envelope:f.env()},'TASK_FIELD_REQUIRES_WRAPPER');
 await f.bad('update_task_v2',{task_id:task.task_id,expected_task_revision:9,patch:{priority:2},envelope:f.env()},'REVISION_CONFLICT');
 await f.bad('create_task_v2',{title:'x',envelope:{...f.env(),origin_instance_uuid:'old'}},'RECOVERY_OUTCOME_UNKNOWN');
 await f.bad('create_task_v2',{title:'x',envelope:f.env('a','unregistered')},'SESSION_SCOPE_MISMATCH');
 await f.bad('create_task_v2',{title:'secret',envelope:f.env(),scope:{project:'other'}},'INVALID_INPUT');
 const other=new Registration(f.path,{...scope,project:'other'});other.register({role:'worker',provider:'test',expected_registration_revision:0},f.env('other','outside'));const tc=other.createTask({title:'elsewhere'},f.env('other','outside'));other.close();
 await f.bad('update_task_v2',{task_id:tc.task_id,expected_task_revision:0,patch:{priority:2},envelope:f.env()},'TARGET_NOT_FOUND');
 const after=counts(s.db);assert.equal(after.messages,before.messages);assert.equal(after.tasks,before.tasks+1);assert.equal(after.operation_receipts,before.operation_receipts+2);
 const errors=await f.call('list_errors_v2');assert.ok(errors.items.length>=5);assert.ok(!JSON.stringify(errors).includes('"secret"'));
 await f.call('record_error_v2',{task_id:task.task_id,envelope:f.env()});s.close();
 }finally{await f.client.close();}
});
test('SDK links correction/replacement preserve relation revisions and immutable membership',async()=>{
 const f=await fixture();try{await f.register();const t=await f.call('create_task_v2',{title:'work',envelope:f.env()}),c=await f.call('create_conversation_v2',{thread_id:'c',envelope:f.env()}),d=await f.call('create_conversation_v2',{thread_id:'d',envelope:f.env()});
 const link=await f.call('link_conversation_v2',{task_id:t.task_id,conversation_id:c.conversation_id,expected_relation_revision:0,envelope:f.env()});
 const corrected=await f.call('correct_link_v2',{link_version_id:link.link_version_id,action:'revise',reason:'reference',expected_relation_revision:1,envelope:f.env()});
 await f.call('replace_link_v2',{link_version_id:corrected.link_version_id,new_task_id:t.task_id,new_conversation_id:d.conversation_id,reason:'changed reference',expected_relation_revision:2,envelope:f.env()});
 const links=await f.call('list_task_conversations_v2',{task_id:t.task_id});assert.equal(links.items.length,1);assert.equal(links.items[0].conversation_id,d.conversation_id);
 }finally{await f.client.close();}
});
test('SDK revoke, generation/lease rejection, explicit transfer and retired registration replay',async()=>{
 const f=await fixture();try{const re=f.env(),reg={role:'worker',provider:'test',expected_registration_revision:0,envelope:re};await f.call('register_v2',reg);await f.register('b');
 const conv=await f.call('create_conversation_v2',{thread_id:'c',envelope:f.env()});const msg=await f.call('ask_async_v2',{to:'b',content:'Q',task_id:null,conversation_id:conv.conversation_id,envelope:f.env()});
 const claimArgs={limit:1,lease_ms:1000,envelope:f.env('b')},c=(await f.call('claim_messages_v2',claimArgs)).items[0];
 await f.bad('ack_v2',{message_id:c.message_id,generation:c.generation+1,token:c.token,envelope:f.env('b')},'STALE_CLAIM');
 await f.bad('ack_v2',{message_id:c.message_id,generation:c.generation,token:null,envelope:f.env('b')},'TOKEN_REQUIRED');
 const r=new Registration(f.path,scope);r.db.prepare('UPDATE bus_meta SET lease_clock_ms=?').run(Date.now()+100000);r.close();
 await f.bad('ack_v2',{message_id:c.message_id,generation:c.generation,token:c.token,envelope:f.env('b')},'LEASE_EXPIRED');
 const a=(await f.call('receive_immediate_v2',{limit:1,envelope:f.env('b')})).items[0];
 await f.call('revoke_session_v2',{target_session_id:'b1',expected_session_revision:1,reason:'end',evidence_ref:'artifact:end',envelope:f.env()});
 const replay=await f.call('claim_messages_v2',claimArgs);assert.equal(replay.items[0].token,undefined);assert.equal(replay.session_active_now,false);
 await f.register('b','b2',1);const tr=await f.call('transfer_reply_authority_v2',{message_id:msg.message_id,new_session_id:'b2',expected_reply_generation:a.reply_generation,prior_holder_session:'b1',termination_evidence_ref:'artifact:end',envelope:f.env('b','b2')});assert.equal(tr.items[0].reply_generation,2);
 await f.call('set_agent_status_v2',{actor:'b',expected_registration_revision:2,status:'working',envelope:f.env()});await f.call('remove_agent_v2',{actor:'b',expected_registration_revision:3,reason:'end',evidence_ref:'artifact:end',envelope:f.env()});
 const retired=await f.call('retire_team_v2',{expected_revision:1,reason:'end',evidence_ref:'artifact:end',envelope:f.env()});assert.match(retired.notice,/cannot resume/);assert.equal((await f.call('register_v2',reg)).replayed,true);
 await f.bad('register_v2',{role:'worker',provider:'test',expected_registration_revision:1,envelope:f.env('a','a2')},'REGISTRATION_RETIRED');
 }finally{await f.client.close();}
});
test('enabled SDK in read_only never writes even invalid writer requests and preview',async()=>{
 const f=await fixture();await f.register();await f.client.close();const s=new Registration(f.path,scope);s.db.exec("UPDATE bus_meta SET recovery_state='recovery_read_only'");s.close();const before=hash(f.path),c=await connect(f.path);
 try{for(const [name,args] of [['create_task_v2',{title:'x',envelope:f.env()}],['register_v2',{role:'worker',provider:'test',expected_registration_revision:0,envelope:f.env('b')}],['create_task_v2',{unknown:'sensitive'}]])assert.equal((await c.callTool({name,arguments:args})).isError,true);
 assert.ok(!(await c.callTool({name:'preview_messages_v2',arguments:{envelope:f.env()}})).isError);await c.callTool({name:'status_summary_v2',arguments:{}});
 }finally{await c.close();}assert.equal(hash(f.path),before);
});
test('SDK U01 is the only ready=false mutation exception; current_ready and replay are explicit',async()=>{
 const source=join(root,`u01-${seq++}-source.db`),path=source.replace('source','target'),db=new Database(source);initializeLegacySchema(db);db.exec("INSERT INTO agents(name,registered_at,last_seen,project,session_id) VALUES('a',1,1,'p','a1'); INSERT INTO tasks(title,thread_id,requested_by,state,created_at,updated_at,project) VALUES('work','t','a','open',1,1,'p'); INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project) VALUES('a','a','msg','reference','delivered',1,'t','p')");db.close();await migrateStoppedCopy(source,path,true);const seed=new Database(path);const iid=Number(seed.prepare("INSERT INTO migration_issues(source_table,source_id,code,detail) VALUES('tasks',1,'WAIT_UNCLASSIFIED','test fixture')").run().lastInsertRowid);seed.prepare("UPDATE tasks SET state='blocked',blocked_reason='unclassified',wait_kind='unknown',migration_issue_id=? WHERE id=1").run(iid);seed.prepare('UPDATE bus_meta SET ready=0').run();seed.close();
 const s=new Registration(path,scope),meta=s.capabilities(),issue=s.db.prepare("SELECT issue_id FROM migration_issues WHERE code='WAIT_UNCLASSIFIED'").get().issue_id;s.close();const c=await connect(path),e={origin_instance_uuid:meta.instance_uuid,actor:'a',session_id:'a1',request_id:randomUUID()},args={task_id:1,expected_task_revision:0,issue_id:issue,wait_kind:'technical',blocked_reason:'verified',evidence_refs:[{table:'tasks',id:1}],envelope:e};
 try{const rejected=await c.callTool({name:'create_task_v2',arguments:{title:'not ready',envelope:{...e,request_id:randomUUID()}}});assert.equal(JSON.parse(rejected.content[0].text).code,'MIGRATION_ISSUES_READ_ONLY');
 const out=await c.callTool({name:'resolve_task_wait_v2',arguments:args});assert.ok(!out.isError,out.content[0].text);assert.equal(JSON.parse(out.content[0].text).current_ready,true);
 assert.equal(JSON.parse((await c.callTool({name:'resolve_task_wait_v2',arguments:args})).content[0].text).replayed,true);
 }finally{await c.close();}
});
test('SDK U01 legacy blocked input is quarantined with its migration issue',async()=>{
 const source=join(root,`u01-isolation-${seq++}-source.db`),target=source.replace('source','target'),db=new Database(source);initializeLegacySchema(db);db.exec("INSERT INTO agents(name,registered_at,last_seen,project,session_id) VALUES('a',1,1,'p','a1'); INSERT INTO tasks(title,thread_id,requested_by,state,blocked_reason,created_at,updated_at,project) VALUES('work','t','a','blocked','unclassified',1,1,'p'); INSERT INTO messages(from_agent,to_agent,kind,content,status,created_at,thread_id,project) VALUES('a','a','msg','reference','delivered',1,'t','p')");db.close();const before=hash(source);await assert.rejects(()=>migrateStoppedCopy(source,target,true),/MIGRATION_FINAL_AUDIT_FAILED/);assert.equal(hash(source),before);assert.equal(existsSync(target),false);const failure=readdirSync(root).find(x=>x.startsWith(target.split('/').pop()+'.failed-')&&x.endsWith('.failure.json'));assert.ok(failure);const manifest=JSON.parse(readFileSync(join(root,failure),'utf8'));assert.equal(manifest.quarantine_path,`${target}.failed-${manifest.run_id}`);assert.equal(existsSync(manifest.quarantine_path),true);assert.equal(existsSync(target+'.migration.json'),false);const failed=new Database(manifest.quarantine_path,{readonly:true});assert.ok(failed.prepare("SELECT count(*) n FROM migration_issues WHERE code='WAIT_UNCLASSIFIED'").get().n>0);assert.equal(failed.prepare('SELECT count(*) n FROM migration_manifests').get().n,0);assert.equal(failed.prepare('SELECT count(*) n FROM operation_receipts').get().n,0);failed.close();
});
test('CLI uses exact schema/core receipts; rejects unknown fields and displays retirement consequences',()=>{
 const path=join(root,`${seq++}.db`),meta=initializeTarget(path,[scope]),file=join(root,'request.json'),env={actor:'a',session_id:'a1',request_id:randomUUID(),origin_instance_uuid:meta.instance_uuid};
 const run=(tool,args)=>{writeFileSync(file,JSON.stringify(args),{mode:0o600});return spawnSync(process.execPath,['dist/v2/cli.js',path,JSON.stringify(scope),tool,file],{encoding:'utf8'});};
 const args={role:'techlead',provider:'test',expected_registration_revision:0,envelope:env};assert.equal(run('register_v2',args).status,0);assert.equal(JSON.parse(run('register_v2',args).stdout).replayed,true);
 const invalid=run('register_v2',{...args,skip_ready:true});assert.equal(invalid.status,1);assert.equal(JSON.parse(invalid.stderr).code,'INVALID_INPUT');
 const retired=run('retire_team_v2',{expected_revision:1,reason:'retire',evidence_ref:'artifact:end',envelope:{...env,request_id:randomUUID()}});assert.equal(retired.status,0);assert.match(JSON.parse(retired.stdout).notice,/cannot resume/);
});


test('runtime shutdown after recovery gate closes retains incomplete epoch without DB writes',()=>{
 const path=join(root,`${seq++}.db`),meta=initializeTarget(path,[scope]),runtime=new ToolRuntime(path,scope,true);
 runtime.call('register_v2',{role:'worker',provider:'test',expected_registration_revision:0,envelope:{actor:'a',session_id:'a1',origin_instance_uuid:meta.instance_uuid,request_id:randomUUID()}});
 runtime.writer.db.exec("UPDATE bus_meta SET recovery_state='recovery_read_only'");const before=hash(path);runtime.close();assert.equal(hash(path),before);
 const db=new Database(path,{readonly:true});assert.equal(db.prepare('SELECT state FROM logging_epochs').get().state,'open');db.close();
});

test('T03b SDK all new wrappers use strict shared schemas, explicit review is not a gate, records replay',async()=>{
 const f=await fixture();try{await f.register();await f.register('b');await f.register('c');
 const t=await f.call('create_task_v2',{title:'T03b',review_required:true,independent_review:true,file_scope:['reported'],envelope:f.env()});let revision=0;
 const mutate=async(name,args={},actor='a')=>{const r=await f.call(name,{task_id:t.task_id,expected_task_revision:revision,...args,envelope:f.env(actor)});revision=r.task_revision;return r;};
 await mutate('claim_task_v2',{},'b');await mutate('acknowledge_task_v2',{response:'claimed',note:'ack'},'b');
 await f.bad('record_task_event_v2',{task_id:t.task_id,event_type:'note',message:'no bypass',metadata:{},task_patch:{claimed_by:'c'},expected_task_revision:revision,envelope:f.env()},'TASK_FIELD_REQUIRES_WRAPPER');
 await mutate('handoff_task_v2',{to_agent:'c',reason:'explicit',references:[{table:'tasks',id:t.task_id},{artifact_path:'not-read',git_ref:'ref'}]});
 await mutate('release_task_v2',{mode:'reopen'});await mutate('assign_task_v2',{to_agent:'b'});await mutate('submit_review_v2',{approved:false,notes:'changes'},'c');
 const ev=await f.call('record_task_event_v2',{task_id:t.task_id,event_type:'phase',message:'explicit completion',metadata:{text:'非ASCII'},task_patch:{state:'completed'},expected_task_revision:revision,envelope:f.env('b')});revision=ev.task_revision;
 const summary=await f.call('status_summary_v2',{task_id:t.task_id});assert.equal(summary.tasks[0].state,'completed');assert.equal(summary.tasks[0].review_state,'changes_requested');assert.equal(summary.tasks[0].review_gate,'not_enforced');
 await f.call('record_test_result_v2',{task_id:t.task_id,command:'reported only',status:'passed',output_summary:'report',envelope:f.env()});
 const decision={decision:'explicit',implemented:false,decision_state:'agreed',evidence_refs:[],envelope:f.env()};const d=await f.call('record_decision_v2',decision);assert.equal((await f.call('record_decision_v2',decision)).decision_id,d.decision_id);
 const m=await f.call('remember_v2',{kind:'summary',content:'record',task_id:t.task_id,envelope:f.env()});await f.call('pin_memory_v2',{memory_id:m.memory_id,pinned:true,envelope:f.env()});await f.call('pin_memory_v2',{memory_id:m.memory_id,pinned:false,envelope:f.env()});
 const c=await f.call('create_task_v2',{title:'cancel',envelope:f.env()});await f.call('cancel_task_v2',{task_id:c.task_id,expected_task_revision:0,reason:'stop',envelope:f.env()});
 await f.bad('record_decision_v2',{...decision,envelope:f.env(),evidence_refs:[{table:'operation_receipts',id:1}]},'INVALID_INPUT');
 const caps=await f.call('v2_capabilities');assert.equal(caps.schema,'2.4-dev.2');assert.match(caps.task_update_boundary,/review records do not gate/);
 }finally{await f.client.close();}
});
test('T03b CLI assignment, metadata/event patch, decision, handoff and cancellation share receipts',()=>{
 const path=join(root,`${seq++}.db`),meta=initializeTarget(path,[scope]),file=join(root,'t03b-request.json');
 const e=()=>({actor:'a',session_id:'a1',origin_instance_uuid:meta.instance_uuid,request_id:randomUUID()});
 const run=(tool,args)=>{writeFileSync(file,JSON.stringify(args),{mode:0o600});const r=spawnSync(process.execPath,['dist/v2/cli.js',path,JSON.stringify(scope),tool,file],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 run('register_v2',{role:'worker',provider:'test',expected_registration_revision:0,envelope:e()});const t=run('create_task_v2',{title:'work',mode:'investigate_only',envelope:e()}).task_id;
 run('assign_task_v2',{task_id:t,expected_task_revision:0,to_agent:'a',envelope:e()});
 run('record_task_event_v2',{task_id:t,event_type:'phase',message:'work',metadata:{text:'実施'},task_patch:{state:'working'},expected_task_revision:1,envelope:e()});
 const handoff={task_id:t,expected_task_revision:2,to_agent:null,reason:'return',references:[],envelope:e()};const h=run('handoff_task_v2',handoff);assert.equal(run('handoff_task_v2',handoff).memory_id,h.memory_id);
 run('record_decision_v2',{decision:'stop',implemented:false,decision_state:'proposed',evidence_refs:[{table:'memories',id:h.memory_id}],envelope:e()});
 run('cancel_task_v2',{task_id:t,expected_task_revision:3,reason:'end',envelope:e()});
});
