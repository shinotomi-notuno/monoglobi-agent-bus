import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const [manifestFile,validatorFile]=process.argv.slice(2);
const fail=(m,work)=>{console.error(`導入を中止しました: ${m}${work?`\n調査用work: ${work}`:''}`);process.exit(1)};
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const run=(cmd,args,opt={})=>execFileSync(cmd,args,{stdio:'pipe',encoding:'utf8',...opt});
const manifest=JSON.parse(fs.readFileSync(manifestFile));
const inject=stage=>{if(process.env.AB_FIXTURE_TEST==='1'&&process.env.AB_TEST_FAIL_STAGE===stage)throw Error(`test interruption: ${stage}`)};
if(process.platform!=='linux'||process.arch!=='x64'||!os.release().toLowerCase().includes('microsoft'))fail('対象は WSL2 Linux x64 です。');
if(process.version!=='v22.17.0'||run('npm',['--version']).trim()!=='11.19.1')fail('Node.js 22.17.0 と npm 11.19.1 を Linux 側へ準備してください。');
for(const p of ['curl','tar','sha256sum','flock'])try{run('command',['-v',p],{shell:true})}catch{fail(`${p} を Linux 側へ準備してください。`)}
const base=process.env.AB_FIXTURE_TEST==='1'&&process.env.AB_INSTALL_BASE?process.env.AB_INSTALL_BASE:path.join(process.env.HOME,'.local/share/monoglobi-agent-bus');
for(const p of [base,path.join(base,'.work'),path.join(base,'installations')]){if(fs.existsSync(p)){const s=fs.lstatSync(p);if(s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0)fail(`管理対象ではない保存先です: ${p}`)}else fs.mkdirSync(p,{mode:0o700,recursive:true});}
const archive=Object.entries(manifest.assets).find(([n])=>n.endsWith('-kit.tar.gz')); if(!archive)fail('manifestにkitがありません');
const prefix=path.join(base,'installations',`${manifest.version}-${archive[1].sha256.slice(0,12)}`);
if(fs.existsSync(prefix)){try{run(process.execPath,[validatorFile,'installed',prefix,manifestFile]);console.log(`導入済み: ${manifest.version}\n保存先: ${prefix}\nMCP: ${path.join(prefix,'node_modules/.bin/monoglobi-agent-bus-mcp')}\n次は ${path.join(prefix,'INSTALL.md')} の「接続準備」を実施してください。`);process.exit(0)}catch{fail(`同版の既存導入が異常です。${prefix} は変更していません。`)}}
const work=fs.mkdtempSync(path.join(base,'.work','install.')); fs.chmodSync(work,0o700); fs.writeFileSync(path.join(work,'install.log'),'started '+new Date().toISOString()+'\n',{mode:0o600});
try{
 const downloads=path.join(work,'assets');fs.mkdirSync(downloads,{mode:0o700});
 const proto=process.env.AB_FIXTURE_TEST==='1'?(process.env.AB_TEST_HTTP==='1'?'=file,http,https':'=file,https'):'=https';for(const [name,a] of Object.entries(manifest.assets)){const out=path.join(downloads,name);run('curl',['--fail','--location','--proto',proto,'--connect-timeout','10','--max-time','120','--output',out,new URL(a.path,manifest.asset_base).href]);if(sha(out)!==a.sha256)throw Error(`asset hash mismatch: ${name}`)}
 inject('after-download');
 run('sha256sum',['-c','SHA256SUMS'],{cwd:downloads});run(process.execPath,[validatorFile,'archive',path.join(downloads,archive[0]),manifestFile]);
 run('tar',['-xzf',path.join(downloads,archive[0]),'-C',work,'--strip-components=1']);run('sha256sum',['-c','CHECKSUMS'],{cwd:work});
 const config=path.join(work,'npmrc'),globalConfig=path.join(work,'npm-globalrc');fs.writeFileSync(config,'fund=false\naudit=false\n');fs.writeFileSync(globalConfig,'fund=false\naudit=false\n');
 const npmEnv={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR??'/tmp',NPM_CONFIG_USERCONFIG:config,NPM_CONFIG_GLOBALCONFIG:globalConfig};const npmArgs=['ci','--omit=dev','--cache',path.join(work,'npm-cache'),'--userconfig',config,'--globalconfig',globalConfig,'--foreground-scripts','--no-audit','--no-fund'];if(process.env.AB_FIXTURE_TEST==='1'&&process.env.AB_TEST_NPM_REGISTRY)npmArgs.push('--registry',process.env.AB_TEST_NPM_REGISTRY,'--fetch-retries=0','--fetch-timeout=1000');
 run('npm',npmArgs,{cwd:work,env:npmEnv});
 inject('after-npm');
 run(process.execPath,[validatorFile,'installed',work,manifestFile]);
 if(fs.existsSync(prefix))throw Error(`確定先が競合しました: ${prefix}`);
 inject('before-commit');
 const before=fs.statSync(work);run('mv',['-T','--no-clobber',work,prefix]);const after=fs.statSync(prefix);if(after.dev!==before.dev||after.ino!==before.ino)throw Error(`確定先が競合しました: ${prefix}`);
 inject('after-commit');
 run(process.execPath,[validatorFile,'installed',prefix,manifestFile]);
 console.log(`導入完了: ${manifest.version}\n保存先: ${prefix}\nMCP: ${path.join(prefix,'node_modules/.bin/monoglobi-agent-bus-mcp')}\n次は ${path.join(prefix,'INSTALL.md')} の「接続準備」を実施してください。`);
 }catch(e){const logRoot=fs.existsSync(prefix)&&fs.existsSync(path.join(prefix,'install.log'))?prefix:work;fs.appendFileSync(path.join(logRoot,'install.log'),String(e.stack??e)+'\n');fail(e.message,logRoot)}
