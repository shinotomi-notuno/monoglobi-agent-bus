import {McpError,ErrorCode} from '@modelcontextprotocol/sdk/types.js';
/** SDK prefixes Error.message; the K03 wire contract requires the raw text. */
export function unknownTool(name:string):never {
 const error=new McpError(ErrorCode.InvalidParams,'Unknown tool',{tool:name});
 error.message='Unknown tool';
 throw error;
}
