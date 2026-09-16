import {join} from 'node:path';
import {accessSync,constants} from 'node:fs';
import {ROLES,ASTRA,AGENTS,REPORT_SCHEMA,catalog,validateRoutes,validatePlan,initialState,approve,advance,parentToolAllowed,timeoutPolicy,attemptBudget,allChecks,checksForTask,repairCheckScopes,correctionPolicy,fixRoundLimit} from './policy.mjs';
import * as io from './io.mjs';
import {rpc} from './rpc.mjs';
import {ROLE_HELP,modelLabel} from './setup.mjs';

const ENTRY='delivery-mode-v1';
const result=(text,details={})=>({content:[{type:'text',text}],details});
const modelId=m=>m?`${m.provider}/${m.id}`:'';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class OwnedRunBusy extends Error {}

export function registerDelivery(pi,schemas,deps={}) {
  if(deps.child ?? process.env.PI_SUBAGENT_CHILD==='1') return;
  const suppliedWorkingTreeEvidence=typeof deps.workingTreeEvidence==='function';
  const suppliedDiff=typeof deps.diff==='function';
  for(const [k,v] of Object.entries({...io,rpc,pollMs:1500,retryDelayMs:5000,now:Date.now})) if(!(k in deps)) deps[k]=v;
  const d=deps;
  let s=initialState(),ctx,root,config,originalTools,job=null,closed=false,checking,requestText='',approvalTurn=null,fileIntent=null;
  function snapshot(plan=s.plan,warnings=[]) {
    if(plan?.sourcePlan && d.readPlan(root,plan.sourcePlan.path).hash!==plan.sourcePlan.hash)throw new Error('Source plan changed; read the updated document and obtain fresh execution approval.');
    return d.fingerprint(root,{scope:plan?.tasks.flatMap(t=>t.files) || [],commands:allChecks(plan),warnings});
  }
  const planKey=()=>JSON.stringify({plan:s.plan,snapshot:s.snapshot,correctionPolicy:s.correctionPolicy});
  function readablePlan(routes) {
    const p=s.plan;
    return [p.title,`Workspace: ${root}`,`Mode: ${p.mode==='review'?'Read-only review — no fixes':'Implementation'}`,
      p.reviewRange?`Commits: ${p.reviewRange.base.slice(0,10)}..${p.reviewRange.head.slice(0,10)}`:'',
      p.sourcePlan?`Source plan: ${p.sourcePlan.path}`:'',
      ...(s.coverageWarnings || []).map(w=>`Coverage warning: ${w}`),
      `Correction budget: up to ${fixRoundLimit(s)} coder rework rounds per task within the existing cumulative coding-time allowance.`,
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
    const boundCorrections=s.correctionPolicy;
    const corrections=boundCorrections ? correctionPolicy(config.corrections) : correctionPolicy({},true);
    if(boundCorrections && JSON.stringify(corrections)!==JSON.stringify(boundCorrections))throw new Error('Correction policy changed; reapproval required');
    d.validateCommands(root,allChecks(s.plan));
    return {routes,hash,timeouts:timeoutPolicy(config.timeouts),corrections};
  }
  async function launchApproved() {
    const {routes,hash,timeouts,corrections}=pendingExecution();
    await d.rpc(pi.events,'ping');
    if(hash!==snapshot())throw new Error('Workspace changed before execution');
    const warnings=s.coverageWarnings || [];
    s=approve(s,routes,hash);s.coverageWarnings=warnings;s.timeouts=timeouts;s.correctionPolicy=corrections;approvalTurn=null;fileIntent=null;save();start();
  }
  function display(text) {pi.sendMessage({customType:'delivery',content:text,display:true});}
  function status() {
    const route=['checks','review-checks','verification'].includes(s.stage)?'host verification':s.active?.model || (s.stage==='blocked'?s.failedRun?.model:null) || s.routes?.[s.stage] || config?.routes?.planning || ASTRA;
    return !s.enabled?'Delivery OFF · /delivery setup':`Delivery ${s.reason?'BLOCKED':'ON'} · ${s.stage} · ${route} · ${s.plan?`task ${s.task+1}/${s.plan.tasks.length}`:'awaiting plan'}${s.reason?' · '+s.reason:''}`;
  }
  function correctionExtensionAvailable() {
    const configured=correctionPolicy(config.corrections);
    const bound=fixRoundLimit(s);
    const spent=s.coding?.[s.task]?.spentMs || 0;
    const total=s.timeouts?.coderMs+s.timeouts?.continuationMs;
    return s.stage==='blocked' && /^Fix\/review round limit exhausted/.test(s.reason) &&
      !job && !s.active && !s.pendingContinuation && !s.pendingRetry && !s.resumeStage &&
      s.plan?.mode!=='review' && s.correctionPolicy?.source!=='confirmed-extension' && configured.maxFixRounds>bound && Number.isFinite(total) && spent<total;
  }
  function roundLimitExhausted() {
    return s.stage==='blocked' && /^Fix\/review round limit exhausted/.test(s.reason) &&
      !job && !s.active && !s.pendingContinuation && !s.pendingRetry && !s.resumeStage &&
      s.plan?.mode!=='review' && s.plan?.tasks?.length>0;
  }
  function terminalCorrection() {
    const failed=s.failedRun?.state==='failed' && s.failedRun.task===s.task;
    return s.stage==='blocked' && failed && !job && !s.active && !s.pendingContinuation && !s.pendingRetry && !s.resumeStage && s.plan?.tasks?.length>0;
  }
  function correctivePlanAction() {
    const review=s.failedRun && s.failedRun.stage!=='coder'?' This was a review failure, not a code finding. Do not replay completed coding; propose read-only validation of existing work and explicitly preserve unfinished implementation obligations.':'';
    return review+' NEXT ACTION: Prepare a new corrective plan with delivery_plan from the retained requirements and latest findings, preserving partial work, unfinished tasks and final checks. No saved Markdown file is required. This is a new proposal requiring fresh approval after it is shown, not a reset or automatic retry of the exhausted run. Do not request a harness reset or keep repeating delivery_resume/approval.';
  }
  function statusText() {
    const lines=[status()];
    if(s.active?.id)lines.push(`Retained child: ${s.active.id}`);
    lines.push('Next action: '+nextAction().message);
    lines.push('Configured routes for new plans: '+JSON.stringify(config?.routes || {}));
    if(s.routes)lines.push('Routes bound to retained plan: '+JSON.stringify(s.routes));
    if(s.plan) {
      const currentReviewed=s.reports.some(r=>r.task===s.task && r.round===s.round && r.stage===(s.plan.security?'security':'quality') && r.report.status==='approved');
      lines.push(`Tasks through required reviews: ${s.stage==='complete'?s.plan.tasks.length:s.task+Number(currentReviewed)}/${s.plan.tasks.length}. Final verification: ${s.stage==='complete'?'complete':'not complete'}.`);
    }
    if(s.active?.id) {
      try {
        const progress=d.runProgress(s.active);
        if(progress)lines.push('Native worker evidence (activity is not verification): '+JSON.stringify(progress));
      } catch(e){lines.push('Native worker evidence unavailable: '+e.message);}
    }
    if(s.checks?.length)lines.push('Host check results: '+JSON.stringify(s.checks));
    if(terminalCorrection()) {
      const latest=s.reports.filter(r=>r.task===s.task).at(-1)?.report;
      lines.push(correctivePlanAction(),'Retained plan context (requirements, not execution authorization):',JSON.stringify({title:s.plan.title,sourcePlan:s.plan.sourcePlan,remainingTasks:s.plan.tasks.slice(s.task),finalChecks:s.plan.checks,failedAttempt:s.failedRun,latestReview:latest?{status:latest.status,summary:latest.summary,findings:latest.findings}:null},null,2));
    }
    return lines.join('\n');
  }
  function blockedReviewReport() {
    if(s.stage!=='blocked' || !s.plan)return null;
    const latest=s.reports.filter(r=>r.task===s.task).at(-1);
    return latest && ['spec','quality','security'].includes(latest.stage) && latest.report?.status==='blocked' ? latest : null;
  }
  function blockedReviewRecovery() {
    const recovery=blockedReviewReport();
    if(!recovery || job || s.active || s.pendingRetry || s.pendingContinuation || s.resumeStage)return null;
    try {if(snapshot()!==s.snapshot)return null;} catch {return null;}
    return recovery;
  }
  function nextAction() {
    if(!s.enabled)return {action:'activate',message:'Activate /delivery to begin.'};
    if(job)return {action:'monitor',message:'Execution is running. Use delivery_status; do not call setup, resume or execute. For a running coder, delivery_steer can request current-task verification.'};
    if(s.active || s.pendingContinuation || s.pendingRetry || s.resumeStage)return {action:'resume',message:'Call delivery_resume to reconcile retained execution. Do not replace its plan or change routes yet.'};
    if(blockedReviewRecovery())return {action:'resume',message:'Call delivery_resume to retry the evidence-blocked reviewer at the same stage. The workspace, task, round, routes and prior blocked report are preserved; no coder replay is launched.'};
    if(correctionExtensionAvailable())return {action:'resume',message:'A higher configured correction bound can be adopted once with delivery_resume confirmation.'};
    if(roundLimitExhausted())return {action:'inspect',message:'The approved correction bound is exhausted. Report retained findings and wait for an explicit user decision; do not create another plan automatically.'};
    if(terminalCorrection())return {action:'plan',message:'Call delivery_plan with a corrective plan from retained context. Setup is unnecessary unless you want different models; use delivery_configure for explicit route changes.'};
    if(s.stage==='awaiting-approval')return {action:'approve',message:'The displayed plan awaits conversational approval. After approval, call delivery_execute. Do not repeat setup or resume.'};
    if(s.stage==='complete')return {action:'complete',message:'Execution completed. Report the recorded checks and reviews.'};
    if(s.stage==='blocked')return {action:'inspect',message:'Inspect the retained reason and evidence before preparing a correction; setup only changes model routes.'};
    return {action:'plan',message:'Describe the task and prepare it with delivery_plan. Setup is only needed for missing routes or requested model changes.'};
  }
  function save() {pi.appendEntry(ENTRY,{...structuredClone(s),workspace:root,owner:ctx.sessionManager.getSessionId()});ctx.ui.setStatus('delivery',status());}
  function block(error) {
    s.stage='blocked';s.reason=error instanceof Error?error.message:String(error);
    if(rejectedReadOnlyLaunch() || rejectedExcludedModelLaunch())s.active.preflightRejection ||= s.reason;
    save();display(`Delivery blocked: ${s.reason}${s.active?.id?'\nRun: '+s.active.id:''}`);
  }
  function restrict() {
    if(!originalTools) originalTools=pi.getActiveTools();
    const discovered=pi.getAllTools?.().map(t=>t.name) || [];
    const candidates=new Set([...originalTools,...pi.getActiveTools(),...discovered,'delivery_plan','delivery_execute','delivery_resume','delivery_status','delivery_diff','delivery_configure','delivery_steer']);
    pi.setActiveTools([...candidates].filter(name=>parentToolAllowed(name,{action:'status'}) || name==='subagent_supervisor'));
  }
  function available() {return ctx.modelRegistry.getAvailable().map(modelId);}
  async function selectPlanning() {
    const id=config?.routes?.planning || ASTRA;
    const m=ctx.modelRegistry.getAvailable().find(m=>modelId(m)===id);
    if(!m || (modelId(ctx.model)!==id && !await pi.setModel(m))) {s.reason=`Planning model unavailable: ${id}. Configure provider access with /login or choose an available planning route with /delivery setup.`;save();return false;}
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
  function guardIdle() {if(job || s.active || s.pendingRetry) throw new OwnedRunBusy('An owned run is active or unresolved; no plan or configuration was changed. '+nextAction().message);}
  function refreshConfig() {config=d.loadConfig(d.configPath());}
  function reconcileOrphanedRun() {
    if(job || !s.active?.id)return false;
    const evidence=d.orphanedRunEvidence(s.active);
    if(!evidence)return false;
    // Runtime duration is unknown. Charge the entire reserved allowance rather
    // than refunding time or granting a continuation after evidence was lost.
    if(!Number.isFinite(s.active.budgetMs) || s.active.budgetMs<=0)throw new Error('Reboot confirmed, but the retained worker budget is missing; inspect the saved run before recovery.');
    chargeCoding({durationMs:s.active.budgetMs});
    const reason='Worker records were lost after a host reboot; the previous worker cannot still be running. Completion and verification are unknown.';
    s.failedRun={...s.active,task:s.task,round:s.round,state:'failed',error:reason,closureEvidence:evidence,durationMs:s.active.budgetMs,durationEstimated:true};
    s.active=null;s.pendingContinuation=false;delete s.pendingRetry;delete s.resumeStage;
    s.stage='blocked';s.reason=reason;approvalTurn=null;fileIntent=null;save();
    display('Retired the interrupted worker after a confirmed host reboot. Partial files, the plan, reviews and consumed budget are preserved. Setup is available; execution requires a new corrective plan. No worker was launched.');
    return true;
  }
  function guardConfiguration() {
    reconcileOrphanedRun();
    guardIdle();
    if(s.pendingContinuation || s.resumeStage)throw new Error('Retained execution must be reconciled with delivery_resume before changing routes.');
  }
  async function saveConfiguration(next) {
    const rebind=s.stage==='awaiting-approval' && s.plan;
    if(rebind && snapshot()!==s.snapshot)throw new Error('Workspace changed since proposal; refresh it with delivery_plan before changing routes.');
    const retainedReason=s.stage==='blocked'?s.reason:'';
    d.saveConfig(d.configPath(),next);config=next;approvalTurn=null;fileIntent=null;
    if(!s.plan)s=initialState();
    if(rebind){s.routes=structuredClone(next.routes);s.timeouts=timeoutPolicy(next.timeouts);}
    await activate();
    if(retainedReason && !s.reason){s.reason=retainedReason;save();}
    if(rebind)display(readablePlan(next.routes));
  }
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
    const limits=timeoutPolicy(config.timeouts),bound=s.timeouts?timeoutPolicy(s.timeouts):null;
    if(bound && JSON.stringify(limits)!==JSON.stringify(bound))throw new Error('Time budget changed; reapproval required');
    if(s.routes && JSON.stringify(r)!==JSON.stringify(s.routes)) throw new Error('Routes changed; reapproval required');
    return r;
  }
  function briefing(stage) {
    const task=s.plan.tasks[s.task];
    const recovering=s.pendingContinuation || s.active?.continuation || (s.interruptions || []).some(r=>r.task===s.task && r.error);
    const scope={title:s.plan.title,mode:s.plan.mode || 'implementation',approvedRoutes:s.routes,sourcePlan:s.plan.sourcePlan,coverageWarnings:s.coverageWarnings,reviewRange:s.plan.reviewRange,taskIndex:s.task,task,interruptions:(s.interruptions || []).filter(r=>r.task===s.task),completedTasks:s.plan.tasks.slice(0,s.task),checks:s.plan.mode==='review'?s.plan.checks:checksForTask(s.plan,s.task),finalChecks:s.plan.checks};
    const workingEvidence=(paths)=>suppliedWorkingTreeEvidence || !suppliedDiff
      ? d.workingTreeEvidence(root,paths)
      : d.diff(root);
    const committedEvidence=(paths)=>d.diff(root,s.plan.reviewRange,40000,0,paths);
    const evidence=stage==='spec' && !s.plan.reviewRange
      ? workingEvidence(task.files)
      : stage==='spec' && s.plan.reviewRange
        ? committedEvidence(task.files)
        : (stage==='quality' || stage==='security') && !s.plan.reviewRange
          ? workingEvidence()
          : d.diff(root,s.plan.reviewRange);
    const localDiff=s.plan.reviewRange
      ? `git diff --no-ext-diff ${s.plan.reviewRange.base} ${s.plan.reviewRange.head} -- <path>`
      : 'git diff --no-ext-diff -- <path>';
    const reviewScope=stage==='spec'
      ? `Review evidence is the exact current-task diff and path-scoped tracked/untracked status. Inspect only the current task for acceptance; accepted prior-task changes are preserved baseline unless actual-source inspection demonstrates a regression affecting current acceptance. For clipped evidence, inspect the approved task paths with ${localDiff}. Do not block because earlier task files are not included.`
      : stage==='quality' || stage==='security'
        ? `Review evidence is aggregate. Use available read and bash tools to inspect the complete workspace; run ${localDiff} for clipped or important files. Do not block solely because embedded evidence is truncated; actual source and repository-local git commands can complete the approved scope. Block only when evidence is genuinely inaccessible or material uncertainty remains.`
        : '';
    return [
      stage==='coder'?'Implement only this approved task. Follow selected SPARK TDD/debugging/verification skills.':`Read-only review. Do not modify any files. Independent ${stage} review. Inspect actual source and the approved review evidence for current-task acceptance and earlier-task regressions. Later task deliverables are not required yet.`,
      stage==='coder' && recovering?'Recovery priority: after reading applicable repository instructions, run the approved current-task checks on the existing work: '+JSON.stringify(checksForTask(s.plan,s.task))+'. Use actual failures to target inspection and fixes. Avoid repeating broad repository discovery. The remaining budget includes verification; report exact command results and unresolved failures before it ends.':'',
      'No commit, push, merge, deploy, credentials access or delegation. Preserve unrelated changes. Stop for scope questions; do not widen scope.',
      'Return your result using the supplied structured_output schema. status=approved requires findings=[]; put successful checks, completed work and informational evidence in summary, never in findings. Use changes_requested for actionable fixes; blocked for missing evidence. findings are concise strings with severity, file:line, evidence, impact and fix. This schema replaces prose/fenced/JSON-only report formatting from role skills.',
      JSON.stringify(scope),
      'Use the runtime-approved dispatch bindings in approvedRoutes; older model names in retained task/document text do not change these bindings. No route changes or fallback.',
      'For implementation, checks apply to the current task only. finalChecks are release gates after all tasks; do not implement later tasks to satisfy them early.',
      s.plan.sourcePlan?`Read the authoritative Markdown plan at ${s.plan.sourcePlan.path}; preserve its global constraints and task boundaries. Do not edit this approved document, including checkboxes; report progress separately.`:'',
      'Uncovered symlink targets are not dependencies you may silently use. Stop if this task needs one. Do not delete or repair unrelated links.',
      s.feedback?'Prior actionable findings: '+s.feedback:'',
      recovering?`Continue the same approved task from its partial changes. Start with verification of the partial workspace, inspect the previous tool logs, and finish only remaining work. Do not discard or reimplement completed work. Previous interrupted runs: ${JSON.stringify((s.interruptions || []).filter(r=>r.task===s.task))}`:'',
      stage==='coder'?'':evidence,
      stage==='coder'?'':reviewScope,
      s.plan.mode==='review'?`Read-only validation: report findings only. Do not implement or fix anything. For a committed range, untracked files are out of scope. Read the full diff in chunks from the supplied review patch; the inline preview may be truncated.`:'',
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
    // A changed or unavailable configuration is not a launch-safety error: refuse the
    // retry and let the caller close the attempt instead of wedging reconciliation.
    refreshConfig();
    let routes;try {routes=validateRoutes(config.routes,available());}catch {return false;}
    if(s.routes && JSON.stringify(routes)!==JSON.stringify(s.routes))return false;
    if(!s.timeouts)return false;
    if(JSON.stringify(timeoutPolicy(config.timeouts))!==JSON.stringify(timeoutPolicy(s.timeouts)))return false;
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
    if(s.active.stage!=='coder' && current!==s.snapshot)return false; // Source changed: close the attempt instead of retrying a review on a mutated tree.
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
    const now=d.now(),limits=s.timeouts?timeoutPolicy(s.timeouts):timeoutPolicy(config.timeouts);
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
    const routes=validateRoutes(config.routes,available()),limits=timeoutPolicy(config.timeouts),bound=s.timeouts?timeoutPolicy(s.timeouts):null;
    if(JSON.stringify(routes)===JSON.stringify(s.routes) && bound && JSON.stringify(limits)===JSON.stringify(bound))return;
    const baseline=snapshot();
    const changes=ROLES.filter(r=>routes[r]!==s.routes?.[r]).map(r=>`${r}: ${s.routes?.[r] || 'unset'} → ${routes[r]}`);
    for(const key of Object.keys(limits))if(limits[key]!==bound?.[key])changes.push(`${key.replace(/Ms$/,'')} budget/notice: ${(bound?.[key] ?? 0)/60000} → ${limits[key]/60000} minutes`);
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
    if(rejectedReadOnlyLaunch() || rejectedExcludedModelLaunch()) {s.active.preflightRejection ||= s.reason;return;}
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
      if(rejectedReadOnlyLaunch(prior) || rejectedExcludedModelLaunch(prior))s.active.preflightRejection=prior.active.preflightRejection ?? prior.reason;
      break; // A newer unknown failure cannot be bypassed using older evidence.
    }
  }
  function rejectedExcludedModelLaunch(state=s) {
    const a=state.active;
    if(state.stage!=='blocked' || !a || a.id!==null || a.dir!==null || !AGENTS[a.stage] || a.model!==state.routes?.[a.stage])return false;
    // The pinned runner resolves explicit model exclusions before launching a child.
    // Only this exact preflight diagnostic proves non-launch; transport errors do not.
    const prefix=`Requested subagent model '${a.model}' is excluded and cannot be replaced by a fallback (reason: `;
    const reason=a.preflightRejection ?? state.reason;
    return typeof reason==='string' && reason.startsWith(prefix) && /^[^\r\n]{1,320}\)\.$/.test(reason.slice(prefix.length));
  }
  async function resumeOwned(taskChecks) {
    if(job)return 'Delivery is already running. '+nextAction().message;
    if(taskChecks===undefined && s.stage==='planning' && !s.plan && !s.active && !s.pendingContinuation && !s.pendingRetry && !s.resumeStage) {
      return 'No delivery task has started in this session. Describe your task normally. Reviews run directly; implementation waits for your conversational approval.';
    }
    config=d.loadConfig(d.configPath());
    if(reconcileOrphanedRun())return statusText();
    const blockedReport=blockedReviewReport();
    if(taskChecks===undefined && blockedReport) {
      if(s.active || s.pendingRetry || s.pendingContinuation || s.resumeStage)throw new Error('Blocked review cannot resume while an active or pending continuation/retry exists; reconcile the retained execution first.');
      if(snapshot()!==s.snapshot)throw new Error('Blocked review snapshot changed; inspect the workspace before retrying the reviewer.');
      const recovery=blockedReviewRecovery();
      if(!recovery)throw new Error('Blocked review evidence is no longer safely retryable; inspect the workspace and retained report.');
      s.stage=recovery.stage;s.reason='';s.feedback=JSON.stringify(recovery.report);s.active=null;save();start();
      return 'Retrying the evidence-blocked reviewer at the same stage. The coder, round, task, routes and prior blocked report are preserved.';
    }
    if(taskChecks===undefined && rejectedExcludedModelLaunch()) {
      const reason=s.active.preflightRejection ?? s.reason;
      s.failedRun={...s.active,task:s.task,round:s.round,state:'failed',error:reason,nativeError:reason,notLaunched:true,durationMs:0,sessionFiles:[]};
      s.active=null;delete s.resumeStage;s.reason=reason;save();
      return 'Excluded-model preflight reconciled: no worker was launched and no execution restarted. Retained plan, partial work, reviews and coding budget are preserved. Use delivery_configure only if the user wants different models. '+correctivePlanAction();
    }
    if(taskChecks===undefined && rejectedReadOnlyLaunch()) {
      const routes=validateRoutes(config.routes,available()),limits=timeoutPolicy(config.timeouts),bound=s.timeouts?timeoutPolicy(s.timeouts):null;
      if(snapshot()!==s.snapshot)throw new Error('Workspace changed since review; preflight recovery refused');
      const identity=JSON.stringify(s),stage=s.active.stage;
      const changes=ROLES.filter(r=>routes[r]!==s.routes?.[r]).map(r=>`${r}: ${s.routes?.[r]} → ${routes[r]}`);
      for(const key of Object.keys(limits))if(limits[key]!==bound?.[key])changes.push(`${key.replace(/Ms$/,'')} budget/notice: ${(bound?.[key] ?? 0)/60000} → ${limits[key]/60000} minutes`);
      const preview=[`Native preflight rejected ${stage} before launching a child. Retry with ${routes[stage]} using an explicit read-only prompt.`,...changes,'Selected providers receive task context and prior evidence. No write tools, coder replay, retry reset or skipped reviews. Existing checks, findings and coding spend are retained.'].join('\n');
      if(!ctx.hasUI || !await ctx.ui.confirm('Retry the rejected read-only review?',preview))throw new Error('Read-only review retry was not approved');
      if(closed || JSON.stringify(s)!==identity)throw new Error('Delivery state changed during review recovery');
      config=d.loadConfig(d.configPath());
      if(JSON.stringify(validateRoutes(config.routes,available()))!==JSON.stringify(routes) || JSON.stringify(timeoutPolicy(config.timeouts))!==JSON.stringify(limits))throw new Error('Recovery configuration changed during approval');
      if(snapshot()!==s.snapshot)throw new Error('Workspace changed during review recovery');
      s.routes=routes;s.timeouts=limits;s.active=null;s.stage=stage;s.reason='';save();start();return;
    }
    if(taskChecks===undefined && s.active && s.active.id===null && s.active.dir===null && s.stage==='blocked' && !s.active.preflightRejection) {
      // Uncertain launch: the reservation never recorded a run ID, so closure cannot be
      // proven from native artifacts. Only an explicit user attestation may close it.
      if(!ctx.hasUI)throw new Error('Uncertain launch resolution requires interactive confirmation; state preserved');
      if(snapshot()!==s.snapshot)throw new Error('Workspace changed since the uncertain launch; inspect changes before closing the reservation');
      const identity=JSON.stringify(s),reason=s.reason;
      const preview=['The retained launch reservation never recorded a run ID, so delivery cannot prove whether a worker started.','Confirm you inspected native subagent status and that no child from this attempt is still running or needs settling.','The reservation closes as a failed attempt. Launch and completion remain unknown; the full reserved coder allowance is charged when applicable. The plan, partial files, reviews and evidence are preserved; no execution restarts. Continuing needs a new corrective plan and fresh approval.'].join('\n');
      if(!await ctx.ui.confirm('Close the uncertain launch reservation?',preview))throw new Error('Uncertain launch was not confirmed; state preserved');
      if(closed || JSON.stringify(s)!==identity)throw new Error('Delivery state changed during confirmation; inspect status first');
      const limits=s.timeouts?timeoutPolicy(s.timeouts):timeoutPolicy(config.timeouts);
      const budgetMs=s.active.budgetMs ?? attemptBudget(limits,s.active.stage,s.active.stage==='coder'?codingLedger().spentMs:0,Boolean(s.active.continuation));
      s.active.budgetMs=budgetMs;chargeCoding({durationMs:budgetMs});
      s.failedRun={...s.active,task:s.task,round:s.round,state:'failed',error:reason,nativeError:reason,launchUnknown:true,closureEvidence:{kind:'user-attestation',confirmedAt:d.now()},durationMs:budgetMs,durationEstimated:true,sessionFiles:[]};
      s.active=null;delete s.resumeStage;save();
      return 'Uncertain launch reservation closed by explicit user attestation; launch and completion remain unknown, and no execution restarted. Retained plan, partial work, reviews and evidence are preserved. '+correctivePlanAction();
    }
    if(taskChecks!==undefined) {
      guardIdle();
      const routes=validateRoutes(config.routes,available()),limits=timeoutPolicy(config.timeouts),bound=s.timeouts?timeoutPolicy(s.timeouts):null;
      if(snapshot()!==s.snapshot)throw new Error('Workspace changed since the recorded coder result; check-scope recovery refused');
      const recovered=repairCheckScopes(s,taskChecks);
      recovered.routes=routes;recovered.timeouts=limits;
      d.validateCommands(root,allChecks(recovered.plan));
      const baseline=s.snapshot,identity=JSON.stringify(s);
      const changes=ROLES.filter(r=>routes[r]!==s.routes?.[r]).map(r=>`${r}: ${s.routes?.[r] || 'unset'} → ${routes[r]}`);
      if(!bound || JSON.stringify(limits)!==JSON.stringify(bound))changes.push(`Adopt configured budgets: coder ${limits.coderMs/60000}m + ${limits.continuationMs/60000}m continuation per task; reviewers ${limits.reviewMs/60000}m. Previously consumed time remains charged.`);
      const preview=['Correct verification ordering; preserve task scope, coder work, evidence and time spent.',...changes,'Selected providers receive the approved task context and prior execution evidence.',...recovered.plan.tasks.map((t,i)=>`Task ${i+1}: ${t.checks.join('; ')}`),'Final release checks remain mandatory:',...recovered.plan.checks,`Restore ${recovered.checkScopeRecovery.creditedRounds} rounds consumed by premature release checks; retain all other retry history.`].join('\n');
      if(!ctx.hasUI || !await ctx.ui.confirm(changes.length?'Approve check ordering and route/budget changes?':'Correct legacy check ordering and continue reviews?',preview))throw new Error('Check ordering correction was not approved; existing work preserved');
      if(closed || JSON.stringify(s)!==identity)throw new Error('Delivery state changed during check-scope approval');
      config=d.loadConfig(d.configPath());
      if(JSON.stringify(validateRoutes(config.routes,available()))!==JSON.stringify(routes) || JSON.stringify(timeoutPolicy(config.timeouts))!==JSON.stringify(limits))throw new Error('Recovery configuration changed during approval; no execution resumed');
      if(snapshot(recovered.plan)!==baseline)throw new Error('Workspace changed during check-scope approval');
      s=recovered;save();display(s.pendingContinuation?'Check ordering corrected; continue the retained timeout recovery. Final release checks retained.':'Check ordering corrected. Re-running current task checks, then independent reviews. No coder replay; final release checks retained.');start();return;
    }
    if(taskChecks===undefined && correctionExtensionAvailable()) {
      const configured=correctionPolicy(config.corrections),bound=fixRoundLimit(s),latest=s.reports.filter(r=>r.task===s.task).at(-1);
      const baseline=snapshot(),identity=JSON.stringify(s),configuration=JSON.stringify({routes:config.routes,timeouts:config.timeouts,corrections:config.corrections});
      const task=s.plan.tasks[s.task],checks=checksForTask(s.plan,s.task),total=s.timeouts.coderMs+s.timeouts.continuationMs;
      const preview=[
        `Continue task ${s.task+1}/${s.plan.tasks.length}: ${task.title}`,
        `Latest findings: ${JSON.stringify(latest?.report?.findings || [])}`,
        `Correction rounds: ${bound} → ${configured.maxFixRounds}.`,
        `Unchanged routes: ${JSON.stringify(s.routes)}.`,
        `Unchanged checks: ${checks.join('; ')}.`,
        `Unchanged task scope: ${task.files.join(', ')}.`,
        `Cumulative coding budget remains ${(total/60000)}m; spent ${(s.coding?.[s.task]?.spentMs || 0)/60000}m.`,
        'No commit, deploy or replacement plan.'
      ].join('\n');
      if(!ctx.hasUI || !await ctx.ui.confirm('Approve correction-bound extension?',preview))throw new Error('Correction extension was not approved; exhausted state preserved');
      if(closed || JSON.stringify(s)!==identity)throw new Error('Delivery state changed during correction extension approval');
      config=d.loadConfig(d.configPath());
      if(JSON.stringify({routes:config.routes,timeouts:config.timeouts,corrections:config.corrections})!==configuration)throw new Error('Correction extension configuration changed during approval');
      if(!correctionExtensionAvailable() || snapshot()!==baseline)throw new Error('Workspace or correction state changed during approval');
      s.correctionPolicy={...configured,source:'confirmed-extension'};
      s.round=Math.max(s.round,bound)+1;
      s.stage='coder';s.reason='';s.feedback=JSON.stringify(latest?.report || {});s.active=null;save();start();return 'Correction bound extended with confirmation; retained task, plan, routes, checks, reports and coding budget preserved.';
    }
    if(taskChecks===undefined && roundLimitExhausted())return statusText();
    if(!s.active && !s.failedRun && s.stage==='blocked' && s.plan?.mode!=='review' && s.plan?.tasks.length>1 && s.plan.tasks.some(t=>!t.checks))throw new Error('Legacy check ordering needs repair: read the approved source plan and call delivery_resume with taskChecks for every task. Final checks and completed coder evidence will be retained.');
    if(s.active?.id) {
      await d.rpc(pi.events,'status',{id:s.active.id});
      const progress=d.runProgress(s.active);
      if(progress?.timedOut && s.active.stage==='coder') {
        if(s.recoverySnapshot && snapshot()!==s.recoverySnapshot)throw new Error('Workspace changed after timeout; inspect changes and obtain fresh approval');
        if(!d.isSettled(s.active))return 'Waiting for the timed-out writer to close; no replacement launched. Use delivery_status to inspect recorded evidence. Retry delivery_resume after runner closure is confirmed; do not replace the plan or infer closure from silence.';
        await approveRecoveryPolicy();
        routeCheck();if(queueContinuation(progress)){start();return;}
        return 'Failed attempt reconciled; no execution restarted. Inspect delivery_status for the corrective-plan path.';
      }
      if(progress?.state==='failed') {if(queueConnectionRetry(progress)){start();return 'Same-route connection retry scheduled.';}return closeFailedAttempt(progress);}
      if(['stopped','paused','blocked'].includes(progress?.state))throw new Error(`Native child is ${progress.state}; no execution restarted. Inspect native status before further recovery.`);
      s.stage=s.active.stage;
    } else if(s.pendingRetry) {
      refreshConfig();
      let routes;try {routes=validateRoutes(config.routes,available());}catch {routes=null;}
      if(!routes || (s.routes && JSON.stringify(routes)!==JSON.stringify(s.routes)) || !s.timeouts || JSON.stringify(timeoutPolicy(config.timeouts))!==JSON.stringify(timeoutPolicy(s.timeouts))) {
        // A queued retry must never launch on changed bindings; cancel it and keep the evidence.
        delete s.pendingRetry;s.stage='blocked';s.reason='Queued connection retry was cancelled because routes or budgets changed; prepare a corrective plan from the retained evidence.';save();
        return statusText();
      }
      s.stage=s.pendingRetry.stage;
    } else if(s.pendingContinuation) {
      if(snapshot()!==s.snapshot)throw new Error('Workspace changed before continuation; inspect changes and obtain fresh approval');
      await approveRecoveryPolicy();s.stage='coder';
    }
    else if(['checks','review-checks','verification','spec','quality','security','coder'].includes(s.resumeStage))s.stage=s.resumeStage;
    else if(terminalCorrection())return statusText();
    else if(['awaiting-approval','complete'].includes(s.stage))return statusText();
    else throw new Error('No retained run or safe continuation to resume');
    delete s.resumeStage;s.reason='';save();start();
  }
  async function runChecks({commands=s.plan.checks,failureLabel,mutationLabel,fixable=false}) {
    checking=new AbortController();s.checks=[];save();
    for(const command of commands) {
      const check=await d.verifyCommand(root,command,checking.signal,s.timeouts?.commandMs);
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
        try {routeCheck();}
        catch(e) {
          if(!s.active?.id)throw e;
          // Never leave a live child unmonitored just because configuration changed.
          try {await d.rpc(pi.events,'stop',{id:s.active.id});}catch {}
          throw new Error(`${e.message} The owned child ${s.active.id} was asked to stop so its attempt can be reconciled; retry delivery_resume after it settles.`);
        }
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
          s.active={id:null,dir:null,model:s.routes[s.stage],stage:s.stage,agent:AGENTS[s.stage],childIndex:0,budgetMs,startedAt:d.now(),continuation};delete s.pendingContinuation;delete s.pendingRetry;save();
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

  pi.registerTool({name:'delivery_plan',label:'Delivery plan',description:'Submit a plan after resolving material ambiguities with the user in normal conversation. Clarification questions are allowed before calling this tool. mode=review starts read-only validation immediately; mode=implementation presents a readable plan for conversational approval. commits=N pins recent commits. tasks[].checks are current-task commands; top-level checks are final release commands after all tasks, never future-task checks run early. All commands must be executable, not review criteria. start=false records a plan without executing it.',parameters:schemas.plan,
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
      const corrections=correctionPolicy(config.corrections);
      const fileApproved=fileIntent && plan.sourcePlan?.path===fileIntent.path && plan.sourcePlan.hash===fileIntent.hash;
      if(fileApproved && (hash!==fileIntent.snapshot || JSON.stringify(proposalRoutes)!==JSON.stringify(fileIntent.routes) || JSON.stringify(timeouts)!==JSON.stringify(fileIntent.timeouts) || JSON.stringify(corrections)!==JSON.stringify(fileIntent.corrections)))throw new Error('Workspace, routes or correction policy changed since the file execution request; refresh approval.');
      const priorRun=s.plan && !s.active && (s.reports||[]).length?{stage:s.stage,task:s.task,round:s.round,reports:s.reports.length}:null;
      s={...initialState(),enabled:true,plan,coverageWarnings,timeouts,routes:proposalRoutes,correctionPolicy:corrections,stage:'awaiting-approval',snapshot:hash,priorRun};approvalTurn=null;save();
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
      const baseline=snapshot(null),routes=proposalCheck(),timeouts=timeoutPolicy(config.timeouts),corrections=correctionPolicy(config.corrections);
      if(fileIntent && (document.path!==fileIntent.path || document.hash!==fileIntent.hash || baseline!==fileIntent.snapshot || JSON.stringify(routes)!==JSON.stringify(fileIntent.routes) || JSON.stringify(timeouts)!==JSON.stringify(fileIntent.timeouts) || JSON.stringify(corrections)!==JSON.stringify(fileIntent.corrections)))throw new Error('Plan, workspace, routes or correction policy changed since this execution request; a fresh user request is required.');
      fileIntent={path:document.path,hash:document.hash,snapshot:baseline,routes,timeouts,corrections};
      approvalTurn=null;
      return result(`Execution request accepted for ${document.path}. Read this authoritative plan, resolve genuine ambiguities if any, and call delivery_plan with planFile="${document.path}", preserving its task boundaries and constraints. Supply each task's executable tests in tasks[].checks and final release tests in top-level checks, never prose or future-task checks assigned early. Do not combine the entire plan into one task or expand scope. The unchanged requested document will execute without asking for approval again. No work has launched yet.\n\n${document.content}`,{sourcePlan:{path:document.path,hash:document.hash}});
    }
    if(!path) {
      if(s.stage!=='awaiting-approval')throw new Error('No pending plan to execute. Resubmit the corrected proposal with delivery_plan, obtain a fresh user approval for the accepted candidate, then call delivery_execute; old tool-call arguments are not authority.');
      if(!approvalTurn || approvalTurn.key!==planKey())throw new Error('A fresh user reply approving this pending plan is required; for an existing Markdown plan supply planFile');
    }
    await launchApproved();return result('Execution started. Use delivery_status for actual progress.');
  }});
  pi.registerTool({name:'delivery_resume',label:'Continue approved delivery',description:'Continue an already approved interrupted task within its existing scope; route/budget changes require explicit confirmation. When a configured correction bound is higher than a retained exhausted bound and cumulative coding time remains, delivery_resume can adopt it once after compact confirmation without a replacement plan. Final exhaustion returns inspect guidance and does not generate another plan automatically. Confirmed coding timeouts allow one bounded same-model continuation after runner closure. Legacy budget changes require user confirmation. For legacy multi-task check-order failures, provide taskChecks derived from the approved source plan; one confirmation covers check ordering plus any configured route/budget changes. Final checks and completed coder evidence are preserved. An exact known read-only preflight non-launch can be retried after confirmation without coder replay. Closed failed children are reconciled without restarting execution; their evidence and coding spend are retained. Closed transport failures retry twice on the same route within the remaining budget; other failures are not auto-retried.',parameters:schemas.resume || schemas.empty,async execute(_id,params,_signal,_update,c){ctx=c;if(!s.enabled)throw new Error('Activate delivery first');const message=await resumeOwned(params.taskChecks);return result(message || 'Recovery started. Use delivery_status for actual progress.');}});
  pi.registerTool({name:'delivery_status',label:'Delivery status',description:'Read actual delivery state, next action, configured versus bound routes and native worker evidence. Activity and transcript paths are not proof checks passed.',parameters:schemas.empty,async execute(){refreshConfig();return result(statusText(),{...structuredClone(s),nextAction:nextAction(),configuredRoutes:structuredClone(config.routes)});}});
  pi.registerTool({name:'delivery_configure',label:'Delivery model routes',description:'Inspect configured routes and available exact model IDs without running setup. Supply only routes the user explicitly wants changed. Shows a confirmation before saving; unchanged routes do not prompt. Preserves retained work. A pending plan is redisplayed on the new routes and needs fresh execution approval. Running or unresolved execution cannot be reconfigured.',parameters:schemas.configure || schemas.empty,async execute(_id,params={},_signal,_update,c){
    ctx=c;if(!root)root=d.repoRoot(ctx.cwd);refreshConfig();
    if(params.routes===undefined)return result(JSON.stringify({configuredRoutes:config.routes,availableModels:available(),nextAction:nextAction()},null,2));
    if(!params.routes || typeof params.routes!=='object' || Array.isArray(params.routes) || Object.keys(params.routes).some(r=>!ROLES.includes(r)))throw new Error('Supply only named delivery model routes.');
    const routes=validateRoutes({...config.routes,...params.routes},available());
    if(JSON.stringify(routes)===JSON.stringify(config.routes))return result('Requested routes are already configured. No setup or confirmation needed. '+nextAction().message);
    guardConfiguration();
    const baseline=JSON.stringify(config),identity=JSON.stringify(s);
    const changes=ROLES.filter(r=>routes[r]!==config.routes[r]).map(r=>`${r}: ${config.routes[r] || 'unset'} → ${routes[r]}`);
    if(!ctx.hasUI || !await ctx.ui.confirm('Change delivery model routes?',changes.join('\n')+'\nSelected providers receive project context. Retained work and evidence are preserved. This does not start execution.'))return result('Routes unchanged; route change was not confirmed.');
    refreshConfig();
    if(closed || JSON.stringify(config)!==baseline || JSON.stringify(s)!==identity)throw new Error('Delivery state or configuration changed during confirmation; no routes saved.');
    validateRoutes(routes,available());
    await saveConfiguration({...config,routes});
    return result('Routes saved; retained work preserved. '+nextAction().message);
  }});
  pi.registerTool({name:'delivery_steer',label:'Prioritize current verification',description:'Ask the currently running owned coder to prioritize its approved task checks and targeted fixes. Uses a fixed in-scope message; cannot change scope, model, tools, budget, or worker. Acceptance by the runner does not prove delivery to the worker.',parameters:schemas.empty,async execute(_id,_params,_signal,_update,c){
    ctx=c;
    if(!s.enabled || closed || !s.active?.id || s.active.stage!=='coder' || s.stage!=='coder')throw new Error('No running owned coder to steer. '+nextAction().message);
    const progress=d.runProgress(s.active);
    if(progress?.state!=='running')throw new Error('Native worker is not confirmed running; inspect delivery_status.');
    const message='Prioritize verification of the existing partial workspace using these approved current-task checks: '+JSON.stringify(checksForTask(s.plan,s.task))+'. Inspect only the context needed for failing checks, fix within the approved task, and rerun affected checks. Preserve completed work. Do not widen scope, skip reviews, change models or extend the deadline. If unable to finish, report exact remaining failures and command results.';
    const receipt=await d.rpc(pi.events,'steer',{id:s.active.id,message});
    return result('Verification steering request accepted by the runner. Delivery to the worker and execution of checks are not yet confirmed.',{receipt});
  }});
  pi.registerTool({name:'delivery_diff',label:'Delivery diff',description:'Read git status and diff in 40k-character pages; pass offset to continue. Pass commits=N for the last N commits with pinned revisions and subjects. Defaults to proposed committed range or working-tree changes.',parameters:schemas.diff || schemas.empty,async execute(_id,params={}){if(!s.enabled)throw new Error('Activate /delivery');const range=params.commits!==undefined?d.revisionRange(root,params.commits):s.plan?.reviewRange;const offset=params.offset ?? 0;if(!Number.isInteger(offset)||offset<0)throw new Error('Invalid diff offset');return result(d.diff(root,range,40000,offset),range || {});}});

  pi.registerCommand('delivery',{
    description:'Delivery: describe a task; setup, models, status, resume, off',
    getArgumentCompletions:prefix=>['setup','models','status','resume','off'].filter(x=>x.startsWith(prefix)).map(x=>({value:x,label:x})),
    async handler(args,c) {
      ctx=c;
      try {
        if(!root) root=d.repoRoot(ctx.cwd);
        config=d.loadConfig(d.configPath());
        const command=args.trim();
        if(command==='status') {display(statusText());return;}
        if(command==='models') {
          const rows=catalog(ctx.modelRegistry.getAll(),ctx.modelRegistry.getAvailable());
          const cli=['claude','codex','cursor-agent'].map(name=>({name,installed:(process.env.PATH||'').split(':').some(dir=>{try{accessSync(join(dir,name),constants.X_OK);return true;}catch{return false;}})}));
          display(JSON.stringify({models:rows,externalCli:cli,note:'Available means locally configured, not tested/qualified. External CLIs are discovery-only, not delivery execution routes. No inference was run.'},null,2));return;
        }
        if(command==='setup') {
          guardConfiguration();if(!ctx.hasUI){display('Run /delivery setup in interactive pi to select routes and approve provider access.');return;}
          const baseline=JSON.stringify(config),identity=JSON.stringify(s);
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
          refreshConfig();
          if(closed || JSON.stringify(config)!==baseline || JSON.stringify(s)!==identity)throw new Error('Delivery state or configuration changed during setup; no routes saved.');
          validateRoutes(next.routes,available());
          await saveConfiguration(next);
          display('Delivery setup saved. '+nextAction().message);return;
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
          const message=await resumeOwned();if(message)display(message);return;
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
      } catch(e) {
        if(e instanceof OwnedRunBusy) {display(e.message+'\n'+statusText());return;}
        display(`Delivery: ${e.message}`);ctx.ui.notify(e.message,'error');
      }
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
      // Legacy retained runs predate the native child identity fields. Restore only
      // the trusted single-child identity implied by the persisted execution stage;
      // malformed or unknown ownership remains fail-closed in ownedSupervisorReply.
      if(s.active && !Object.hasOwn(s.active,'agent') && !Object.hasOwn(s.active,'childIndex')) {
        const agent=AGENTS[s.active.stage];
        if(agent && s.active.id) {s.active.agent=agent;s.active.childIndex=0;}
      }
      if(saved?.active && saved.owner!==ctx.sessionManager.getSessionId()) {s.enabled=true;s.reason='Forked delivery run: return to owning session; no automatic replay';s.stage='blocked';}
      else if(!saved)s.enabled=config.repos.includes(root);
      if(s.enabled) {
        retainPreflightProof(entries);
        restrict();await selectPlanning();
        reconcileOrphanedRun();
        if(s.active) {s.stage='blocked';s.reason='Retained child requires /delivery resume reconciliation';}
        else if(!['planning','awaiting-approval','complete','blocked'].includes(s.stage)) {s.resumeStage=s.stage;s.stage='blocked';s.reason=['checks','review-checks','verification'].includes(s.resumeStage)?'Interrupted host verification; delivery_resume reruns approved checks':s.resumeStage==='coder'?'Interrupted coding round; delivery_resume continues it within the remaining approved budget':'Interrupted between stages; use delivery_resume to reconcile before further work';}
        else {try{validateRoutes(config.routes,available());}catch(e){s.reason=e.message;}}
      }
      save();
    }catch(e){ctx.ui.setStatus('delivery',`Delivery OFF · ${e.message}`);}
  });
  pi.on('input',async(e,c)=>{
    ctx=c;refreshConfig();
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
    return {systemPrompt:e.systemPrompt+'\n\nDELIVERY MODE ACTIVE. You are the planning/orchestration parent, never the implementer. Infer task intent from the user message AND conversation, not a command or keyword. During planning, ask the user concise questions in normal conversation whenever missing information materially affects scope, behavior, acceptance criteria or implementation choices. Read available repository context first; do not ask again about decisions already supplied. Ask one focused question at a time, offer concrete options when useful, and wait for the answer before finalizing the affected part of the plan. You may continue independent read-only investigation while waiting. Do not invent requirements or submit delivery_plan merely to avoid asking a question. A clarification answer is not approval to execute: incorporate it into the proposal, show the resolved plan, then obtain approval for that plan. Select relevant installed SPARK skills lazily: reviews use requesting-code-review/audit, bugs use debugging, new features use brainstorming/planning. UI work also uses available frontend/design/accessibility skills; pass selected skill paths and design requirements in task instructions. Do not invent missing skills. For review/validation requests, inspect delivery_diff (commits=N for recent commits), then call delivery_plan with mode=review: this starts reviewers automatically, with no coder or fixes. Do not ask for approval for the requested read-only review. Set start=false ONLY if the user asked for a plan without execution. Review criteria go in task.acceptance. For implementation, put each task\'s executable checks in tasks[].checks; top-level checks are FINAL release checks, run only after all tasks. Never assign a later task\'s test to an earlier task. Checks are commands, NEVER prose. Use checks=[] for static review and disclose tests not run. When the user explicitly requests execution of an existing Markdown plan, call delivery_execute with planFile even after reload; it adopts the file and returns instructions for deriving its tasks through delivery_plan. Preserve all task boundaries and global constraints. Do not demand prior registration or another approval for the same unchanged document. If unresolved scope/product decisions genuinely prevent execution, clarify rather than guess. Out-of-scope broken/external symlinks are coverage warnings, not reasons to demand repository repairs; do not follow or depend on their targets. For new changes, show a concise human-readable plan using delivery_plan with mode=implementation; wait for the user to agree in conversation, then CALL delivery_execute immediately. Do not merely promise to execute. Rejections, questions and requested revisions are not approval; clarify genuinely ambiguous intent. Never instruct the user to run /delivery approve or select a review mode. If a read-only review blocked because checks were invalid, prepare corrected executable checks and retry that review through delivery_plan. For a legacy multi-task implementation blocked by premature final checks, read delivery_status and the approved source plan, then call delivery_resume with taskChecks for every existing task. It corrects ordering after confirmation, preserves final gates and completed coding evidence, and resumes current-task checks and independent reviews without replaying the coder. Do not replace that implementation plan or increase retry limits. Read/search and delivery tools are available; parent shell/edit/write and direct child execution are blocked. The extension owns coder/reviewer execution. During a run, answer without changing scope. Coding timeouts have one bounded same-model continuation; do not request approval again for that already approved allowance. For retained interrupted work with an active/unresolved child or reserved continuation, use delivery_resume; never replace that owned child. Closed transport failures retry automatically at most twice on the same route, preserving partial work and budgets. Do not request another approval or route change for those retries. Other closed failed attempts are reconciled without automatic retry; inspect their native error and retained work before proposing further changes. A higher configured correction bound may be adopted once through delivery_resume confirmation when the retained round limit is exhausted and cumulative coding budget remains; preserve the task, routes, checks, reports and coding spend. When that final bound is exhausted, stop at delivery_status with inspect and wait for an explicit user decision; do not generate another corrective plan automatically. An exhausted non-round-limit failure still needs a new corrective plan, not repeated resume/approval calls. No saved Markdown file is required when retained task context exists. For supported recovery, changed routes/budgets require explicit confirmation while retaining partial work; never replace an active or unresolved child with delivery_plan. Budget warnings are not proof of a stalled provider; a quiet running tool must not be killed. Only delivery_status establishes completion; never claim unrun checks or blocked work passed.\nCurrent state: '+status()+'\nNext action: '+JSON.stringify(nextAction())+'\nUse delivery_configure without routes to inspect configuration and exact available model IDs. Only request setup for missing model configuration or an explicit user route change. For requested route changes, use delivery_configure with the selected exact IDs; it preserves work and shows a confirmation. Do not recommend model speed or capability from names alone. Use delivery_steer to prioritize approved checks in a running coder; direct subagent steer is blocked. A steering acknowledgment means the runner accepted the request, not that the worker received or acted on it. Read native transcript command results before claiming checks never ran, passed or failed; missing build artifacts and long gaps between tools do not establish those claims. A closed failed attempt needs a corrective proposal, not a new session. Follow the reported next action; repeating setup/resume/approval does not create a pending plan.'+(terminalCorrection()?'\n'+correctivePlanAction():'')};
  });
  function ownedSupervisorReply(input) {
    const active=s.active;
    if(!active?.id || !input?.replyTo || !active.agent || !Number.isInteger(active.childIndex))return false;
    // Native pi-subagents validates replyTo and recipient, while this extension binds
    // the no-prompt path to the request journaled for this exact owned child. Do not
    // infer ownership from reply prose or from the existence of another live child.
    return ctx?.sessionManager?.getBranch?.().some(entry=>{
      if(entry?.customType!=='subagent_supervisor_request')return false;
      const details=entry.details || entry.data || {};
      return (details.id===input.replyTo || details.requestId===input.replyTo)
        && details.runId===active.id
        && details.agent===active.agent
        && details.childIndex===active.childIndex;
    }) ?? false;
  }
  pi.on('tool_call',async(e,c)=>{
    if(s.enabled && e.toolName==='subagent_supervisor' && e.input?.action==='reply') {
      // An active owned worker may receive supervisor evidence/clarifications directly.
      // This is informational only: native request/recipient validation still applies,
      // and replies cannot authorize scope, model, budget, review or tool changes.
      return ownedSupervisorReply(e.input)?undefined:{block:true,reason:'Supervisor response requires an active owned worker'};
    }
    if(s.enabled && !parentToolAllowed(e.toolName,e.input)) {
      const reason=e.toolName==='subagent' && e.input?.action==='steer'?'Direct subagent steering is blocked. Use delivery_steer to prioritize the running owned coder\'s approved checks. No steering message was queued by this rejected call.':'Delivery mode: parent mutation/unmanaged delegation is blocked. No tool action was executed. Do not retry with a generic worker, different agent, cwd or async setting. Use delivery tools to continue; the extension owns dispatch on the configured model routes.';
      // Reject the action without ending the turn, so the planner can recover.
      return {block:true,reason:reason+'\nNext action: '+JSON.stringify(nextAction())};
    }
  });
  pi.on('user_bash',()=>s.enabled?{result:{output:'Delivery mode blocks shell shortcuts. Use /delivery off explicitly for manual work.',exitCode:1,cancelled:false,truncated:false}}:undefined);
  pi.on('session_before_tree',()=>s.enabled?{cancel:true}:undefined);
  pi.on('session_shutdown',()=>{closed=true;checking?.abort();});
  return {state:()=>structuredClone(s),settled:()=>job||Promise.resolve()};
}
