import test from 'node:test';
import assert from 'node:assert/strict';
import {registerDelivery} from '../extensions/delivery/extension.mjs';
import {rpc} from '../extensions/delivery/rpc.mjs';
import {readOutcome} from '../extensions/delivery/io.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const plan=()=>({mode:'implementation',title:'Bounded change',tasks:[{title:'One',instructions:'Implement one',files:['a'],acceptance:['Works'],checks:['task-one']}],checks:['final'],security:false});
const approved={status:'approved',summary:'Inspected source and evidence',findings:[]};
function harness({entries=[],reports=[],live=false,spawnError=false,checkCode=0,snapshot={a:"hash",unrelated:"dirty"},onSave=()=>{},releaseError=false,delayPing=0,sessionId='session',sessionFile,spawn,readOutcome:outcome,onLock=()=>{}}={}) {
 const handlers={},tools={},commands={},calls=[],messages=[],saved=[...entries];let n=0;
 const models=['planning','coder','quality','security'].map(id=>({provider:'test',id}));
 const events={listeners:new Map(),on(k,f){this.listeners.set(k,f);return()=>this.listeners.delete(k);},emit(k,r){if(!k.endsWith(':request'))return;calls.push(r);let data={version:1,capabilities:{asyncSpawn:true,processTerminalProof:{version:1}},methods:['spawn','status','stop']};
 if(r.method==='spawn')data={details:spawn?spawn(r.params,++n):{runId:`run-${++n}`,asyncDir:`/artifacts/${n}`}};
 if(r.method==='status')data={fleet:{totalActive:0}};
 const reply=()=>this.listeners.get(`subagents:rpc:v1:reply:${r.requestId}`)({version:1,requestId:r.requestId,success:!(spawnError&&r.method==='spawn'),data,error:{message:'Provider unavailable'}});if(r.method==='ping'&&delayPing)setTimeout(reply,delayPing);else reply();
 }};
 const pi={events,on:(k,f)=>handlers[k]=f,registerTool:t=>tools[t.name]=t,registerCommand:(k,c)=>commands[k]=c,appendEntry:(customType,data)=>{saved.push({type:'custom',customType,data:structuredClone(data)});onSave(data);},sendMessage:m=>messages.push(m),getActiveTools:()=>['read','bash','write','subagent'],setActiveTools:()=>{},setModel:async()=>true};
 const ctx={cwd:'/workspace',hasUI:true,ui:{setStatus(){},notify(){},confirm:async()=>true},sessionManager:{getBranch:()=>saved,getSessionId:()=>sessionId,getSessionFile:()=>sessionFile},modelRegistry:{getAvailable:()=>models}};
 const deps={child:false,loadConfig:()=>({version:1,routes:Object.fromEntries(models.map(m=>[m.id,`test/${m.id}`])),repos:['/workspace']}),repoRoot:()=>'/workspace',snapshot:()=>structuredClone(snapshot),acquireLock:(root,owner)=>onLock('acquire',root,owner),releaseLock:(root,owner)=>{onLock('release',root,owner);if(releaseError)throw new Error("Lock ownership changed");},readOutcome:outcome || (()=>live?null:reports.shift()||approved),workingTreeEvidence:()=> 'dirty diff',validateCommands:()=>{},verifyCommand:async(_r,command)=>({command,code:typeof checkCode==='function'?checkCode(command):checkCode,signal:null,terminated:false,processClosed:true,output:'actual output'}),rpc,pollMs:1};
 registerDelivery(pi,{empty:{},plan:{},configure:{}},deps);
 const invoke=(name,args={})=>tools[name].execute('call',args,undefined,undefined,ctx);
 const input=text=>handlers.input({text,source:'interactive'},ctx);
 const state=()=>saved.filter(e=>e.customType==='delivery-coordinator-v2').at(-1)?.data;
 const wait=async()=>{for(let i=0;i<200;i++){if(['complete','blocked','stopped'].includes(state()?.stage))return state();await new Promise(r=>setTimeout(r,2));}throw new Error('did not settle');};
 return {handlers,tools,commands,calls,messages,saved,ctx,deps,invoke,input,state,wait,start:()=>handlers.session_start({},ctx)};
}

test('thin interface proposes without launching and questions never approve',async()=>{
 const h=harness();await h.start();await h.commands.delivery.handler('on',h.ctx);
 assert.deepEqual(Object.keys(h.tools).sort(),['delivery_configure','delivery_execute','delivery_plan','delivery_status'].sort());
 await h.invoke('delivery_plan',plan());await h.input('Can you implement this plan?');await assert.rejects(h.invoke('delivery_execute'),/approval/i);assert.equal(h.calls.filter(c=>c.method==='spawn').length,0);
 await h.input('Plan only, do not implement');await assert.rejects(h.invoke('delivery_execute'),/approval/i);
});
test('native RPC runs coder, task checks, independent quality/security and final checks in order',async()=>{
 const h=harness();await h.start();await h.commands.delivery.handler('on',h.ctx);const p=plan();p.tasks[0].sensitive=true;p.tasks.push({...p.tasks[0],title:'Two',files:['b'],checks:['task-two'],sensitive:false});await h.invoke('delivery_plan',p);await h.input('Implement the displayed plan');await h.invoke('delivery_execute');const s=await h.wait();assert.equal(s.stage,'complete',s.reason);
 const launches=h.calls.filter(c=>c.method==='spawn').map(c=>c.params);assert.deepEqual(launches.map(c=>c.model),['test/coder','test/quality','test/security','test/coder','test/quality']);assert.ok(launches.every(c=>c.context==='fresh'&&c.async===true&&c.share===false));
 assert.deepEqual(s.checks.map(c=>c.command),['task-one','task-two','final']);assert.equal(s.reports.length,5);assert.match(launches[1].task,/task-one/);assert.match(launches[1].task,/Do not modify files/);assert.match(launches[3].task,/Two/);
});
test('corrections are bounded and keep original approval',async()=>{
 const finding={status:'changes_requested',summary:'Bug',findings:['high: a:1 fix bug']};const h=harness({reports:[approved,finding,approved,finding,approved,finding]});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');const s=await h.wait();assert.equal(s.stage,'blocked');assert.match(s.reason,/correction.*limit/i);assert.equal(h.calls.filter(c=>c.method==='spawn'&&c.params.agent==='delivery-coder').length,3);assert.ok(!s.checks.some(c=>c.command==='final'));
});
test('review-only does not execute checks or a writer and findings cannot launch fixes',async()=>{
 const h=harness({reports:[{status:'changes_requested',summary:'Bug',findings:['a:1 bug']}]});await h.start();await h.commands.delivery.handler('on',h.ctx);const p=plan();p.mode='review';p.tasks[0].checks=[];p.checks=[];await h.invoke('delivery_plan',p);await h.input('Approved');await h.invoke('delivery_execute');const s=await h.wait();assert.equal(s.stage,'blocked');assert.equal(s.checks.length,0);assert.deepEqual(h.calls.filter(c=>c.method==='spawn').map(c=>c.params.agent),['delivery-reviewer']);
});
test('failed checks stop at the bound without fabricated passing evidence',async()=>{
 const h=harness({checkCode:1});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');const s=await h.wait();assert.equal(s.stage,'blocked');assert.ok(s.checks.every(c=>c.code===1));assert.ok(!h.calls.some(c=>c.params?.agent==='delivery-reviewer'));
});
test('launch errors retain unknown ownership and prevent duplicates',async()=>{
 const h=harness({spawnError:true});await h.start();await h.commands.delivery.handler('on',h.ctx);await h.invoke('delivery_plan',plan());await h.input('Approved');await h.invoke('delivery_execute');const s=await h.wait();assert.equal(s.stage,'blocked');assert.ok(s.active);await assert.rejects(h.invoke('delivery_execute'));await assert.rejects(h.invoke('delivery_plan',plan()));assert.equal(h.calls.filter(c=>c.method==='spawn').length,1);
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
test('parent tool hooks deny writers, shell, external tools and native delegation',async()=>{
 const h=harness();await h.start();await h.commands.delivery.handler('on',h.ctx);
 for(const toolName of ['bash','write','edit','subagent','custom_mutator'])assert.equal(h.handlers.tool_call({toolName}).block,true);
 assert.equal(h.handlers.tool_call({toolName:'read'}),undefined);assert.throws(()=>h.handlers.user_bash({command:'true'}),/shell/);
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
 return {sessionFile,sessionId,readOutcome,workers,write,spawn(params){
  const n=workers.length+1,asyncDir=join(dir,String(n));mkdirSync(asyncDir);
  const runId=`native-${n}`,report=join(asyncDir,'report.json');
  const worker={dir:asyncDir,status:{runId,sessionId:sessionFile ?? sessionId,state:live&&workers.length===0?'running':'complete',steps:[{agent:params.agent,model:params.model,attemptedModels:[params.model],sessionFile:join(asyncDir,'child.jsonl'),structuredOutputPath:report}]}};
  workers.push(worker);write(worker);
  writeFileSync(report,JSON.stringify(approved));
  writeFileSync(join(asyncDir,'process-terminal.json'),JSON.stringify({runId,state:'observed',instances:[{exitCode:0,signal:null}]}));
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
