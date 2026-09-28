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
const REJECTION="Agent 'delivery-security' was given an implementation task, but its tool allowlist has no mutation-capable tools. Add bash, edit, write, or another mutation-capable tool to the agent, or use a read-only task/agent.";

export function proveNativePrelaunch(active,reason) {
  if(active?.id!==null || active?.dir!==null || active?.agent!=='delivery-security' || active?.stage!=='security' ||
    typeof active?.session!=='string' || typeof active?.nativeSession!=='string' ||
    !Number.isSafeInteger(active?.startedAt) || active.startedAt<=0 ||
    reason!==`Run fan-out: 1/64 used, 63 remaining\n${REJECTION}`)throw new Error('Native prelaunch refusal not proven; retain unknown worker and lock.');
  const root=realpathSync(join(agentDir(),'npm/node_modules/pi-subagents'));
  for(const [relative,expected] of Object.entries(SOURCES)) {
    const path=join(root,relative),actual=realpathSync(path),stat=statSync(actual);
    if(actual!==path || !stat.isFile() || stat.ctimeMs>active.startedAt || stat.mtimeMs>active.startedAt ||
      createHash('sha256').update(readFileSync(path)).digest('hex')!==expected)
      throw new Error('Native source identity or prelaunch chronology not proven; retain unknown worker and lock.');
  }
  return {kind:'native-prelaunch-refusal',agent:active.agent,session:active.session,nativeSession:active.nativeSession,startedAt:active.startedAt,reason,sourceHashes:SOURCES};
}
