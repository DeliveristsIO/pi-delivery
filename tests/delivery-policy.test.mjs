import test from 'node:test';
import assert from 'node:assert/strict';
import {PLAN_SCHEMA,SCHEMAS,validate,validatePlan,validateReport,validateRoutes,isApproval,assertUnchanged,assertCoderChanges} from '../extensions/delivery/policy.mjs';
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
 for(const text of ['Approved','approval',' Approval! ','I approve','yes','Yes, please.','OK','okay','proceed','Implement the displayed plan','Please implement this plan.','Execute the unchanged plan','Go ahead',
  'arroved','aproved','approvd','Approoved!','yep','sure','lgtm','ship it','do it','yes go ahead','ok approved','Looks good, proceed','👍','approved, thanks','continue','Continue.','good','great','perfect','fine','cool','nice','alright','correct','sounds good','works for me','go on','carry on','👌','🚀','k','agree'])assert.equal(isApproval(text),true,text);
 for(const text of ['unapproved','stop','do not continue','hold on','incorrect','not good','cancel','later','disapproved','not approved','nope','reject','wait','no','Approved but only task one'])assert.equal(isApproval(text),false,text);
 for(const text of ['Can you implement this plan?','Do not implement the plan','Plan only','Approved, but change task two','Explain why I should approve the plan','The document says Approved','Should we go ahead?','approval?','no approval','approval pending','yes, but change task two','okay?','proceed only after review'])assert.equal(isApproval(text),false,text);
});
test('malformed or contradictory native reports never approve work',()=>{
 for(const report of [null,{}, {status:'approved',summary:'ok',findings:['bug']},{status:'changes_requested',summary:'bug',findings:[]},{status:'approved',summary:'ok',findings:[],extra:true}])assert.throws(()=>validateReport(report));
 assert.equal(validateReport({status:'approved',summary:'source inspected; tests not run',findings:[]}).status,'approved');
});
test('snapshot checks preserve dirty unrelated files and detect review races and index changes',()=>{
 const before={a:'dirty','unrelated':'keep','.git/index':'staged'};
 assert.deepEqual(assertCoderChanges(before,{...before,a:'implemented',related:'new'}),['a','related']);
 for(const after of [{...before,unrelated:'lost'},{...before,'.git/index':'changed'},{...before,a:'race'}])assert.throws(()=>assertUnchanged(before,after));
 assert.throws(()=>assertUnchanged(before,{...before,ab:'outside'}));
});

test('coder edits allow repository paths but never Git metadata or changed symlinks',()=>{
 const before={a:'old','.git/index':'index','.git/HEAD':'head',link:'symlink:opaque'};
 assert.deepEqual(assertCoderChanges(before,{...before,a:'new',related:'added'}),['a','related']);
 for(const path of ['.git/index','.git/HEAD','link'])assert.throws(()=>assertCoderChanges(before,{...before,[path]:'changed'}));
 assert.throws(()=>assertCoderChanges(before,{...before,related:'symlink:escape'}),/symlink/);
 const removed={...before};delete removed.a;assert.deepEqual(assertCoderChanges(before,removed),['a']);
});

test('opaque boundaries reject intersecting scopes and coder additions/removal/replacement, not unrelated edits',()=>{
 const before={outer:'old','vendor/nested':'opaque-directory:identity','.git/index':'gitlink-revision'};
 assert.deepEqual(assertCoderChanges(before,{...before,outer:'new'}),['outer']);
 for(const after of [{...before,'vendor/nested':'opaque-directory:replacement'},{outer:'old','.git/index':'gitlink-revision'},{...before,added:'opaque-directory:new'},{...before,'vendor/nested/source':'new'}])assert.throws(()=>assertCoderChanges(before,after),/opaque.*run delivery in that repository/i);
 assert.throws(()=>assertCoderChanges(before,{...before,'.git/index':'new-revision'}),/Git metadata/);
});
