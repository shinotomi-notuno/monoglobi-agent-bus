import {Tasks} from '../../dist/v2/tasks.js';
import {Observation} from '../../dist/v2/observation.js';
const c=JSON.parse(process.env.TEST_OBSERVER_CONFIG),t=new Tasks(c.path,c.scope);
const observer=new Observation(t.db,t.sid,{db:()=>{throw new Error('injected');},stderr:()=>{throw new Error('injected');},file:()=>{throw new Error('injected');}});
observer.start();observer.record(new Error('internal failure'));
process.exit(71); // Deliberately skip stop/close to leave the logging epoch unclosed.
