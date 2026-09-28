import {assertUnchanged,validateReport} from './policy.mjs';
import {snapshotId} from './evidence.mjs';
import {isAbsolute} from 'node:path';

const MISSING_TOOL='Missing structured_output call; this step has outputSchema and must finish by calling structured_output.';
export function closedReviewerOutputFailure(native,closure) {
  const fail=()=>{throw new Error('Closed reviewer output failure not eligible for evidence-only recovery');};
  const {status,terminal}=closure || {},step=status?.steps?.[0],diagnostic=step?.effects?.settlementDiagnostic;
  if(!['quality','security'].includes(native?.stage) || native.agent!==({quality:'delivery-reviewer',security:'delivery-security'})[native.stage] ||
    !native.id || status?.runId!==native.id || status.sessionId!==native.nativeSession || status.state!=='failed' ||
    status.steps?.length!==1 || step.agent!==native.agent || step.model!==native.model ||
    !step.attemptedModels?.length || step.attemptedModels.some(model=>model!==native.model) ||
    !status.error?.startsWith(MISSING_TOOL) || step.error!==status.error ||
    diagnostic?.requiredOutput?.kind!=='structured' || diagnostic.requiredOutput.missing!==true ||
    diagnostic.requiredOutput.path!==step.structuredOutputPath || !isAbsolute(step.structuredOutputPath) ||
    diagnostic.mutation?.attempted!==false || diagnostic.mutation?.observed!==false ||
    terminal?.state!=='observed' || terminal.runId!==native.id || terminal.instances?.length!==1 ||
    terminal.instances[0].kind!=='runner' || terminal.instances[0].exitCode!==0 || terminal.instances[0].signal!==null)fail();
  return {reason:'review_report_invalid',closure:terminal};
}

export function assertRecovery(state,{root,session,nativeSession,snapshot,routes,readNativeClosure,inspectLock,owner},maxCorrections=2) {
  if(state.recoveryInvalidated)throw new Error('Unmanaged handoff invalidated recovery. Files and receipts preserved; a newly approved plan is required for managed work.');
  if(state.recoveryVersion!==1 || !state.checkpoint || !state.failure)throw new Error('Recovery proof absent: typed failure/checkpoint unavailable (old journals are not upgraded). Do not repeat recovery or resume. For user-requested continuation, use delivery_plan with remaining work against current source and revised acceptance; settled ownership and fresh approval are required. Prior results are not inherited approvals.');
  if(state.root!==root || state.session!==session || !state.run)throw new Error('Recovery repository/session/run mismatch');
  if(state.active || state.pendingCheck || state.stopping || !['blocked','awaiting-recovery-approval','recovering'].includes(state.stage))throw new Error('Recovery requires a closed block without active/unknown worker, pending check or stop request');
  if(state.plan.mode!=='implementation' || state.round>maxCorrections ||
    (state.round===maxCorrections && !(state.failure.reason==='review_report_invalid' && ['quality','security'].includes(state.failure.native?.stage))))
    throw new Error('Recovery cannot bypass review-only authority or exhausted correction budget');
  const {checkpoint:cp,failure}=state,source=snapshotId(state.snapshot);
  if(!['evidence_unavailable','review_report_invalid'].includes(failure.reason))throw new Error('Failure classification is not recoverable');
  if(cp.task!==state.task || cp.round!==state.round || cp.source!==source || failure.checkpointId!==cp.id || failure.source!==source)throw new Error('Recovery checkpoint task/round/source identity mismatch');
  assertUnchanged(state.snapshot,snapshot);
  if(JSON.stringify(state.routes)!==JSON.stringify(routes))throw new Error('Recovery exact routes changed; no substitution');
  if((state.recoveryAttempts || []).some(a=>a.task===state.task && a.source===source && a.count>=1))throw new Error('Evidence recovery attempt limit (1 per task/source) exhausted');
  const coder=state.reports.find(r=>r.task===cp.task && r.round===cp.round && r.stage==='coder' && r.native.id===cp.coder);
  if(!coder || validateReport(coder.report).status!=='approved')throw new Error('Retained successful coder report missing');
  const checks=state.checks.filter(c=>c.task===cp.task && c.round===cp.round);
  if(JSON.stringify(checks)!==JSON.stringify(cp.checks) || JSON.stringify(checks.map(c=>c.command))!==JSON.stringify(state.plan.tasks[state.task].checks) || checks.some(c=>c.code!==0 || !c.processClosed || c.signal || c.terminated))throw new Error('Successful same-source task-check receipts missing');
  const native=failure.native;
  if(!native?.id || native.session!==session || native.nativeSession!==nativeSession || native.model!==state.routes[native.stage==='verifier'?'coder':native.stage])throw new Error('Recovery native worker/session/route identity mismatch');
  const closure=readNativeClosure(native);
  if(!closure || !failure.closure || JSON.stringify(closure.terminal)!==JSON.stringify(failure.closure))throw new Error('Recovery native process-tree closure missing or changed');
  const step=closure.status.steps?.[0];
  const failedReviewer=failure.reason==='review_report_invalid' && closure.status.state==='failed';
  if(failedReviewer)closedReviewerOutputFailure(native,closure);
  else if(closure.status.state!=='complete' || closure.terminal.instances.some(i=>i.exitCode!==0 || i.signal))throw new Error('Recovery exact native completion/model evidence invalid');
  if(closure.status.steps?.length!==1 || step.agent!==native.agent || step.model!==native.model || !step.attemptedModels?.length || step.attemptedModels.some(m=>m!==native.model))throw new Error('Recovery exact native completion/model evidence invalid');
  if(!state.leased || !state.lockFence)throw new Error('Recovery retained lease/fence missing');
  inspectLock(root,owner);
  return cp;
}
