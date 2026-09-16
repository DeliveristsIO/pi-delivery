import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,symlinkSync,unlinkSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fingerprint,revisionRange,diff,reviewPatch,workingTreeEvidence,assertCommittedWorkspace,validateCommands,readPlan} from '../extensions/delivery/io.mjs';
import {initialState,approve,advance,validatePlan} from '../extensions/delivery/policy.mjs';
function repo(t){const d=mkdtempSync(join(tmpdir(),'delivery-review-'));t.after(()=>rmSync(d,{recursive:true,force:true}));execFileSync('git',['init','-q',d]);return d;}
const plan={title:'Review',mode:'review',commits:2,tasks:[{title:'Review changes',instructions:'No fixes',files:['a'],acceptance:['Requirements satisfied']}],checks:['node --test'],risk:'low',security:true};
const routes={planning:'p/a',coder:'p/b',spec:'p/c',quality:'p/d',security:'p/e'};
test('internal file links are fingerprinted, including target content and link identity',t=>{
 const d=repo(t);writeFileSync(join(d,'AGENTS.md'),'rules');symlinkSync('AGENTS.md',join(d,'CLAUDE.md'));
 const before=fingerprint(d);writeFileSync(join(d,'AGENTS.md'),'new rules');assert.notEqual(fingerprint(d),before);
 writeFileSync(join(d,'OTHER.md'),'new rules');const target=fingerprint(d);
 unlinkSync(join(d,'CLAUDE.md'));symlinkSync('OTHER.md',join(d,'CLAUDE.md'));assert.notEqual(fingerprint(d),target);
});
test('unsupported link targets warn outside scope but block when required',t=>{
 const d=repo(t),link=join(d,'link');
 for(const target of ['/etc/passwd','missing','link','.']) {
  symlinkSync(target,link);
  const warnings=[];assert.match(fingerprint(d,{scope:['app/model.rb'],warnings}),/^[a-f0-9]{64}$/);assert.equal(warnings.length,1);
  assert.throws(()=>fingerprint(d,{scope:['link/file']}),/required.*symlink/i);
  assert.throws(()=>fingerprint(d,{commands:['test -e link/file']}),/required.*symlink/i);
  unlinkSync(link);
 }
});
test('working-tree evidence scopes tracked diff and untracked discovery to task paths',t=>{
 const d=repo(t);mkdirSync(join(d,'app'),{recursive:true});mkdirSync(join(d,'other'),{recursive:true});
 writeFileSync(join(d,'app','a.rb'),'changed\n');writeFileSync(join(d,'other','b.rb'),'unrelated\n');
 const evidence=workingTreeEvidence(d,['app/a.rb']);
 assert.ok(evidence.includes('app/a.rb'));assert.ok(!evidence.includes('other/b.rb'));
});
test('commit range supplies actual committed diff even on a clean workspace',t=>{
 const d=repo(t);
 for(const value of ['zero','one','two']) {
  writeFileSync(join(d,'a'),value+'\n');execFileSync('git',['-C',d,'add','a']);
  execFileSync('git',['-C',d,'-c','user.name=Test','-c','user.email=test@localhost','commit','-qm',value]);
 }
 const range=revisionRange(d,2);assert.match(range.base,/^[a-f0-9]{40}$/);assert.notEqual(range.base,range.head);
 const report=diff(d,range);assert.match(report,/-zero/);assert.match(report,/\+two/);assert.match(report,/one/);
 assert.throws(()=>revisionRange(d,100),/1.*20|range/i);
 assertCommittedWorkspace(d,range);
 writeFileSync(join(d,'a'),'x'.repeat(60000)+'UNIQUE_TAIL\n');
 assert.throws(()=>assertCommittedWorkspace(d,range),/tracked files/);
 execFileSync('git',['-C',d,'add','a']);execFileSync('git',['-C',d,'-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','large change']);
 assert.throws(()=>assertCommittedWorkspace(d,range),/HEAD changed/);
 const large=revisionRange(d,2);assert.match(diff(d,large),/offset=40000/);
 assert.match(diff(d,large,40000,40000),/UNIQUE_TAIL/);
 const patch=reviewPatch(d,large);t.after(()=>rmSync(dirname(patch),{recursive:true,force:true}));
 assert.equal(readFileSync(patch,'utf8'),diff(d,large,Infinity));
 assert.match(readFileSync(patch,'utf8'),/UNIQUE_TAIL/);
});
test('review approval starts reviewers, never coder; findings never auto-fix',()=>{
 let s=approve({...initialState(),stage:'awaiting-approval',plan},routes,'hash');assert.equal(s.stage,'review-checks');
 s.stage='spec'; // Host check gate is exercised by extension tests.
 s=advance(s,{status:'changes_requested',summary:'bug',findings:['a:1 fix needed']},'hash');
 assert.equal(s.stage,'blocked');assert.equal(s.round,0);
});
test('checklist prose is rejected before shell execution, while test commands validate without running',t=>{
 const d=repo(t);
 assert.throws(()=>validateCommands(d,['Verify exact base/head before execution; exclude untracked .mcp.json.']),/Not a runnable verification command/);
 validateCommands(d,['node --test missing-test.mjs']); // Validation must not execute the test.
 assert.throws(()=>validateCommands(d,['node --test "unterminated']),/Not a runnable/);
 assert.equal(validatePlan({...plan,checks:[]}).checks.length,0);
});
test('uninitialized out-of-scope gitlinks do not block unrelated application tasks',t=>{
 const d=repo(t);mkdirSync(join(d,'nested'));
 execFileSync('git',['-C',d,'update-index','--add','--cacheinfo','160000,'+'a'.repeat(40)+',nested']);
 const warnings=[];const before=fingerprint(d,{scope:['app/model.rb'],warnings});assert.equal(warnings.length,1);
 assert.throws(()=>fingerprint(d,{scope:['nested/file']}),/Required nested repository/);
 execFileSync('git',['-C',d,'update-index','--cacheinfo','160000,'+'b'.repeat(40)+',nested']);assert.notEqual(fingerprint(d),before);
});
test('source plan reads are versioned and confined to real plan files',t=>{
 const d=repo(t),path='docs/spark/plans/task.md';mkdirSync(join(d,'docs/spark/plans'),{recursive:true});
 writeFileSync(join(d,path),'# Approved plan');const before=readPlan(d,path);assert.equal(before.content,'# Approved plan');assert.equal(before.path,path);
 writeFileSync(join(d,path),'# Changed plan');assert.notEqual(readPlan(d,path).hash,before.hash);
 assert.throws(()=>readPlan(d,'../../secret.md'),/under docs/);
 symlinkSync('task.md',join(d,'docs/spark/plans/alias.md'));assert.throws(()=>readPlan(d,'docs/spark/plans/alias.md'),/symlink/);
});
test('opaque symlink identity remains monitored without reading target contents',t=>{
 const d=repo(t),link=join(d,'.devcontainer-shared');
 symlinkSync('../missing',link);const before=fingerprint(d);unlinkSync(link);symlinkSync('../other-missing',link);assert.notEqual(fingerprint(d),before);
});
test('review plan rejects unknown modes and implementation commit ranges',()=>{
 assert.throws(()=>validatePlan({...plan,mode:'unknown'}),/mode/i);
 assert.throws(()=>validatePlan({...plan,mode:'implementation'}),/commits/i);
});
