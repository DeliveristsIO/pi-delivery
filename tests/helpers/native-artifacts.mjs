// pi-subagents 0.67.0 finalizeProcessTerminal: children execute in the runner;
// expectedWriters={0:0} legitimately produces a runner-only observed sidecar.
export function terminalProof(runId='native',patch={}) {
 return {version:1,runId,runnerProcessInstanceId:'runner-instance',state:'observed',observedAt:100,
  instances:[{kind:'runner',processInstanceId:'runner-instance',closeObservedAt:100,exitCode:0,signal:null}],...patch};
}
