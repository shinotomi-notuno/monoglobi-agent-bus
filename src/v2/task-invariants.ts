import type Database from 'better-sqlite3';
import type {Row} from './schema.js';
export function validateTask(db:Database.Database,next:Row):void {
 if(!['backlog','open','claimed','working','blocked','completed','failed','canceled'].includes(next.state)||!Number.isSafeInteger(next.priority))throw new Error('INVALID_TASK_WAIT');
  if(next.state!=='blocked') {
   if(next.wait_kind!=='none'||next.human_question_id!==null||next.blocked_reason!==null||next.blocked_on_task_id!==null)throw new Error('INVALID_TASK_WAIT');
  }else {
   if(!['technical','human'].includes(next.wait_kind)||typeof next.blocked_reason!=='string'||!next.blocked_reason.trim())throw new Error('INVALID_TASK_WAIT');
   if(next.wait_kind==='technical'&&next.human_question_id!==null)throw new Error('INVALID_TASK_WAIT');
   if(next.wait_kind==='human') {
    if(!Number.isSafeInteger(next.human_question_id)||!db.prepare("SELECT 1 FROM messages q JOIN task_conversation_versions v ON v.conversation_id=q.conversation_id WHERE q.id=? AND q.scope_id=? AND q.kind='ask' AND v.task_id=? AND v.ended_rev IS NULL").get(next.human_question_id,next.scope_id,next.id))throw new Error('HUMAN_QUESTION_REQUIRED');
   }
  }
  if(next.blocked_on_task_id!==null && (!Number.isSafeInteger(next.blocked_on_task_id)||next.blocked_on_task_id===next.id||!db.prepare('SELECT 1 FROM tasks WHERE id=? AND scope_id=?').get(next.blocked_on_task_id,next.scope_id)))throw new Error('INVALID_DEPENDENCY');
  if(next.claimed_by!==null && (typeof next.claimed_by!=='string'||!db.prepare('SELECT 1 FROM registered_sessions WHERE actor=? AND scope_id=?').get(next.claimed_by,next.scope_id)))throw new Error('SESSION_SCOPE_MISMATCH');
}
