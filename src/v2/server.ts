#!/usr/bin/env node
import {unknownTool} from './protocol-errors.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {ToolRuntime,jsonSchema} from './tool-runtime.js';
if(!process.env.AGENT_BUS_V2_DB||!process.env.AGENT_BUS_V2_SCOPE)throw new Error('EXPLICIT_V2_DB_AND_SCOPE_REQUIRED');
const runtime=new ToolRuntime(process.env.AGENT_BUS_V2_DB,JSON.parse(process.env.AGENT_BUS_V2_SCOPE),process.env.AGENT_BUS_V2_WRITERS==='1',process.env.AGENT_BUS_V2_LEGACY==='1');
const server=new Server({name:'agent-bus-v2-development',version:'2.4.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:runtime.tools.map(t=>({name:t.name,description:t.description,inputSchema:jsonSchema(t.schema)}))}));
server.setRequestHandler(CallToolRequestSchema,async req=>{
 if(!runtime.tools.some(t=>t.name===req.params.name)){runtime.noMutationShutdown();unknownTool(req.params.name);}
 try{return {content:[{type:'text',text:JSON.stringify(await runtime.call(req.params.name,req.params.arguments))}]};}
 catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify(runtime.error(error))}]};}
});
process.on('exit',()=>runtime.close());
server.onclose=()=>runtime.close();
await server.connect(new StdioServerTransport());
