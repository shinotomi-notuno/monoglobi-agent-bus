import {Registration} from '../../dist/v2/registration.js';
import {existsSync} from 'node:fs';
const c=JSON.parse(process.env.AB24_CONFIG);
const store=new Registration(c.path,c.scope,{now:()=>10000,fault:point=>{
 if(point===c.exitAt)process.exit(71);
 if(point==='locked'&&c.gate){process.send({locked:true});while(!existsSync(c.gate))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
}});
process.send({ready:true});
process.on('message',m=>{if(m!=='go')return;process.send({started:true});
 try{process.send({ok:true,result:store[c.method](c.args,c.envelope)});}catch(e){process.send({ok:false,code:e.message});}
 finally{store.close();process.disconnect();}
});
