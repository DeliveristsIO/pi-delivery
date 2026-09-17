import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog, validatePlan, initialState, approve, advance, parentToolAllowed, validateRoutes, correctionPolicy, fixRoundLimit, createExecutionAuthority, executionAuthorityMatches } from '../extensions/delivery/policy.mjs';

export const routes = { planning: 'openai-codex/gpt-6-astra', coder: 'ollama-cloud/coder', spec: 'anthropic/reviewer', quality: 'anthropic/reviewer', security: 'openai-codex/reviewer' };
export const plan = { title: 'Fixture', tasks: [{ title: 'Task', instructions: 'Implement fixture', files: ['src/a.js'], checks: ['node --test'], acceptance: ['Works'] }], checks: ['node --test'], risk: 'low', security: true };

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
  assert.throws(() => validatePlan({...plan, tasks:[{...plan.tasks[0], checks:undefined}]}), /explicit task.checks/);
  assert.throws(() => validatePlan({...plan, tasks:[{...plan.tasks[0], files:['../escape']}]}), /files/);
  assert.throws(() => validatePlan({...plan, tasks:[{...plan.tasks[0], files:[':(exclude)src/a.js']}]}), /files/);
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
test('execution authority is bound to the exact user, session, repository, proposal and material policy', () => {
  const binding={turn:'turn-1',userTurn:'Implement the fixture',session:'session',repository:'/repo',plan,workspace:'tree',routes,timeouts:{coderMs:1},corrections:{maxFixRounds:4},gitPolicy:{reviewPolicy:'balanced'}};
  const authority=createExecutionAuthority(binding);
  assert.equal(executionAuthorityMatches(authority,binding),true);
  for(const [key,value] of [
    ['turn','turn-2'],['userTurn','Implement something else'],['session','other'],['repository','/other'],['plan',{...plan,title:'Changed'}],['workspace','other'],
    ['routes',{...routes,coder:'other/model'}],['timeouts',{coderMs:2}],['corrections',{maxFixRounds:5}],['gitPolicy',{reviewPolicy:'strict'}]
  ]) assert.equal(executionAuthorityMatches(authority,{...binding,[key]:value}),false,key);
  assert.throws(()=>createExecutionAuthority({...binding,userTurn:''}),/user turn/i);
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
test('new correction policy permits four rework rounds after the initial attempt',()=>{
  const p=correctionPolicy();
  assert.deepEqual(p,{maxFixRounds:4,source:'default'});
  let s={...approve({...initialState(),plan,stage:'awaiting-approval'},routes,'tree'),correctionPolicy:p,stage:'quality'};
  const bad={status:'changes_requested',summary:'bug',findings:['a:1 fix']};
  for(let expected=1;expected<=4;expected++) {
    s=advance(s,bad,'tree');
    assert.equal(s.stage,'coder');assert.equal(s.round,expected);
    s.stage='quality';
  }
  s=advance(s,bad,'tree');
  assert.equal(s.stage,'blocked');assert.match(s.reason,/round limit.*4/i);
});
test('retained state without correction policy keeps two-round contract',()=>{
  assert.equal(fixRoundLimit({}),2);
});
test('correction policy rejects unsafe limits',()=>{
  for(const maxFixRounds of [-1,1.5,9])assert.throws(()=>correctionPolicy({maxFixRounds}),/maxFixRounds/);
});
test('blocked reports stop without incrementing the fix round',()=>{
  const s={...approve({...initialState(),plan,stage:'awaiting-approval'},routes,'tree'),stage:'quality',round:3};
  const blocked=advance(s,{status:'blocked',summary:'host unavailable',findings:[]},'tree');
  assert.equal(blocked.stage,'blocked');
  assert.equal(blocked.round,3);
});
test('high risk plans cannot skip security', () => {
  assert.equal(validatePlan({...plan,risk:'high',security:false}).security,true);
});
