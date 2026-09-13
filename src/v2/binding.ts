import type Database from 'better-sqlite3';
import type { Row } from './schema.js';
export function binding(db:Database.Database,id:number):Row {
  const row=db.prepare('SELECT * FROM message_bindings WHERE message_id=?').get(id) as Row|undefined;
  if(!row)throw new Error('MESSAGE_BINDING_MISSING');return row;
}
export function saveBinding(db:Database.Database,id:number,taskId:number|null,askId:number|null):void {
  const parent=askId===null?null:binding(db,askId);
  db.prepare('INSERT INTO message_bindings(message_id,task_ids,task_binding,basis,coverage,evidence_json) VALUES(?,?,?,?,?,?)')
    .run(id,parent?.task_ids??JSON.stringify(taskId===null?[]:[taskId]),parent?.task_binding??(taskId===null?'unassigned':'assigned'),
      parent?'reply_inherited':taskId===null?'explicit_null':'explicit_task',parent?.coverage??'creation_recorded',
      JSON.stringify(parent?{ask_id:askId,source_basis:parent.basis}:{task_id:taskId}));
}
