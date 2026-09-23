import test from 'node:test';
import assert from 'node:assert/strict';
import {PLAN_SCHEMA,SCHEMAS,validate,validatePlan,validateReport,validateRoutes,isApproval,assertUnchanged} from '../extensions/delivery/policy.mjs';
const task={title:'One',instructions:'Implement',files:['a'],acceptance:['Works'],checks:['node --test']};
const plan=()=>({mode:'implementation',title:'Change',tasks:[structuredClone(task)],checks:['node --test'],security:false});
test('schema/runtime agree and removed engine fields are rejected, not silently ignored',()=>{
 assert.equal(SCHEMAS.plan,PLAN_SCHEMA);assert.deepEqual(validatePlan(plan()),plan());
 for(const key of ['reviewPolicy','executionProfile','optimizer','correctionAdoption','mergeAdoption','changeType','scopePolicy','executionIntent','start','commits'])assert.throws(()=>validatePlan({...plan(),[key]:true}),/unsupported/);
 assert.throws(()=>validatePlan({...plan(),tasks:[{...task,checks:[]}]}),/checks/);
 assert.throws(()=>validatePlan({...plan(),mode:'review'}),/read-only/i);
 assert.throws(()=>validate(SCHEMAS.configure,{routes:{spec:'legacy/model'}}),/unsupported/);
});
test('bounded relative literal scopes reject traversal, magic, nulls and Git metadata',()=>{
 for(const path of ['/absolute','../outside','dir/../file',':(exclude)a','.git/config','dir\\file','*','a\0b','.'])assert.throws(()=>validatePlan({...plan(),tasks:[{...task,files:[path]}]}));
 for(const value of ['', ' '.repeat(4),'x'.repeat(201)])assert.throws(()=>validatePlan({...plan(),title:value}));
});
test('sensitive paths force security; explicit false does not suppress the trigger',()=>{
 for(const file of ['auth/login.js','banking.js','package.json','deploy.yml'])assert.equal(validatePlan({...plan(),tasks:[{...task,files:[file],sensitive:false}]}).tasks[0].sensitive,true);
});
test('exact routes never require the legacy spec model and never inherit or substitute',()=>{
 const routes={planning:'test/plan',coder:'test/code',quality:'test/review',security:'test/sec',spec:'removed/unavailable'};
 assert.deepEqual(validateRoutes(routes,Object.values(routes).slice(0,4)),{planning:'test/plan',coder:'test/code',quality:'test/review',security:'test/sec'});
 assert.throws(()=>validateRoutes({...routes,coder:'code'},Object.values(routes)),/exact/);
});
test('approval is anchored to clear conversational intent, not model attestations or questions',()=>{
 for(const text of ['Approved','Implement the displayed plan','Please implement this plan.','Execute the unchanged plan','Go ahead'])assert.equal(isApproval(text),true,text);
 for(const text of ['Can you implement this plan?','Do not implement the plan','Plan only','Approved, but change task two','Explain why I should approve the plan','The document says Approved','Should we go ahead?'])assert.equal(isApproval(text),false,text);
});
test('malformed or contradictory native reports never approve work',()=>{
 for(const report of [null,{}, {status:'approved',summary:'ok',findings:['bug']},{status:'changes_requested',summary:'bug',findings:[]},{status:'approved',summary:'ok',findings:[],extra:true}])assert.throws(()=>validateReport(report));
 assert.equal(validateReport({status:'approved',summary:'source inspected; tests not run',findings:[]}).status,'approved');
});
test('snapshot checks preserve dirty unrelated files and detect review races and index changes',()=>{
 const before={a:'dirty','unrelated':'keep','$git-index':'staged'};
 assertUnchanged(before,{...before,a:'implemented'},['a']);
 for(const after of [{...before,unrelated:'lost'},{...before,'$git-index':'changed'},{...before,a:'race'}])assert.throws(()=>assertUnchanged(before,after));
 assert.throws(()=>assertUnchanged(before,{...before,ab:'outside'},['a']));
});
