import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,approve,advance,validatePlan} from '../extensions/delivery/policy.mjs';
const routes={planning:'p',coder:'c',spec:'s',quality:'q',security:'x'};
const plan={title:'Feature',mode:'implementation',changeType:'feature',tasks:[{title:'one',instructions:'one',files:['a'],checks:['node --test'],acceptance:['ok']},{title:'two',instructions:'two',files:['b'],checks:['node --test'],acceptance:['ok']}],checks:['node --test'],risk:'low',security:false};
test('Git lifecycle reviews every task, commits, runs final checks, then aggregate reviews',()=>{
 let s=approve({...initialState(),stage:'awaiting-approval',plan,gitPolicy:{changeType:'feature'}},routes,'head');
 for(const stage of ['coder','checks','spec','quality','security']) {assert.equal(s.stage,stage);s=advance(s,{status:'approved',summary:'ok',findings:[]},'head');}
 assert.equal(s.stage,'commit');s=advance(s,{committed:true,status:'approved',summary:'feat',findings:[]},'head');
 assert.equal(s.stage,'coder');
 for(const stage of ['coder','checks','spec','quality','security']) {s=advance(s,{status:'approved',summary:'ok',findings:[]},'head');}
 assert.equal(s.stage,'commit');s=advance(s,{committed:true,status:'approved',summary:'feat',findings:[]},'head');
 assert.equal(s.stage,'final-checks');s=advance(s,{status:'approved',summary:'ok',findings:[]},'head');
 assert.equal(s.stage,'aggregate-quality');s=advance(s,{status:'approved',summary:'ok',findings:[]},'head');assert.equal(s.stage,'aggregate-security');s=advance(s,{status:'approved',summary:'ok',findings:[]},'head');assert.equal(s.stage,'verification');
});

test('aggregate reviewer corrections retain correction identity through a commit',()=>{
 let s=approve({...initialState(),stage:'awaiting-approval',plan,gitPolicy:{changeType:'feature'}},routes,'head');
 for(const stage of ['coder','checks','spec','quality','security','commit','coder','checks','spec','quality','security','commit','final-checks']) s=advance(s,stage==='commit'?{committed:true,status:'approved',summary:'ok',findings:[]}:{status:'approved',summary:'ok',findings:[]},'head');
 s=advance(s,{status:'changes_requested',summary:'aggregate issue',findings:['fix']},'head');
 assert.equal(s.stage,'coder');assert.equal(s.aggregateCorrection,true);
 for(const stage of ['coder','checks','final-checks','aggregate-quality','aggregate-security']) {assert.equal(s.stage,stage);s=advance(s,{status:'approved',summary:'ok',findings:[]},'head');}
 assert.equal(s.stage,'commit');s=advance(s,{committed:true,status:'approved',summary:'bug',findings:[]},'head');assert.equal(s.stage,'verification');
});

test('balanced lifecycle uses one optimizer and skips task security when explicitly non-sensitive',()=>{
 const balanced={...plan,reviewPolicy:'balanced',tasks:plan.tasks.map(t=>({...t,sensitive:false}))};
 assert.equal(validatePlan(balanced).reviewPolicy,'balanced');
 let s=approve({...initialState(),stage:'awaiting-approval',plan:balanced,gitPolicy:{changeType:'feature',reviewPolicy:'balanced'}},routes,'head');
 for(const stage of ['coder','checks','optimizer']) {assert.equal(s.stage,stage);s=advance(s,{status:'approved',summary:'ok',findings:[],optimizerChanged:false,optimizerBeforeSnapshot:'before',optimizerAfterSnapshot:'after'},'head');}
 assert.deepEqual(s.optimizerPasses[0],{ran:true,changed:false,beforeSnapshot:'before',afterSnapshot:'after',checks:'reused'});
 assert.equal(s.stage,'quality');s=advance(s,{status:'approved',summary:'combined',findings:[]},'head');assert.equal(s.stage,'commit');
});

test('strict lifecycle reruns checks after optimizer changes and runs separate reviews',()=>{
 const strict={...plan,reviewPolicy:'strict',tasks:plan.tasks.map(t=>({...t,sensitive:false}))};
 let s=approve({...initialState(),stage:'awaiting-approval',plan:strict,gitPolicy:{changeType:'feature',reviewPolicy:'strict'}},routes,'head');
 for(const stage of ['coder','checks','optimizer']) {assert.equal(s.stage,stage);s=advance(s,{status:'approved',summary:'ok',findings:[],optimizerChanged:stage==='optimizer'},'head');}
 assert.equal(s.stage,'optimizer-checks');s=advance(s,{status:'approved',summary:'ok',findings:[]},'head');
 for(const stage of ['spec','quality','security']) {assert.equal(s.stage,stage);s=advance(s,{status:'approved',summary:'ok',findings:[]},'head');}
 assert.equal(s.stage,'commit');
});

test('a non-approved optimizer attempt still consumes the one optimizer pass',()=>{
 const balanced={...plan,reviewPolicy:'balanced',tasks:plan.tasks.map(t=>({...t,sensitive:false}))};
 let s=approve({...initialState(),stage:'awaiting-approval',plan:balanced,gitPolicy:{changeType:'feature',reviewPolicy:'balanced'}},routes,'head');
 s=advance(s,{status:'approved',summary:'coder',findings:[]},'head');s=advance(s,{status:'approved',summary:'checks',findings:[]},'head');
 s=advance(s,{status:'changes_requested',summary:'optimizer issue',findings:['fix']},'head');assert.equal(s.stage,'coder');assert.equal(s.optimizerPasses[0].ran,true);assert.equal(s.optimizerPasses[0].status,'changes_requested');
 s=advance(s,{status:'approved',summary:'fixed',findings:[]},'head');s=advance(s,{status:'approved',summary:'checks',findings:[]},'head');assert.equal(s.stage,'quality');
});

test('optimizer pass state resets when a task advances to the next task',()=>{
 const balanced={...plan,reviewPolicy:'balanced',tasks:plan.tasks.map(t=>({...t,sensitive:false}))};
 let s=approve({...initialState(),stage:'awaiting-approval',plan:balanced,gitPolicy:{changeType:'feature',reviewPolicy:'balanced'}},routes,'head');
 for(const stage of ['coder','checks','optimizer'])s=advance(s,{status:'approved',summary:'ok',findings:[],optimizerChanged:false},'head');
 s=advance(s,{status:'approved',summary:'combined',findings:[]},'head');s=advance(s,{committed:true,status:'approved',summary:'commit',findings:[]},'head');
 assert.equal(s.task,1);assert.equal(s.optimizerBypass,false);assert.equal(s.stage,'coder');
});

test('correction after balanced combined review skips a second optimizer pass',()=>{
 const balanced={...plan,reviewPolicy:'balanced',tasks:plan.tasks.map(t=>({...t,sensitive:false}))};
 let s=approve({...initialState(),stage:'awaiting-approval',plan:balanced,gitPolicy:{changeType:'feature',reviewPolicy:'balanced'}},routes,'head');
 for(const stage of ['coder','checks','optimizer'])s=advance(s,{status:'approved',summary:'ok',findings:[],optimizerChanged:false},'head');
 s=advance(s,{status:'changes_requested',summary:'fix',findings:['fix']},'head');assert.equal(s.stage,'coder');
 s=advance(s,{status:'approved',summary:'fixed',findings:[]},'head');assert.equal(s.stage,'checks');
 s=advance(s,{status:'approved',summary:'ok',findings:[]},'head');assert.equal(s.stage,'quality');
});
