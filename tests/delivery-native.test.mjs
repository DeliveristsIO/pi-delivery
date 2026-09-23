// Optional no-inference contract check against the installed native bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {rpc} from '../extensions/delivery/rpc.mjs';
import {REPORT_SCHEMA} from '../extensions/delivery/policy.mjs';
const installed=process.env.PI_SUBAGENTS_DIR || join(process.env.PI_CODING_AGENT_DIR || join(homedir(),'.pi/agent'),'npm/node_modules/pi-subagents');
test('installed RPC bridge accepts exact async single-worker launch and propagates native errors without inference',{skip:!existsSync(join(installed,'src/extension/rpc.ts'))},async()=>{
 const require=createRequire(join(installed,'package.json'));
 const {createJiti}=require('jiti');const jiti=createJiti(import.meta.url,{moduleCache:false,fsCache:false});
 const {registerSubagentRpcBridge}=await jiti.import(join(installed,'src/extension/rpc.ts'));
 const {resolvePiLaunchToolPlan}=await jiti.import(join(installed,'src/api/child-tool-plan.ts'));
 for(const name of ['reviewer','security']) {
  const text=readFileSync(new URL(`../agents/delivery-${name}.md`,import.meta.url),'utf8');
  const tools=text.match(/^tools: (.+)$/m)[1].split(', '),excludeTools=text.match(/^excludeTools: (.+)$/m)[1].split(', ');
  const resolved=resolvePiLaunchToolPlan({agentName:`delivery-${name}`,tools,excludeTools,structuredOutput:true,requireReadTool:true,hostAvailableBuiltins:['read','grep','find','ls','bash','edit','write']});
  assert.equal(resolved.explicitToolAllowlist,true);assert.equal(resolved.fanoutAuthorized,false);
  assert.ok(resolved.effectiveToolAllowlist.includes('structured_output'));
  assert.ok(!resolved.effectiveToolAllowlist.some(tool=>['bash','powershell','edit','write','subagent'].includes(tool)||tool.startsWith('browser_')));
 }
 const listeners=new Map(),calls=[];
 const events={on:(name,fn)=>{listeners.set(name,fn);return()=>listeners.delete(name);},emit:(name,value)=>{listeners.get(name)?.(value);}};
 const ctx={cwd:'/fixture',sessionManager:{getSessionId:()=> 'fixture',getSessionFile:()=>null}};
 const bridge=registerSubagentRpcBridge({events,getContext:()=>ctx,execute:async(_id,params)=>{calls.push(params);return {content:[{type:'text',text:'Native fixture'}],details:{runId:'native-id',asyncDir:'/fixture/artifacts'}};}});
 try {
  const ping=await rpc(events,'ping');assert.equal(ping.capabilities.asyncSpawn,true);assert.equal(ping.capabilities.processTerminalProof.version,1);
  const launch=await rpc(events,'spawn',{agent:'delivery-reviewer',agentScope:'user',cwd:'/fixture',task:'Read-only review. Do not modify files.',model:'fixture/exact-model',context:'fresh',async:true,outputSchema:REPORT_SCHEMA,output:false,share:false,timeoutMs:600000,acceptance:{level:'none',reason:'Fixture; never invokes a model'}});
  assert.equal(launch.details.runId,'native-id');assert.equal(calls.length,1);assert.equal(calls[0].model,'fixture/exact-model');assert.equal(calls[0].agent,'delivery-reviewer');assert.equal(calls[0].async,true);
  await assert.rejects(rpc(events,'spawn',{agent:'delivery-reviewer',task:'Review',async:false}),/async|detached/i);assert.equal(calls.length,1);
 }finally{bridge.dispose();}
});
