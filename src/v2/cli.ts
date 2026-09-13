#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {ToolRuntime} from './tool-runtime.js';
import {recoveryEntryError} from './recovery-entry.js';
let runtime:ToolRuntime|undefined;
try {
 if(process.argv.length!==6)throw new Error('Usage: monoglobi-agent-bus-v2 DB_PATH JSON_SCOPE TOOL REQUEST_JSON_FILE. Preserve envelope/request IDs before calling. retire_team_v2 closes registration permanently for this scope; after all Sessions are revoked online registration cannot resume.');
 runtime=new ToolRuntime(process.argv[2]!,JSON.parse(process.argv[3]!),true,process.env.AGENT_BUS_V2_LEGACY==='1');
 const result=await runtime.call(process.argv[4]!,JSON.parse(readFileSync(process.argv[5]!,'utf8')));
 process.stdout.write(JSON.stringify(result)+'\n');
}catch(error){const code=recoveryEntryError(error);process.stderr.write(JSON.stringify(runtime?runtime.error(error):code.startsWith('RECOVERY_')&&error instanceof Error&&error.message===code?{code}:{code:'INVALID_INPUT',message:(error as Error).message})+'\n');process.exitCode=1;}
finally{runtime?.close();}
