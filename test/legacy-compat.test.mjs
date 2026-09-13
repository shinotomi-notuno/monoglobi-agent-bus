import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {initializeTarget} from '../dist/v2/initialize.js';
import {Registration} from '../dist/v2/registration.js';
import {LegacyAdapter,legacyGroups,legacyPublished,legacyNames,legacyError} from '../dist/v2/legacy-adapter.js';
import {legacyInputs} from '../dist/v2/legacy-input.js';
import {ToolRuntime} from '../dist/v2/tool-runtime.js';
import {BusError} from '../dist/util/errors.js';
const root=mkdtempSync(join(tmpdir(),'ab24-t04-')),scope={project:'p',area:null,team:null},other={project:'p',area:'',team:null};let seq=0;
function fixture(){const dir=mkdtempSync(join(root,'case-')),path=join(dir,'bus.db'),meta=initializeTarget(path,[scope,other]);const w=new Registration(path,scope),e=(actor='a')=>({origin_instance_uuid:meta.instance_uuid,actor,session_id:actor+'1',request_id:randomUUID()});
 for(const actor of ['a','b'])w.register({role:'worker',provider:'test',expected_registration_revision:0},e(actor));const task=w.createTask({title:'work'},e()).task_id,conversation=w.createConversation({thread_id:'thread'},e()).conversation_id;
 const message=w.ask({to:'b',content:'Q 日本語',task_id:task,conversation_id:conversation},e()).message_id;
 w.remember({kind:'summary',content:'memory',task_id:task},e());w.recordDecision({decision:'d',decision_state:'agreed',implemented:false,evidence_refs:[]},e());w.recordTestResult({task_id:task,command:'reported',status:'passed',output_summary:'ok'},e());w.recordTaskEvent({task_id:task,event_type:'note',message:'event',metadata:{}},e());
 const f=new Registration(path,other);f.register({role:'worker',provider:'test',expected_registration_revision:0},e('other'));const foreign=f.createTask({title:'FOREIGN_SECRET'},e('other')).task_id;f.close();
 const adapter=new LegacyAdapter(path,scope);return {path,w,adapter,e,task,conversation,message,foreign,close(){adapter.close();w.close();}};
}
const snapshot=db=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function error(fn,code){assert.throws(fn,e=>e instanceof BusError&&e.code===code);}
function args(name,f){return {inbox:{agent:'b',mark_delivered:false},inbox_status:{agent:'b'},inbox_previews:{agent:'b'},get_message:{message_id:f.message},ack:{agent:'b',message_id:f.message},message_status:{message_id:f.message},why_no_reply:{message_id:f.message},thread:{thread_id:'thread'},wait_for_agents:{names:['a','b'],timeout_s:0},get_task:{task_id:f.task},task_result:{task_id:f.task},wait_for_task:{task_id:f.task,wait_s:0},check_scope_conflicts:{file_scope:['src/']},now:{agent:'a',task_id:f.task,status:'working',phase:'working',note:'must not write'},team_board:{team:'mismatch'}}[name]??{};}

test('65 categories match accepted matrix; 51 strict schemas and all dispatch paths preserve every DB table',async()=>{
 const f=fixture();try{
 assert.deepEqual(Object.values(legacyGroups).map(x=>x.length),[20,8,23,14]);assert.equal(new Set(legacyNames).size,65);assert.equal(legacyPublished.length,51);const limited=new ToolRuntime(f.path,scope,false,true);assert.equal(limited.tools.length,63);limited.close();
 const before=snapshot(f.w.db);for(const name of legacyNames){
 if(legacyGroups.disabled.includes(name)){error(()=>f.adapter.call(name,{}),'LEGACY_TOOL_DISABLED');continue;}
 assert.ok(legacyInputs[name],name);
 if(legacyGroups.reject.includes(name)){error(()=>f.adapter.call(name,args(name,f)),name==='ack'?'LEGACY_ACK_DISABLED':'UPGRADE_REQUIRED');continue;}
 if(name==='team_board'){error(()=>f.adapter.call(name,args(name,f)),'SCOPE_UNRESOLVED');continue;}
 const result=await f.adapter.call(name,args(name,f));assert.ok(result!==undefined,name);assert.ok(!JSON.stringify(result).includes('FOREIGN_SECRET'),name);
 }
 assert.deepEqual(snapshot(f.w.db),before);
 }finally{f.close();}
});
test('K01 overlapping conditions obey input, Agent, scope, Message, recipient, mode order and no observer writes',()=>{
 const f=fixture();try{const unresolved=new LegacyAdapter(f.path,null),before=snapshot(f.w.db);
 error(()=>unresolved.call('ack',{agent:'',message_id:0,token:'x'}),'INVALID_INPUT');
 error(()=>unresolved.call('ack',{agent:'missing',message_id:99999}),'AGENT_NOT_FOUND');
 error(()=>unresolved.call('ack',{agent:'b',message_id:99999}),'SCOPE_UNRESOLVED');
 error(()=>f.adapter.call('ack',{agent:'other',message_id:f.message}),'AGENT_NOT_FOUND');
 error(()=>f.adapter.call('ack',{agent:'b',message_id:99999}),'MESSAGE_NOT_FOUND');
 error(()=>f.adapter.call('ack',{agent:'a',message_id:f.message}),'RECIPIENT_MISMATCH');
 error(()=>f.adapter.call('ack',{agent:'b',message_id:f.message,envelope:{}}),'INVALID_INPUT');
 error(()=>f.adapter.call('ack',{agent:'b',message_id:f.message}),'LEGACY_ACK_DISABLED');
 unresolved.close();assert.deepEqual(snapshot(f.w.db),before);
 for(const mode of ['legacy_terminal','invalid']){f.w.db.prepare('UPDATE delivery_state SET mode=? WHERE message_id=?').run(mode,f.message);const snapshotBefore=snapshot(f.w.db);error(()=>f.adapter.call('ack',{agent:'a',message_id:f.message}),'RECIPIENT_MISMATCH');error(()=>f.adapter.call('ack',{agent:'b',message_id:f.message}),mode==='invalid'?'DELIVERY_STATE_INVALID':'LEGACY_ACK_DISABLED');assert.deepEqual(snapshot(f.w.db),snapshotBefore);}
 f.w.db.prepare('DELETE FROM delivery_state WHERE message_id=?').run(f.message);error(()=>f.adapter.call('ack',{agent:'a',message_id:f.message}),'RECIPIENT_MISMATCH');error(()=>f.adapter.call('ack',{agent:'b',message_id:f.message}),'DELIVERY_STATE_INVALID');
 }finally{f.close();}
});
test('K01 all delivery statuses and both supported modes refuse without tables/files changing through shutdown',()=>{
 for(const status of ['pending','delivered','answered'])for(const mode of ['guarded','legacy_terminal']){const f=fixture();try{
 f.w.db.prepare('UPDATE messages SET status=? WHERE id=?').run(status,f.message);f.w.db.prepare('UPDATE delivery_state SET mode=? WHERE message_id=?').run(mode,f.message);
 const before=snapshot(f.w.db),fileBefore=hash(f.path),keyBefore=hash(f.path+'.cursor-key.json'),r=new ToolRuntime(f.path,scope,true,true);
 assert.throws(()=>r.call('ack',args('ack',f)),e=>e.code==='LEGACY_ACK_DISABLED');r.close();assert.deepEqual(snapshot(f.w.db),before);assert.equal(hash(f.path),fileBefore);assert.equal(hash(f.path+'.cursor-key.json'),keyBefore);
 }finally{f.close();}}
});
test('legacy reads preserve body/preview/record shapes and explicit Task membership; scope/unknown retained',async()=>{
 const f=fixture();try{const before=snapshot(f.w.db);
 const message=f.adapter.call('get_message',{message_id:f.message});assert.equal(message.message.content,'Q 日本語');assert.equal(message.full_content_included,true);
 const preview=f.adapter.call('get_message',{message_id:f.message,preview_chars:2});assert.equal(preview.message.content_preview,'Q ');assert.equal(preview.message.truncated,true);assert.equal(preview.message.content,undefined);
 const result=f.adapter.call('task_result',{task_id:f.task});assert.deepEqual(Object.keys(result),['task','events','test_results','memories','messages']);assert.equal(result.messages[0].id,f.message);assert.equal(result.task.wait_kind,'none');assert.equal(result.events.length,1);assert.equal(result.test_results.length,1);assert.equal(result.memories.length,1);
 assert.equal(f.adapter.call('message_status',{message_id:f.message}).related_task.id,f.task);
 error(()=>f.adapter.call('get_task',{task_id:f.foreign}),'TASK_NOT_FOUND');
 for(const project of ['*','other',null,''])assert.throws(()=>f.adapter.call('list_tasks',{project}));
 assert.equal(f.adapter.call('list_tasks',{}).length,1);assert.equal(f.adapter.call('list_tasks',{project:'p'}).length,1);
 for(const a of [{agent:'b'},{agent:'b',mark_delivered:true},{agent:'b',mark_delivered:false,claim_s:1}])error(()=>f.adapter.call('inbox',a),'UPGRADE_REQUIRED');
 assert.equal((await f.adapter.call('inbox',{agent:'b',mark_delivered:false}))[0].id,f.message);assert.deepEqual(snapshot(f.w.db),before);
 }finally{f.close();}
});
async function connect(f,modern=false,writers=false,legacy=true){const c=new Client({name:'T04-sdk',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[resolve(modern?'dist/v2/server.js':'dist/mcp/server.js')],env:{...process.env,AGENT_BUS_V2_DB:f.path,AGENT_BUS_V2_SCOPE:JSON.stringify(scope),AGENT_BUS_V2_WRITERS:writers?'1':'0',AGENT_BUS_V2_LEGACY:legacy?'1':'0'}}));return c;}
test('SDK legacy 51 and combined 96 manifests; 14 stopped names and unknown return exact K03, ack never observes',async()=>{
 const f=fixture();try{for(const modern of [false,true]){const before=snapshot(f.w.db),file=hash(f.path),files=readdirSync(dirname(f.path)),client=await connect(f,modern,true);try{
 const tools=(await client.listTools()).tools,names=tools.map(t=>t.name);if(modern){const caps=JSON.parse((await client.callTool({name:'v2_capabilities',arguments:{}})).content[0].text);for(const tool of tools)assert.deepEqual(tool.inputSchema,caps.public_tools.find(x=>x.name===tool.name).input_schema);}assert.equal(names.length,modern?96:51);for(const name of legacyPublished)assert.ok(names.includes(name));for(const name of [...legacyGroups.disabled,'unknown_tool'])await assert.rejects(()=>client.callTool({name,arguments:{}}),e=>e.code===-32602&&e.message==='MCP error -32602: Unknown tool'&&e.data.tool===name);
 for(const [a,code] of [[{agent:'missing',message_id:f.message},'AGENT_NOT_FOUND'],[{agent:'b',message_id:f.message,token:'not-upgrade'},'INVALID_INPUT'],[args('ack',f),'LEGACY_ACK_DISABLED']]){const r=await client.callTool({name:'ack',arguments:a});assert.equal(r.isError,true);const out=JSON.parse(r.content[0].text);assert.equal(out.code,code);assert.equal(out.replacement,'ack_v2');}
 const p=await client.callTool({name:'inbox',arguments:args('inbox',f)});assert.ok(!p.isError,p.content[0].text);
 }finally{await client.close();}assert.deepEqual(snapshot(f.w.db),before);assert.equal(hash(f.path),file);assert.deepEqual(readdirSync(dirname(f.path)),files);}
 }finally{f.close();}
});
test('all compatibility reads/rejections in recovery read_only leave tables and file unchanged',async()=>{
 const f=fixture();try{f.w.db.exec("UPDATE bus_meta SET recovery_state='recovery_read_only'");const before=snapshot(f.w.db),file=hash(f.path),r=new ToolRuntime(f.path,scope,true,true);
 for(const name of legacyPublished){try{await r.call(name,args(name,f));}catch(e){assert.ok(e instanceof BusError,name);}}r.close();assert.deepEqual(snapshot(f.w.db),before);assert.equal(hash(f.path),file);
 }finally{f.close();}
});

test('old exports guard removal/force-release/Task/Reply and preserve scoped reads before legacy SQL; old CLI migration hints',()=>{
 const f=fixture();try{const before=snapshot(f.w.db),file=hash(f.path),env={...process.env,AGENT_BUS_DIR:dirname(f.path),AGENT_BUS_V2_DB:f.path,AGENT_BUS_V2_SCOPE:JSON.stringify(scope)};
 const script=`import * as bus from './dist/bus.js';import {getDb} from './dist/db.js';import {strict as assert} from 'node:assert';
 for(const [method,args,code] of [['deleteTeam',{team:'x',force:true},'LEGACY_TOOL_DISABLED'],['removeAgent',{name:'b',force:true},'UPGRADE_REQUIRED'],['updateTask',{task_id:${f.task},agent:'a',state:'completed'},'UPGRADE_REQUIRED'],['reply',{ask_id:${f.message},from:'b',answer:'x'},'UPGRADE_REQUIRED'],['claimTask',{task_id:${f.task},agent:'b'},'UPGRADE_REQUIRED']])assert.throws(()=>bus[method](args),e=>e.code===code);
 assert.throws(()=>bus.ack({agent:'b',message_id:${f.message},token:'x'}),e=>e.code==='INVALID_INPUT');assert.throws(()=>bus.ack({agent:'b',message_id:${f.message}}),e=>e.code==='LEGACY_ACK_DISABLED');
 assert.equal(bus.getTask(${f.task}).title,'work');assert.equal((await bus.inbox({agent:'b',mark_delivered:false})).length,1);
 assert.throws(()=>getDb(),/V2_DB_REQUIRES_V2_ENTRYPOINT/);console.log('core adapter passed');`;
 // getDb guard uses its own configured old DB path, so point that resolver at the same target without overwriting it.
 const scriptCore=script;
 const result=spawnSync(process.execPath,['--input-type=module','-e',scriptCore],{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 for(const [argv,code,hint] of [[['delete-team','x','--force'],'LEGACY_TOOL_DISABLED','retire_team_v2'],[['register','--name','a'],'UPGRADE_REQUIRED','register_v2'],[['task-done',String(f.task),'--by','a','--result','end'],'UPGRADE_REQUIRED','update_task_v2'],[['listen','--agent','b','--wait-s','1'],'UPGRADE_REQUIRED','claim_messages_v2']]){const r=spawnSync(process.execPath,['dist/cli/index.js',...argv],{env,encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,new RegExp(code));assert.match(r.stderr,new RegExp(hint));}
 for(const argv of [['whois'],['tasks'],['task-result',String(f.task)],['now','--agent','a','--task',String(f.task),'--phase','working']]){const r=spawnSync(process.execPath,['dist/cli/index.js',...argv],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.ok(!r.stdout.includes('FOREIGN_SECRET'));if(argv[0]==='now')assert.match(r.stdout,/read only/);}
 const poll=spawnSync(process.execPath,['dist/cli/index.js','poll-inbox','--agent','b','--session','no-auto-resume'],{env,encoding:'utf8'});assert.equal(poll.status,0,poll.stderr);assert.equal(JSON.parse(poll.stdout).decision,undefined);assert.equal(JSON.parse(poll.stdout).messages.length,1);
 assert.deepEqual(snapshot(f.w.db),before);assert.equal(hash(f.path),file);
 }finally{f.close();}
});
test('legacy bound differences: inbox 50/500, previews 20/100, Task 100/500, core recent 1000; no enumeration guarantee',async()=>{
 const f=fixture();try{for(let i=0;i<505;i++)f.w.send({to:'b',content:'m'+i,task_id:null,conversation_id:f.conversation},f.e());
 assert.equal((await f.adapter.call('inbox',{agent:'b',mark_delivered:false})).length,50);assert.equal((await f.adapter.call('inbox',{agent:'b',mark_delivered:false,limit:500})).length,500);
 assert.equal((await f.adapter.call('inbox_previews',{agent:'b'})).length,20);assert.equal((await f.adapter.call('inbox_previews',{agent:'b',limit:100})).length,100);
 assert.equal(f.adapter.call('recent',{limit:1000},true).length,506);error(()=>f.adapter.call('recent',{limit:501}),'INVALID_INPUT');
 assert.equal(f.adapter.call('thread',{thread_id:'thread',limit:1000},true).length,506);
 }finally{f.close();}
});
test('Task flow uses explicit new writes, keeps legacy readable, blocked exit requires clear_wait and no terminal resume',()=>{
 const f=fixture();try{let r=f.w.claimTask({task_id:f.task,expected_task_revision:0},f.e('b'));
 error(()=>f.adapter.call('claim_task',{agent:'b',task_id:f.task}),'UPGRADE_REQUIRED');
 assert.throws(()=>f.w.claimTask({task_id:f.task,expected_task_revision:r.task_revision},f.e('b')),/TASK_NOT_CLAIMABLE/);
 r=f.w.updateTask({task_id:f.task,expected_task_revision:r.task_revision,patch:{state:'working'}},f.e('b'));
 r=f.w.updateTask({task_id:f.task,expected_task_revision:r.task_revision,patch:{state:'blocked',wait_kind:'technical',blocked_reason:'api key'}},f.e('b'));
 assert.throws(()=>f.w.updateTask({task_id:f.task,expected_task_revision:r.task_revision,patch:{state:'completed'}},f.e('b')),/CLEAR_WAIT_REQUIRED/);
 r=f.w.updateTask({task_id:f.task,expected_task_revision:r.task_revision,patch:{state:'completed',clear_wait:true,result:'fixed'}},f.e('b'));
 assert.throws(()=>f.w.updateTask({task_id:f.task,expected_task_revision:r.task_revision,patch:{state:'working'}},f.e('b')),/TASK_INVALID_TRANSITION/);assert.equal(f.adapter.call('get_task',{task_id:f.task}).result,'fixed');
 }finally{f.close();}
});
test('Project flow excludes NULL/empty/other scopes; ask_best stopped, explicit recipient and reply authority used',()=>{
 const f=fixture();try{error(()=>f.adapter.call('ask_best',{from:'a',capability:'react',question:'q'}),'LEGACY_TOOL_DISABLED');
 error(()=>f.adapter.call('whois',{project:'*'}),'SCOPE_UNRESOLVED');assert.deepEqual(f.adapter.call('whois',{}).map(x=>x.name).sort(),['a','b']);
 const auth=f.w.immediate({limit:1},f.e('b')).items[0];f.w.reply({message_id:f.message,reply_generation:auth.reply_generation,reply_token:auth.reply_token,content:'explicit answer'},f.e('b'));
 const view=f.adapter.call('message_status',{message_id:f.message});assert.equal(view.reply.content,'explicit answer');assert.equal(view.message.status,'answered');assert.equal(view.related_task.id,f.task);
 }finally{f.close();}
});

test('team_board successful scoped delegate and NULL/empty scope connections remain distinct',()=>{
 const path=join(root,`team-${seq++}.db`),team={project:'p',area:null,team:'team'},nil={project:null,area:null,team:null},empty={project:'',area:null,team:null};initializeTarget(path,[team,nil,empty]);
 const board=new LegacyAdapter(path,team);assert.deepEqual(board.call('team_board',{team:'team'}).open_tasks,[]);error(()=>board.call('team_board',{team:'*'}),'SCOPE_UNRESOLVED');board.close();
 const n=new LegacyAdapter(path,nil),e=new LegacyAdapter(path,empty);assert.deepEqual(n.call('list_tasks',{}),[]);assert.deepEqual(e.call('list_tasks',{}),[]);assert.throws(()=>n.call('list_tasks',{project:''}));assert.throws(()=>e.call('list_tasks',{project:null}));n.close();e.close();
});
test('K01 cross-scope Message returns MESSAGE_NOT_FOUND, even when recipient matches',()=>{
 const f=fixture();try{const w=new Registration(f.path,other);w.register({role:'worker',provider:'test',expected_registration_revision:0},{...f.e('b'),session_id:'b-other'});const c=w.createConversation({thread_id:'foreign'},f.e('other')).conversation_id;const m=w.ask({to:'b',content:'FOREIGN_SECRET',task_id:null,conversation_id:c},f.e('other')).message_id;
 error(()=>f.adapter.call('ack',{agent:'b',message_id:m}),'MESSAGE_NOT_FOUND');error(()=>f.adapter.call('get_message',{message_id:m}),'MESSAGE_NOT_FOUND');w.close();
 }finally{f.close();}
});

test('core limit/preview clamping differs from MCP rejection without weakening unknown-field validation',()=>{
 const f=fixture();try{assert.equal(f.adapter.call('get_message',{message_id:f.message,preview_chars:30000},true).message.truncated,false);error(()=>f.adapter.call('get_message',{message_id:f.message,preview_chars:30000}),'INVALID_INPUT');
 assert.equal(f.adapter.call('list_tasks',{limit:-1},true).length,1);error(()=>f.adapter.call('list_tasks',{limit:-1}),'INVALID_INPUT');
 error(()=>f.adapter.call('list_tasks',{unknown:true},true),'INVALID_INPUT');
 }finally{f.close();}
});

test('legacy inbox status/preview observe persisted lease clock without updating it; equality is expired',async()=>{
 const f=fixture();try{const future=Date.now()+100000;f.w.db.prepare('UPDATE bus_meta SET lease_clock_ms=?').run(future);f.w.db.prepare('UPDATE delivery_state SET deadline=?,holder_session=? WHERE message_id=?').run(future,'b1',f.message);
 const before=snapshot(f.w.db);assert.equal((await f.adapter.call('inbox',{agent:'b',mark_delivered:false})).length,1);const status=f.adapter.call('inbox_status',{agent:'b'});assert.equal(status.unread.length,1);assert.equal(status.in_flight.length,0);assert.ok(!f.adapter.call('message_status',{message_id:f.message}).diagnostics.some(x=>x.startsWith('message is claimed')));assert.deepEqual(snapshot(f.w.db),before);
 }finally{f.close();}
});

test('mixed writer session then legacy ack/preview/unknown preserves all tables/files through shutdown, retaining incomplete epoch',async()=>{
 const f=fixture();try{
 for(const name of ['ack','inbox','preview_messages_v2','unknown_tool']){
 const r=new ToolRuntime(f.path,scope,true,true);r.call('create_task_v2',{title:'start writer observation',envelope:f.e()});const before=snapshot(f.w.db),file=hash(f.path);
 try{await r.call(name,name==='preview_messages_v2'?{envelope:f.e('b')}:name==='inbox'?args(name,f):{});}catch(e){assert.ok(e instanceof BusError||e.message==='UNKNOWN_TOOL');}
 r.close();assert.deepEqual(snapshot(f.w.db),before);assert.equal(hash(f.path),file);assert.equal(f.w.db.prepare('SELECT state FROM logging_epochs ORDER BY epoch_id DESC LIMIT 1').get().state,'open');
 }
 const client=await connect(f,true,true);await client.callTool({name:'create_task_v2',arguments:{title:'mixed SDK',envelope:f.e()}});const before=snapshot(f.w.db),file=hash(f.path);
 await client.callTool({name:'ack',arguments:{agent:'b',message_id:f.message}});await assert.rejects(()=>client.callTool({name:'delete_team',arguments:{team:'x'}}),e=>e.code===-32602&&e.message==='MCP error -32602: Unknown tool');await client.close();assert.deepEqual(snapshot(f.w.db),before);assert.equal(hash(f.path),file);
 }finally{f.close();}
});
