import {terminalProof} from './helpers/native-artifacts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,symlinkSync,rmSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadConfig,saveConfig,snapshot,repoRoot,readOutcome} from '../extensions/delivery/io.mjs';
import * as io from '../extensions/delivery/io.mjs';
const inspectRepository=(...args)=>io.inspectRepository(...args);
import {rpc} from '../extensions/delivery/rpc.mjs';
function fixture(t) {const d=mkdtempSync(join(tmpdir(),'delivery-test-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;}
test('config default, atomic roundtrip, malformed input and symlink refusal', t=>{
 const d=fixture(t),p=join(d,'config.json');assert.deepEqual(loadConfig(p),{version:1,routes:{},repos:[]});
 const c={version:1,routes:{planning:'custom/a'},repos:[d]};saveConfig(p,c);assert.deepEqual(loadConfig(p),c);
 saveConfig(p,{...c,evidence:{coder:'trial'}});assert.deepEqual(loadConfig(p).routes,c.routes);
 const link=join(d,'link');symlinkSync(p,link);assert.throws(()=>saveConfig(link,c),/symlink/);
 writeFileSync(p,'invalid');assert.throws(()=>loadConfig(p));
});
test('fingerprint includes untracked source, content and HEAD; canonical root in subdirectory',t=>{
 const d=fixture(t);execFileSync('git',['init','-q',d]);
 writeFileSync(join(d,'a'),'one');const a=JSON.stringify(snapshot(d));writeFileSync(join(d,'a'),'two');assert.notEqual(JSON.stringify(snapshot(d)),a);
 assert.equal(repoRoot(d),d);
 symlinkSync('/etc/passwd',join(d,'link'));assert.match(snapshot(d).link,/^symlink:/);
});
test('completion requires actual terminal proof, model and structured report',t=>{
 const d=fixture(t),id='run';
 const a={id,dir:d,model:'custom/a',agent:'delivery-coder',nativeSession:'session'};
 writeFileSync(join(d,'status.json'),JSON.stringify({runId:id,sessionId:'session',state:'complete',steps:[{agent:'delivery-coder',model:'custom/a',attemptedModels:['custom/a'],sessionFile:join(d,'actual-session.jsonl'),structuredOutputPath:join(d,'report.json')}]}));
 assert.equal(readOutcome(a),null);
 writeFileSync(join(d,'process-terminal.json'),JSON.stringify(terminalProof(id)));
 writeFileSync(join(d,'report.json'),JSON.stringify({status:'approved',summary:'ok',findings:[]}));
 assert.equal(readOutcome(a).status,'approved');
 assert.throws(()=>readOutcome({...a,model:'other/a'}),/model/);
 const s=JSON.parse(readFileSync(join(d,'status.json')));s.steps[0].attemptedModels=[];
 writeFileSync(join(d,'status.json'),JSON.stringify(s));assert.throws(()=>readOutcome(a),/model/);
});
test('RPC correlates replies and times out without installed owner',async()=>{
 const listeners=new Map();
 const events={on:(n,f)=>{listeners.set(n,f);return()=>listeners.delete(n);},emit:(n,r)=>{if(n.endsWith(':request')) listeners.get('subagents:rpc:v1:reply:'+r.requestId)({version:1,requestId:r.requestId,success:true,data:{ok:true}});}};
 assert.deepEqual(await rpc(events,'ping',{},50),{ok:true});assert.equal(listeners.size,0);
 events.emit=()=>{};await assert.rejects(rpc(events,'ping',{},5),/timed out/);assert.equal(listeners.size,0);
});
test('controlled inspection uses fixed read-only Git operations, not aliases, hooks or shell',t=>{
 const d=fixture(t),git=(...args)=>execFileSync('git',['-C',d,...args]);git('init','-q','-b','main');
 writeFileSync(join(d,'a'),'base\n');git('add','a');git('-c','user.name=T','-c','user.email=t@x','commit','-qm','base');
 const marker=join(d,'executed');
 for(const key of ['core.fsmonitor','core.pager','alias.status','alias.log'])git('config',key,`!touch ${marker}`);
 git('config','log.showSignature','true');git('config','gpg.program',marker);
 const before=readFileSync(join(d,'.git/index'));
 writeFileSync(join(d,'a'),'dirty\n');symlinkSync('/not/a/real/target',join(d,'external'));
 assert.match(inspectRepository(d,'status'),/a/);assert.match(inspectRepository(d,'status'),/external/);
 assert.match(inspectRepository(d,'history'),/base/);assert.deepEqual(readFileSync(join(d,'.git/index')),before);
 assert.throws(()=>readFileSync(marker),/ENOENT/);
 for(const view of ['status; touch executed','$(touch executed)','status > executed','-c alias.x=!id','diff','config',null])assert.throws(()=>inspectRepository(d,view),/inspection view/i);
 for(const offset of [-1,1.5,'0'])assert.throws(()=>inspectRepository(d,'status',offset),/offset/i);
});
test('controlled status refuses clean and process filters without executing them',t=>{
 for(const kind of ['clean','process']) {
  const d=fixture(t),git=(...args)=>execFileSync('git',['-C',d,...args]);git('init','-q','-b','main');
  writeFileSync(join(d,'.gitattributes'),'a filter=probe\n');writeFileSync(join(d,'a'),'initial\n');
  git('add','.');git('-c','user.name=T','-c','user.email=t@x','commit','-qm','base');
  const marker=join(d,'executed'),index=readFileSync(join(d,'.git/index'));
  git('config',`filter.probe.${kind}`,`touch '${marker}'; cat`);
  writeFileSync(join(d,'a'),'changed\n');const later=new Date(Date.now()+5000);utimesSync(join(d,'a'),later,later);
  assert.throws(()=>inspectRepository(d,'status'),/configured Git filters.*history/i);
  assert.match(inspectRepository(d,'history'),/base/);
  assert.throws(()=>readFileSync(marker),/ENOENT/);assert.deepEqual(readFileSync(join(d,'.git/index')),index);
 }
});
test('controlled inspection paginates bounded output',t=>{
 const d=fixture(t);execFileSync('git',['init','-q',d]);
 for(let i=0;i<600;i++)writeFileSync(join(d,String(i).padStart(3,'0')+'-'.repeat(80)),'');
 const first=inspectRepository(d,'status'),next=inspectRepository(d,'status',40000);
 assert.match(first,/truncated at 40000/i);assert.ok(first.length<40200);
 assert.match(next,/599/);assert.notEqual(first,next);
});
test('workspace lock excludes another session and never steals unknown ownership',t=>{
 const d=fixture(t),old=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=d;t.after(()=>{if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;});
 const owner={session:'one',run:'first'};owner.fence=io.acquireLock(d,owner);owner.fence=io.acquireLock(d,owner);
 assert.throws(()=>io.acquireLock(d,{session:'two',run:'second'}),/owned/);
 assert.throws(()=>io.releaseLock(d,{session:'one',run:'wrong'}),/ownership/);
 io.releaseLock(d,owner);io.acquireLock(d,{session:'two',run:'second'});
});
test('native partial failure needs terminal proof and cannot masquerade as completion',t=>{
 const d=fixture(t),active={id:'r',dir:d,nativeSession:'s',agent:'delivery-coder',model:'test/code'};
 writeFileSync(join(d,'status.json'),JSON.stringify({runId:'r',sessionId:'s',state:'partial',error:'provider unavailable',steps:[]}));assert.equal(readOutcome(active),null);
 writeFileSync(join(d,'process-terminal.json'),JSON.stringify(terminalProof('r')));assert.throws(()=>readOutcome(active),e=>e.closed===true && /partial/.test(e.message));
 assert.throws(()=>readOutcome({...active,nativeSession:'foreign'}),/identity/);
});
test('workspace lease rejects a second process even for the same retained session/run',t=>{
 const d=fixture(t),old=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=d;t.after(()=>{if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;});
 io.acquireLock(d,{session:'one',run:'same',pid:123});
 assert.throws(()=>io.acquireLock(d,{session:'one',run:'same',pid:456}),/owned/);
});
test('snapshot metadata cannot collide with a tracked or untracked source filename',t=>{
 const d=fixture(t);execFileSync('git',['init','-q',d]);writeFileSync(join(d,'$git-index'),'ordinary source');
 const s=snapshot(d);assert.equal(typeof s['.git/index'],'string');assert.equal(typeof s['$git-index'],'string');assert.notEqual(s['.git/index'],s['$git-index']);
});
test('snapshot hashes binary bytes without lossy text decoding',t=>{
 const d=fixture(t);execFileSync('git',['init','-q',d]);writeFileSync(join(d,'binary'),Buffer.from([255]));const before=snapshot(d);writeFileSync(join(d,'binary'),Buffer.from([254]));assert.notDeepEqual(snapshot(d),before);
});
test('expired terminal-proof wait stops with inspection guidance instead of polling forever',t=>{
 const d=fixture(t),active={id:'r',dir:d,nativeSession:'s',agent:'delivery-coder',model:'test/code'};
 writeFileSync(join(d,'status.json'),JSON.stringify({runId:'r',sessionId:'s',state:'complete',endedAt:Date.now()-120000,steps:[]}));
 assert.throws(()=>readOutcome(active),/terminal proof.*inspect/i);
 writeFileSync(join(d,'process-terminal.json'),JSON.stringify(terminalProof('foreign')));assert.throws(()=>readOutcome(active),/identity/i);
});
test('native outcome requires exact bound owner and run, never a parent UUID/path alternative',t=>{
 const d=fixture(t),active={id:'native-run',dir:d,session:'parent-uuid',nativeSession:join(d,'parent.jsonl'),agent:'delivery-coder',model:'test/code'};
 const status={runId:active.id,sessionId:active.nativeSession,state:'complete',steps:[{agent:active.agent,model:active.model,attemptedModels:[active.model],structuredOutputPath:join(d,'report.json')}]};
 const write=()=>writeFileSync(join(d,'status.json'),JSON.stringify(status));write();
 writeFileSync(join(d,'report.json'),JSON.stringify({status:'approved',summary:'Synthetic report',findings:[]}));
 writeFileSync(join(d,'process-terminal.json'),JSON.stringify(terminalProof(active.id)));
 assert.equal(readOutcome(active).status,'approved');
 for(const nativeSession of [undefined,null,'','   ',42])assert.throws(()=>readOutcome({...active,nativeSession}),/owner-session/);
 for(const sessionId of [active.session,join(d,'foreign.jsonl'),null]){status.sessionId=sessionId;write();assert.throws(()=>readOutcome(active),/owner-session/);}
 status.sessionId=active.nativeSession;status.runId='foreign-run';write();assert.throws(()=>readOutcome(active),/run-ID/);
});
