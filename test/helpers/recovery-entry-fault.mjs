// Test process preload only. Not imported by any production entrypoint.
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const original=fs.renameSync;let n=0;
fs.renameSync=(from,to)=>{
 const artifact=!String(from).endsWith('.tmp');
 if(artifact&&process.env.R01_TEST_FAULT===`before_${++n}`)process.kill(process.pid,'SIGKILL');
 original(from,to);
 if(artifact&&process.env.R01_TEST_FAULT===`after_${n}`)process.kill(process.pid,'SIGKILL');
};
syncBuiltinESMExports();
