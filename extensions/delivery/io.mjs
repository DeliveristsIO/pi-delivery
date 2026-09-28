import {readFileSync,writeFileSync,mkdirSync,renameSync,lstatSync,realpathSync,existsSync,unlinkSync,readlinkSync} from 'node:fs';
import {dirname,join,resolve,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {proveNativePrelaunch} from './prelaunch.mjs';
export const agentDir=()=>process.env.PI_CODING_AGENT_DIR || join(homedir(),'.pi','agent');
export const configPath=()=>join(agentDir(),'delivery.json');
export function jsonFile(path,max=4*1024*1024) {
  const st=lstatSync(path);if(st.isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
  if(!st.isFile() || st.size>max) throw new Error(`Invalid/oversized file: ${path}`);
  return JSON.parse(readFileSync(path,'utf8'));
}
export function loadConfig(path=configPath()) {
  if(!existsSync(path)) return {version:1,routes:{},repos:[]};
  const c=jsonFile(path,65536);
  if(c.version!==1 || !c.routes || !Array.isArray(c.repos) || !c.repos.every(p=>typeof p==='string')) throw new Error('Invalid delivery configuration');
  return c;
}
export function saveConfig(path,c) {
  mkdirSync(dirname(path),{recursive:true});
  try {if(lstatSync(path).isSymbolicLink())throw new Error('Refusing config symlink');} catch(e){if(e.code!=='ENOENT')throw e;}
  const temp=`${path}.${randomUUID()}.tmp`;
  try {writeFileSync(temp,JSON.stringify(c,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(temp,path);}
  finally {if(existsSync(temp)) unlinkSync(temp);}
}

function assertSafeFilters(root) {
  // Status/diff may run clean/process drivers even with optional locks disabled.
  // Query effective outer config (including includes) without invoking any driver.
  let filters='';
  try {filters=execFileSync('git',['-C',root,'config','--null','--name-only','--get-regexp','^filter\\..*\\.(clean|process)$'],{encoding:'utf8',timeout:15000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});}
  catch(error) {if(error.status!==1)throw error;}
  if(filters)throw new Error('Status inspection cannot safely run with configured Git filters; use history inspection or read source files directly.');
}
export function inspectRepository(root,view='status',offset=0) {
  if(!['status','history'].includes(view))throw new Error('Invalid inspection view; use status or history.');
  if(!Number.isSafeInteger(offset) || offset<0)throw new Error('Invalid inspection offset.');
  if(view==='status')assertSafeFilters(root);
  const args=view==='status'
    ? ['status','--short','--branch','--untracked-files=all','--ignore-submodules=all']
    : ['log','-20','--no-show-signature','--no-decorate','--format=%h %s'];
  const output=execFileSync('git',['--no-pager','--no-optional-locks','--no-replace-objects','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','core.quotePath=true','-C',root,...args],{encoding:'utf8',timeout:15000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});
  const page=output.slice(offset,offset+40000);
  return output.length>offset+40000 ? page+`\n[Inspection truncated at ${offset+40000} characters; read source files for remaining evidence.]` : page;
}

export function validateCommands(cwd,commands) {
  for(const command of commands) {
    const executable=command.match(/^\s*([A-Za-z0-9_./-]+)(?=\s|$)/)?.[1];
    try {
      if(!executable)throw new Error('Expected an executable first (use env for variable assignments)');
      execFileSync('/bin/bash',['--noprofile','--norc','-n'],{cwd,input:command,timeout:5000,stdio:['pipe','ignore','pipe']});
      execFileSync('/bin/bash',['--noprofile','--norc','-c','command -v -- "$1" >/dev/null','delivery-check',executable],{cwd,timeout:5000,stdio:'ignore'});
    }catch {throw new Error(`Not a runnable verification command: ${command}. Put review criteria in task.acceptance; checks must contain actual installed test commands, or [] for static review.`);}
  }
}
export function verifyCommand(cwd,command,signal,timeoutMs=120000) {
  return new Promise((resolve,reject)=>{
    const p=spawn('/bin/bash',['--noprofile','--norc','-c',command],{cwd,detached:true,stdio:['ignore','pipe','pipe']});
    let output='',terminated=false,terminationReason=null;
    const terminate=reason=>{terminated=true;terminationReason ||= reason;try{process.kill(-p.pid,'SIGKILL');}catch{}};
    const stop=()=>terminate('aborted');
    const timer=setTimeout(()=>terminate('timeout'),timeoutMs);
    signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    const collect=b=>{output=(output+b.toString()).slice(-40000);};p.stdout.on('data',collect);p.stderr.on('data',collect);
    p.on('error',e=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(e);});
    p.on('close',(code,sig)=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);resolve({command,code,signal:sig,terminated,terminationReason:terminationReason || (sig?'signal':null),processClosed:true,timeoutMs,output});});
  });
}
function git(root,args) {
  return execFileSync('git',['--no-pager','--no-optional-locks','--no-replace-objects','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-C',root,...args],{encoding:'utf8',timeout:15000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});
}
export function repoRoot(cwd) {return realpathSync(git(cwd,['rev-parse','--show-toplevel']).trim());}
const hash=value=>createHash('sha256').update(value).digest('hex');
export function snapshot(root) {
  // No status crawl before opaque boundaries have been identified.
  assertSafeFilters(root);
  const files=git(root,['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean);
  if(files.length>50000)throw new Error('Workspace exceeds 50000 files');
  const result=Object.create(null);let bytes=0;
  const index=git(root,['ls-files','--stage','-z']);
  result['.git/index']=hash(index);
  const gitlinks=new Set(index.split('\0').filter(entry=>entry.startsWith('160000 ')).map(entry=>entry.slice(entry.indexOf('\t')+1)));
  // Identity only, not contents/mtime: never enter a boundary or read its Git configuration.
  const opaque=(file,st)=>{result[file]='opaque-directory:'+hash(JSON.stringify([file,st.dev,st.ino,st.mode]));};
  try {result['.git/HEAD']=hash(git(root,['rev-parse','--verify','--quiet','HEAD']).trim());}
  catch(error){if(error.status!==1)throw error;result['.git/HEAD']='unborn';}
  entries: for(const entry of [...new Set(files)].sort()) {
    // ls-files emits untracked embedded repositories with '/', but cached gitlinks without it.
    const file=entry.endsWith('/')?entry.slice(0,-1):entry;
    if(isAbsolute(file) || file.split('/').some(part=>['','..','.'].includes(part)))throw new Error('Unsafe snapshot path');
    const path=resolve(root,file);let st;
    // Check ancestry before lstat/read so even a missing leaf cannot hide a symlink escape.
    let ancestor=root,relative='';
    for(const part of file.split('/').slice(0,-1)) {
      ancestor=join(ancestor,part);relative=relative?relative+'/'+part:part;
      if(result[relative]?.startsWith('opaque-directory:'))continue entries;
      let parent;
      try {parent=lstatSync(ancestor);if(parent.isSymbolicLink())throw new Error(`Symlink ancestor not supported: ${file}`);}
      catch(e){if(e.code!=='ENOENT')throw e;break;}
      // Outer tracked descendants can hide an embedded repo from ls-files' directory entries.
      try {
        const metadata=lstatSync(join(ancestor,'.git'));
        if(!metadata.isDirectory() && !metadata.isFile() && !metadata.isSymbolicLink())throw new Error(`Unsafe non-file Git boundary: ${relative}`);
        opaque(relative,parent);continue entries;
      }catch(e){if(e.code!=='ENOENT')throw e;}
    }
    try {st=lstatSync(path);}catch(e){if(e.code==='ENOENT'){result[file]=gitlinks.has(file)?'opaque-directory:missing':'deleted';continue;}throw e;}
    if(st.isSymbolicLink()){result[file]='symlink:'+hash(readlinkSync(path));continue;}
    if(st.isDirectory() && (entry.endsWith('/') || gitlinks.has(file))) {
      opaque(file,st);continue;
    }
    if(!st.isFile() || gitlinks.has(file))throw new Error(`Unsafe non-file entry or non-directory gitlink requires separate review: ${file}`);
    bytes+=st.size;if(bytes>256*1024*1024)throw new Error('Workspace exceeds 256 MiB');
    result[file]=hash(Buffer.concat([Buffer.from(String(st.mode)+':'),readFileSync(path)]));
  }
  return result;
}
export function workingTreeEvidence(root,current=snapshot(root)) {
  assertSafeFilters(root);
  const excluded=Object.keys(current).filter(path=>current[path].startsWith('opaque-directory:')).map(path=>`:(literal,exclude)${path}`);
  const status=git(root,['-c','core.quotePath=true','status','--short','--branch','--untracked-files=all','--ignore-submodules=all','--','.',...excluded]);
  let head=[];
  try {git(root,['rev-parse','--verify','--quiet','HEAD']);head=['HEAD'];}catch(error){if(error.status!==1)throw error;}
  const patch=git(root,['diff','--no-ext-diff','--no-textconv','--ignore-submodules=all',...head,'--','.',...excluded]);
  const text=`STATUS (includes untracked paths; read source only outside opaque boundaries):\n${status}\nTRACKED DIFF${excluded.length?' (opaque nested boundaries excluded; contents not reviewed)':''}:\n${patch}`;
  return text.slice(0,40000)+(text.length>40000?'\n[Diff clipped. Read the approved source files; do not infer a clean review from this preview.]':'');
}
const lockPath=root=>join(agentDir(),'delivery-locks',hash(realpathSync(root))+'.json');
const sameFence=(a,b)=>a?.fence===b.fence && (a?.fence===undefined || typeof a.fence==='string' && a.fence.length>0);
const sameOwner=(a,b)=>a?.session===b.session && a?.run===b.run && a?.pid===b.pid && sameFence(a,b);
const ownerText=owner=>`pid=${owner?.pid ?? 'unknown'} session=${owner?.session ?? 'unknown'} run=${owner?.run ?? 'unknown'} fence=${owner?.fence ?? 'legacy'}`;
function readLock(path) {try{return jsonFile(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function withLockGuard(path,operation) {
  const guard=path+'.guard';
  try {writeFileSync(guard,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});}
  catch(error){if(error.code==='EEXIST')throw new Error(`Lock operation guard exists; ownership/operation closure unknown. Inspect ${guard}; no automatic removal.`);throw error;}
  try {return operation();}finally{unlinkSync(guard);}
}
export function acquireLock(root,owner,{active,pendingCheck,rejectedLaunch}={}) {
  const path=lockPath(root);let retained;
  const diagnostic=error=>new Error(`Workspace delivery lock owned/stored ${ownerText(retained)}; current ${ownerText(owner)}. ${error.message} Inspect exact retained native evidence; no force unlock or replacement. Lock: ${path}`);
  function inspect() {
    retained=readLock(path);
    if(pendingCheck)throw new Error(`Host check closure is pending: ${pendingCheck}; cannot reconcile.`);
    if(!retained) {if(active)throw new Error('Retained worker lock is missing; ownership evidence unavailable.');return;}
    if(retained.session!==owner.session || retained.run!==owner.run)throw new Error('Foreign session/run ownership.');
    if(!sameFence(retained,owner))throw new Error('Stale or missing journal fence; inspect the latest retained state, not an earlier worker proof.');
    if(sameOwner(retained,owner))return;
    if(!Number.isSafeInteger(retained.pid) || retained.pid<=0)throw new Error('Previous owner process liveness is unknown (invalid pid).');
    try {process.kill(retained.pid,0);throw new Error('Previous owner process is alive.');}
    catch(error){if(error.code!=='ESRCH')throw new Error(`Previous owner process not proven dead: ${error.message}`);}
    if(rejectedLaunch) {
      const {active:reservation,reason,proof}=rejectedLaunch;
      if(reservation?.session!==owner.session || JSON.stringify(proveNativePrelaunch(reservation,reason))!==JSON.stringify(proof))
        throw new Error('Native prelaunch refusal binding is unverified.');
      return;
    }
    if(!active || active.session!==owner.session)throw new Error('Known retained native worker/session evidence is required.');
    if(!readNativeClosure(active))throw new Error(`Exact native worker ${active.id} in ${active.dir} (owner=${active.nativeSession}) is live or observed process-terminal.json closure is pending/unknown. A restart cannot supply the spawning parent's missing close observation.`);
  }
  try {
    // Inspect first, then revalidate under a short exclusive filesystem guard.
    inspect();const inspected=JSON.stringify(retained);mkdirSync(dirname(path),{recursive:true});
    return withLockGuard(path,()=>{
      if(JSON.stringify(readLock(path))!==inspected)throw new Error('Lock ownership changed since inspection; no reconciliation performed.');
      inspect();
      // Every acquisition fences earlier journal copies, including legacy records.
      // The coordinator reacquires before consuming a worker and advancing work.
      const next={...owner,fence:randomUUID()};
      if(!retained)writeFileSync(path,JSON.stringify(next),{flag:'wx',mode:0o600});
      else saveConfig(path,next);
      return next.fence;
    });
  }catch(error){throw diagnostic(error);}
}
// Inspection-only: a missing lock alone never establishes recovery authority.
export function assertNoLock(root) {
  if(readLock(lockPath(root)))throw new Error('A workspace lock still exists; closed reviewer adoption refuses unknown ownership.');
}
export function inspectLock(root,owner) {
  const retained=readLock(lockPath(root));
  if(!retained || retained.session!==owner.session || retained.run!==owner.run || !sameFence(retained,owner))throw new Error('Missing/foreign workspace lock or stale journal fence; recovery refused.');
  return retained;
}
export function releaseLock(root,owner) {
  const path=lockPath(root);
  return withLockGuard(path,()=>{
    const retained=readLock(path);
    if(!retained || !sameOwner(retained,owner))throw new Error(`Workspace lock ownership changed: stored ${ownerText(retained)}; current ${ownerText(owner)}. Inspect before continuing.`);
    unlinkSync(path);
  });
}
const terminalStates=['complete','failed','partial','stopped','paused','blocked','rejected'];
export function readNativeStatus(active) {
  if(typeof active?.id!=='string' || !active.id.trim() || typeof active.dir!=='string' || !isAbsolute(active.dir) || realpathSync(active.dir)!==active.dir)throw new Error('Native worker ID/directory identity is unverified');
  const status=jsonFile(join(active.dir,'status.json'));
  if(status.runId!==active.id)throw new Error('Native worker run-ID identity mismatch');
  if(typeof active.nativeSession!=='string' || !active.nativeSession.trim() || status.sessionId!==active.nativeSession)throw new Error('Native worker owner-session identity mismatch');
  return status;
}
export function readNativeClosure(active) {
  const status=readNativeStatus(active);
  if(!terminalStates.includes(status.state))return null;
  const path=join(active.dir,'process-terminal.json'),terminal=existsSync(path)?jsonFile(path):null;
  if(terminal && terminal.runId!==active.id)throw new Error('Native terminal proof identity mismatch; inspect subagent status.');
  if(!terminal || terminal.state==='pending' || terminal.state==='not-started')return null;
  const invalid=reason=>{throw new Error(`Native terminal proof ${reason}; inspect ${path}. No closure established.`);};
  // pi-subagents v1 authoritative sidecar (finalizeProcessTerminal), not status.state,
  // candidate records, PID death, or a child-step projection. In-runner children
  // legitimately produce runner-only instances; subprocess writers need tree proof.
  if(terminal.version!==1 || terminal.state!=='observed' || typeof terminal.runnerProcessInstanceId!=='string' || !terminal.runnerProcessInstanceId || !Number.isFinite(terminal.observedAt) || !Array.isArray(terminal.instances))invalid(`is malformed or unknown${terminal.reason?` (${terminal.reason})`:''}`);
  if(status.processTerminal?.runnerProcessInstanceId && status.processTerminal.runnerProcessInstanceId!==terminal.runnerProcessInstanceId)invalid('runner identity mismatch');
  const runners=terminal.instances.filter(i=>i?.kind==='runner');
  if(runners.length!==1 || runners[0].processInstanceId!==terminal.runnerProcessInstanceId)invalid('matching runner close is missing');
  const ids=new Set();
  for(const i of terminal.instances) {
    if(!i || typeof i.processInstanceId!=='string' || !i.processInstanceId || ids.has(i.processInstanceId) || !Number.isFinite(i.closeObservedAt) || !(i.exitCode===null || Number.isInteger(i.exitCode)) || !(i.signal===null || typeof i.signal==='string'))invalid('instance close is malformed');
    ids.add(i.processInstanceId);
    if(i.kind==='runner') {if(i.attempt!==undefined)invalid('runner instance is malformed');}
    else if(i.kind!=='pi-writer' || !Number.isInteger(i.attempt) || i.attempt<0 || i.processTree?.state!=='observed' || i.processTree.mechanism!=='posix-process-group' || !Number.isInteger(i.processTree.processGroupId) || i.processTree.processGroupId<=0 || !Number.isFinite(i.processTree.verifiedAt))invalid('writer process-tree closure is unknown or malformed');
  }
  return {status,terminal};
}
export function readOutcome(active) {
  const closure=readNativeClosure(active);
  if(!closure) {
    const status=readNativeStatus(active),endedAt=status.endedAt ?? status.lastUpdate ?? active.startedAt;
    if(terminalStates.includes(status.state) && Number.isFinite(endedAt) && Date.now()-endedAt>60000)throw new Error('Native terminal proof is still unavailable; inspect native artifacts. Resume only after closure evidence becomes available; no replacement launched.');
    return null;
  }
  const {status,terminal}=closure;
  if(status.state!=='complete' || terminal.instances.some(i=>i.exitCode!==0 || i.signal)) {
    const error=new Error(`Native worker ${active.id} ${status.state}: ${status.error || 'runner did not close successfully'}. Inspect native evidence; no retry launched.`);error.closed=true;error.nativeState=status.state;throw error;
  }
  const step=status.steps?.[0];
  if(status.steps?.length!==1 || step.agent!==active.agent || step.model!==active.model || !step.attemptedModels?.length || step.attemptedModels.some(model=>model!==active.model))throw new Error('Native worker agent/model evidence missing or differs from exact approved route');
  try {
    if(typeof step.structuredOutputPath!=='string' || !isAbsolute(step.structuredOutputPath))throw new Error('Native worker missing structured report');
    return jsonFile(step.structuredOutputPath,128000);
  }catch(error){error.code='DELIVERY_STRUCTURED_REPORT';error.closed=true;error.nativeState=status.state;throw error;}
}
