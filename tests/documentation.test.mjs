import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('current prompts describe only the thin pipeline and common structured report contract',()=>{
 const text=readFileSync(resolve(root,'skills/orchestrate-delivery/SKILL.md'),'utf8');
 for(const name of ['delivery_plan','delivery_execute','delivery_status','delivery_resume','delivery_stop'])assert.ok(text.includes(name));
 assert.match(text,/two correction rounds/);assert.match(text,/Unsupported old journals/);assert.match(text,/read-only review/i);
 assert.doesNotMatch(text,/delivery_(cleanup|scope|steer|diff|inspect)|correctionAdoption|reviewPolicy|executionProfile/);
 const security=readFileSync(resolve(root,'skills/security-review/SKILL.md'),'utf8');assert.match(security,/Findings are strings/);
});
test('completed review guidance avoids permission-to-plan questions without granting implementation authority',()=>{
 const text=readFileSync(resolve(root,'skills/orchestrate-delivery/SKILL.md'),'utf8');
 assert.match(text,/completed review/i);assert.match(text,/do not ask.*want.*plan/i);
 assert.match(text,/implementation still requires.*approval/i);
});

test('agent prompts preserve quality gates and evidence discipline',()=>{
 const coder=readFileSync(resolve(root,'agents/delivery-coder.md'),'utf8');
 assert.match(coder,/TDD\/debugging\/verification/);assert.match(coder,/changed files, acceptance coverage, exact checks\/results/i);
 assert.match(coder,/blocked verdict only for genuinely ambiguous outcomes/i);
 const reviewer=readFileSync(resolve(root,'agents/delivery-reviewer.md'),'utf8');
 assert.match(reviewer,/Do not trust coder claims/i);assert.match(reviewer,/Missing evidence is uncertainty/i);
 assert.match(reviewer,/Reject shallow approvals/i);
 const security=readFileSync(resolve(root,'agents/delivery-security.md'),'utf8');
 assert.match(security,/Threat-model the change/i);assert.match(security,/attacker-controlled input/i);
 assert.match(security,/exploit preconditions, attack path, impact, and remediation/i);
});

test('skills preserve high-quality planning, security and exact route guidance',()=>{
 const orchestration=readFileSync(resolve(root,'skills/orchestrate-delivery/SKILL.md'),'utf8');
 assert.match(orchestration,/clear instructions.*concrete acceptance.*task-specific executable checks/i);
 assert.match(orchestration,/shallow approvals, fabricated evidence, behavior drift/i);
 const security=readFileSync(resolve(root,'skills/security-review/SKILL.md'),'utf8');
 assert.match(security,/Threat-model before approving/i);assert.match(security,/exploit preconditions, impact and remediation/i);
 const models=readFileSync(resolve(root,'skills/select-task-model/SKILL.md'),'utf8');
 assert.match(models,/Availability is not successful inference, quality proof, price proof or task qualification/i);
 assert.match(models,/Route changes require a new displayed approval/i);
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
test('all runtime modules are explicitly packaged; removed modules are not referenced',()=>{
 const pkg=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
 for(const file of readdirSync(resolve(root,'extensions/delivery')))assert.ok(pkg.files.includes(`extensions/delivery/${file}`),file);
 assert.ok(!pkg.files.some(file=>/cleanup|merge\.mjs/.test(file)));
 for(const file of pkg.files)assert.ok(existsSync(resolve(root,file)),file);
});
test('public autonomy contract explains file hints, security binding and old-session restart',()=>{
 for(const file of ['README.md','SECURITY.md','docs/configuration.md','skills/orchestrate-delivery/SKILL.md']) {
  const text=readFileSync(resolve(root,file),'utf8');assert.match(text,/starting points/i);assert.match(text,/changed paths/i);
  assert.match(text,/security route/i);assert.match(text,/fresh session/i);
 }
});

test('current recovery guidance distinguishes observation, cancellation and restart evidence',()=>{
 for(const file of ['README.md','docs/configuration.md','SECURITY.md','skills/orchestrate-delivery/SKILL.md']) {
  const text=readFileSync(resolve(root,file),'utf8');
  assert.match(text,/delivery_resume/);assert.match(text,/delivery_stop/);assert.match(text,/same-process/i);assert.match(text,/process-terminal\.json/);
  assert.match(text,/pending|unknown/i);assert.match(text,/no new approval|without new approval/i);
  assert.doesNotMatch(text,/different Pi process cannot reclaim/i);
 }
});
