import {terminalProof} from './helpers/native-artifacts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerDelivery} from '../extensions/delivery/extension.mjs';
import {rpc} from '../extensions/delivery/rpc.mjs';
import {readOutcome,readNativeStatus,readNativeClosure,inspectLock,acquireLock,releaseLock} from '../extensions/delivery/io.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const plan=()=>({mode:'implementation',title:'Bounded change',tasks:[{title:'One',instructions:'Implement one',files:['a'],acceptance:['Works'],checks:['task-one']}],checks:['final'],security:false});
const approved={status:'approved',summary:'Inspected source and evidence',findings:[]};
function harness({initialTools=['read','bash','write','subagent'],entries=[],reports=[],live=false,spawnError=false,checkCode=0,snapshot={a:"hash",unrelated:"dirty"},onSave=()=>{},releaseError=false,delayPing=0,sessionId='session',sessionFile,spawn,readOutcome:outcome,onLock=()=>{},realLocksRoot,nativeStatus=()=>({state:'running'}),overrides={}}={}) {
 const handlers={},tools={},commands={},calls=[],messages=[],saved=[...entries],activeTools=[],modelSets=[];let n=0;
 const models=['planning','coder','quality','security'].map(id=>({provider:'test',id}));
 const events={listeners:new Map(),on(k,f){this.listeners.set(k,f);return()=>this.listeners.delete(k);},emit(k,r){if(!k.endsWith(':request'))return;calls.push(r);let data={version:1,capabilities:{asyncSpawn:true,processTerminalProof:{version:1}},methods:['spawn','status','stop']};
 if(r.method==='spawn')data={details:spawn?spawn(r.params,++n):{runId:`run-${++n}`,asyncDir:`/artifacts/${n}`}};
 if(r.method==='status')data={fleet:{totalActive:0}};
 const reply=()=>this.listeners.get(`subagents:rpc:v1:reply:${r.requestId}`)({version:1,requestId:r.requestId,success:!(spawnError&&r.method==='spawn'),data,error:{message:'Provider unavailable'}});if(r.method==='ping'&&delayPing)setTimeout(reply,delayPing);else reply();
 }};
 const pi={events,on:(k,f)=>handlers[k]=f,registerTool:t=>tools[t.name]=t,registerCommand:(k,c)=>commands[k]=c,appendEntry:(customType,data)=>{saved.push({type:'custom',customType,data:structuredClone(data)});onSave(data);},sendMessage:m=>messages.push(m),getActiveTools:()=>activeTools.length?[...activeTools]:initialTools,setActiveTools:tools=>{activeTools.splice(0,activeTools.length,...tools);},setModel:async(model)=>{modelSets.push(model);return true;}};
 const ctx={cwd:'/workspace',hasUI:true,ui:{setStatus(){},notify(){},confirm:async()=>true,select:async()=>null},sessionManager:{getBranch:()=>saved,getSessionId:()=>sessionId,getSessionFile:()=>sessionFile},modelRegistry:{getAvailable:()=>models}};
 const deps={child:false,readNativeStatus:nativeStatus,loadConfig:()=>({version:1,routes:Object.fromEntries(models.map(m=>[m.id,`test/${m.id}`])),repos:['/workspace']}),repoRoot:()=>'/workspace',snapshot:()=>structuredClone(snapshot),acquireLock:(root,owner)=>onLock('acquire',root,owner),releaseLock:(root,owner)=>{onLock('release',root,owner);if(releaseError)throw new Error("Lock ownership changed");},readOutcome:outcome || (()=>live?null:reports.shift()||approved),workingTreeEvidence:()=> 'dirty diff',validateCommands:()=>{},autoContinue:false,autoApprove:false,autoCommit:false,commitPaths:()=>{throw new Error("unexpected commit");},verifyCommand:async(_r,command)=>({command,code:typeof checkCode==='function'?checkCode(command):checkCode,signal:null,terminated:false,processClosed:true,output:'actual output'}),rpc,pollMs:1};
 if(realLocksRoot){ctx.cwd=realLocksRoot;deps.repoRoot=()=>realLocksRoot;deps.acquireLock=acquireLock;deps.releaseLock=releaseLock;}
 registerDelivery(pi,undefined,{...deps,...overrides});
 const invoke=(name,args={})=>tools[name].execute('call',args,undefined,undefined,ctx);
 const input=text=>handlers.input({text,source:'interactive'},ctx);
 const state=()=>saved.filter(e=>e.customType==='delivery-coordinator-v2').at(-1)?.data;
 const wait=async()=>{for(let i=0;i<200;i++){if(['complete','blocked','stopped'].includes(state()?.stage))return state();await new Promise(r=>setTimeout(r,2));}throw new Error('did not settle');};
 return {handlers,tools,commands,calls,messages,saved,ctx,deps,activeTools,modelSets,invoke,input,state,wait,start:()=>handlers.session_start({},ctx)};
}

test('completed review continuation prepares the next plan without resume or permission-to-plan loops',async()=>{
 const h=harness();await h.start();await h.commands.delivery.handler('on',h.ctx);
 const review={...plan(),mode:'review',tasks:plan().tasks.map(task=>({...task,checks:[]})),checks:[]};
 await h.invoke('delivery_plan',review);await h.input('Approved');await h.invoke('delivery_execute');assert.equal((await h.wait()).stage,'complete');
 const launches=h.calls.filter(c=>c.method==='spawn').length;
 await h.input('continue');
 const status=await h.invoke('delivery_status');const resumed=await h.invoke('delivery_resume');
 for(const value of [status,resumed]) {
  const text=value.content.map(part=>part.text).join('\n');
  assert.match(text,/review complete.*nothing to resume/i);
  assert.match(text,/delivery_plan/);assert.match(text,/do not ask.*want.*plan/i);
  assert.match(text,/implementation still requires.*approval/i);
 }
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,launches);
 assert.match(h.handlers.before_agent_start().message.content,/completed review/i);
 await h.invoke('delivery_plan',plan());await assert.rejects(h.invoke('delivery_execute'),/approval/i);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,launches);
});

for(const reply of ['approval','yes','okay','proceed'])test(`conversational ${reply} authorizes only an already displayed plan`,async()=>{
 const h=harness();await h.start();await h.commands.delivery.handler('on',h.ctx);
 await h.input(reply);await h.invoke('delivery_plan',plan());await assert.rejects(h.invoke('delivery_execute'),/approval/i);
 await h.input(reply);await h.invoke('delivery_execute');assert.equal((await h.wait()).stage,'complete');
});
test('thin interface proposes without launching and questions never approve',async()=>{
 const h=harness();await h.start();await h.commands.delivery.handler('on',h.ctx);
 assert.deepEqual(Object.keys(h.tools).sort(),['delivery_configure','delivery_execute','delivery_issues','delivery_plan','delivery_status','delivery_resume','delivery_stop','delivery_recovery_plan','delivery_recovery_execute'].sort());
 await h.invoke('delivery_plan',plan());await h.input('Can you implement this plan?');await assert.rejects(h.invoke('delivery_execute'),/approval/i);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 await h.input('Plan only, do not implement');await assert.rejects(h.invoke('delivery_execute'),/approval/i);
});
test('native RPC runs coder, task checks, independent quality/security and final checks in order',async()=>{
 const h=harness();await h.start();await h.commands.delivery.handler('on',h.ctx);const p=plan();p.tasks[0].sensitive=true;p.tasks.push({...p.tasks[0],title:'Two',files:['b'],checks:['task-two'],sensitive:false});await h.invoke('delivery_plan',p);await h.input('Implement the displayed plan');await h.invoke('delivery_execute');const s=await h.wait();assert.equal(s.stage,'complete',s.reason);
 const launches=h.calls.filter(c=>c.method==='spawn').map(c=>c.params);assert.deepEqual(launches.map(c=>c.model),['test/coder','test/quality','test/security','test/coder','test/quality']);assert.ok(launches.every(c=>c.context==='fresh'&&c.async===true&&c.share===false));
 assert.deepEqual(s.checks.map(c=>c.command),['task-one','task-two','final']);assert.equal(s.reports.length,5);assert.match(launches[1].task,/task-one/);assert.match(launches[1].task,/Do not modify files/);assert.match(launches[1].task,/Call the structured_output tool/);assert.match(launches[3].task,/Two/);
});
test('security findings return to coder then rerun task checks and both independent reviews',async()=>{
 const finding={status:'changes_requested',summary:'Authorization defect',findings:['high: a:1 deny unauthorized access']};
 const h=harness({reports:[approved,approved,finding,approved,approved,approved]});const p=plan();p.security=true;
 await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',p);await h.input('approval');await h.invoke('delivery_execute');
 assert.equal((await h.wait()).stage,'complete');
 const launches=h.calls.filter(c=>c.method==='spawn');
 assert.deepEqual(launches.map(c=>c.params.agent),['delivery-coder','delivery-reviewer','delivery-security','delivery-coder','delivery-reviewer','delivery-security']);
 assert.match(launches[3].params.task,/Authorization defect/);
 assert.deepEqual(h.state().checks.map(c=>c.command),['task-one','task-one','final']);
});
test('corrections are bounded and keep original approval',async()=>{
 const finding={status:'changes_requested',summary:'Bug',findings:['high: a:1 fix bug']};const h=harness({reports:[approved,finding,approved,finding,approved,finding]});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');const s=await h.wait();assert.equal(s.stage,'blocked');assert.match(s.reason,/correction.*limit/i);assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,3);assert.ok(!s.checks.some(c=>c.command==='final'));
});
test('continue after exhausted correction rounds displays a scoped fresh proposal without launching',async()=>{
 const finding={status:'changes_requested',summary:'SQLite race remains',findings:['high: app/models/invitation.rb:40 handle SQLite busy deterministically']};
 const h=harness({reports:[approved,finding,approved,finding,approved,finding]});
 await h.start();await h.commands.delivery.handler('on',h.ctx);const p=plan();p.tasks.push({...p.tasks[0],title:'Later'});
 await h.invoke('delivery_plan',p);await h.input('Approved');await h.invoke('delivery_execute');const blocked=await h.wait();
 assert.equal(blocked.stage,'blocked');const before=h.calls.filter(c=>c.method==='spawn').length;
 await h.input('continue');assert.equal(h.state().stage,'awaiting-approval');assert.equal(h.state().plan.tasks.length,2);
 assert.match(h.state().plan.tasks[0].instructions,/SQLite race remains/);
 assert.match(h.state().plan.tasks[0].instructions,/Do not replay accepted/);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,before);
 const proposal=h.state().run;await h.input('what changed in this plan');await assert.rejects(h.invoke('delivery_execute'),/approval/i);
 await h.input('continue');assert.equal(h.state().run,proposal,'continue on a displayed plan approves it without replanning');
 await h.invoke('delivery_execute');assert.ok(h.calls.filter(c=>c.method==='spawn').length>before);await h.handlers.session_shutdown();
});
const settle=async(h,done)=>{for(let i=0;i<500;i++){if(done(h.state()))return h.state();await new Promise(r=>setTimeout(r,2));}throw new Error(`did not settle: ${h.state()?.stage}`);};
test('exhausted corrections auto-continue once under the original approval with the same scope',async()=>{
 const finding={status:'changes_requested',summary:'SQLite race remains',findings:['high: a:40 handle busy']};
 const h=harness({reports:[approved,finding,approved,finding,approved,finding],overrides:{autoContinue:true}});
 await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');
 const s=await settle(h,s=>s?.stage==='complete' && s.autoContinuations===1);
 assert.equal(s.inheritedApproval.title,'Bounded change');assert.match(s.plan.tasks[0].instructions,/SQLite race remains/);
 assert.deepEqual(s.plan.tasks[0].files,['a']);assert.deepEqual(s.plan.checks,['final']);
 assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,4);
 assert.ok(h.messages.some(m=>/Auto-continuing run .* under its original approval \(1\/1\)/.test(m.content)));
 assert.ok(h.saved.some(e=>e.customType==='delivery-superseded-v1'));
});
test('an auto-continuation that blocks again waits for the user',async()=>{
 const finding={status:'changes_requested',summary:'Still broken',findings:['high: a:1 still broken']};
 const h=harness({readOutcome:active=>active.agent==='delivery-reviewer'?finding:approved,overrides:{autoContinue:true}});
 await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');
 const s=await settle(h,s=>s?.stage==='blocked' && s.autoContinuations===1);await new Promise(r=>setTimeout(r,20));
 assert.equal(h.state().stage,'blocked');assert.equal(h.state().run,s.run);assert.match(s.reason,/Correction round limit/);
 assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,6);
 await assert.rejects(h.invoke('delivery_execute'),/approval/i);
});
test('check-failure exhaustion derives a continuation from the failing receipt',async()=>{
 const snapshot={a:'hash',unrelated:'dirty'};let edits=0;
 const h=harness({checkCode:1,snapshot,readOutcome:active=>{if(active.stage==='coder')snapshot.a=`hash-${++edits}`;return approved;}});
 await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');
 assert.equal((await h.wait()).stage,'blocked');await h.input('continue');
 assert.equal(h.state().stage,'awaiting-approval');assert.match(h.state().plan.tasks[0].instructions,/Task check still failing: task-one/);
});
test('autonomous mode launches a displayed plan without an approval turn',async()=>{
 const h=harness({overrides:{autoApprove:true}});await h.start();await h.commands.delivery.handler('on',h.ctx);
 const response=await h.invoke('delivery_plan',plan());assert.match(textOf(response),/Autonomous mode: launched without an approval turn/);
 assert.equal((await h.wait()).stage,'complete');assert.ok(h.calls.some(c=>c.method==='spawn'&&c.params.agent==='delivery-coder'));
 const guidance=h.handlers.before_agent_start().message.content;assert.match(guidance,/Autonomous mode/);
});
test('autonomous mode fixes a failing final check without asking',async()=>{
 let finals=0;const h=harness({checkCode:command=>command==='final' && finals++===0?1:0,overrides:{autoApprove:true,autoContinue:true}});
 await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());
 const s=await settle(h,s=>s?.stage==='complete' && s.autoContinuations===1);
 assert.match(s.plan.title,/final checks/);assert.deepEqual(s.plan.tasks[0].checks,['final']);assert.deepEqual(s.plan.tasks[0].files,['a']);
 assert.match(s.plan.tasks[0].instructions,/final check failed: final exit=1/);
});
test('autonomous continuation that changes nothing stops instead of looping',async()=>{
 const h=harness({checkCode:command=>command==='final'?1:0,overrides:{autoApprove:true,autoContinue:true}});
 await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());
 const s=await settle(h,s=>s?.stage==='blocked' && s.autoContinuations===1);await new Promise(r=>setTimeout(r,30));
 assert.equal(h.state().run,s.run);assert.equal(h.state().stage,'blocked');assert.match(s.reason,/Final check failed/);
});
test('autonomous mode keeps continuing while making progress, up to the bound',async()=>{
 const finding={status:'changes_requested',summary:'Still broken',findings:['high: a:1 still broken']};
 const snapshot={a:'hash',unrelated:'dirty'};let edits=0;
 const h=harness({snapshot,readOutcome:active=>{if(active.agent==='delivery-coder'){snapshot.a=`hash-${++edits}`;return approved;}return active.agent==='delivery-reviewer'?finding:approved;},overrides:{autoApprove:true,autoContinue:true}});
 await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());
 const s=await settle(h,s=>s?.stage==='blocked' && s.autoContinuations===3);await new Promise(r=>setTimeout(r,30));
 assert.equal(h.state().run,s.run);assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,12);
});
test('each reviewed task is committed with its changed paths before the next task starts',async()=>{
 const snapshot={a:'hash',unrelated:'dirty'},commits=[];let edits=0;
 const h=harness({snapshot,readOutcome:active=>{if(active.agent==='delivery-coder')snapshot.a=`hash-${++edits}`;return approved;},overrides:{autoCommit:true,commitPaths:(root,paths,message)=>{commits.push({root,paths,message,task:h.state().task});snapshot['.git/HEAD']=`head-${commits.length}`;return `${commits.length}`.repeat(40);}}});
 await h.start();await h.commands.delivery.handler('on',h.ctx);const p=plan();p.tasks.push({...p.tasks[0],title:'Two'});
 await h.invoke('delivery_plan',p);await h.input('Approved');await h.invoke('delivery_execute');const s=await h.wait();
 assert.equal(s.stage,'complete',s.reason);assert.deepEqual(commits.map(c=>[c.task,c.paths]),[[0,['a']],[1,['a']]]);
 assert.equal(commits[0].root,'/workspace');assert.match(commits[0].message,/^One\n\nInspected source and evidence\n\nDelivery: Bounded change \(task 1\/2/);
 assert.equal(s.commits.length,2);assert.match(textOf(await h.invoke('delivery_status')),/Committed task 2: 2{12}/);
});
test('a failing commit is reported but never blocks the remaining work',async()=>{
 const snapshot={a:'hash',unrelated:'dirty'};
 const h=harness({snapshot,readOutcome:active=>{if(active.agent==='delivery-coder')snapshot.a='changed';return approved;},overrides:{autoCommit:true,commitPaths:()=>{throw new Error('Author identity unknown');}}});
 await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');
 const s=await h.wait();assert.equal(s.stage,'complete',s.reason);assert.match(s.commitFailures[0].error,/Author identity unknown/);
 assert.ok(h.messages.some(m=>/Commit skipped for task 1: Author identity unknown/.test(m.content)));
});
test('commit false in delivery.json disables per-task commits',async()=>{
 const models=['planning','coder','quality','security'];let called=0;
 const h=harness({overrides:{autoCommit:true,commitPaths:()=>{called++;return 'f'.repeat(40);},loadConfig:()=>({version:1,commit:false,routes:Object.fromEntries(models.map(m=>[m,`test/${m}`])),repos:['/workspace']})}});
 await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');
 assert.equal((await h.wait()).stage,'complete');assert.equal(called,0);
});
test('approval manual in delivery.json keeps the explicit approval gate',async()=>{
 const models=['planning','coder','quality','security'];
 const h=harness({overrides:{autoApprove:true,loadConfig:()=>({version:1,approval:'manual',routes:Object.fromEntries(models.map(m=>[m,`test/${m}`])),repos:['/workspace']})}});
 await h.start();await h.commands.delivery.handler('on',h.ctx);
 assert.match(textOf(await h.invoke('delivery_plan',plan())),/awaiting approval/);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 await assert.rejects(h.invoke('delivery_execute'),/approval/i);
});
test('review-only does not execute checks or a writer and findings cannot launch fixes',async()=>{
 const h=harness({reports:[{status:'changes_requested',summary:'Bug',findings:['a:1 bug']}]});await h.start();await h.commands.delivery.handler('on',h.ctx);const p=plan();p.mode='review';p.tasks[0].checks=[];p.checks=[];await h.invoke('delivery_plan',p);await h.input('Approved');await h.invoke('delivery_execute');const s=await h.wait();assert.equal(s.stage,'blocked');assert.equal(s.checks.length,0);assert.deepEqual(h.calls.filter(c=>c.method==='spawn').map(c=>c.params.agent),['delivery-reviewer']);
});
test('status distinguishes live same-process host check from closure lost after reload',async()=>{
 let finish,first=true;
 const h=harness({overrides:{verifyCommand:(_root,command)=>first?(first=false,new Promise(resolve=>{finish=resolve;})):Promise.resolve({command,code:0,signal:null,terminated:false,processClosed:true,output:'ok'})}});
 await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');
 for(let i=0;i<100&&!h.state().pendingCheck;i++)await new Promise(resolve=>setTimeout(resolve,1));
 assert.ok(h.state().pendingCheck);assert.match(h.messages.at(-1)?.content || '',/plan/i);
 assert.match((await h.invoke('delivery_status')).content[0].text,/Host check running/i);
 const r=harness({entries:h.saved});await r.start();assert.match((await r.invoke('delivery_status')).content[0].text,/Host check closure is unknown/i);
 finish({command:'task-one',code:0,signal:null,terminated:false,processClosed:true,output:'ok'});
 assert.equal((await h.wait()).stage,'complete');
});
test('failed checks stop at the bound without fabricated passing evidence',async()=>{
 // Coder keeps changing files, so each failure is a new attempt, not a stalled one.
 const snapshot={a:'hash',unrelated:'dirty'};let edits=0;
 const h=harness({checkCode:1,snapshot,readOutcome:active=>{if(active.stage==='coder')snapshot.a=`hash-${++edits}`;return approved;}});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');const s=await h.wait();assert.equal(s.stage,'blocked');assert.ok(s.checks.every(c=>c.code===1));assert.ok(!h.calls.some(c=>c.params?.agent==='delivery-reviewer'));
});
test('unchanged check failure after a no-change correction round is deferred to review, not retried',async()=>{
 const h=harness({checkCode:command=>command==='task-one'?1:0});await h.start();await h.commands.delivery.handler('on',h.ctx);
 await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');const s=await h.wait();
 assert.equal(s.stage,'complete',s.reason);assert.equal(s.round,1);
 assert.deepEqual(h.calls.filter(c=>c.method==='spawn').map(c=>c.params.agent),['delivery-coder','delivery-coder','delivery-reviewer']);
 const taskChecks=s.checks.filter(c=>c.command==='task-one');assert.deepEqual(taskChecks.map(c=>[c.round,c.code,Boolean(c.deferredToReview)]),[[0,1,false],[1,1,true]]);
 const review=h.calls.find(c=>c.params?.agent==='delivery-reviewer').params.task;assert.match(review,/Approve only if the acceptance explicitly permits this exact failure/);
 assert.match(textOf(await h.invoke('delivery_status')),/deferred to review verdict/);
});
test('reviewer rejecting a deferred check failure still ends at the correction bound',async()=>{
 const finding={status:'changes_requested',summary:'Failure not permitted',findings:['high: t:1 check still fails']};
 const h=harness({checkCode:command=>command==='task-one'?1:0,reports:[approved,approved,finding,approved,finding]});await h.start();await h.commands.delivery.handler('on',h.ctx);
 await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');const s=await h.wait();
 assert.equal(s.stage,'blocked');assert.match(s.reason,/Correction round limit/);assert.equal(s.round,2);assert.ok(!s.checks.some(c=>c.command==='final'));assert.equal(h.calls.filter(c=>c.params?.agent==='delivery-reviewer').length,2);
});
test('launch errors retain correlated unknown ownership and prevent duplicates',async()=>{
 const h=harness({spawnError:true});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');const s=await h.wait();assert.equal(s.stage,'blocked');assert.ok(s.active);
 const launch=h.calls.find(c=>c.method==='spawn');assert.equal(s.active.launchRequestId,launch.requestId);
 assert.match(s.reason,/request.*identity/i);assert.match(s.reason,/Provider unavailable/);
 await assert.rejects(h.invoke('delivery_execute'));await assert.rejects(h.invoke('delivery_plan',plan()));
 await assert.rejects(h.commands.delivery.handler('off',h.ctx),/native launch correlation.*no replacement/i);
 const before=h.state().stopping;
 await assert.rejects(h.commands.delivery.handler('stop',h.ctx),/native launch correlation.*no replacement/i);
 assert.equal(h.state().stopping,before,'refused stop must not create a false cancellation request');
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,1);
});
test('verified prelaunch native refusal permits fresh plan, preserves old receipts and requires new approval',async()=>{
 const locks=[],original='Run fan-out: 1/64 used, 63 remaining\\nOriginal prelaunch refusal';
 const h=harness({spawnError:true,onLock:(...args)=>locks.push(args),overrides:{inspectLock:()=>({fence:'retained'}),proveNativePrelaunch:(_active,reason)=>{assert.equal(reason,original);return {kind:'native-prelaunch-refusal',source:'verified'};}}});
 await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');await h.wait();
 const state=h.state();state.active.stage='security';state.active.agent='delivery-security';state.stopping=true;
 state.reason=original;h.saved.push({type:'custom',customType:'delivery-coordinator-v2',data:structuredClone(state)});
 state.reason='Stop not confirmed: unknown worker';
 await h.start();await h.invoke('delivery_plan',plan());
 assert.equal(h.state().stage,'awaiting-approval');assert.equal(h.state().active,null);
 assert.ok(h.saved.some(e=>e.customType==='delivery-superseded-v1'));
 assert.ok(locks.some(([action])=>action==='release'));
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,1);
 await assert.rejects(h.invoke('delivery_execute'),/approval/i);
});
test('closed native failed reviewer missing structured tool output gets fresh reviewed recovery without coder replay',async()=>{
 let reviews=0;
 const nativeFailure=active=>{
  const error=new Error(`Native worker ${active.id} failed: Missing structured_output call; this step has outputSchema and must finish by calling structured_output.`);
  error.closed=true;error.nativeState='failed';throw error;
 };
 const closure=active=>{
  const message='Missing structured_output call; this step has outputSchema and must finish by calling structured_output.';
  const outputPath=join(active.dir,'structured-output/output.json');
  return {status:{runId:active.id,sessionId:active.nativeSession,state:'failed',error:message,steps:[{agent:active.agent,model:active.model,attemptedModels:[active.model],status:'failed',error:message,structuredOutputPath:outputPath,effects:{settlementDiagnostic:{mutation:{expected:false,attempted:false,observed:false},requiredOutput:{kind:'structured',path:outputPath,missing:true}}}}]},terminal:terminalProof(active.id)};
 };
 const h=harness({readOutcome:active=>active.stage==='quality' && reviews++<2?{status:'changes_requested',summary:'Concrete fix required',findings:['high: a:1 fix']}:active.stage==='quality' && reviews===3?nativeFailure(active):approved,overrides:{readNativeClosure:closure}});
 await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');
 assert.equal((await h.wait()).stage,'blocked');assert.equal(h.state().round,2);assert.equal(h.state().failure.reason,'review_report_invalid');assert.equal(h.state().leased,true);
 // Simulate the historical journal saved before failed-step classification existed.
 const historical=structuredClone(h.state());const failedNative=historical.failure.native;
 historical.failure={stage:'quality',reason:'infrastructure_or_product_failure'};historical.leased=false;historical.lockFence=null;
 historical.reason=`Native worker ${failedNative.id} failed: Missing structured_output call; this step has outputSchema and must finish by calling structured_output.`;
 const entries=[...h.saved,{type:'custom',customType:'delivery-coordinator-v2',data:historical}];
 let releases=0;
 const r=harness({entries,overrides:{readNativeClosure:closure,assertNoLock:()=>{},inspectLock:()=>{},acquireLock:()=>`fence-${++releases}`,releaseLock:()=>{}},readOutcome:()=>approved});
 await r.start();await r.input('continue');assert.equal(r.state().stage,'awaiting-recovery-approval');
 assert.equal(r.calls.filter(c=>c.method==='spawn').length,0);
 await assert.rejects(r.invoke('delivery_recovery_execute'),/approval/i);
 await r.input('Approved');await r.invoke('delivery_recovery_execute');assert.equal((await r.wait()).stage,'complete');
 assert.equal(r.calls.filter(c=>c.method==='spawn' && c.params.agent==='delivery-coder').length,0);
 assert.equal(r.calls.filter(c=>c.method==='spawn' && c.params.agent==='delivery-reviewer').length,1);
});
test('failed reviewer without verified native closure retains exact worker and lease',async()=>{
 const h=harness({readOutcome:active=>{
  if(active.stage!=='quality')return approved;
  const error=new Error(`Native worker ${active.id} failed: Missing structured_output call; this step has outputSchema and must finish by calling structured_output.`);
  error.closed=true;error.nativeState='failed';throw error;
 },overrides:{readNativeClosure:()=>null}});
 await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');
 const s=await h.wait();assert.equal(s.stage,'blocked');assert.equal(s.leased,true);assert.ok(s.active?.id);assert.equal(s.failure.reason,'infrastructure_or_product_failure');
 await assert.rejects(h.invoke('delivery_recovery_plan'));assert.equal(h.calls.filter(c=>c.method==='spawn').length,2);
});
test('confirmed route changes and setup reselect the planning model immediately while enabled',async()=>{
 let savedRoutes=null;
 const h=harness({overrides:{
  loadConfig:()=>({version:1,routes:{planning:'test/planning',coder:'test/coder',quality:'test/quality',security:'test/security'},repos:['/workspace']}),
  configPath:()=>'isolated-delivery.json',
  saveConfig:(_path,c)=>{savedRoutes=c.routes;}
 }});
 await h.start();await h.commands.delivery.handler('on',h.ctx);
 assert.deepEqual(h.modelSets,[{provider:'test',id:'planning'}]);
 await h.invoke('delivery_configure',{routes:{quality:'test/security'}});
 assert.equal(savedRoutes.quality,'test/security');
 assert.deepEqual(h.modelSets,[{provider:'test',id:'planning'},{provider:'test',id:'planning'}]);
 h.ctx.ui.select=async(_,options)=>options[0];
 await h.commands.delivery.handler('setup',h.ctx);
 assert.deepEqual(savedRoutes.quality,'test/planning');
 assert.deepEqual(h.modelSets,Array(3).fill({provider:'test',id:'planning'}));
});
test('malformed worker report blocks rather than implying approval',async()=>{
 const h=harness({reports:[{status:'approved',summary:'ok',findings:['unresolved']}]});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');assert.match((await h.wait()).reason,/report/i);
});
test('concurrent execute calls and reload do not duplicate known live workers',async()=>{
 const h=harness({live:true});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');await assert.rejects(h.invoke('delivery_execute'));await new Promise(r=>setTimeout(r,5));await h.handlers.session_shutdown({},h.ctx);
 const resumed=harness({entries:h.saved,live:true});await resumed.start();assert.equal(resumed.calls.filter(c=>c.method==='spawn').length,0);await resumed.commands.delivery.handler('resume',resumed.ctx);await new Promise(r=>setTimeout(r,5));assert.equal(resumed.calls.filter(c=>c.method==='spawn').length,0);await resumed.commands.delivery.handler('stop',resumed.ctx);assert.ok(resumed.calls.some(c=>c.method==='stop'));await resumed.handlers.session_shutdown({},resumed.ctx);
});
test('legacy journals are preserved and never migrated or resumed',async()=>{
 const old={type:'custom',customType:'delivery-mode-v1',data:{enabled:true,stage:'coder',active:{id:'old'}}};const h=harness({entries:[old]});await h.start();await assert.rejects(h.commands.delivery.handler('on',h.ctx),/legacy|unsupported/i);assert.deepEqual(h.saved,[old]);assert.equal(h.calls.length,0);
});
test('stopped native worker is observed without running checks, reviewers or replacement',async()=>{
 const h=harness({live:true});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');await new Promise(r=>setTimeout(r,5));await h.commands.delivery.handler('stop',h.ctx);await h.handlers.session_shutdown({},h.ctx);
 const resumed=harness({entries:h.saved,reports:[approved]});await resumed.start();await resumed.commands.delivery.handler('resume',resumed.ctx);const s=await resumed.wait();assert.equal(s.stage,'stopped');assert.equal(s.checks.length,0);assert.equal(resumed.calls.filter(c=>c.method==='spawn').length,0);
});
test('reload after native infrastructure failure monitors original worker stage only',async()=>{
 const h=harness({live:true});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');await new Promise(r=>setTimeout(r,5));await h.handlers.session_shutdown({},h.ctx);
 const entry=h.saved.filter(e=>e.customType==='delivery-coordinator-v2').at(-1);entry.data.stage='blocked';entry.data.reason='status timed out';
 const r=harness({entries:h.saved});await r.start();await r.commands.delivery.handler('resume',r.ctx);assert.equal((await r.wait()).stage,'complete');assert.equal(r.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,0);
});
test('planning-only input invalidates earlier approval and replacing the proposal requires a new turn',async()=>{
 const h=harness();await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.input('Just explain the plan');await assert.rejects(h.invoke('delivery_execute'),/approval/);await h.input('Approved');await h.invoke('delivery_plan',plan());await assert.rejects(h.invoke('delivery_execute'),/approval/);
});
test('delivery never strips or blocks the session tools, so work can always continue',async()=>{
 const h=harness();await h.start();await h.commands.delivery.handler('on',h.ctx);
 for(const toolName of ['read','bash','write','subagent'])assert.ok(h.activeTools.includes(toolName),toolName);
 assert.ok(h.activeTools.includes('delivery_plan'));
 assert.equal(h.handlers.tool_call,undefined);assert.equal(h.handlers.user_bash,undefined);
});
test('legacy off cannot write a new entry that hides unresolved old ownership',async()=>{
 const old={type:'custom',customType:'delivery-mode-v1',data:{stage:'coder',active:{id:'unknown'}}};const h=harness({entries:[old]});await h.start();await assert.rejects(h.commands.delivery.handler('off',h.ctx),/legacy|unsupported/i);assert.deepEqual(h.saved,[old]);
});
test('session switch resets proposal/approval instead of leaking another session plan',async()=>{
 const h=harness();await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');
 const other={...h.ctx,sessionManager:{getBranch:()=>[],getSessionId:()=> 'other'}};
 assert.equal(typeof h.handlers.session_switch,'function');await h.handlers.session_switch({},other);await assert.rejects(h.invoke('delivery_execute'),/OFF|approval/);
});
test('setup cannot change routes while an approved worker is starting or running',async()=>{
 const h=harness({live:true});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');await assert.rejects(h.commands.delivery.handler('setup',h.ctx),/ownership|running|live|proposal/);await h.handlers.session_shutdown({},h.ctx);
});
test('approved file scopes cannot include opaque symlinks',async()=>{
 const h=harness({snapshot:{a:'symlink:opaque'}});await h.start();await h.commands.delivery.handler('on',h.ctx);await assert.rejects(h.invoke('delivery_plan',plan()),/symlink/);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('blocked status monitoring retains scoped partial coder edits on resume',async()=>{
 const snapshot={a:'hash',unrelated:'dirty'},h=harness({live:true,snapshot});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');await new Promise(r=>setTimeout(r,5));await h.handlers.session_shutdown({},h.ctx);
 const entry=h.saved.filter(e=>e.customType==='delivery-coordinator-v2').at(-1);entry.data.stage='blocked';entry.data.reason='native status temporarily unavailable';
 const resumed=harness({entries:h.saved,snapshot:{...snapshot,a:'partial'}});await resumed.start();await resumed.commands.delivery.handler('resume',resumed.ctx);assert.equal((await resumed.wait()).stage,'complete');assert.equal(resumed.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,0);
});
test('completion persists released lease and checks even a final-check-free snapshot',async()=>{
 const snapshot={a:'hash',unrelated:'dirty'};let changed=false;
 const h=harness({snapshot,onSave:s=>{if(s.stage==='final-checks'&&!changed){changed=true;snapshot.a='raced';}}});await h.start();await h.commands.delivery.handler('on',h.ctx);const p=plan();p.checks=[];await h.invoke('delivery_plan',p);await h.input('Approved');await h.invoke('delivery_execute');assert.equal((await h.wait()).stage,'blocked');
 const good=harness();await good.start();await good.commands.delivery.handler('on',good.ctx);await good.invoke('delivery_plan',plan());await good.input('Approved');await good.invoke('delivery_execute');assert.equal((await good.wait()).leased,false);
});
test('lease-release infrastructure errors remain actionable without an unhandled async failure',async()=>{
 const h=harness({releaseError:true});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');const s=await h.wait();assert.equal(s.stage,'blocked');assert.match(s.reason,/Lock ownership changed/);assert.equal(s.leased,true);
});
test('stop during native preflight cannot let another unapproved proposal launch',async()=>{
 const h=harness({delayPing:10});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');const pending=h.invoke('delivery_execute');await h.commands.delivery.handler('stop',h.ctx);await assert.rejects(h.invoke('delivery_plan',plan()),/live|unresolved|starting/);await assert.rejects(pending,/cancel|stop/i);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});

const textOf=result=>result.content.map(part=>part.text || '').join('\n');
async function executePlan(h,p=plan()) {
 await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',p);await h.input('Approved');await h.invoke('delivery_execute');return h.wait();
}
test('completed status and terminal text expose actual checks and reviewer evidence',async()=>{
 const h=harness();const p=plan();p.security=true;assert.equal((await executePlan(h,p)).stage,'complete');
 const terminal=h.messages.at(-1).content,status=await h.invoke('delivery_status');await h.commands.delivery.handler('status',h.ctx);
 for(const text of [terminal,textOf(status),h.messages.at(-1).content]) {
  assert.match(text,/task-one.*exit=0/);assert.match(text,/final.*exit=0/);
  assert.match(text,/quality: approved/);assert.match(text,/security: approved/);assert.match(text,/Inspected source and evidence/);
 }
 assert.equal(status.details.checks[0].output,'actual output');assert.equal(status.details.reports.length,3);
});
test('read-only findings are visible in status and blocked messages without a writer',async()=>{
 const finding={status:'changes_requested',summary:'Parser accepts unsafe input',findings:['high: a:17 reject the unsafe input']};
 const h=harness({reports:[finding]}),p=plan();p.mode='review';p.tasks[0].checks=[];p.checks=[];assert.equal((await executePlan(h,p)).stage,'blocked');
 const terminal=h.messages.at(-1).content,status=await h.invoke('delivery_status');await h.commands.delivery.handler('status',h.ctx);
 for(const text of [terminal,textOf(status),h.messages.at(-1).content]) {
  assert.match(text,/quality: changes_requested/);assert.match(text,/Parser accepts unsafe input/);assert.match(text,/high: a:17 reject the unsafe input/);assert.match(text,/No host checks executed/);
 }
 assert.deepEqual(h.calls.filter(c=>c.method==='spawn').map(c=>c.params.agent),['delivery-reviewer']);
});
test('exhausted correction text reports latest findings rather than superseded rounds',async()=>{
 const finding=n=>({status:'changes_requested',summary:`Review round ${n}`,findings:[`high: a:${n} remaining defect ${n}`]});
 const h=harness({reports:[approved,finding(1),approved,finding(2),approved,finding(3)]});assert.equal((await executePlan(h)).stage,'blocked');
 for(const text of [h.messages.at(-1).content,textOf(await h.invoke('delivery_status'))]) {
  assert.match(text,/Correction round limit/);assert.match(text,/Review round 3/);assert.match(text,/a:3 remaining defect 3/);assert.match(text,/task-one.*exit=0/);
  assert.doesNotMatch(text,/remaining defect [12]/);
 }
});
test('corrected completion text does not present old findings or failed checks as current blockers',async()=>{
 const finding={status:'changes_requested',summary:'Earlier failed review',findings:['high: a:1 superseded defect']};
 const h=harness({reports:[approved,finding,approved,approved]});assert.equal((await executePlan(h)).stage,'complete');
 const status=await h.invoke('delivery_status');
 for(const text of [h.messages.at(-1).content,textOf(status)]) {
  assert.match(text,/quality: approved/);assert.match(text,/task-one.*exit=0/);assert.doesNotMatch(text,/superseded defect|Earlier failed review|changes_requested/);
 }
 assert.equal(status.details.reports[1].report.findings[0],'high: a:1 superseded defect');
 // Include a previous failed check in retained history; the current passing receipt remains authoritative.
 const retained=structuredClone(h.state());retained.checks.unshift({...retained.checks[0],round:0,code:1,output:'old check failure'});
 const reloaded=harness({entries:[{type:'custom',customType:'delivery-coordinator-v2',data:retained}]});await reloaded.start();
 const current=await reloaded.invoke('delivery_status');assert.match(textOf(current),/task-one.*exit=0/);assert.doesNotMatch(textOf(current),/exit=1|old check failure/);assert.equal(current.details.checks[0].code,1);
});
test('large status evidence is bounded in text while full findings and outputs remain in details',async()=>{
 const finding={status:'changes_requested',summary:'Actionable latest review '+ 's'.repeat(7900),findings:Array.from({length:50},(_,i)=>`high: a:${i+1} ${'f'.repeat(1900)}`)};
 const retained={version:2,enabled:true,stage:'blocked',plan:plan(),root:'/workspace',session:'session',task:0,round:2,active:null,reason:'Correction round limit exhausted',reports:[{task:0,round:2,stage:'quality',report:finding}],checks:Array.from({length:10},(_,i)=>({task:0,round:2,command:`check-${i}`,code:1,signal:null,terminated:false,output:'o'.repeat(40000)}))};
 const h=harness({entries:[{type:'custom',customType:'delivery-coordinator-v2',data:retained}]});await h.start();const status=await h.invoke('delivery_status');await h.commands.delivery.handler('status',h.ctx);
 for(const text of [textOf(status),h.messages.at(-1).content]) {
  assert.ok(text.length<=12000,`Report length ${text.length}`);assert.match(text,/quality: changes_requested/);assert.match(text,/Actionable latest review/);assert.match(text,/high: a:1/);assert.match(text,/check-9.*exit=1/);assert.match(text,/truncated|omitted/i);
 }
 assert.deepEqual(status.details.reports[0].report,finding);assert.equal(status.details.checks[0].output.length,40000);
});

test('unlisted related files reach reviews and status across corrections without more approval',async()=>{
 const snapshot={a:'hash',unrelated:'dirty'};let round=0;
 const finding={status:'changes_requested',summary:'Fix related view',findings:['high: views/item.erb:1 fix rendering']};
 const h=harness({snapshot,reports:[approved,finding,approved,approved],onSave:s=>{
  if(s.active?.stage==='coder' && s.active.id && round===s.round){snapshot[round===0?'lib/item.rb':'views/item.erb']='implemented';round++;}
 }});
 const s=await executePlan(h);assert.equal(s.stage,'complete',s.reason);
 assert.deepEqual(s.changedPaths[0],['lib/item.rb','views/item.erb']);assert.equal(snapshot.unrelated,'dirty');
 const reviews=h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-reviewer');
 assert.match(reviews[0].params.task,/Actual changed paths.*lib\/item.rb/);
 assert.match(reviews[1].params.task,/Actual changed paths.*lib\/item.rb.*views\/item.erb/);
 assert.match(reviews[1].params.task,/Preexisting work.*dirty diff/s);
 assert.match(textOf(await h.invoke('delivery_status')),/lib\/item.rb.*views\/item.erb/s);
});
test('resume accepts additional coder files and records them for independent review',async()=>{
 const h=harness({live:true});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');await new Promise(r=>setTimeout(r,5));await h.handlers.session_shutdown({},h.ctx);
 const resumed=harness({entries:h.saved,snapshot:{a:'hash',unrelated:'dirty','related.rb':'partial'}});await resumed.start();await resumed.commands.delivery.handler('resume',resumed.ctx);
 const s=await resumed.wait();assert.equal(s.stage,'complete',s.reason);assert.deepEqual(s.changedPaths[0],['related.rb']);
 assert.equal(resumed.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,0);
});
test('newly discovered sensitive files require the exact security route bound before execution',async()=>{
 const snapshot={a:'hash'};
 const h=harness({snapshot,onSave:s=>{if(s.active?.stage==='coder'&&s.active.id)snapshot['auth/session.rb']='fix';}});
 const s=await executePlan(h);assert.equal(s.stage,'complete',s.reason);assert.equal(s.routes.security,'test/security');
 const launches=h.calls.filter(c=>c.method==='spawn');assert.deepEqual(launches.map(c=>c.params.model),['test/coder','test/quality','test/security']);assert.match(launches[2].params.task,/Actual changed paths.*auth\/session.rb/);
});
test('implementation binds a configured security route even before sensitive paths are discovered',async()=>{
 const h=harness();h.ctx.modelRegistry.getAvailable=()=>['planning','coder','quality'].map(id=>({provider:'test',id}));
 await h.start();await h.commands.delivery.handler('on',h.ctx);await assert.rejects(h.invoke('delivery_plan',plan()),/security/);assert.equal(h.calls.length,0);
});
for(const stage of ['coder','quality','check'])test(`${stage} cannot change Git metadata; reviewers and checks cannot edit any source`,async()=>{
 for(const path of ['.git/index','.git/HEAD',...(stage==='coder'?[]:['related.rb'])]) {
  const snapshot={a:'hash','.git/index':'index','.git/HEAD':'head'};let changed=false;
  const h=harness({snapshot,onSave:s=>{if(!changed && (stage==='check'?s.pendingCheck:s.active?.stage===stage&&s.active.id)){snapshot[path]='mutated';changed=true;}}});
  const s=await executePlan(h);assert.equal(s.stage,'blocked');assert.match(s.reason,/changed|metadata/);
 }
});
test('coder cannot introduce an unlisted symlink',async()=>{
 const snapshot={a:'hash'},h=harness({snapshot,onSave:s=>{if(s.active?.stage==='coder'&&s.active.id)snapshot.related='symlink:external';}});
 const s=await executePlan(h);assert.equal(s.stage,'blocked');assert.match(s.reason,/symlink/);
});
test('task check correction fixes related files under original approval and bounded rounds',async()=>{
 const snapshot={a:'hash'};let checks=0;
 const h=harness({snapshot,checkCode:command=>command==='task-one'&&checks++===0?1:0,onSave:s=>{if(s.active?.stage==='coder'&&s.active.id&&s.round===1)snapshot['tests/related.test.rb']='fixed';}});
 const s=await executePlan(h);assert.equal(s.stage,'complete',s.reason);assert.equal(s.round,1);assert.deepEqual(s.changedPaths[0],['tests/related.test.rb']);
 assert.deepEqual(s.checks.map(c=>c.code),[1,0,0]);assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,2);
});
test('sensitive paths discovered in a correction persist through later rounds even when reverted',async()=>{
 const snapshot={a:'hash'};let written=false,reverted=false;
 const finding={status:'changes_requested',summary:'Correct task behavior',findings:['high: a:1 correct behavior']};
 const h=harness({snapshot,reports:[approved,finding,approved,approved,finding,approved,approved,approved],onSave:s=>{
  if(s.active?.stage!=='coder'||!s.active.id)return;
  if(s.round===1&&!written){snapshot['auth/session.rb']='fix';written=true;}
  if(s.round===2&&!reverted){delete snapshot['auth/session.rb'];reverted=true;}
 }});
 const s=await executePlan(h);assert.equal(s.stage,'complete',s.reason);assert.deepEqual(s.changedPaths[0],['auth/session.rb']);
 assert.deepEqual(h.calls.filter(c=>c.method==='spawn').map(c=>c.params.agent),['delivery-coder','delivery-reviewer','delivery-coder','delivery-reviewer','delivery-security','delivery-coder','delivery-reviewer','delivery-security']);
});
test('final-check failure preserves evidence without guessing task attribution or replaying completed work',async()=>{
 const h=harness({checkCode:command=>command==='final'?1:0});const s=await executePlan(h);
 assert.equal(s.stage,'blocked');assert.match(s.reason,/automatic attribution.*unavailable/);assert.equal(s.round,0);
 assert.deepEqual(s.checks.map(c=>c.code),[0,1]);assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,1);
});
test('newly required security never launches with a missing bound route in a retained worker',async()=>{
 const h=harness({live:true});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');await new Promise(r=>setTimeout(r,5));await h.handlers.session_shutdown({},h.ctx);
 const entry=h.saved.filter(e=>e.customType==='delivery-coordinator-v2').at(-1);delete entry.data.routes.security;
 const resumed=harness({entries:h.saved,snapshot:{a:'hash',unrelated:'dirty','auth/session.rb':'fix'}});await resumed.start();await resumed.commands.delivery.handler('resume',resumed.ctx);
 const s=await resumed.wait();assert.equal(s.stage,'blocked');assert.match(s.reason,/exact model route: security/);assert.ok(!resumed.calls.some(c=>c.method==='spawn'&&c.params.agent==='delivery-security'));
});

const parentUUID='37ea2a5e-f069-4e6a-9b1f-a08d309df5e7';
function nativeArtifacts(t,{sessionFile=join(tmpdir(),'delivery-parent.jsonl'),sessionId=parentUUID,live=false}={}) {
 const dir=mkdtempSync(join(tmpdir(),'delivery-owner-test-')),workers=[];
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 function write(worker,patch={}) {
  Object.assign(worker.status,patch);writeFileSync(join(worker.dir,'status.json'),JSON.stringify(worker.status));
 }
 return {sessionFile,sessionId,readOutcome,nativeStatus:readNativeStatus,workers,write,spawn(params){
  const n=workers.length+1,asyncDir=join(dir,String(n));mkdirSync(asyncDir);
  const runId=`native-${n}`,report=join(asyncDir,'report.json');
  const worker={dir:asyncDir,status:{runId,sessionId:sessionFile ?? sessionId,state:live&&workers.length===0?'running':'complete',steps:[{agent:params.agent,model:params.model,attemptedModels:[params.model],sessionFile:join(asyncDir,'child.jsonl'),structuredOutputPath:report}]}};
  workers.push(worker);write(worker);
  writeFileSync(report,JSON.stringify(approved));
  writeFileSync(join(asyncDir,'process-terminal.json'),JSON.stringify(terminalProof(runId)));
  return {runId,asyncDir};
 }};
}
test('persisted native owner path completes through real readOutcome while journal and lock retain parent UUID',async t=>{
 const native=nativeArtifacts(t),locks=[];
 const h=harness({...native,onLock:(_method,_root,owner)=>locks.push(owner.session),onSave:s=>{if(s.active)assert.equal(s.active.nativeSession,native.sessionFile);}});
 const s=await executePlan(h);
 assert.equal(s.stage,'complete',s.reason);
 assert.equal(s.session,parentUUID);assert.ok(locks.length);assert.ok(locks.every(session=>session===parentUUID));
 assert.ok(s.reports.every(r=>r.native.nativeSession===native.sessionFile));
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,2);
});
for(const sessionFile of [null,undefined])test(`nonpersisted native owner falls back to parent UUID (${sessionFile})`,async t=>{
 const native=nativeArtifacts(t,{sessionFile:null});native.sessionFile=sessionFile;
 const h=harness(native),s=await executePlan(h);
 assert.equal(s.stage,'complete',s.reason);assert.ok(s.reports.every(r=>r.native.nativeSession===parentUUID));
});
for(const sessionFile of ['', '   ',42])test(`invalid native owner is rejected before spawn (${JSON.stringify(sessionFile)})`,async t=>{
 const h=harness(nativeArtifacts(t,{sessionFile})),s=await executePlan(h);
 assert.equal(s.stage,'blocked');assert.match(s.reason,/session.*identity|owner.*session/i);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
async function retainedNativeWorker(t,{old=false,sessionFile}={}) {
 const native=nativeArtifacts(t,{live:true,...(sessionFile===undefined?{}:{sessionFile})}),h=harness(native);
 await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');
 await new Promise(r=>setTimeout(r,5));await h.handlers.session_shutdown({},h.ctx);
 const retained=structuredClone(h.state());retained.stage='blocked';retained.reason='Retained worker awaiting monitoring';
 if(old)delete retained.active.nativeSession;
 return {native,retained,entries:[{type:'custom',customType:'delivery-coordinator-v2',data:retained}]};
}
for(const old of [false,true])test(`${old?'old UUID-bound v2':'current path-bound'} worker reload consumes original worker without duplicate coding or checks`,async t=>{
 const {native,retained,entries}=await retainedNativeWorker(t,{old});
 native.write(native.workers[0],{state:'complete'});
 const original=structuredClone(retained.active),h=harness({...native,entries});await h.start();
 assert.equal(h.calls.length,0);await h.commands.delivery.handler('resume',h.ctx);
 const s=await h.wait();assert.equal(s.stage,'complete',s.reason);
 assert.equal(s.reports[0].native.id,original.id);assert.equal(s.reports[0].native.dir,original.dir);
 assert.equal(s.reports[0].native.nativeSession,native.sessionFile);assert.equal(s.session,parentUUID);
 assert.deepEqual(h.calls.filter(c=>c.method==='spawn').map(c=>c.params.agent),['delivery-reviewer']);
 assert.deepEqual(s.checks.map(c=>c.command),['task-one','final']);
});
for(const old of [false,true])test(`${old?'old v2':'current'} worker stop/resume observes closure without replacement`,async t=>{
 const {native,entries}=await retainedNativeWorker(t,{old}),h=harness({...native,entries});await h.start();
 await h.commands.delivery.handler('stop',h.ctx);native.write(native.workers[0],{state:'stopped'});
 await h.commands.delivery.handler('resume',h.ctx);const s=await h.wait();assert.equal(s.stage,'stopped',s.reason);
 assert.equal(s.active,null);assert.equal(s.checks.length,0);assert.equal(s.reports.length,0);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);assert.equal(h.calls.filter(c=>c.method==='stop').length,1);
});
for(const patch of [{sessionId:'/foreign/parent.jsonl'},{sessionId:parentUUID},{runId:'foreign-run'}])test(`old v2 binding does not trust returned identity ${JSON.stringify(patch)}`,async t=>{
 const {native,retained,entries}=await retainedNativeWorker(t,{old:true});native.write(native.workers[0],{state:'complete',...patch});
 const h=harness({...native,entries});await h.start();await h.commands.delivery.handler('resume',h.ctx);const s=await h.wait();
 assert.equal(s.stage,'blocked');assert.match(s.reason,patch.runId?/run-ID/:/owner-session/);
 assert.equal(s.active.id,retained.active.id);assert.equal(s.active.dir,retained.active.dir);assert.equal(s.active.nativeSession,native.sessionFile);
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);assert.equal(s.checks.length,0);
 await assert.rejects(h.invoke('delivery_plan',plan()),/live|unresolved/);
});
for(const patch of [{session:'foreign-uuid'},{root:'/foreign-repository'},{session:undefined},{root:undefined}])test(`old v2 normalization requires verified parent UUID and repository ${JSON.stringify(patch)}`,async t=>{
 const {native,retained,entries}=await retainedNativeWorker(t,{old:true});Object.assign(retained,patch);
 const h=harness({...native,entries});await h.start();await assert.rejects(h.commands.delivery.handler('resume',h.ctx),/legacy|unsupported|owner|session|repository/i);
 assert.equal(h.calls.length,0);assert.equal(retained.active.nativeSession,undefined);
});
for(const patch of [{session:'foreign-uuid'},{nativeSession:'/foreign/parent.jsonl'},{nativeSession:''},{dir:null}])test(`retained worker cannot be rebound from ambiguous binding ${JSON.stringify(patch)}`,async t=>{
 const {native,retained,entries}=await retainedNativeWorker(t,{old:true});Object.assign(retained.active,patch);
 const h=harness({...native,entries});await h.start();await assert.rejects(h.commands.delivery.handler('resume',h.ctx),/owner|session|identity/i);
 assert.equal(h.calls.length,0);
});
test('new nonpersisted binding is not normalized when a session file later appears',async t=>{
 const {native,retained,entries}=await retainedNativeWorker(t,{sessionFile:null});
 const h=harness({...native,entries,sessionFile:'/new/parent.jsonl'});await h.start();
 await assert.rejects(h.commands.delivery.handler('resume',h.ctx),/owner.session/i);assert.equal(h.calls.length,0);
 assert.equal(retained.active.nativeSession,parentUUID);
});
test('retained v2 quality worker normalization never replays finished coding or task checks',async t=>{
 const {native,retained,entries}=await retainedNativeWorker(t,{old:true});
 retained.active.stage='quality';retained.active.agent='delivery-reviewer';retained.active.model='test/quality';
 retained.reports=[{task:0,round:0,stage:'coder',native:{id:'finished-coder'},report:approved}];
 retained.checks=[{task:0,round:0,command:'task-one',code:0,processClosed:true,output:'Retained passing check'}];
 const worker=native.workers[0];native.write(worker,{state:'complete',steps:[{...worker.status.steps[0],agent:'delivery-reviewer',model:'test/quality',attemptedModels:['test/quality']}]});
 const h=harness({...native,entries});await h.start();await h.commands.delivery.handler('resume',h.ctx);const s=await h.wait();
 assert.equal(s.stage,'complete',s.reason);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 assert.deepEqual(s.reports.map(r=>r.stage),['coder','quality']);assert.deepEqual(s.checks.map(c=>c.command),['task-one','final']);
 assert.equal(s.checks[0].output,'Retained passing check');assert.equal(s.reports[1].native.id,retained.active.id);
});
test('retained nonpersisted v2 worker binds the same UUID and observes stopped closure',async t=>{
 const {native,retained,entries}=await retainedNativeWorker(t,{old:true,sessionFile:null});retained.stopping=true;
 native.write(native.workers[0],{state:'stopped'});
 const h=harness({...native,entries});await h.start();await h.commands.delivery.handler('resume',h.ctx);
 assert.equal((await h.wait()).stage,'stopped');assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 assert.ok(h.saved.some(e=>e.data?.active?.nativeSession===parentUUID));
});
test('nonpersisted missing parent identity cannot launch',async t=>{
 const h=harness(nativeArtifacts(t,{sessionFile:null,sessionId:''})),s=await executePlan(h);
 assert.equal(s.stage,'blocked');assert.match(s.reason,/session.*ownership|identity/);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
});
test('resume and stop are public empty-schema tools allowed by the parent gate',async()=>{
 const h=harness();await h.start();await h.commands.delivery.handler('on',h.ctx);
 for(const name of ['delivery_resume','delivery_stop']) {
  assert.ok(h.tools[name]);assert.ok(h.activeTools.includes(name));assert.deepEqual(h.tools[name].parameters.properties,{});
  assert.equal(h.tools[name].parameters.additionalProperties,false);
  assert.equal(h.handlers.tool_call,undefined);
  await assert.rejects(h.invoke(name,{message:'replace the worker'}),/unsupported/);
 }
});
test('blocked guidance points continue to model-callable observation without approval or unmanaged tools',async t=>{
 const {native,entries}=await retainedNativeWorker(t,{old:true}),h=harness({...native,entries});await h.start();
 assert.match(textOf(await h.invoke('delivery_status')),/delivery_resume/);
 assert.match(textOf(await h.invoke('delivery_status')),/no.*approval|without.*approval/i);
 await h.input('Approved');await assert.rejects(h.invoke('delivery_execute'),/live|unresolved/);
 const response=await h.invoke('delivery_stop');assert.match(textOf(response),/requested.*not.*closed/i);
 assert.match(textOf(response),/delivery_resume/);assert.equal(h.calls.filter(c=>c.method==='stop').length,1);
 await h.handlers.session_shutdown();
});
for(const outcome of ['complete','failed','stopped','stop requested','missing proof','live owner','pending check'])test(`full restart retained reviewer: ${outcome}, real filesystem lock, no accepted work replay`,async t=>{
 const {spawnSync}=await import('node:child_process'),{readFileSync,readdirSync}=await import('node:fs');
 const {native,retained,entries}=await retainedNativeWorker(t,{old:true});
 const root=mkdtempSync(join(tmpdir(),'delivery-restart-lock-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const oldEnv=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=join(root,'agent');t.after(()=>{if(oldEnv===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldEnv;});
 retained.root=root;retained.active.stage='quality';retained.active.agent='delivery-reviewer';retained.active.model='test/quality';
 retained.leased=false; // recovery must persist newly acquired ownership, not trust this old flag
 retained.plan.checks=[];
 retained.reports=[{task:0,round:0,stage:'coder',native:{id:'accepted-coder'},report:approved}];
 retained.checks=[{task:0,round:0,command:'task-one',code:0,processClosed:true,output:'Accepted receipt'}];
 if(outcome==='stop requested')retained.stopping=true;
 if(outcome==='pending check')retained.pendingCheck='unfinished';
 const worker=native.workers[0];native.write(worker,{state:['failed','stopped'].includes(outcome)?outcome:'complete',steps:[{...worker.status.steps[0],agent:retained.active.agent,model:retained.active.model,attemptedModels:[retained.active.model]}]});
 if(outcome==='missing proof'){rmSync(join(worker.dir,'process-terminal.json'));retained.stage='quality';}
 const dead=Number(spawnSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8'}).stdout.trim());
 const oldOwner={session:parentUUID,run:retained.run,pid:outcome==='live owner'?process.pid:dead};
 // A live owner means a different live process, not this same-process reload.
 let live;
 if(outcome==='live owner') {
  const {spawn}=await import('node:child_process');live=spawn(process.execPath,['-e','setTimeout(()=>{},30000)']);oldOwner.pid=live.pid;t.after(()=>live.kill());
 }
 acquireLock(root,oldOwner);
 const lock=join(process.env.PI_CODING_AGENT_DIR,'delivery-locks',readdirSync(join(process.env.PI_CODING_AGENT_DIR,'delivery-locks')).find(n=>n.endsWith('.json')));
 writeFileSync(lock,JSON.stringify(oldOwner)); // Retained pre-fence lock.
 const before=readFileSync(lock);
 const h=harness({...native,entries,realLocksRoot:root});await h.start();
 if(['missing proof','live owner','pending check'].includes(outcome)) {
  await assert.rejects(h.invoke('delivery_resume'),/closure|alive|pending|proven dead/i);
  assert.deepEqual(readFileSync(lock),before);assert.equal(h.state().stage,'blocked');assert.equal(h.state().leased,false);
  assert.equal(h.state().active.nativeSession,undefined,'no normalization persisted before ownership');
  assert.ok(!h.saved.some(e=>e.data?.stage==='complete'));
  assert.match(textOf(await h.invoke('delivery_status')),/closure|alive|pending|proven dead/i);
 } else {
  await h.invoke('delivery_resume');const state=await h.wait();
  assert.equal(state.stage,outcome==='complete'?'complete':outcome==='failed'?'blocked':'stopped',state.reason);
  assert.equal(state.leased,false);assert.throws(()=>readFileSync(lock),/ENOENT/);
  assert.equal(state.reports.length,outcome==='complete'?2:1);
  if(outcome==='failed')assert.match(state.reason,/failed/);
 }
 assert.deepEqual(h.state().checks,retained.checks);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 await h.handlers.session_shutdown();
});


test('pure issue research is available through active allowlist and hook without snapshot, proposal, approval or native launch',async()=>{
 let reads=0;const h=harness({overrides:{snapshot:()=>assert.fail('research must not snapshot'),readIssues:async args=>{reads++;assert.deepEqual(args,{repo:'Owner/repo',limit:5});return {content:[{type:'text',text:'Untrusted issue data'}],details:{issues:[]}};}}});
 await h.start();await h.commands.delivery.handler('on',h.ctx);
 assert.ok(h.tools.delivery_issues);assert.ok(h.activeTools.includes('delivery_issues'));assert.equal(h.handlers.tool_call,undefined);
 assert.equal(h.tools.delivery_issues.parameters.additionalProperties,false);assert.equal(h.tools.delivery_issues.parameters.properties.repo.type,'string');
 await h.invoke('delivery_issues',{repo:'Owner/repo',limit:5});assert.equal(reads,1);assert.equal(h.state().plan,null);assert.equal(h.calls.length,0);
 await assert.rejects(h.invoke('delivery_issues',{repo:'Owner/repo',command:'edit'}),/unsupported/);assert.equal(reads,1);
 assert.match(h.handlers.before_agent_start().message.content,/issue.*delivery_issues.*without.*delivery_plan/i);
});
test('unrelated opaque directory coverage warning reaches proposal, reviewer and status while explicit nested scope fails',async()=>{
 const h=harness({snapshot:{a:'hash','vendor/nested':'opaque-directory:identity'}});
 const p=plan();p.mode='review';p.tasks[0].checks=[];p.checks=[];
 const s=await executePlan(h,p);assert.equal(s.stage,'complete',s.reason);
 for(const text of [h.messages[0].content,h.calls.find(c=>c.method==='spawn').params.task,textOf(await h.invoke('delivery_status'))]){
  assert.match(text,/opaque.*vendor\/nested/i);assert.match(text,/contents.*not fingerprinted/i);assert.match(text,/do not traverse/i);
 }
 p.tasks[0].files=['vendor'];await assert.rejects(h.invoke('delivery_plan',p),/run delivery in that repository/i);
});
test('opaque coverage warning is bounded and counts omitted boundary paths',async()=>{
 const snapshot={a:'hash',...Object.fromEntries(Array.from({length:100},(_,i)=>['nested-'+i+'x'.repeat(300),'opaque-directory:identity']))};
 const h=harness({snapshot});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());
 const text=textOf(await h.invoke('delivery_status'));assert.ok(text.length<=12000);assert.match(text,/opaque/i);assert.match(text,/omitted/i);
});

test('reviewer children do not register the issues tool or any coordinator authority',()=>{
 const h=harness({overrides:{child:true}});assert.deepEqual(Object.keys(h.tools),[]);assert.deepEqual(Object.keys(h.commands),[]);
});

const browserContract=()=>({acceptance:['Works'],runner:'scripts/browser.mjs',probe:'node scripts/browser.mjs --probe',scenarios:[{name:'navigation',command:'node scripts/browser.mjs --navigation'}],environment:'local',target:'http://127.0.0.1:3000',interactionScope:'Isolated fixture navigation only',artifacts:[]});
function browserHarness(t,{failEvidence=false,failProbe=false,malformedReview=false,recoveryDefect=false,...options}={}) {
 const dir=mkdtempSync(join(tmpdir(),'delivery-browser-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let fence=Number(options.entries?.at(-1)?.data.lockFence?.match(/^fence-(\d+)$/)?.[1] || 0),h,failed=false;const order=[];
 h=harness({...options,readOutcome:active=>{
  order.push(active.stage);
  if(active.stage==='probe'||active.stage==='verifier') {
   const s=h.state(),identity=s.active.evidence.identity;
   const fail=active.stage==='probe'?failProbe:failEvidence&&(failEvidence==='always'||!failed);
   if(fail)failed=true;
   return {...identity,status:fail?'blocked':'approved',summary:fail?'Headless fixture unavailable':'Navigation assertions passed',findings:[],...(fail?{blockedReason:'evidence_unavailable'}:{}),commands:fail?[]:[{command:active.stage==='probe'?browserContract().probe:browserContract().scenarios[0].command,exitCode:0}],artifacts:[]};
  }
  if(active.stage==='quality'&&recoveryDefect&&h.state().recoveringTask===h.state().task)return {status:'changes_requested',summary:'Navigation bug',findings:['high: a:12 navigation loses state']};
  if(active.stage==='quality'&&malformedReview&&!failed){failed=true;return {status:'approved'};}
  return approved;
 },overrides:{evidenceRoot:()=>join(dir,'evidence'),readNativeClosure:active=>({status:{runId:active.id,sessionId:active.nativeSession,state:'complete',steps:[{agent:active.agent,model:active.model,attemptedModels:[active.model]}]},terminal:terminalProof(active.id)}),inspectLock:(_r,o)=>{assert.equal(o.fence,`fence-${fence}`);},acquireLock:(_r,o)=>{if(o.fence)assert.equal(o.fence,`fence-${fence}`);return `fence-${++fence}`;},verifyCommand:async(_r,command)=>{order.push(command);return {command,code:0,signal:null,terminated:false,processClosed:true,output:'actual output'};},...options.overrides}});
 return Object.assign(h,{order});
}
const fourTaskPlan=()=>{const p=plan();p.tasks[0].browser=browserContract();p.tasks[0].sensitive=true;for(let i=2;i<=4;i++)p.tasks.push({...plan().tasks[0],title:`Task ${i}`,checks:[`task-${i}`]});return p;};
test('four-task browser pipeline probes before coding and hands native evidence to read-only reviewers',async t=>{
 const h=browserHarness(t);const s=await executePlan(h,fourTaskPlan());assert.equal(s.stage,'complete',s.reason);
 assert.deepEqual(h.order,['probe','coder','task-one','verifier','quality','security','coder','task-2','quality','coder','task-3','quality','coder','task-4','quality','final']);
 const launches=h.calls.filter(c=>c.method==='spawn');assert.ok(launches.filter(c=>c.params.agent==='delivery-verifier').every(c=>c.params.model==='test/coder'&&c.params.context==='fresh'));
 assert.match(launches.find(c=>c.params.agent==='delivery-reviewer').params.task,/Navigation assertions passed/);
});
test('missing browser capability blocks before first coder without install or fallback',async t=>{
 const h=browserHarness(t,{failProbe:true});const s=await executePlan(h,fourTaskPlan());assert.equal(s.stage,'blocked');assert.equal(s.failure.reason,'capability_unavailable');assert.deepEqual(h.order,['probe']);
 assert.match(textOf(await h.invoke('delivery_status')),/capability|prerequisite/i);await assert.rejects(h.invoke('delivery_recovery_plan'),/checkpoint|capability|recover/i);
});
test('closed evidence recovery needs new approval and preserves accepted task-one coder/checks through four tasks',async t=>{
 const h=browserHarness(t,{failEvidence:true});let s=await executePlan(h,fourTaskPlan());assert.equal(s.stage,'blocked');assert.equal(s.active,null);assert.equal(s.failure.reason,'evidence_unavailable');
 assert.match(textOf(await h.invoke('delivery_status')),/delivery_recovery_plan/);await assert.rejects(h.invoke('delivery_resume'),/recovery_plan/);
 const count=h.calls.length;await h.invoke('delivery_recovery_plan');assert.equal(h.calls.length,count,'proposal is inspection only');await assert.rejects(h.invoke('delivery_recovery_execute'),/approval/i);
 await h.input('Approved');await h.invoke('delivery_recovery_execute');s=await h.wait();assert.equal(s.stage,'complete',s.reason);
 assert.equal(h.order.filter(x=>x==='coder').length,4);assert.equal(h.order.filter(x=>x==='task-one').length,1);assert.equal(s.recoveryAttempts[0].count,1);
});
test('malformed closed reviewer report permits one approved fresh review, never coder replay',async t=>{
 const h=browserHarness(t,{malformedReview:true});assert.equal((await executePlan(h,plan())).stage,'blocked');assert.equal(h.state().failure.reason,'review_report_invalid');
 await h.invoke('delivery_recovery_plan');await h.input('Approved');await h.invoke('delivery_recovery_execute');assert.equal((await h.wait()).stage,'complete');assert.equal(h.order.filter(x=>x==='coder').length,1);assert.equal(h.order.filter(x=>x==='quality').length,2);
});
for(const mutation of ['snapshot','routes','closure','pending','unknown','stop','budget','fence','foreign'])test(`evidence recovery refuses ${mutation} without new launch`,async t=>{
 const h=browserHarness(t,{failEvidence:true});await executePlan(h,fourTaskPlan());const retained=structuredClone(h.state());
 if(mutation==='pending')retained.pendingCheck='uncertain';if(mutation==='unknown')retained.active={id:null};if(mutation==='stop')retained.stopping=true;if(mutation==='budget')retained.round=2;if(mutation==='fence')retained.lockFence='stale';if(mutation==='foreign')retained.failure.native.nativeSession='foreign';
 const r=browserHarness(t,{entries:[{type:'custom',customType:'delivery-coordinator-v2',data:retained}],snapshot:mutation==='snapshot'?{a:'changed'}:undefined,overrides:{inspectLock:(_r,o)=>{if(o.fence==='stale')throw new Error('Stale fence');},...(mutation==='closure'?{readNativeClosure:()=>null}:{}),...(mutation==='routes'?{loadConfig:()=>({routes:{planning:'test/planning',coder:'test/quality',quality:'test/quality',security:'test/security'}})}:{})}});
 await r.start();await assert.rejects(r.invoke('delivery_recovery_plan'));assert.equal(r.calls.filter(c=>c.method==='spawn').length,0);
});
test('OFF explicitly invalidates closed recovery and restores shell; ON never revives it',async t=>{
 const h=browserHarness(t,{failEvidence:true});await executePlan(h,fourTaskPlan());await h.commands.delivery.handler('off',h.ctx);assert.ok(h.activeTools.includes('bash'));assert.equal(h.handlers.tool_call,undefined);
 assert.match(textOf(await h.invoke('delivery_status')),/unmanaged handoff.*invalidated recovery/i);await assert.rejects(h.invoke('delivery_resume'),/invalidated recovery/i);
 await h.commands.delivery.handler('on',h.ctx);await assert.rejects(h.invoke('delivery_recovery_plan'),/invalidated recovery/i);assert.equal(h.order.filter(x=>x==='coder').length,1);
});
test('recovery defect stops current task without coding, later tasks or final checks',async t=>{
 const h=browserHarness(t,{failEvidence:true,recoveryDefect:true});await executePlan(h,fourTaskPlan());await h.invoke('delivery_recovery_plan');await h.input('Approved');await h.invoke('delivery_recovery_execute');const s=await h.wait();
 assert.equal(s.stage,'blocked');assert.equal(s.failure.reason,'recovery_code_defect');assert.equal(h.order.filter(x=>x==='coder').length,1);assert.ok(!h.order.includes('task-2'));assert.ok(!h.order.includes('final'));assert.equal(s.recoveryAttempts[0].count,1);
 assert.match(textOf(await h.invoke('delivery_status')),/a:12/);assert.match(textOf(await h.invoke('delivery_status')),/correction.*delivery_plan/);await assert.rejects(h.invoke('delivery_recovery_plan'),/recoverable/);
});
test('one evidence recovery attempt survives reload and repeated proposal cannot reset it',async t=>{
 const h=browserHarness(t,{failEvidence:'always'});await executePlan(h,fourTaskPlan());await h.invoke('delivery_recovery_plan');await h.input('Approved');await h.invoke('delivery_recovery_plan');await assert.rejects(h.invoke('delivery_recovery_execute'),/approval/);
 await h.input('Approved');await h.invoke('delivery_recovery_execute');assert.equal((await h.wait()).stage,'blocked');await assert.rejects(h.invoke('delivery_recovery_plan'),/limit/);
 const r=browserHarness(t,{entries:h.saved,overrides:{inspectLock:()=>{}}});await r.start();await assert.rejects(r.invoke('delivery_recovery_plan'),/limit/);assert.equal(r.calls.length,0);
});
test('recovery rechecks snapshot after proposal and concurrent execution has one launch chain',async t=>{
 const snapshot={a:'hash',unrelated:'dirty'},h=browserHarness(t,{failEvidence:true,snapshot,delayPing:15});await executePlan(h,fourTaskPlan());await h.invoke('delivery_recovery_plan');snapshot.a='changed';await h.input('Approved');await assert.rejects(h.invoke('delivery_recovery_execute'),/snapshot/);assert.equal(h.order.filter(x=>x==='verifier').length,1);
 snapshot.a='hash';await h.invoke('delivery_recovery_plan');await h.input('Approved');const start=h.invoke('delivery_recovery_execute');await assert.rejects(h.invoke('delivery_recovery_execute'),/progress/);await start;assert.equal((await h.wait()).stage,'complete');assert.equal(h.order.filter(x=>x==='verifier').length,2);
});
test('OFF after reload restores original available tools, never the restricted coordinator list',async t=>{
 const h=browserHarness(t,{failEvidence:true});await executePlan(h,fourTaskPlan());const r=browserHarness(t,{entries:h.saved,initialTools:[...h.activeTools]});await r.start();await r.commands.delivery.handler('off',r.ctx);assert.ok(r.activeTools.includes('bash'));
 await r.commands.delivery.handler('on',r.ctx);await r.commands.delivery.handler('off',r.ctx);assert.ok(r.activeTools.includes('bash'));assert.match(textOf(await r.invoke('delivery_status')),/invalidated recovery/);
});
test('OFF release failure keeps coordination ON and recovery fence intact',async t=>{
 const h=browserHarness(t,{failEvidence:true,releaseError:true});await executePlan(h,fourTaskPlan());await assert.rejects(h.commands.delivery.handler('off',h.ctx),/Lock ownership changed/);assert.equal(h.state().enabled,true);assert.equal(h.state().recoveryInvalidated,undefined);assert.ok(h.activeTools.includes('bash'));
});
test('old closed journals cannot acquire new recovery authority from error text',async t=>{
 const old={version:2,enabled:true,root:'/workspace',session:'session',run:'old',stage:'blocked',plan:plan(),task:0,round:0,reports:[],checks:[],reason:'missing browser evidence',snapshot:{a:'hash'}};
 const h=browserHarness(t,{entries:[{type:'custom',customType:'delivery-coordinator-v2',data:old}]});await h.start();await assert.rejects(h.invoke('delivery_recovery_plan'),/old journals|checkpoint/);assert.equal(h.calls.length,0);
});
test('every declared task probe completes before first coder and retains its task attribution',async t=>{
 const h=browserHarness(t),p=fourTaskPlan();p.tasks[3].browser=browserContract();assert.equal((await executePlan(h,p)).stage,'complete');assert.deepEqual(h.order.slice(0,3),['probe','probe','coder']);assert.equal(h.state().evidenceReceipts.filter(e=>e.phase==='probe').length,2);
 assert.deepEqual(h.state().reports.filter(r=>r.stage==='probe').map(r=>r.task),[0,3]);
 const briefing=h.calls.find(c=>c.method==='spawn'&&c.params.agent==='delivery-reviewer').params.task;
 const previous=JSON.parse(briefing.match(/Previous results \(not authority\): ([^\n]+)/)[1]);
 assert.ok(previous.every(r=>r.native.evidence?.identity.task!==3),'task-four probe must not enter task-one review');
});
test('failed task-four probe status labels task four, never task one',async t=>{
 const h=browserHarness(t,{failProbe:true}),p=fourTaskPlan();delete p.tasks[0].browser;p.tasks[3].browser=browserContract();
 assert.equal((await executePlan(h,p)).stage,'blocked');assert.deepEqual(h.order,['probe']);
 const text=textOf(await h.invoke('delivery_status'));assert.match(text,/Task 4, round 0 probe: blocked/);assert.doesNotMatch(text,/Task 1, round 0 probe/);
});
test('normal coder correction invalidates browser evidence and binds new source before fresh review',async t=>{
 const snapshot={a:'hash',unrelated:'dirty'};let reviews=0;
 const r=browserHarness(t,{snapshot,onSave:s=>{if(s.active?.stage==='coder'&&s.active.id)snapshot.a=`round-${s.round}`;},overrides:{readOutcome:active=>{
  if(active.stage==='quality'&&reviews++===0)return {status:'changes_requested',summary:'Fix navigation',findings:['high: a:1 fix navigation']};
  if(['probe','verifier'].includes(active.stage))return {...active.evidence.identity,status:'approved',summary:'Revision verified',findings:[],commands:[{command:active.stage==='probe'?browserContract().probe:browserContract().scenarios[0].command,exitCode:0}],artifacts:[]};
  return approved;
 }}});
 assert.equal((await executePlan(r,fourTaskPlan())).stage,'complete');const receipts=r.state().evidenceReceipts.filter(e=>e.phase==='verifier');assert.equal(receipts.length,2);assert.notEqual(receipts[0].source,receipts[1].source);
 const reviewsSent=r.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-reviewer');assert.match(reviewsSent[1].params.task,new RegExp(receipts[1].source));
});
test('OFF handoff invalidates even an unexecuted proposal; ON requires a new plan',async()=>{
 const h=harness();await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.commands.delivery.handler('off',h.ctx);await h.commands.delivery.handler('on',h.ctx);await h.input('Approved');await assert.rejects(h.invoke('delivery_execute'),/new.*plan|handoff/i);assert.equal(h.calls.length,0);
});
test('sanitized text artifact is delivered inline to both read-only reviewers',async t=>{
 const {createHash}=await import('node:crypto');const p=fourTaskPlan();p.tasks[0].browser.artifacts=[{path:'navigation.txt',kind:'text',capture:'Redacted navigation assertion'}];
 const h=browserHarness(t,{overrides:{readOutcome:active=>{
  if(!active.evidence)return approved;
  const {identity,directory,browser}=active.evidence,artifacts=[];
  if(identity.phase==='verifier') {
   const text='Navigation keeps selected item\nCookie: synthetic-cookie';writeFileSync(join(directory,'navigation.txt'),text);artifacts.push({path:'navigation.txt',sha256:createHash('sha256').update(text).digest('hex')});
  }
  return {...identity,status:'approved',summary:'Fixture inspected',findings:[],commands:[{command:identity.phase==='probe'?browser.probe:browser.scenarios[0].command,exitCode:0}],artifacts};
 }}});
 assert.equal((await executePlan(h,p)).stage,'complete');const reviews=h.calls.filter(c=>c.method==='spawn'&&['delivery-reviewer','delivery-security'].includes(c.params.agent));
 for(const c of reviews.slice(0,2)){assert.match(c.params.task,/Navigation keeps selected item/);assert.doesNotMatch(c.params.task,/synthetic-cookie/);assert.match(c.params.task,/Do not modify files\. Do not execute commands/);}
});
test('typed native missing report needs closure and fresh recovery approval, never counts as verdict',async t=>{
 let failed=false;const h=browserHarness(t,{overrides:{readOutcome:active=>{if(active.stage==='quality'&&!failed){failed=true;throw Object.assign(new Error('Native worker missing structured report'),{code:'DELIVERY_STRUCTURED_REPORT',closed:true,nativeState:'complete'});}return approved;}}});
 assert.equal((await executePlan(h,plan())).stage,'blocked');assert.equal(h.state().failure.reason,'review_report_invalid');assert.equal(h.state().reports.filter(r=>r.stage==='quality').length,0);
 await h.invoke('delivery_recovery_plan');await h.input('Approved');await h.invoke('delivery_recovery_execute');assert.equal((await h.wait()).stage,'complete');assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,1);
});
test('new unknown native fleet during recovery preflight consumes attempt but launches nothing',async t=>{
 let recovery=false;const h=browserHarness(t,{failEvidence:true,overrides:{rpc:async(...args)=>{if(recovery&&args[1]==='status')return {fleet:{totalActive:1}};return rpc(...args);}}});
 await executePlan(h,fourTaskPlan());await h.invoke('delivery_recovery_plan');await h.input('Approved');recovery=true;const count=h.calls.filter(c=>c.method==='spawn').length;await assert.rejects(h.invoke('delivery_recovery_execute'),/ownership unknown/);assert.equal(h.calls.filter(c=>c.method==='spawn').length,count);assert.equal(h.state().recoveryAttempts[0].count,1);
});
test('fresh continuation replaces old v2 block without recovery metadata, never inherits approval',async()=>{
 const old={version:2,enabled:true,stage:'blocked',root:'/workspace',session:'session',run:'old-run',task:0,round:0,active:null,plan:plan(),reports:[],checks:[],snapshot:{a:'old'},reason:'Browser evidence unavailable',leased:false};
 const h=harness({entries:[{type:'custom',customType:'delivery-coordinator-v2',data:old}]});await h.start();
 await assert.rejects(h.invoke('delivery_recovery_plan'),/proof absent/i);
 const revised=plan();revised.title='Remaining work; browser validation deferred';revised.tasks[0].acceptance=['Server behavior only; browser login remains unverified'];
 await h.invoke('delivery_plan',revised);
 assert.equal(h.state().stage,'awaiting-approval');assert.equal(h.state().superseded.run,'old-run');assert.notEqual(h.state().run,'old-run');
 assert.deepEqual(h.saved.find(e=>e.customType==='delivery-superseded-v1').data,{...old,toolsBefore:['read','bash','write','subagent']});
 assert.match(h.messages.map(m=>m.content).join('\n'),/omissions are not passing evidence/);
 await assert.rejects(h.invoke('delivery_execute'),/approval/i);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 await h.input('Approved');await h.invoke('delivery_execute');assert.equal((await h.wait()).stage,'complete');
});
test('fresh continuation releases settled evidence lease without OFF and preserves old reports',async t=>{
 const h=browserHarness(t,{failEvidence:true});await executePlan(h,fourTaskPlan());const old=structuredClone(h.state());
 await h.invoke('delivery_plan',plan());assert.equal(h.state().superseded.run,old.run);assert.equal(h.state().stage,'awaiting-approval');
 assert.deepEqual(h.saved.find(e=>e.customType==='delivery-superseded-v1').data,old);assert.equal(h.order.filter(s=>s==='coder').length,1);
});
test('fresh continuation refuses unknown fleet without replacing retained state',async t=>{
 let reject=false;const h=browserHarness(t,{failEvidence:true,overrides:{rpc:async(...args)=>reject&&args[1]==='status'?{fleet:{totalActive:1}}:rpc(...args)}});
 await executePlan(h,fourTaskPlan());const old=structuredClone(h.state());reject=true;
 await assert.rejects(h.invoke('delivery_plan',plan()),/ownership is unknown/);assert.deepEqual(h.state(),old);
});
test('typed evidence block in read-only review releases lease and cannot enable recovery',async t=>{
 const h=browserHarness(t,{overrides:{readOutcome:()=>({status:'blocked',summary:'Supplied evidence unavailable',findings:[],blockedReason:'evidence_unavailable'})}}),p=plan();p.mode='review';p.tasks[0].checks=[];p.checks=[];
 const s=await executePlan(h,p);assert.equal(s.stage,'blocked');assert.equal(s.leased,false);await assert.rejects(h.invoke('delivery_recovery_plan'));await h.invoke('delivery_plan',plan());assert.equal(h.state().stage,'awaiting-approval');assert.equal(h.calls.filter(c=>c.method==='spawn').length,1);
});

for(const scenario of ['closed','recovery ping failure','recovery fleet failure','exhausted recovery','live owner','unknown owner','stale fence','foreign run','foreign session','foreign native owner','foreign worker','foreign repository','missing native','missing proof','malformed proof','changed proof','release failure'])test(`OFF after full restart with real retained lock: ${scenario}`,async t=>{
 const {spawnSync,spawn}=await import('node:child_process');
 const source=browserHarness(t,{failEvidence:'always'});await executePlan(source,fourTaskPlan());
 if(scenario==='exhausted recovery'){
  await source.invoke('delivery_recovery_plan');await source.input('Approved');await source.invoke('delivery_recovery_execute');await source.wait();
  assert.equal(source.state().recoveryAttempts[0].count,1);
 }
 const retained=structuredClone(source.state()),root=mkdtempSync(join(tmpdir(),'delivery-off-restart-'));
 const old=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=join(root,'agent');
 t.after(()=>{if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;rmSync(root,{recursive:true,force:true});});
 retained.root=root;const native=retained.failure.native;native.dir=join(root,'native');mkdirSync(native.dir);
 const status={runId:native.id,sessionId:native.nativeSession,state:'complete',steps:[{agent:native.agent,model:native.model,attemptedModels:[native.model]}]};
 writeFileSync(join(native.dir,'status.json'),JSON.stringify(status));writeFileSync(join(native.dir,'process-terminal.json'),JSON.stringify(retained.failure.closure));
 const dead=Number(spawnSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8'}).stdout.trim());assert.ok(dead>0);
 let pid=dead;if(scenario==='live owner'){const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)']);pid=child.pid;t.after(()=>child.kill());}
 retained.lockFence=acquireLock(root,{session:retained.session,run:retained.run,pid});
 const lockDir=join(process.env.PI_CODING_AGENT_DIR,'delivery-locks'),lock=join(lockDir,readdirSync(lockDir).find(n=>n.endsWith('.json')));
 if(scenario==='unknown owner')writeFileSync(lock,JSON.stringify({...JSON.parse(readFileSync(lock)),pid:null}));
 if(scenario==='stale fence')retained.lockFence='stale';
 if(scenario==='foreign run')retained.run='foreign';
 if(scenario==='foreign session')native.session='foreign';
 if(scenario==='foreign native owner')native.nativeSession='foreign';
 if(scenario==='foreign worker')native.id='foreign';
 if(scenario==='foreign repository')retained.root='/foreign';
 if(scenario==='missing native')delete retained.failure.native;
 if(scenario==='missing proof')rmSync(join(native.dir,'process-terminal.json'));
 if(scenario==='malformed proof')writeFileSync(join(native.dir,'process-terminal.json'),JSON.stringify({state:'observed'}));
 if(scenario==='changed proof')writeFileSync(join(native.dir,'process-terminal.json'),JSON.stringify({...retained.failure.closure,observedAt:999}));
 const before=readFileSync(lock);let failRelease=scenario==='release failure';
 const h=harness({entries:[{type:'custom',customType:'delivery-coordinator-v2',data:retained}],realLocksRoot:root,overrides:{inspectLock,readNativeClosure,rpc:async(...args)=>{if(scenario==='recovery ping failure'&&args[1]==='ping')throw new Error('Injected ping failure');if(scenario==='recovery fleet failure'&&args[1]==='status')return {fleet:{totalActive:1}};return rpc(...args);},releaseLock:(...args)=>{if(failRelease)throw new Error('Injected release failure');return releaseLock(...args);}}});await h.start();
 if(scenario.startsWith('recovery ')){
  await h.invoke('delivery_recovery_plan');await h.input('Approved');
  await assert.rejects(h.invoke('delivery_recovery_execute'),/Injected ping failure|ownership unknown/);
  assert.equal(h.state().recoveryAttempts[0].count,1);
  assert.equal(h.state().failure.reason,'infrastructure_or_product_failure');
  retained.recoveryAttempts=structuredClone(h.state().recoveryAttempts);
 }
 if(!['closed','recovery ping failure','recovery fleet failure','exhausted recovery','release failure'].includes(scenario)){
  await assert.rejects(h.commands.delivery.handler('off',h.ctx));assert.deepEqual(readFileSync(lock),before);assert.deepEqual(h.state(),retained);
  if(scenario!=='foreign repository'){assert.ok(h.activeTools.includes('bash'));}
 }else{
  if(failRelease){
   await assert.rejects(h.commands.delivery.handler('off',h.ctx),/Injected release failure/);
   assert.equal(h.state().enabled,true);assert.equal(h.state().leased,true);assert.equal(h.state().recoveryInvalidated,undefined);assert.ok(h.activeTools.includes('bash'));
   assert.equal(h.state().lockFence,JSON.parse(readFileSync(lock)).fence,'reconciled fence must persist for safe retry');failRelease=false;
  }
  await h.commands.delivery.handler('off',h.ctx);assert.throws(()=>readFileSync(lock),/ENOENT/);assert.equal(h.state().leased,false);assert.equal(h.state().enabled,false);assert.equal(h.state().recoveryInvalidated,true);assert.ok(h.activeTools.includes('bash'));
  assert.deepEqual(h.state().reports,retained.reports);assert.deepEqual(h.state().checks,retained.checks);assert.deepEqual(h.state().recoveryAttempts,retained.recoveryAttempts);
 }
 assert.equal(h.calls.filter(c=>c.method==='spawn').length,0,'OFF must not launch or retry work');
});
