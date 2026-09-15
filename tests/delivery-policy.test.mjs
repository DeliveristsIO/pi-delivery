import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog, validatePlan, initialState, approve, advance, parentToolAllowed, validateRoutes } from '../extensions/delivery/policy.mjs';

export const routes = { planning: 'openai-codex/gpt-6-astra', coder: 'ollama-cloud/coder', spec: 'anthropic/reviewer', quality: 'anthropic/reviewer', security: 'openai-codex/reviewer' };
export const plan = { title: 'Fixture', tasks: [{ title: 'Task', instructions: 'Implement fixture', files: ['src/a.js'], acceptance: ['Works'] }], checks: ['node --test'], risk: 'low', security: true };

test('provider neutral catalog distinguishes available from listed; no inference claims', () => {
  const all = [{provider:'anthropic',id:'a'}, {provider:'custom',id:'b'}];
  assert.deepEqual(catalog(all, [all[1]]), [
    {id:'anthropic/a', available:false, evidence:'not tested'},
    {id:'custom/b', available:true, evidence:'not tested'}
  ]);
});
test('routes require every exact model, never inherit', () => {
  assert.throws(() => validateRoutes({...routes, coder:'inherit'}, Object.values(routes)), /coder/);
  assert.throws(() => validateRoutes({...routes, coder:undefined}, Object.values(routes)), /coder/);
  assert.deepEqual(validateRoutes(routes, Object.values(routes)), routes);
});
test('plan must have bounded concrete scope and verification', () => {
  assert.deepEqual(validatePlan(plan), plan);
  assert.throws(() => validatePlan({...plan, checks:[]}), /checks/);
  assert.throws(() => validatePlan({...plan, tasks:[{...plan.tasks[0], files:['../escape']}]}), /files/);
});
test('parent cannot edit, shell, delegate directly or bypass via custom tools', () => {
  for (const name of ['bash','powershell','edit','write','interactive_shell','mcp','subagent']) assert.equal(parentToolAllowed(name, {}), false, name);
  assert.equal(parentToolAllowed('read', {}), true);
  assert.equal(parentToolAllowed('delivery_plan', {}), true);
  assert.equal(parentToolAllowed('delivery_configure', {}), true);
  assert.equal(parentToolAllowed('delivery_steer', {}), true);
  assert.equal(parentToolAllowed('subagent', {action:'status'}), true);
  assert.equal(parentToolAllowed('subagent', {action:'steer'}), false);
  assert.equal(parentToolAllowed('subagent', {action:'create'}), false);
});
test('approval is bound to plan and routes; no approval means no work', () => {
  const s=initialState();
  assert.throws(() => approve(s, routes, 'tree'), /plan/);
  s.plan=plan; s.stage='awaiting-approval';
  const a=approve(s,routes,'tree');
  assert.equal(a.stage,'coder'); assert.equal(a.snapshot,'tree');
  assert.notEqual(a.routes,routes);
});
test('full stage order requires each passing result and host verification', () => {
  let s=approve({...initialState(), plan, stage:'awaiting-approval'}, routes,'tree');
  for(const stage of ['coder','checks','spec','quality','security']) {
    assert.equal(s.stage,stage);
    s=advance(s,{status:'approved',summary:'checked',findings:[]},'tree');
  }
  assert.equal(s.stage,'verification');
  assert.throws(()=>advance(s,{status:'approved',findings:[]},'tree'),/host verification/);
  s=advance(s,{verified:true},'tree');
  assert.equal(s.stage,'complete');
});
test('review mutation, missing verdict and inconsistent clean finding fail closed', () => {
  const s={...approve({...initialState(),plan,stage:'awaiting-approval'},routes,'tree'),stage:'spec'};
  assert.throws(()=>advance(s,{status:'approved',summary:'ok',findings:[]},'other'),/changed/);
  assert.throws(()=>advance(s,{},'tree'),/report/);
  assert.throws(()=>advance(s,{status:'approved',summary:'ok',findings:['bug']},'tree'),/report/);
});
test('fixes rerun every review; retry bound blocks repeated findings', () => {
  let s={...approve({...initialState(),plan,stage:'awaiting-approval'},routes,'tree'),stage:'quality'};
  const bad={status:'changes_requested',summary:'bug',findings:['fix bug']};
  s=advance(s,bad,'tree'); assert.equal(s.stage,'coder'); assert.equal(s.round,1);
  s.stage='quality'; s=advance(s,bad,'tree'); assert.equal(s.round,2);
  s.stage='quality'; s=advance(s,bad,'tree'); assert.equal(s.stage,'blocked');
});
test('high risk plans cannot skip security', () => {
  assert.equal(validatePlan({...plan,risk:'high',security:false}).security,true);
});
