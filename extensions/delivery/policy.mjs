export const ROLES = ['planning', 'coder', 'spec', 'quality', 'security'];
export const AGENTS = { coder: 'delivery-coder', spec: 'delivery-reviewer', quality: 'delivery-reviewer', security: 'delivery-security' };
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
export function catalog(all, available) {
  const ids = new Set(available.map(m => `${m.provider}/${m.id}`));
  return [...new Set(all.map(m=>`${m.provider}/${m.id}`))].sort().map(id=>({id,available:ids.has(id),evidence:'not tested'}));
}
export function validateRoutes(routes, available) {
  for (const role of ROLES) check(text(routes?.[role],256) && available.includes(routes[role]), `Missing/unavailable exact model route: ${role}. Select an available exact model using delivery_configure, or configure its provider with /login. /delivery setup is the interactive alternative.`);
  return Object.fromEntries(ROLES.map(r=>[r,routes[r]]));
}
export function validatePlan(input) {
  check(input && typeof input==='object' && JSON.stringify(input).length<=64000, 'Invalid or oversized plan');
  check(text(input.title,200), 'Invalid plan title');
  check(input.mode===undefined || ['implementation','review'].includes(input.mode), 'Invalid plan mode');
  if(input.commits!==undefined)check(input.mode==='review' && Number.isInteger(input.commits) && input.commits>=1 && input.commits<=20,'commits requires review mode and 1–20 commits');
  check(Array.isArray(input.tasks) && input.tasks.length>0 && input.tasks.length<=12, 'Plan needs 1–12 tasks');
  for (const t of input.tasks) {
    check(text(t.title,200) && text(t.instructions), 'Invalid task instructions');
    check(Array.isArray(t.files) && t.files.length>0 && t.files.length<=100 && t.files.every(f=>text(f,512) && !f.startsWith('/') && !f.includes('\\') && !f.split('/').includes('..') && !f.split('/').includes('.git')), 'Invalid task files');
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
  // Supervisor responses are handled by the user, not an LLM able to authorize scope changes.
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
export function attemptBudget(policy,stage,spentMs=0,continuation=false) {
  check(Number.isFinite(spentMs) && spentMs>=0,'Invalid recorded coding time');
  if(stage!=='coder')return policy.reviewMs;
  const remaining=policy.coderMs+policy.continuationMs-spentMs;
  const budget=Math.min(continuation?policy.continuationMs:policy.coderMs,remaining);
  check(budget>0,'Coding task budget exhausted; a new budget needs explicit approval');
  return budget;
}
export function initialState() {
  return {version:1,enabled:false,stage:'planning',task:0,round:0,plan:null,routes:null,snapshot:null,active:null,reports:[],feedback:'',reason:''};
}
export function approve(state, routes, snapshot) {
  check(state.stage==='awaiting-approval' && state.plan, 'No proposed plan awaiting approval');
  return {...initialState(),enabled:true,plan:validatePlan(state.plan),routes:structuredClone(routes),stage:state.plan.mode==='review'?'review-checks':'coder',snapshot};
}
export function advance(state, report, snapshot) {
  const s=structuredClone(state);
  if (s.stage==='verification') {
    check(report?.verified===true,'Completion requires host verification');
    check(snapshot===s.snapshot,'Workspace changed during verification');
    s.stage='complete'; return s;
  }
  check(AGENTS[s.stage] || s.stage==='checks', 'Invalid execution stage');
  if(s.stage!=='coder') check(snapshot===s.snapshot,'Workspace changed during review; reapproval required');
  check(report && ['approved','changes_requested','blocked'].includes(report.status) && text(report.summary,8000) && Array.isArray(report.findings) && report.findings.length<=50 && report.findings.every(f=>text(f,2000)) && !(report.status==='approved' && report.findings.length), 'Missing or inconsistent structured report');
  s.reports.push({stage:s.stage,task:s.task,round:s.round,report,snapshot});
  s.active=null; s.snapshot=snapshot;
  if(report.status==='blocked') return {...s,stage:'blocked',reason:report.summary};
  if(report.status==='changes_requested') {
    if(s.plan.mode==='review')return {...s,stage:'blocked',reason:'Read-only validation found issues; fixes require a separate approved implementation plan.'};
    if(s.round>=2) return {...s,stage:'blocked',reason:'Two fix/review rounds exhausted'};
    return {...s,stage:'coder',round:s.round+1,feedback:JSON.stringify(report)};
  }
  if(s.stage==='coder') s.stage='checks';
  else if(s.stage==='checks') s.stage='spec';
  else if(s.stage==='spec') s.stage='quality';
  else if(s.stage==='quality' && s.plan.security) s.stage='security';
  else if(s.task+1 < s.plan.tasks.length) { s.task++; s.stage=s.plan.mode==='review'?'spec':'coder'; s.round=0; s.feedback=''; }
  else s.stage='verification';
  return s;
}
