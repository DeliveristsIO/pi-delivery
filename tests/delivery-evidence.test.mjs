import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import * as policy from '../extensions/delivery/policy.mjs';

const browser=()=>({acceptance:['Works'],runner:'scripts/browser.mjs',probe:'node scripts/browser.mjs --probe',scenarios:[{name:'navigation',command:'node scripts/browser.mjs --navigation'}],environment:'local',target:'http://127.0.0.1:3000',interactionScope:'Isolated fixture navigation only',artifacts:[{path:'navigation.txt',kind:'text',capture:'Redacted navigation assertions only'}]});
const plan=()=>({mode:'implementation',title:'UI',tasks:[{title:'UI',instructions:'Implement UI',files:['a'],acceptance:['Works'],checks:['true'],browser:browser()}],checks:[],security:false});
test('browser schema accepts explicit verification and rejects review execution and unsafe contracts',()=>{
 assert.doesNotThrow(()=>policy.validatePlan(plan()));
 for(const mutate of [p=>{p.mode='review';p.tasks[0].checks=[];},p=>p.tasks[0].browser.target='https://user:secret@example.test/?token=x',p=>p.tasks[0].browser.artifacts[0].path='../secret',p=>p.tasks[0].browser.runner='../outside',p=>p.tasks[0].browser.acceptance=['Unapproved requirement']]) {
  const p=plan();mutate(p);assert.throws(()=>policy.validatePlan(p));
 }
});
test('typed evidence block cannot contain an unresolved defect or approve work',()=>{
 assert.doesNotThrow(()=>policy.validateReport({status:'blocked',summary:'Need evidence',findings:[],blockedReason:'evidence_unavailable'}));
 for(const status of ['approved','changes_requested'])assert.throws(()=>policy.validateReport({status,summary:'Bad',findings:[],blockedReason:'evidence_unavailable'}));
 assert.throws(()=>policy.validateReport({status:'blocked',summary:'Bad',findings:['high: defect'],blockedReason:'evidence_unavailable'}));
});
test('artifact receipts bind identity, hash and commands and sanitize bounded text',async t=>{
 const e=await import('../extensions/delivery/evidence.mjs');
 const dir=mkdtempSync(join(tmpdir(),'delivery-evidence-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const text='navigation passed\nCookie: session=synthetic-cookie\nAuthorization: Bearer synthetic-bearer\nhttps://fixture.test/callback?token=synthetic-query#synthetic-fragment\npassword=synthetic-password';
 writeFileSync(join(dir,'navigation.txt'),text);
 const identity={task:0,round:0,source:'source-hash',phase:'verifier'};
 const report={...identity,status:'approved',summary:'Navigation passed',findings:[],commands:[{command:browser().scenarios[0].command,exitCode:0}],artifacts:[{path:'navigation.txt',sha256:createHash('sha256').update(text).digest('hex')}]};
 const receipt=e.collectEvidence(dir,browser(),report,identity);
 assert.match(receipt.artifacts[0].text,/navigation passed/);assert.doesNotMatch(JSON.stringify(receipt),/synthetic-(cookie|bearer|query|fragment|password)/);
 for(const change of [{source:'stale'},{task:1},{round:1},{phase:'probe'},{commands:[]},{artifacts:[{path:'navigation.txt',sha256:'wrong'}]}])assert.throws(()=>e.collectEvidence(dir,browser(),{...report,...change},identity));
 writeFileSync(join(dir,'navigation.txt'),'x'.repeat(20000));assert.throws(()=>e.collectEvidence(dir,browser(),report,identity),/oversized|limit/i);
 rmSync(join(dir,'navigation.txt'));symlinkSync('/etc/passwd',join(dir,'navigation.txt'));assert.throws(()=>e.collectEvidence(dir,browser(),report,identity),/symlink/i);
 const alias=join(dir,'alias');symlinkSync(dir,alias);assert.throws(()=>e.collectEvidence(alias,browser(),report,identity),/symlink|canonical/i);
});
