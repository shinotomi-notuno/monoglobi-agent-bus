import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
const [mode,target,manifestFile]=process.argv.slice(2),fail=m=>{console.error('検証失敗: '+m);process.exit(1)},sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest=JSON.parse(fs.readFileSync(manifestFile));
const names=['CHECKSUMS','INSTALL.md','LICENSE','NOTICE','THIRD_PARTY_LICENSES.json','monoglobi-agent-bus-0.1.0-dev.2.tgz','package-lock.json','package.json'];
if(mode==='archive'){
 const root='monoglobi-agent-bus-0.1.0-dev.2-kit/',list=execFileSync('tar',['-tzf',target],{encoding:'utf8'}).trim().split('\n'),ok=new Set([root,...names.map(n=>root+n)]);
 if(list.length!==ok.size||new Set(list).size!==list.length||list.some(n=>!ok.has(n)||n.includes('..')||n.startsWith('/')||n.includes('\\')))fail('archive entry');
 const verbose=execFileSync('tar',['-tvzf',target],{encoding:'utf8'});if(verbose.split('\n').some(x=>x&&!/^[d-]/.test(x)))fail('archive link');
 if(fs.statSync(target).size>5*1024*1024)fail('archive size');process.exit(0);
}
if(mode!=='installed')fail('mode');
for(const n of names){const p=path.join(target,n);if(!fs.existsSync(p)||!fs.lstatSync(p).isFile())fail('必須ファイル不足: '+n)}
if(sha(path.join(target,'package-lock.json'))!==manifest.root_lock_sha256)fail('root lock hash');
try{execFileSync('sha256sum',['-c','CHECKSUMS'],{cwd:target,stdio:'ignore'});execFileSync('npm',['ls','--omit=dev','--all','--json'],{cwd:target,stdio:'ignore'})}catch{fail('runtime lock/tree')}
const lock=JSON.parse(fs.readFileSync(path.join(target,'package-lock.json')));for(const [place,v] of Object.entries(lock.packages)){if(!place)continue;const p=path.join(target,place,'package.json');if(!fs.existsSync(p))fail('runtime欠落: '+place);const q=JSON.parse(fs.readFileSync(p));if(q.version!==v.version)fail('runtime版不一致: '+place)}
const expected=new Set(Object.keys(lock.packages).filter(p=>p.startsWith('node_modules/'))),actual=new Set();function walk(dir,rel='node_modules'){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name==='.bin')continue;const p=path.join(dir,e.name),r=path.posix.join(rel,e.name);if(!e.isDirectory())continue;if(e.name.startsWith('@')){walk(p,r);continue}if(fs.existsSync(path.join(p,'package.json')))actual.add(r);const nested=path.join(p,'node_modules');if(fs.existsSync(nested))walk(nested,r+'/node_modules')}}walk(path.join(target,'node_modules'));if([...actual].some(p=>!expected.has(p))||[...expected].some(p=>!actual.has(p)))fail('runtime余分または欠落');
for(const n of ['monoglobi-agent-bus-mcp','monoglobi-agent-bus-init','monoglobi-agent-bus-recover','monoglobi-agent-bus-v2']){const p=path.join(target,'node_modules/.bin',n);if(!fs.existsSync(p)||!fs.realpathSync(p).startsWith(path.join(target,'node_modules')+path.sep))fail('bin不整合: '+n)}
try{execFileSync(process.execPath,['-e',"const D=require('better-sqlite3');let d=new D(':memory:');d.exec('create table x(a);insert into x values(1)');if(d.prepare('select count(*) n from x').get().n!==1)process.exit(1);d.close()"],{cwd:target,stdio:'ignore'})}catch{fail('native DB操作')}
