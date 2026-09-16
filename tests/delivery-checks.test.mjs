import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePlan,allChecks,checksForTask,repairCheckScopes} from '../extensions/delivery/policy.mjs';
import {fingerprint} from '../extensions/delivery/io.mjs';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const task={title:'First',instructions:'Do only this task',files:['a'],acceptance:['works']};
const plan={title:'Two tasks',tasks:[task,{...task,title:'Later',files:['later']}],checks:['node release.mjs'],risk:'low',security:false};
const mapping=[['node first.mjs'],['node later.mjs']];
function legacy(){return {enabled:true,stage:'blocked',active:null,plan,task:0,round:2,snapshot:'tree',coding:{0:{spentMs:12345,continuations:1}},reports:[0,1,2].flatMap(round=>[
 {stage:'coder',task:0,round,snapshot:'tree',report:{status:'approved',summary:'done',findings:[]}},
 {stage:'checks',task:0,round,snapshot:'tree',report:{status:'changes_requested',summary:'Host verification failed',findings:['node release.mjs: Missing future file']}}
])};}
test('real workspace hash is independent of check scoping, but still detects file changes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'delivery-check-hash-'));
 try {
  execFileSync('git',['init','-q',dir]);writeFileSync(join(dir,'first.mjs'),'// existing, initially unreferenced test\n');
  const old=fingerprint(dir,{scope:['a'],commands:plan.checks});
  assert.equal(fingerprint(dir,{scope:['a'],commands:[...plan.checks,...mapping.flat()]}),old);
  writeFileSync(join(dir,'first.mjs'),'// changed\n');
  assert.notEqual(fingerprint(dir,{scope:['a'],commands:plan.checks}),old);
  symlinkSync('../outside',join(dir,'opaque'));
  fingerprint(dir,{commands:plan.checks});
  assert.throws(()=>fingerprint(dir,{commands:[...plan.checks,'node opaque']}),/Required workspace symlink/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('implementation plans require explicit task checks; retained single-task legacy plans stay compatible',()=>{
 assert.throws(()=>validatePlan(plan),/explicit task.checks/);
 assert.throws(()=>validatePlan({...plan,tasks:[task]}),/explicit task.checks/);
 assert.throws(()=>checksForTask(plan,0),/Legacy/);
 const p=validatePlan({...plan,tasks:plan.tasks.map((t,i)=>({...t,checks:mapping[i]}))});
 assert.deepEqual(checksForTask(p,0),mapping[0]);assert.deepEqual(allChecks(p),['node release.mjs','node first.mjs','node later.mjs']);
 assert.deepEqual(checksForTask({...plan,tasks:[task]},0),plan.checks);
 assert.throws(()=>validatePlan({...p,tasks:[{...p.tasks[0],checks:[]}]}),/Task checks/);
});
test('scope correction preserves final gates, evidence, and spent coding budget',()=>{
 const s=legacy(),fixed=repairCheckScopes(s,mapping);
 assert.deepEqual(fixed.plan.checks,s.plan.checks);assert.deepEqual(fixed.reports,s.reports);assert.deepEqual(fixed.coding,s.coding);
 assert.equal(fixed.stage,'checks');assert.equal(fixed.round,0);assert.equal(fixed.checkScopeRecovery.creditedRounds,2);
 assert.equal(s.round,2);assert.equal(s.plan.tasks[0].checks,undefined);
 assert.throws(()=>repairCheckScopes({...fixed,stage:'blocked'},mapping),/legacy/);
});
test('scope recovery cannot bypass current review findings or unchanged failing task checks',()=>{
 const s=legacy();s.reports.push({stage:'quality',task:0,round:2,snapshot:'tree',report:{status:'changes_requested',summary:'Bug',findings:['a:1 broken']}});
 assert.throws(()=>repairCheckScopes(s,mapping),/independent review/);
 assert.throws(()=>repairCheckScopes(legacy(),[['node release.mjs'],mapping[1]]),/not caused by a deferred/);
 assert.throws(()=>repairCheckScopes({...legacy(),active:{id:'live'}},mapping),/owned child/);
 assert.throws(()=>repairCheckScopes({...legacy(),snapshot:'changed'},mapping),/unchanged workspace/);
 assert.throws(()=>repairCheckScopes(legacy(),[mapping[0]]),/every existing task/);
});
test('only incorrectly staged host failures earn retry credit',()=>{
 const s=legacy();s.reports[1]={...s.reports[1],stage:'quality',report:{status:'changes_requested',summary:'Real defect',findings:['a:1 fix']}};
 const fixed=repairCheckScopes(s,mapping);assert.equal(fixed.round,1);assert.equal(fixed.checkScopeRecovery.creditedRounds,1);
});
test('a reserved, closed timeout continuation can adopt scopes without a second grant',()=>{
 const s={...legacy(),reports:[],round:0,pendingContinuation:true,interruptions:[{id:'closed',task:0,snapshot:'tree'}]};
 const fixed=repairCheckScopes(s,mapping);assert.equal(fixed.stage,'coder');assert.equal(fixed.pendingContinuation,true);assert.deepEqual(fixed.coding,s.coding);
 assert.throws(()=>repairCheckScopes({...s,interruptions:[]},mapping),/completed coder evidence/);
});
