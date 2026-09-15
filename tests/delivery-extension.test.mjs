import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,copyFileSync,rmSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {registerDelivery} from '../extensions/delivery/extension.mjs';
import {timeoutPolicy} from '../extensions/delivery/policy.mjs';
const routes={planning:'openai-codex/gpt-6-astra',coder:'custom/c',spec:'custom/r',quality:'custom/r',security:'custom/s'};
const plan={title:'Fixture',tasks:[{title:'Add',instructions:'Add one',files:['a'],acceptance:['works']}],checks:['node --test'],risk:'low',security:true};
function harness(config={version:1,routes,evidence:{},repos:['/repo']}) {
 const events={},commands={},tools={},entries=[],statuses=[],messages=[],calls=[];
 let model={provider:'openai-codex',id:'gpt-5.5'};
 const models=[...new Set(Object.values(routes))].map(s=>{const [provider,...id]=s.split('/');return {provider,id:id.join('/')};});
 const ctx={cwd:'/repo',hasUI:true,mode:'tui',isIdle:()=>true,isProjectTrusted:()=>true,modelRegistry:{getAll:()=>models,getAvailable:()=>models},get model(){return model;},sessionManager:{getSessionId:()=> 'session',getBranch:()=>entries},ui:{setStatus:(k,v)=>statuses.push(v),notify:()=>{},confirm:async()=>true,select:async(t,opts)=>opts[0],input:async()=> 'trial'}};
 const pi={on:(e,h)=>events[e]=h,registerCommand:(n,c)=>commands[n]=c,registerTool:t=>tools[t.name]=t,appendEntry:(customType,data)=>entries.push({type:'custom',customType,data:structuredClone(data)}),setModel:async m=>{model=m;return true;},sendMessage:m=>messages.push(m),sendUserMessage:m=>messages.push(m),getActiveTools:()=>['read','bash','edit','write','delivery_plan'],setActiveTools:()=>{},events:{}};
 const deps={configPath:()=>'/unused',loadConfig:()=>structuredClone(config),saveConfig:(_,c)=>Object.assign(config,c),repoRoot:()=>'/repo',fingerprint:()=> 'hash',diff:()=> 'diff',reviewPatch:()=>'/fake/full.diff',validateCommands:()=>{},runProgress:()=>null,verifyCommand:async()=>({code:0,output:'PASS'}),rpc:async(_e,method,params)=>{calls.push({method,params});return method==='spawn'?{details:{runId:'r'+calls.length,asyncDir:'/fake'}}:{};},readOutcome:()=>({status:'approved',summary:'ok',findings:[]}),pollMs:1,child:false};
 const controller=registerDelivery(pi,{plan:{},empty:{}},deps);
 return {pi,ctx,events,commands,tools,entries,statuses,messages,calls,controller,deps,config};
}
const securityPreflightError="Run fan-out: 1/64 used, 63 remaining\nAgent 'delivery-security' was given an implementation task, but its tool allowlist has no mutation-capable tools. Add bash, edit, write, or another mutation-capable tool to the agent, or use a read-only task/agent.";
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
  await assert.rejects(next.tools.delivery_resume.execute('r',{},null,null,next.ctx),/No retained run|Uncertain/);
  assert.equal(next.calls.filter(c=>c.method==='spawn').length,0);return;
 }
 assert.equal(next.controller.state().active.preflightRejection,securityPreflightError);
 await next.tools.delivery_resume.execute('r',{},null,null,next.ctx);await next.controller.settled();
 assert.equal(next.controller.state().stage,'complete');assert.deepEqual(next.calls.filter(c=>c.method==='spawn').map(c=>c.params.agent),['delivery-security']);
});
test('exhausted terminal run exposes retained requirements and a corrective-plan path',async()=>{
 const h=harness();const entry=oldRunEntry('blocked',routes,{reports:[{stage:'spec',task:0,report:{status:'changes_requested',summary:'remaining regression',findings:['HIGH a:1 preserve cleared values']}}]});h.entries.push(entry);
 await h.events.session_start({},h.ctx);const before=h.controller.state();
 const status=await h.tools.delivery_status.execute();const text=status.content.map(c=>c.text||'').join('\n');
 assert.match(text,/new corrective plan/i);assert.match(text,/delivery_plan/);assert.match(text,/Add one/);assert.match(text,/preserve cleared values/);assert.match(text,/node --test/);assert.match(text,/No saved Markdown file is required/);
 const prompt=await h.events.before_agent_start({systemPrompt:'base'},h.ctx);assert.match(prompt.systemPrompt,/NEXT ACTION:.*delivery_plan/);
 await assert.rejects(h.tools.delivery_resume.execute('r',{},null,null,h.ctx),/new corrective plan.*delivery_plan/i);
 assert.deepEqual(h.controller.state(),before);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 await h.tools.delivery_plan.execute('p',{...plan,title:'Correct remaining regression'},null,null,h.ctx);
 await assert.rejects(h.tools.delivery_execute.execute('e',{},null,null,h.ctx),/fresh user reply/i);
 await h.events.input({text:'Approve this corrective plan',source:'interactive'},h.ctx);
 await h.tools.delivery_execute.execute('e',{},null,null,h.ctx);await h.controller.settled();assert.equal(h.controller.state().stage,'complete');
});
test('unresolved children never receive a corrective-plan next action',async()=>{
 const h=harness();h.entries.push(oldRunEntry('blocked',routes,{active:{id:null,dir:null,stage:'coder',model:routes.coder}}));
 await h.events.session_start({},h.ctx);const status=await h.tools.delivery_status.execute();
 assert.doesNotMatch(status.content[0].text,/NEXT ACTION:.*delivery_plan/);
 await assert.rejects(h.tools.delivery_plan.execute('p',plan,null,null,h.ctx),/owned run|unresolved/i);
});
test('unknown security launch errors remain uncertain, never retried',async()=>{
 const {h}=await rejectedSecurity('pi-subagents spawn timed out');const before=h.controller.state();
 await assert.rejects(h.tools.delivery_resume.execute('r',{},null,null,h.ctx),/No retained run|Uncertain/);
 assert.deepEqual(h.controller.state(),before);
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
 const h=harness();h.config.routes={...routes,security:routes.spec};h.config.timeouts={reviewMs:20*60000};const oldPlan={...plan,tasks:[plan.tasks[0],{...plan.tasks[0],title:'Later'}],checks:['node release-test.mjs']};
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
 await h.tools.delivery_plan.execute('id',{...plan,mode:'review',commits:2},null,null,h.ctx);
 assert.equal(h.controller.state().plan.mode,'review');assert.deepEqual(h.controller.state().plan.reviewRange,range);
 await h.controller.settled();
 assert.equal(h.controller.state().stage,'complete');assert.ok(checked>0);
 assert.deepEqual(h.calls.filter(c=>c.method==='spawn').map(c=>c.params.agent),['delivery-reviewer','delivery-reviewer','delivery-security']);
 assert.ok(h.calls.filter(c=>c.method==='spawn').every(c=>c.params.task.includes('Host verification evidence: [{') && c.params.task.includes('committed diff')));
});
test('read-only check failure stops without dispatching an automatic fix',async()=>{
 const h=harness();h.deps.verifyCommand=async()=>({code:1,output:'failing test'});
 await h.events.session_start({},h.ctx);await h.commands.delivery.handler('review',h.ctx);
 await h.tools.delivery_plan.execute('id',{...plan,mode:'review'},null,null,h.ctx);
 await h.controller.settled();
 assert.equal(h.controller.state().stage,'blocked');assert.match(h.controller.state().reason,/failing test/);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('ordinary user review request executes without an approval command',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 await h.events.input({text:'Please validate these changes without fixing anything',source:'interactive'},h.ctx);
 await h.tools.delivery_plan.execute('id',{...plan,mode:'review'},null,null,h.ctx);await h.controller.settled();
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
test('implementation and review checks keep their ordering and stop on failure',async()=>{
 for(const mode of ['implementation','review']) {
  const h=harness(),ran=[];
  h.deps.verifyCommand=async(_cwd,command)=>{ran.push(command);return {command,code:0,output:'PASS'};};
  await h.events.session_start({},h.ctx);
  await h.tools.delivery_plan.execute('plan',{...plan,mode,checks:['first','second']},null,null,h.ctx);
  await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();
  assert.deepEqual(ran,['first','second','first','second']);assert.equal(h.controller.state().stage,'complete');
 }
 const h=harness(),ran=[];
 h.deps.verifyCommand=async(_cwd,command)=>{ran.push(command);return {command,code:1,output:'FAIL'};};
 await h.events.session_start({},h.ctx);
 await h.tools.delivery_plan.execute('plan',{...plan,mode:'review',checks:['first','second']},null,null,h.ctx);
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
 h.deps.runProgress=()=>({state:'failed',timedOut:false,model:kind==='wrong-model'?'wrong':active.model,attemptedModels:[active.model],durationMs:34000,error:'Connection error.',sessionFiles:['/fake/session.jsonl']});
 await h.events.session_start({},h.ctx);const before=h.controller.state();
 if(['unclosed','wrong-model'].includes(kind)) {
  await assert.rejects(h.tools.delivery_resume.execute('r',{},null,null,h.ctx),/closed|model/i);
  assert.deepEqual(h.controller.state().active,before.active);assert.deepEqual(h.controller.state().coding,before.coding);
 } else {
  const r=await h.tools.delivery_resume.execute('r',{},null,null,h.ctx);await h.controller.settled();
  assert.match(r.content[0].text,/no execution restarted/i);assert.equal(h.controller.state().active,null);
  assert.equal(h.controller.state().failedRun.id,'failed-child');assert.equal(h.controller.state().failedRun.error,'Connection error.');
  assert.equal(h.controller.state().coding[0].spentMs,3287707+(stage==='coder'?34000:0));assert.equal(h.controller.state().coding[0].continuations,1);
  assert.deepEqual(h.controller.state().reports,before.reports);assert.equal(h.controller.state().round,1);
  const retained=h.controller.state();await assert.rejects(h.tools.delivery_resume.execute('r',{},null,null,h.ctx),/delivery_plan/);assert.deepEqual(h.controller.state(),retained);
  const text=(await h.tools.delivery_status.execute()).content[0].text;assert.match(text,/Connection error/);assert.match(text,/delivery_plan/);
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
test('human supervisor reply is confirmed; parent cannot authorize it silently',async()=>{
 const h=harness();await h.events.session_start({},h.ctx);
 const response=await h.events.tool_call({toolName:'subagent_supervisor',input:{action:'reply',message:'approve scope'}},h.ctx);
 assert.equal(response.block,true);
});
test('runtime failed child cannot become approved from prose',async()=>{
 const h=harness();h.deps.readOutcome=()=>{throw new Error('child failed');};await h.events.session_start({},h.ctx);await h.tools.delivery_plan.execute('id',plan,null,null,h.ctx);
 await h.commands.delivery.handler('approve',h.ctx);await h.controller.settled();assert.equal(h.controller.state().stage,'blocked');assert.match(h.controller.state().reason,/child failed/);
});
const oldRunEntry=(stage,oldRoutes,extra={})=>({type:'custom',customType:'delivery-mode-v1',data:{version:1,enabled:true,stage,task:0,round:2,plan,routes:oldRoutes,snapshot:'hash',active:null,reports:[{stage:'security',task:0,round:2,snapshot:'hash',runId:'old',report:{status:'approved',summary:'done',findings:[]}}],reason:stage==='blocked'?'Two fix/review rounds exhausted':'',workspace:'/repo',owner:'session',...extra}});
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
