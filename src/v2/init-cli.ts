#!/usr/bin/env node
import {initializeTarget} from './initialize.js';
try {
 if(process.argv.length!==4)throw new Error('Usage: monoglobi-agent-bus-init NEW_DB_PATH JSON_SCOPE_ARRAY');
 process.stdout.write(JSON.stringify(initializeTarget(process.argv[2]!,JSON.parse(process.argv[3]!)))+'\n');
}catch(error){process.stderr.write((error as Error).message+'\n');process.exitCode=1;}
