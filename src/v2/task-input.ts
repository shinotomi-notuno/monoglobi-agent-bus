import {z} from 'zod';
export const taskId=z.number().int().safe().min(1),taskRev=z.number().int().safe().min(0),text=z.string().min(1).regex(/\S/);
const nullableText=z.string().nullable().optional(),bool=z.boolean().optional();
export const taskStates=z.enum(['backlog','open','claimed','working','blocked','completed','failed','canceled']);
const details={description:nullableText,milestone:nullableText,result:nullableText,expected_output:nullableText,deadline_at:z.number().int().safe().min(0).nullable().optional(),checkin_at:z.number().int().safe().min(0).nullable().optional(),final_answer:nullableText,phase:nullableText,changed_files:z.array(text).optional(),file_scope:z.array(text).optional(),edit_scope:z.array(text).optional(),read_scope:z.array(text).optional(),mode:z.enum(['investigate_only','propose_patch','edit_files','test_only']).optional(),ack_required:bool,review_required:bool,independent_review:bool,priority:z.number().int().safe().optional()};
const wait={wait_kind:z.enum(['none','technical','human']).optional(),human_question_id:taskId.nullable().optional(),blocked_reason:text.nullable().optional(),blocked_on_task_id:taskId.nullable().optional()};
export const taskPatch=z.object({...details,...wait,state:taskStates.optional(),clear_wait:bool}).strict();
export const reference=z.union([z.object({table:z.enum(['tasks','messages','conversations','memories','decisions','test_results','task_events']),id:taskId}).strict(),z.object({artifact_path:text,git_ref:text}).strict()]);
export const references=z.array(reference).max(16);
const base={task_id:taskId,expected_task_revision:taskRev};
export const taskInputs={
 create_task_v2:z.object({title:text,...details,state:z.enum(['backlog','open']).optional()}).strict(),
 update_task_v2:z.object({...base,patch:taskPatch}).strict(),
 claim_task_v2:z.object(base).strict(),
 assign_task_v2:z.object({...base,to_agent:text}).strict(),
 release_task_v2:z.object({...base,mode:z.enum(['preserve_state','reopen']),clear_wait:bool}).strict(),
 acknowledge_task_v2:z.object({...base,response:z.enum(['claimed','declined','blocked']),note:text.optional(),...wait}).strict(),
 submit_review_v2:z.object({...base,approved:z.boolean(),notes:z.string().optional()}).strict(),
 handoff_task_v2:z.object({...base,to_agent:text.nullable(),reason:text,references}).strict(),
 cancel_task_v2:z.object({...base,reason:text,clear_wait:bool}).strict(),
 record_test_result_v2:z.object({task_id:taskId.nullable(),command:text,status:z.enum(['passed','failed','skipped']),output_summary:z.string(),git_ref:text.optional(),cwd:text.optional()}).strict(),
 record_task_event_v2:z.object({task_id:taskId,event_type:z.enum(['note','phase','progress','log','result','cancel']),message:text,phase:text.optional(),metadata:z.record(z.unknown()),task_patch:taskPatch.optional(),expected_task_revision:taskRev.optional()}).strict(),
 record_decision_v2:z.object({decision:text,rationale:z.string().optional(),implemented:z.boolean(),decision_state:z.enum(['proposed','agreed']),evidence_refs:references}).strict(),
 remember_v2:z.object({kind:text,content:text,agent:text.nullable().optional(),task_id:taskId.optional(),conversation_id:taskId.optional(),pinned:bool,supersedes_id:taskId.optional()}).strict(),
 pin_memory_v2:z.object({memory_id:taskId,pinned:z.boolean()}).strict(),
};
export type TaskOperation=keyof typeof taskInputs;

export const taskWrapperFields=['claimed_by','pending_assignee','claimed_at','acknowledged_at','acknowledged_by','review_state','reviewed_by','review_notes','manager_reviewed','finished_at'];
export function taskInputError(op:string,args:any):string {
 if(op==='handoff_task_v2'&&!references.safeParse(args?.references).success)return 'HANDOFF_REFERENCE_INVALID';
 const patch=op==='update_task_v2'?args?.patch:op==='record_task_event_v2'?args?.task_patch:undefined;
 return patch&&typeof patch==='object'&&taskWrapperFields.some(k=>Object.hasOwn(patch,k))?'TASK_FIELD_REQUIRES_WRAPPER':'INVALID_INPUT';
}
