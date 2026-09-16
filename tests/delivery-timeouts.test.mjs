import test from 'node:test';
import assert from 'node:assert/strict';
import {timeoutPolicy,attemptBudget} from '../extensions/delivery/policy.mjs';
import {runProgress} from '../extensions/delivery/io.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('coding gets 45 minutes plus one bounded 15-minute continuation; reviews get 15 minutes',()=>{
 const p=timeoutPolicy();assert.equal(p.coderMs,45*60000);assert.equal(p.continuationMs,15*60000);assert.equal(p.reviewMs,15*60000);
 assert.equal(attemptBudget(p,'coder',0,false),45*60000);
 assert.equal(attemptBudget(p,'coder',45*60000,true),15*60000);
 assert.equal(attemptBudget(p,'coder',55*60000,false),5*60000);
 assert.throws(()=>attemptBudget(p,'coder',60*60000,false),/budget exhausted/i);
});
test('timeout configuration is bounded and rejects typos',()=>{
 assert.equal(timeoutPolicy().commandMs,120000);
 assert.equal(timeoutPolicy({coderMs:30*60000}).coderMs,30*60000);
 assert.equal(timeoutPolicy({commandMs:30*60000}).commandMs,30*60000);
 assert.equal(timeoutPolicy({continuationMs:0}).continuationMs,0);
 assert.throws(()=>timeoutPolicy({coderMs:0}),/coderMs/);
 assert.throws(()=>timeoutPolicy({commandMs:0}),/commandMs/);
 assert.throws(()=>timeoutPolicy({coderMs:Infinity}),/coderMs/);
 assert.throws(()=>timeoutPolicy({coderMS:123}),/Unknown/);
});
test('native timeout status supplies activity and runner-owned prior logs, not heartbeat inference',()=>{
 const dir=mkdtempSync(join(tmpdir(),'delivery-progress-'));
 try {
  writeFileSync(join(dir,'status.json'),JSON.stringify({runId:'r',state:'failed',error:'Subagent timed out after 900000ms.',startedAt:100,lastUpdate:900100,timeoutMs:900000,steps:[{model:'p/m',attemptedModels:['p/m'],lastActivityAt:899999,currentTool:'bash',sessionFile:'/tmp/worker.jsonl',transcriptPath:'relative-not-evidence'}]}));
  const p=runProgress({id:'r',dir});assert.equal(p.timedOut,true);assert.equal(p.durationMs,900000);assert.equal(p.currentTool,'bash');assert.equal(p.lastActivityAt,899999);assert.deepEqual(p.sessionFiles,['/tmp/worker.jsonl']);
  assert.throws(()=>runProgress({id:'wrong',dir}),/identity/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('native partial connection failure is terminal even when runner exits successfully',()=>{
 const dir=mkdtempSync(join(tmpdir(),'delivery-partial-'));
 try {
  writeFileSync(join(dir,'status.json'),JSON.stringify({runId:'r',state:'partial',error:'Connection error.\nRequired structured output was not produced',startedAt:100,endedAt:137100,steps:[{status:'failed',exitCode:1,model:'p/m',attemptedModels:['p/m']}]}));
  const p=runProgress({id:'r',dir});assert.equal(p.state,'failed');assert.equal(p.nativeState,'partial');assert.equal(p.durationMs,137000);assert.equal(p.timedOut,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
