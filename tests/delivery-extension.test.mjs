import test from 'node:test';
import assert from 'node:assert/strict';
import {registerDelivery} from '../extensions/delivery/extension.mjs';
import {rpc} from '../extensions/delivery/rpc.mjs';

const plan=()=>({mode:'implementation',title:'Bounded change',tasks:[{title:'One',instructions:'Implement one',files:['a'],acceptance:['Works'],checks:['task-one']}],checks:['final'],security:false});
const approved={status:'approved',summary:'Inspected source and evidence',findings:[]};
function harness({entries=[],reports=[],live=false,spawnError=false,checkCode=0,snapshot={a:"hash",unrelated:"dirty"},onSave=()=>{},releaseError=false,delayPing=0}={}) {
 const handlers={},tools={},commands={},calls=[],messages=[],saved=[...entries];let n=0;
 const models=['planning','coder','quality','security'].map(id=>({provider:'test',id}));
 const events={listeners:new Map(),on(k,f){this.listeners.set(k,f);return()=>this.listeners.delete(k);},emit(k,r){if(!k.endsWith(':request'))return;calls.push(r);let data={version:1,capabilities:{asyncSpawn:true,processTerminalProof:{version:1}},methods:['spawn','status','stop']};
 if(r.method==='spawn')data={details:{runId:`run-${++n}`,asyncDir:`/artifacts/${n}`}};
 if(r.method==='status')data={fleet:{totalActive:0}};
 const reply=()=>this.listeners.get(`subagents:rpc:v1:reply:${r.requestId}`)({version:1,requestId:r.requestId,success:!(spawnError&&r.method==='spawn'),data,error:{message:'Provider unavailable'}});if(r.method==='ping'&&delayPing)setTimeout(reply,delayPing);else reply();
 }};
 const pi={events,on:(k,f)=>handlers[k]=f,registerTool:t=>tools[t.name]=t,registerCommand:(k,c)=>commands[k]=c,appendEntry:(customType,data)=>{saved.push({type:'custom',customType,data:structuredClone(data)});onSave(data);},sendMessage:m=>messages.push(m),getActiveTools:()=>['read','bash','write','subagent'],setActiveTools:()=>{},setModel:async()=>true};
 const ctx={cwd:'/workspace',hasUI:true,ui:{setStatus(){},notify(){},confirm:async()=>true},sessionManager:{getBranch:()=>saved,getSessionId:()=> 'session'},modelRegistry:{getAvailable:()=>models}};
 const deps={child:false,loadConfig:()=>({version:1,routes:Object.fromEntries(models.map(m=>[m.id,`test/${m.id}`])),repos:['/workspace']}),repoRoot:()=>'/workspace',snapshot:()=>structuredClone(snapshot),acquireLock:()=>{},releaseLock:()=>{if(releaseError)throw new Error("Lock ownership changed");},readOutcome:()=>live?null:reports.shift()||approved,workingTreeEvidence:()=> 'dirty diff',validateCommands:()=>{},verifyCommand:async(_r,command)=>({command,code:checkCode,signal:null,terminated:false,processClosed:true,output:'actual output'}),rpc,pollMs:1};
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
