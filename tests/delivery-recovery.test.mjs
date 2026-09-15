import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, advance, approve, initialState } from '../extensions/delivery/policy.mjs';
import { saveConfig, fingerprint, isSettled, verifyCommand } from '../extensions/delivery/io.mjs';
import { mkdtempSync,writeFileSync,symlinkSync,lstatSync,rmSync } from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const plan={title:'x',tasks:[{title:'x',instructions:'x',files:['a'],acceptance:['x']}],checks:['true'],risk:'low',security:false};
const routes={planning:'p/a',coder:'p/b',spec:'p/c',quality:'p/c',security:'p/d'};
function dir(t){const d=mkdtempSync(join(tmpdir(),'delivery-recovery-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;}
test('banking path automatically upgrades risk, not merely security review',()=>{
 const p=validatePlan({...plan,tasks:[{...plan.tasks[0],files:['app/bank_account.rb']}]});assert.equal(p.risk,'high');assert.equal(p.security,true);
});
test('dangling config symlink is not silently replaced',t=>{
 const d=dir(t),p=join(d,'config');symlinkSync(join(d,'absent'),p);assert.throws(()=>saveConfig(p,{}),/symlink/);assert.ok(lstatSync(p).isSymbolicLink());
});
test('a failed-but-closed child can release ownership; running child cannot',t=>{
 const d=dir(t),active={id:'run',dir:d};assert.equal(isSettled(active),false);
 writeFileSync(join(d,'process-terminal.json'),JSON.stringify({runId:'run',state:'observed',instances:[{exitCode:1}]}));assert.equal(isSettled(active),true);
});
test('final verification does not approve a changed tree',()=>{
 const s={...approve({...initialState(),stage:'awaiting-approval',plan},routes,'old'),stage:'verification'};
 assert.throws(()=>advance(s,{verified:true},'new'),/changed/);
});
test('verification records actual command failure and timeout',async t=>{
 const d=dir(t);assert.equal((await verifyCommand(d,'exit 7')).code,7);
 const timeout=await verifyCommand(d,'sleep 5',undefined,20);assert.equal(timeout.terminated,true);assert.notEqual(timeout.code,0);
});
