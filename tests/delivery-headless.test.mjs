import test from 'node:test';
import assert from 'node:assert/strict';
import {registerDelivery} from '../extensions/delivery/extension.mjs';
import {rpc} from '../extensions/delivery/rpc.mjs';

const plan=()=>({mode:'implementation',title:'Bounded change',tasks:[{title:'One',instructions:'Implement one',files:['a'],acceptance:['Works'],checks:['task-one']}],checks:['final'],security:false});
const approved={status:'approved',summary:'Inspected source and evidence',findings:[]};
const blockedReport={status:'blocked',summary:'Required capability unavailable',findings:[],blockedReason:'evidence_unavailable'};
const modelIds=['planning','coder','quality','security'];

function harness({hasUI=false,config={},autoApprove=true,readOutcome,routes}={}) {
 const handlers={},tools={},commands={},messages=[],saved=[],activeTools=[],modelSets=[],compactions=[];let n=0,contextPercent=null;
 const models=modelIds.map(id=>({provider:'test',id}));
 const events={listeners:new Map(),on(k,f){this.listeners.set(k,f);return()=>this.listeners.delete(k);},emit(k,r){if(!k.endsWith(':request'))return;let data={version:1,capabilities:{asyncSpawn:true,processTerminalProof:{version:1}},methods:['spawn','status','stop']};
  if(r.method==='spawn')data={details:{runId:`run-${++n}`,asyncDir:`/artifacts/${n}`}};
  if(r.method==='status')data={fleet:{totalActive:0}};
  this.listeners.get(`subagents:rpc:v1:reply:${r.requestId}`)({version:1,requestId:r.requestId,success:true,data});
 }};
 const pi={events,on:(k,f)=>handlers[k]=f,registerTool:t=>tools[t.name]=t,registerCommand:(k,c)=>commands[k]=c,appendEntry:(customType,data)=>{saved.push({type:'custom',customType,data:structuredClone(data)});},sendMessage:(m,options)=>messages.push({...m,options}),getActiveTools:()=>activeTools.length?[...activeTools]:['read','bash','write','subagent'],setActiveTools:t=>{activeTools.splice(0,activeTools.length,...t);},setModel:async model=>{modelSets.push(model);return true;}};
 const ctx={cwd:'/workspace',hasUI,ui:{setStatus(){},notify(){},confirm:async()=>true,select:async()=>null},sessionManager:{getBranch:()=>saved,getSessionId:()=>'session',getSessionFile:()=>undefined},modelRegistry:{getAvailable:()=>models},getContextUsage:()=>({percent:contextPercent}),compact:options=>compactions.push(options)};
 const loadConfig=()=>({version:1,routes:routes||Object.fromEntries(modelIds.map(id=>[id,`test/${id}`])),repos:['/workspace'],...config});
 const deps={child:false,readNativeStatus:()=>({state:'running'}),loadConfig,repoRoot:()=>'/workspace',snapshot:()=>({a:'hash'}),acquireLock:()=>{},releaseLock:()=>{},readOutcome:readOutcome||(()=>approved),workingTreeEvidence:()=> 'dirty diff',validateCommands:()=>{},autoContinue:false,autoApprove,autoCommit:false,commitPaths:()=>{throw new Error('unexpected commit');},verifyCommand:async(_r,command)=>({command,code:0,signal:null,terminated:false,processClosed:true,output:'actual output'}),rpc,pollMs:1};
 registerDelivery(pi,undefined,deps);
 const state=()=>saved.filter(e=>e.customType==='delivery-coordinator-v2').at(-1)?.data;
 return {handlers,tools,commands,messages,saved,ctx,activeTools,modelSets,compactions,state,
  setContextPercent:value=>{contextPercent=value;},
  invoke:(name,args={})=>tools[name].execute('call',args,undefined,undefined,ctx),
  start:()=>handlers.session_start({},ctx),
  wait:async()=>{for(let i=0;i<400;i++){if(['complete','blocked','stopped'].includes(state()?.stage))return state();await new Promise(r=>setTimeout(r,2));}throw new Error('did not settle');}};
}
const text=out=>out.content.map(c=>c.text).join('\n');
const said=(h,re)=>h.messages.some(m=>re.test(String(m.content)));

test('without the headless key a UI-less session stays OFF and refuses to plan',async()=>{
 const h=harness({hasUI:false});await h.start();
 assert.notEqual(h.state()?.enabled,true);
 await assert.rejects(h.invoke('delivery_plan',plan()),/Delivery is OFF/);
});

test('headless true with no UI turns Delivery ON with the exact planning route and delivery tools',async()=>{
 const h=harness({hasUI:false,config:{headless:true}});await h.start();
 assert.equal(h.state()?.enabled,true);
 assert.deepEqual(h.modelSets.map(m=>m.id),['planning']);
 assert.ok(h.activeTools.includes('delivery_plan'));
});

test('headless true never changes an interactive session',async()=>{
 const h=harness({hasUI:true,config:{headless:true}});await h.start();
 assert.notEqual(h.state()?.enabled,true);
 assert.equal(h.modelSets.length,0);
});

test('headless values other than literal true do not enable',async()=>{
 for(const headless of ['true',1,'yes',{enable:true}]){
  const h=harness({hasUI:false,config:{headless}});await h.start();
  assert.notEqual(h.state()?.enabled,true,JSON.stringify(headless));
 }
});

test('headless refuses manual approval because nobody can approve and says why',async()=>{
 const h=harness({hasUI:false,config:{headless:true,approval:'manual'}});await h.start();
 assert.notEqual(h.state()?.enabled,true);
 assert.ok(said(h,/headless/i) && said(h,/autonomous/i));
 await assert.rejects(h.invoke('delivery_plan',plan()),/Delivery is OFF/);
});

test('headless enable failure leaves Delivery OFF, explains it and never substitutes a model',async()=>{
 const h=harness({hasUI:false,config:{headless:true},routes:{planning:'test/missing',coder:'test/coder',quality:'test/quality',security:'test/security'}});
 await h.start();
 assert.notEqual(h.state()?.enabled,true);
 assert.equal(h.modelSets.length,0);
 assert.ok(said(h,/headless/i) && said(h,/could not|failed|not available/i));
});

test('headless plan launches without approval and returns only after the run completes',async()=>{
 const h=harness({hasUI:false,config:{headless:true}});await h.start();
 const out=await h.invoke('delivery_plan',plan());
 assert.equal(h.state().stage,'complete');
 assert.match(text(out),/Delivery complete/);
 assert.equal(h.state().enabled,true);
});

test('headless plan returns blocked evidence instead of hanging',async()=>{
 const h=harness({hasUI:false,config:{headless:true},readOutcome:()=>blockedReport});await h.start();
 const out=await h.invoke('delivery_plan',plan());
 assert.equal(h.state().stage,'blocked');
 assert.match(text(out),/blocked/i);
});

test('interactive autonomous launch still returns immediately and finishes in the background',async()=>{
 const h=harness({hasUI:true});await h.start();await h.commands.delivery.handler('on',h.ctx);
 const out=await h.invoke('delivery_plan',plan());
 assert.match(text(out),/launched without an approval turn/);
 assert.notEqual(h.state().stage,'complete');
 assert.equal((await h.wait()).stage,'complete');
});

test('headless guidance tells the coordinator that planning waits for the outcome',async()=>{
 const h=harness({hasUI:false,config:{headless:true}});await h.start();
 const guidance=await h.handlers.before_agent_start({},h.ctx);
 assert.match(guidance.message.content,/Headless/);
 assert.match(guidance.message.content,/waits/i);
 assert.match(guidance.message.content,/no approved run/);
});

test('leader context compacts above 35 percent and carries current run identity',async()=>{
 const h=harness({hasUI:true});await h.start();await h.commands.delivery.handler('on',h.ctx);
 await h.invoke('delivery_plan',plan());await h.wait();
 h.setContextPercent(35);h.handlers.turn_end({},h.ctx);assert.equal(h.compactions.length,0);
 h.setContextPercent(35.1);h.handlers.turn_end({},h.ctx);assert.equal(h.compactions.length,1);
 assert.match(h.compactions[0].customInstructions,/Current Delivery run/);
 assert.match(h.compactions[0].customInstructions,/Do not select a new issue or duplicate this task/);
 h.handlers.turn_end({},h.ctx);assert.equal(h.compactions.length,1);
 h.compactions[0].onComplete();h.handlers.turn_end({},h.ctx);assert.equal(h.compactions.length,1);
 h.setContextPercent(29);h.handlers.turn_end({},h.ctx);
 h.setContextPercent(36);h.handlers.turn_end({},h.ctx);assert.equal(h.compactions.length,2);
});

test('leader context compaction is inactive while Delivery is OFF or usage unavailable',async()=>{
 const h=harness({hasUI:true});await h.start();h.setContextPercent(80);h.handlers.turn_end({},h.ctx);assert.equal(h.compactions.length,0);
 await h.commands.delivery.handler('on',h.ctx);h.setContextPercent(null);h.handlers.turn_end({},h.ctx);assert.equal(h.compactions.length,0);
});

test('old-session compaction callback cannot clear a new session compaction',async()=>{
 const h=harness({hasUI:true});await h.start();await h.commands.delivery.handler('on',h.ctx);
 h.setContextPercent(40);h.handlers.turn_end({},h.ctx);assert.equal(h.compactions.length,1);
 await h.start();h.handlers.turn_end({},h.ctx);assert.equal(h.compactions.length,2);
 h.compactions[0].onComplete();h.handlers.turn_end({},h.ctx);assert.equal(h.compactions.length,2);
 h.compactions[1].onComplete();
});

test('interactive leader gets one current-run supervision turn after an unhandled block',async()=>{
 const h=harness({hasUI:true,readOutcome:()=>blockedReport});await h.start();await h.commands.delivery.handler('on',h.ctx);
 await h.invoke('delivery_plan',plan());await h.wait();
 await new Promise(resolve=>setTimeout(resolve,0));
 const notices=h.messages.filter(m=>m.customType==='delivery-supervision');
 assert.equal(notices.length,1);
 assert.equal(notices[0].options?.triggerTurn,true);
 assert.match(notices[0].content,/current Delivery run only/);
 assert.match(notices[0].content,/Never spawn a duplicate worker or choose a new issue/);
 assert.equal(h.state().leaderNoticeKey!==undefined,true);
});

test('headless block returns evidence without queuing a second leader turn',async()=>{
 const h=harness({hasUI:false,config:{headless:true},readOutcome:()=>blockedReport});await h.start();
 await h.invoke('delivery_plan',plan());
 assert.equal(h.messages.filter(m=>m.customType==='delivery-supervision').length,0);
});
