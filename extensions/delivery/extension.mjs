import {join} from 'node:path';
import {accessSync,constants} from 'node:fs';
import {ROLES,ASTRA,AGENTS,REPORT_SCHEMA,catalog,validateRoutes,validatePlan,initialState,approve,advance,parentToolAllowed,timeoutPolicy,attemptBudget,allChecks,checksForTask,repairCheckScopes} from './policy.mjs';
import * as io from './io.mjs';
import {rpc} from './rpc.mjs';
import {ROLE_HELP,modelLabel} from './setup.mjs';

const ENTRY='delivery-mode-v1';
const result=(text,details={})=>({content:[{type:'text',text}],details});
const modelId=m=>m?`${m.provider}/${m.id}`:'';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export function registerDelivery(pi,schemas,deps={}) {
  if(deps.child ?? process.env.PI_SUBAGENT_CHILD==='1') return;
  for(const [k,v] of Object.entries({...io,rpc,pollMs:1500,retryDelayMs:5000,now:Date.now})) if(!(k in deps)) deps[k]=v;
  const d=deps;
  let s=initialState(),ctx,root,config,originalTools,job=null,closed=false,checking,requestText='',approvalTurn=null,fileIntent=null;
  function snapshot(plan=s.plan,warnings=[]) {
    if(plan?.sourcePlan && d.readPlan(root,plan.sourcePlan.path).hash!==plan.sourcePlan.hash)throw new Error('Source plan changed; read the updated document and obtain fresh execution approval.');
    return d.fingerprint(root,{scope:plan?.tasks.flatMap(t=>t.files) || [],commands:allChecks(plan),warnings});
  }
  const planKey=()=>JSON.stringify({plan:s.plan,snapshot:s.snapshot});
  function readablePlan(routes) {
    const p=s.plan;
    return [p.title,`Workspace: ${root}`,`Mode: ${p.mode==='review'?'Read-only review — no fixes':'Implementation'}`,
      p.reviewRange?`Commits: ${p.reviewRange.base.slice(0,10)}..${p.reviewRange.head.slice(0,10)}`:'',
      p.sourcePlan?`Source plan: ${p.sourcePlan.path}`:'',
      ...(s.coverageWarnings || []).map(w=>`Coverage warning: ${w}`),
      'Tasks',...p.tasks.map((t,i)=>`${i+1}. ${t.title}\n   ${t.instructions}\n   Files: ${t.files.join(', ')}\n   Acceptance: ${t.acceptance.join('; ')}\n   Task checks: ${(t.checks || (p.tasks.length===1?p.checks:[])).join('; ')}`),
      `Time budget: coder ${timeoutPolicy(config.timeouts).coderMs/60000}m + one ${timeoutPolicy(config.timeouts).continuationMs/60000}m continuation per task; reviewers ${timeoutPolicy(config.timeouts).reviewMs/60000}m per run.`,
      p.mode==='review'?'Validation commands':'Final/release test commands',...(p.checks.length?p.checks.map(c=>`  ${c}`):['  None — static review only; no test pass will be claimed.']),
      'Models',...Object.entries(routes).filter(([role])=>p.mode!=='review'||role!=='coder').map(([role,model])=>`  ${role}: ${model}`),
      'Commands run with your account permissions. No automatic commit, push, merge or deployment.'
    ].filter(Boolean).join('\n');
  }
  function pendingExecution() {
    guardIdle();
    if(s.stage!=='awaiting-approval')throw new Error(s.stage==='blocked'?'The previous run stopped. Ask to retry; I must prepare corrected checks before execution.':'No pending plan to execute.');
    refreshConfig();
    const routes=routeCheck(),hash=snapshot();
    if(hash!==s.snapshot)throw new Error('Workspace changed since proposal; refresh the plan first');
    d.validateCommands(root,allChecks(s.plan));
    return {routes,hash,timeouts:timeoutPolicy(config.timeouts)};
  }
  async function launchApproved() {
    const {routes,hash,timeouts}=pendingExecution();
    await d.rpc(pi.events,'ping');
    if(hash!==snapshot())throw new Error('Workspace changed before execution');
    const warnings=s.coverageWarnings || [];
    s=approve(s,routes,hash);s.coverageWarnings=warnings;s.timeouts=timeouts;approvalTurn=null;fileIntent=null;save();start();
  }
  function display(text) {pi.sendMessage({customType:'delivery',content:text,display:true});}
  function status() {
    const route=['checks','review-checks','verification'].includes(s.stage)?'host verification':s.routes?.[s.stage] || config?.routes?.planning || ASTRA;
    return !s.enabled?'Delivery OFF · /delivery setup':`Delivery ${s.reason?'BLOCKED':'ON'} · ${s.stage} · ${route} · ${s.plan?`task ${s.task+1}/${s.plan.tasks.length}`:'awaiting plan'}${s.reason?' · '+s.reason:''}`;
  }
  function terminalCorrection() {
    const legacyChecks=s.plan?.mode!=='review' && s.plan?.tasks?.length>1 && s.plan.tasks.some(t=>!t.checks);
    const failed=s.failedRun?.state==='failed' && s.failedRun.task===s.task;
    return s.stage==='blocked' && (failed || (s.reason==='Two fix/review rounds exhausted' && !legacyChecks)) && !job && !s.active && !s.pendingContinuation && !s.pendingRetry && !s.resumeStage && s.plan?.tasks?.length>0;
  }
  function correctivePlanAction() {
    const review=s.failedRun && s.failedRun.stage!=='coder'?' This was a review failure, not a code finding. Do not replay completed coding; propose read-only validation of existing work and explicitly preserve unfinished implementation obligations.':'';
    return review+' NEXT ACTION: Prepare a new corrective plan with delivery_plan from the retained requirements and latest findings, preserving partial work, unfinished tasks and final checks. No saved Markdown file is required. This is a new proposal requiring fresh approval after it is shown, not a reset or automatic retry of the exhausted run. Do not request a harness reset or keep repeating delivery_resume/approval.';
  }
  function statusText() {
    const lines=[status()];
    if(s.active?.id)lines.push(`Retained child: ${s.active.id}`);
    if(terminalCorrection()) {
      const latest=s.reports.filter(r=>r.task===s.task).at(-1)?.report;
      lines.push(correctivePlanAction(),'Retained plan context (requirements, not execution authorization):',JSON.stringify({title:s.plan.title,sourcePlan:s.plan.sourcePlan,remainingTasks:s.plan.tasks.slice(s.task),finalChecks:s.plan.checks,failedAttempt:s.failedRun,latestReview:latest?{status:latest.status,summary:latest.summary,findings:latest.findings}:null},null,2));
    }
    return lines.join('\n');
  }
  function save() {pi.appendEntry(ENTRY,{...structuredClone(s),workspace:root,owner:ctx.sessionManager.getSessionId()});ctx.ui.setStatus('delivery',status());}
  function block(error) {
    s.stage='blocked';s.reason=error instanceof Error?error.message:String(error);
    if(rejectedReadOnlyLaunch())s.active.preflightRejection ||= s.reason;
    save();display(`Delivery blocked: ${s.reason}${s.active?.id?'\nRun: '+s.active.id:''}`);
  }
  function restrict() {
    if(!originalTools) originalTools=pi.getActiveTools();
    const discovered=pi.getAllTools?.().map(t=>t.name) || [];
    const candidates=new Set([...originalTools,...pi.getActiveTools(),...discovered,'delivery_plan','delivery_execute','delivery_resume','delivery_status','delivery_diff']);
    pi.setActiveTools([...candidates].filter(name=>parentToolAllowed(name,{action:'status'}) || name==='subagent_supervisor'));
  }
  function available() {return ctx.modelRegistry.getAvailable().map(modelId);}
  async function selectPlanning() {
    const id=config?.routes?.planning || ASTRA;
    const m=ctx.modelRegistry.getAvailable().find(m=>modelId(m)===id);
    if(!m || !await pi.setModel(m)) {s.reason=`Planning model unavailable: ${id}. Use /delivery setup or /login.`;save();return false;}
    return true;
  }
  async function activate() {
    s.enabled=true;restrict();
    if(await selectPlanning()) {
      try {validateRoutes(config.routes,available());s.reason='';}
      catch(e){s.reason=e.message;}
    }
    save();
  }
  function guardIdle() {if(job || s.active || s.pendingRetry) throw new Error('An owned run is active or unresolved; inspect status before changing the plan.');}
  function refreshConfig() {config=d.loadConfig(d.configPath());}
  // Proposal validation: only the currently configured exact routes/budgets. It never compares
  // against a stopped/completed run's bindings, so a terminal old/new route mismatch still permits
  // a fresh proposal (which launches nothing and reuses no approvals).
  function proposalCheck() {
    refreshConfig();
    const routes=validateRoutes(config.routes,available());
    timeoutPolicy(config.timeouts);
    return routes;
  }
  function routeCheck() {
    const r=validateRoutes(config.routes,available());
    const limits=timeoutPolicy(config.timeouts);
    if(s.timeouts && JSON.stringify(limits)!==JSON.stringify(s.timeouts))throw new Error('Time budget changed; reapproval required');
    if(s.routes && JSON.stringify(r)!==JSON.stringify(s.routes)) throw new Error('Routes changed; reapproval required');
    return r;
  }
  function briefing(stage) {
    const task=s.plan.tasks[s.task];
    const scope={title:s.plan.title,mode:s.plan.mode || 'implementation',approvedRoutes:s.routes,sourcePlan:s.plan.sourcePlan,coverageWarnings:s.coverageWarnings,reviewRange:s.plan.reviewRange,taskIndex:s.task,task,interruptions:(s.interruptions || []).filter(r=>r.task===s.task),completedTasks:s.plan.tasks.slice(0,s.task),checks:s.plan.mode==='review'?s.plan.checks:checksForTask(s.plan,s.task),finalChecks:s.plan.checks};
    return [
      stage==='coder'?'Implement only this approved task. Follow selected SPARK TDD/debugging/verification skills.':`Read-only review. Do not modify any files. Independent ${stage} review. Inspect actual source and the full current diff for current-task acceptance and earlier-task regressions. Later task deliverables are not required yet. No edits or commands.`,
      'No commit, push, merge, deploy, credentials access or delegation. Preserve unrelated changes. Stop for scope questions; do not widen scope.',
      'Return your result using the supplied structured_output schema. status=approved requires findings=[]; put successful checks, completed work and informational evidence in summary, never in findings. Use changes_requested for actionable fixes; blocked for missing evidence. findings are concise strings with severity, file:line, evidence, impact and fix. This schema replaces prose/fenced/JSON-only report formatting from role skills.',
      JSON.stringify(scope),
      'Use the runtime-approved dispatch bindings in approvedRoutes; older model names in retained task/document text do not change these bindings. No route changes or fallback.',
      'For implementation, checks apply to the current task only. finalChecks are release gates after all tasks; do not implement later tasks to satisfy them early.',
      s.plan.sourcePlan?`Read the authoritative Markdown plan at ${s.plan.sourcePlan.path}; preserve its global constraints and task boundaries. Do not edit this approved document, including checkboxes; report progress separately.`:'',
      'Uncovered symlink targets are not dependencies you may silently use. Stop if this task needs one. Do not delete or repair unrelated links.',
      s.feedback?'Prior actionable findings: '+s.feedback:'',
      s.pendingContinuation || s.active?.continuation || (s.interruptions || []).some(r=>r.task===s.task && r.error)?`Continue the same approved task from its partial changes. Start with verification of the partial workspace, inspect the previous tool logs, and finish only remaining work. Do not discard or reimplement completed work. Previous interrupted runs: ${JSON.stringify((s.interruptions || []).filter(r=>r.task===s.task))}`:'',
      stage==='coder'?'':d.diff(root,s.plan.reviewRange),
      s.plan.mode==='review'?`Read-only validation: report findings only. Do not implement or fix anything. For a committed range, untracked files are out of scope. Read the FULL diff in chunks from ${d.reviewPatch(root,s.plan.reviewRange)}; the inline preview may be truncated.`:'',
      stage==='coder'?'':'Host verification evidence: '+JSON.stringify(s.checks || []),
      stage==='coder'?'':'Actual coder session/tool-output evidence: '+JSON.stringify(s.reports.filter(r=>r.stage==='coder' && r.task===s.task).map(r=>r.report.executionEvidence).filter(Boolean))+'. Read these logs for pre-fix failing tests or other execution evidence not present in post-fix host checks. Do not replace them with coder prose claims.',
      'Use the repository instruction files. Review paths not shown in truncated diffs yourself. Never treat a prior agent claim as test evidence.'
    ].join('\n\n');
  }
  function codingLedger() {
    s.coding ||= {};
    return s.coding[s.task] ||= {spentMs:0,continuations:0};
  }
  function chargeCoding(progress) {
    if(s.active?.stage!=='coder' || s.active.charged)return;
    const grant=s.active.budgetMs ?? progress?.timeoutMs ?? 15*60000;
    if(!Number.isFinite(grant) || grant<=0)throw new Error('Cannot establish previous coding budget');
    const started=s.active.startedAt ?? progress?.startedAt;
    const elapsed=progress?.durationMs ?? (Number.isFinite(started)?d.now()-started:grant);
    codingLedger().spentMs+=Math.min(grant,Math.max(0,elapsed));
    s.active.charged=true;save();
  }
  function closeFailedAttempt(progress,reason=progress?.error || 'Native child failed without a report') {
    if(progress?.state!=='failed' || !s.active?.id)throw new Error('No confirmed failed child to reconcile');
    if(!d.isSettled(s.active))throw new Error('Failed child has not been confirmed closed; no execution restarted');
    if(progress.model!==s.active.model || !progress.attemptedModels?.length || progress.attemptedModels.some(m=>m!==s.active.model))throw new Error('Failed worker model evidence does not match the approved route');
    chargeCoding(progress);
    s.failedRun={...s.active,task:s.task,round:s.round,state:'failed',error:reason,nativeError:progress.error,timedOut:progress.timedOut,durationMs:progress.durationMs,sessionFiles:progress.sessionFiles || []};
    s.active=null;s.pendingContinuation=false;delete s.resumeStage;s.stage='blocked';s.reason=`Child ${s.failedRun.id} failed; attempt closed. ${reason}`;save();
    const message='Failed attempt reconciled; no execution restarted. '+reason+' Inspect delivery_status for retained evidence and the corrective-plan path.';
    display(message);return message;
  }
  function queueConnectionRetry(progress) {
    // Only a known transport failure of a closed, exact-route worker is retryable.
    const transient=/^(?:Connection error\.|fetch failed|(?:Error: )?(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)\b[^\n]*)(?:\n|$)/i.test(progress?.error || '');
    if(progress?.state!=='failed' || progress.timedOut || !transient)return false;
    if(!d.isSettled(s.active))throw new Error('Failed child has not been confirmed closed; no execution restarted');
    if(progress.model!==s.active.model || !progress.attemptedModels?.length || progress.attemptedModels.some(m=>m!==s.active.model))throw new Error('Failed worker model evidence does not match the approved route');
    refreshConfig();routeCheck();
    if(!s.timeouts)return false;
    const key=`${s.task}:${s.round}:${s.active.stage}`;
    s.connectionRetries ||= {};
    const ledger=s.connectionRetries[key] ||= {count:0,spentMs:0};
    chargeCoding(progress);
    const elapsed=progress.durationMs ?? s.active.budgetMs;
    ledger.spentMs+=Math.min(s.active.budgetMs,Math.max(0,elapsed));
    const budget=s.active.stage==='coder'
      ? s.timeouts.coderMs+s.timeouts.continuationMs-codingLedger().spentMs
      : s.timeouts.reviewMs-ledger.spentMs;
    if(ledger.count>=2 || !(budget>0))return false;
    const current=snapshot();
    if(s.active.stage!=='coder' && current!==s.snapshot)throw new Error('Review modified source; connection retry refused');
    ledger.count++;
    s.interruptions ||= [];
    s.interruptions.push({id:s.active.id,task:s.task,stage:s.active.stage,model:s.active.model,error:progress.error,sessionFiles:progress.sessionFiles || [],snapshot:current});
    s.pendingRetry={stage:s.active.stage,budgetMs:Math.min(budget,s.active.budgetMs),continuation:Boolean(s.active.continuation),notBefore:d.now()+d.retryDelayMs*ledger.count};
    s.snapshot=current;s.stage=s.active.stage;s.active=null;delete s.resumeStage;s.reason='';save();
    display(`Model connection lost. Retrying ${s.stage} on the same approved route (${ledger.count}/2); partial work and consumed budget retained.`);
    return true;
  }
  function queueContinuation(progress) {
    if(s.active?.stage!=='coder' || !progress?.timedOut)throw new Error('Only confirmed coding timeouts can continue automatically');
    if(!d.isSettled(s.active))throw new Error('Previous writer has not been confirmed closed; no replacement launched');
    if(progress.model!==s.active.model || !progress.attemptedModels?.length || progress.attemptedModels.some(m=>m!==s.active.model))throw new Error('Timed-out worker model evidence does not match the approved route');
    chargeCoding(progress);
    s.recoverySnapshot=snapshot();save();
    if(!s.timeouts)throw new Error('Legacy timeout budget requires explicit recovery via delivery_resume before continuing');
    const ledger=codingLedger();
    if(ledger.continuations>=1 || ledger.spentMs>=s.timeouts.coderMs+s.timeouts.continuationMs) {
      closeFailedAttempt(progress,'Coding continuation/budget exhausted; preserve changes and propose a new corrective plan');return false;
    }
    const budget=attemptBudget(s.timeouts,'coder',ledger.spentMs,true);
    s.interruptions ||= [];
    s.interruptions.push({id:s.active.id,task:s.task,model:s.active.model,sessionFiles:progress.sessionFiles || [],snapshot:s.recoverySnapshot});
    ledger.continuations++;
    s.snapshot=s.recoverySnapshot;s.active=null;s.pendingContinuation=true;s.stage='coder';s.reason='';save();
    display(`Previous timed-out runner is closed. Continuing task ${s.task+1} from partial changes with ${s.routes.coder}, for up to ${Math.ceil(budget/60000)}m. Scope unchanged.`);return true;
  }
  async function watchProgress(progress) {
    if(!progress || !['running','queued'].includes(progress.state))return;
    const now=d.now(),limits=s.timeouts || timeoutPolicy(config.timeouts);
    const deadline=progress.deadlineAt ?? (s.active.startedAt+s.active.budgetMs);
    const lead=Math.min(limits.deadlineWarningMs,(s.active.budgetMs || limits.coderMs)/5);
    if(Number.isFinite(deadline) && deadline>now && deadline-now<=lead && !s.active.deadlineWarned) {
      s.active.deadlineWarned=true;save();
      display(`Worker budget ends in about ${Math.ceil((deadline-now)/60000)}m. Requesting verification or a precise handoff; no deadline extension.`);
      try {await d.rpc(pi.events,'steer',{id:s.active.id,message:'Your current attempt is nearing its hard time limit. Prioritize verification of existing changes. Do not widen scope or skip tests. If unable to finish, preserve work and record exact remaining checks/blockers and evidence for continuation.'},5000);}
      catch(e){display(`Budget warning could not be delivered to the worker: ${e.message}`);}
    }
    const last=progress.lastActivityAt ?? progress.startedAt ?? s.active.startedAt;
    if(!progress.currentTool && Number.isFinite(last) && now-last>=limits.idleWarningMs && s.active.idleWarnedAt!==last) {
      s.active.idleWarnedAt=last;save();
      display('No recent recorded worker activity. It may still be generating or waiting on the provider; inspect status. This warning does not kill the run.');
    }
  }
  async function approveRecoveryPolicy() {
    const routes=validateRoutes(config.routes,available()),limits=timeoutPolicy(config.timeouts);
    if(JSON.stringify(routes)===JSON.stringify(s.routes) && JSON.stringify(limits)===JSON.stringify(s.timeouts))return;
    const baseline=snapshot();
    const changes=ROLES.filter(r=>routes[r]!==s.routes?.[r]).map(r=>`${r}: ${s.routes?.[r] || 'unset'} → ${routes[r]}`);
    const text=[`Continue task ${s.task+1}/${s.plan.tasks.length}; preserve and verify partial changes.`,...changes,`Recovery allowance: up to ${limits.continuationMs/60000}m, within the ${(limits.coderMs+limits.continuationMs)/60000}m total coding budget.`,`Selected providers receive the task context and previous run evidence. The old writer is confirmed closed. No new scope, commits or deployment.`].join('\n');
    if(!ctx.hasUI || !await ctx.ui.confirm('Approve changed recovery routes/budget?',text))throw new Error('Changed recovery routes/budget were not approved; partial work preserved');
    if(snapshot()!==baseline)throw new Error('Workspace changed during recovery approval; inspect changes first');
    s.routes=routes;s.timeouts=limits;save();
  }
  function rejectedReadOnlyLaunch(state=s) {
    const a=state.active;
    if(state.stage!=='blocked' || !a || a.id!==null || a.dir!==null || !['spec','quality','security'].includes(a.stage) || a.model!==state.routes?.[a.stage])return false;
    // Pinned pi-subagents preflight returns this exact error BEFORE async launch.
    // Do not infer non-launch from arbitrary provider errors or RPC timeouts.
    const expected=`Agent '${AGENTS[a.stage]}' was given an implementation task, but its tool allowlist has no mutation-capable tools. Add bash, edit, write, or another mutation-capable tool to the agent, or use a read-only task/agent.`;
    const reason=a.preflightRejection ?? state.reason;
    return typeof reason==='string' && reason.replace(/^Run fan-out: \d+\/\d+ used, \d+ remaining\n/,'')===expected;
  }
  function retainPreflightProof(entries) {
    if(rejectedReadOnlyLaunch()) {s.active.preflightRejection ||= s.reason;return;}
    if(!s.active || s.active.preflightRejection!==undefined || s.reason!=='Retained child requires /delivery resume reconciliation')return;
    // Older startup code overwrote reason. Recover only from consecutive entries
    // of this exact reservation/execution; never cross changed evidence or owners.
    const identity=state=>{const copy=structuredClone(state);delete copy.reason;delete copy.stage;return JSON.stringify(copy);};
    const key=identity(s);
    for(const entry of [...entries].reverse()) {
      if(entry.type!=='custom' || entry.customType!==ENTRY)continue;
      const prior=entry.data;
      if(!prior || identity(prior)!==key)break;
      if(prior.reason==='Retained child requires /delivery resume reconciliation')continue;
      if(rejectedReadOnlyLaunch(prior))s.active.preflightRejection=prior.active.preflightRejection ?? prior.reason;
      break; // A newer unknown failure cannot be bypassed using older evidence.
    }
  }
  async function resumeOwned(taskChecks) {
    if(job)throw new Error('Delivery is already running');
    config=d.loadConfig(d.configPath());
    if(taskChecks===undefined && rejectedReadOnlyLaunch()) {
      const routes=validateRoutes(config.routes,available()),limits=timeoutPolicy(config.timeouts);
      if(snapshot()!==s.snapshot)throw new Error('Workspace changed since review; preflight recovery refused');
      const identity=JSON.stringify(s),stage=s.active.stage;
      const changes=ROLES.filter(r=>routes[r]!==s.routes?.[r]).map(r=>`${r}: ${s.routes?.[r]} → ${routes[r]}`);
      for(const key of Object.keys(limits))if(limits[key]!==s.timeouts?.[key])changes.push(`${key.replace(/Ms$/,'')} budget/notice: ${(s.timeouts?.[key] ?? 0)/60000} → ${limits[key]/60000} minutes`);
      const preview=[`Native preflight rejected ${stage} before launching a child. Retry with ${routes[stage]} using an explicit read-only prompt.`,...changes,'Selected providers receive task context and prior evidence. No write tools, coder replay, retry reset or skipped reviews. Existing checks, findings and coding spend are retained.'].join('\n');
      if(!ctx.hasUI || !await ctx.ui.confirm('Retry the rejected read-only review?',preview))throw new Error('Read-only review retry was not approved');
      if(closed || JSON.stringify(s)!==identity)throw new Error('Delivery state changed during review recovery');
      config=d.loadConfig(d.configPath());
      if(JSON.stringify(validateRoutes(config.routes,available()))!==JSON.stringify(routes) || JSON.stringify(timeoutPolicy(config.timeouts))!==JSON.stringify(limits))throw new Error('Recovery configuration changed during approval');
      if(snapshot()!==s.snapshot)throw new Error('Workspace changed during review recovery');
      s.routes=routes;s.timeouts=limits;s.active=null;s.stage=stage;s.reason='';save();start();return;
    }
    if(taskChecks!==undefined) {
      guardIdle();
      const routes=validateRoutes(config.routes,available()),limits=timeoutPolicy(config.timeouts);
      if(snapshot()!==s.snapshot)throw new Error('Workspace changed since the recorded coder result; check-scope recovery refused');
      const recovered=repairCheckScopes(s,taskChecks);
      recovered.routes=routes;recovered.timeouts=limits;
      d.validateCommands(root,allChecks(recovered.plan));
      const baseline=s.snapshot,identity=JSON.stringify(s);
      const changes=ROLES.filter(r=>routes[r]!==s.routes?.[r]).map(r=>`${r}: ${s.routes?.[r] || 'unset'} → ${routes[r]}`);
      if(JSON.stringify(limits)!==JSON.stringify(s.timeouts))changes.push(`Adopt configured budgets: coder ${limits.coderMs/60000}m + ${limits.continuationMs/60000}m continuation per task; reviewers ${limits.reviewMs/60000}m. Previously consumed time remains charged.`);
      const preview=['Correct verification ordering; preserve task scope, coder work, evidence and time spent.',...changes,'Selected providers receive the approved task context and prior execution evidence.',...recovered.plan.tasks.map((t,i)=>`Task ${i+1}: ${t.checks.join('; ')}`),'Final release checks remain mandatory:',...recovered.plan.checks,`Restore ${recovered.checkScopeRecovery.creditedRounds} rounds consumed by premature release checks; retain all other retry history.`].join('\n');
      if(!ctx.hasUI || !await ctx.ui.confirm(changes.length?'Approve check ordering and route/budget changes?':'Correct legacy check ordering and continue reviews?',preview))throw new Error('Check ordering correction was not approved; existing work preserved');
      if(closed || JSON.stringify(s)!==identity)throw new Error('Delivery state changed during check-scope approval');
      config=d.loadConfig(d.configPath());
      if(JSON.stringify(validateRoutes(config.routes,available()))!==JSON.stringify(routes) || JSON.stringify(timeoutPolicy(config.timeouts))!==JSON.stringify(limits))throw new Error('Recovery configuration changed during approval; no execution resumed');
      if(snapshot(recovered.plan)!==baseline)throw new Error('Workspace changed during check-scope approval');
      s=recovered;save();display(s.pendingContinuation?'Check ordering corrected; continue the retained timeout recovery. Final release checks retained.':'Check ordering corrected. Re-running current task checks, then independent reviews. No coder replay; final release checks retained.');start();return;
    }
    if(!s.active && !s.failedRun && s.stage==='blocked' && s.plan?.mode!=='review' && s.plan?.tasks.length>1 && s.plan.tasks.some(t=>!t.checks))throw new Error('Legacy check ordering needs repair: read the approved source plan and call delivery_resume with taskChecks for every task. Final checks and completed coder evidence will be retained.');
    if(s.active?.id) {
      await d.rpc(pi.events,'status',{id:s.active.id});
      const progress=d.runProgress(s.active);
      if(progress?.timedOut && s.active.stage==='coder') {
        if(s.recoverySnapshot && snapshot()!==s.recoverySnapshot)throw new Error('Workspace changed after timeout; inspect changes and obtain fresh approval');
        if(!d.isSettled(s.active))throw new Error('Previous writer has not been confirmed closed; no replacement launched');
        await approveRecoveryPolicy();
        routeCheck();if(queueContinuation(progress)){start();return;}
        return 'Failed attempt reconciled; no execution restarted. Inspect delivery_status for the corrective-plan path.';
      }
      if(progress?.state==='failed') {if(queueConnectionRetry(progress)){start();return 'Same-route connection retry scheduled.';}return closeFailedAttempt(progress);}
      if(['stopped','paused','blocked'].includes(progress?.state))throw new Error(`Native child is ${progress.state}; no execution restarted. Inspect native status before further recovery.`);
      s.stage=s.active.stage;
    } else if(s.pendingRetry) {
      refreshConfig();routeCheck();s.stage=s.pendingRetry.stage;
    } else if(s.pendingContinuation) {
      if(snapshot()!==s.snapshot)throw new Error('Workspace changed before continuation; inspect changes and obtain fresh approval');
      await approveRecoveryPolicy();s.stage='coder';
    }
    else if(['checks','review-checks','verification','spec','quality','security'].includes(s.resumeStage))s.stage=s.resumeStage;
    else if(terminalCorrection())throw new Error(correctivePlanAction());
    else throw new Error('No retained run or safe continuation to resume');
    delete s.resumeStage;s.reason='';save();start();
  }
  async function runChecks({commands=s.plan.checks,failureLabel,mutationLabel,fixable=false}) {
    checking=new AbortController();s.checks=[];save();
    for(const command of commands) {
      const check=await d.verifyCommand(root,command,checking.signal);
      if(closed)return false;
      s.checks.push(check);save();
      if(mutationLabel && snapshot()!==s.snapshot)throw new Error(mutationLabel);
      if(check.code!==0 || check.terminated) {
        if(!fixable)throw new Error(`${failureLabel}: ${command}\n${check.output}`);
        s=advance({...s,stage:'checks'},{status:'changes_requested',summary:'Host verification failed',findings:[`${command}: ${check.output}`.slice(0,2000)]},s.snapshot);
        save();break;
      }
    }
    return true;
  }
  async function pump() {
    try {
      while(!closed && s.enabled && !['blocked','complete'].includes(s.stage)) {
        routeCheck();
        if(s.plan.reviewRange)d.assertCommittedWorkspace(root,s.plan.reviewRange);
        if(s.plan.mode==='review' && s.stage==='spec' && !s.reviewChecksDone){s.stage='review-checks';save();}
        if(s.stage==='review-checks') {
          if(snapshot()!==s.snapshot)throw new Error('Workspace changed before validation');
          if(!await runChecks({failureLabel:'Read-only validation check failed',mutationLabel:'Validation check modified source; review stopped'}))return;
          s.reviewChecksDone=true;s.stage='spec';save();
        }
        if(s.stage==='checks') {
          if(snapshot()!==s.snapshot)throw new Error('Workspace changed before task verification');
          const commands=checksForTask(s.plan,s.task);
          if(!await runChecks({commands,fixable:true,mutationLabel:'Verification changed reviewed source; reapproval required'}))return;
          if(s.stage==='checks') {
            s=advance(s,{status:'approved',summary:'Current task host checks passed',findings:[]},snapshot());
            s.reports.at(-1).checks=structuredClone(s.checks);save();
          }
          if(s.stage==='blocked')display(`Delivery blocked: ${s.reason}`);
          continue;
        }
        if(s.stage==='verification') {
          if(snapshot()!==s.snapshot) throw new Error('Workspace changed since review; reapproval required');
          if(!await runChecks({failureLabel:'Verification failed'}))return;
          s=advance(s,{verified:true},snapshot());save();
          display([s.plan.checks.length?'Delivery complete: required reviews and test commands passed.':'Static review complete. Tests were NOT run.',...s.reports.map(r=>`- ${r.stage}, task ${r.task+1}: ${r.report.status}`),...s.checks.map(c=>`- Test: ${c.command || 'approved command'} — exit ${c.code}`)].join('\n'));
          break;
        }
        if(!AGENTS[s.stage]) throw new Error('No approved execution stage');
        if(!s.active) {
          if(s.pendingRetry && d.now()<s.pendingRetry.notBefore){await sleep(Math.min(d.pollMs,s.pendingRetry.notBefore-d.now()));continue;}
          refreshConfig();routeCheck();
          if(s.plan.mode!=='review')checksForTask(s.plan,s.task);
          if(snapshot()!==s.snapshot) throw new Error('Workspace changed outside the approved run; reapproval required');
          // Persist launch reservation before RPC. A crash/timeout here must never replay a writer.
          const continuation=Boolean(s.pendingContinuation || s.pendingRetry?.continuation);
          const budgetMs=s.pendingRetry?.budgetMs ?? attemptBudget(s.timeouts || timeoutPolicy(config.timeouts),s.stage,s.stage==='coder'?codingLedger().spentMs:0,continuation);
          s.active={id:null,dir:null,model:s.routes[s.stage],stage:s.stage,budgetMs,startedAt:d.now(),continuation};delete s.pendingContinuation;delete s.pendingRetry;save();
          const params={agent:AGENTS[s.stage],agentScope:'user',cwd:root,model:s.routes[s.stage],context:'fresh',async:true,task:briefing(s.stage),outputSchema:REPORT_SCHEMA,output:false,timeoutMs:budgetMs,share:false,acceptance:{level:'none',reason:'Delivery owns structured review and host verification gates'}};
          const launched=await d.rpc(pi.events,'spawn',params,60000);
          const details=launched.details;
          if(!details?.runId || !details?.asyncDir) throw new Error('Launch did not return a run ID and artifact directory; inspect subagent status before recovery');
          s.active={...s.active,id:details.runId,dir:details.asyncDir};
          if(closed) return;
          save();
        }
        if(!s.active.id) throw new Error('Uncertain launch; inspect subagent status. Automatic replay refused.');
        // Reconcile through the package before consuming its durable lifecycle artifacts.
        await d.rpc(pi.events,'status',{id:s.active.id});
        if(closed) return;
        const progress=d.runProgress(s.active);
        if(progress?.timedOut && s.stage==='coder') {
          if(!d.isSettled(s.active)) {
            if(s.active.awaitingCloseAt===undefined){s.active.awaitingCloseAt=d.now();save();}
            if(d.now()-s.active.awaitingCloseAt>60000)throw new Error('Timed-out writer closure is still unconfirmed; no replacement launched. Inspect runner status before recovery.');
            await sleep(d.pollMs);continue;
          }
          queueContinuation(progress);continue;
        }
        if(progress?.state==='failed'){if(queueConnectionRetry(progress))continue;closeFailedAttempt(progress);return;}
        await watchProgress(progress);
        if(closed)return;
        const report=d.readOutcome(s.active);
        if(!report) {await sleep(d.pollMs);continue;}
        chargeCoding(progress);
        const id=s.active.id;
        s=advance(s,report,snapshot());
        s.reports.at(-1).runId=id;save();
        if(s.stage==='blocked') display(`Delivery blocked: ${s.reason}`);
      }
    } catch(e) {if(!closed)block(e);}
    finally {checking=undefined;}
  }
  function start() {if(job) return;job=pump().finally(()=>{job=null;});}

  pi.registerTool({name:'delivery_plan',label:'Delivery plan',description:'Route the requested task. mode=review starts read-only validation immediately; mode=implementation presents a readable plan for conversational approval. commits=N pins recent commits. tasks[].checks are current-task commands; top-level checks are final release commands after all tasks, never future-task checks run early. All commands must be executable, not review criteria. start=false records a plan without executing it.',parameters:schemas.plan,
    async execute(_id,params,_signal,_update,c) {
      ctx=c;if(!s.enabled) throw new Error('Activate /delivery first');guardIdle();
      const proposalRoutes=proposalCheck();
      if(modelId(ctx.model)!==config.routes.planning) throw new Error('Wrong planning model; activate /delivery again');
      const plan=validatePlan(params);
      d.validateCommands(root,allChecks(plan));
      delete plan.sourcePlan;
      if(params.planFile) {
        const document=d.readPlan(root,params.planFile);
        if(fileIntent && (document.path!==fileIntent.path || document.hash!==fileIntent.hash))throw new Error('Source plan changed since the execution request; ask for approval of the changed document.');
        plan.sourcePlan={path:document.path,hash:document.hash};
      }
      delete plan.reviewRange; // Only this extension resolves and pins revision identities.
      if(plan.mode==='review' && plan.commits) {
        plan.reviewRange=d.revisionRange(root,plan.commits);
        d.assertCommittedWorkspace(root,plan.reviewRange);
      }
      const coverageWarnings=[],hash=snapshot(plan,coverageWarnings);
      const timeouts=timeoutPolicy(config.timeouts);
      const fileApproved=fileIntent && plan.sourcePlan?.path===fileIntent.path && plan.sourcePlan.hash===fileIntent.hash;
      if(fileApproved && (hash!==fileIntent.snapshot || JSON.stringify(proposalRoutes)!==JSON.stringify(fileIntent.routes) || JSON.stringify(timeouts)!==JSON.stringify(fileIntent.timeouts)))throw new Error('Workspace or routes changed since the file execution request; refresh approval.');
      const priorRun=s.plan && !s.active && (s.reports||[]).length?{stage:s.stage,task:s.task,round:s.round,reports:s.reports.length}:null;
      s={...initialState(),enabled:true,plan,coverageWarnings,timeouts,routes:proposalRoutes,stage:'awaiting-approval',snapshot:hash,priorRun};approvalTurn=null;save();
      display(readablePlan(config.routes));
      if(fileApproved && params.start!==false) {
        await launchApproved();
        return result('Execution of the requested Markdown plan started. No additional approval needed. Use delivery_status for progress.');
      }
      if(plan.mode==='review' && requestText && params.start!==false) {
        await launchApproved();
        return result('Read-only validation started. No coder or automatic fixes. Use delivery_status for progress.');
      }
      return result('Plan ready. Ask for conversational approval. After the user agrees, call delivery_execute; do not send them to a slash command.',{plan,routes:config.routes,workspace:root});
    }});
  pi.registerTool({name:'delivery_execute',label:'Execute requested plan',description:'Use ONLY for an explicit real-user request to execute a plan, never a question, rejection or planning-only request. For an existing Markdown document pass planFile: it is read and bound to this execution request; then derive its tasks via delivery_plan with the same planFile. No prior registration or repeated approval is required. Without planFile, execute the conversationally approved pending plan. Do not widen scope or resolve real product ambiguities silently.',parameters:schemas.execute || schemas.empty,async execute(_id,params={},_signal,_update,c){
    ctx=c;if(!s.enabled)throw new Error('Activate delivery first');guardIdle();
    if(modelId(ctx.model)!==config.routes.planning)throw new Error('Wrong planning model; reactivate delivery');
    const references=[...new Set(requestText.match(/docs\/spark\/plans\/[^\s"'`]+\.md/g) || [])];
    const path=params.planFile || (s.stage!=='awaiting-approval' && references.length===1?references[0]:undefined);
    if(path) {
      if(!requestText.trim())throw new Error('A real user request to execute this document is required');
      const document=d.readPlan(root,path);
      const baseline=snapshot(null),routes=proposalCheck(),timeouts=timeoutPolicy(config.timeouts);
      if(fileIntent && (document.path!==fileIntent.path || document.hash!==fileIntent.hash || baseline!==fileIntent.snapshot || JSON.stringify(routes)!==JSON.stringify(fileIntent.routes) || JSON.stringify(timeouts)!==JSON.stringify(fileIntent.timeouts)))throw new Error('Plan, workspace or routes changed since this execution request; a fresh user request is required.');
      fileIntent={path:document.path,hash:document.hash,snapshot:baseline,routes,timeouts};
      approvalTurn=null;
      return result(`Execution request accepted for ${document.path}. Read this authoritative plan, resolve genuine ambiguities if any, and call delivery_plan with planFile="${document.path}", preserving its task boundaries and constraints. Supply each task's executable tests in tasks[].checks and final release tests in top-level checks, never prose or future-task checks assigned early. Do not combine the entire plan into one task or expand scope. The unchanged requested document will execute without asking for approval again. No work has launched yet.\n\n${document.content}`,{sourcePlan:{path:document.path,hash:document.hash}});
    }
    if(!path) {
      if(s.stage!=='awaiting-approval')throw new Error('No pending plan to execute. Resubmit the corrected proposal with delivery_plan, obtain a fresh user approval for the accepted candidate, then call delivery_execute; old tool-call arguments are not authority.');
      if(!approvalTurn || approvalTurn.key!==planKey())throw new Error('A fresh user reply approving this pending plan is required; for an existing Markdown plan supply planFile');
    }
    await launchApproved();return result('Execution started. Use delivery_status for actual progress.');
  }});
  pi.registerTool({name:'delivery_resume',label:'Continue approved delivery',description:'Continue an already approved interrupted task within its existing scope; route/budget changes require explicit confirmation. Confirmed coding timeouts allow one bounded same-model continuation after runner closure. Legacy budget changes require user confirmation. For legacy multi-task check-order failures, provide taskChecks derived from the approved source plan; one confirmation covers check ordering plus any configured route/budget changes. Final checks and completed coder evidence are preserved. An exact known read-only preflight non-launch can be retried after confirmation without coder replay. Closed failed children are reconciled without restarting execution; their evidence and coding spend are retained. Closed transport failures retry twice on the same route within the remaining budget; other failures are not auto-retried.',parameters:schemas.resume || schemas.empty,async execute(_id,params,_signal,_update,c){ctx=c;if(!s.enabled)throw new Error('Activate delivery first');const message=await resumeOwned(params.taskChecks);return result(message || 'Recovery started. Use delivery_status for actual progress.');}});
  pi.registerTool({name:'delivery_status',label:'Delivery status',description:'Read actual delivery state, approved routes and evidence.',parameters:schemas.empty,async execute(){return result(statusText(),structuredClone(s));}});
  pi.registerTool({name:'delivery_diff',label:'Delivery diff',description:'Read git status and diff in 40k-character pages; pass offset to continue. Pass commits=N for the last N commits with pinned revisions and subjects. Defaults to proposed committed range or working-tree changes.',parameters:schemas.diff || schemas.empty,async execute(_id,params={}){if(!s.enabled)throw new Error('Activate /delivery');const count=params.commits ?? s.reviewCommits;const range=params.commits!==undefined?d.revisionRange(root,params.commits):(s.plan?.reviewRange || (count?d.revisionRange(root,count):undefined));const offset=params.offset ?? 0;if(!Number.isInteger(offset)||offset<0)throw new Error('Invalid diff offset');return result(d.diff(root,range,40000,offset),range || {});}});

  pi.registerCommand('delivery',{
    description:'Delivery: describe a task; setup, models, status, resume, off',
    getArgumentCompletions:prefix=>['setup','models','status','resume','off'].filter(x=>x.startsWith(prefix)).map(x=>({value:x,label:x})),
    async handler(args,c) {
      ctx=c;
      try {
        if(!root) root=d.repoRoot(ctx.cwd);
        config=d.loadConfig(d.configPath());
        const command=args.trim();
        if(command==='status') {display(status()+'\n'+JSON.stringify(s,null,2));return;}
        if(command==='models') {
          const rows=catalog(ctx.modelRegistry.getAll(),ctx.modelRegistry.getAvailable());
          const cli=['claude','codex','cursor-agent'].map(name=>({name,installed:(process.env.PATH||'').split(':').some(dir=>{try{accessSync(join(dir,name),constants.X_OK);return true;}catch{return false;}})}));
          display(JSON.stringify({models:rows,externalCli:cli,note:'Available means locally configured, not tested/qualified. External CLIs are discovery-only, not delivery execution routes. No inference was run.'},null,2));return;
        }
        if(command==='setup') {
          guardIdle();if(!ctx.hasUI){display('Run /delivery setup in interactive pi to select routes and approve provider access.');return;}
          const models=ctx.modelRegistry.getAvailable();
          const choices=models.map(modelId).sort();if(!choices.length)throw new Error('No configured models. Configure a provider with /login, then reload.');
          const next=structuredClone(config);
          delete next.evidence; // Retire legacy trial/evidence markers without changing saved routes.
          for(const role of ROLES) {
            const preferred=next.routes[role] || (role==='planning'?ASTRA:null);
            const ordered=[...choices].sort((a,b)=>a===preferred?-1:b===preferred?1:a.localeCompare(b));
            const options=ordered.map(id=>({id,label:modelLabel(models.find(m=>modelId(m)===id))}));
            const selected=await ctx.ui.select(`Delivery ${role}: ${ROLE_HELP[role]}\nContext/output are token limits; prices are catalog estimates, not actual billing. Availability is not a quality ranking.`,options.map(o=>o.label));
            if(!selected)return;
            const choice=options.find(o=>o.label===selected);
            if(!choice)throw new Error('Selected model is no longer available; rerun setup.');
            next.routes[role]=choice.id;
          }
          if(!await ctx.ui.confirm('Save delivery routes and provider permission?',JSON.stringify(next.routes,null,2)+'\nSelected providers receive project context. No inference probes are run. Model metadata is not a performance guarantee. Plan approval, tests and independent reviews remain required; sensitive changes require security review.'))return;
          if(await ctx.ui.confirm('Enable automatic delivery in this repository?',root))next.repos=[...new Set([...next.repos,root])];
          d.saveConfig(d.configPath(),next);config=next;s=initialState();await activate();display('Delivery setup saved. Describe your task normally. Reviews run directly; implementation waits for your conversational approval.');return;
        }
        if(command==='off') {
          if(s.active && !d.isSettled(s.active)) {
            if(!s.active.id)throw new Error('Uncertain child launch. Inspect subagent status before disabling delivery.');
            await d.rpc(pi.events,'stop',{id:s.active.id});
            throw new Error('Stop requested; keep delivery active until the child settles. Inspect status before retrying off.');
          }
          if(job)throw new Error('Wait for delivery to settle before disabling it.');
          s.active=null;s.enabled=false;if(originalTools)pi.setActiveTools(originalTools);save();return;
        }
        if(command==='approve') {
          if(!ctx.hasUI){display('Approval requires the interactive command confirmation.');return;}
          const {routes}=pendingExecution();
          if(!await ctx.ui.confirm('Run this delivery plan?',readablePlan(routes)))return;
          await launchApproved();return;
        }
        if(command==='resume') {
          await resumeOwned();return;
        }
        if(!command && s.plan) {
          if(job) {display(statusText());return;}
          const retained=s.active || s.pendingContinuation || s.pendingRetry || s.resumeStage;
          if(retained) {
            if(!ctx.hasUI) {display(statusText()+'\nOpen /delivery interactively to review and resume this retained work.');return;}
            const identity=JSON.stringify(s);
            const preview=[s.plan.title,`Workspace: ${root}`,`Task ${s.task+1}/${s.plan.tasks.length}: ${s.plan.tasks[s.task].title}`,
              'Reconcile the retained worker and continue within the approved scope and remaining budget. Preserve partial files and completed reviews.',
              'An unresolved launch will not be replayed. Changed routes or budgets still require confirmation.'].join('\n');
            if(!await ctx.ui.confirm('Resume retained delivery?',preview))return;
            if(closed || JSON.stringify(s)!==identity)throw new Error('Delivery state changed while confirming resume; inspect status first');
            const message=await resumeOwned();if(message)display(message);return;
          }
          // A status/activation command must not erase a pending proposal or failed-run evidence.
          display(statusText());return;
        }
        guardIdle();
        requestText=command;approvalTurn=null;fileIntent=null;
        s={...initialState(),enabled:true};await activate();
        if(command && !s.reason)pi.sendUserMessage(command,{deliverAs:'followUp'});
        else display(status());
      } catch(e) {display(`Delivery: ${e.message}`);ctx.ui.notify(e.message,'error');}
    }
  });
  pi.on('session_start',async(_e,c)=>{
    ctx=c;closed=false;
    try {
      root=d.repoRoot(ctx.cwd);config=d.loadConfig(d.configPath());
      const entries=ctx.sessionManager.getBranch();
      const saved=entries.filter(e=>e.type==='custom'&&e.customType===ENTRY).at(-1)?.data;
      if(saved?.workspace===root && saved.owner===ctx.sessionManager.getSessionId())s=structuredClone(saved);
      else s=initialState();
      if(saved?.active && saved.owner!==ctx.sessionManager.getSessionId()) {s.enabled=true;s.reason='Forked delivery run: return to owning session; no automatic replay';s.stage='blocked';}
      else if(!saved)s.enabled=config.repos.includes(root);
      if(s.enabled) {
        retainPreflightProof(entries);
        restrict();await selectPlanning();
        if(s.active) {s.stage='blocked';s.reason='Retained child requires /delivery resume reconciliation';}
        else if(!['planning','awaiting-approval','complete','blocked'].includes(s.stage)) {s.resumeStage=s.stage;s.stage='blocked';s.reason=['checks','review-checks','verification'].includes(s.resumeStage)?'Interrupted host verification; delivery_resume reruns approved checks':'Interrupted between stages; use delivery_resume to reconcile before further work';}
        else {try{validateRoutes(config.routes,available());}catch(e){s.reason=e.message;}}
      }
      save();
    }catch(e){ctx.ui.setStatus('delivery',`Delivery OFF · ${e.message}`);}
  });
  pi.on('input',async(e,c)=>{
    ctx=c;
    if(['interactive','rpc'].includes(e.source)) {
      requestText=e.text || '';fileIntent=null;
      approvalTurn=s.stage==='awaiting-approval' && requestText.trim()?{key:planKey(),text:requestText}:null;
    }
    if(!s.enabled && /^\/skill:orchestrate-delivery(?:\s|$)/.test(e.text || '')) {
      try {root=d.repoRoot(ctx.cwd);config=d.loadConfig(d.configPath());await activate();}
      catch(error){display(`Delivery activation failed: ${error.message}`);return {action:'handled'};}
    }
    if(!s.enabled)return;
    if(!await selectPlanning()){display(status());return {action:'handled'};}
    // Discussion stays possible with missing coder routes; proposing/executing a plan remains blocked.
    return {action:'continue'};
  });
  pi.on('before_agent_start',async(e,c)=>{
    ctx=c;if(!s.enabled)return;restrict();
    if(modelId(ctx.model)!==(config.routes.planning||ASTRA) && !await selectPlanning()){ctx.abort?.();return;}
    return {systemPrompt:e.systemPrompt+'\n\nDELIVERY MODE ACTIVE. You are the planning/orchestration parent, never the implementer. Infer task intent from the user message AND conversation, not a command or keyword. Select relevant installed SPARK skills lazily: reviews use requesting-code-review/audit, bugs use debugging, new features use brainstorming/planning. UI work also uses available frontend/design/accessibility skills; pass selected skill paths and design requirements in task instructions. Do not invent missing skills. For review/validation requests, inspect delivery_diff (commits=N for recent commits), then call delivery_plan with mode=review: this starts reviewers automatically, with no coder or fixes. Do not ask for approval for the requested read-only review. Set start=false ONLY if the user asked for a plan without execution. Review criteria go in task.acceptance. For implementation, put each task\'s executable checks in tasks[].checks; top-level checks are FINAL release checks, run only after all tasks. Never assign a later task\'s test to an earlier task. Checks are commands, NEVER prose. Use checks=[] for static review and disclose tests not run. When the user explicitly requests execution of an existing Markdown plan, call delivery_execute with planFile even after reload; it adopts the file and returns instructions for deriving its tasks through delivery_plan. Preserve all task boundaries and global constraints. Do not demand prior registration or another approval for the same unchanged document. If unresolved scope/product decisions genuinely prevent execution, clarify rather than guess. Out-of-scope broken/external symlinks are coverage warnings, not reasons to demand repository repairs; do not follow or depend on their targets. For new changes, show a concise human-readable plan using delivery_plan with mode=implementation; wait for the user to agree in conversation, then CALL delivery_execute immediately. Do not merely promise to execute. Rejections, questions and requested revisions are not approval; clarify genuinely ambiguous intent. Never instruct the user to run /delivery approve or select a review mode. If a read-only review blocked because checks were invalid, prepare corrected executable checks and retry that review through delivery_plan. For a legacy multi-task implementation blocked by premature final checks, read delivery_status and the approved source plan, then call delivery_resume with taskChecks for every existing task. It corrects ordering after confirmation, preserves final gates and completed coding evidence, and resumes current-task checks and independent reviews without replaying the coder. Do not replace that implementation plan or increase retry limits. Read/search and delivery tools are available; parent shell/edit/write and direct child execution are blocked. The extension owns coder/reviewer execution. During a run, answer without changing scope. Coding timeouts have one bounded same-model continuation; do not request approval again for that already approved allowance. For retained interrupted work with an active/unresolved child or reserved continuation, use delivery_resume; never replace that owned child. Closed transport failures retry automatically at most twice on the same route, preserving partial work and budgets. Do not request another approval or route change for those retries. Other closed failed attempts are reconciled without automatic retry; inspect their native error and retained work before proposing further changes. An exhausted or failed terminal task with no owned child is different: inspect delivery_status and prepare its new corrective plan, not repeated resume/approval calls. No saved Markdown file is required when retained task context exists. For supported recovery, changed routes/budgets require explicit confirmation while retaining partial work; never replace an active or unresolved child with delivery_plan. Budget warnings are not proof of a stalled provider; a quiet running tool must not be killed. Only delivery_status establishes completion; never claim unrun checks or blocked work passed.\nCurrent state: '+status()+(terminalCorrection()?'\n'+correctivePlanAction():'')};
  });
  pi.on('tool_call',async(e,c)=>{
    if(s.enabled && e.toolName==='subagent_supervisor' && e.input?.action==='reply') {
      const ok=s.active?.id && c.hasUI && await c.ui.confirm('Approve supervisor reply?',JSON.stringify(e.input)+'\nDo not approve scope/model changes here; those require a new delivery plan.');
      return ok?undefined:{block:true,reason:'Supervisor response needs explicit user approval'};
    }
    if(s.enabled && !parentToolAllowed(e.toolName,e.input)) return {block:true,reason:'Delivery mode: parent mutation/unmanaged delegation is blocked. Use delivery_plan to route work; after explicit conversational approval use delivery_execute.',terminate:true};
  });
  pi.on('user_bash',()=>s.enabled?{result:{output:'Delivery mode blocks shell shortcuts. Use /delivery off explicitly for manual work.',exitCode:1,cancelled:false,truncated:false}}:undefined);
  pi.on('session_before_tree',()=>s.enabled?{cancel:true}:undefined);
  pi.on('session_shutdown',()=>{closed=true;checking?.abort();});
  return {state:()=>structuredClone(s),settled:()=>job||Promise.resolve()};
}
