import {readFileSync,statSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
const agentDir=()=>process.env.PI_CODING_AGENT_DIR || join(homedir(),'.pi','agent');

// Pinned native sources whose single-worker implementation contract returns
// this error before the async runner/status path. Unknown versions fail closed.
const SOURCES={
  'src/runs/background/async-execution.ts':'f9af56c064fbfa70813e0b20b49179a305321a0da83c74edfcbb7ba5e54722f1',
  'src/runs/shared/completion-guard.ts':'e247f285b7f6fcf98e314a4851842df3d96f1ff830ceac469cae012445ed64a5',
  'src/extension/rpc.ts':'7c4c12d44ab8b6486f091cb003da02eb18dff0768991f86a8f42d79189926035'
};
// Pinned native sources where an RPC spawn creates the run fan-out budget
// directory (createRunFanoutBudget) before executeAsyncSingle and before any
// runner process is spawned; a filesystem error there is returned verbatim as
// the RPC error and nothing was started. Unknown versions fail closed.
const BUDGET_SOURCES={
  ...SOURCES,
  'src/runs/foreground/subagent-executor.ts':'b45e0be64c69df71e6b974a46f3e5153aa5d0bf5e8fed06474a374d6f841628b',
  'src/runs/shared/run-fanout-budget.ts':'430d9ca20c8d9bb7dac15fde9d4caeba9cd27e6ba6731c7a1e40a6daa2a1fb00'
};
const REJECTION="Agent 'delivery-security' was given an implementation task, but its tool allowlist has no mutation-capable tools. Add bash, edit, write, or another mutation-capable tool to the agent, or use a read-only task/agent.";
const AGENT_STAGES={'delivery-coder':'coder','delivery-reviewer':'quality','delivery-security':'security','delivery-verifier':['verifier','probe']};
// fs error from the two recursive mkdirSync calls in createRunFanoutBudget:
// the budget root, or `<safeRunId>-<uuid>/claims`. Runtimes differ in which
// path a recursive mkdir reports (Node: the requested `.../claims`; Pi's
// bundled runtime was observed reporting the failing `<safeRunId>-<uuid>`),
// so exactly those shapes are accepted. Admission locks, claim slot files,
// wrapped messages and any other path are not this pre-spawn code path.
const UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BUDGET_FS_ERROR=new RegExp(`^(ENOSPC|EDQUOT|ENFILE|EMFILE|EROFS|EACCES|EPERM|EIO): [^\\n']{1,200}, mkdir '(\\/[^\\n']{1,1024}\\/run-fanout-budgets(?:\\/[A-Za-z0-9._-]{1,120}-${UUID}(?:\\/claims)?)?)'$`);

function baseReservation(active) {
  return active?.id===null && active?.dir===null && typeof active?.session==='string' && typeof active?.nativeSession==='string' &&
    Number.isSafeInteger(active?.startedAt) && active.startedAt>0;
}
function verifySources(sources,startedAt) {
  const root=realpathSync(join(agentDir(),'npm/node_modules/pi-subagents'));
  for(const [relative,expected] of Object.entries(sources)) {
    const path=join(root,relative),actual=realpathSync(path),stat=statSync(actual);
    if(actual!==path || !stat.isFile() || stat.ctimeMs>startedAt || stat.mtimeMs>startedAt ||
      createHash('sha256').update(readFileSync(path)).digest('hex')!==expected)
      throw new Error('Native source identity or prelaunch chronology not proven; retain unknown worker and lock.');
  }
}
// The journal stores the RPC failure wrapped with the exact reserved request id.
function launchError(active,reason) {
  const prefix=`Native launch request ${active.launchRequestId} failed; worker identity remains unknown. `;
  return typeof active.launchRequestId==='string' && active.launchRequestId && typeof reason==='string' && reason.startsWith(prefix)?reason.slice(prefix.length):null;
}

export function proveNativePrelaunch(active,reason) {
  if(baseReservation(active) && active.agent==='delivery-security' && active.stage==='security' &&
    reason===`Run fan-out: 1/64 used, 63 remaining\n${REJECTION}`) {
    verifySources(SOURCES,active.startedAt);
    return {kind:'native-prelaunch-refusal',agent:active.agent,session:active.session,nativeSession:active.nativeSession,startedAt:active.startedAt,reason,sourceHashes:SOURCES};
  }
  const stages=AGENT_STAGES[active?.agent],error=baseReservation(active)?launchError(active,reason):null,match=error?.match(BUDGET_FS_ERROR);
  if(!match || ![stages].flat().includes(active.stage))throw new Error('Native prelaunch refusal not proven; retain unknown worker and lock.');
  verifySources(BUDGET_SOURCES,active.startedAt);
  return {kind:'native-prelaunch-budget-fs-error',agent:active.agent,stage:active.stage,session:active.session,nativeSession:active.nativeSession,startedAt:active.startedAt,launchRequestId:active.launchRequestId,code:match[1],path:match[2],reason,sourceHashes:BUDGET_SOURCES};
}
