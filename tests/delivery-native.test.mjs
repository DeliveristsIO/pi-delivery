import {terminalProof} from './helpers/native-artifacts.mjs';
// Optional no-inference contract check against the installed native bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {rpc} from '../extensions/delivery/rpc.mjs';
import {proveNativePrelaunch} from '../extensions/delivery/prelaunch.mjs';
import {REPORT_SCHEMA} from '../extensions/delivery/policy.mjs';
import {registerDelivery} from '../extensions/delivery/extension.mjs';
import {readOutcome} from '../extensions/delivery/io.mjs';
const installed=process.env.PI_SUBAGENTS_DIR || join(process.env.PI_CODING_AGENT_DIR || join(homedir(),'.pi/agent'),'npm/node_modules/pi-subagents');
test('pinned native prelaunch rejection proves only exact historical security error',{skip:!existsSync(join(installed,'src/runs/background/async-execution.ts'))},()=>{
 const active={id:null,dir:null,agent:'delivery-security',stage:'security',session:'old-session',nativeSession:'/old/session.jsonl',startedAt:Date.now()};
 const reason="Run fan-out: 1/64 used, 63 remaining\nAgent 'delivery-security' was given an implementation task, but its tool allowlist has no mutation-capable tools. Add bash, edit, write, or another mutation-capable tool to the agent, or use a read-only task/agent.";
 assert.equal(proveNativePrelaunch(active,reason).kind,'native-prelaunch-refusal');
 assert.throws(()=>proveNativePrelaunch(active,'Unknown RPC failure'),/not proven/);
 assert.throws(()=>proveNativePrelaunch({...active,agent:'delivery-coder'},reason),/not proven/);
 assert.throws(()=>proveNativePrelaunch({...active,startedAt:1},reason),/not proven/);
 assert.throws(()=>proveNativePrelaunch({...active,id:'maybe'},reason),/not proven/);
});
test('RPC preserves launch correlation and native error code without claiming non-launch',async()=>{
 const listeners=new Map(),events={on:(key,fn)=>{listeners.set(key,fn);return()=>listeners.delete(key);},emit:(key,request)=>{
  assert.equal(request.requestId,'reserved-launch');
  listeners.get(`subagents:rpc:v1:reply:${request.requestId}`)({version:1,requestId:request.requestId,success:false,error:{code:'execution_failed',message:'Native launch rejected'}});
 }};
 await assert.rejects(rpc(events,'spawn',{agent:'delivery-security'},15000,'reserved-launch'),error=>{
  assert.equal(error.message,'Native launch rejected');
  assert.equal(error.code,'execution_failed');
  assert.equal(error.requestId,'reserved-launch');
  return true;
 });
});
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
  assert.match(text,/call (?:the )?`structured_output` tool/i);
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
 const {classifyTaskMutationIntent}=await jiti.import(join(installed,'src/runs/shared/task-intent.ts'));
 const root=mkdtempSync(join(tmpdir(),'delivery-native-owner-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const sessionFile of [join(root,'parent.jsonl'),null,undefined]) {
  const handlers={},tools={},commands={},saved=[],sessionId='37ea2a5e-f069-4e6a-9b1f-a08d309df5e7';let launches=0;
  const state=()=>saved.at(-1);
  const models=['planning','quality','security'].map(id=>({provider:'fixture',id}));
  const ctx={cwd:root,ui:{setStatus(){}},sessionManager:{getBranch:()=>[],getSessionId:()=>sessionId,getSessionFile:()=>sessionFile},modelRegistry:{getAvailable:()=>models}};
  const nativeOwner=resolveCurrentSessionId(ctx.sessionManager);
  const pi={events:{},on:(name,fn)=>handlers[name]=fn,registerTool:tool=>tools[tool.name]=tool,registerCommand:(name,command)=>commands[name]=command,appendEntry:(_type,data)=>saved.push(data),sendMessage(){},getActiveTools:()=>[],setActiveTools(){},setModel:async()=>true};
  registerDelivery(pi,undefined,{child:false,repoRoot:()=>root,loadConfig:()=>({routes:{planning:'fixture/planning',quality:'fixture/quality',security:'fixture/security'}}),snapshot:()=>({}),workingTreeEvidence:()=>'',validateCommands(){},acquireLock:(_root,owner)=>assert.equal(owner.session,sessionId),releaseLock:(_root,owner)=>assert.equal(owner.session,sessionId),readOutcome,pollMs:1,
   rpc:async(_events,method,params)=>{
    if(method==='ping')return {capabilities:{asyncSpawn:true,processTerminalProof:{version:1}}};
    if(method==='status')return {fleet:{totalActive:0}};
    assert.equal(method,'spawn');launches++;
    assert.equal(classifyTaskMutationIntent(params.agent,params.task).kind,'read-only',`${params.agent} must receive a read-only task despite quoted implementation requirements`);
    assert.equal(state().session,sessionId);assert.equal(state().active.nativeSession,nativeOwner);
    const asyncDir=mkdtempSync(join(root,'worker-')),runId='synthetic-run',report=join(asyncDir,'report.json');
    writeFileSync(join(asyncDir,'status.json'),JSON.stringify({runId,sessionId:nativeOwner,state:'complete',steps:[{agent:params.agent,model:params.model,attemptedModels:[params.model],sessionFile:join(asyncDir,'child.jsonl'),structuredOutputPath:report}]}));
    writeFileSync(join(asyncDir,'process-terminal.json'),JSON.stringify(terminalProof(runId)));
    writeFileSync(report,JSON.stringify({status:'approved',summary:'Offline identity fixture',findings:[]}));
    return {details:{runId,asyncDir}};
   }});
  const invoke=(name,args={})=>tools[name].execute('call',args,undefined,undefined,ctx);
  await handlers.session_start({},ctx);await commands.delivery.handler('on',ctx);
  await invoke('delivery_plan',{mode:'review',title:'Offline contract',tasks:[{title:'Review',instructions:'Implement the approved fix. Modify session handling. Add tests.',files:['a'],acceptance:['Implement the requested behavior; owner binding matches native'],checks:[]}],checks:[],security:true});
  await handlers.input({source:'interactive',text:'Approved'});await invoke('delivery_execute');
  for(let i=0;i<100&&!['complete','blocked'].includes(state().stage);i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(state().stage,'complete',state().reason);assert.equal(launches,2);assert.equal(state().reports[0].native.nativeSession,nativeOwner);
  await handlers.session_shutdown();
 }
});
test('installed finalizeProcessTerminal produces the closure contract consumed by Delivery offline',{skip:!existsSync(join(installed,'src/runs/background/process-terminal.ts'))},async t=>{
 const require=createRequire(join(installed,'package.json')),{createJiti}=require('jiti');
 const native=await createJiti(import.meta.url,{moduleCache:false,fsCache:false}).import(join(installed,'src/runs/background/process-terminal.ts'));
 const {readNativeClosure}=await import('../extensions/delivery/io.mjs');
 const root=mkdtempSync(join(tmpdir(),'delivery-terminal-contract-')),dir=join(root,'native');mkdirSync(dir);t.after(()=>rmSync(root,{recursive:true,force:true}));
 const active={id:'offline-run',dir,nativeSession:'offline-owner',agent:'delivery-reviewer',model:'fixture/review'};
 const report=join(dir,'report.json');
 writeFileSync(report,JSON.stringify({status:'approved',summary:'Native generated closure contract',findings:[]}));
 for(const state of ['complete','failed','stopped']) {
  native.initializeProcessTerminal(dir,active.id,'offline-runner');
  writeFileSync(join(dir,'status.json'),JSON.stringify({runId:active.id,sessionId:active.nativeSession,state,steps:[{agent:active.agent,model:active.model,attemptedModels:[active.model],structuredOutputPath:report}]}));
  native.writeProcessTerminalCandidate(dir,{version:1,runId:active.id,runnerProcessInstanceId:'offline-runner',writers:{0:[]},expectedWriters:{0:0}});
  assert.equal(readNativeClosure(active),null,'candidate/status alone are not closure');
  const proof=native.finalizeProcessTerminal(dir,active.id,{processInstanceId:'offline-runner',closeObservedAt:Date.now(),exitCode:state==='failed'?1:0,signal:null});
  assert.equal(proof.state,'observed');assert.deepEqual(readNativeClosure(active).terminal,proof);
  if(state==='complete')assert.equal(readOutcome(active).status,'approved');
  else assert.throws(()=>readOutcome(active),e=>e.closed && e.nativeState===state);
 }
});
test('installed native verifier tool plan grants bash but no editing/delegation and injects structured_output offline',{skip:!existsSync(join(installed,'src/api/child-tool-plan.ts'))},async()=>{
 const require=createRequire(join(installed,'package.json')),{createJiti}=require('jiti');
 const {resolvePiLaunchToolPlan}=await createJiti(import.meta.url,{moduleCache:false,fsCache:false}).import(join(installed,'src/api/child-tool-plan.ts'));
 const text=readFileSync(new URL('../agents/delivery-verifier.md',import.meta.url),'utf8');
 const tools=text.match(/^tools: (.+)$/m)[1].split(', '),excludeTools=text.match(/^excludeTools: (.+)$/m)[1].split(', ');
 const resolved=resolvePiLaunchToolPlan({agentName:'delivery-verifier',tools,excludeTools,structuredOutput:true,hostAvailableBuiltins:['read','grep','find','ls','bash','edit','write']});
 assert.equal(resolved.explicitToolAllowlist,true);assert.equal(resolved.fanoutAuthorized,false);assert.ok(resolved.effectiveToolAllowlist.includes('bash'));assert.ok(resolved.effectiveToolAllowlist.includes('structured_output'));assert.ok(!resolved.effectiveToolAllowlist.some(t=>['edit','write','subagent'].includes(t)));assert.match(text,/completionGuard: false/);
 const {VERIFIER_REPORT_SCHEMA,validate}=await import('../extensions/delivery/policy.mjs');
 assert.doesNotThrow(()=>validate(VERIFIER_REPORT_SCHEMA,{status:'approved',summary:'Offline fixture only',findings:[],task:0,round:0,source:'source',phase:'probe',commands:[{command:'node fixture --probe',exitCode:0}],artifacts:[]}));
});
test('installed missing-output diagnostic is absence, not recovery authority for native failed outcomes',{skip:!existsSync(join(installed,'src/runs/shared/completion-evidence.ts'))},async t=>{
 const require=createRequire(join(installed,'package.json')),{createJiti}=require('jiti');
 const {projectSettlementDiagnostic}=await createJiti(import.meta.url,{moduleCache:false,fsCache:false}).import(join(installed,'src/runs/shared/completion-evidence.ts'));
 const dir=mkdtempSync(join(tmpdir(),'delivery-failed-report-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const active={id:'failed-report',dir,nativeSession:'owner',agent:'delivery-reviewer',model:'fixture/exact'};
 const diagnostic=projectSettlementDiagnostic({guardTriggered:false,guardBlocked:false,mutationExpected:false,mutationAttempted:false},{terminalFailed:true,finalTextPresent:true,mutationObserved:false,requiredOutput:{kind:'structured',path:join(dir,'missing.json'),missing:true}});
 assert.equal(diagnostic.requiredOutput.missing,true);
 writeFileSync(join(dir,'status.json'),JSON.stringify({runId:active.id,sessionId:active.nativeSession,state:'failed',steps:[{agent:active.agent,model:active.model,attemptedModels:[active.model],effects:{settlementDiagnostic:diagnostic}}]}));
 writeFileSync(join(dir,'process-terminal.json'),JSON.stringify(terminalProof(active.id)));
 assert.throws(()=>readOutcome(active),e=>e.closed===true&&e.nativeState==='failed'&&e.code!=='DELIVERY_STRUCTURED_REPORT');
});
