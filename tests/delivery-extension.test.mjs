import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,copyFileSync,rmSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {registerDelivery} from '../extensions/delivery/extension.mjs';
import {timeoutPolicy} from '../extensions/delivery/policy.mjs';
const routes={planning:'openai-codex/gpt-6-astra',coder:'custom/c',spec:'custom/r',quality:'custom/r',security:'custom/s'};
const plan={title:'Fixture',tasks:[{title:'Add',instructions:'Add one',files:['a'],checks:['node --test'],acceptance:['works']}],checks:['node --test'],risk:'low',security:true};
function harness(config={version:1,routes,evidence:{},repos:['/repo']}) {
 const configuredWorkingTreeEvidence=config.workingTreeEvidence;config={...config};delete config.workingTreeEvidence;
 const events={},commands={},tools={},entries=[],statuses=[],messages=[],calls=[];
 let model={provider:'openai-codex',id:'gpt-5.5'};
 const models=[...new Set(Object.values(routes))].map(s=>{const [provider,...id]=s.split('/');return {provider,id:id.join('/')};});
 const ctx={cwd:'/repo',hasUI:true,mode:'tui',isIdle:()=>true,isProjectTrusted:()=>true,modelRegistry:{getAll:()=>models,getAvailable:()=>models},get model(){return model;},sessionManager:{getSessionId:()=> 'session',getBranch:()=>entries},ui:{setStatus:(k,v)=>statuses.push(v),notify:()=>{},confirm:async()=>true,select:async(t,opts)=>opts[0],input:async()=> 'trial'}};
 const pi={on:(e,h)=>events[e]=h,registerCommand:(n,c)=>commands[n]=c,registerTool:t=>tools[t.name]=t,appendEntry:(customType,data)=>entries.push({type:'custom',customType,data:structuredClone(data)}),setModel:async m=>{model=m;return true;},sendMessage:m=>messages.push(m),sendUserMessage:m=>messages.push(m),getActiveTools:()=>['read','bash','edit','write','delivery_plan'],setActiveTools:()=>{},events:{}};
 const deps={configPath:()=>'/unused',loadConfig:()=>structuredClone(config),saveConfig:(_,c)=>Object.assign(config,c),repoRoot:()=>'/repo',fingerprint:()=> 'hash',diff:()=> 'diff',reviewPatch:()=>'/fake/full.diff',validateCommands:()=>{},runProgress:()=>null,orphanedRunEvidence:()=>null,verifyCommand:async()=>({code:0,output:'PASS'}),rpc:async(_e,method,params)=>{calls.push({method,params});return method==='spawn'?{details:{runId:'r'+calls.length,asyncDir:'/fake'}}:{};},readOutcome:()=>({status:'approved',summary:'ok',findings:[]}),pollMs:1,retryDelayMs:0,child:false};
 if(configuredWorkingTreeEvidence)deps.workingTreeEvidence=configuredWorkingTreeEvidence;
 const controller=registerDelivery(pi,{plan:{},empty:{}},deps);
 return {pi,ctx,events,commands,tools,entries,statuses,messages,calls,controller,deps,config};
}
const securityPreflightError="Run fan-out: 1/64 used, 63 remaining\nAgent 'delivery-security' was given an implementation task, but its tool allowlist has no mutation-capable tools. Add bash, edit, write, or another mutation-capable tool to the agent, or use a read-only task/agent.";
test('blocked worker dispatch permits recovery through an approved delivery plan',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);const before=h.controller.state();
 const rejected=await h.events.tool_call({toolName:'subagent',input:{agent:'worker',cwd:'/repo',async:false,task:'Fix the build'}},h.ctx);
 assert.equal(rejected.block,true);assert.notEqual(rejected.terminate,true);
 assert.match(rejected.reason,/No tool action was executed/);assert.match(rejected.reason,/delivery_plan/);
 assert.deepEqual(h.controller.state(),before);assert.deepEqual(h.calls,[]);
 await h.tools.delivery_plan.execute('plan',plan,null,null,h.ctx);
 await assert.rejects(h.tools.delivery_execute.execute('go',{},null,null,h.ctx),/user reply/i);
 await h.events.input({text:'approve',source:'interactive'},h.ctx);
 await h.tools.delivery_execute.execute('go',{},null,null,h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');
 assert.equal(h.calls.find(c=>c.method==='spawn').params.agent,'delivery-coder');
});
test('rejected parent tools preserve owned work and point to recovery',async()=>{
 const h=harness();h.entries.push(oldRunEntry('coder',routes,{active:{id:'owned',dir:'/fake',stage:'coder',model:routes.coder}}));
 await h.events.session_start({},h.ctx);const before=h.controller.state();
 for(const toolName of ['subagent','bash','edit','write']) {
  const rejected=await h.events.tool_call({toolName,input:{}},h.ctx);
  assert.equal(rejected.block,true);assert.notEqual(rejected.terminate,true);
  assert.match(rejected.reason,/delivery_resume/);
 }
 assert.deepEqual(h.controller.state(),before);assert.deepEqual(h.calls,[]);
});
test('route inspection and unchanged route requests do not repeat setup or confirmation',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);const before=h.controller.state();
 h.ctx.ui.confirm=async()=>{throw new Error('Unexpected confirmation');};
 const inspected=JSON.parse((await h.tools.delivery_configure.execute('c',{},null,null,h.ctx)).content[0].text);
 assert.deepEqual(inspected.configuredRoutes,routes);assert.ok(inspected.availableModels.includes(routes.coder));
 const same=await h.tools.delivery_configure.execute('c',{routes:{coder:routes.coder}},null,null,h.ctx);
 assert.match(same.content[0].text,/already configured/);assert.deepEqual(h.controller.state(),before);assert.deepEqual(h.calls,[]);
});
for(const decision of ['approve','decline','no-ui','config-race','state-race','shutdown','workspace-change'])test(`route change on pending proposal: ${decision}`,async()=>{
 const h=harness({version:1,routes:structuredClone(routes),repos:['/repo']});await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('p',plan,null,null,h.ctx);await h.events.input({text:'approve',source:'interactive'},h.ctx);
 const before=h.controller.state(),saved=structuredClone(h.config);let confirmations=0;
 if(decision==='no-ui')h.ctx.hasUI=false;
 h.ctx.ui.confirm=async(_title,text)=>{
  confirmations++;assert.match(text,/custom\/c → custom\/r/);
  if(decision==='config-race')h.config.routes.security=routes.coder;
  if(decision==='state-race')await h.commands.delivery.handler('off',h.ctx);
  if(decision==='shutdown')await h.events.session_shutdown();
  if(decision==='workspace-change')h.deps.fingerprint=()=> 'changed';
  return decision!=='decline';
 };
 const change=h.tools.delivery_configure.execute('c',{routes:{coder:routes.spec}},null,null,h.ctx);
 if(['config-race','state-race','shutdown','workspace-change'].includes(decision)) {
  await assert.rejects(change,/changed/);
  assert.equal(h.config.routes.coder,saved.routes.coder);
 } else {
  await change;
  if(decision==='approve') {
   assert.equal(h.config.routes.coder,routes.spec);assert.equal(h.controller.state().routes.coder,routes.spec);
   assert.deepEqual(h.controller.state().plan,before.plan);assert.equal(h.controller.state().snapshot,before.snapshot);
   assert.match(h.messages.at(-1).content,/coder: custom\/r/);
   await assert.rejects(h.tools.delivery_execute.execute('e',{},null,null,h.ctx),/fresh user reply/);
  } else {assert.deepEqual(h.config,saved);assert.deepEqual(h.controller.state(),before);}
 }
 assert.equal(confirmations,decision==='no-ui'?0:1);assert.deepEqual(h.calls,[]);
});
test('invalid routes fail before confirmation or saving',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 h.ctx.ui.confirm=async()=>{throw new Error('Unexpected confirmation');};
 for(const routes of [{coder:'missing/model'},{unknown:'custom/c'}])await assert.rejects(h.tools.delivery_configure.execute('c',{routes},null,null,h.ctx),/model route|named delivery/);
});
for(const stage of ['awaiting-approval','complete'])test(`resume in ${stage} returns guidance without duplicate errors`,async()=>{
 const h=harness(),notifications=[];h.entries.push(oldRunEntry(stage,routes));h.ctx.ui.notify=(...args)=>notifications.push(args);
 await h.events.session_start({},h.ctx);const before=h.controller.state();
 await h.commands.delivery.handler('resume',h.ctx);await h.commands.delivery.handler('resume',h.ctx);
 const status=await h.tools.delivery_status.execute();assert.equal(status.details.nextAction.action,stage==='complete'?'complete':'approve');
 assert.deepEqual(h.controller.state(),before);assert.deepEqual(h.calls,[]);assert.deepEqual(notifications,[]);
});
test('status counts completed task reviews while final verification is still pending',async()=>{
 const h=harness();h.entries.push(oldRunEntry('verification',routes));await h.events.session_start({},h.ctx);
 const status=await h.tools.delivery_status.execute();
 assert.match(status.content[0].text,/Tasks through required reviews: 1\/1/);assert.match(status.content[0].text,/Final verification: not complete/);
});
test('configured and bound routes are distinct, with failed model and next action in visible status',async()=>{
 const h=harness({version:1,routes:structuredClone(routes),repos:['/repo']});
 h.entries.push(oldRunEntry('blocked',routes,{failedRun:{id:'closed',state:'failed',task:0,stage:'coder',model:routes.coder},reason:'failed'}));
 await h.events.session_start({},h.ctx);h.config.routes.coder=routes.spec;
 const status=await h.tools.delivery_status.execute();
 assert.match(status.content[0].text.split('\n')[0],/custom\/c/);
 assert.equal(status.details.configuredRoutes.coder,routes.spec);assert.equal(status.details.routes.coder,routes.coder);
 assert.equal(status.details.nextAction.action,'plan');assert.match(status.content[0].text,/Configured routes for new plans/);
 const notes=[];h.ctx.ui.notify=(...args)=>notes.push(args);const before=h.controller.state();
 await h.commands.delivery.handler('resume',h.ctx);await h.commands.delivery.handler('resume',h.ctx);
 assert.deepEqual(notes,[]);assert.deepEqual(h.controller.state(),before);
});
test('planning model is not reselected on every input',async()=>{
 const h=harness({version:1,routes:structuredClone(routes),repos:['/repo']}),set=h.pi.setModel;let changes=0;h.pi.setModel=async m=>{changes++;return set(m);};
 await h.events.session_start({},h.ctx);
 await h.events.input({text:'status?',source:'interactive'},h.ctx);await h.events.before_agent_start({systemPrompt:'base'},h.ctx);
 assert.equal(changes,1);
 h.config.routes.planning=routes.spec;await h.events.input({text:'continue',source:'interactive'},h.ctx);
 assert.equal(changes,2);assert.equal(h.ctx.model.id,'r');
});
for(const nativeState of ['running','failed','unknown'])test(`owned verification steering: ${nativeState}`,async()=>{
 const h=harness();h.entries.push(oldRunEntry('coder',routes,{active:{id:'owned',dir:'/fake',stage:'coder',model:routes.coder}}));
 await h.events.session_start({},h.ctx);
 h.deps.runProgress=()=>nativeState==='unknown'?null:{state:nativeState,model:routes.coder,attemptedModels:[routes.coder],sessionFiles:['/fake/transcript.jsonl']};
 // Startup reconciliation is required; steering cannot act on a blocked retained child.
 await assert.rejects(h.tools.delivery_steer.execute('s',{},null,null,h.ctx),/No running owned coder/);
 if(nativeState!=='running')return;
 h.deps.readOutcome=()=>null;
 await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);
 try {
  const status=await h.tools.delivery_status.execute();assert.match(status.content[0].text,/transcript.jsonl/);assert.equal(status.details.nextAction.action,'monitor');
  const response=await h.tools.delivery_steer.execute('s',{},null,null,h.ctx);
  assert.match(response.content[0].text,/not yet confirmed/);
  const steering=h.calls.filter(c=>c.method==='steer');assert.equal(steering.length,1);assert.equal(steering[0].params.id,'owned');assert.match(steering[0].params.message,/node --test/);
  assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
  const repeat=await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);assert.match(repeat.content[0].text,/already running/);
  await assert.rejects(h.tools.delivery_configure.execute('c',{routes:{coder:routes.spec}},null,null,h.ctx),/owned run/);
  const direct=await h.events.tool_call({toolName:'subagent',input:{action:'steer',id:'owned',message:'change scope'}},h.ctx);assert.equal(direct.block,true);
 } finally {await h.events.session_shutdown();await h.controller.settled();}
});
test('resume after setup explains how to start without errors or execution',async()=>{
 const h=harness(),notifications=[];h.ctx.ui.notify=(...args)=>notifications.push(args);
 await h.events.session_start({},h.ctx);await h.commands.delivery.handler('setup',h.ctx);
 const before=h.controller.state(),messageCount=h.messages.length,entryCount=h.entries.length;
 await h.commands.delivery.handler('resume',h.ctx);
 assert.equal(h.messages.length,messageCount+1);
 assert.match(h.messages.at(-1).content,/No delivery task has started.*Describe your task normally/);
 const response=await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);
 assert.match(response.content[0].text,/No delivery task has started/);
 assert.doesNotMatch(response.content[0].text,/Recovery started/);
 assert.deepEqual(h.controller.state(),before);assert.equal(h.entries.length,entryCount);
 assert.deepEqual(notifications,[]);assert.deepEqual(h.calls,[]);
});
async function rejectedSecurity(reason=securityPreflightError) {
 const h=harness({version:1,routes:structuredClone(routes),repos:['/repo']}),rpc=h.deps.rpc;let reject=true;
 h.deps.rpc=async(...args)=>{const r=await rpc(...args);if(reject&&args[1]==='spawn'&&args[2].agent==='delivery-security')throw new Error(reason);return r;};
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('p',plan,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 return {h,allow:()=>{reject=false;}};
}
test('review prompts explicitly prohibit mutation despite implementation requirements',async()=>{
 const h=harness();h.deps.readPlan=()=>({path:'/repo/docs/plan.md',hash:'source',content:'Implement the approved feature.'});await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('p',{...plan,planFile:'docs/plan.md',tasks:[{...plan.tasks[0],instructions:'Implement banking. Write controller tests and fix authorization.'}]},null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 const file=(process.env.PI_SUBAGENTS_DIR || `${homedir()}/.pi/agent/npm/node_modules/pi-subagents`)+'/src/runs/shared/task-intent.ts';
 if(existsSync(file)) {
  // Node strips TS outside node_modules; execute the installed pure classifier unchanged.
  const dir=mkdtempSync(`${tmpdir()}/pi-native-classifier-`);
  try {
   copyFileSync(file,`${dir}/task-intent.ts`);
   const {classifyTaskMutationIntent}=await import(pathToFileURL(`${dir}/task-intent.ts`));
   for(const c of h.calls.filter(c=>c.method==='spawn'&&c.params.agent!=='delivery-coder'))assert.equal(classifyTaskMutationIntent(c.params.agent,c.params.task).kind,'read-only');
  } finally {rmSync(dir,{recursive:true,force:true});}
 }
 for(const c of h.calls.filter(c=>c.method==='spawn'&&c.params.agent!=='delivery-coder'))assert.match(c.params.task,/Read-only review\. Do not modify any files\./);
});
for(const choice of ['accept','new-policy','decline','workspace','config','shutdown'])test(`known security preflight recovery: ${choice}`,async()=>{
 const {h,allow}=await rejectedSecurity();const before=h.controller.state();allow();
 if(choice==='new-policy'){h.config.routes.security=routes.spec;h.config.timeouts={reviewMs:20*60000};}
 h.ctx.ui.confirm=async(_title,text)=>{if(choice==='new-policy'){assert.match(text,/custom\/s → custom\/r/);assert.match(text,/15 → 20/);}if(choice==='workspace')h.deps.fingerprint=()=> 'changed';if(choice==='config')h.config.routes.security=routes.spec;if(choice==='shutdown')await h.events.session_shutdown();return choice!=='decline';};
 const recovery=h.tools.delivery_resume.execute('r',{},null,null,h.ctx);
 if(!['accept','new-policy'].includes(choice)) {await assert.rejects(recovery,/not approved|changed|reapproval/i);assert.deepEqual(h.controller.state(),before);return;}
 await recovery;await h.controller.settled();const after=h.controller.state();
 assert.equal(after.stage,'complete');assert.deepEqual(after.coding,before.coding);assert.equal(after.round,before.round);
 if(choice==='new-policy'){assert.equal(after.routes.security,routes.spec);assert.equal(after.timeouts.reviewMs,20*60000);}
 assert.deepEqual(after.reports.slice(0,before.reports.length),before.reports);
 assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,1);
 assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-security').length,2);
});
test('security preflight evidence survives two restarts without coder replay',async()=>{
 const {h}=await rejectedSecurity();const original=h.controller.state();
 let current=h;
 for(let i=0;i<2;i++) {
  const next=harness(structuredClone(h.config));next.entries.push(...structuredClone(current.entries));
  await next.events.session_start({},next.ctx);current=next;
  assert.equal(current.controller.state().active.preflightRejection,securityPreflightError);
 }
 await current.tools.delivery_resume.execute('r',{},null,null,current.ctx);await current.controller.settled();
 assert.equal(current.controller.state().stage,'complete');assert.deepEqual(current.controller.state().coding,original.coding);
 assert.deepEqual(current.controller.state().reports.slice(0,original.reports.length),original.reports);
 assert.deepEqual(current.calls.filter(c=>c.method==='spawn').map(c=>c.params.agent),['delivery-security']);
});
for(const evidence of ['matching','missing','other-reservation','other-snapshot','newer-unknown-error'])test(`legacy overwritten preflight reason: ${evidence}`,async()=>{
 const {h}=await rejectedSecurity();const entries=structuredClone(h.entries);
 for(const e of entries)if(e.data?.active)delete e.data.active.preflightRejection;
 const current=structuredClone(entries.at(-1));current.data.reason='Retained child requires /delivery resume reconciliation';
 if(evidence==='other-reservation')for(const e of entries)if(e.data?.active)e.data.active.startedAt-=1;
 if(evidence==='other-snapshot')for(const e of entries)e.data.snapshot='different';
 if(evidence==='newer-unknown-error'){const newer=structuredClone(current);newer.data.reason='pi-subagents spawn timed out';entries.push(newer);}
 const next=harness(structuredClone(h.config));if(evidence!=='missing')next.entries.push(...entries);next.entries.push(current);
 await next.events.session_start({},next.ctx);
 if(evidence!=='matching') {
  next.ctx.ui.confirm=async()=>false;
  await assert.rejects(next.tools.delivery_resume.execute('r',{},null,null,next.ctx),/not confirmed/i);
  assert.equal(next.calls.filter(c=>c.method==='spawn').length,0);return;
 }
 assert.equal(next.controller.state().active.preflightRejection,securityPreflightError);
 await next.tools.delivery_resume.execute('r',{},null,null,next.ctx);await next.controller.settled();
 assert.equal(next.controller.state().stage,'complete');assert.deepEqual(next.calls.filter(c=>c.method==='spawn').map(c=>c.params.agent),['delivery-security']);
});
test('final correction exhaustion stops without proposing another plan',async()=>{
 const h=harness({version:1,routes,corrections:{maxFixRounds:4},repos:['/repo']});
 h.entries.push(oldRunEntry('blocked',routes,{round:4,correctionPolicy:{maxFixRounds:4,source:'configured'},reason:'Fix/review round limit exhausted (4)',reports:[{stage:'coder',task:0,round:4,snapshot:'hash',runId:'old',report:{status:'approved',summary:'done',findings:[]}}]}));
 await h.events.session_start({},h.ctx);const before=h.controller.state();
 const status=await h.tools.delivery_status.execute();const text=status.content.map(c=>c.text||'').join('\\n');
 assert.equal(status.details.nextAction.action,'inspect');assert.match(text,/approved correction bound is exhausted/i);assert.doesNotMatch(text,/prepare a new corrective plan/i);
 assert.deepEqual(h.controller.state(),before);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});

test('legacy exhausted plan adopts configured limit without replacement plan',async()=>{
 const h=harness({version:1,routes,corrections:{maxFixRounds:4},repos:['/repo']});
 h.entries.push(oldRunEntry('blocked',routes,{round:2,reason:'Fix/review round limit exhausted (2)',correctionPolicy:undefined}));
 await h.events.session_start({},h.ctx);const before=h.controller.state();
 await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);await h.controller.settled();
 const state=h.controller.state();
 assert.deepEqual(state.correctionPolicy,{maxFixRounds:4,source:'confirmed-extension'});assert.ok(state.round>=before.round);
 assert.deepEqual(state.plan,before.plan);assert.deepEqual(state.routes,before.routes);assert.ok(state.reports.some(r=>r.runId==='old'));
});

test('declined correction extension preserves exhausted state',async()=>{
 const h=harness({version:1,routes,corrections:{maxFixRounds:4},repos:['/repo']});
 h.entries.push(oldRunEntry('blocked',routes,{round:2,reason:'Fix/review round limit exhausted (2)',correctionPolicy:undefined}));
 await h.events.session_start({},h.ctx);const before=h.controller.state();h.ctx.ui.confirm=async()=>false;
 await assert.rejects(h.tools.delivery_resume.execute('r',{},null,null,h.ctx),/not approved/i);
 assert.deepEqual(h.controller.state(),before);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});

test('coding budget exhaustion refuses a correction extension without launching a coder',async()=>{
 const h=harness({version:1,routes,corrections:{maxFixRounds:4},repos:['/repo']});
 h.entries.push(oldRunEntry('blocked',routes,{round:2,reason:'Fix/review round limit exhausted (2)',correctionPolicy:undefined,coding:{0:{spentMs:60*60000,continuations:1}}}));
 await h.events.session_start({},h.ctx);const before=h.controller.state();
 const result=await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);
 assert.match(result.content[0].text,/approved correction bound is exhausted|inspect/i);assert.deepEqual(h.controller.state(),before);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('unresolved children never receive a corrective-plan next action',async()=>{
 const h=harness();h.entries.push(oldRunEntry('blocked',routes,{active:{id:null,dir:null,stage:'coder',model:routes.coder}}));
 await h.events.session_start({},h.ctx);const status=await h.tools.delivery_status.execute();
 assert.doesNotMatch(status.content[0].text,/NEXT ACTION:.*delivery_plan/);
 await assert.rejects(h.tools.delivery_plan.execute('p',plan,null,null,h.ctx),/owned run|unresolved/i);
});
test('unknown security launch errors stay uncertain without attestation and are never retried',async()=>{
 const {h}=await rejectedSecurity('pi-subagents spawn timed out');const before=h.controller.state(),spawns=h.calls.filter(c=>c.method==='spawn').length;
 h.ctx.ui.confirm=async()=>false;
 await assert.rejects(h.tools.delivery_resume.execute('r',{},null,null,h.ctx),/not confirmed/i);
 assert.deepEqual(h.controller.state(),before);assert.equal(h.calls.filter(c=>c.method==='spawn').length,spawns);
});
test('uncertain launch closes only through explicit attestation, without replay',async()=>{
 const {h}=await rejectedSecurity('pi-subagents spawn timed out');const before=h.controller.state(),spawns=h.calls.filter(c=>c.method==='spawn').length;
 let prompt='';h.ctx.ui.confirm=async(_title,text)=>{prompt=text;return true;};
 const r=await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);
 assert.match(r.content[0].text,/attestation/i);assert.match(r.content[0].text,/delivery_plan/);
 assert.match(prompt,/subagent status/);
 const state=h.controller.state();assert.equal(state.active,null);assert.equal(state.failedRun.launchUnknown,true);assert.equal(state.failedRun.notLaunched,undefined);
 assert.equal(state.failedRun.closureEvidence.kind,'user-attestation');assert.equal(state.failedRun.durationEstimated,true);
 assert.deepEqual(state.plan,before.plan);assert.deepEqual(state.reports,before.reports);assert.deepEqual(state.coding,before.coding);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,spawns);
});
test('later-task and final checks never run after the first coder',async()=>{
 const h=harness(),executed=[];let laterReady=false;
 const p={...plan,tasks:[{...plan.tasks[0],checks:['node first-test.mjs']},{...plan.tasks[0],title:'Later',files:['later'],checks:['node later-test.mjs']}],checks:['node release-test.mjs']};
 h.deps.readOutcome=a=>{if(a.stage==='coder'&&h.controller.state().task===1)laterReady=true;return {status:'approved',summary:'ok',findings:[]};};
 h.deps.verifyCommand=async(_root,command)=>{executed.push([command,h.controller.state().stage]);return {command,code:command.includes('first')||laterReady?0:1,output:'result'};};
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('plan',p,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');
 assert.deepEqual(executed,[['node first-test.mjs','checks'],['node later-test.mjs','checks'],['node release-test.mjs','verification']]);
 assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,2);
});
for(const approval of ['accepted','declined','workspace changed','state changed','routes changed','budget changed'])test(`legacy check-scope recovery preserves work (${approval})`,async()=>{
 const h=harness();h.config.routes={...routes,security:routes.spec};h.config.timeouts={reviewMs:20*60000};const legacyTask={title:'Add',instructions:'Add one',files:['a'],acceptance:['works']};const oldPlan={...plan,tasks:[legacyTask,{...legacyTask,title:'Later'}],checks:['node release-test.mjs']};
 const reports=[0,1,2].flatMap(round=>[{stage:'coder',task:0,round,snapshot:'hash',runId:'old'+round,report:{status:'approved',summary:'done',findings:[],executionEvidence:{sessionFiles:['/fake/prior.jsonl']}}},{stage:'checks',task:0,round,snapshot:'hash',report:{status:'changes_requested',summary:'Host verification failed',findings:['node release-test.mjs: Missing later test']}}]);
 h.entries.push({type:'custom',customType:'delivery-mode-v1',data:{version:1,enabled:true,stage:'blocked',task:0,round:2,plan:oldPlan,routes,timeouts:timeoutPolicy(),snapshot:'hash',active:null,reports,reason:'Two fix/review rounds exhausted',coding:{0:{spentMs:900000,continuations:1}},workspace:'/repo',owner:'session'}});
 let approvedText='',confirmations=0;h.ctx.ui.confirm=async(_title,text)=>{confirmations++;approvedText=text;if(approval==='workspace changed')h.deps.fingerprint=()=> 'changed';if(approval==='state changed')await h.commands.delivery.handler('off',h.ctx);if(approval==='routes changed')h.config.routes={...routes,security:routes.coder};if(approval==='budget changed')h.config.timeouts={coderMs:30*60000};return approval!=='declined';};
 const executed=[];h.deps.verifyCommand=async(_r,command)=>{executed.push(command);return {command,code:0,output:'PASS'};};
 await h.events.session_start({},h.ctx);
 const recovery=h.tools.delivery_resume.execute('resume',{taskChecks:[['node first-test.mjs'],['node later-test.mjs']]},null,null,h.ctx);
 if(approval!=='accepted') {await assert.rejects(recovery,/not approved|Workspace changed|state changed|configuration changed/);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);if(approval!=='state changed'){assert.equal(h.controller.state().round,2);assert.equal(h.controller.state().routes.security,routes.security);assert.equal(h.controller.state().timeouts.reviewMs,15*60000);}else assert.equal(h.controller.state().enabled,false);return;}
 await recovery;await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.match(approvedText,/release-test/);assert.match(approvedText,/security: custom\/s → custom\/r/);assert.match(approvedText,/reviewers 20m/);assert.equal(confirmations,1);
 assert.equal(h.controller.state().routes.security,routes.spec);
 assert.deepEqual(executed,['node first-test.mjs','node later-test.mjs','node release-test.mjs']);
 assert.equal(h.calls.find(c=>c.method==='spawn').params.model,routes.spec);assert.equal(h.calls.find(c=>c.method==='spawn').params.timeoutMs,20*60000);
 assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,1);
 assert.equal(h.controller.state().coding[0].spentMs,900000);
 assert.ok(h.controller.state().reports.some(r=>r.runId==='old2'));
});
test('interrupted task verification resumes checks and reviewers without replaying the coder',async()=>{
 const h=harness();const p={...plan,tasks:[{...plan.tasks[0],checks:['node task-test.mjs']}],checks:['node release-test.mjs']};
 h.deps.verifyCommand=async()=>{await h.events.session_shutdown({},h.ctx);return {code:0,output:'interrupted receipt'};};
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('plan',p,null,null,h.ctx);await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'checks');
 const next=harness();next.entries.push(h.entries.at(-1));await next.events.session_start({},next.ctx);
 await next.tools.delivery_resume.execute('resume',{},null,null,next.ctx);await next.controller.settled();
 assert.equal(next.controller.state().stage,'complete');assert.equal(next.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,0);
});
test('final release failure still blocks after all tasks, without replaying coders',async()=>{
 const h=harness();const p={...plan,tasks:[{...plan.tasks[0],checks:['node task-test.mjs']},{...plan.tasks[0],checks:['node later-test.mjs']}],checks:['node release-test.mjs']};
 h.deps.verifyCommand=async(_r,command)=>({command,code:command.includes('release')?1:0,output:'failed release'});
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('plan',p,null,null,h.ctx);await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'blocked');assert.match(h.controller.state().reason,/Verification failed/);assert.equal(h.controller.state().task,1);
 assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,2);
});
test('real command, auto activation, Astra selection and shell gate',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 assert.ok(h.commands.delivery);assert.equal(h.ctx.model.id,'gpt-6-astra');assert.match(h.statuses.at(-1),/planning/);
 assert.equal((await h.events.tool_call({toolName:'bash',input:{command:'echo x > a'}},h.ctx)).block,true);
 await h.events.session_shutdown({},h.ctx);
});
test('missing routes visibly block implementation, not inherited GPT',async()=>{
 const h=harness({version:1,routes:{planning:routes.planning},evidence:{},repos:['/repo']});await h.events.session_start({},h.ctx);
 await assert.rejects(h.tools.delivery_plan.execute('id',plan,null,null,h.ctx),/route/);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('proposal alone cannot launch; approval runs all stages and verification',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('id',plan,null,null,h.ctx);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 await h.commands.delivery.handler('approve',h.ctx);
 await h.controller.settled();
 assert.deepEqual(h.calls.filter(c=>c.method==='spawn').map(c=>c.params.agent),['delivery-coder','delivery-reviewer','delivery-reviewer','delivery-security']);
 assert.deepEqual(h.calls.filter(c=>c.method==='spawn').map(c=>c.params.model),[routes.coder,routes.spec,routes.quality,routes.security]);
 assert.equal(h.controller.state().stage,'complete');
 for(const c of h.calls.filter(c=>c.method==='spawn')) {assert.equal(c.params.context,'fresh');assert.equal(c.params.async,true);}
 await h.events.session_shutdown({},h.ctx);
});
test('failed host check requests bounded fix without inventing a spec review',async()=>{
 const h=harness();let checks=0;h.deps.verifyCommand=async()=>({code:checks++===0?1:0,output:'check result'});
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('id',plan,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');
 assert.equal(h.controller.state().reports.find(r=>r.report.status==='changes_requested').stage,'checks');
});
test('CLI/no-UI cannot auto approve plan',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('id',plan,null,null,h.ctx);h.ctx.hasUI=false;
 await h.commands.delivery.handler('approve',h.ctx);assert.equal(h.controller.state().stage,'awaiting-approval');
});
test('unconfigured repo remains OFF; child registers nothing',async()=>{
 const h=harness({version:1,routes,evidence:{},repos:[]});await h.events.session_start({},h.ctx);assert.equal(h.controller.state().enabled,false);assert.match(h.statuses.at(-1),/OFF/);
 const result=registerDelivery({on:()=>assert.fail('child hook'),registerCommand:()=>assert.fail('child command')},{},{child:true});assert.equal(result,undefined);
});
test('reload during verification resumes checks without relaunching a coder',async()=>{
 const h=harness();
 h.entries.push({type:'custom',customType:'delivery-mode-v1',data:{version:1,enabled:true,stage:'verification',task:0,round:0,plan,routes,snapshot:'hash',active:null,reports:[],reason:'',workspace:'/repo',owner:'session'}});
 await h.events.session_start({},h.ctx);assert.equal(h.controller.state().stage,'blocked');
 await h.commands.delivery.handler('resume',h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('retained coder is reconciled, never launched a second time on resume',async()=>{
 const h=harness();
 h.entries.push({type:'custom',customType:'delivery-mode-v1',data:{version:1,enabled:true,stage:'coder',task:0,round:0,plan,routes,snapshot:'hash',active:{id:'old',dir:'/fake',model:routes.coder,stage:'coder'},reports:[],reason:'',workspace:'/repo',owner:'session'}});
 await h.events.session_start({},h.ctx);await h.commands.delivery.handler('resume',h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,0);
});
test('legacy orchestration skill invocation activates the real mode',async()=>{
 const h=harness({version:1,routes,evidence:{},repos:[]});await h.events.session_start({},h.ctx);
 await h.events.input({text:'/skill:orchestrate-delivery feature',source:'interactive'},h.ctx);
 assert.equal(h.controller.state().enabled,true);assert.equal(h.ctx.model.id,'gpt-6-astra');
});
test('setup saves explicit selected routes and repo opt-in without inference',async()=>{
 const h=harness({version:1,routes:{},evidence:{},repos:[]});await h.events.session_start({},h.ctx);
 await h.commands.delivery.handler('setup',h.ctx);
 assert.equal(h.config.routes.planning,routes.planning);
 for(const role of ['coder','spec','quality','security'])assert.ok(h.config.routes[role]);
 assert.deepEqual(h.config.repos,['/repo']);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('setup explains roles and model capabilities without evidence prompts',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 const selections=[],confirmations=[];
 h.ctx.ui.input=async()=>assert.fail('No evidence/trial questions');
 const models=h.ctx.modelRegistry.getAvailable().map(m=>({...m,contextWindow:272000,maxTokens:32000,reasoning:true,input:['text','image'],cost:{input:2,output:8}}));
 h.ctx.modelRegistry.getAvailable=()=>models;
 h.ctx.ui.select=async(title,options)=>{selections.push({title,options});return options[0];};
 h.ctx.ui.confirm=async(title,body)=>{confirmations.push(body);return true;};
 await h.commands.delivery.handler('setup',h.ctx);
 assert.equal(selections.length,5);
 assert.match(selections[1].title,/implements.*tests/i);
 assert.match(selections[2].title,/acceptance criteria/i);
 assert.match(selections[3].title,/correctness/i);
 assert.match(selections[4].title,/security/i);
 assert.match(selections[0].options[0],/272k.*32k.*reasoning.*image.*\$2.*\$8/i);
 assert.equal(h.config.routes.planning,routes.planning);
 assert.ok(confirmations.every(t=>!/attestation|trial|evidence reference/i.test(t)));
});
test('legacy trial markers do not block high-risk tasks; approval and security remain mandatory',async()=>{
 const h=harness({version:1,routes,evidence:{coder:'trial',spec:'trial',quality:'trial',security:'trial'},repos:['/repo']});
 await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('id',{...plan,risk:'high',security:false},null,null,h.ctx);
 assert.equal(h.controller.state().stage,'awaiting-approval');assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 assert.equal(h.controller.state().plan.security,true);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.ok(h.calls.some(c=>c.params?.agent==='delivery-security'));
});
test('planner interprets raw request and starts only reviewers for the pinned range',async()=>{
 const h=harness();const range={base:'a'.repeat(40),head:'b'.repeat(40)};
 h.deps.revisionRange=(_root,n)=>{assert.equal(n,2);return range;};h.deps.assertCommittedWorkspace=()=>{};
 let checked=0;h.deps.verifyCommand=async()=>{checked++;return {code:0,output:'PASS'};};
 h.deps.diff=(_root,r)=>{assert.deepEqual(r,range);return 'committed diff';};
 await h.events.session_start({},h.ctx);await h.commands.delivery.handler('validate last 2 commits',h.ctx);
 assert.equal(h.messages.at(-1),'validate last 2 commits');
 assert.match((await h.tools.delivery_diff.execute('diff',{commits:2})).content[0].text,/committed diff/);
 await h.tools.delivery_plan.execute('id',{...plan,mode:'review',commits:2,tasks:[{...plan.tasks[0],checks:undefined}]},null,null,h.ctx);
 assert.equal(h.controller.state().plan.mode,'review');assert.deepEqual(h.controller.state().plan.reviewRange,range);
 await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.ok(checked>0);
 assert.deepEqual(h.calls.filter(c=>c.method==='spawn').map(c=>c.params.agent),['delivery-reviewer','delivery-reviewer','delivery-security']);
 assert.ok(h.calls.filter(c=>c.method==='spawn').every(c=>c.params.task.includes('Host verification evidence: [{') && c.params.task.includes('committed diff')));
});
test('committed multi-task spec evidence is path-scoped while aggregate reviewers inspect the range',async()=>{
 const h=harness();const range={base:'a'.repeat(40),head:'b'.repeat(40)},diffCalls=[];
 h.deps.revisionRange=()=>range;h.deps.assertCommittedWorkspace=()=>{};
 h.deps.diff=(_root,r,_limit,_offset,paths)=>{
  diffCalls.push({range:r,paths});
  return 'COMMITTED RANGE\n'+('large committed evidence '.repeat(2200))+'\n[Embedded diff truncated; inspect remaining approved files with repository-local git/read tools.]';
 };
 await h.events.session_start({},h.ctx);await h.commands.delivery.handler('validate last 2 commits',h.ctx);
 const committedPlan={...plan,mode:'review',commits:2,security:false,tasks:[
  {...plan.tasks[0],files:['app/a.rb'],checks:undefined},
  {...plan.tasks[0],title:'Second',files:['app/b.rb'],checks:undefined}
 ]};
 await h.tools.delivery_plan.execute('p',committedPlan,null,null,h.ctx);await h.controller.settled();
 const specs=h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-reviewer'&&c.params.task.includes('Independent spec'));
 const qualities=h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-reviewer'&&c.params.task.includes('Independent quality'));
 assert.equal(specs.length,2);assert.equal(qualities.length,2);
 assert.deepEqual(diffCalls.map(c=>c.paths),[['app/a.rb'],undefined,['app/b.rb'],undefined]);
 assert.match(specs[0].params.task,/exact current-task diff/i);assert.match(specs[0].params.task,/app\/a\.rb/);
 assert.doesNotMatch(specs[0].params.task,/continue delivery_diff/i);
 assert.match(qualities[0].params.task,/git diff --no-ext-diff/i);
 assert.doesNotMatch(qualities[0].params.task,/continue delivery_diff/i);
});

test('read-only check failure stops without dispatching an automatic fix',async()=>{
 const h=harness();h.deps.verifyCommand=async()=>({code:1,output:'failing test'});
 await h.events.session_start({},h.ctx);await h.commands.delivery.handler('review',h.ctx);
 await h.tools.delivery_plan.execute('id',{...plan,mode:'review',tasks:[{...plan.tasks[0],checks:undefined}]},null,null,h.ctx);
 await h.controller.settled();
 assert.equal(h.controller.state().stage,'blocked');assert.match(h.controller.state().reason,/failing test/);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('ordinary user review request executes without an approval command',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 await h.events.input({text:'Please validate these changes without fixing anything',source:'interactive'},h.ctx);
 await h.tools.delivery_plan.execute('id',{...plan,mode:'review',tasks:[{...plan.tasks[0],checks:undefined}]},null,null,h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');
 assert.ok(h.calls.some(c=>c.method==='spawn'));assert.ok(h.calls.every(c=>c.params?.agent!=='delivery-coder'));
});
test('conversational execution needs a fresh user reply to the exact pending plan',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('id',plan,null,null,h.ctx);
 assert.ok(h.tools.delivery_execute,'execution tool exists');
 await assert.rejects(h.tools.delivery_execute.execute('go',{},null,null,h.ctx),/user reply/i);
 await h.events.input({text:'Yes, implement the plan',source:'extension'},h.ctx);
 await assert.rejects(h.tools.delivery_execute.execute('go',{},null,null,h.ctx),/user reply/i);
 await h.events.input({text:'Yes, implement the plan',source:'interactive'},h.ctx);
 await h.tools.delivery_execute.execute('go',{},null,null,h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.ok(h.calls.some(c=>c.params?.agent==='delivery-coder'));
});
test('explicit file execution after reload adopts the document and starts derived tasks without another approval',async()=>{
 const h=harness();const path='docs/spark/plans/banking.md';
 h.deps.readPlan=()=>({path,hash:'doc-hash',content:'# Banking plan\n## Task 1\nImplement Add.'});
 await h.events.session_start({},h.ctx);
 await h.events.input({text:`Execute the plan ${path}`,source:'interactive'},h.ctx);
 const adopted=await h.tools.delivery_execute.execute('go',{planFile:path},null,null,h.ctx);
 assert.match(adopted.content[0].text,/Banking plan/);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 await h.tools.delivery_plan.execute('plan',{...plan,planFile:path},null,null,h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.equal(h.controller.state().plan.sourcePlan.hash,'doc-hash');
 assert.ok(h.calls.some(c=>c.params?.agent==='delivery-coder'));
});
test('file execution consent cannot survive a new message or changed document',async()=>{
 const h=harness();const path='docs/spark/plans/banking.md';let hash='one';
 h.deps.readPlan=()=>({path,hash,content:'# Banking'});
 await h.events.session_start({},h.ctx);await h.events.input({text:`Execute ${path}`,source:'interactive'},h.ctx);
 await h.tools.delivery_execute.execute('go',{planFile:path},null,null,h.ctx);hash='two';
 await assert.rejects(h.tools.delivery_plan.execute('plan',{...plan,planFile:path},null,null,h.ctx),/plan.*changed/i);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 hash='one';await h.tools.delivery_execute.execute('go',{planFile:path},null,null,h.ctx);
 await h.events.input({text:'Wait, only explain it',source:'interactive'},h.ctx);
 await h.tools.delivery_plan.execute('plan',{...plan,planFile:path},null,null,h.ctx);
 assert.equal(h.controller.state().stage,'awaiting-approval');assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('file execution consent rejects a changed correction policy before auto-launch',async()=>{
 const h=harness({version:1,routes,corrections:{maxFixRounds:0},repos:['/repo']});const path='docs/spark/plans/banking.md';
 h.deps.readPlan=()=>({path,hash:'one',content:'# Banking'});
 await h.events.session_start({},h.ctx);await h.events.input({text:`Execute ${path}`,source:'interactive'},h.ctx);
 await h.tools.delivery_execute.execute('go',{planFile:path},null,null,h.ctx);
 h.config.corrections={maxFixRounds:8};
 await assert.rejects(h.tools.delivery_plan.execute('plan',{...plan,planFile:path},null,null,h.ctx),/correction.*changed|reapproval/i);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('repeated file execution request rejects a changed correction policy',async()=>{
 const h=harness({version:1,routes,corrections:{maxFixRounds:0},repos:['/repo']});const path='docs/spark/plans/banking.md';
 h.deps.readPlan=()=>({path,hash:'one',content:'# Banking'});
 await h.events.session_start({},h.ctx);await h.events.input({text:`Execute ${path}`,source:'interactive'},h.ctx);
 await h.tools.delivery_execute.execute('go',{planFile:path},null,null,h.ctx);
 h.config.corrections={maxFixRounds:8};
 await assert.rejects(h.tools.delivery_execute.execute('go',{planFile:path},null,null,h.ctx),/correction.*changed|fresh user request/i);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('implementation and review checks keep their ordering and stop on failure',async()=>{
 for(const mode of ['implementation','review']) {
  const h=harness(),ran=[];
  h.deps.verifyCommand=async(_cwd,command)=>{ran.push(command);return {command,code:0,output:'PASS'};};
  await h.events.session_start({},h.ctx);
  await h.tools.delivery_plan.execute('plan',{...plan,mode,checks:['first','second'],tasks:[{...plan.tasks[0],checks:mode==='review'?undefined:['first','second']}]},null,null,h.ctx);
  await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
  assert.deepEqual(ran,['first','second','first','second']);assert.equal(h.controller.state().stage,'complete');
 }
 const h=harness(),ran=[];
 h.deps.verifyCommand=async(_cwd,command)=>{ran.push(command);return {command,code:1,output:'FAIL'};};
 await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('plan',{...plan,mode:'review',checks:['first','second'],tasks:[{...plan.tasks[0],checks:undefined}]},null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.deepEqual(ran,['first']);assert.equal(h.controller.state().stage,'blocked');
});
test('shared approval validation still rejects workspace changes during confirmation',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('plan',plan,null,null,h.ctx);
 h.ctx.ui.confirm=async()=>{h.deps.fingerprint=()=> 'changed';return true;};
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 assert.equal(h.controller.state().stage,'awaiting-approval');
});
test('confirmed coder timeout continues once on the exact model after runner closure',async()=>{
 const h=harness();let now=0,attempt=0,proofChecks=0;
 h.deps.now=()=>now;
 h.deps.runProgress=active=>{
  if(active.stage!=='coder' || attempt>0)return null;
  now=45*60000;return {state:'failed',timedOut:true,model:routes.coder,attemptedModels:[routes.coder],sessionFiles:[],durationMs:45*60000};
 };
 h.deps.isSettled=()=>{proofChecks++;if(proofChecks===1)return false;attempt=1;return true;};
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('plan',plan,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 const coders=h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder');
 assert.equal(coders.length,2);assert.equal(coders[0].params.timeoutMs,45*60000);assert.equal(coders[1].params.timeoutMs,15*60000);
 assert.ok(coders.every(c=>c.params.model===routes.coder));assert.match(coders[1].params.task,/partial.*verification|verify.*partial/i);
 assert.equal(h.controller.state().stage,'complete');assert.ok(proofChecks>=2);
});
for(const kind of ['coder','security','unclosed','wrong-model'])test(`failed child reconciliation: ${kind}`,async()=>{
 const h=harness();const stage=kind==='security'?'security':'coder';
 const active={id:'failed-child',dir:'/fake',stage,model:routes[stage],budgetMs:312293,continuation:true};
 h.entries.push(oldRunEntry('blocked',routes,{round:1,reason:'Child failed',active,coding:{0:{spentMs:3287707,continuations:1}}}));
 h.deps.isSettled=()=>kind!=='unclosed';
 h.deps.runProgress=()=>({state:'failed',timedOut:false,model:kind==='wrong-model'?'wrong':active.model,attemptedModels:[active.model],durationMs:34000,error:'Invalid API key.',sessionFiles:['/fake/session.jsonl']});
 await h.events.session_start({},h.ctx);const before=h.controller.state();
 if(['unclosed','wrong-model'].includes(kind)) {
  await assert.rejects(h.tools.delivery_resume.execute('r',{},null,null,h.ctx),/closed|model/i);
  assert.deepEqual(h.controller.state().active,before.active);assert.deepEqual(h.controller.state().coding,before.coding);
 } else {
  const r=await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);await h.controller.settled();
  assert.match(r.content[0].text,/no execution restarted/i);assert.equal(h.controller.state().active,null);
  assert.equal(h.controller.state().failedRun.id,'failed-child');assert.equal(h.controller.state().failedRun.error,'Invalid API key.');
  assert.equal(h.controller.state().coding[0].spentMs,3287707+(stage==='coder'?34000:0));assert.equal(h.controller.state().coding[0].continuations,1);
  assert.deepEqual(h.controller.state().reports,before.reports);assert.equal(h.controller.state().round,1);
  const retained=h.controller.state();assert.match((await h.tools.delivery_resume.execute('r',{},null,null,h.ctx)).content[0].text,/delivery_plan/);assert.deepEqual(h.controller.state(),retained);
  const text=(await h.tools.delivery_status.execute()).content[0].text;assert.match(text,/Invalid API key/);assert.match(text,/delivery_plan/);
  if(stage==='security')assert.match(text,/Do not replay completed coding/);
 }
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('second timeout stops; no infinite restart loop',async()=>{
 const h=harness();h.deps.isSettled=()=>true;
 h.deps.runProgress=a=>({state:'failed',timedOut:true,model:a.model,attemptedModels:[a.model],durationMs:a.budgetMs,sessionFiles:[]});
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('plan',plan,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'blocked');assert.equal(h.calls.filter(c=>c.method==='spawn').length,2);
 assert.match(h.controller.state().reason,/continuation|budget/i);
 assert.equal(h.controller.state().active,null);assert.equal(h.controller.state().failedRun.state,'failed');
 assert.match((await h.tools.delivery_status.execute()).content[0].text,/delivery_plan/);
});
test('worker instructions keep positive evidence out of actionable findings',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('plan',plan,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.match(h.calls.find(c=>c.method==='spawn').params.task,/approved requires findings=\[\]/);
});
for(const approved of [false,true])test(`changed routes recover a closed timeout only with confirmation (${approved})`,async()=>{
 const h=harness();h.config.routes={...routes,coder:routes.spec};
 h.entries.push({type:'custom',customType:'delivery-mode-v1',data:{version:1,enabled:true,stage:'blocked',task:0,round:0,plan,routes,snapshot:'hash',active:{id:'old',dir:'/fake',model:routes.coder,stage:'coder'},reports:[],reason:'Routes changed',workspace:'/repo',owner:'session'}});
 h.deps.isSettled=()=>true;
 h.deps.runProgress=a=>a.id==='old'?{state:'failed',timedOut:true,model:routes.coder,attemptedModels:[routes.coder],timeoutMs:900000,durationMs:900000,sessionFiles:['/fake/prior.jsonl']}:null;
 let prompt='';h.ctx.ui.confirm=async(_title,text)=>{prompt=text;return approved;};
 await h.events.session_start({},h.ctx);
 const resume=h.tools.delivery_resume.execute('resume',{},null,null,h.ctx);
 if(approved){await resume;await h.controller.settled();assert.equal(h.controller.state().stage,'complete');assert.equal(h.calls.find(c=>c.method==='spawn').params.model,routes.spec);assert.ok(h.calls.find(c=>c.method==='spawn').params.task.includes('"approvedRoutes":'+JSON.stringify(h.config.routes)));}
 else{await assert.rejects(resume,/not approved/);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);assert.equal(h.controller.state().routes.coder,routes.coder);}
 assert.match(prompt,/custom\/c → custom\/r/);assert.match(prompt,/partial/);
});
test('restart between timeout closure and dispatch retains the single continuation grant',async()=>{
 const h=harness();h.config.routes={...routes,coder:routes.spec};
 h.entries.push({type:'custom',customType:'delivery-mode-v1',data:{version:1,enabled:true,stage:'coder',task:0,round:0,plan,routes,timeouts:timeoutPolicy(),snapshot:'hash',active:null,pendingContinuation:true,coding:{0:{spentMs:45*60000,continuations:1}},reports:[],reason:'',workspace:'/repo',owner:'session'}});
 await h.events.session_start({},h.ctx);await h.tools.delivery_resume.execute('resume',{},null,null,h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.equal(h.controller.state().coding[0].continuations,1);
 const launch=h.calls.find(c=>c.method==='spawn');assert.equal(launch.params.model,routes.spec);assert.equal(launch.params.timeoutMs,15*60000);
});
test('quiet running tools are not classified as idle or stopped',async()=>{
 const h=harness();let now=0;h.deps.now=()=>now;
 h.deps.runProgress=a=>{if(a.stage!=='coder')return null;now=10*60000;return {state:'running',lastActivityAt:0,currentTool:'bash',deadlineAt:45*60000};};
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('plan',plan,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.ok(!h.messages.some(m=>m.content?.includes('No recent recorded')));
 assert.equal(h.calls.filter(c=>c.method==='stop').length,0);
});
test('near-deadline steer is sent once; inactivity only warns',async()=>{
 const h=harness();let now=0,reads=0;h.deps.now=()=>now;
 h.deps.runProgress=a=>{if(a.stage!=='coder')return null;now=41*60000;return {state:'running',lastActivityAt:0,deadlineAt:45*60000};};
 h.deps.readOutcome=()=>++reads===1?null:{status:'approved',summary:'ok',findings:[]};
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('plan',plan,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.equal(h.calls.filter(c=>c.method==='steer').length,1);assert.equal(h.calls.filter(c=>c.method==='stop').length,0);
 assert.equal(h.messages.filter(m=>m.content?.includes('No recent recorded')).length,1);
});
test('model-mismatched timed-out runs cannot obtain continuation authority',async()=>{
 const h=harness();h.deps.isSettled=()=>true;
 h.deps.runProgress=()=>({state:'failed',timedOut:true,model:'other/model',attemptedModels:['other/model'],durationMs:900000});
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('plan',plan,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'blocked');assert.match(h.controller.state().reason,/model evidence/);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,1);
});
test('approval preview is readable rather than a JSON object dump',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('id',plan,null,null,h.ctx);
 let body;h.ctx.ui.confirm=async(_title,text)=>{body=text;return false;};
 await h.commands.delivery.handler('approve',h.ctx);
 assert.match(body,/Tasks/);assert.match(body,/node --test/);assert.doesNotMatch(body,/"tasks"\s*:/);
});
test('new proposal binds four correction rounds and shows them before approval',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('p',plan,null,null,h.ctx);
 assert.deepEqual(h.controller.state().correctionPolicy,{maxFixRounds:4,source:'default'});
 assert.match(h.messages.at(-1).content,/up to 4 coder rework rounds/i);
});
test('configured correction limit changes pending approval identity',async()=>{
 const h=harness();h.config.corrections={maxFixRounds:3};
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('p',plan,null,null,h.ctx);
 await h.events.input({text:'approve',source:'interactive'},h.ctx);
 h.config.corrections={maxFixRounds:4};
 await assert.rejects(h.tools.delivery_execute.execute('e',{},null,null,h.ctx),/correction.*changed|reapproval/i);
});
test('reloaded approval preserves the correction policy bound to the proposal',async()=>{
 const first=harness({version:1,routes,corrections:{maxFixRounds:3},repos:['/repo']});
 await first.events.session_start({},first.ctx);await first.tools.delivery_plan.execute('p',plan,null,null,first.ctx);
 const reloaded=harness(structuredClone(first.config));reloaded.entries.push(...structuredClone(first.entries));
 await reloaded.events.session_start({},reloaded.ctx);
 assert.deepEqual(reloaded.controller.state().correctionPolicy,{maxFixRounds:3,source:'configured'});
 await reloaded.events.input({text:'approve',source:'interactive'},reloaded.ctx);
 await reloaded.tools.delivery_execute.execute('e',{},null,null,reloaded.ctx);await reloaded.controller.settled();
 assert.deepEqual(reloaded.controller.state().correctionPolicy,{maxFixRounds:3,source:'configured'});
});
test('reloaded legacy approval without correction policy keeps the two-round limit',async()=>{
 const h=harness();h.entries.push(oldRunEntry('awaiting-approval',routes));
 await h.events.session_start({},h.ctx);
 assert.equal(h.controller.state().correctionPolicy,undefined);
 await h.events.input({text:'approve',source:'interactive'},h.ctx);
 await h.tools.delivery_execute.execute('e',{},null,null,h.ctx);await h.controller.settled();
 assert.deepEqual(h.controller.state().correctionPolicy,{maxFixRounds:2,source:'legacy'});
 assert.equal(h.controller.state().stage,'complete');
 assert.ok(h.calls.some(c=>c.method==='spawn'&&c.params.agent==='delivery-coder'));
});
const supervisorRequestEntry=(runId='owned',agent='delivery-coder',childIndex=0,id='request-1')=>({type:'custom_message',customType:'subagent_supervisor_request',details:{id,requestId:id,runId,agent,childIndex}});
for (const hasUI of [true, false]) test(`active supervisor replies are informational without a confirmation prompt (${hasUI ? 'UI' : 'no UI'})`,async()=>{
 const h=harness();h.entries.push(oldRunEntry('coder',routes,{active:{id:'owned',dir:'/fake',stage:'coder',model:routes.coder,agent:'delivery-coder',childIndex:0}}),supervisorRequestEntry());
 h.ctx.hasUI=hasUI;
 h.ctx.ui.confirm=async()=>{throw new Error('Unexpected confirmation');};
 await h.events.session_start({},h.ctx);
 const response=await h.events.tool_call({toolName:'subagent_supervisor',input:{action:'reply',replyTo:'request-1',message:'clarification'}},h.ctx);
 assert.equal(response,undefined);
});

test('active worker does not authorize a same-session supervisor reply for another child',async()=>{
 const h=harness();h.entries.push(oldRunEntry('coder',routes,{active:{id:'owned',dir:'/fake',stage:'coder',model:routes.coder,agent:'delivery-coder',childIndex:0}}),supervisorRequestEntry('other-run','worker',1,'other-request'));
 await h.events.session_start({},h.ctx);
 const response=await h.events.tool_call({toolName:'subagent_supervisor',input:{action:'reply',replyTo:'other-request',message:'clarification'}},h.ctx);
 assert.equal(response.block,true);assert.match(response.reason,/owned worker/);
});

test('legacy active owned worker state restores trusted supervisor reply identity',async()=>{
 const h=harness();h.entries.push(oldRunEntry('coder',routes,{active:{id:'owned',dir:'/fake',stage:'coder',model:routes.coder}}),supervisorRequestEntry());
 await h.events.session_start({},h.ctx);
 h.ctx.hasUI=false;h.ctx.ui.confirm=async()=>{throw new Error('Unexpected confirmation');};
 const response=await h.events.tool_call({toolName:'subagent_supervisor',input:{action:'reply',replyTo:'request-1',message:'clarification'}},h.ctx);
 assert.equal(response,undefined);
 assert.equal(h.controller.state().active.agent,'delivery-coder');
 assert.equal(h.controller.state().active.childIndex,0);
});
test('supervisor replies without an active owned worker remain blocked',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 const response=await h.events.tool_call({toolName:'subagent_supervisor',input:{action:'reply',replyTo:'request-1',message:'clarification'}},h.ctx);
 assert.equal(response.block,true);
});
test('runtime failed child cannot become approved from prose',async()=>{
 const h=harness();h.deps.readOutcome=()=>{throw new Error('child failed');};await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('id',plan,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();assert.equal(h.controller.state().stage,'blocked');assert.match(h.controller.state().reason,/child failed/);
});
const oldRunEntry=(stage,oldRoutes,extra={})=>({type:'custom',customType:'delivery-mode-v1',data:{version:1,enabled:true,stage,task:0,round:2,plan,routes:oldRoutes,timeouts:timeoutPolicy(),snapshot:'hash',active:null,reports:[{stage:'security',task:0,round:2,snapshot:'hash',runId:'old',report:{status:'approved',summary:'done',findings:[]}}],reason:stage==='blocked'?'Two fix/review rounds exhausted':'',workspace:'/repo',owner:'session',...extra}});
const excludedModelError=model=>`Requested subagent model '${model}' is excluded and cannot be replaced by a fallback (reason: Connection error.; expires: 2026-09-16T12:59:57.188Z).`;
test('excluded model preflight can be closed without replay or lost evidence, then routes changed',async()=>{
 const h=harness(),rpc=h.deps.rpc;
 h.deps.rpc=async(...args)=>{if(args[1]==='spawn')throw new Error(excludedModelError(routes.coder));return rpc(...args);};
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('p',plan,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 const before=h.controller.state();assert.equal(before.active.id,null);
 const response=await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);
 assert.match(response.content[0].text,/no worker was launched/);
 const closed=h.controller.state();assert.equal(closed.active,null);assert.equal(closed.failedRun.notLaunched,true);
 assert.deepEqual(closed.plan,before.plan);assert.deepEqual(closed.coding,before.coding);assert.deepEqual(closed.reports,before.reports);
 await h.commands.delivery.handler('setup',h.ctx);
 assert.deepEqual(h.controller.state().plan,closed.plan);assert.deepEqual(h.controller.state().failedRun,closed.failedRun);
 const status=await h.tools.delivery_status.execute();assert.match(status.content[0].text,/new corrective plan/);
 await h.tools.delivery_plan.execute('p',{...plan,title:'Finish retained work'},null,null,h.ctx);
 assert.equal(h.controller.state().stage,'awaiting-approval');
 await assert.rejects(h.tools.delivery_execute.execute('e',{},null,null,h.ctx),/fresh user reply/);
});
for(const evidence of ['matching','other-model','other-reservation','newer-unknown'])test(`legacy excluded-model preflight evidence: ${evidence}`,async()=>{
 const h=harness();
 const original=oldRunEntry('blocked',routes,{active:{id:null,dir:null,model:routes.coder,stage:'coder',startedAt:1},reason:excludedModelError(evidence==='other-model'?routes.spec:routes.coder)});
 const current=structuredClone(original);current.data.reason='Retained child requires /delivery resume reconciliation';
 if(evidence==='other-reservation')current.data.active.startedAt=2;
 h.entries.push(original);
 if(evidence==='newer-unknown'){const unknown=structuredClone(original);unknown.data.reason='pi-subagents spawn timed out';h.entries.push(unknown);}
 h.entries.push(current);await h.events.session_start({},h.ctx);
 const next=harness();next.entries.push(...structuredClone(h.entries));await next.events.session_start({},next.ctx);
 if(evidence==='matching') {
  await next.tools.delivery_resume.execute('r',{},null,null,next.ctx);
  assert.equal(next.controller.state().active,null);assert.equal(next.controller.state().failedRun.notLaunched,true);
 } else {
  next.ctx.ui.confirm=async()=>false;
  const before=next.controller.state();await assert.rejects(next.tools.delivery_resume.execute('r',{},null,null,next.ctx),/not confirmed/i);assert.deepEqual(next.controller.state(),before);
 }
 assert.deepEqual(next.calls,[]);
});
test('terminal old/new route mismatch permits a replacement proposal without launching',async()=>{
 const h=harness();h.entries.push(oldRunEntry('complete',{...routes,coder:routes.spec,security:routes.spec}));
 await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('plan',plan,null,null,h.ctx);
 assert.equal(h.controller.state().stage,'awaiting-approval');
 assert.equal(h.controller.state().routes.security,routes.security);
 assert.equal(h.controller.state().routes.coder,routes.coder);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('fresh approval executes the replacement proposal on current routes; old routes are not reused',async()=>{
 const h=harness();h.entries.push(oldRunEntry('complete',{...routes,coder:routes.spec,security:routes.spec}));
 await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('plan',plan,null,null,h.ctx);
 await h.events.input({text:'Yes, implement the plan',source:'interactive'},h.ctx);
 await h.tools.delivery_execute.execute('go',{},null,null,h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');
 assert.deepEqual(h.calls.filter(c=>c.method==='spawn').map(c=>c.params.model),[routes.coder,routes.spec,routes.quality,routes.security]);
 assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,1);
});
test('an old reply cannot authorize the replacement proposal',async()=>{
 const h=harness();h.entries.push(oldRunEntry('complete',{...routes,coder:routes.spec,security:routes.spec}));
 await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('plan',plan,null,null,h.ctx);
 await assert.rejects(h.tools.delivery_execute.execute('go',{},null,null,h.ctx),/user reply/i);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('config changes after a proposal still block execution',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('plan',plan,null,null,h.ctx);
 h.config.routes={...routes,security:routes.quality};
 await h.events.input({text:'Yes, implement the plan',source:'interactive'},h.ctx);
 await assert.rejects(h.tools.delivery_execute.execute('go',{},null,null,h.ctx),/Routes changed|reapproval/i);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('active or uncertain owned children prevent replacement proposals',async()=>{
 for(const active of [{id:'old',dir:'/fake',model:routes.coder,stage:'coder'},{id:null,dir:null,model:routes.coder,stage:'coder'}]) {
  const h=harness();h.entries.push(oldRunEntry('blocked',{...routes,coder:routes.spec,security:routes.spec},{active}));
  await h.events.session_start({},h.ctx);
  await assert.rejects(h.tools.delivery_plan.execute('plan',plan,null,null,h.ctx),/owned run is active|unresolved/i);
  assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 }
});
test('delivery_execute without a pending plan explains resubmission, not repeated approval',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 await assert.rejects(h.tools.delivery_execute.execute('go',{},null,null,h.ctx),/No pending plan/);
 assert.doesNotMatch(h.controller.state().reason||'',/./);
});
test('saved-file adoption after a terminal run binds current routes, not stale run bindings',async()=>{
 const h=harness();const path='docs/spark/plans/bank.md';
 h.deps.readPlan=()=>({path,hash:'doc-hash',content:'# Bank plan\n## Task 1\nImplement Add.'});
 h.entries.push(oldRunEntry('complete',{...routes,coder:routes.spec,security:routes.spec}));
 await h.events.session_start({},h.ctx);
 await h.events.input({text:`Execute the plan ${path}`,source:'interactive'},h.ctx);
 await h.tools.delivery_execute.execute('go',{planFile:path},null,null,h.ctx);
 await h.tools.delivery_plan.execute('plan',{...plan,planFile:path},null,null,h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');
 assert.equal(h.controller.state().plan.sourcePlan.hash,'doc-hash');
 assert.ok(h.calls.some(c=>c.params?.agent==='delivery-coder'&&c.params.model===routes.coder));
});
test('prior run evidence stays in session history and out of the new active reports',async()=>{
 const h=harness();h.entries.push(oldRunEntry('complete',{...routes,coder:routes.spec,security:routes.spec}));
 await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('plan',plan,null,null,h.ctx);
 const state=h.controller.state();
 assert.ok(!state.reports.some(r=>r.runId==='old'));
 assert.ok(!state.reports.length);
 assert.equal(state.priorRun?.reports,1);
 assert.ok(h.entries.some(e=>JSON.stringify(e.data).includes('"runId":"old"')));
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});

for(const stage of ['coder','spec','quality','security'])test(`connection failure retries only the failed ${stage} on the approved route`,async()=>{
 const h=harness();let failed=false;
 h.deps.isSettled=()=>true;
 h.deps.runProgress=a=>{
  if(a.stage!==stage || failed)return null;
  failed=true;
  return {state:'failed',nativeState:'partial',error:'Connection error.\nRequired structured output was not produced',model:a.model,attemptedModels:[a.model],durationMs:1000,sessionFiles:['/fake/prior.jsonl']};
 };
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('p',plan,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 const state=h.controller.state(),spawns=h.calls.filter(c=>c.method==='spawn');
 assert.equal(state.stage,'complete');assert.equal(state.round,0);
 const attempts=spawns.filter(c=>c.params.model===routes[stage] && c.params.agent===`delivery-${stage==='coder'?'coder':stage==='security'?'security':'reviewer'}`);
 assert.equal(spawns.length,5);assert.equal(spawns.filter(c=>c.params.agent==='delivery-coder').length,stage==='coder'?2:1);
 assert.ok(attempts.some(c=>c.params.task.includes('/fake/prior.jsonl')));
 assert.equal(state.connectionRetries[`0:0:${stage}`].count,1);
 assert.equal(state.interruptions.length,1);
});
for(const scenario of ['exhausted','unclosed','wrong-model','route-change','review-mutation','non-transient'])test(`connection retry boundary: ${scenario}`,async()=>{
 const h=harness();h.deps.isSettled=()=>scenario!=='unclosed';
 h.deps.runProgress=a=>{
  if(scenario==='review-mutation' && a.stage==='coder')return null;
  if(scenario==='route-change')h.config.routes={...routes,coder:routes.spec};
  if(scenario==='review-mutation')h.deps.fingerprint=()=> 'mutated';
  return {state:'failed',error:scenario==='non-transient'?'Invalid API key.':'Connection error.',model:scenario==='wrong-model'?'other/model':a.model,attemptedModels:[a.model],durationMs:1000,sessionFiles:[]};
 };
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('p',plan,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 const state=h.controller.state();assert.equal(state.stage,'blocked');
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,scenario==='exhausted'?3:scenario==='review-mutation'?2:1);
 if(scenario==='exhausted'){assert.equal(state.coding[0].spentMs,3000);assert.equal(state.connectionRetries['0:0:coder'].count,2);assert.equal(state.active,null);}
});
test('retained failed connection recovers through resume without another approval',async()=>{
 const h=harness();h.entries.push(oldRunEntry('blocked',routes,{round:0,timeouts:timeoutPolicy(),active:{id:'old',dir:'/fake',stage:'coder',model:routes.coder,budgetMs:2700000,startedAt:0}}));
 h.deps.isSettled=()=>true;
 h.deps.runProgress=a=>a.id==='old'?{state:'failed',error:'Connection error.',model:a.model,attemptedModels:[a.model],durationMs:137000,sessionFiles:['/fake/old.jsonl']}:null;
 h.ctx.ui.confirm=async()=>{throw new Error('Unexpected approval');};
 await h.events.session_start({},h.ctx);await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.equal(h.controller.state().connectionRetries['0:0:coder'].count,1);
});
test('pending connection retry survives restart and retains retry ceiling and remaining budget',async()=>{
 const h=harness();h.entries.push(oldRunEntry('coder',routes,{round:0,timeouts:timeoutPolicy(),pendingRetry:{stage:'coder',budgetMs:5000,notBefore:0,continuation:false},connectionRetries:{'0:0:coder':{count:2,spentMs:2000}},coding:{0:{spentMs:2000,continuations:0}}}));
 h.deps.isSettled=()=>true;
 h.deps.runProgress=a=>({state:'failed',error:'Connection error.',model:a.model,attemptedModels:[a.model],durationMs:1000,sessionFiles:[]});
 await h.events.session_start({},h.ctx);await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);await h.controller.settled();
 const spawns=h.calls.filter(c=>c.method==='spawn');assert.equal(spawns.length,1);assert.equal(spawns[0].params.timeoutMs,5000);
 assert.equal(h.controller.state().stage,'blocked');assert.equal(h.controller.state().coding[0].spentMs,3000);
});
test('connection failure cannot extend an exhausted review budget',async()=>{
 const h=harness();h.deps.isSettled=()=>true;
 h.deps.runProgress=a=>a.stage==='spec'?{state:'failed',error:'Connection error.',model:a.model,attemptedModels:[a.model],durationMs:a.budgetMs,sessionFiles:[]}:null;
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('p',plan,null,null,h.ctx);await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'blocked');assert.equal(h.calls.filter(c=>c.method==='spawn').length,2);
});

for(const choice of ['accept','decline','no-ui','state-change'])test(`bare delivery offers retained recovery: ${choice}`,async()=>{
 const h=harness();h.entries.push(oldRunEntry('blocked',routes,{round:0,timeouts:timeoutPolicy(),active:{id:'old',dir:'/fake',stage:'coder',model:routes.coder,budgetMs:2700000,startedAt:0}}));
 h.deps.isSettled=()=>true;
 h.deps.runProgress=a=>a.id==='old'?{state:'failed',error:'Connection error.',model:a.model,attemptedModels:[a.model],durationMs:1000,sessionFiles:[]}:null;
 await h.events.session_start({},h.ctx);const before=h.controller.state();let confirmations=0;
 h.ctx.hasUI=choice!=='no-ui';
 h.ctx.ui.confirm=async(title,text)=>{confirmations++;assert.match(title,/Resume retained delivery/);assert.match(text,/Fixture/);assert.match(text,/Task 1\/1/);if(choice==='state-change')await h.commands.delivery.handler('off',h.ctx);return choice!=='decline';};
 await h.commands.delivery.handler('',h.ctx);await h.controller.settled();
 assert.equal(confirmations,choice==='no-ui'?0:1);
 if(choice==='accept'){assert.equal(h.controller.state().stage,'complete');assert.equal(h.controller.state().connectionRetries['0:0:coder'].count,1);}
 else {assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);if(choice!=='state-change')assert.deepEqual(h.controller.state(),before);}
});
for(const stage of ['awaiting-approval','blocked','complete'])test(`bare delivery preserves ${stage} plan and evidence`,async()=>{
 const h=harness();h.entries.push(oldRunEntry(stage,routes));await h.events.session_start({},h.ctx);
 const before=h.controller.state();h.ctx.ui.confirm=async()=>{throw new Error('Unexpected resume prompt');};
 await h.commands.delivery.handler('',h.ctx);assert.deepEqual(h.controller.state(),before);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('bare delivery reports a running worker without prompting or replacing it',async()=>{
 const h=harness();let release;h.deps.readOutcome=()=>null;
 const rpc=h.deps.rpc;h.deps.rpc=async(...args)=>{const r=await rpc(...args);if(args[1]==='status')await new Promise(resolve=>{release=resolve;});return r;};
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('p',plan,null,null,h.ctx);await h.commands.delivery.handler('approve',h.ctx);
 while(!release)await new Promise(r=>setImmediate(r));
 const before=h.controller.state();h.ctx.ui.confirm=async()=>{throw new Error('Unexpected prompt');};
 await h.commands.delivery.handler('',h.ctx);assert.deepEqual(h.controller.state(),before);
 await h.events.session_shutdown();release();await h.controller.settled();
});
test('busy commands report status once without changing or steering the live worker',async()=>{
 const h=harness(),notifications=[];let release;h.deps.readOutcome=()=>null;
 h.ctx.ui.notify=(...args)=>notifications.push(args);
 const rpc=h.deps.rpc;h.deps.rpc=async(...args)=>{const r=await rpc(...args);if(args[1]==='status')await new Promise(resolve=>{release=resolve;});return r;};
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('p',plan,null,null,h.ctx);await h.commands.delivery.handler('approve',h.ctx);
 while(!release)await new Promise(r=>setImmediate(r));
 try {
  const before=h.controller.state(),calls=structuredClone(h.calls);
  h.ctx.ui.confirm=async()=>{throw new Error('Unexpected confirmation');};
  for(const command of ['setup','approve','fix the build','setup']) {
   const count=h.messages.length;
   await h.commands.delivery.handler(command,h.ctx);
   assert.equal(h.messages.length,count+1);assert.match(h.messages.at(-1).content,/Execution is running.*delivery_status/);
   assert.deepEqual(h.controller.state(),before);assert.deepEqual(h.calls,calls);
  }
  assert.deepEqual(notifications,[]);
 } finally {await h.events.session_shutdown();release();await h.controller.settled();}
});
test('unclosed timeout recovery waits without errors or replacement, then continues after closure',async()=>{
 const h=harness(),notifications=[];let settled=false;
 h.ctx.ui.notify=(...args)=>notifications.push(args);
 h.entries.push(oldRunEntry('blocked',routes,{timeouts:timeoutPolicy(),active:{id:'old',dir:'/fake',stage:'coder',model:routes.coder,budgetMs:2700000,startedAt:0}}));
 h.deps.isSettled=()=>settled;
 h.deps.runProgress=a=>a.id==='old'?{state:'failed',timedOut:true,model:a.model,attemptedModels:[a.model],durationMs:2700000,sessionFiles:[]}:null;
 await h.events.session_start({},h.ctx);const before=h.controller.state();
 for(let i=0;i<2;i++) {
  await h.commands.delivery.handler('resume',h.ctx);
  assert.match(h.messages.at(-1).content,/Waiting for the timed-out writer to close/);
  assert.deepEqual(h.controller.state(),before);
 }
 const response=await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);
 assert.match(response.content[0].text,/no replacement launched.*delivery_status/);
 assert.deepEqual(h.controller.state(),before);assert.deepEqual(notifications,[]);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 settled=true;await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');
 assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,1);
});

for(const entryPoint of ['startup','setup','resume'])test(`missing worker after reboot is retired through ${entryPoint} without replay`,async()=>{
 const h=harness();const active={id:'lost',dir:'/gone',stage:'coder',model:routes.coder,budgetMs:900000,startedAt:1000,continuation:true};
 h.entries.push(oldRunEntry('blocked',routes,{round:0,timeouts:timeoutPolicy(),active,coding:{0:{spentMs:2700000,continuations:1}}}));
 const evidence={kind:'host-reboot',bootedAt:100000,startedAt:1000,missingPath:'/gone/status.json'};
 if(entryPoint==='startup')h.deps.orphanedRunEvidence=()=>evidence;
 await h.events.session_start({},h.ctx);const planBefore=h.controller.state().plan;
 h.deps.orphanedRunEvidence=()=>evidence;
 if(entryPoint==='setup')await h.commands.delivery.handler('setup',h.ctx);
 if(entryPoint==='resume')await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);
 const state=h.controller.state();assert.equal(state.active,null);assert.equal(state.stage,'blocked');
 assert.equal(state.coding[0].spentMs,3600000);assert.equal(state.coding[0].continuations,1);
 assert.equal(state.failedRun.id,'lost');assert.deepEqual(state.failedRun.closureEvidence,evidence);
 assert.equal(state.failedRun.durationEstimated,true);assert.deepEqual(state.plan,planBefore);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);assert.equal(h.controller.state().coding[0].spentMs,3600000);
 await h.commands.delivery.handler('setup',h.ctx);assert.ok(h.messages.some(m=>m.content?.includes('Delivery setup saved')));
});
test('missing same-boot worker evidence does not release ownership or allow setup',async()=>{
 const h=harness();const active={id:'unknown',dir:'/gone',stage:'coder',model:routes.coder,budgetMs:900000,startedAt:1000};
 h.entries.push(oldRunEntry('blocked',routes,{active,timeouts:timeoutPolicy()}));
 await h.events.session_start({},h.ctx);const before=h.controller.state();let prompts=0;
 h.ctx.ui.select=async()=>{prompts++;};
 await h.commands.delivery.handler('setup',h.ctx);
 assert.deepEqual(h.controller.state(),before);assert.equal(prompts,0);assert.equal(h.calls.length,0);
});
test('reboot recovery never refunds a previously charged attempt',async()=>{
 const h=harness();h.entries.push(oldRunEntry('blocked',routes,{active:{id:'lost',dir:'/gone',stage:'coder',model:routes.coder,budgetMs:900000,startedAt:1000,charged:true},coding:{0:{spentMs:3600000,continuations:1}}}));
 h.deps.orphanedRunEvidence=()=>({kind:'host-reboot',bootedAt:100000,startedAt:1000});
 await h.events.session_start({},h.ctx);assert.equal(h.controller.state().coding[0].spentMs,3600000);assert.equal(h.controller.state().active,null);
});
test('interrupted coding round resumes within its budget instead of dead-ending',async()=>{
 const h=harness();h.entries.push(oldRunEntry('coder',routes,{round:1,timeouts:timeoutPolicy()}));
 h.ctx.ui.confirm=async()=>{throw new Error('Unexpected confirmation');};
 await h.events.session_start({},h.ctx);
 assert.match((await h.tools.delivery_status.execute()).details.nextAction.message,/delivery_resume/);
 const r=await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);await h.controller.settled();
 assert.match(r.content[0].text,/Recovery started/);
 assert.equal(h.controller.state().stage,'complete');
 assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,1);
});
test('changed routes close a failed child instead of wedging reconciliation',async()=>{
 const h=harness();h.config.routes={...routes,coder:routes.spec};
 h.entries.push(oldRunEntry('blocked',routes,{round:0,timeouts:timeoutPolicy(),active:{id:'failed-child',dir:'/fake',stage:'coder',model:routes.coder,budgetMs:2700000,startedAt:0}}));
 h.deps.isSettled=()=>true;
 h.deps.runProgress=a=>a.id==='failed-child'?{state:'failed',error:'Connection error.',model:routes.coder,attemptedModels:[routes.coder],durationMs:137000,sessionFiles:[]}:null;
 await h.events.session_start({},h.ctx);
 const r=await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);
 assert.match(r.content[0].text,/no execution restarted/i);
 const state=h.controller.state();
 assert.equal(state.active,null);assert.equal(state.failedRun.id,'failed-child');assert.equal(state.failedRun.error,'Connection error.');
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 assert.match((await h.tools.delivery_status.execute()).content[0].text,/delivery_plan/);
});
test('mid-run route change asks the live child to stop and reconciles after closure',async()=>{
 const h=harness();h.entries.push(oldRunEntry('blocked',routes,{round:0,timeouts:timeoutPolicy(),active:{id:'live-child',dir:'/fake',stage:'coder',model:routes.coder,budgetMs:2700000,startedAt:0}}));
 let failed=false;
 h.deps.isSettled=()=>true;
 h.deps.runProgress=a=>a.id==='live-child'?(failed?{state:'failed',error:'Connection error.',model:routes.coder,attemptedModels:[routes.coder],durationMs:1000,sessionFiles:[]}:{state:'running',model:routes.coder,attemptedModels:[routes.coder]}):null;
 await h.events.session_start({},h.ctx);
 h.config.routes={...routes,coder:routes.spec};
 await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);await h.controller.settled();
 assert.ok(h.calls.some(c=>c.method==='stop'&&c.params.id==='live-child'));
 assert.equal(h.controller.state().stage,'blocked');assert.equal(h.controller.state().active.id,'live-child');
 failed=true;
 const r=await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);
 assert.match(r.content[0].text,/no execution restarted/i);
 assert.equal(h.controller.state().active,null);assert.equal(h.controller.state().failedRun.id,'live-child');
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('configured command timeout bounds each verification command',async()=>{
 const h=harness();h.config.timeouts={commandMs:30*60000};
 const seen=[];
 h.deps.verifyCommand=async(_root,_command,_signal,timeoutMs)=>{seen.push(timeoutMs);return {code:0,output:'PASS'};};
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('plan',plan,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');
 assert.deepEqual(seen,[30*60000,30*60000]);
});
function blockedReviewHarness({stage='spec',round=1,summary='aggregate diff was truncated',active=null,snapshotChanged=false}={}) {
 const h=harness();
 const blockedPlan={...plan,security:false};
 const report={stage,task:0,round, snapshot:'hash',report:{status:'blocked',summary,findings:[]}};
 h.entries.push(oldRunEntry('blocked',routes,{plan:blockedPlan,round,reports:[report],active,reason:summary}));
 if(snapshotChanged)h.deps.fingerprint=()=> 'changed';
 return h;
}
test('resume retries a closed evidence-blocked spec reviewer without a coder or round increment',async()=>{
 const h=blockedReviewHarness();await h.events.session_start({},h.ctx);const before=h.controller.state();
 await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);await h.controller.settled();
 const reviewer=h.calls.find(c=>c.method==='spawn' && c.params.agent==='delivery-reviewer');assert.ok(reviewer);
 assert.equal(h.controller.state().round,before.round);assert.equal(h.controller.state().task,before.task);
 assert.ok(h.controller.state().reports.some(r=>r.report.status==='blocked'));
});

test('blocked review cannot resume while a child is active or snapshot changed',async()=>{
 for(const h of [blockedReviewHarness({active:{id:'live',dir:'/fake',stage:'spec',model:routes.spec}}),blockedReviewHarness({snapshotChanged:true})]) {
  await h.events.session_start({},h.ctx);
  await assert.rejects(h.tools.delivery_resume.execute('r',{},null,null,h.ctx),/active|snapshot/i);
 }
});

test('uncertain coder attestation charges the full reserved allowance without claiming non-launch',async()=>{
 const h=harness();h.entries.push(oldRunEntry('blocked',routes,{round:0,timeouts:timeoutPolicy(),active:{id:null,dir:null,stage:'coder',model:routes.coder,budgetMs:900000,startedAt:0},coding:{0:{spentMs:0,continuations:0}}}));
 await h.events.session_start({},h.ctx);
 const r=await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);
 assert.match(r.content[0].text,/launch and completion remain unknown/i);
 const state=h.controller.state();assert.equal(state.active,null);assert.equal(state.failedRun.launchUnknown,true);assert.equal(state.failedRun.notLaunched,undefined);
 assert.equal(state.failedRun.durationMs,900000);assert.equal(state.failedRun.durationEstimated,true);assert.equal(state.coding[0].spentMs,900000);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('legacy retained timeouts omit commandMs without creating a false budget change',async()=>{
 const h=harness(),legacy=timeoutPolicy();delete legacy.commandMs;
 h.entries.push(oldRunEntry('verification',routes,{round:0,timeouts:legacy}));
 h.ctx.ui.confirm=async()=>{throw new Error('Unexpected budget confirmation');};
 await h.events.session_start({},h.ctx);
 await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.equal(h.calls.filter(c=>c.method==='stop').length,0);
});

test('spec briefing scopes diff review to current task and never advertises parent-only delivery_diff',async()=>{
 let scoped;const h=harness({version:1,routes, evidence:{},repos:['/repo'],workingTreeEvidence:(_root,paths)=>{if(paths)scoped=paths;return 'exact current-task diff\\napp/a.rb\\naccepted prior-task changes are preserved baseline';}});
 const p={...plan,security:false,tasks:[{...plan.tasks[0],files:['app/a.rb','test/a_test.rb']}]};
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('p',p,null,null,h.ctx);await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 const reviewerCall=h.calls.find(c=>c.method==='spawn' && c.params?.agent==='delivery-reviewer');assert.ok(reviewerCall,JSON.stringify({calls:h.calls,state:h.controller.state(),messages:h.messages}));const briefing=reviewerCall.params.task;
 assert.deepEqual(scoped,['app/a.rb','test/a_test.rb']);assert.match(briefing,/exact current-task diff/i);assert.match(briefing,/app\/a\.rb/);
 assert.match(briefing,/accepted prior-task changes.*preserved baseline/i);assert.doesNotMatch(briefing,/continue delivery_diff/i);
});

test('quality briefing requires aggregate inspection through available read and bash tools',async()=>{
 const h=harness({version:1,routes, evidence:{},repos:['/repo'],workingTreeEvidence:()=> 'aggregate diff'});
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('p',{...plan,security:false},null,null,h.ctx);await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 const reviewerCall=h.calls.find(c=>c.method==='spawn' && c.params?.agent==='delivery-reviewer' && c.params.task.includes('Independent quality'));assert.ok(reviewerCall,JSON.stringify({calls:h.calls,state:h.controller.state(),messages:h.messages}));const briefing=reviewerCall.params.task;
 assert.match(briefing,/git diff --no-ext-diff/i);assert.match(briefing,/do not block solely because embedded evidence is truncated/i);
});
