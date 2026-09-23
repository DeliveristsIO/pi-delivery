import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {snapshot,workingTreeEvidence} from '../extensions/delivery/io.mjs';
test('reviewers have native strict read-only tool allowlists without shell or browser capabilities',()=>{
 for(const name of ['reviewer','security']) {
  const profile=readFileSync(new URL(`../agents/delivery-${name}.md`,import.meta.url),'utf8');
  assert.match(profile,/^tools: read, grep, find, ls$/m);assert.match(profile,/^excludeTools: bash, powershell, edit, write$/m);
  assert.doesNotMatch(profile,/optimizer|balanced|strict tasks|aggregate|commit gate/i);
 }
});
test('dirty worktree evidence is bounded and snapshot detects changes without writing Git',t=>{
 const root=mkdtempSync(join(tmpdir(),'delivery-review-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 execFileSync('git',['init','-q',root]);writeFileSync(join(root,'untracked'),'keep');
 const before=snapshot(root);assert.match(workingTreeEvidence(root),/untracked/);assert.deepEqual(snapshot(root),before);
 writeFileSync(join(root,'untracked'),'changed');assert.notDeepEqual(snapshot(root),before);
});
test('worker profiles judge product intent, not file-list membership, and preserve preexisting work',()=>{
 for(const name of ['coder','reviewer','security']) {
  const profile=readFileSync(new URL(`../agents/delivery-${name}.md`,import.meta.url),'utf8');
  assert.match(profile,/starting points.*not.*permission list/i);
  assert.match(profile,/approved product task/i);assert.match(profile,/preexisting/i);
 }
 const coder=readFileSync(new URL('../agents/delivery-coder.md',import.meta.url),'utf8');
 assert.match(coder,/without.*per-file approval/i);assert.match(coder,/task-related.*check failures/i);
});
