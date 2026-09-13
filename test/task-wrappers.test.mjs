import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {initializeTarget} from '../dist/v2/initialize.js';
import {Registration} from '../dist/v2/registration.js';
import {Queries} from '../dist/v2/queries.js';
import {ToolRuntime} from '../dist/v2/tool-runtime.js';
const root=mkdtempSync(join(tmpdir(),'ab24-t03b-')),scope={project:'p',area:null,team:null},otherScope={project:'p',area:'',team:null};let seq=0;
function fixture(){
 const path=join(root,`${seq++}.db`),meta=initializeTarget(path,[scope,otherScope]);let now=1000;
 const s=new Registration(path,scope,{now:()=>now}),e=(actor='a',session_id=actor+'1')=>({origin_instance_uuid:meta.instance_uuid,actor,session_id,request_id:randomUUID()});
 for(const actor of ['a','b','c'])s.register({role:'worker',provider:'test',expected_registration_revision:0},e(actor));
 const row=id=>s.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
 const task=(args={})=>s.createTask({title:'work',...args},e()).task_id;
 const call=(method,id,args={},actor='a')=>s[method]({task_id:id,expected_task_revision:row(id).task_revision,...args},e(actor));
 const foreign=new Registration(path,otherScope,{now:()=>now});foreign.register({role:'worker',provider:'test',expected_registration_revision:0},e('foreign'));
 return {s,path,meta,e,row,task,call,foreign,time:n=>now=n,close:()=>{foreign.close();s.close();}};
}
const tables=['tasks','task_events','memories','decisions','test_results','operation_receipts','communication_events','messages'];
const snapshot=s=>Object.fromEntries(tables.map(t=>[t,s.db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]));
function rejectsUnchanged(f,fn,code){const before=snapshot(f.s);assert.throws(fn,new RegExp(code));assert.deepEqual(snapshot(f.s),before);}
const technical={state:'blocked',wait_kind:'technical',blocked_reason:'dependency'};
const reason={reason:'end',evidence_ref:'artifact:operator'};

test('create metadata persists; initial state/assignment/automation/unknown and typed input reject',()=>{
 const f=fixture();try{
 const t=f.task({state:'backlog',description:'用途',priority:2,mode:'test_only',file_scope:['a'],edit_scope:[],read_scope:['b'],changed_files:[],review_required:true,independent_review:true,ack_required:true,deadline_at:123,checkin_at:100,expected_output:'report',final_answer:null});
 const r=f.row(t);assert.equal(r.claimed_by,null);assert.equal(r.wait_kind,'none');assert.equal(r.review_state,'none');assert.equal(r.acknowledged_at,null);assert.equal(r.file_scope,'["a"]');assert.equal(r.review_required,1);assert.equal(r.mode,'test_only');
 for(const a of [{state:'claimed'},{claimed_by:'b'},{required_capability:'x'},{allow_conflicts:true},{allow_pending_agent:true},{file_scope:null},{read_scope:['']},{ack_required:1},{deadline_at:'tomorrow'},{unknown:'secret'}])rejectsUnchanged(f,()=>f.task(a),'INVALID_INPUT');
 assert.equal(f.s.db.prepare('SELECT count(*) n FROM conversations').get().n,0);assert.equal(f.s.db.prepare('SELECT count(*) n FROM messages').get().n,0);
 }finally{f.close();}
});
test('claim/assign requester and recipient checks, CAS, replay preserves assignment time and revision',()=>{
 const f=fixture();try{const t=f.task();rejectsUnchanged(f,()=>f.call('assignTask',t,{to_agent:'b'},'c'),'TASK_FORBIDDEN');
 rejectsUnchanged(f,()=>f.call('assignTask',t,{to_agent:'foreign'}),'RECIPIENT_SCOPE_MISMATCH');
 for(const key of ['required_capability','allow_conflicts','allow_pending_agent'])rejectsUnchanged(f,()=>f.call('assignTask',t,{to_agent:'b',[key]:true}),'INVALID_INPUT');
 const e=f.e('b'),a={task_id:t,expected_task_revision:0};f.s.claimTask(a,e);const before=f.row(t);f.time(9000);assert.equal(f.s.claimTask(a,e).replayed,true);assert.deepEqual(f.row(t),before);
 rejectsUnchanged(f,()=>f.call('claimTask',t,{},'c'),'TASK_NOT_CLAIMABLE');rejectsUnchanged(f,()=>f.s.updateTask({task_id:t,expected_task_revision:0,patch:{priority:2}},f.e()),'REVISION_CONFLICT');
 rejectsUnchanged(f,()=>f.call('updateTask',t,{patch:{state:'working'}},'c'),'TASK_FORBIDDEN');
 }finally{f.close();}
});
test('update transition matrix across all eight states, including requester unassigned reopen',()=>{
 const expected={backlog:['backlog','open'],open:['open','backlog','working','blocked','completed','failed'],claimed:['claimed','working','blocked','completed','failed'],working:['working','blocked','completed','failed'],blocked:['blocked','working','completed','failed'],completed:['completed'],failed:['failed'],canceled:['canceled']};
 const f=fixture();try{for(const [state,allowed] of Object.entries(expected))for(const next of Object.keys(expected)){
  const t=f.task(state==='backlog'?{state}:{});if(['claimed','working','blocked','completed','failed','canceled'].includes(state))f.call('assignTask',t,{to_agent:'b'});
  if(state==='canceled')f.call('cancelTask',t,{reason:'end'});else if(!['backlog','open','claimed'].includes(state))f.call('updateTask',t,{patch:state==='blocked'?technical:{state}});
  const patch={state:next,...(next==='blocked'?technical:{}),...(state==='blocked'&&next!=='blocked'?{clear_wait:true}:{})};
  if(allowed.includes(next)){f.call('updateTask',t,{patch});assert.equal(f.row(t).state,next);}else rejectsUnchanged(f,()=>f.call('updateTask',t,{patch}),'TASK_INVALID_TRANSITION');
 }}finally{f.close();}
});
test('unassigned blocked/claimed/working reopen and assigned blocked require distinct explicit paths',()=>{
 const f=fixture();try{
 for(const state of ['blocked','claimed','working']){
  const t=f.task();if(state!=='blocked')f.call('assignTask',t,{to_agent:'b'});
  if(state!=='claimed')f.call('updateTask',t,{patch:state==='blocked'?technical:{state}});
  if(state!=='blocked')f.call('releaseTask',t,{mode:'preserve_state'});
  rejectsUnchanged(f,()=>f.call('releaseTask',t,{mode:'reopen',clear_wait:true}),'TASK_NOT_ASSIGNED');
  rejectsUnchanged(f,()=>f.call('updateTask',t,{patch:{state:'open',clear_wait:true}},'b'),'TASK_FORBIDDEN');
  if(state==='blocked')rejectsUnchanged(f,()=>f.call('updateTask',t,{patch:{state:'open'}}),'CLEAR_WAIT_REQUIRED');
  f.call('updateTask',t,{patch:{state:'open',...(state==='blocked'?{clear_wait:true}:{})}});assert.equal(f.row(t).wait_kind,'none');
 }
 const t=f.task();f.call('assignTask',t,{to_agent:'b'});f.call('updateTask',t,{patch:technical});
 rejectsUnchanged(f,()=>f.call('updateTask',t,{patch:{state:'open',clear_wait:true}}),'TASK_INVALID_TRANSITION');
 rejectsUnchanged(f,()=>f.call('releaseTask',t,{mode:'preserve_state',clear_wait:false}),'INVALID_INPUT');
 rejectsUnchanged(f,()=>f.call('releaseTask',t,{mode:'reopen'}),'CLEAR_WAIT_REQUIRED');
 f.call('releaseTask',t,{mode:'reopen',clear_wait:true});assert.equal(f.row(t).state,'open');assert.equal(f.row(t).claimed_by,null);
 }finally{f.close();}
});
test('terminal completion timestamp/phase fixed, same-state preserves finish time, release cannot reopen',()=>{
 const f=fixture();try{for(const state of ['completed','failed','canceled']){
 const finish=2000+['completed','failed','canceled'].indexOf(state)*3000;const t=f.task();f.call('assignTask',t,{to_agent:'b'});f.time(finish);
 if(state==='canceled')f.call('cancelTask',t,{reason:'stop'});else f.call('updateTask',t,{patch:{state}});
 const old=f.row(t);assert.equal(old.finished_at,finish);assert.equal(old.phase,state);f.time(finish+1000);
 f.call('updateTask',t,{patch:{state,description:'same-state metadata'}});assert.equal(f.row(t).finished_at,finish);
 rejectsUnchanged(f,()=>f.call('updateTask',t,{patch:{phase:'working'}}),'TASK_INVALID_TRANSITION');
 rejectsUnchanged(f,()=>f.call('releaseTask',t,{mode:'reopen'}),'TASK_INVALID_TRANSITION');
 f.call('releaseTask',t,{mode:'preserve_state'});assert.equal(f.row(t).state,state);assert.equal(f.row(t).finished_at,finish);f.time(1000);
 }}finally{f.close();}
});
test('acknowledgements and same-actor handoff reset ack, release retains historical ack',()=>{
 const f=fixture();try{const t=f.task();f.call('assignTask',t,{to_agent:'b'});
 rejectsUnchanged(f,()=>f.call('acknowledgeTask',t,{response:'claimed'}),'TASK_FORBIDDEN');
 f.call('acknowledgeTask',t,{response:'claimed',note:'received'},'b');assert.equal(f.row(t).acknowledged_by,'b');assert.equal(f.s.db.prepare('SELECT message FROM task_events').get().message,'received');
 f.call('handoffTask',t,{to_agent:'b',reason:'fresh assignment',references:[]},'b');assert.equal(f.row(t).acknowledged_at,null);
 f.call('acknowledgeTask',t,{response:'declined'},'b');assert.equal(f.row(t).state,'open');assert.equal(f.row(t).claimed_by,null);assert.equal(f.row(t).acknowledged_by,'b');
 f.call('assignTask',t,{to_agent:'b'});assert.equal(f.row(t).acknowledged_by,null);
 rejectsUnchanged(f,()=>f.call('acknowledgeTask',t,{response:'blocked'},'b'),'INVALID_TASK_WAIT');
 f.call('acknowledgeTask',t,{response:'blocked',wait_kind:'technical',blocked_reason:'wait'},'b');const r=f.row(t);
 f.call('releaseTask',t,{mode:'preserve_state'});assert.equal(f.row(t).acknowledged_at,r.acknowledged_at);assert.equal(f.row(t).wait_kind,'technical');
 }finally{f.close();}
});
test('Human wait survives handoff/release; wait-changing inputs rejected; explicit cancel clears it',()=>{
 const f=fixture();try{const t=f.task(),c=f.s.createConversation({thread_id:'q'},f.e()).conversation_id;
 const q=f.s.ask({to:'c',content:'PM question',conversation_id:c,task_id:t},f.e()).message_id;
 f.call('assignTask',t,{to_agent:'b'});f.call('acknowledgeTask',t,{response:'blocked',wait_kind:'human',blocked_reason:'PM',human_question_id:q},'b');
 const before=f.row(t),args={to_agent:'c',reason:'continue',references:[{table:'messages',id:q}]};
 rejectsUnchanged(f,()=>f.call('handoffTask',t,{...args,clear_wait:true}),'INVALID_INPUT');rejectsUnchanged(f,()=>f.call('handoffTask',t,{...args,wait_kind:'none'}),'INVALID_INPUT');
 rejectsUnchanged(f,()=>f.call('handoffTask',t,{...args,references:[{table:'messages',id:99999}]}),'HANDOFF_REFERENCE_INVALID');
 const r=f.call('handoffTask',t,args);assert.equal(f.row(t).human_question_id,q);assert.equal(f.row(t).blocked_reason,before.blocked_reason);
 const m=f.s.db.prepare('SELECT * FROM memories WHERE id=?').get(r.memory_id);assert.equal(m.content,'continue');assert.deepEqual(JSON.parse(m.handoff_references),args.references);
 rejectsUnchanged(f,()=>f.call('cancelTask',t,{reason:'stop'}),'CLEAR_WAIT_REQUIRED');
 f.call('cancelTask',t,{reason:'stop',clear_wait:true});assert.equal(f.row(t).wait_kind,'none');assert.equal(f.row(t).claimed_by,'c');
 assert.equal(f.s.db.prepare("SELECT count(*) n FROM task_events WHERE event_type='cancel'").get().n,1);
 }finally{f.close();}
});
test('review recording has actor independence checks but no completion gate, requester-only policy changes',()=>{
 const f=fixture();try{const t=f.task({independent_review:true});f.call('assignTask',t,{to_agent:'b'});
 rejectsUnchanged(f,()=>f.call('updateTask',t,{patch:{review_required:false}},'b'),'TASK_FORBIDDEN');
 rejectsUnchanged(f,()=>f.call('submitReview',t,{approved:true},'b'),'REVIEW_SELF_FORBIDDEN');
 f.call('submitReview',t,{approved:false,notes:'changes'},'c');let r=f.row(t);assert.equal(r.state,'claimed');assert.equal(r.review_required,1);assert.equal(r.review_state,'changes_requested');
 f.call('updateTask',t,{patch:{state:'completed'}},'b');assert.equal(f.row(t).state,'completed');
 const q=new Queries(f.path,scope);r=q.statusSummary({task_id:t}).tasks[0];assert.equal(r.review_state,'changes_requested');assert.equal(r.review_gate,'not_enforced');assert.equal(r.independent_review,true);q.close();
 f.call('submitReview',t,{approved:true},'c');assert.equal(f.row(t).state,'completed');
 const reviews=f.s.db.prepare("SELECT details_json FROM communication_events WHERE operation='submit_review_v2' ORDER BY event_id").all().map(x=>JSON.parse(x.details_json).review);assert.equal(reviews[0].notes,'changes');assert.equal(reviews[0].approved,false);assert.equal(reviews[1].approved,true);
 }finally{f.close();}
});
test('record event patch shares field/actor/state checks; event phase/cancel name alone leave Task intact',()=>{
 const f=fixture();try{const t=f.task(),base={task_id:t,event_type:'cancel',message:'record only',phase:'canceled',metadata:{unicode:'確認'}};
 const old=f.row(t);f.s.recordTaskEvent(base,f.e('c'));assert.deepEqual(f.row(t),old);
 for(const patch of [{claimed_by:'c'},{pending_assignee:'c'},{review_state:'approved'},{finished_at:1}]){
 rejectsUnchanged(f,()=>f.call('updateTask',t,{patch}),'TASK_FIELD_REQUIRES_WRAPPER');
 rejectsUnchanged(f,()=>f.s.recordTaskEvent({...base,task_patch:patch,expected_task_revision:0},f.e()),'TASK_FIELD_REQUIRES_WRAPPER');}
 rejectsUnchanged(f,()=>f.s.recordTaskEvent({...base,task_patch:{state:'working'},expected_task_revision:0},f.e('c')),'TASK_FORBIDDEN');
 rejectsUnchanged(f,()=>f.s.recordTaskEvent({...base,task_patch:{state:'canceled'},expected_task_revision:0},f.e()),'TASK_INVALID_TRANSITION');
 for(const a of [{task_patch:{priority:2}},{expected_task_revision:0}])rejectsUnchanged(f,()=>f.s.recordTaskEvent({...base,...a},f.e()),'INVALID_INPUT');
 f.s.recordTaskEvent({...base,task_patch:{state:'failed'},expected_task_revision:0},f.e());assert.equal(f.row(t).state,'failed');assert.equal(f.row(t).phase,'failed');assert.equal(f.row(t).finished_at,1000);
 }finally{f.close();}
});
test('JSON metadata UTF-8 exactly 64KiB accepted; byte overflow, null, array, invalid nested values rejected without raw Errors',()=>{
 const f=fixture();try{const runtime=new ToolRuntime(f.path,scope,true),t=f.task(),base={task_id:t,event_type:'log',message:'record'};
 const metadata={x:'あ'.repeat(21842)+'aa'};assert.equal(Buffer.byteLength(JSON.stringify(metadata)),65536);
 runtime.call('record_task_event_v2',{...base,metadata,envelope:f.e()});
 for(const metadata of [{x:'あ'.repeat(21843)},null,[],{x:undefined},{x:NaN}])rejectsUnchanged(f,()=>f.s.recordTaskEvent({...base,metadata},f.e()),'INVALID_INPUT');
 assert.throws(()=>runtime.call('record_task_event_v2',{...base,metadata:{x:'sensitive-raw'},unknown:'secret',envelope:f.e()}),/INVALID_INPUT/);
 assert.ok(!JSON.stringify(runtime.reader.listErrors()).includes('sensitive-raw'));runtime.close();
 }finally{f.close();}
});
test('decision explicit state and allowlisted references: all DB kinds checked, empty/artifact only syntax',()=>{
 const f=fixture();try{const t=f.task(),conversation_id=f.s.createConversation({thread_id:'c'},f.e()).conversation_id;
 const message_id=f.s.send({to:'b',content:'Task #9999 literal',task_id:null,conversation_id},f.e()).message_id;
 const memory_id=f.s.remember({kind:'artifact',content:'ref'},f.e()).memory_id;
 const test_result_id=f.s.recordTestResult({task_id:null,command:'reported',status:'skipped',output_summary:''},f.e()).test_result_id;
 const task_event_id=f.s.recordTaskEvent({task_id:t,event_type:'note',message:'record',metadata:{}},f.e()).task_event_id;
 const base={decision:'選択',implemented:false,decision_state:'proposed',evidence_refs:[]};const d=f.s.recordDecision(base,f.e()).decision_id;
 const refs=[['tasks',t],['messages',message_id],['conversations',conversation_id],['memories',memory_id],['test_results',test_result_id],['task_events',task_event_id],['decisions',d]].map(([table,id])=>({table,id}));refs.push({artifact_path:'/does/not/exist',git_ref:'unverified-ref'});
 const out=f.s.recordDecision({...base,implemented:true,decision_state:'agreed',evidence_refs:refs},f.e());const saved=f.s.db.prepare('SELECT * FROM decisions WHERE id=?').get(out.decision_id);assert.deepEqual(JSON.parse(saved.evidence_refs),refs);assert.equal(saved.decision_state,'agreed');assert.equal(saved.implemented,1);
 const foreign=f.foreign.createTask({title:'outside'},f.e('foreign')).task_id;
 for(const evidence_refs of [[{table:'tasks',id:foreign}],[{table:'tasks',id:99999}],[{table:'memories',id:99999}]])rejectsUnchanged(f,()=>f.s.recordDecision({...base,evidence_refs},f.e()),'TARGET_NOT_FOUND');
 for(const evidence_refs of [[{table:'operation_receipts',id:1}],[{table:'tasks; DROP TABLE tasks',id:t}],[{table:'tasks',id:t,secret:'x'}],[{artifact_path:'x',git_ref:'x',unknown:1}],Array(17).fill(refs[0]),null])rejectsUnchanged(f,()=>f.s.recordDecision({...base,evidence_refs},f.e()),'INVALID_INPUT');
 rejectsUnchanged(f,()=>f.s.recordDecision({...base,evidence_refs:[{artifact_path:'x\n',git_ref:'ref'}]},f.e()),'INVALID_EVIDENCE_REFERENCE');
 assert.equal(f.s.db.prepare('SELECT task_binding FROM message_bindings WHERE message_id=?').get(message_id).task_binding,'unassigned');
 }finally{f.close();}
});
test('memory references, historical agent, supersedes and pin/unpin restricted updates and replay',()=>{
 const f=fixture();try{const t=f.task(),c=f.s.createConversation({thread_id:'thread'},f.e()).conversation_id;
 const oldId=f.s.remember({kind:'summary',content:'old'},f.e()).memory_id,old=f.s.db.prepare('SELECT * FROM memories WHERE id=?').get(oldId);
 f.s.revokeSession({target_session_id:'b1',expected_session_revision:1,...reason},f.e());
 const args={kind:'summary',content:'new',task_id:t,conversation_id:c,agent:'b',supersedes_id:oldId,pinned:true};
 const m=f.s.remember(args,f.e()).memory_id;assert.deepEqual(f.s.db.prepare('SELECT * FROM memories WHERE id=?').get(oldId),old);
 const before=f.s.db.prepare('SELECT * FROM memories WHERE id=?').get(m);assert.equal(before.thread_id,'thread');assert.equal(before.agent,'b');
 f.time(2000);const e=f.e();f.s.pinMemory({memory_id:m,pinned:false},e);const after=f.s.db.prepare('SELECT * FROM memories WHERE id=?').get(m);assert.deepEqual(after,{...before,pinned:0,updated_at:2000});f.time(3000);f.s.pinMemory({memory_id:m,pinned:false},e);assert.deepEqual(f.s.db.prepare('SELECT * FROM memories WHERE id=?').get(m),after);
 const outside=f.foreign.remember({kind:'summary',content:'outside'},f.e('foreign')).memory_id;
 for(const a of [{kind:'conversation_link',content:'no'},{...args,agent:'missing'},{...args,supersedes_id:outside},{...args,conversation_id:9999}])rejectsUnchanged(f,()=>f.s.remember(a,f.e()),a.kind==='conversation_link'?'INVALID_INPUT':'TARGET_NOT_FOUND');
 rejectsUnchanged(f,()=>f.s.pinMemory({memory_id:outside,pinned:true},f.e()),'TARGET_NOT_FOUND');
 }finally{f.close();}
});
test('recorded tests do not update Task or infer execution, scoped attachment mandatory when supplied',()=>{
 const f=fixture();try{const t=f.task(),old=f.row(t);for(const status of ['passed','failed','skipped'])f.s.recordTestResult({task_id:t,command:'not executed by Bus',status,output_summary:'本人報告',git_ref:'ref',cwd:'/reported'},f.e('c'));assert.deepEqual(f.row(t),old);
 const other=f.foreign.createTask({title:'other'},f.e('foreign')).task_id;rejectsUnchanged(f,()=>f.s.recordTestResult({task_id:other,command:'x',status:'passed',output_summary:''},f.e()),'TARGET_NOT_FOUND');
 }finally{f.close();}
});

function actions(f,t){return [
 ['createTask',{title:'new'}],['updateTask',{task_id:t,expected_task_revision:1,patch:{state:'working'}}],
 ['releaseTask',{task_id:t,expected_task_revision:1,mode:'preserve_state'}],['acknowledgeTask',{task_id:t,expected_task_revision:1,response:'claimed',note:'note'},'b'],
 ['submitReview',{task_id:t,expected_task_revision:1,approved:false},'c'],['handoffTask',{task_id:t,expected_task_revision:1,to_agent:'c',reason:'handoff',references:[]}],
 ['cancelTask',{task_id:t,expected_task_revision:1,reason:'stop'}],['recordTaskEvent',{task_id:t,expected_task_revision:1,event_type:'phase',message:'record',metadata:{},task_patch:{state:'working'}}],
 ['recordDecision',{decision:'d',implemented:false,decision_state:'proposed',evidence_refs:[]}],['recordTestResult',{task_id:t,command:'cmd',status:'passed',output_summary:'report'}],['remember',{kind:'summary',content:'record',task_id:t}],
 ];}
test('all new mutation paths rollback at before_commit and exactly replay after_commit response loss',()=>{
 for(const point of ['before_commit','after_commit']){
 const seed=fixture(),t0=seed.task();seed.call('assignTask',t0,{to_agent:'b'});const names=actions(seed,t0).map(a=>a[0]);seed.close();
 for(const method of [...names,'claimTask','assignTask','pinMemory']){
 const f=fixture();try{const t=f.task();let args,actor='a';
 if(method==='claimTask')args={task_id:t,expected_task_revision:0};
 else if(method==='assignTask')args={task_id:t,expected_task_revision:0,to_agent:'b'};
 else if(method==='pinMemory')args={memory_id:f.s.remember({kind:'summary',content:'old'},f.e()).memory_id,pinned:true};
 else {f.call('assignTask',t,{to_agent:'b'});[,args,actor='a']=actions(f,t).find(a=>a[0]===method);}
 const e=f.e(actor),before=snapshot(f.s);const faulty=new Registration(f.path,scope,{now:()=>2000,fault:p=>{if(p===point)throw new Error('injected');}});
 assert.throws(()=>faulty[method](args,e),/injected/);faulty.close();
 if(point==='before_commit')assert.deepEqual(snapshot(f.s),before);
 else {const saved=snapshot(f.s);assert.equal(f.s[method](args,e).replayed,true);assert.deepEqual(snapshot(f.s),saved);}
 }finally{f.close();}
 }}
});
test('event, ancillary row and receipt SQL failures rollback Task and all associated writes',()=>{
 const f=fixture();try{const t=f.task();f.call('assignTask',t,{to_agent:'b'});
 for(const table of ['task_events','communication_events','operation_receipts']){
 f.s.db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END`);
 rejectsUnchanged(f,()=>f.call('cancelTask',t,{reason:'stop'}),'injected');f.s.db.exec('DROP TRIGGER fail_insert');
 }
 f.s.db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT,'injected'); END");
 rejectsUnchanged(f,()=>f.call('handoffTask',t,{to_agent:'c',reason:'handoff',references:[]}),'injected');f.s.db.exec('DROP TRIGGER fail_insert');
 }finally{f.close();}
});
function worker(f,action,gate){
 let ready,locked,started,done;const r=new Promise(x=>ready=x),l=new Promise(x=>locked=x),st=new Promise(x=>started=x),end=new Promise(x=>done=x);
 const child=fork(resolve('test/helpers/registration-worker.mjs'),[],{env:{...process.env,AB24_CONFIG:JSON.stringify({path:f.path,scope,...action,gate})},silent:true});let result;
 child.on('message',m=>{if(m.ready)ready();else if(m.locked)locked();else if(m.started)started();else result=m;});child.on('exit',code=>done(result??{exit:code}));
 return {r,l,st,end,go:()=>child.send('go')};
}
async function ordered(f,first,second){const gate=join(root,`gate-${seq++}`),a=worker(f,first,gate),b=worker(f,second);await Promise.all([a.r,b.r]);a.go();await a.l;b.go();await b.st;writeFileSync(gate,'go');return Promise.all([a.end,b.end]);}
test('concurrent claims serialize CAS; assignment vs revocation has both ordered outcomes',async()=>{
 const f=fixture();try{const t=f.task(),[a,b]=await ordered(f,{method:'claimTask',args:{task_id:t,expected_task_revision:0},envelope:f.e('b')},{method:'claimTask',args:{task_id:t,expected_task_revision:0},envelope:f.e('c')});assert.equal(a.ok,true);assert.equal(b.code,'REVISION_CONFLICT');assert.equal(f.row(t).claimed_by,'b');}finally{f.close();}
 for(const revokeFirst of [true,false]){const f=fixture();try{const t=f.task(),revoke={method:'revokeSession',args:{target_session_id:'b1',expected_session_revision:1,...reason},envelope:f.e()},assign={method:'assignTask',args:{task_id:t,expected_task_revision:0,to_agent:'b'},envelope:f.e()};const [first,second]=await ordered(f,...(revokeFirst?[revoke,assign]:[assign,revoke]));assert.equal(first.ok,true);if(revokeFirst){assert.equal(second.code,'RECIPIENT_SCOPE_MISMATCH');assert.equal(f.row(t).claimed_by,null);}else{assert.equal(second.ok,true);assert.equal(f.row(t).claimed_by,'b');}}finally{f.close();}}
});
test('revoked requester/holder cannot delegate automatically; explicit same-actor registration resumes',()=>{
 const f=fixture();try{const t=f.task();f.call('assignTask',t,{to_agent:'b'});
 f.s.revokeSession({target_session_id:'a1',expected_session_revision:1,...reason},f.e('c'));f.s.revokeSession({target_session_id:'b1',expected_session_revision:1,...reason},f.e('c'));
 rejectsUnchanged(f,()=>f.call('handoffTask',t,{to_agent:'c',reason:'takeover',references:[]},'c'),'TASK_FORBIDDEN');
 rejectsUnchanged(f,()=>f.call('updateTask',t,{patch:{state:'working'}}),'SESSION_REVOKED');
 f.s.register({role:'worker',provider:'test',expected_registration_revision:1},f.e('a','a2'));
 f.s.releaseTask({task_id:t,expected_task_revision:1,mode:'reopen'},f.e('a','a2'));assert.equal(f.row(t).state,'open');
 }finally{f.close();}
});
test('all structured reference table kinds reject foreign scope, including null-vs-empty scope',()=>{
 const f=fixture();try{const e=f.e('foreign'),w=f.foreign,t=w.createTask({title:'out'},e).task_id,c=w.createConversation({thread_id:'out'},f.e('foreign')).conversation_id;
 const refs=[['tasks',t],['conversations',c],['messages',w.send({to:'foreign',content:'out',task_id:null,conversation_id:c},f.e('foreign')).message_id],['memories',w.remember({kind:'summary',content:'out'},f.e('foreign')).memory_id],['decisions',w.recordDecision({decision:'out',implemented:false,decision_state:'proposed',evidence_refs:[]},f.e('foreign')).decision_id],['test_results',w.recordTestResult({task_id:null,command:'out',status:'skipped',output_summary:''},f.e('foreign')).test_result_id],['task_events',w.recordTaskEvent({task_id:t,event_type:'note',message:'out',metadata:{}},f.e('foreign')).task_event_id]];
 for(const [table,id] of refs)rejectsUnchanged(f,()=>f.s.recordDecision({decision:'x',implemented:false,decision_state:'proposed',evidence_refs:[{table,id}]},f.e()),'TARGET_NOT_FOUND');
 }finally{f.close();}
});
test('dev.1 is refused without modification; initializer never overwrites an existing target',()=>{
 const f=fixture();const path=f.path;f.s.db.exec("UPDATE bus_meta SET schema_version='2.4-dev.1'");f.close();
 const hash=()=>createHash('sha256').update(readFileSync(path)).digest('hex'),before=hash();assert.throws(()=>new Registration(path,scope),/UNSUPPORTED_SCHEMA/);assert.throws(()=>initializeTarget(path,[scope]));assert.equal(hash(),before);
});

test('blocked handoff to nobody retains wait, requester explicitly reopens; legacy automation columns stay untouched',()=>{
 const f=fixture();try{const t=f.task();f.call('assignTask',t,{to_agent:'b'});f.call('updateTask',t,{patch:technical});
 f.s.db.prepare("UPDATE tasks SET required_capability='legacy-record' WHERE id=?").run(t);
 f.call('handoffTask',t,{to_agent:null,reason:'return',references:[]});let r=f.row(t);assert.equal(r.state,'blocked');assert.equal(r.wait_kind,'technical');assert.equal(r.claimed_by,null);assert.equal(r.required_capability,'legacy-record');
 f.call('updateTask',t,{patch:{state:'open',clear_wait:true}});assert.equal(f.row(t).state,'open');assert.equal(f.row(t).required_capability,'legacy-record');
 }finally{f.close();}
});
test('pending-assignee review restriction is logical-name based and normal patches preserve historical pending values',()=>{
 const f=fixture();try{const t=f.task({independent_review:true});f.call('assignTask',t,{to_agent:'b'});
 f.s.db.prepare("UPDATE tasks SET pending_assignee='c',required_capability='legacy' WHERE id=?").run(t);
 f.call('updateTask',t,{patch:{description:'record'}});assert.equal(f.row(t).pending_assignee,'c');
 rejectsUnchanged(f,()=>f.call('submitReview',t,{approved:true},'c'),'REVIEW_SELF_FORBIDDEN');f.call('submitReview',t,{approved:false});assert.equal(f.row(t).pending_assignee,'c');
 }finally{f.close();}
});
