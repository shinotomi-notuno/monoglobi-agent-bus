import {unknownTool} from './protocol-errors.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {LegacyAdapter,legacyPath,legacyPublished,legacyError,replacement} from './legacy-adapter.js';
import {legacyInputs} from './legacy-input.js';
import {jsonSchema} from './tool-runtime.js';
let scope:unknown=null;try{scope=JSON.parse(process.env.AGENT_BUS_V2_SCOPE??'null');}catch{}
const adapter=new LegacyAdapter(legacyPath()!,scope),server=new Server({name:'agent-bus-legacy-v2-development',version:'2.4.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:legacyPublished.map(name=>({name,description:`Scoped legacy compatibility; read-only or rejection. ${replacement(name)}`,inputSchema:jsonSchema(legacyInputs[name]!)}))}));
server.setRequestHandler(CallToolRequestSchema,async req=>{
 if(!legacyPublished.includes(req.params.name))unknownTool(req.params.name);
 try{return {content:[{type:'text',text:JSON.stringify(await adapter.call(req.params.name,req.params.arguments??{}))}]};}
 catch(e){return {isError:true,content:[{type:'text',text:JSON.stringify(legacyError(e))}]};}
});
let closed=false;const close=()=>{if(!closed){closed=true;adapter.close();}};server.onclose=close;process.on('exit',close);await server.connect(new StdioServerTransport());
