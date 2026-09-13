// The fixed smoke's S01-047 fallback assumes its temporary directory has no
// ancestor .git marker. Hide only /tmp/.git inside this test process; never
// rename/delete the workspace's real marker or change the fixed smoke source.
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const original=fs.existsSync;
if(original('/tmp/.git')){
 fs.existsSync=p=>String(p)==='/tmp/.git'?false:original(p);
 syncBuiltinESMExports();
 process.stderr.write('S01-047 fixture isolation: /tmp/.git hidden only from existsSync in this test process.\n');
}
