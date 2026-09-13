import {Delivery} from '../../dist/v2/delivery.js';
import {readFileSync} from 'node:fs';
const c=JSON.parse(process.env.TEST_DELIVERY_CONFIG);
const d=new Delivery(c.path,c.scope,{now:()=>c.clockFile?Number(readFileSync(c.clockFile,'utf8')):c.now,
 fault:point=>{if(point===c.exitAt)process.exit(71);if(point==='before_commit'&&c.notifyCommit)process.send({point});}});
process.send({ready:true});
process.on('message',message=>{
 if(message!=='go')return;
 try{const result=d[c.method](c.args,c.envelope);process.send({ok:true,result});}
 catch(e){process.send({ok:false,code:e.code??e.message});}
 finally{d.close();process.disconnect();}
});
