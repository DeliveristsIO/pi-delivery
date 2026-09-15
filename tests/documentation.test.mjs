import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('orchestration guidance uses real delivery gates rather than direct worker dispatch',()=>{
 const text=readFileSync(resolve(root,'skills/orchestrate-delivery/SKILL.md'),'utf8');
 assert.match(text,/delivery_plan/);assert.match(text,/delivery_execute/);assert.match(text,/delivery_resume/);
 assert.match(text,/new corrective plan/i);assert.match(text,/No saved Markdown file is required/);
 assert.doesNotMatch(text,/No custom .*setup command is required|Dispatch `delivery-coder`|instruction limit, not mechanical/);
});
test('public documentation relative links resolve',()=>{
 for(const name of ['README.md','CONTRIBUTING.md','SECURITY.md','tests/README.md','docs/configuration.md','docs/roadmap.md','docs/releasing.md']) {
  const path=resolve(root,name),text=readFileSync(path,'utf8');
  for(const [,target] of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
   if(target.startsWith('#')||/^https?:/.test(target))continue;
   assert.ok(existsSync(resolve(dirname(path),target.split('#')[0])),`${name}: broken link ${target}`);
  }
 }
});
