import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadConfig,saveConfig,fingerprint,repoRoot,readOutcome} from '../extensions/delivery/io.mjs';
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
 writeFileSync(join(d,'a'),'one');const a=fingerprint(d);writeFileSync(join(d,'a'),'two');assert.notEqual(fingerprint(d),a);
 assert.equal(repoRoot(d),d);
 symlinkSync('/etc/passwd',join(d,'link'));assert.throws(()=>fingerprint(d,{scope:['link']}),/symlink/);
});
test('completion requires actual terminal proof, model and structured report',t=>{
 const d=fixture(t),id='run';
 const a={id,dir:d,model:'custom/a'};
 writeFileSync(join(d,'status.json'),JSON.stringify({runId:id,state:'complete',steps:[{model:'custom/a',attemptedModels:['custom/a'],sessionFile:join(d,'actual-session.jsonl'),structuredOutputPath:join(d,'report.json')}]}));
 assert.equal(readOutcome(a),null);
 writeFileSync(join(d,'process-terminal.json'),JSON.stringify({runId:id,state:'observed',instances:[{exitCode:0,signal:null}]}));
 writeFileSync(join(d,'report.json'),JSON.stringify({status:'approved',summary:'ok',findings:[],executionEvidence:{sessionFiles:['/fabricated']}}));
 assert.equal(readOutcome(a).status,'approved');
 assert.deepEqual(readOutcome(a).executionEvidence.sessionFiles,[join(d,'actual-session.jsonl')]);
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
