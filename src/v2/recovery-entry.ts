import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
/** No repair, self-derived expectation, or gate release at normal startup. */
export function guardNormalStartup(path:string):void {
 path=resolve(path);
 if(existsSync(path+'.replacement.json'))throw new Error('RECOVERY_RENAME_UNKNOWN');
 if(existsSync(path+'.replace.lock'))throw new Error('RECOVERY_REPLACE_REFUSED');
}
export function recoveryEntryError(error:unknown):string {
 const message=error instanceof Error?error.message:'';
 const allowed=['INVALID_INPUT','RECOVERY_IDENTITY_MISMATCH','RECOVERY_OUTCOME_UNKNOWN',
  'RECOVERY_RENAME_UNKNOWN','RECOVERY_REPLACE_REFUSED','RECOVERY_READ_ONLY','MIGRATION_DEADLINE_EXCEEDED'];
 if(allowed.includes(message))return message;
 if(error instanceof SyntaxError)return 'INVALID_INPUT';
 // Never expose raw JSON, SQL, filesystem exceptions, receipt results or secrets.
 return 'RECOVERY_REPLACE_REFUSED';
}
