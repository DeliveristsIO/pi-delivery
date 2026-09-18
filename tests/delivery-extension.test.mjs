import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,copyFileSync,rmSync,writeFileSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {registerDelivery} from '../extensions/delivery/extension.mjs';
import {assertCorrectionCandidate,branchState,correctionCandidate,createCorrectionBranch,fingerprint,firstFreeBranch} from '../extensions/delivery/io.mjs';
import {timeoutPolicy} from '../extensions/delivery/policy.mjs';
const routes={planning:'openai-codex/gpt-6-astra',coder:'custom/c',spec:'custom/r',quality:'custom/r',security:'custom/s'};
const plan={title:'Fixture',changeType:'feature',tasks:[{title:'Add',instructions:'Add one',files:['a'],checks:['node --test'],acceptance:['works']}],checks:['node --test'],risk:'low',security:true};
function harness(config={version:1,routes,evidence:{},repos:['/repo']}) {
 const configuredWorkingTreeEvidence=config.workingTreeEvidence;config={...config};delete config.workingTreeEvidence;
 const events={},commands={},tools={},entries=[],statuses=[],messages=[],calls=[];
 let model={provider:'openai-codex',id:'gpt-5.5'};
 const models=[...new Set(Object.values(routes))].map(s=>{const [provider,...id]=s.split('/');return {provider,id:id.join('/')};});
 const ctx={cwd:'/repo',hasUI:true,mode:'tui',isIdle:()=>true,isProjectTrusted:()=>true,modelRegistry:{getAll:()=>models,getAvailable:()=>models},get model(){return model;},sessionManager:{getSessionId:()=> 'session',getBranch:()=>entries},ui:{setStatus:(k,v)=>statuses.push(v),notify:()=>{},confirm:async()=>true,select:async(t,opts)=>opts[0],input:async()=> 'trial'}};
 const pi={on:(e,h)=>events[e]=h,registerCommand:(n,c)=>commands[n]=c,registerTool:t=>tools[t.name]=t,appendEntry:(customType,data)=>entries.push({type:'custom',customType,data:structuredClone(data)}),setModel:async m=>{model=m;return true;},sendMessage:m=>messages.push(m),sendUserMessage:m=>messages.push(m),getActiveTools:()=>['read','bash','edit','write','delivery_plan'],setActiveTools:()=>{},events:{}};
 const deps={configPath:()=>'/unused',loadConfig:()=>structuredClone(config),saveConfig:(_,c)=>Object.assign(config,c),repoRoot:()=>'/repo',fingerprint:()=> 'hash',scopedContentFingerprint:()=> 'hash',diff:()=> 'diff',reviewPatch:()=>'/fake/full.diff',validateCommands:()=>{},runProgress:()=>null,orphanedRunEvidence:()=>null,verifyCommand:async()=>({code:0,output:'PASS'}),rpc:async(_e,method,params)=>{calls.push({method,params});return method==='spawn'?{details:{runId:'r'+calls.length,asyncDir:'/fake'}}:{};},readOutcome:()=>({status:'approved',summary:'ok',findings:[]}),pollMs:1,retryDelayMs:0,child:false,
   lifecyclePreflight:()=>({branch:'main',defaultBranch:'main',head:'hash',clean:true,status:''}),firstFreeBranch:()=> 'feature/fixture',createDeliveryBranch:()=>({branch:'feature/fixture',defaultBranch:'main',head:'hash',clean:true,status:''}),branchState:()=>({branch:'feature/fixture',head:'hash',defaultBranch:'main',clean:true,status:''}),commitApprovedTask:()=>({hash:'hash',message:'feat: Add',branch:'feature/fixture',baseHead:'hash',paths:['a'],snapshot:'hash'}),assertApprovedPaths:()=>[],clearApprovedStagedPaths:()=>[]};
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
 const status=await h.tools.delivery_status.execute();assert.equal(status.details.nextAction.action,stage==='complete'?'complete':'decide');
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
 assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,2);
 assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-security').length,3);
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
 assert.deepEqual(current.calls.filter(c=>c.method==='spawn').map(c=>c.params.agent),['delivery-security','delivery-reviewer','delivery-security']);
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
 assert.equal(next.controller.state().stage,'complete');assert.deepEqual(next.calls.filter(c=>c.method==='spawn').map(c=>c.params.agent),['delivery-security','delivery-reviewer','delivery-security']);
});
test('final correction exhaustion stops without proposing another plan',async()=>{
 const h=harness({version:1,routes,corrections:{maxFixRounds:4},repos:['/repo']});
 h.entries.push(oldRunEntry('blocked',routes,{round:4,correctionPolicy:{maxFixRounds:4,source:'configured'},reason:'Fix/review round limit exhausted (4)',reports:[{stage:'coder',task:0,round:4,snapshot:'hash',runId:'old',report:{status:'approved',summary:'done',findings:[]}}]}));
 await h.events.session_start({},h.ctx);const before=h.controller.state();
 const status=await h.tools.delivery_status.execute();const text=status.content.map(c=>c.text||'').join('\\n');
 assert.equal(status.details.nextAction.action,'inspect');assert.match(text,/approved correction bound is exhausted/i);assert.doesNotMatch(text,/prepare a new corrective plan/i);
 assert.deepEqual(h.controller.state(),before);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});

test('legacy exhausted plan adopts configured limit and starts the next rework round',async()=>{
 const h=harness({version:1,routes,corrections:{maxFixRounds:4},repos:['/repo']});
 h.entries.push(oldRunEntry('blocked',routes,{round:2,reason:'Fix/review round limit exhausted (2)',correctionPolicy:undefined,reports:[
  {stage:'coder',task:0,round:1,snapshot:'hash',runId:'old-1',report:{status:'changes_requested',summary:'still needs work',findings:['one']}},
  {stage:'coder',task:0,round:2,snapshot:'hash',runId:'old-2',report:{status:'changes_requested',summary:'still needs work',findings:['two']}}
 ]}));
 await h.events.session_start({},h.ctx);const before=h.controller.state();
 await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);await h.controller.settled();
 const state=h.controller.state();
 assert.deepEqual(state.correctionPolicy,{maxFixRounds:4,source:'confirmed-extension'});assert.equal(state.round,3);assert.equal(before.round,2);
 assert.deepEqual(state.plan,before.plan);assert.deepEqual(state.routes,before.routes);assert.ok(state.reports.some(r=>r.runId==='old-2'));
 const coderReports=state.reports.filter(r=>r.stage==='coder');
 assert.equal(coderReports.at(-1).round,3);assert.ok(coderReports.filter(r=>r.round>0).length<=4);
});

test('confirmed correction extension cannot be adopted again',async()=>{
 const h=harness({version:1,routes,corrections:{maxFixRounds:6},repos:['/repo']});
 h.entries.push(oldRunEntry('blocked',routes,{round:4,reason:'Fix/review round limit exhausted (4)',correctionPolicy:{maxFixRounds:4,source:'confirmed-extension'}}));
 await h.events.session_start({},h.ctx);const before=h.controller.state();
 const status=await h.tools.delivery_status.execute();
 assert.equal(status.details.nextAction.action,'inspect');
 const result=await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);
 assert.match(result.content[0].text,/approved correction bound is exhausted|inspect/i);assert.deepEqual(h.controller.state(),before);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
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
 assert.deepEqual(executed,[['node first-test.mjs','checks'],['node later-test.mjs','checks'],['node release-test.mjs','final-checks']]);
 assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,4);
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
 assert.equal(next.controller.state().stage,'complete');assert.equal(next.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,1);assert.equal(next.controller.state().reports.filter(r=>r.stage==='coder').length,1);
});
test('final release failure still blocks after all tasks, without replaying coders',async()=>{
 const h=harness();const p={...plan,tasks:[{...plan.tasks[0],checks:['node task-test.mjs']},{...plan.tasks[0],checks:['node later-test.mjs']}],checks:['node release-test.mjs']};
 h.deps.verifyCommand=async(_r,command)=>({command,code:command.includes('release')?1:0,output:'failed release'});
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('plan',p,null,null,h.ctx);await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'blocked');assert.match(h.controller.state().reason,/Final release check failed|Verification failed/);assert.equal(h.controller.state().task,1);
 assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,4);
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
test('fresh implementation controller proposals require changeType',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 await assert.rejects(h.tools.delivery_plan.execute('id',{...plan,changeType:undefined},null,null,h.ctx),/changeType/i);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('fresh implementation binds balanced policy and explicit task sensitivity by default',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('id',{...plan,security:false,tasks:[{...plan.tasks[0],sensitive:true}]},null,null,h.ctx);
 const state=h.controller.state();assert.equal(state.plan.reviewPolicy,'balanced');assert.equal(state.plan.tasks[0].sensitive,true);assert.equal(state.gitPolicy.reviewPolicy,'balanced');
 assert.match(h.messages[0].content,/Review policy: balanced/);assert.match(h.messages[0].content,/Sensitive: yes/);
});
test('delivery status exposes the bound balanced and strict review policies',async()=>{
 for(const reviewPolicy of ['balanced','strict']) {
  const h=harness();await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('id',{...plan,reviewPolicy},null,null,h.ctx);
  const status=await h.tools.delivery_status.execute();assert.equal(status.details.reviewPolicy,reviewPolicy);assert.match(status.content[0].text,new RegExp(`reviewPolicy ${reviewPolicy}`));
 }
});
test('balanced optimizer source changes rerun task checks exactly once before combined review',async()=>{
 const h=harness();let optimized=false;const checked=[];
 h.deps.fingerprint=()=>optimized?'after':'hash';
 h.deps.readOutcome=a=>{if(a.stage==='optimizer')optimized=true;return {status:'approved',summary:'ok',findings:[]};};
 h.deps.verifyCommand=async(_root,command)=>{checked.push([command,h.controller.state().stage]);return {command,code:0,output:'PASS'};};
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('id',{...plan,security:false},null,null,h.ctx);await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.ok(h.controller.state().reports.some(r=>r.stage==='optimizer-checks'));assert.deepEqual(checked,[['node --test','checks'],['node --test','optimizer-checks'],['node --test','final-checks']]);
});
test('approved task content race before commit is rejected and re-reviewed without adoption',async()=>{
 const h=harness();let mutated=false,commitAttempts=0,adopted=0;
 h.deps.assertApprovedPaths=()=>['a'];
 h.deps.scopedContentFingerprint=()=>mutated?'raced-content':'accepted-content';
 h.deps.beforeCommit=()=>{if(!mutated)mutated=true;};
 h.deps.commitApprovedTask=(_root,options)=>{
  commitAttempts++;
  if(h.deps.scopedContentFingerprint()!==options.snapshot){const error=new Error('Reviewed task snapshot changed before delivery staging; commit authorization was invalidated.');error.commitAuthorizationInvalid=true;throw error;}
  adopted++;return {hash:'hash',message:'feat: Add',branch:'feature/fixture',baseHead:'hash',paths:['a'],snapshot:options.snapshot};
 };
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('id',{...plan,security:false},null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 const qualityReports=h.controller.state().reports.filter(r=>r.stage==='quality');
 assert.equal(h.controller.state().stage,'complete');assert.equal(qualityReports.length,2);
 assert.equal(commitAttempts,2);assert.equal(adopted,1);assert.equal(h.controller.state().gitPolicy.commits.length,1);
 assert.equal(qualityReports[0].report.reviewedContentSnapshot,'accepted-content');assert.equal(qualityReports[1].report.reviewedContentSnapshot,'raced-content');
});
test('verification-only task with no changed paths skips the commit stage and advances cleanly',async()=>{
 const h=harness();let commitAttempts=0;
 h.deps.commitApprovedTask=()=>{commitAttempts++;throw new Error('Cannot create an empty delivery commit.');};
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('id',plan,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 const after=h.controller.state();
 assert.equal(after.stage,'complete');
 assert.equal(after.reason,'');
 assert.equal(commitAttempts,0);
 assert.ok(h.calls.some(c=>c.method==='spawn'&&c.params.agent==='delivery-coder'));
 assert.equal(after.reports.some(r=>r.stage==='commit'&&r.report.committed===true),true);
 assert.equal(after.gitPolicy.commits.length,1);
 assert.equal(after.gitPolicy.commits[0].hash,after.gitPolicy.expectedHead);
 assert.deepEqual(after.gitPolicy.commits[0].paths,[]);
 assert.equal(after.gitPolicy.expectedHead,h.deps.branchState().head);
});
test('explicit implementation intent displays, journals and starts the unchanged proposal immediately',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 const userTurn='Implement the fixture now';
 await h.events.input({text:userTurn,source:'interactive'},h.ctx);
 const response=await h.tools.delivery_plan.execute('id',{...plan,executionIntent:{kind:'explicit-implementation',userTurn}},null,null,h.ctx);
 assert.match(response.content[0].text,/started/i);assert.ok(h.messages.some(message=>message.customType==='delivery' && /Fixture/.test(message.content)));
 assert.ok(h.entries.some(entry=>entry.data.executionAuthority?.userTurn===userTurn));
 await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.ok(h.calls.some(c=>c.params?.agent==='delivery-coder'));
});
test('planning-only, ambiguous, rejecting, deferring, questioning and absent intent do not launch',async()=>{
 for(const [text,start] of [['Plan this change',false],['Maybe change this',undefined],['Do not implement this',undefined],['Wait until later',undefined],['Could we implement this?',undefined],['',undefined]]) {
  const h=harness();await h.events.session_start({},h.ctx);
  if(text)await h.events.input({text,source:'interactive'},h.ctx);
  const response=await h.tools.delivery_plan.execute('id',{...plan,...(start===false?{start:false}:{})},null,null,h.ctx);
  assert.match(response.content[0].text,/Plan ready/i);assert.equal(h.controller.state().stage,'awaiting-approval');assert.equal(h.calls.filter(c=>c.method==='spawn').length,0,text||'absent');
 }
});
test('implementation attestation must match the exact real-user turn and start false always wins',async()=>{
 for(const candidate of [
  {text:'Implement the fixture',intent:{kind:'explicit-implementation',userTurn:'an older request'}},
  {text:'Implement the fixture',intent:{kind:'explicit-implementation',userTurn:'Implement the fixture'},start:false},
  {text:'Implement the fixture',intent:undefined}
 ]) {
  const h=harness();await h.events.session_start({},h.ctx);await h.events.input({text:candidate.text,source:'interactive'},h.ctx);
  const response=await h.tools.delivery_plan.execute('id',{...plan,...(candidate.intent?{executionIntent:candidate.intent}:{}),...(candidate.start===false?{start:false}:{})},null,null,h.ctx);
  assert.match(response.content[0].text,/Plan ready/i);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 }
});
for(const changed of ['workspace','routes','timeouts','corrections'])test(`explicit intent is invalidated when ${changed} changes before launch`,async()=>{
 const h=harness({version:1,routes:structuredClone(routes),corrections:{maxFixRounds:4},repos:['/repo']});await h.events.session_start({},h.ctx);
 const userTurn='Implement the fixture';await h.events.input({text:userTurn,source:'interactive'},h.ctx);
 const rpc=h.deps.rpc;h.deps.rpc=async(...args)=>{if(args[1]==='ping') {
  if(changed==='workspace')h.deps.fingerprint=()=> 'changed';
  if(changed==='routes')h.config.routes.coder=routes.spec;
  if(changed==='timeouts')h.config.timeouts={coderMs:30*60000};
  if(changed==='corrections')h.config.corrections={maxFixRounds:3};
 } return rpc(...args);};
 await assert.rejects(h.tools.delivery_plan.execute('id',{...plan,executionIntent:{kind:'explicit-implementation',userTurn}},null,null,h.ctx),/changed|policy/i);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('a new rejecting user turn during pre-launch ping invalidates explicit intent',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 const userTurn='Implement the fixture';await h.events.input({text:userTurn,source:'interactive'},h.ctx);
 let releasePing,atPing;const pingReached=new Promise(resolve=>{atPing=resolve;});
 const rpc=h.deps.rpc;h.deps.rpc=async(...args)=>{
  if(args[1]==='ping'){atPing();await new Promise(resolve=>{releasePing=resolve;});}
  return rpc(...args);
 };
 const launching=h.tools.delivery_plan.execute('id',{...plan,executionIntent:{kind:'explicit-implementation',userTurn}},null,null,h.ctx);
 await pingReached;await h.events.input({text:'Wait, do not implement this',source:'interactive'},h.ctx);releasePing();
 await assert.rejects(launching,/authority|user turn|intent/i);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('one user-turn authority cannot be rebound to a materially changed second candidate',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);const userTurn='Implement the fixture';await h.events.input({text:userTurn,source:'interactive'},h.ctx);
 const rpc=h.deps.rpc;let first=true;h.deps.rpc=async(...args)=>{if(args[1]==='ping'&&first){first=false;h.deps.fingerprint=()=> 'changed';}return rpc(...args);};
 await assert.rejects(h.tools.delivery_plan.execute('first',{...plan,executionIntent:{kind:'explicit-implementation',userTurn}},null,null,h.ctx),/changed/i);
 h.deps.fingerprint=()=> 'hash';
 const response=await h.tools.delivery_plan.execute('second',{...plan,title:'Different candidate',executionIntent:{kind:'explicit-implementation',userTurn}},null,null,h.ctx);
 assert.match(response.content[0].text,/not started/i);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('proposal alone cannot launch; approval runs all stages and verification',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('id',plan,null,null,h.ctx);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 await h.commands.delivery.handler('approve',h.ctx);
 await h.controller.settled();
 assert.deepEqual(h.calls.filter(c=>c.method==='spawn').map(c=>c.params.agent),['delivery-coder','delivery-coder','delivery-reviewer','delivery-security','delivery-reviewer','delivery-security']);
 assert.deepEqual(h.calls.filter(c=>c.method==='spawn').map(c=>c.params.model),[routes.coder,routes.coder,routes.quality,routes.security,routes.quality,routes.security]);
 assert.equal(h.controller.state().stage,'complete');
 assert.equal(h.controller.state().gitPolicy.commits.length,1);assert.match((await h.tools.delivery_status.execute()).content[0].text,/Git lifecycle:.*base HEAD|Git commit:/);
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
test('legacy commit resume without a review fingerprint returns through review before committing',async()=>{
 const h=harness();let commitAttempts=0;
 h.entries.push({type:'custom',customType:'delivery-mode-v1',data:{version:1,enabled:true,stage:'commit',task:0,round:0,plan,routes,snapshot:'hash',active:null,reports:[],reason:'',workspace:'/repo',owner:'session',gitPolicy:{changeType:'feature',reviewPolicy:'balanced',baseBranch:'main',defaultBranch:'main',workingBranch:'feature/fixture',baseHead:'hash',expectedHead:'hash',createBranch:false,branchCreated:true,commits:[]}}});
 h.deps.commitApprovedTask=()=>{commitAttempts++;assert.ok(h.controller.state().reports.some(r=>r.stage==='quality'));return {hash:'hash',message:'feat: Add',branch:'feature/fixture',baseHead:'hash',paths:['a'],snapshot:'hash'};};
 h.deps.assertApprovedPaths=()=>['a'];
 await h.events.session_start({},h.ctx);await h.commands.delivery.handler('resume',h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.equal(commitAttempts,1);assert.equal(h.controller.state().reports.filter(r=>r.stage==='quality').length,1);
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
 assert.equal(selections.length,10);
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
 await h.tools.delivery_plan.execute('id',{...plan,mode:'review',changeType:undefined,commits:2,tasks:[{...plan.tasks[0],checks:undefined}]},null,null,h.ctx);
 assert.equal(h.controller.state().plan.mode,'review');assert.deepEqual(h.controller.state().plan.reviewRange,range);
 await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.ok(checked>0);
 assert.deepEqual(h.calls.filter(c=>c.method==='spawn').map(c=>c.params.agent),['delivery-reviewer','delivery-reviewer','delivery-security']);
 assert.ok(h.calls.filter(c=>c.method==='spawn').every(c=>c.params.task.includes('Concise check evidence') && c.params.task.includes('command/code/signal/terminated') && c.params.task.includes('committed diff')));
});
test('committed multi-task spec evidence is path-scoped while aggregate reviewers inspect the range',async()=>{
 const h=harness();const range={base:'a'.repeat(40),head:'b'.repeat(40)},diffCalls=[];
 h.deps.revisionRange=()=>range;h.deps.assertCommittedWorkspace=()=>{};
 h.deps.diff=(_root,r,_limit,_offset,paths)=>{
  diffCalls.push({range:r,paths});
  return 'COMMITTED RANGE\n'+('large committed evidence '.repeat(2200))+'\n[Embedded diff truncated; inspect remaining approved files with repository-local git/read tools.]';
 };
 await h.events.session_start({},h.ctx);await h.commands.delivery.handler('validate last 2 commits',h.ctx);
 const committedPlan={...plan,mode:'review',changeType:undefined,commits:2,security:false,tasks:[
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
 await h.tools.delivery_plan.execute('id',{...plan,mode:'review',changeType:undefined,tasks:[{...plan.tasks[0],checks:undefined}]},null,null,h.ctx);
 await h.controller.settled();
 assert.equal(h.controller.state().stage,'blocked');assert.match(h.controller.state().reason,/failing test/);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('ordinary user review request executes without an approval command',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 await h.events.input({text:'Please validate these changes without fixing anything',source:'interactive'},h.ctx);
 await h.tools.delivery_plan.execute('id',{...plan,mode:'review',changeType:undefined,tasks:[{...plan.tasks[0],checks:undefined}]},null,null,h.ctx);await h.controller.settled();
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
  await h.tools.delivery_plan.execute('plan',{...plan,mode,changeType:mode==='review'?undefined:plan.changeType,checks:['first','second'],tasks:[{...plan.tasks[0],checks:mode==='review'?undefined:['first','second']}]},null,null,h.ctx);
  await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
  assert.deepEqual(ran,mode==='implementation'?['first','second','first','second']:['first','second','first','second']);assert.equal(h.controller.state().stage,'complete');
 }
 const h=harness(),ran=[];
 h.deps.verifyCommand=async(_cwd,command)=>{ran.push(command);return {command,code:1,output:'FAIL'};};
 await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('plan',{...plan,mode:'review',changeType:undefined,checks:['first','second'],tasks:[{...plan.tasks[0],checks:undefined}]},null,null,h.ctx);
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
 assert.equal(coders.length,3);assert.equal(coders[0].params.timeoutMs,45*60000);assert.equal(coders[1].params.timeoutMs,15*60000);
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
for (const hasUI of [true, false]) test(`plain supervisor replies require confirmation or are blocked (${hasUI ? 'UI' : 'no UI'})`,async()=>{
 const h=harness();h.entries.push(oldRunEntry('coder',routes,{active:{id:'owned',dir:'/fake',stage:'coder',model:routes.coder,agent:'delivery-coder',childIndex:0}}),supervisorRequestEntry());
 h.ctx.hasUI=hasUI;
 h.ctx.ui.confirm=async()=>hasUI;
 await h.events.session_start({},h.ctx);
 const response=await h.events.tool_call({toolName:'subagent_supervisor',input:{action:'reply',replyTo:'request-1',message:'clarification'}},h.ctx);
 if(hasUI)assert.equal(response,undefined);else {assert.equal(response.block,true);assert.match(response.reason,/envelope/);}
});

test('active worker does not authorize a same-session supervisor reply for another child',async()=>{
 const h=harness();h.entries.push(oldRunEntry('coder',routes,{active:{id:'owned',dir:'/fake',stage:'coder',model:routes.coder,agent:'delivery-coder',childIndex:0}}),supervisorRequestEntry('other-run','worker',1,'other-request'));
 await h.events.session_start({},h.ctx);
 const response=await h.events.tool_call({toolName:'subagent_supervisor',input:{action:'reply',replyTo:'other-request',message:'clarification'}},h.ctx);
 assert.equal(response.block,true);assert.match(response.reason,/owned worker/);
});

test('strict supervisor envelope restores owned worker identity',async()=>{
 const h=harness();h.entries.push(oldRunEntry('coder',routes,{active:{id:'owned',dir:'/fake',stage:'coder',model:routes.coder}}),supervisorRequestEntry());
 await h.events.session_start({},h.ctx);
 h.ctx.hasUI=false;
 const response=await h.events.tool_call({toolName:'subagent_supervisor',input:{action:'reply',replyTo:'request-1',message:JSON.stringify({kind:'clarification',content:'clarification',nonAuthoritative:true})}},h.ctx);
 assert.equal(response,undefined);
 assert.equal(h.controller.state().active.agent,'delivery-coder');
 assert.equal(h.controller.state().active.childIndex,0);
});
test('mixed supervisor payload fields are rejected even for an owned child',async()=>{
 const h=harness();h.entries.push(oldRunEntry('coder',routes,{active:{id:'owned',dir:'/fake',stage:'coder',model:routes.coder,agent:'delivery-coder',childIndex:0}}),supervisorRequestEntry());
 await h.events.session_start({},h.ctx);h.ctx.hasUI=true;h.ctx.ui.confirm=async()=>{throw new Error('must not confirm mixed payload');};
 const message=JSON.stringify({kind:'evidence',content:'safe',nonAuthoritative:true});
 for(const input of [{action:'reply',replyTo:'request-1',message,envelope:{}},{action:'reply',replyTo:'request-1',message,reply:{}},{action:'reply',replyTo:'request-1',message,unknown:true}]) {
  const response=await h.events.tool_call({toolName:'subagent_supervisor',input},h.ctx);assert.equal(response.block,true);
 }
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
 assert.deepEqual(h.calls.filter(c=>c.method==='spawn').map(c=>c.params.model),[routes.coder,routes.coder,routes.quality,routes.security,routes.quality,routes.security]);
 assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,2);
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
test('attached recovery review finding restores the complete retained task and finishes remaining work without coder replay',async()=>{
 const tasks=Array.from({length:5},(_,i)=>({title:`Task ${i+1}`,instructions:`Implement ${i+1}`,files:[`task-${i+1}.js`],checks:[`check-${i+1}`],acceptance:[`task ${i+1} works`],sensitive:false}));
 const implementation={title:'Quento',mode:'implementation',changeType:'feature',reviewPolicy:'balanced',tasks,checks:['final-gate'],risk:'low',security:false};
 const retained=oldRunEntry('blocked',routes,{plan:implementation,task:0,round:0,reason:'Child quality-failed failed; attempt closed. review infrastructure failed',failedRun:{id:'quality-failed',state:'failed',stage:'quality',task:0,round:0,model:routes.quality,error:'review infrastructure failed'},correctionPolicy:{maxFixRounds:4,source:'configured'},coding:{0:{spentMs:1234,continuations:0}},connectionRetries:{'0:0:quality':{count:1,spentMs:50}},checks:[{command:'check-1',code:0}],reports:[
  {stage:'coder',task:0,round:0,snapshot:'hash',runId:'task-1-coder',report:{status:'approved',summary:'Task 1 implemented',findings:[]}},
  {stage:'checks',task:0,round:0,snapshot:'hash',report:{status:'approved',summary:'checks pass',findings:[]}}
 ],gitPolicy:{changeType:'feature',reviewPolicy:'balanced',baseBranch:'main',defaultBranch:'main',workingBranch:'feature/quento',baseHead:'hash',expectedHead:'hash',createBranch:false,branchCreated:true,commits:[]}});
 retained.data.snapshot='retained-hash';retained.data.reports=retained.data.reports.map(entry=>({...entry,snapshot:'retained-hash'}));
 const h=harness({version:1,routes,corrections:{maxFixRounds:4},repos:['/repo']});h.entries.push(retained);h.deps.fingerprint=(_root,options)=>options.scope.length===5?'retained-hash':'review-hash';h.deps.branchState=()=>({branch:'feature/quento',head:'hash',defaultBranch:'main',clean:false,status:' M task-1.js'});
 let outcomes=0;h.deps.readOutcome=()=>++outcomes===1
  ? {status:'changes_requested',summary:'Task 1 defect',findings:['high task-1.js:1 incorrect answer; fix calculation']}
  : {status:'approved',summary:'ok',findings:[]};
 await h.events.session_start({},h.ctx);await h.events.input({text:'Run a recovery review of the retained Task 1 work',source:'interactive'},h.ctx);
 const review={title:'Quento Task 1 recovery review',mode:'review',reviewAttachment:{kind:'retained-recovery'},tasks:[{title:'Review retained Task 1',instructions:'Review the retained implementation only',files:['task-1.js'],acceptance:['Task 1 is correct']}],checks:[],risk:'low',security:false};
 await h.tools.delivery_plan.execute('review',review,null,null,h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'blocked');assert.equal(h.calls.filter(call=>call.params?.agent==='delivery-coder').length,0,'read-only finding grants no corrective writer');
 const userTurn='Implement the explicitly reviewed Task 1 correction';await h.events.input({text:userTurn,source:'interactive'},h.ctx);
 const candidate={version:1,branch:'feature/quento',head:'hash',defaultBranch:'main',clean:false,status:' M task-1.js',inventory:['task-1.js'],staged:[],fingerprint:'retained-hash'};h.deps.correctionCandidate=()=>candidate;h.deps.assertCorrectionCandidate=()=>candidate;
 await h.tools.delivery_plan.execute('correct',{title:'Correct retained Task 1',mode:'implementation',changeType:'bug',reviewPolicy:'balanced',executionIntent:{kind:'explicit-implementation',userTurn},correctionAdoption:{kind:'retained-candidate',userTurn},tasks:[{title:'Correct Task 1',instructions:'Correct the retained finding',files:['task-1.js'],checks:['check-1'],acceptance:['Task 1 is correct'],sensitive:false}],checks:['final-gate'],risk:'low',security:false},null,null,h.ctx);await h.controller.settled();
 const state=h.controller.state(),spawns=h.calls.filter(call=>call.method==='spawn');
 assert.equal(state.stage,'complete',JSON.stringify({reason:state.reason,task:state.task,round:state.round,active:state.active,retained:Boolean(state.retainedRun)}));assert.equal(state.plan.title,'Quento');assert.equal(state.plan.tasks.length,5);assert.deepEqual(state.plan.checks,['final-gate']);
 assert.ok(state.coding[0].spentMs>=1234);assert.equal(state.retainedRun.state.coding[0].spentMs,1234);assert.deepEqual(state.connectionRetries['0:0:quality'],{count:1,spentMs:50});assert.equal(state.correctionPolicy.maxFixRounds,4);
 assert.equal(state.gitPolicy.workingBranch,'feature/quento');assert.equal(state.round,0);assert.ok(state.reports.some(entry=>entry.reviewAttachment?.status==='changes_requested'));
 assert.equal(spawns.filter(call=>call.params.agent==='delivery-coder' && /Implement only this approved task/.test(call.params.task)).length,5);
 assert.equal(spawns[0].params.agent,'delivery-reviewer');assert.equal(spawns[1].params.agent,'delivery-coder');assert.match(spawns[1].params.task,/Task 1 defect/);
 assert.ok(spawns.some(call=>call.params.task.includes('Task 5')));assert.ok(state.reports.some(entry=>entry.stage==='final-checks'));
});
test('attached recovery review approval resumes after the failed review without replaying accepted coding',async()=>{
 const tasks=[1,2].map(i=>({title:`Task ${i}`,instructions:`Implement ${i}`,files:[`task-${i}.js`],checks:[`check-${i}`],acceptance:[`task ${i} works`],sensitive:false}));
 const implementation={title:'Retained approval',mode:'implementation',changeType:'feature',reviewPolicy:'balanced',tasks,checks:['final-gate'],risk:'low',security:false};
 const h=harness({version:1,routes,corrections:{maxFixRounds:4},repos:['/repo']});
 h.entries.push(oldRunEntry('blocked',routes,{plan:implementation,task:0,round:0,reason:'Child quality-failed failed; attempt closed. review infrastructure failed',failedRun:{id:'quality-failed',state:'failed',stage:'quality',task:0,round:0,model:routes.quality,error:'review infrastructure failed'},correctionPolicy:{maxFixRounds:4,source:'configured'},coding:{0:{spentMs:500,continuations:0}},reports:[{stage:'coder',task:0,round:0,snapshot:'hash',runId:'accepted-coder',report:{status:'approved',summary:'implemented',findings:[]}}],gitPolicy:{changeType:'feature',reviewPolicy:'balanced',baseBranch:'main',defaultBranch:'main',workingBranch:'feature/retained',baseHead:'hash',expectedHead:'hash',createBranch:false,branchCreated:true,commits:[]}}));
 h.deps.branchState=()=>({branch:'feature/retained',head:'hash',defaultBranch:'main',clean:false,status:' M task-1.js'});
 await h.events.session_start({},h.ctx);await h.events.input({text:'Approve the retained work through a recovery review',source:'interactive'},h.ctx);
 await h.tools.delivery_plan.execute('review',{title:'Recovery',mode:'review',reviewAttachment:{kind:'retained-recovery'},tasks:[{title:'Review Task 1',instructions:'Review only',files:['task-1.js'],acceptance:['correct']}],checks:[],risk:'low',security:false},null,null,h.ctx);await h.controller.settled();
 const implementationCoders=h.calls.filter(call=>call.method==='spawn' && call.params.agent==='delivery-coder' && /Implement only this approved task/.test(call.params.task));
 assert.equal(h.controller.state().stage,'complete');assert.equal(implementationCoders.length,1);assert.match(implementationCoders[0].params.task,/Task 2/);assert.equal(h.controller.state().coding[0].spentMs,500);
 assert.equal(h.controller.state().failedRun,undefined,'resolved recovery failure is consumed');
});
test('recovery attachment rejects a stale failed review after a later round or blocker',async()=>{
 const recovery={title:'Stale recovery',mode:'review',reviewAttachment:{kind:'retained-recovery'},tasks:[{title:'Review',instructions:'Review only',files:['a'],acceptance:['correct']}],checks:[],risk:'low',security:false};
 for(const extra of [
  {round:2,reason:'Child old failed; attempt closed. failed',correctionPolicy:{maxFixRounds:4,source:'default'},failedRun:{id:'old',state:'failed',stage:'quality',task:0,round:1,model:routes.quality,error:'failed'}},
  {round:1,reason:'Fix/review round limit exhausted (4) after old',correctionPolicy:{maxFixRounds:4,source:'default'},failedRun:{id:'old',state:'failed',stage:'quality',task:0,round:1,model:routes.quality,error:'failed'}},
  {round:1,reason:'HEAD changed after old',correctionPolicy:{maxFixRounds:4,source:'default'},failedRun:{id:'old',state:'failed',stage:'quality',task:0,round:1,model:routes.quality,error:'failed'}},
  {round:1,reason:'Child failed',correctionPolicy:{maxFixRounds:4,source:'default'},failedRun:{id:'old',state:'failed',stage:'quality',task:0,round:1,model:routes.quality,error:'failed'}}
 ]) {
  const h=harness();h.entries.push(oldRunEntry('blocked',routes,extra));await h.events.session_start({},h.ctx);await h.events.input({text:'review retained work',source:'interactive'},h.ctx);
  await assert.rejects(h.tools.delivery_plan.execute('review',recovery,null,null,h.ctx),/matching failed implementation review/i);
  assert.equal(h.calls.filter(call=>call.method==='spawn').length,0);
 }
});
test('strict optimizer recovery resumes at specification review before quality without coder replay',async()=>{
 const task={title:'Retained strict task',instructions:'Already implemented',files:['task-1.js'],checks:['check-1'],acceptance:['strict behavior works'],sensitive:false};
 const implementation={title:'Strict optimizer recovery',mode:'implementation',changeType:'feature',reviewPolicy:'strict',tasks:[task],checks:['final-gate'],risk:'low',security:false};
 const h=harness({version:1,routes,corrections:{maxFixRounds:4},repos:['/repo']});
 h.entries.push(oldRunEntry('blocked',routes,{plan:implementation,task:0,round:0,reason:'Child optimizer-failed failed; attempt closed. optimizer infrastructure failed',failedRun:{id:'optimizer-failed',state:'failed',stage:'optimizer',task:0,round:0,model:routes.coder,error:'optimizer infrastructure failed'},correctionPolicy:{maxFixRounds:4,source:'configured'},coding:{0:{spentMs:500,continuations:0}},reports:[
  {stage:'coder',task:0,round:0,snapshot:'hash',runId:'accepted-coder',report:{status:'approved',summary:'implemented',findings:[]}},
  {stage:'checks',task:0,round:0,snapshot:'hash',report:{status:'approved',summary:'checks pass',findings:[]}}
 ],gitPolicy:{changeType:'feature',reviewPolicy:'strict',baseBranch:'main',defaultBranch:'main',workingBranch:'feature/retained',baseHead:'hash',expectedHead:'hash',createBranch:false,branchCreated:true,commits:[]}}));
 h.deps.branchState=()=>({branch:'feature/retained',head:'hash',defaultBranch:'main',clean:false,status:' M task-1.js'});
 await h.events.session_start({},h.ctx);await h.events.input({text:'Run the strict retained recovery review',source:'interactive'},h.ctx);
 await h.tools.delivery_plan.execute('review',{title:'Strict recovery',mode:'review',reviewAttachment:{kind:'retained-recovery'},tasks:[{title:'Review retained task',instructions:'Review only',files:['task-1.js'],acceptance:['correct']}],checks:[],risk:'low',security:false},null,null,h.ctx);await h.controller.settled();
 const spawns=h.calls.filter(call=>call.method==='spawn');
 assert.equal(h.controller.state().stage,'complete');assert.equal(spawns.filter(call=>call.params.agent==='delivery-coder').length,0);
 assert.match(spawns[0].params.task,/Independent spec review/);assert.match(spawns[1].params.task,/Independent quality review/);
 assert.deepEqual(h.controller.state().reports.filter(report=>report.task===0 && ['spec','quality'].includes(report.stage)).map(report=>report.stage).slice(-2),['spec','quality']);
});
test('attached recovery reviewer uses the retained implementation contract and balanced stage semantics',async()=>{
 const tasks=[
  {title:'Accepted Task 1',instructions:'Already implemented',files:['task-1.js'],checks:['check-1'],acceptance:['first retained requirement'],sensitive:false},
  {title:'Retained Task 2',instructions:'Verify the original retained behavior',files:['task-2.js'],checks:['retained-task-check'],acceptance:['original retained acceptance sentinel'],sensitive:false}
 ];
 const implementation={title:'Original retained contract',mode:'implementation',changeType:'feature',reviewPolicy:'balanced',tasks,checks:['retained-final-gate'],risk:'low',security:false};
 const retainedReports=[
  {stage:'quality',task:0,round:0,snapshot:'hash',runId:'accepted-task-1',report:{status:'approved',summary:'Task 1 accepted',findings:[]}},
  {stage:'checks',task:1,round:1,snapshot:'hash',report:{status:'approved',summary:'retained checks pass',findings:[]},checks:[{command:'retained-task-check',code:0}]}
 ];
 const h=harness({version:1,routes,corrections:{maxFixRounds:4},repos:['/repo']});
 h.entries.push(oldRunEntry('blocked',routes,{plan:implementation,task:1,round:1,reason:'Child optimizer-failed failed; attempt closed. optimizer infrastructure failed',feedback:'retained actionable feedback sentinel',checks:[{command:'retained-task-check',code:0}],reports:retainedReports,failedRun:{id:'optimizer-failed',state:'failed',stage:'optimizer',task:1,round:1,model:routes.coder,error:'optimizer infrastructure failed'},correctionPolicy:{maxFixRounds:4,source:'configured'},gitPolicy:{changeType:'feature',reviewPolicy:'balanced',baseBranch:'main',defaultBranch:'main',workingBranch:'feature/retained',baseHead:'hash',expectedHead:'hash',createBranch:false,branchCreated:true,commits:[]}}));
 h.deps.fingerprint=(_root,options)=>options.scope.includes('task-2.js')?'hash':'other';
 h.deps.branchState=()=>({branch:'feature/retained',head:'hash',defaultBranch:'main',clean:false,status:' M task-2.js'});
 await h.events.session_start({},h.ctx);await h.events.input({text:'Run the retained Task 2 recovery review',source:'interactive'},h.ctx);
 const recovery={title:'Watered-down replacement',mode:'review',reviewAttachment:{kind:'retained-recovery'},tasks:[{title:'Shallow review',instructions:'Ignore original details',files:['task-2.js'],acceptance:['watered down acceptance sentinel']}],checks:[],risk:'low',security:false};
 await h.tools.delivery_plan.execute('review',recovery,null,null,h.ctx);await h.controller.settled();
 const prompt=h.calls.find(call=>call.method==='spawn').params.task;
 assert.match(prompt,/Read-only review/);assert.match(prompt,/combined specification and code-quality/);
 assert.match(prompt,/Original retained contract/);assert.match(prompt,/Retained Task 2/);assert.match(prompt,/original retained acceptance sentinel/);
 assert.match(prompt,/retained-task-check/);assert.match(prompt,/retained-final-gate/);assert.match(prompt,/Accepted Task 1/);assert.match(prompt,/retained actionable feedback sentinel/);
 assert.doesNotMatch(prompt,/watered down acceptance sentinel|Ignore original details/);
});
test('recovery review attachment requires the exact failed task scope',async()=>{
 const retainedPlan={...plan,tasks:[{...plan.tasks[0],files:['a','b']} ]};
 const h=harness();h.entries.push(oldRunEntry('blocked',routes,{plan:retainedPlan,reason:'Child review-failed failed; attempt closed. infrastructure failed',correctionPolicy:{maxFixRounds:4,source:'default'},failedRun:{id:'review-failed',state:'failed',stage:'quality',task:0,round:0,model:routes.quality,error:'infrastructure failed'}}));
 await h.events.session_start({},h.ctx);await h.events.input({text:'Review only a subset',source:'interactive'},h.ctx);
 const subset={title:'Subset recovery',mode:'review',reviewAttachment:{kind:'retained-recovery'},tasks:[{title:'Review',instructions:'Review only',files:['a'],acceptance:['correct']}],checks:[],risk:'low',security:false};
 await assert.rejects(h.tools.delivery_plan.execute('review',subset,null,null,h.ctx),/exact|scope|matching/i);
 assert.equal(h.calls.filter(call=>call.method==='spawn').length,0);assert.equal(h.controller.state().plan.title,'Fixture');
});
test('aggregate recovery review attachment requires the complete implementation scope',async()=>{
 const retainedPlan={...plan,tasks:[
  {...plan.tasks[0],title:'One',files:['a']},
  {...plan.tasks[0],title:'Two',files:['b']}
 ]};
 const h=harness();h.entries.push(oldRunEntry('blocked',routes,{plan:retainedPlan,task:1,reason:'Child aggregate-failed failed; attempt closed. infrastructure failed',correctionPolicy:{maxFixRounds:4,source:'default'},failedRun:{id:'aggregate-failed',state:'failed',stage:'aggregate-quality',task:1,round:0,model:routes.quality,error:'infrastructure failed'}}));
 await h.events.session_start({},h.ctx);await h.events.input({text:'Review only the last task',source:'interactive'},h.ctx);
 const subset={title:'Aggregate subset',mode:'review',reviewAttachment:{kind:'retained-recovery'},tasks:[{title:'Review',instructions:'Review only',files:['b'],acceptance:['correct']}],checks:[],risk:'low',security:false};
 await assert.rejects(h.tools.delivery_plan.execute('review',subset,null,null,h.ctx),/exact|scope|matching/i);
 assert.equal(h.calls.filter(call=>call.method==='spawn').length,0);assert.equal(h.controller.state().plan.title,'Fixture');
});
test('aggregate recovery requires one full-scope report rather than split task reviews',async()=>{
 const retainedPlan={...plan,tasks:[
  {...plan.tasks[0],title:'One',files:['a']},
  {...plan.tasks[0],title:'Two',files:['b']}
 ]};
 const h=harness();h.entries.push(oldRunEntry('blocked',routes,{plan:retainedPlan,task:1,reason:'Child aggregate-failed failed; attempt closed. infrastructure failed',correctionPolicy:{maxFixRounds:4,source:'default'},failedRun:{id:'aggregate-failed',state:'failed',stage:'aggregate-quality',task:1,round:0,model:routes.quality,error:'infrastructure failed'}}));
 await h.events.session_start({},h.ctx);await h.events.input({text:'Run a full aggregate recovery review',source:'interactive'},h.ctx);
 const split={title:'Split aggregate recovery',mode:'review',reviewAttachment:{kind:'retained-recovery'},tasks:[
  {title:'Review A',instructions:'Review A',files:['a'],acceptance:['correct']},
  {title:'Review B',instructions:'Review B',files:['b'],acceptance:['correct']}
 ],checks:[],risk:'low',security:false};
 await assert.rejects(h.tools.delivery_plan.execute('review',split,null,null,h.ctx),/aggregate|one|single|matching/i);
 assert.equal(h.calls.filter(call=>call.method==='spawn').length,0);assert.equal(h.controller.state().plan.title,'Fixture');
});
test('security recovery requires security policy and resumes only from a security-route report',async()=>{
 const retainedPlan={...plan,mode:'implementation',security:true,tasks:[{...plan.tasks[0],sensitive:true}]};
 const retained=oldRunEntry('blocked',routes,{plan:retainedPlan,round:0,reason:'Child security-failed failed; attempt closed. infrastructure failed',correctionPolicy:{maxFixRounds:4,source:'default'},failedRun:{id:'security-failed',state:'failed',stage:'security',task:0,round:0,model:routes.security,error:'infrastructure failed'}});
 const h=harness();h.entries.push(retained);let outcome=0;h.deps.readOutcome=()=>++outcome===1
  ? {status:'changes_requested',summary:'security defect',findings:['high a:1 unsafe behavior; enforce validation']}
  : {status:'approved',summary:'ok',findings:[]};
 await h.events.session_start({},h.ctx);await h.events.input({text:'Run the retained security recovery review',source:'interactive'},h.ctx);
 const recovery={title:'Security recovery',mode:'review',reviewAttachment:{kind:'retained-recovery'},tasks:[{title:'Review security',instructions:'Review security only',files:['a'],acceptance:['secure']}],checks:[],risk:'low',security:false};
 await assert.rejects(h.tools.delivery_plan.execute('review',recovery,null,null,h.ctx),/security|matching/i);
 await h.tools.delivery_plan.execute('review',{...recovery,security:true},null,null,h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'blocked');
 const userTurn='Implement the retained security correction';await h.events.input({text:userTurn,source:'interactive'},h.ctx);const candidate={version:1,branch:'main',head:'hash',defaultBranch:'main',clean:false,status:' M a',inventory:['a'],staged:[],fingerprint:'hash'};h.deps.correctionCandidate=()=>candidate;h.deps.assertCorrectionCandidate=()=>candidate;h.deps.createCorrectionBranch=()=>({branch:'bug/security-correction',head:'hash',defaultBranch:'main',clean:false,status:' M a'});h.deps.firstFreeBranch=()=> 'bug/security-correction';h.deps.branchState=()=>({branch:'bug/security-correction',head:'hash',defaultBranch:'main',clean:false,status:' M a'});
 await h.tools.delivery_plan.execute('correct',{...plan,title:'Security correction',mode:'implementation',changeType:'bug',reviewPolicy:'strict',security:true,executionIntent:{kind:'explicit-implementation',userTurn},correctionAdoption:{kind:'retained-candidate',userTurn},tasks:[{...plan.tasks[0],files:['a'],sensitive:true}]},null,null,h.ctx);await h.controller.settled();
 const spawns=h.calls.filter(call=>call.method==='spawn');
 assert.equal(spawns[0].params.agent,'delivery-security');assert.equal(spawns[0].params.model,routes.security);
 assert.equal(spawns[1].params.agent,'delivery-coder');assert.match(spawns[1].params.task,/security defect/);
 assert.equal(h.controller.state().stage,'complete');
});
test('legacy pre-authorization commit failure reuses only unchanged accepted evidence after reload',async()=>{
 const gitPolicy={changeType:'feature',reviewPolicy:'balanced',baseBranch:'main',defaultBranch:'main',workingBranch:'feature/fixture',baseHead:'hash',expectedHead:'hash',createBranch:false,branchCreated:true,commits:[]};
 const pendingCommit={phase:'preparation',task:0,round:2,snapshot:'hash',reviewedContentSnapshot:'hash',files:['a']};
 const h=harness();h.entries.push(oldRunEntry('blocked',routes,{gitPolicy,reviewedContentSnapshot:{task:0,aggregate:false,snapshot:'hash'},pendingCommit,reason:'Commit failed before staging'}));
 let commits=0;h.deps.commitApprovedTask=()=>{commits++;return {hash:'hash',message:'feat: Add',branch:'feature/fixture',baseHead:'hash',paths:['a'],snapshot:'hash'};};
 h.deps.assertApprovedPaths=()=>['a'];
 await h.events.session_start({},h.ctx);const result=await h.tools.delivery_resume.execute('resume',{},null,null,h.ctx);await h.controller.settled();
 assert.match(result.content[0].text,/unchanged accepted review evidence/);assert.equal(commits,1);assert.equal(h.controller.state().pendingCommit,undefined);assert.equal(h.calls.filter(call=>call.params?.agent==='delivery-coder').length,0);
});
test('dirty worktree with unchanged pending commit points to delivery_resume instead of the generic dirty error',async()=>{
 const dirtyError='Delivery requires a clean tracked and untracked worktree before proposal. Reviewed dirty work must use an explicitly authorized correctionAdoption plan; ordinary plans still require commit or stash. No automatic stash or baseline commit was created.';
 const gitPolicy={changeType:'feature',reviewPolicy:'balanced',baseBranch:'main',defaultBranch:'main',workingBranch:'feature/fixture',baseHead:'hash',expectedHead:'hash',createBranch:false,branchCreated:true,commits:[]};
 const pendingCommit={phase:'preparation',task:0,round:2,snapshot:'hash',reviewedContentSnapshot:'hash',files:['a']};
 const h=harness();h.entries.push(oldRunEntry('blocked',routes,{gitPolicy,reviewedContentSnapshot:{task:0,aggregate:false,snapshot:'hash'},pendingCommit,reason:'Commit failed before staging'}));
 h.deps.lifecyclePreflight=()=>{throw new Error(dirtyError);};
 await h.events.session_start({},h.ctx);
 // Workspace unchanged since the blocked commit: the pending-commit recovery message must replace the generic dirty-worktree error.
 await assert.rejects(h.tools.delivery_plan.execute('plan',plan,null,null,h.ctx),/pending for task 1[\s\S]*delivery_resume[\s\S]*commit[\s\/]stash/);
 assert.deepEqual(h.controller.state().pendingCommit,pendingCommit);
 // Workspace changed since the blocked commit: the original dirty-worktree error is rethrown.
 const changed=harness();changed.entries.push(oldRunEntry('blocked',routes,{gitPolicy,reviewedContentSnapshot:{task:0,aggregate:false,snapshot:'hash'},pendingCommit,reason:'Commit failed before staging'}));
 changed.deps.lifecyclePreflight=()=>{throw new Error(dirtyError);};
 changed.deps.fingerprint=()=> 'changed-hash';
 await changed.events.session_start({},changed.ctx);
 await assert.rejects(changed.tools.delivery_plan.execute('plan',plan,null,null,changed.ctx),new RegExp(dirtyError.replaceAll(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 assert.deepEqual(changed.controller.state().pendingCommit,pendingCommit);
});
test('legacy recovery review lineage is reconstructed only from matching same-session repository journal evidence',async()=>{
 const retained=oldRunEntry('blocked',routes,{reason:'Child review-failed failed; attempt closed. infrastructure failed',correctionPolicy:{maxFixRounds:4,source:'default'},failedRun:{id:'review-failed',state:'failed',stage:'quality',task:0,round:2,model:routes.quality,error:'infrastructure failed'}});
 const reviewPlan={title:'Legacy recovery',mode:'review',tasks:[{title:'Review',instructions:'Review only',files:['a'],acceptance:['correct']}],checks:[],risk:'low',security:false};
 const reviewState={version:1,enabled:true,stage:'spec',task:0,round:0,plan:reviewPlan,routes,timeouts:timeoutPolicy(),correctionPolicy:{maxFixRounds:4,source:'default'},snapshot:'hash',active:null,reports:[],priorRun:{stage:'blocked',task:0,round:2,reports:1},reviewProvenance:{version:1,kind:'retained-recovery',session:'session',repository:'/repo',candidateFingerprint:'hash',reviewCandidateFingerprint:'hash',reviewFiles:['a'],failedRun:{id:'review-failed',stage:'quality',task:0,round:2},routes,timeouts:timeoutPolicy(),correctionPolicy:{maxFixRounds:4,source:'default'}},workspace:'/repo',owner:'session'};
 const h=harness();h.entries.push(retained,structuredClone(retained),{type:'custom',customType:'delivery-mode-v1',data:reviewState});await h.events.session_start({},h.ctx);
 const state=h.controller.state();assert.equal(state.retainedRun.source,'trusted-journal');assert.equal(state.retainedRun.state.plan.title,'Fixture');assert.equal(state.reviewAttachment.legacy,true);assert.equal(state.resumeStage,'quality');
});
test('persisted standalone same-scope review cannot attach to a blocked implementation after restart',async()=>{
 const retained=oldRunEntry('blocked',routes,{reason:'Child review-failed failed; attempt closed. infrastructure failed',failedRun:{id:'review-failed',state:'failed',stage:'quality',task:0,round:0,model:routes.quality,error:'infrastructure failed'}});
 const reviewPlan={title:'Standalone same-file review',mode:'review',tasks:[{title:'Review',instructions:'Review only',files:['a'],acceptance:['correct']}],checks:[],risk:'low',security:false};
 const reviewState={version:1,enabled:true,stage:'spec',task:0,round:0,plan:reviewPlan,routes,timeouts:timeoutPolicy(),correctionPolicy:{maxFixRounds:4,source:'default'},snapshot:'hash',active:null,reports:[],priorRun:{stage:'blocked',task:0,round:0,reports:1},reviewProvenance:{version:1,kind:'standalone'},workspace:'/repo',owner:'session'};
 const h=harness();h.entries.push(retained,{type:'custom',customType:'delivery-mode-v1',data:reviewState});await h.events.session_start({},h.ctx);
 assert.equal(h.controller.state().retainedRun,undefined);assert.equal(h.controller.state().reviewAttachment,undefined);assert.equal(h.controller.state().plan.mode,'review');
});
test('legacy recovery lineage rejects changed material bindings',async()=>{
 const retained=oldRunEntry('blocked',routes,{reason:'Child review-failed failed; attempt closed. infrastructure failed',failedRun:{id:'review-failed',state:'failed',stage:'quality',task:0,round:0,model:routes.quality,error:'infrastructure failed'}});
 const reviewPlan={title:'Legacy recovery',mode:'review',tasks:[{title:'Review',instructions:'Review only',files:['a'],acceptance:['correct']}],checks:[],risk:'low',security:false};
 const changedRoutes={...routes,coder:routes.spec};
 const reviewState={version:1,enabled:true,stage:'blocked',task:0,round:0,plan:reviewPlan,routes:changedRoutes,timeouts:timeoutPolicy(),correctionPolicy:{maxFixRounds:4,source:'default'},snapshot:'hash',active:null,reports:[],priorRun:{stage:'blocked',task:0,round:0,reports:1},reviewProvenance:{version:1,kind:'retained-recovery',session:'session',repository:'/repo',candidateFingerprint:'hash',reviewCandidateFingerprint:'hash',reviewFiles:['a'],failedRun:{id:'review-failed',stage:'quality',task:0,round:0},routes:changedRoutes,timeouts:timeoutPolicy(),correctionPolicy:{maxFixRounds:4,source:'default'}},workspace:'/repo',owner:'session'};
 const h=harness();h.entries.push(retained,{type:'custom',customType:'delivery-mode-v1',data:reviewState});await h.events.session_start({},h.ctx);
 assert.equal(h.controller.state().retainedRun,undefined);assert.match(h.controller.state().reason,/binding|lineage|matching/i);
});
test('ambiguous legacy recovery review lineage fails closed without asking to clean retained work',async()=>{
 const reviewPlan={title:'Legacy recovery',mode:'review',tasks:[{title:'Review',instructions:'Review only',files:['a'],acceptance:['correct']}],checks:[],risk:'low',security:false};
 const reviewState={version:1,enabled:true,stage:'blocked',task:0,round:0,plan:reviewPlan,routes,timeouts:timeoutPolicy(),snapshot:'hash',active:null,reports:[],priorRun:{stage:'blocked',task:0,round:2,reports:1},reason:'legacy review stopped',workspace:'/repo',owner:'session'};
 const h=harness();h.entries.push({type:'custom',customType:'delivery-mode-v1',data:reviewState});await h.events.session_start({},h.ctx);
 assert.match(h.controller.state().reason,/no unique matching same-session, same-repository/i);assert.doesNotMatch(h.controller.state().reason,/clean (?:the )?(?:tree|workspace)|discard retained/i);assert.equal(h.controller.state().retainedRun,undefined);
});
test('standalone read-only review never acquires retained implementation authority',async()=>{
 const h=harness();h.entries.push(oldRunEntry('complete',routes));await h.events.session_start({},h.ctx);
 await h.events.input({text:'Review a separate file',source:'interactive'},h.ctx);
 const review={title:'Separate review',mode:'review',tasks:[{title:'Review',instructions:'Review only',files:['other.js'],acceptance:['correct']}],checks:[],risk:'low',security:false};
 await h.tools.delivery_plan.execute('review',review,null,null,h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().plan.mode,'review');assert.equal(h.controller.state().stage,'complete');assert.equal(h.calls.filter(call=>call.params?.agent==='delivery-coder').length,0);
 assert.deepEqual(h.controller.state().reviewProvenance,{version:1,kind:'standalone'});assert.equal(h.controller.state().retainedRun,undefined);
});
test('reviewed dirty candidate enters correction only through exact explicit adoption without a checkpoint',async()=>{
 const reviewPlan={title:'Dirty review',mode:'review',tasks:[{title:'Review candidate',instructions:'Review only',files:['a'],acceptance:['original behavior']}],checks:[],risk:'low',security:false};
 const reviewed=oldRunEntry('blocked',routes,{plan:reviewPlan,task:0,round:0,reason:'Read-only validation found issues; fixes require a separate approved implementation plan.',reports:[{stage:'quality',task:0,round:0,snapshot:'hash',runId:'review',report:{status:'changes_requested',summary:'defect',findings:['high a:1 broken result; correct it']}}],reviewProvenance:{version:1,kind:'standalone'}});
 const h=harness();h.entries.push(reviewed);h.deps.lifecyclePreflight=()=>{throw new Error('clean-worktree checkpoint loop');};
 const candidate={version:1,branch:'main',head:'hash',defaultBranch:'main',clean:false,status:'M  a\0',inventory:['a'],staged:[],fingerprint:'hash'};
 h.deps.correctionCandidate=()=>structuredClone(candidate);h.deps.assertCorrectionCandidate=()=>structuredClone(candidate);h.deps.createCorrectionBranch=()=>({branch:'feature/fix-reviewed-candidate',head:'hash',defaultBranch:'main',clean:false,status:' M a'});
 h.deps.firstFreeBranch=()=> 'feature/fix-reviewed-candidate';h.deps.branchState=()=>({branch:'feature/fix-reviewed-candidate',head:'hash',defaultBranch:'main',clean:false,status:' M a'});
 await h.events.session_start({},h.ctx);const userTurn='Implement the reviewed correction without discarding the candidate';await h.events.input({text:userTurn,source:'interactive'},h.ctx);
 const correction={...plan,title:'Fix reviewed candidate',security:false,tasks:[{...plan.tasks[0],files:['a'],acceptance:['original behavior','review finding corrected']}],executionIntent:{kind:'explicit-implementation',userTurn},correctionAdoption:{kind:'retained-candidate',userTurn}};
 await h.tools.delivery_plan.execute('correct',correction,null,null,h.ctx);await h.controller.settled();
 const state=h.controller.state();assert.equal(state.stage,'complete',state.reason);assert.ok(state.adoptions?.length);assert.ok(state.adoptedEvidence?.reports?.length);assert.match(h.calls.find(call=>call.params?.agent==='delivery-coder').params.task,/broken result|original behavior/);
});
test('reviewed dirty candidate with checks adopts its dedicated content fingerprint',async()=>{
 const reviewPlan={title:'Checked dirty review',mode:'review',tasks:[{title:'Review candidate',instructions:'Review only',files:['a'],checks:['review-check'],acceptance:['original behavior']}],checks:['review-final'],risk:'low',security:false};
 const reviewed=oldRunEntry('blocked',routes,{plan:reviewPlan,snapshot:'checked-hash',reason:'Read-only validation found issues; fixes require a separate approved implementation plan.',reports:[{stage:'quality',task:0,round:0,snapshot:'checked-hash',report:{status:'changes_requested',summary:'defect',findings:['a:1 correct checked candidate']}}],reviewProvenance:{version:1,kind:'standalone'}});
 const h=harness();h.entries.push(reviewed);h.deps.fingerprint=(_root,options)=>options.commands?.length?'checked-hash':'content-hash';
 const candidate={version:1,branch:'main',head:'hash',defaultBranch:'main',clean:false,status:' M a',inventory:['a'],staged:[],fingerprint:'content-hash'};h.deps.correctionCandidate=()=>candidate;h.deps.assertCorrectionCandidate=()=>candidate;h.deps.createCorrectionBranch=()=>({branch:'feature/fixture',head:'hash',defaultBranch:'main',clean:false,status:' M a'});h.deps.branchState=()=>({branch:'feature/fixture',head:'hash',defaultBranch:'main',clean:false,status:' M a'});
 await h.events.session_start({},h.ctx);const userTurn='Implement the checked reviewed correction';await h.events.input({text:userTurn,source:'interactive'},h.ctx);
 await h.tools.delivery_plan.execute('correct',{...plan,title:'Checked correction',security:false,executionIntent:{kind:'explicit-implementation',userTurn},correctionAdoption:{kind:'retained-candidate',userTurn},tasks:[{...plan.tasks[0],files:['a']}]},null,null,h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.equal(h.controller.state().adoptions[0].candidate.fingerprint,'content-hash');
});
test('review with checks adopts the real content-only dirty candidate and completes correction',async t=>{
 const d=mkdtempSync(join(tmpdir(),'delivery-adoption-fingerprint-'));t.after(()=>rmSync(d,{recursive:true,force:true}));
 execFileSync('git',['init','-q','-b','main',d]);writeFileSync(join(d,'a'),'base\n');execFileSync('git',['-C',d,'add','a']);execFileSync('git',['-C',d,'-c','user.name=T','-c','user.email=t@x','commit','-qm','base']);writeFileSync(join(d,'a'),'candidate\n');
 const h=harness(),executed=[];h.deps.fingerprint=(_root,options)=>fingerprint(d,options);h.deps.correctionCandidate=(_root,scope)=>correctionCandidate(d,scope);h.deps.assertCorrectionCandidate=(_root,scope,expected)=>assertCorrectionCandidate(d,scope,expected);h.deps.firstFreeBranch=(_root,naming)=>firstFreeBranch(d,naming);h.deps.createCorrectionBranch=(_root,name,scope,expected)=>createCorrectionBranch(d,name,scope,expected);h.deps.branchState=()=>branchState(d);h.deps.commitApprovedTask=()=>{const state=branchState(d);return {hash:state.head,message:'fix: Correct candidate',branch:state.branch,baseHead:state.head,paths:['a'],snapshot:fingerprint(d,{scope:['a']})};};
 h.deps.verifyCommand=async(_root,command)=>{executed.push([command,h.controller.state().stage]);return {command,code:0,output:'PASS'};};
 let outcome=0;h.deps.readOutcome=()=>++outcome===1?{status:'changes_requested',summary:'defect',findings:['a:1 fix candidate']}:{status:'approved',summary:'corrected',findings:[]};
 await h.events.session_start({},h.ctx);await h.events.input({text:'Review the dirty checked candidate',source:'interactive'},h.ctx);
 const reviewPlan={title:'Checked candidate review',mode:'review',tasks:[{title:'Review candidate',instructions:'Review only',files:['a'],acceptance:['candidate is correct']}],checks:['npm test'],risk:'low',security:false};
 await h.tools.delivery_plan.execute('review',reviewPlan,null,null,h.ctx);await h.controller.settled();
 const reviewed=h.controller.state(),candidate=correctionCandidate(d,['a']);assert.equal(reviewed.stage,'blocked');assert.equal(reviewed.candidateFingerprint,candidate.fingerprint);assert.equal(reviewed.snapshot,fingerprint(d,{scope:['a'],commands:['npm test']}));executed.length=0;
 const userTurn='Implement the checked candidate correction';await h.events.input({text:userTurn,source:'interactive'},h.ctx);
 const correction={title:'Checked correction',mode:'implementation',changeType:'bug',reviewPolicy:'balanced',executionIntent:{kind:'explicit-implementation',userTurn},correctionAdoption:{kind:'retained-candidate',userTurn},tasks:[{title:'Correct candidate',instructions:'Fix the retained finding',files:['a'],checks:['node --test'],acceptance:['candidate is correct']}],checks:['node --test'],risk:'low',security:false};
 await h.tools.delivery_plan.execute('correct',correction,null,null,h.ctx);await h.controller.settled();
 const corrected=h.controller.state(),writers=h.calls.filter(call=>call.params?.agent==='delivery-coder');assert.equal(corrected.stage,'complete',corrected.reason);assert.ok(writers.length>=1);assert.equal(corrected.adoptions[0].candidate.fingerprint,candidate.fingerprint);assert.ok(writers.some(call=>/fix candidate|candidate is correct/i.test(call.params.task)));
 assert.ok(executed.some(([command,stage])=>command==='npm test'&&stage==='final-checks'),'retained final check must run after adoption');
});
test('pending correction adoption survives reload with its exact candidate and evidence',async()=>{
 const reviewPlan={title:'Reloaded dirty review',mode:'review',tasks:[{title:'Review',instructions:'Review only',files:['a'],acceptance:['original behavior']}],checks:[],risk:'low',security:false};
 const first=harness();first.entries.push(oldRunEntry('blocked',routes,{plan:reviewPlan,reason:'Read-only validation found issues; fixes require a separate approved implementation plan.',reports:[{stage:'quality',task:0,round:0,snapshot:'hash',report:{status:'changes_requested',summary:'defect',findings:['a:1 fix after reload']}}],reviewProvenance:{version:1,kind:'standalone'}}));
 const candidate={version:1,branch:'main',head:'hash',defaultBranch:'main',clean:false,status:' M a',inventory:['a'],staged:[],fingerprint:'hash'};first.deps.correctionCandidate=()=>candidate;
 await first.events.session_start({},first.ctx);const userTurn='Prepare and retain this explicit correction adoption';await first.events.input({text:userTurn,source:'interactive'},first.ctx);
 await first.tools.delivery_plan.execute('correct',{...plan,title:'Reload correction',security:false,start:false,executionIntent:{kind:'explicit-implementation',userTurn},correctionAdoption:{kind:'retained-candidate',userTurn},tasks:[{...plan.tasks[0],files:['a']}]},null,null,first.ctx);
 const next=harness();next.entries.push(...structuredClone(first.entries));next.deps.correctionCandidate=()=>candidate;next.deps.assertCorrectionCandidate=()=>candidate;next.deps.createCorrectionBranch=()=>({branch:'feature/fixture',head:'hash',defaultBranch:'main',clean:false,status:' M a'});next.deps.branchState=()=>({branch:'feature/fixture',head:'hash',defaultBranch:'main',clean:false,status:' M a'});
 await next.events.session_start({},next.ctx);assert.equal(next.controller.state().stage,'awaiting-approval');assert.equal(next.controller.state().correctionAdoption.candidate.fingerprint,'hash');
 await next.events.input({text:'Approve the displayed retained correction',source:'interactive'},next.ctx);await next.tools.delivery_execute.execute('go',{},null,null,next.ctx);await next.controller.settled();
 assert.equal(next.controller.state().stage,'complete');assert.match(next.calls.find(call=>call.params?.agent==='delivery-coder').params.task,/fix after reload|original behavior/);
});
test('correction adoption rejects absent consent and a changed candidate without launching a writer',async()=>{
 const reviewPlan={title:'Dirty review',mode:'review',tasks:[{title:'Review',instructions:'Review only',files:['a'],acceptance:['correct']}],checks:[],risk:'low',security:false};
 for(const scenario of ['consent','changed']) {
  const h=harness();h.entries.push(oldRunEntry('blocked',routes,{plan:reviewPlan,reason:'Read-only validation found issues; fixes require a separate approved implementation plan.',reports:[{stage:'quality',task:0,round:0,snapshot:'hash',report:{status:'changes_requested',summary:'defect',findings:['a:1 fix']}}],reviewProvenance:{version:1,kind:'standalone'}}));
  const candidate={version:1,branch:'main',head:'hash',defaultBranch:'main',clean:false,status:' M a',inventory:['a'],staged:[],fingerprint:'hash'};h.deps.correctionCandidate=()=>candidate;h.deps.lifecyclePreflight=()=>{throw new Error('dirty worktree requires correction adoption');};h.deps.assertCorrectionCandidate=()=>{if(scenario==='changed')throw new Error('Correction candidate changed');return candidate;};
  await h.events.session_start({},h.ctx);const userTurn='Implement the reviewed correction';await h.events.input({text:userTurn,source:'interactive'},h.ctx);
  const correction={...plan,title:'Fix reviewed candidate',security:false,tasks:[{...plan.tasks[0],files:['a']}],executionIntent:{kind:'explicit-implementation',userTurn},...(scenario==='consent'?{}:{correctionAdoption:{kind:'retained-candidate',userTurn}})};
  if(scenario==='consent')await assert.rejects(h.tools.delivery_plan.execute('correct',correction,null,null,h.ctx),/clean-worktree|adoption|dirty|requires/i);
  else await assert.rejects(h.tools.delivery_plan.execute('correct',correction,null,null,h.ctx),/candidate changed/i);
  assert.equal(h.calls.filter(call=>call.method==='spawn').length,0);
 }
});

for(const stage of ['coder','spec','quality','security'])test(`connection failure retries only the failed ${stage} on the approved route`,async()=>{
 const h=harness();let failed=false;const strictPlan={...plan,reviewPolicy:'strict'};
 h.deps.isSettled=()=>true;
 h.deps.runProgress=a=>{
  if(a.stage!==stage || failed)return null;
  failed=true;
  return {state:'failed',nativeState:'partial',error:'Connection error.\nRequired structured output was not produced',model:a.model,attemptedModels:[a.model],durationMs:1000,sessionFiles:['/fake/prior.jsonl']};
 };
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('p',strictPlan,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 const state=h.controller.state(),spawns=h.calls.filter(c=>c.method==='spawn');
 assert.equal(state.stage,'complete');assert.equal(state.round,0);
 const attempts=spawns.filter(c=>c.params.model===routes[stage] && c.params.agent===`delivery-${stage==='coder'?'coder':stage==='security'?'security':'reviewer'}`);
 assert.equal(spawns.length,8);assert.equal(spawns.filter(c=>c.params.agent==='delivery-coder').length,stage==='coder'?3:2);
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
 const h=harness();const strictPlan={...plan,reviewPolicy:'strict'};h.deps.isSettled=()=>true;
 h.deps.runProgress=a=>a.stage==='spec'?{state:'failed',error:'Connection error.',model:a.model,attemptedModels:[a.model],durationMs:a.budgetMs,sessionFiles:[]}:null;
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('p',strictPlan,null,null,h.ctx);await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 assert.equal(h.controller.state().stage,'blocked');assert.equal(h.calls.filter(c=>c.method==='spawn').length,3);
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
 const reviewerCall=h.calls.find(c=>c.method==='spawn' && c.params?.agent==='delivery-reviewer' && c.params.task.includes('Independent aggregate-quality'));assert.ok(reviewerCall,JSON.stringify({calls:h.calls,state:h.controller.state(),messages:h.messages}));const briefing=reviewerCall.params.task;
 assert.match(briefing,/git diff --no-ext-diff/i);assert.match(briefing,/do not block solely because embedded evidence is truncated/i);
});
test('aggregate review briefing includes committed range and current correction artifact',async()=>{
 const h=harness({version:1,routes,evidence:{},repos:['/repo'],workingTreeEvidence:()=> 'CURRENT_CORRECTION_MARKER'});let requested=false;
 h.deps.readOutcome=a=>{if(a.stage==='aggregate-quality'&&!requested){requested=true;return {status:'changes_requested',summary:'aggregate correction',findings:['fix']};}return {status:'approved',summary:'ok',findings:[]};};
 await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('p',{...plan,security:false},null,null,h.ctx);await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
 const aggregates=h.calls.filter(c=>c.method==='spawn' && c.params?.task.includes('Independent aggregate-quality'));assert.equal(aggregates.length,2);const aggregate=aggregates.at(-1);assert.match(aggregate.params.task,/BOUND COMMITTED RANGE/);assert.match(aggregate.params.task,/CURRENT_CORRECTION_MARKER/);assert.match(aggregate.params.task,/BOUND CURRENT WORKING-TREE CORRECTION/);
});
