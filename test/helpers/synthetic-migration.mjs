// Test-only declaration for newly generated synthetic fixtures. No production bypass.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {migrateStoppedCopy as migrate} from '../../dist/v2/migrate.js';
export function confirmation(source){return {kind:'new_synthetic_fixture',generator:'test/helpers/synthetic-migration.mjs',source_path:resolve(source),source_sha256:createHash('sha256').update(readFileSync(source)).digest('hex'),old_secrets_absent:true};}
export function migrateStoppedCopy(source,target,stopped,options={}){return migrate(source,target,stopped,{...options,inputConfirmation:confirmation(source)});}
