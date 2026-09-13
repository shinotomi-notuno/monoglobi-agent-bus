import type Database from 'better-sqlite3';
import type {Row} from './schema.js';
export function textInput(value:unknown):asserts value is string {
 if(typeof value!=='string'||!value.trim())throw new Error('INVALID_INPUT');
}
export function input(args:Row,fields:string[]) {
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!fields.includes(k)))throw new Error('INVALID_INPUT');
}
export function revision(value:unknown,min=1):asserts value is number {
 if(!Number.isSafeInteger(value)||(value as number)<min)throw new Error('INVALID_INPUT');
}
export function identity(db:Database.Database,sid:number,e:{actor:string;session_id:string}):Row|undefined {
 return db.prepare('SELECT * FROM registered_sessions WHERE actor=? AND session_id=? AND scope_id=?').get(e.actor,e.session_id,sid) as Row|undefined;
}
export function activeSession(db:Database.Database,sid:number,e:{actor:string;session_id:string}):boolean {
 return !!db.prepare(`SELECT 1 FROM registered_sessions s JOIN agent_registrations a USING(scope_id,actor,generation)
   WHERE s.scope_id=? AND s.actor=? AND s.session_id=? AND s.active=1 AND a.active=1`).get(sid,e.actor,e.session_id);
}
export function activeRecipient(db:Database.Database,sid:number,actor:unknown):boolean {
 return typeof actor==='string'&&!!db.prepare(`SELECT 1 FROM agent_registrations a JOIN registered_sessions s USING(scope_id,actor,generation)
   WHERE a.scope_id=? AND a.actor=? AND a.active=1 AND s.active=1`).get(sid,actor);
}
export type RegisterArgs={role:string;provider:string;expected_registration_revision:number};
/** Fixed bootstrap business operation; not a caller-supplied mutation callback. */
export function registerBusiness(db:Database.Database,sid:number,args:RegisterArgs,e:{actor:string;session_id:string},now:number):Row {
 input(args,['role','provider','expected_registration_revision']);textInput(args.role);textInput(args.provider);revision(args.expected_registration_revision,0);
 if(db.prepare('SELECT 1 FROM registered_sessions WHERE session_id=?').get(e.session_id))throw new Error('ALREADY_REGISTERED');
 const state=db.prepare('SELECT * FROM scope_registration_state WHERE scope_id=?').get(sid) as Row|undefined;
 if(!state)throw new Error('SCOPE_NOT_FOUND');
 if(!state.accepting_registrations)throw new Error('REGISTRATION_RETIRED');
 const old=db.prepare('SELECT * FROM agent_registrations WHERE scope_id=? AND actor=? ORDER BY generation DESC LIMIT 1').get(sid,e.actor) as Row|undefined;
 if((old?.revision??0)!==args.expected_registration_revision)throw new Error('REVISION_CONFLICT');
 if(old?.active&&(old.role!==args.role||old.provider!==args.provider))throw new Error('REGISTRATION_METADATA_MISMATCH');
 const generation=old?.active?old.generation:(old?.generation??0)+1,rev=(old?.revision??0)+1;
 // Legacy Task foreign keys reference agents(name). This retained name anchor is
 // not an authority/session registry; all v2 permission checks use the tables above.
 db.prepare('INSERT OR IGNORE INTO agents(name,registered_at,last_seen) VALUES(?,?,?)').run(e.actor,now,now);
 if(old?.active)db.prepare('UPDATE agent_registrations SET revision=?,updated_at=? WHERE scope_id=? AND actor=? AND generation=?').run(rev,now,sid,e.actor,generation);
 else db.prepare('INSERT INTO agent_registrations VALUES(?,?,?,?,1,?,?,?, ?,NULL,?)').run(sid,e.actor,generation,rev,args.role,args.provider,'registered',now,now);
 db.prepare('INSERT INTO registered_sessions(actor,session_id,scope_id,generation,registered_at) VALUES(?,?,?,?,?)').run(e.actor,e.session_id,sid,generation,now);
 return {actor:e.actor,session_id:e.session_id,registration_generation:generation,registration_revision:rev,session_revision:1};
}
