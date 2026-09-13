import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { initializeLegacySchema } from '../db.js';

export type Scope = {project: string|null; area: string|null; team: string|null};
export type Row = Record<string, any>;
export const schemaVersion = '2.4-dev.2';
export const apiVersion = '2.4-development';
export function scopeKey(s: Scope): string {
  if(!s||typeof s!=='object'||Array.isArray(s))throw new Error('INVALID_SCOPE');
  for (const k of ['project','area','team'] as const) {
    if (!(s[k] === null || typeof s[k] === 'string') || s[k] === '*') throw new Error('INVALID_SCOPE');
  }
  return JSON.stringify([s.project,s.area,s.team]);
}
export function scopeId(db: Database.Database, s: Scope): number {
  const key=scopeKey(s);
  db.prepare('INSERT OR IGNORE INTO scopes(scope_key,project,area,team) VALUES (?,?,?,?)').run(key,s.project,s.area,s.team);
  return (db.prepare('SELECT scope_id FROM scopes WHERE scope_key=?').get(key) as Row).scope_id;
}
export function installSchema(db: Database.Database): void {
  db.pragma('foreign_keys=ON');
  initializeLegacySchema(db);
  db.exec(`
    CREATE TABLE bus_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), lineage_uuid TEXT NOT NULL,
      instance_uuid TEXT NOT NULL, schema_version TEXT NOT NULL, api_version TEXT NOT NULL,
      relation_revision INTEGER NOT NULL DEFAULT 0, cursor_epoch INTEGER NOT NULL DEFAULT 1,
      lease_clock_ms INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0,
      recovery_state TEXT NOT NULL DEFAULT 'development_only');
    CREATE TABLE scopes(scope_id INTEGER PRIMARY KEY AUTOINCREMENT,scope_key TEXT NOT NULL UNIQUE,
      project TEXT,area TEXT,team TEXT);
    CREATE TABLE conversations(conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,scope_id INTEGER NOT NULL REFERENCES scopes,
      thread_id TEXT NOT NULL, UNIQUE(scope_id,thread_id));
    ALTER TABLE decisions ADD COLUMN decision_state TEXT CHECK(decision_state IN ('proposed','agreed'));
    ALTER TABLE decisions ADD COLUMN evidence_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_refs));
    ALTER TABLE memories ADD COLUMN handoff_references TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(handoff_references));
    ALTER TABLE tasks ADD COLUMN scope_id INTEGER REFERENCES scopes;
    ALTER TABLE tasks ADD COLUMN task_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN wait_kind TEXT NOT NULL DEFAULT 'none' CHECK(wait_kind IN ('none','technical','human','unknown'));
    ALTER TABLE tasks ADD COLUMN human_question_id INTEGER REFERENCES messages;
    ALTER TABLE tasks ADD COLUMN migration_issue_id INTEGER;
    ALTER TABLE messages ADD COLUMN scope_id INTEGER REFERENCES scopes;
    ALTER TABLE messages ADD COLUMN conversation_id INTEGER REFERENCES conversations;
    ALTER TABLE messages ADD COLUMN message_purpose TEXT;
    CREATE TABLE task_conversation_versions(link_version_id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks,conversation_id INTEGER NOT NULL REFERENCES conversations,
      born_rev INTEGER NOT NULL,ended_rev INTEGER,previous_version_id INTEGER REFERENCES task_conversation_versions,
      reason TEXT NOT NULL,actor TEXT NOT NULL,
      CHECK(ended_rev IS NULL OR ended_rev>born_rev),
      CHECK(previous_version_id IS NULL OR previous_version_id<link_version_id));
    CREATE UNIQUE INDEX current_link ON task_conversation_versions(task_id,conversation_id) WHERE ended_rev IS NULL;
    CREATE UNIQUE INDEX one_successor ON task_conversation_versions(previous_version_id) WHERE previous_version_id IS NOT NULL;
    CREATE INDEX link_task_page ON task_conversation_versions(task_id,link_version_id);
    CREATE INDEX message_conversation_page ON messages(conversation_id,id);
    CREATE TABLE migration_runs(run_id TEXT PRIMARY KEY,source_path TEXT NOT NULL,source_hash TEXT NOT NULL,
      source_schema TEXT NOT NULL,target_path TEXT NOT NULL,target_schema TEXT NOT NULL,
      origin_instance_uuid TEXT,scope_json TEXT,started_at INTEGER NOT NULL,finished_at INTEGER,
      status TEXT NOT NULL CHECK(status IN('running','ready','blocked','failed')),issue_count INTEGER NOT NULL DEFAULT 0,
      manifest_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE migration_issues(issue_id INTEGER PRIMARY KEY AUTOINCREMENT,source_table TEXT NOT NULL,
      source_id INTEGER,code TEXT NOT NULL,detail TEXT NOT NULL);
    CREATE TABLE migration_map(source_table TEXT NOT NULL,source_id INTEGER NOT NULL,target_table TEXT NOT NULL,
      target_id INTEGER NOT NULL,classification TEXT NOT NULL,basis TEXT NOT NULL DEFAULT '',
      source_path_sha256 TEXT NOT NULL DEFAULT '',source_content_sha256 TEXT NOT NULL DEFAULT '',
      source_scope_key TEXT NOT NULL DEFAULT '',target_scope_key TEXT NOT NULL DEFAULT '',
      audit_ref TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY(source_table,source_id,target_table,target_id));
    CREATE TABLE migration_manifests(run_id TEXT PRIMARY KEY REFERENCES migration_runs,
      source_hash TEXT NOT NULL,target_hash TEXT NOT NULL,manifest_json TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE delivery_state(message_id INTEGER PRIMARY KEY REFERENCES messages,mode TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,token_hash TEXT,holder_session TEXT,deadline INTEGER,
      completed_generation INTEGER,completion_kind TEXT,reply_generation INTEGER NOT NULL DEFAULT 0,
      reply_holder_session TEXT,reply_token_hash TEXT);
    CREATE TABLE agent_registrations(scope_id INTEGER NOT NULL REFERENCES scopes,actor TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation>0),revision INTEGER NOT NULL CHECK(revision>0),
      active INTEGER NOT NULL CHECK(active IN(0,1)),role TEXT NOT NULL,provider TEXT NOT NULL,
      status TEXT NOT NULL,registered_at INTEGER NOT NULL,revoked_at INTEGER,updated_at INTEGER NOT NULL,
      PRIMARY KEY(scope_id,actor,generation));
    CREATE UNIQUE INDEX one_active_registration ON agent_registrations(scope_id,actor) WHERE active=1;
    CREATE TABLE registered_sessions(actor TEXT NOT NULL,session_id TEXT PRIMARY KEY,scope_id INTEGER NOT NULL,
      generation INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),registered_at INTEGER NOT NULL,revoked_at INTEGER,
      FOREIGN KEY(scope_id,actor,generation) REFERENCES agent_registrations(scope_id,actor,generation));
    CREATE TABLE scope_registration_state(scope_id INTEGER PRIMARY KEY REFERENCES scopes,
      accepting_registrations INTEGER NOT NULL DEFAULT 1 CHECK(accepting_registrations IN(0,1)),revision INTEGER NOT NULL DEFAULT 1);
    CREATE TRIGGER scope_registration_init AFTER INSERT ON scopes BEGIN
      INSERT INTO scope_registration_state(scope_id) VALUES(NEW.scope_id); END;
    CREATE TRIGGER session_identity BEFORE UPDATE ON registered_sessions WHEN
      NEW.session_id IS NOT OLD.session_id OR NEW.actor IS NOT OLD.actor OR NEW.scope_id IS NOT OLD.scope_id
      OR NEW.generation IS NOT OLD.generation OR NEW.registered_at IS NOT OLD.registered_at OR (OLD.active=0 AND NEW.active<>0)
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SESSION'); END;
    CREATE TRIGGER session_no_delete BEFORE DELETE ON registered_sessions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SESSION'); END;
    CREATE TRIGGER registration_identity BEFORE UPDATE ON agent_registrations WHEN
      NEW.scope_id IS NOT OLD.scope_id OR NEW.actor IS NOT OLD.actor OR NEW.generation IS NOT OLD.generation
      OR NEW.role IS NOT OLD.role OR NEW.provider IS NOT OLD.provider OR NEW.registered_at IS NOT OLD.registered_at
      OR (OLD.active=0 AND NEW.active<>0)
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REGISTRATION'); END;
    CREATE TRIGGER registration_no_delete BEFORE DELETE ON agent_registrations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REGISTRATION'); END;
    CREATE TRIGGER registration_scope_fixed BEFORE UPDATE ON scope_registration_state WHEN
      NEW.scope_id IS NOT OLD.scope_id OR (OLD.accepting_registrations=0 AND NEW.accepting_registrations<>0)
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REGISTRATION_SCOPE'); END;
    CREATE TABLE logging_epochs(epoch_id INTEGER PRIMARY KEY AUTOINCREMENT,scope_id INTEGER NOT NULL REFERENCES scopes,
      started_at INTEGER NOT NULL,ended_at INTEGER,state TEXT NOT NULL CHECK(state IN ('open','closed','gap')));
    CREATE TABLE error_events(event_id INTEGER PRIMARY KEY AUTOINCREMENT,scope_id INTEGER NOT NULL REFERENCES scopes,
      code TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('bus','agent_report')),at INTEGER NOT NULL,request_id TEXT,request_ref TEXT,
      target_type TEXT,target_id INTEGER,unknown_reason TEXT,task_ids TEXT NOT NULL,task_binding TEXT NOT NULL,
      retryable INTEGER NOT NULL,summary TEXT NOT NULL,details_ref TEXT,epoch_id INTEGER REFERENCES logging_epochs,
      corrects_event_id INTEGER REFERENCES error_events);
    CREATE INDEX error_scope_page ON error_events(scope_id,event_id);
    CREATE TABLE message_bindings(message_id INTEGER PRIMARY KEY REFERENCES messages,
      task_ids TEXT NOT NULL CHECK(json_valid(task_ids) AND json_type(task_ids)='array'),
      task_binding TEXT NOT NULL CHECK(task_binding IN ('assigned','unassigned','unknown')),
      basis TEXT NOT NULL CHECK(basis IN ('explicit_task','explicit_null','reply_inherited','migration_snapshot')),
      coverage TEXT NOT NULL CHECK(coverage IN ('creation_recorded','historical_unobserved')),
      evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
      CHECK((task_binding='assigned' AND json_array_length(task_ids)>0) OR (task_binding<>'assigned' AND json_array_length(task_ids)=0)));
    CREATE TABLE communication_events(event_id INTEGER PRIMARY KEY AUTOINCREMENT,scope_id INTEGER NOT NULL REFERENCES scopes,
      operation TEXT NOT NULL,at INTEGER NOT NULL,from_agent TEXT,to_agent TEXT,task_ids TEXT NOT NULL,
      task_binding TEXT NOT NULL,purpose TEXT NOT NULL,status TEXT NOT NULL,message_id INTEGER REFERENCES messages,
      request_id TEXT NOT NULL,actor TEXT NOT NULL,session_id TEXT NOT NULL,details_json TEXT NOT NULL);
    CREATE TABLE ask_answers(ask_id INTEGER PRIMARY KEY REFERENCES messages,reply_id INTEGER NOT NULL UNIQUE REFERENCES messages);
    CREATE TABLE task_wait_resolutions(resolution_id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL UNIQUE REFERENCES migration_issues,task_id INTEGER NOT NULL UNIQUE REFERENCES tasks,
      scope_id INTEGER NOT NULL REFERENCES scopes,task_revision INTEGER NOT NULL CHECK(task_revision>0),
      before_json TEXT NOT NULL CHECK(json_valid(before_json)),after_json TEXT NOT NULL CHECK(json_valid(after_json)),
      input_json TEXT NOT NULL CHECK(json_valid(input_json)),evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
      origin_instance_uuid TEXT NOT NULL,actor TEXT NOT NULL,session_id TEXT NOT NULL,request_id TEXT NOT NULL,
      at INTEGER NOT NULL,event_id INTEGER NOT NULL UNIQUE REFERENCES communication_events,
      FOREIGN KEY(origin_instance_uuid,actor,request_id) REFERENCES operation_receipts(origin_instance_uuid,actor,request_id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE operation_receipts(origin_instance_uuid TEXT NOT NULL,actor TEXT NOT NULL,request_id TEXT NOT NULL,
      executed_instance_uuid TEXT NOT NULL,operation TEXT NOT NULL,input_digest TEXT NOT NULL,
      result_json TEXT NOT NULL,committed_at INTEGER NOT NULL,secret_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY(origin_instance_uuid,actor,request_id));
  `);
  // Install before conversion so both migration and subsequent writes obey this invariant.
  for (const event of ['INSERT','UPDATE']) db.exec(`
    CREATE TRIGGER task_unknown_issue_${event.toLowerCase()} BEFORE ${event} ON tasks
      WHEN NEW.wait_kind='unknown' AND NOT EXISTS(
        SELECT 1 FROM migration_issues i WHERE i.issue_id=NEW.migration_issue_id
        AND i.source_table='tasks' AND i.source_id=NEW.id AND i.code='WAIT_UNCLASSIFIED')
      BEGIN SELECT RAISE(ABORT,'INVALID_UNKNOWN_ISSUE'); END;`);
  db.exec(`
    CREATE TRIGGER referenced_wait_issue_insert BEFORE INSERT ON migration_issues
      WHEN EXISTS(SELECT 1 FROM tasks t WHERE t.wait_kind='unknown' AND t.migration_issue_id=NEW.issue_id
        AND (NEW.source_table IS NOT 'tasks' OR NEW.source_id IS NOT t.id OR NEW.code IS NOT 'WAIT_UNCLASSIFIED'))
      BEGIN SELECT RAISE(ABORT,'REFERENCED_UNKNOWN_ISSUE'); END;
    CREATE TRIGGER referenced_wait_issue_update BEFORE UPDATE ON migration_issues
      WHEN EXISTS(SELECT 1 FROM tasks t WHERE t.wait_kind='unknown' AND t.migration_issue_id=OLD.issue_id
        AND (NEW.issue_id IS NOT OLD.issue_id OR NEW.source_table IS NOT 'tasks'
          OR NEW.source_id IS NOT t.id OR NEW.code IS NOT 'WAIT_UNCLASSIFIED'))
      BEGIN SELECT RAISE(ABORT,'REFERENCED_UNKNOWN_ISSUE'); END;
    CREATE TRIGGER referenced_wait_issue_delete BEFORE DELETE ON migration_issues
      WHEN EXISTS(SELECT 1 FROM tasks WHERE wait_kind='unknown' AND migration_issue_id=OLD.issue_id)
      BEGIN SELECT RAISE(ABORT,'REFERENCED_UNKNOWN_ISSUE'); END;
  `);
  const id=randomUUID();
  db.prepare('INSERT INTO bus_meta(singleton,lineage_uuid,instance_uuid,schema_version,api_version) VALUES(1,?,?,?,?)')
    .run(id,randomUUID(),schemaVersion,apiVersion);
}

/** Installed after copy conversion; guards apply to terminal history as well. */
export function installGuards(db: Database.Database): void {
  for (const table of ['tasks','messages']) {
    const condition=`NEW.scope_id IS NULL OR NOT EXISTS(SELECT 1 FROM scopes s WHERE s.scope_id=NEW.scope_id
      AND s.project IS NEW.project AND s.area IS NEW.area AND s.team IS NEW.team)`;
    db.exec(`CREATE TRIGGER ${table}_scope_insert BEFORE INSERT ON ${table} WHEN ${condition}
      BEGIN SELECT RAISE(ABORT,'SCOPE_MISMATCH'); END;
      CREATE TRIGGER ${table}_scope_update BEFORE UPDATE ON ${table}
      WHEN NEW.scope_id IS NOT OLD.scope_id OR NEW.project IS NOT OLD.project OR NEW.area IS NOT OLD.area OR NEW.team IS NOT OLD.team
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SCOPE'); END;
      CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;`);
  }
  db.exec(`
    CREATE TRIGGER resolution_insert BEFORE INSERT ON task_wait_resolutions
      WHEN EXISTS(SELECT 1 FROM task_wait_resolutions WHERE issue_id=NEW.issue_id OR task_id=NEW.task_id)
      OR NOT EXISTS(SELECT 1 FROM tasks t JOIN migration_issues i ON i.issue_id=t.migration_issue_id
        WHERE t.id=NEW.task_id AND t.scope_id=NEW.scope_id AND i.issue_id=NEW.issue_id
          AND i.source_table='tasks' AND i.source_id=t.id AND i.code='WAIT_UNCLASSIFIED'
          AND t.state='blocked' AND t.wait_kind IN ('technical','human') AND t.task_revision=NEW.task_revision)
      BEGIN SELECT RAISE(ABORT,'INVALID_WAIT_RESOLUTION'); END;
    CREATE TRIGGER resolution_update BEFORE UPDATE ON task_wait_resolutions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESOLUTION'); END;
    CREATE TRIGGER resolution_delete BEFORE DELETE ON task_wait_resolutions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESOLUTION'); END;
    CREATE TRIGGER resolved_issue_update BEFORE UPDATE ON migration_issues
      WHEN EXISTS(SELECT 1 FROM task_wait_resolutions WHERE issue_id=OLD.issue_id)
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESOLVED_ISSUE'); END;
    CREATE TRIGGER resolved_issue_delete BEFORE DELETE ON migration_issues
      WHEN EXISTS(SELECT 1 FROM task_wait_resolutions WHERE issue_id=OLD.issue_id)
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESOLVED_ISSUE'); END;
    CREATE TRIGGER resolved_issue_replace BEFORE INSERT ON migration_issues
      WHEN EXISTS(SELECT 1 FROM task_wait_resolutions WHERE issue_id=NEW.issue_id)
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESOLVED_ISSUE'); END;
    CREATE TRIGGER error_events_update BEFORE UPDATE ON error_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVENT'); END;
    CREATE TRIGGER error_events_delete BEFORE DELETE ON error_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVENT'); END;
    CREATE TRIGGER message_bindings_insert BEFORE INSERT ON message_bindings
      WHEN EXISTS(SELECT 1 FROM message_bindings WHERE message_id=NEW.message_id)
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MESSAGE_BINDING'); END;
    CREATE TRIGGER message_bindings_update BEFORE UPDATE ON message_bindings BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MESSAGE_BINDING'); END;
    CREATE TRIGGER message_bindings_delete BEFORE DELETE ON message_bindings BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MESSAGE_BINDING'); END;
    CREATE TRIGGER communication_events_update BEFORE UPDATE ON communication_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVENT'); END;
    CREATE TRIGGER communication_events_delete BEFORE DELETE ON communication_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVENT'); END;
    CREATE TRIGGER ask_answers_insert BEFORE INSERT ON ask_answers
      WHEN NOT EXISTS(SELECT 1 FROM messages q JOIN messages r ON r.reply_to=q.id
        WHERE q.id=NEW.ask_id AND r.id=NEW.reply_id AND q.kind='ask' AND r.kind='reply' AND q.scope_id=r.scope_id)
      BEGIN SELECT RAISE(ABORT,'INVALID_ANSWER'); END;
    CREATE TRIGGER ask_answers_update BEFORE UPDATE ON ask_answers BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ANSWER'); END;
    CREATE TRIGGER ask_answers_delete BEFORE DELETE ON ask_answers BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ANSWER'); END;
    CREATE TRIGGER immutable_scope BEFORE UPDATE ON scopes BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SCOPE'); END;
    CREATE TRIGGER immutable_scope_delete BEFORE DELETE ON scopes BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SCOPE'); END;
    CREATE TRIGGER conversation_immutable BEFORE UPDATE ON conversations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CONVERSATION'); END;
    CREATE TRIGGER conversation_delete BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CONVERSATION'); END;
    CREATE TRIGGER message_conversation_insert BEFORE INSERT ON messages
      WHEN NEW.conversation_id IS NULL OR NOT EXISTS(SELECT 1 FROM conversations c WHERE c.conversation_id=NEW.conversation_id AND c.scope_id=NEW.scope_id AND (NEW.thread_id IS NULL OR c.thread_id=NEW.thread_id))
      BEGIN SELECT RAISE(ABORT,'CONVERSATION_SCOPE_MISMATCH'); END;
    CREATE TRIGGER message_immutable BEFORE UPDATE ON messages WHEN NEW.id IS NOT OLD.id OR NEW.content IS NOT OLD.content
      OR NEW.from_agent IS NOT OLD.from_agent OR NEW.to_agent IS NOT OLD.to_agent OR NEW.thread_id IS NOT OLD.thread_id
      OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.reply_to IS NOT OLD.reply_to OR NEW.kind IS NOT OLD.kind
      OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MESSAGE'); END;
    CREATE TRIGGER task_identity BEFORE UPDATE ON tasks WHEN NEW.id IS NOT OLD.id OR NEW.thread_id IS NOT OLD.thread_id
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TASK_IDENTITY'); END;
    CREATE TRIGGER link_insert BEFORE INSERT ON task_conversation_versions
      WHEN NOT EXISTS(SELECT 1 FROM tasks t JOIN conversations c ON c.scope_id=t.scope_id
        WHERE t.id=NEW.task_id AND c.conversation_id=NEW.conversation_id)
      OR (NEW.previous_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM task_conversation_versions p
        WHERE p.link_version_id=NEW.previous_version_id AND p.task_id=NEW.task_id AND p.conversation_id=NEW.conversation_id
        AND p.ended_rev=NEW.born_rev))
      BEGIN SELECT RAISE(ABORT,'INVALID_LINK'); END;
    CREATE TRIGGER link_immutable BEFORE UPDATE ON task_conversation_versions
      WHEN NEW.link_version_id IS NOT OLD.link_version_id OR NEW.task_id IS NOT OLD.task_id
      OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.born_rev IS NOT OLD.born_rev
      OR NEW.previous_version_id IS NOT OLD.previous_version_id OR NEW.reason IS NOT OLD.reason OR NEW.actor IS NOT OLD.actor
      OR OLD.ended_rev IS NOT NULL OR NEW.ended_rev IS NULL
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LINK_VERSION'); END;
    CREATE TRIGGER link_no_delete BEFORE DELETE ON task_conversation_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LINK_VERSION'); END;
  `);
  const invalidWait=`(NEW.state<>'blocked' AND (NEW.wait_kind<>'none' OR NEW.human_question_id IS NOT NULL OR NEW.blocked_reason IS NOT NULL OR NEW.blocked_on_task_id IS NOT NULL))
    OR (NEW.state='blocked' AND NEW.wait_kind='none')
    OR (NEW.wait_kind='technical' AND (NEW.human_question_id IS NOT NULL OR NEW.blocked_reason IS NULL OR trim(NEW.blocked_reason)=''))
    OR (NEW.wait_kind='human' AND (NEW.blocked_reason IS NULL OR trim(NEW.blocked_reason)='' OR NOT EXISTS(
      SELECT 1 FROM messages q JOIN task_conversation_versions v ON v.conversation_id=q.conversation_id
      WHERE q.id=NEW.human_question_id AND q.kind='ask' AND q.scope_id=NEW.scope_id AND v.task_id=NEW.id AND v.ended_rev IS NULL)))
    OR (NEW.wait_kind='unknown' AND NEW.human_question_id IS NOT NULL)
    OR (NEW.blocked_on_task_id IS NOT NULL AND (NEW.blocked_on_task_id=NEW.id OR NOT EXISTS(SELECT 1 FROM tasks d WHERE d.id=NEW.blocked_on_task_id AND d.scope_id=NEW.scope_id)))`;
  for(const action of ['INSERT','UPDATE'])db.exec(`CREATE TRIGGER task_wait_${action.toLowerCase()} BEFORE ${action} ON tasks
    WHEN ${invalidWait} BEGIN SELECT RAISE(ABORT,'INVALID_TASK_WAIT'); END;`);
  for (const table of ['memories','decisions','test_results','task_events']) db.exec(`
    CREATE TRIGGER ${table}_scope_immutable BEFORE UPDATE ON ${table}
    WHEN NEW.project IS NOT OLD.project OR NEW.area IS NOT OLD.area OR NEW.team IS NOT OLD.team
    BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SCOPE'); END;`);
}
