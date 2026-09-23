import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import * as io from '../extensions/delivery/io.mjs';

import {terminalProof} from './helpers/native-artifacts.mjs';
function fixture(t,{legacy=true}={}) {
 const root=mkdtempSync(join(tmpdir(),'delivery-recovery-')),agent=join(root,'agent'),dir=join(root,'native');mkdirSync(dir);
 const old=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agent;
 t.after(()=>{if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;rmSync(root,{recursive:true,force:true});});
 const dead=Number(spawnSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8'}).stdout.trim());
 const owner={session:'parent-uuid',run:'delivery-run',pid:dead},current={...owner,pid:process.pid};
 const active={id:'native',dir,session:owner.session,nativeSession:join(root,'parent.jsonl'),agent:'delivery-reviewer',model:'test/review'};
 const status={runId:active.id,sessionId:active.nativeSession,state:'complete',processTerminal:terminalProof(),steps:[{agent:active.agent,model:active.model,attemptedModels:[active.model],structuredOutputPath:join(dir,'report.json')}]};
 const write=(name,data)=>writeFileSync(join(dir,name),JSON.stringify(data));
 write('status.json',status);write('process-terminal.json',terminalProof());write('report.json',{status:'approved',summary:'Offline review',findings:[]});
 io.acquireLock(root,owner);
 const lock=join(agent,'delivery-locks',readdirSync(join(agent,'delivery-locks')).find(n=>n.endsWith('.json')));
 if(legacy)writeFileSync(lock,JSON.stringify(owner)); // Pre-fence lock format, not a new-code acquisition.
 else owner.fence=current.fence=JSON.parse(readFileSync(lock)).fence;
 return {root,agent,dir,owner,current,active,status,write,lock};
}
test('same-session restarted pid reclaims exact lock only after native observed closure',t=>{
 const f=fixture(t);f.current.fence=io.acquireLock(f.root,f.current,{active:f.active});
 assert.deepEqual(JSON.parse(readFileSync(f.lock)),f.current);assert.equal(io.readOutcome(f.active).status,'approved');
 io.releaseLock(f.root,f.current);
});
for(const scenario of ['live owner','unknown owner','live worker','missing proof','weak proof','pending proof','unknown tree','foreign session','foreign run','foreign worker','foreign native owner','pending check'])test(`reclaim refuses ${scenario} without changing lock`,t=>{
 const f=fixture(t);let current=f.current,active=f.active,pendingCheck;
 if(scenario==='live owner')writeFileSync(f.lock,JSON.stringify({...f.owner,pid:process.pid})),current={...f.current,pid:f.owner.pid};
 if(scenario==='unknown owner')writeFileSync(f.lock,JSON.stringify({...f.owner,pid:null}));
 if(scenario==='live worker')f.write('status.json',{...f.status,state:'running'});
 if(scenario==='missing proof')rmSync(join(f.dir,'process-terminal.json'));
 if(scenario==='weak proof')f.write('process-terminal.json',{runId:'native',state:'observed',instances:[{exitCode:0,signal:null}]});
 if(scenario==='pending proof')f.write('process-terminal.json',terminalProof('native',{state:'pending'}));
 if(scenario==='unknown tree')f.write('process-terminal.json',terminalProof('native',{instances:[...terminalProof().instances,{kind:'pi-writer',processInstanceId:'writer',attempt:0,closeObservedAt:100,exitCode:0,signal:null,processTree:{state:'unknown',reason:'verification-failed'}}]}));
 if(scenario==='foreign session')current={...current,session:'foreign'};
 if(scenario==='foreign run')current={...current,run:'foreign'};
 if(scenario==='foreign worker')active={...active,id:'foreign'};
 if(scenario==='foreign native owner')active={...active,nativeSession:'foreign'};
 if(scenario==='pending check')pendingCheck='unfinished-check';
 const before=readFileSync(f.lock);
 assert.throws(()=>io.acquireLock(f.root,current,{active,pendingCheck}),error=>{
  assert.match(error.message,/stored.*pid.*session.*run.*current.*pid.*session.*run/is);assert.match(error.message,/inspect|evidence/i);return true;
 });assert.deepEqual(readFileSync(f.lock),before);
});
for(const state of ['failed','stopped'])test(`closed ${state} permits exact ownership reconciliation, not success`,t=>{
 const f=fixture(t);f.write('status.json',{...f.status,state,error:'Native failure'});
 f.current.fence=io.acquireLock(f.root,f.current,{active:f.active});
 assert.throws(()=>io.readOutcome(f.active),error=>error.closed===true && error.nativeState===state);
 io.releaseLock(f.root,f.current);
});
test('proof-less acquisition and release cannot unlock a dead foreign process',t=>{
 const f=fixture(t),before=readFileSync(f.lock);
 assert.throws(()=>io.acquireLock(f.root,f.current),/known|evidence/);
 assert.throws(()=>io.releaseLock(f.root,f.current),/ownership/);assert.deepEqual(readFileSync(f.lock),before);
});
test('unknown guard ownership blocks acquire and release without removing either file',t=>{
 const f=fixture(t);writeFileSync(f.lock+'.guard','unknown');const before=readFileSync(f.lock);
 assert.throws(()=>io.acquireLock(f.root,f.current,{active:f.active}),/guard/i);
 assert.throws(()=>io.releaseLock(f.root,f.owner),/guard/i);assert.deepEqual(readFileSync(f.lock),before);
 assert.equal(readFileSync(f.lock+'.guard','utf8'),'unknown');
});
test('two restarted Pi processes racing resume cannot both own/write the retained run',{timeout:10000},async t=>{
 const {spawn}=await import('node:child_process');
 const f=fixture(t),state={version:2,enabled:true,stage:'blocked',root:f.root,session:f.owner.session,run:f.owner.run,active:{...f.active,stage:'quality'},snapshot:{},leased:true,task:0,round:0,reports:[],checks:[],changedPaths:{},plan:{mode:'review',tasks:[{files:['a'],checks:[]}],checks:[],security:false}};
 const path=join(f.root,'retained.json');writeFileSync(path,JSON.stringify(state));
 const children=[0,1].map(()=>{
  const child=spawn(process.execPath,[new URL('./helpers/resume-process.mjs',import.meta.url).pathname,path],{env:process.env,stdio:['pipe','pipe','pipe']});
  let output='',errors='';child.stderr.on('data',b=>errors+=b);
  const ready=new Promise(resolve=>child.stdout.on('data',b=>{output+=b;if(output.startsWith('ready\n'))resolve();}));
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{try{assert.equal(code,0,errors);resolve(JSON.parse(output.trim().split('\n').at(-1)));}catch(e){reject(e);}});});
  t.after(()=>child.kill());return {child,ready,done};
 });
 await Promise.all(children.map(c=>c.ready));for(const c of children)c.child.stdin.end('resume\n');
 const results=await Promise.all(children.map(c=>c.done));
 assert.equal(results.filter(r=>r.acquired).length,1,JSON.stringify(results));
 const winner=results.find(r=>r.acquired),loser=results.find(r=>!r.acquired);
 assert.equal(winner.state.stage,'complete');assert.equal(loser.state.stage,'blocked');assert.ok(!loser.stages.includes('complete'));
 assert.match(loser.error,/guard|missing|alive|not proven dead|changed since inspection|fence/);assert.ok(results.every(r=>r.calls.length===0));
 assert.throws(()=>readFileSync(f.lock),/ENOENT/);
});
test('lock ownership is revalidated against the inspected owner, not a newer dead owner',t=>{
 const f=fixture(t),kill=process.kill,newOwner={...f.owner,pid:f.owner.pid+1};
 process.kill=pid=>{assert.equal(pid,f.owner.pid);writeFileSync(f.lock,JSON.stringify(newOwner));const e=new Error('offline dead process');e.code='ESRCH';throw e;};
 t.after(()=>{process.kill=kill;});
 assert.throws(()=>io.acquireLock(f.root,f.current,{active:f.active}),/changed.*inspection|inspection.*changed/i);
 assert.deepEqual(JSON.parse(readFileSync(f.lock)),newOwner);
});
test('unknown owner liveness (EPERM) is not death and does not unlock',t=>{
 const f=fixture(t),kill=process.kill,before=readFileSync(f.lock);
 process.kill=()=>{const error=new Error('permission denied');error.code='EPERM';throw error;};t.after(()=>{process.kill=kill;});
 assert.throws(()=>io.acquireLock(f.root,f.current,{active:f.active}),/not proven dead.*permission denied/i);
 assert.deepEqual(readFileSync(f.lock),before);
});
for(const [name,patch] of [
 ['wrong version',{version:2}],['missing observed time',{observedAt:null}],
 ['missing runner',{instances:[]}],['wrong runner instance',{runnerProcessInstanceId:'other-runner'}],
 ['missing exit evidence',{instances:[{...terminalProof().instances[0],signal:undefined}]}],
 ['unverified writer tree',{instances:[...terminalProof().instances,{kind:'pi-writer',processInstanceId:'writer',attempt:0,closeObservedAt:100,exitCode:0,signal:null,processTree:{state:'observed'}}]}]
])test(`malformed native proof (${name}) cannot reclaim or approve`,t=>{
 const f=fixture(t),before=readFileSync(f.lock);f.write('process-terminal.json',terminalProof('native',patch));
 assert.throws(()=>io.acquireLock(f.root,f.current,{active:f.active}),/proof/i);
 assert.throws(()=>io.readOutcome(f.active),/proof/i);assert.deepEqual(readFileSync(f.lock),before);
});
for(const legacy of [true,false])test(`delayed stale resumer cannot reclaim W0 after A advances to live coder W1 (${legacy?'legacy':'fenced'} journal)`,t=>{
 const f=fixture(t,{legacy}),path=join(f.root,'retained.json');
 const state={version:2,enabled:true,stage:'blocked',root:f.root,session:f.owner.session,run:f.owner.run,active:{...f.active,stage:'quality'},snapshot:{},leased:true,task:0,round:0,reports:[],checks:[],changedPaths:{},routes:{coder:'test/code',quality:'test/review'},plan:{title:'Two tasks',mode:'implementation',tasks:[{title:'Reviewed',files:['a'],checks:[]},{title:'Later coding',files:['b'],checks:['true']}],checks:[],security:false}};
 if(!legacy)state.lockFence=JSON.parse(readFileSync(f.lock)).fence;
 const run=(retained,mode)=>{
  writeFileSync(path,JSON.stringify(retained));
  const child=spawnSync(process.execPath,[new URL('./helpers/advance-process.mjs',import.meta.url).pathname,path,mode],{env:process.env,encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);
 };
 const a=run(state,'advance');assert.equal(a.acquired,true,a.error);assert.equal(a.calls.filter(c=>c==='spawn').length,1);
 assert.equal(a.state.active.stage,'coder');assert.equal(a.state.active.id,'later-coder');
 assert.equal(JSON.parse(readFileSync(join(a.state.active.dir,'status.json'))).state,'running');
 const before=readFileSync(f.lock),b=run(state,'observe');
 assert.equal(b.acquired,false,'stale B must not obtain ownership with W0 proof after A exits with live W1');
 assert.match(b.error,/fenc|stale/i);assert.ok(!b.calls.includes('spawn'));assert.deepEqual(readFileSync(f.lock),before);
 assert.ok(a.monitoring.lockFence,'A published ownership while observing W0');
 assert.notEqual(a.monitoring.lockFence,a.state.lockFence,'fence advanced when W0 was consumed, before W1');
 const staleMonitoring=run(a.monitoring,'observe');assert.equal(staleMonitoring.acquired,false);assert.match(staleMonitoring.error,/fenc|stale/i);
 assert.deepEqual(readFileSync(f.lock),before);assert.ok(!staleMonitoring.calls.includes('spawn'));
 const liveCurrent=run(a.state,'observe');assert.equal(liveCurrent.acquired,false);assert.match(liveCurrent.error,/live|closure/i);
 assert.deepEqual(readFileSync(f.lock),before);assert.ok(!liveCurrent.calls.includes('spawn'));
 const worker=a.state.active;
 writeFileSync(join(worker.dir,'status.json'),JSON.stringify({runId:worker.id,sessionId:worker.nativeSession,state:'complete',steps:[{agent:worker.agent,model:worker.model,attemptedModels:[worker.model],structuredOutputPath:join(worker.dir,'report.json')}]}));
 writeFileSync(join(worker.dir,'process-terminal.json'),JSON.stringify(terminalProof(worker.id)));
 const current=run(a.state,'finish');assert.equal(current.acquired,true,current.error);
 assert.equal(current.state.stage,'complete',current.state.reason);
 assert.deepEqual(current.state.reports.map(r=>r.native.id),['native','later-coder','later-reviewer']);
 assert.deepEqual(current.state.checks.map(c=>[c.command,c.code]),[['true',0]]);
 assert.equal(current.calls.filter(c=>c==='spawn').length,1,'only the remaining reviewer, not another coder');
 assert.throws(()=>readFileSync(f.lock),/ENOENT/);
});

test('same-process reload respects the current fence; stale acquire/release cannot change it',t=>{
 const f=fixture(t);f.current.fence=io.acquireLock(f.root,f.current,{active:f.active});
 const stale={...f.current};f.current.fence=io.acquireLock(f.root,f.current,{active:f.active});
 const before=readFileSync(f.lock);
 assert.throws(()=>io.acquireLock(f.root,stale,{active:f.active}),/fence/);
 assert.throws(()=>io.releaseLock(f.root,stale),/ownership/);
 assert.deepEqual(readFileSync(f.lock),before);
 io.releaseLock(f.root,f.current);
});
