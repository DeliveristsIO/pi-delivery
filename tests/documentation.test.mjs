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
 assert.match(text,/Do not generate another corrective plan automatically after final exhaustion/i);
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
test('recovery documentation explains explicit dirty-candidate adoption and reload limits',()=>{
 const configuration=readFileSync(resolve(root,'docs/configuration.md'),'utf8');const readme=readFileSync(resolve(root,'README.md'),'utf8');
 for(const text of [configuration,readme]) {
  assert.match(text,/correctionAdoption/);assert.match(text,/branch.*HEAD.*inventory.*index.*fingerprint/is);assert.match(text,/no (?:WIP )?commit.*stash.*baseline commit/is);assert.match(text,/reload|restart/i);
  assert.match(text,/standalone.*review.*(?:read-only|no write|does not).*author/i);assert.match(text,/full adopted candidate|original changes/i);
 }
});
test('configuration documentation defines the version-1 correction policy migration',()=>{
 const configuration=readFileSync(resolve(root,'docs/configuration.md'),'utf8');
 const readme=readFileSync(resolve(root,'README.md'),'utf8');
 for(const text of [configuration,readme]) {
  assert.match(text, /"corrections"\s*:\s*\{\s*"maxFixRounds"\s*:\s*4\s*\}/);
  assert.match(text, /integers?\s+`?0\.\.8`?/i);
  assert.match(text, /default\s+(?:is\s+)?`?4`?\s+for\s+new\s+plans/i);
  assert.match(text, /older\s+retained\s+plans?.*2.*(?:explicit|migration)/i);
  assert.match(text, /Phase\s+2.*profiles.*migration/i);
 }
});
