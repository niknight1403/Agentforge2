import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.VF_TEST='1';
process.env.VF_DB=join(mkdtempSync(join(tmpdir(),'vf-mcp-agent-tools-')),'db.sqlite');
process.env.VF_WORKSPACE=join(tmpdir(),'vf-mcp-agent-workspace');
process.env.VF_LLM_FREE_ONLY='1';

const { registerMcpServer, replaceMcpServerTools, listMcpTools, setMcpToolPolicy, setMcpServerStatus, removeMcpServer } = await import('../mcp-registry.mjs');
const { toolSpecs, availableToolPrompt } = await import('../agents.mjs');

test('agent tool registry exposes only approved tools on active MCP servers',()=>{
  const server=registerMcpServer({name:'agent tool registry test',transport:'http',url:'https://mcp.example.test'});
  try{
    replaceMcpServerTools(server.id,[
      {name:'search_docs',description:'Search documentation',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']}},
      {name:'dangerous_action',description:'Unreviewed action',inputSchema:{type:'object',properties:{}}}
    ]);
    const discovered=listMcpTools({serverId:server.id});
    setMcpToolPolicy(discovered.find(tool=>tool.name==='search_docs').id,'approved','test approval');
    setMcpServerStatus(server.id,'active');
    const alias=`mcp:${server.id}:search_docs`;
    const specs=toolSpecs();
    assert.ok(specs.some(tool=>tool.name===alias&&tool.enabled===true&&tool.executionTool==='mcp_call'));
    assert.ok(!specs.some(tool=>tool.name===`mcp:${server.id}:dangerous_action`));
    assert.ok(availableToolPrompt().includes(alias));
    setMcpToolPolicy(discovered.find(tool=>tool.name==='search_docs').id,'blocked','test revocation');
    assert.ok(!toolSpecs().some(tool=>tool.name===alias));
  }finally{
    removeMcpServer(server.id);
  }
});
