export const ROLES = ['planning', 'coder', 'spec', 'quality', 'security'];
export const AGENTS = { coder: 'delivery-coder', optimizer: 'delivery-coder', spec: 'delivery-reviewer', quality: 'delivery-reviewer', security: 'delivery-security' };
export const REVIEW_POLICIES = ['balanced','strict'];
export const ASTRA = 'openai-codex/gpt-6-astra';
export const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    status: {type:'string', enum:['approved','changes_requested','blocked']},
    summary: {type:'string', maxLength:8000},
    findings: {type:'array', maxItems:50, items:{type:'string', maxLength:2000}}
  }, required:['status','summary','findings']
};
const check = (ok, message) => { if (!ok) throw new Error(message); };
const text = (v, max=16000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
export const CHANGE_TYPES = ['feature','bug','chore'];
export function validateSupervisorReply(value) {
  check(value && typeof value==='object' && !Array.isArray(value),'Supervisor reply must be an envelope');
  const keys=Object.keys(value).sort();
  check(JSON.stringify(keys)===JSON.stringify(['content','kind','nonAuthoritative']),'Supervisor reply envelope contains unknown or missing keys');
  check(value.nonAuthoritative===true,'Supervisor reply must be explicitly non-authoritative');
  check(value.kind==='evidence' || value.kind==='clarification','Supervisor reply kind is not allowlisted');
  check(text(value.content,16000) && !value.content.includes('\0'),'Supervisor reply content is empty or oversized');
  return {kind:value.kind,content:value.content,nonAuthoritative:true};
}
export function catalog(all, available) {
  const ids = new Set(available.map(m => `${m.provider}/${m.id}`));
  return [...new Set(all.map(m=>`${m.provider}/${m.id}`))].sort().map(id=>({id,available:ids.has(id),evidence:'not tested'}));
}
export function validateRoutes(routes, available) {
  for (const role of ROLES) check(text(routes?.[role],256) && available.includes(routes[role]), `Missing/unavailable exact model route: ${role}. Select an available exact model using delivery_configure, or configure its provider with /login. /delivery setup is the interactive alternative.`);
  return Object.fromEntries(ROLES.map(r=>[r,routes[r]]));
}
export function validateFallbacks(fallbacks={}, routes={}, available) {
  check(fallbacks && typeof fallbacks==='object' && !Array.isArray(fallbacks),'Invalid fallback routes');
  for (const role of Object.keys(fallbacks)) {
    check(ROLES.includes(role),`Unknown fallback role: ${role}`);
    check(Array.isArray(fallbacks[role]) && fallbacks[role].length<=3,`Fallback routes for ${role} must contain 0–3 models`);
    const seen=new Set([routes[role]]);
    for (const id of fallbacks[role]) {
      check(text(id,256) && available.includes(id),`Missing/unavailable exact fallback model for ${role}: ${id}`);
      check(!seen.has(id),`Duplicate fallback model for ${role}: ${id}`);seen.add(id);
    }
  }
  return Object.fromEntries(ROLES.map(role=>[role,structuredClone(fallbacks[role] || [])]));
}
export function validatePlan(input) {
  check(input && typeof input==='object' && JSON.stringify(input).length<=64000, 'Invalid or oversized plan');
  check(text(input.title,200), 'Invalid plan title');
  check(input.mode===undefined || ['implementation','review'].includes(input.mode), 'Invalid plan mode');
  if(input.start!==undefined)check(typeof input.start==='boolean','start must be a boolean');
  if(input.executionIntent!==undefined) {
    check(input.mode!=='review' && input.executionIntent && typeof input.executionIntent==='object' && !Array.isArray(input.executionIntent),'executionIntent is only valid for implementation plans');
    check(JSON.stringify(Object.keys(input.executionIntent).sort())===JSON.stringify(['kind','userTurn']),'executionIntent contains unknown or missing fields');
    check(input.executionIntent.kind==='explicit-implementation' && text(input.executionIntent.userTurn,16000) && !input.executionIntent.userTurn.includes('\0'),'Invalid executionIntent attestation');
  }
  if(input.reviewAttachment!==undefined) {
    check(input.mode==='review' && input.reviewAttachment && typeof input.reviewAttachment==='object' && !Array.isArray(input.reviewAttachment),'reviewAttachment is only valid for read-only review plans');
    check(JSON.stringify(Object.keys(input.reviewAttachment))===JSON.stringify(['kind']) && input.reviewAttachment.kind==='retained-recovery','Invalid reviewAttachment attestation');
  }
  if(input.correctionAdoption!==undefined) {
    check(input.mode!=='review' && input.correctionAdoption && typeof input.correctionAdoption==='object' && !Array.isArray(input.correctionAdoption),'correctionAdoption is only valid for implementation plans');
    check(JSON.stringify(Object.keys(input.correctionAdoption).sort())===JSON.stringify(['kind','userTurn']) && input.correctionAdoption.kind==='retained-candidate' && text(input.correctionAdoption.userTurn,16000) && !input.correctionAdoption.userTurn.includes('\0'),'Invalid correctionAdoption attestation');
  }
  if(input.changeType!==undefined)check(input.mode!=='review' && CHANGE_TYPES.includes(input.changeType),'changeType must be feature, bug, or chore and is only valid for implementation plans');
  if(input.reviewPolicy!==undefined)check(input.mode!=='review' && REVIEW_POLICIES.includes(input.reviewPolicy),'reviewPolicy must be balanced or strict and is only valid for implementation plans');
  if(input.commits!==undefined)check(input.mode==='review' && Number.isInteger(input.commits) && input.commits>=1 && input.commits<=20,'commits requires review mode and 1–20 commits');
  check(Array.isArray(input.tasks) && input.tasks.length>0 && input.tasks.length<=12, 'Plan needs 1–12 tasks');
  for (const t of input.tasks) {
    check(text(t.title,200) && text(t.instructions), 'Invalid task instructions');
    if(t.sensitive!==undefined)check(typeof t.sensitive==='boolean','Task sensitivity must be a boolean');
    check(Array.isArray(t.files) && t.files.length>0 && t.files.length<=100 && t.files.every(f=>text(f,512) && !f.startsWith('/') && !f.startsWith(':') && !f.includes('\\') && !f.split('/').includes('..') && !f.split('/').includes('.git')), 'Invalid task files');
    if(t.checks!==undefined)check(validChecks(t.checks,input.mode!=='review'),'Task checks must be executable commands (nonempty for implementation)');
    check(Array.isArray(t.acceptance) && t.acceptance.length>0 && t.acceptance.length<=30 && t.acceptance.every(a=>text(a,2000)), 'Task needs acceptance criteria');
  }
  check(Array.isArray(input.checks) && (input.mode==='review' || input.checks.length>0) && input.checks.length<=10 && input.checks.every(c=>text(c,2000) && !c.includes('\0')), 'Use executable verification commands in checks (not review criteria); reviews may use an empty list');
  if(input.mode!=='review')check(input.tasks.every(t=>Array.isArray(t.checks)),'Implementation plans require explicit task.checks; plan.checks are final release checks');
  if(input.mode==='review')check(input.tasks.every(t=>!t.checks?.length),'Read-only review uses plan.checks, not task.checks');
  check(['low','high'].includes(input.risk) && typeof input.security==='boolean', 'Specify risk and security review');
  const p=structuredClone(input);
  // Conservative trigger supplements user-approved risk classification; not a security classifier.
  if (/auth|bank|payment|secret|upload|dependenc|deploy|network|permission|package(-lock)?\.json|Gemfile|\.github\//i.test(p.tasks.flatMap(t=>t.files).join('\n'))) p.risk='high';
  if (p.risk==='high') p.security=true;
  return p;
}
const validChecks=(commands,required=false)=>Array.isArray(commands) && (!required || commands.length>0) && commands.length<=10 && commands.every(c=>text(c,2000) && !c.includes('\0'));
export function allChecks(plan) {return [...new Set([...(plan?.checks || []),...(plan?.tasks || []).flatMap(t=>t.checks || [])])];}
export function checksForTask(plan,index) {
  const commands=plan.tasks[index]?.checks ?? (plan.tasks.length===1?plan.checks:undefined);
  check(validChecks(commands,true),'Legacy multi-task plan needs task-specific checks. Use delivery_resume with taskChecks derived from the approved source plan; keep final checks intact.');
  return commands;
}
export function repairCheckScopes(state,taskChecks) {
  check(state.stage==='blocked' && !state.active,'Check-scope recovery requires stopped execution with no owned child');
  check(state.plan?.mode!=='review' && state.plan?.tasks.length>1 && state.plan.tasks.every(t=>t.checks===undefined),'Check-scope recovery applies only to legacy multi-task implementation plans');
  check(Array.isArray(taskChecks) && taskChecks.length===state.plan.tasks.length,'Supply checks for every existing task');
  const s=structuredClone(state);
  s.plan=validatePlan({...s.plan,tasks:s.plan.tasks.map((t,i)=>({...t,checks:taskChecks[i]}))});
  if(s.pendingContinuation && s.interruptions?.some(r=>r.task===s.task && r.snapshot===s.snapshot)) {
    s.checkScopeRecovery={previousRound:s.round,creditedRounds:0,deferredChecks:[]};
    s.stage='coder';s.reason='';return s;
  }
  const lastCoder=s.reports.findLastIndex(r=>r.task===s.task && r.stage==='coder');
  const coder=s.reports[lastCoder];
  check(coder?.report.status==='approved' && coder.snapshot===s.snapshot,'Recovery requires completed coder evidence for the unchanged workspace');
  check(s.reports.slice(lastCoder+1).every(r=>r.task===s.task && r.stage==='checks'),'Cannot bypass an independent review through check-scope recovery');
  const deferred=s.plan.checks.filter(c=>!taskChecks[s.task].includes(c));
  const failures=s.reports.filter(r=>r.task===s.task && r.report.status==='changes_requested');
  const corrected=failures.filter(r=>r.stage==='checks' && r.report.summary==='Host verification failed' && r.report.findings.length>0 && r.report.findings.every(f=>deferred.some(c=>f.startsWith(c+': '))));
  check(s.reports.slice(lastCoder+1).every(r=>r.report.status==='approved' || corrected.includes(r)),'Current check failure was not caused by a deferred release check');
  const credited=corrected.filter(r=>r.round<2).length;
  s.checkScopeRecovery={previousRound:s.round,creditedRounds:Math.min(s.round,credited),deferredChecks:deferred};
  s.round=Math.max(0,s.round-credited);s.stage='checks';s.reason='';s.feedback='';s.checks=[];
  return s;
}
export function parentToolAllowed(name, input) {
  if (['read','grep','find','ls','delivery_plan','delivery_execute','delivery_resume','delivery_status','delivery_diff','delivery_configure','delivery_steer'].includes(name)) return true;
  if (name==='subagent') return ['status','list','get','models','guide','doctor','children.list'].includes(input?.action);
  // Keep reply out of this global allowlist: only the extension's active-owned-run
  // interception admits native supervisor replies, which are informational evidence
  // and cannot authorize scope/model/budget, review waivers or tool permissions.
  return name==='subagent_supervisor' && ['pending','list'].includes(input?.action);
}
export function timeoutPolicy(input={}) {
  const defaults={coderMs:45*60000,continuationMs:15*60000,reviewMs:15*60000,commandMs:120000,idleWarningMs:5*60000,deadlineWarningMs:5*60000};
  check(input && typeof input==='object' && !Array.isArray(input),'Invalid timeout configuration');
  for(const key of Object.keys(input))check(Object.hasOwn(defaults,key),`Unknown timeout setting: ${key}`);
  const p={...defaults,...input};
  for(const [key,value] of Object.entries(p))check(Number.isSafeInteger(value) && value>=(key==='continuationMs'?0:60000) && value<=2*60*60000,`Invalid timeout setting: ${key}`);
  return p;
}
export function executionProfile(value='default') {
  check(value==='default' || value==='dev', 'Invalid execution profile');
  return value;
}
export function profileDefaults(profile='default') {
  executionProfile(profile);
  if(profile==='dev') return {timeouts:{coderMs:10*60000,continuationMs:5*60000,reviewMs:5*60000,commandMs:60000,idleWarningMs:120000,deadlineWarningMs:120000},corrections:{maxFixRounds:1},optimizer:false,aggregateSecurity:false};
  return {timeouts:{},corrections:{},optimizer:true,aggregateSecurity:true};
}
export function recommendExecution(plan) {
  check(plan && typeof plan==='object','Execution recommendation needs a plan');
  const tasks=Array.isArray(plan.tasks)?plan.tasks:[],files=new Set(tasks.flatMap(task=>task.files || [])),checks=tasks.reduce((n,task)=>n+(task.checks?.length || 0),0)+(plan.checks?.length || 0);
  const sensitive=plan.security===true || plan.risk==='high' || tasks.some(task=>task.sensitive===true);
  const reasons=[];
  if(sensitive) reasons.push('security-sensitive or high-risk work');
  if(tasks.length>2) reasons.push(`${tasks.length} implementation tasks`);
  if(files.size>12) reasons.push(`${files.size} files in scope`);
  if(checks>6) reasons.push(`${checks} verification commands`);
  const full=sensitive || tasks.length>2 || files.size>12 || checks>6;
  const split=tasks.length===1 && (files.size>8 || (tasks[0]?.instructions?.length || 0)>4500);
  return {profile:full?'default':'dev',label:full?'FULL':'FAST / DEV',split,reasons:reasons.length?reasons:['bounded low-risk change'],files:files.size,tasks:tasks.length,checks};
}
export function attemptBudget(policy,stage,spentMs=0,continuation=false) {
  check(Number.isFinite(spentMs) && spentMs>=0,'Invalid recorded coding time');
  if(stage!=='coder')return policy.reviewMs;
  const remaining=policy.coderMs+policy.continuationMs-spentMs;
  const budget=Math.min(continuation?policy.continuationMs:policy.coderMs,remaining);
  check(budget>0,'Coding task budget exhausted; a new budget needs explicit approval');
  return budget;
}
export function correctionPolicy(input={},legacy=false) {
  check(input && typeof input==='object' && !Array.isArray(input),'Invalid correction policy');
  for(const key of Object.keys(input))check(key==='maxFixRounds',`Unknown correction policy setting: ${key}`);
  const maxFixRounds=input.maxFixRounds ?? (legacy?2:4);
  check(Number.isInteger(maxFixRounds) && maxFixRounds>=0 && maxFixRounds<=8,'Invalid maxFixRounds');
  return {maxFixRounds,source:legacy?'legacy':input.maxFixRounds===undefined?'default':'configured'};
}
export function fixRoundLimit(state) {
  const policy=state?.correctionPolicy;
  if(!policy)return correctionPolicy({},true).maxFixRounds;
  check(policy && typeof policy==='object' && !Array.isArray(policy),'Invalid correction policy');
  for(const key of Object.keys(policy))check(key==='maxFixRounds' || key==='source',`Unknown correction policy setting: ${key}`);
  return correctionPolicy({maxFixRounds:policy.maxFixRounds}).maxFixRounds;
}
const authorityFields=['turn','userTurn','session','repository','plan','workspace','routes','timeouts','corrections','gitPolicy','adoption'];
function authorityBinding(binding) {return Object.fromEntries(authorityFields.map(key=>[key,structuredClone(binding?.[key] ?? null)]));}
export function createExecutionAuthority(binding) {
  check(text(binding?.turn,1024) && text(binding?.userTurn,16000) && !binding.userTurn.includes('\0'),'Execution authority requires an exact real-user turn');
  check(text(binding?.session,1024) && text(binding?.repository,4096),'Execution authority requires session and repository identity');
  check(binding.plan && binding.workspace && binding.routes && binding.timeouts && binding.corrections,'Execution authority requires complete proposal bindings');
  return {version:1,...authorityBinding(binding)};
}
export function executionAuthorityMatches(authority,binding) {
  return authority?.version===1 && JSON.stringify(authorityBinding(authority))===JSON.stringify(authorityBinding(binding));
}
export function initialState() {
  return {version:1,enabled:false,stage:'planning',task:0,round:0,aggregateRound:0,plan:null,routes:null,fallbacks:null,snapshot:null,active:null,reports:[],feedback:'',reason:'',gitPolicy:null,optimizerPasses:{},optimizerBypass:false,reviewedContentSnapshot:null,reviewContentCandidate:null};
}
function cumulativeFeedback(previous, report) {
  const entry=JSON.stringify({summary:report.summary,findings:report.findings});
  const lines=previous ? previous.split('\n\n') : [];
  if(lines.some(line=>line===entry)) return previous;
  // Keep the contract bounded while retaining recent actionable reports. This
  // prevents a long repair history from crowding out the task instructions.
  return [...lines,entry].slice(-6).join('\n\n').slice(-12000);
}
function lifecycleReviewPolicy(state) { return state?.gitPolicy?.reviewPolicy || null; }
function aggregateNeedsSecurity(state) { return state.plan?.aggregateSecurity!==false || lifecycleReviewPolicy(state)==='strict' || state.plan?.security===true || state.plan?.tasks?.some(task=>task.sensitive===true); }
function taskNeedsSecurity(state) {
  const policy=lifecycleReviewPolicy(state);
  if(!policy) return Boolean(state.plan?.security || state.gitPolicy);
  return policy==='strict' || state.plan?.tasks?.[state.task]?.sensitive===true;
}
function reviewEntry(state) { return lifecycleReviewPolicy(state)==='strict' ? 'spec' : 'quality'; }
function afterTaskReview(state) {
  if(state.gitPolicy)return 'commit';
  if(state.task+1<state.plan.tasks.length)return state.plan.mode==='review'?'spec':'coder';
  return 'verification';
}
export function approve(state, routes, snapshot, fallbacks={}) {
  check(state.stage==='awaiting-approval' && state.plan, 'No proposed plan awaiting approval');
  const plan=validatePlan(state.plan);
  // A plan without a retained lifecycle policy is legacy state and must not
  // acquire branch/commit behavior merely because its plan data has a type.
  return {...initialState(),enabled:true,plan,routes:structuredClone(routes),fallbacks:structuredClone(fallbacks),stage:plan.mode==='review'?'review-checks':'coder',snapshot,gitPolicy:state.gitPolicy ? structuredClone(state.gitPolicy) : null};
}
export function advance(state, report, snapshot) {
  const s=structuredClone(state);
  // Retained runs created before aggregate correction tracking are upgraded
  // in memory without changing their existing task round.
  s.aggregateRound ||= 0;
  if (s.stage==='verification') {
    check(report?.verified===true,'Completion requires host verification');
    check(snapshot===s.snapshot,'Workspace changed during verification');
    s.stage='complete'; return s;
  }
  check(AGENTS[s.stage] || ['checks','optimizer-checks','final-checks','commit','aggregate-quality','aggregate-security'].includes(s.stage), 'Invalid execution stage');
  if(s.stage!=='coder' && s.stage!=='optimizer' && s.stage!=='commit' && s.stage!=='final-checks') check(snapshot===s.snapshot,'Workspace changed during review; reapproval required');
  if(s.stage==='commit') {
    check(report?.committed===true,'Commit stage requires extension-owned commit evidence');
    check(snapshot===s.snapshot,'Workspace changed before commit');
    s.reports.push({stage:s.stage,task:s.task,round:s.round,report,snapshot});s.active=null;s.optimizerBypass=false;s.reviewedContentSnapshot=null;s.reviewContentCandidate=null;
    if(s.aggregateCorrection) {s.aggregateCorrection=false;s.stage='verification';}
    else if(s.task+1 < s.plan.tasks.length) {s.task++;s.round=0;s.feedback='';s.stage='coder';}
    else s.stage='final-checks';
    return s;
  }
  check(report && ['approved','changes_requested','blocked'].includes(report.status) && text(report.summary,8000) && Array.isArray(report.findings) && report.findings.length<=50 && report.findings.every(f=>text(f,2000)) && !(report.status==='approved' && report.findings.length), 'Missing or inconsistent structured report');
  s.reports.push({stage:s.stage,task:s.task,round:s.round,report,snapshot});
  if(report.status==='changes_requested') s.reviewContentCandidate=null;
  if(report.reviewedContentSnapshot && ['quality','security','aggregate-quality','aggregate-security'].includes(s.stage)) s.reviewedContentSnapshot={task:s.task,aggregate:s.stage.startsWith('aggregate-'),snapshot:report.reviewedContentSnapshot};
  // An optimizer reservation is consumed even when its structured report is
  // not approved. This prevents correction handling from silently launching a
  // second optimizer pass for the same task.
  if(s.stage==='optimizer' && !s.optimizerPasses?.[s.task]?.ran) {
    s.optimizerPasses[s.task]={ran:true,changed:report.optimizerChanged===true,beforeSnapshot:report.optimizerBeforeSnapshot,afterSnapshot:report.optimizerAfterSnapshot,checks:report.optimizerChanged===true?'rerun':'reused',status:report.status};
    s.optimizerBypass=true;
  }
  s.active=null; s.snapshot=snapshot;
  if(report.status==='blocked') return {...s,stage:'blocked',reason:report.summary};
  if(report.status==='changes_requested') {
    if(s.plan.mode==='review')return {...s,stage:'blocked',reason:'Read-only validation found issues; fixes require a separate approved implementation plan.'};
    if(s.gitPolicy && (s.stage==='aggregate-quality' || s.stage==='aggregate-security')) {
      if(s.aggregateRound>=fixRoundLimit(s))return {...s,stage:'blocked',reason:`Fix/review round limit exhausted (${fixRoundLimit(s)})`};
      s.aggregateCorrection=true;s.stage='coder';s.aggregateRound+=1;s.round+=1;s.feedback=cumulativeFeedback(s.feedback,report);return s;
    }
    if(s.optimizerPasses?.[s.task]?.ran) s.optimizerBypass=true;
    if(s.round>=fixRoundLimit(s)) {
      const limit=fixRoundLimit(s);
      return {...s,stage:'blocked',reason:`Fix/review round limit exhausted (${limit})`};
    }
    return {...s,stage:'coder',round:s.round+1,feedback:cumulativeFeedback(s.feedback,report)};
  }
  if(s.stage==='coder') s.stage='checks';
  else if(s.stage==='checks' && s.aggregateCorrection) s.stage='final-checks';
  else if(s.stage==='checks' && s.optimizerBypass) s.stage=reviewEntry(s);
  else if(s.stage==='checks' && lifecycleReviewPolicy(s) && s.plan?.optimizer!==false) s.stage='optimizer';
  else if(s.stage==='checks') s.stage='spec';
  else if(s.stage==='optimizer') {
    s.optimizerPasses[s.task]={ran:true,changed:report.optimizerChanged===true, beforeSnapshot:report.optimizerBeforeSnapshot, afterSnapshot:report.optimizerAfterSnapshot, checks:report.optimizerChanged===true?'rerun':'reused'};
    s.stage=report.optimizerChanged===true?'optimizer-checks':reviewEntry(s);
  }
  else if(s.stage==='optimizer-checks') s.stage=reviewEntry(s);
  else if(s.stage==='spec') s.stage=lifecycleReviewPolicy(s)==='balanced'?'quality':'quality';
  else if(s.stage==='quality' && taskNeedsSecurity(s)) s.stage='security';
  else if(s.stage==='quality' && s.gitPolicy) s.stage='commit';
  else if(s.stage==='quality' && s.task+1 < s.plan.tasks.length) { s.task++; s.stage=s.plan.mode==='review'?'spec':'coder'; s.round=0; s.feedback=''; s.optimizerBypass=false; }
  else if(s.stage==='security' && s.gitPolicy) s.stage='commit';
  else if(s.stage==='security' && s.task+1 < s.plan.tasks.length) { s.task++; s.stage=s.plan.mode==='review'?'spec':'coder'; s.round=0; s.feedback=''; s.optimizerBypass=false; }
  else if(s.stage==='security') s.stage='verification';
  else if(s.stage==='final-checks') s.stage=s.gitPolicy?'aggregate-quality':'verification';
  else if(s.stage==='aggregate-quality') s.stage=aggregateNeedsSecurity(s)?'aggregate-security':(s.aggregateCorrection?'commit':'verification');
  else if(s.stage==='aggregate-security') s.stage=s.aggregateCorrection?'commit':'verification';
  else if(s.stage==='quality' && s.task+1 >= s.plan.tasks.length) s.stage='verification';
  else s.stage='verification';
  return s;
}
