import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {initializeTarget} from '../dist/v2/initialize.js';
import {Registration} from '../dist/v2/registration.js';
import {LegacyAdapter} from '../dist/v2/legacy-adapter.js';

test('v2 cross-process CLI: five concurrent explicit sends, replay across process restart, legacy read and new reply',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ab24-cross-')),path=join(dir,'bus.db'),scope={project:'p',area:null,team:null},meta=initializeTarget(path,[scope]),w=new Registration(path,scope);
 const e=(actor='a')=>({actor,session_id:actor+'1',request_id:randomUUID(),origin_instance_uuid:meta.instance_uuid});let sequence=0;
 const run=(tool,args)=>{const file=join(dir,`${sequence++}.json`);writeFileSync(file,JSON.stringify(args),{mode:0o600});return new Promise((resolve,reject)=>{const c=spawn(process.execPath,['dist/v2/cli.js',path,JSON.stringify(scope),tool,file]);let out='',err='';c.stdout.on('data',x=>out+=x);c.stderr.on('data',x=>err+=x);c.on('error',reject);c.on('close',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));});};
 try{for(const actor of ['a','b'])w.register({role:'worker',provider:'test',expected_registration_revision:0},e(actor));const conversation_id=w.createConversation({thread_id:'thread'},e()).conversation_id;
 const requests=Array.from({length:5},(_,i)=>({to:'b',content:'message '+i,conversation_id,task_id:null,envelope:e()}));
 const result=await Promise.all(requests.map(a=>run('send_message_v2',a)));assert.equal(new Set(result.map(r=>r.message_id)).size,5);
 const replay=await run('send_message_v2',requests[0]);assert.equal(replay.replayed,true);assert.equal(replay.message_id,result[0].message_id);assert.equal(w.db.prepare('SELECT count(*) n FROM messages').get().n,5);
 const legacy=new LegacyAdapter(path,scope);try{assert.equal((await legacy.call('inbox',{agent:'b',mark_delivered:false})).length,5);}finally{legacy.close();}
 const question=await run('ask_async_v2',{to:'b',content:'explicit question',conversation_id,task_id:null,envelope:e()});
 const received=await run('receive_immediate_v2',{limit:10,envelope:e('b')}),authority=received.items.find(x=>x.message_id===question.message_id);
 const answer=await run('reply_v2',{message_id:question.message_id,content:'explicit answer',reply_generation:authority.reply_generation,reply_token:authority.reply_token,envelope:e('b')});assert.ok(answer.reply_id);
 const read=new LegacyAdapter(path,scope);try{assert.equal(read.call('message_status',{message_id:question.message_id}).reply.content,'explicit answer');}finally{read.close();}
 }finally{w.close();}
});
