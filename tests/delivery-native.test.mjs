// Optional no-inference contract check against the installed native bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {rpc} from '../extensions/delivery/rpc.mjs';
import {REPORT_SCHEMA} from '../extensions/delivery/policy.mjs';
import {registerDelivery} from '../extensions/delivery/extension.mjs';
import {readOutcome} from '../extensions/delivery/io.mjs';
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
test('delivery binds the installed resolveCurrentSessionId identity before spawn and reads native-shaped results offline',{skip:!existsSync(join(installed,'src/shared/session-identity.ts'))},async t=>{
 const require=createRequire(join(installed,'package.json')),{createJiti}=require('jiti');
 const jiti=createJiti(import.meta.url,{moduleCache:false,fsCache:false});
 const {resolveCurrentSessionId}=await jiti.import(join(installed,'src/shared/session-identity.ts'));
 const root=mkdtempSync(join(tmpdir(),'delivery-native-owner-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const sessionFile of [join(root,'parent.jsonl'),null,undefined]) {
  const handlers={},tools={},commands={},saved=[],sessionId='37ea2a5e-f069-4e6a-9b1f-a08d309df5e7';let launches=0;
  const state=()=>saved.at(-1);
  const models=['planning','quality'].map(id=>({provider:'fixture',id}));
  const ctx={cwd:root,ui:{setStatus(){}},sessionManager:{getBranch:()=>[],getSessionId:()=>sessionId,getSessionFile:()=>sessionFile},modelRegistry:{getAvailable:()=>models}};
  const nativeOwner=resolveCurrentSessionId(ctx.sessionManager);
  const pi={events:{},on:(name,fn)=>handlers[name]=fn,registerTool:tool=>tools[tool.name]=tool,registerCommand:(name,command)=>commands[name]=command,appendEntry:(_type,data)=>saved.push(data),sendMessage(){},getActiveTools:()=>[],setActiveTools(){},setModel:async()=>true};
  registerDelivery(pi,undefined,{child:false,repoRoot:()=>root,loadConfig:()=>({routes:{planning:'fixture/planning',quality:'fixture/quality'}}),snapshot:()=>({}),workingTreeEvidence:()=>'',validateCommands(){},acquireLock:(_root,owner)=>assert.equal(owner.session,sessionId),releaseLock:(_root,owner)=>assert.equal(owner.session,sessionId),readOutcome,pollMs:1,
   rpc:async(_events,method,params)=>{
    if(method==='ping')return {capabilities:{asyncSpawn:true,processTerminalProof:{version:1}}};
    if(method==='status')return {fleet:{totalActive:0}};
    assert.equal(method,'spawn');launches++;
    assert.equal(state().session,sessionId);assert.equal(state().active.nativeSession,nativeOwner);
    const asyncDir=mkdtempSync(join(root,'worker-')),runId='synthetic-run',report=join(asyncDir,'report.json');
    writeFileSync(join(asyncDir,'status.json'),JSON.stringify({runId,sessionId:nativeOwner,state:'complete',steps:[{agent:params.agent,model:params.model,attemptedModels:[params.model],sessionFile:join(asyncDir,'child.jsonl'),structuredOutputPath:report}]}));
    writeFileSync(join(asyncDir,'process-terminal.json'),JSON.stringify({runId,state:'observed',instances:[{exitCode:0,signal:null}]}));
    writeFileSync(report,JSON.stringify({status:'approved',summary:'Offline identity fixture',findings:[]}));
    return {details:{runId,asyncDir}};
   }});
  const invoke=(name,args={})=>tools[name].execute('call',args,undefined,undefined,ctx);
  await handlers.session_start({},ctx);await commands.delivery.handler('on',ctx);
  await invoke('delivery_plan',{mode:'review',title:'Offline contract',tasks:[{title:'Review',instructions:'Inspect synthetic evidence',files:['a'],acceptance:['Owner binding matches native'],checks:[]}],checks:[],security:false});
  await handlers.input({source:'interactive',text:'Approved'});await invoke('delivery_execute');
  for(let i=0;i<100&&!['complete','blocked'].includes(state().stage);i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(state().stage,'complete',state().reason);assert.equal(launches,1);assert.equal(state().reports[0].native.nativeSession,nativeOwner);
  await handlers.session_shutdown();
 }
});
