import {readFileSync,writeFileSync,mkdirSync,renameSync,lstatSync,realpathSync,existsSync,unlinkSync,readlinkSync} from 'node:fs';
import {dirname,join,resolve,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
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

export function inspectRepository(root,view='status',offset=0) {
  if(!['status','history'].includes(view))throw new Error('Invalid inspection view; use status or history.');
  if(!Number.isSafeInteger(offset) || offset<0)throw new Error('Invalid inspection offset.');
  if(view==='status') {
    // Status may run clean/process drivers even with optional locks disabled.
    // Query effective config (including includes) without invoking any driver.
    let filters='';
    try {filters=execFileSync('git',['-C',root,'config','--null','--name-only','--get-regexp','^filter\\..*\\.(clean|process)$'],{encoding:'utf8',timeout:15000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});}
    catch(error) {if(error.status!==1)throw error;}
    if(filters)throw new Error('Status inspection cannot safely run with configured Git filters; use history inspection or read source files directly.');
  }
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
  // Refuse filters before status/diff can execute repository-configured code.
  inspectRepository(root);
  const files=git(root,['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean);
  if(files.length>50000)throw new Error('Workspace exceeds 50000 files');
  const result=Object.create(null);let bytes=0;
  result['.git/index']=hash(git(root,['ls-files','--stage','-z']));
  try {result['.git/HEAD']=hash(git(root,['rev-parse','--verify','--quiet','HEAD']).trim());}
  catch(error){if(error.status!==1)throw error;result['.git/HEAD']='unborn';}
  for(const file of [...new Set(files)].sort()) {
    const path=resolve(root,file);let st;
    try {st=lstatSync(path);}catch(e){if(e.code==='ENOENT'){result[file]='deleted';continue;}throw e;}
    if(realpathSync(dirname(path))!==dirname(path))throw new Error(`Symlink ancestor not supported: ${file}`);
    if(st.isSymbolicLink()){result[file]='symlink:'+hash(readlinkSync(path));continue;}
    if(!st.isFile())throw new Error(`Nested repository or non-file entry requires separate review: ${file}`);
    bytes+=st.size;if(bytes>256*1024*1024)throw new Error('Workspace exceeds 256 MiB');
    result[file]=hash(Buffer.concat([Buffer.from(String(st.mode)+':'),readFileSync(path)]));
  }
  return result;
}
export function workingTreeEvidence(root) {
  const status=inspectRepository(root);
  let head=[];
  try {git(root,['rev-parse','--verify','--quiet','HEAD']);head=['HEAD'];}catch(error){if(error.status!==1)throw error;}
  const patch=git(root,['diff','--no-ext-diff','--no-textconv',...head,'--']);
  const text=`STATUS (includes untracked paths; read their source directly):\n${status}\nTRACKED DIFF:\n${patch}`;
  return text.slice(0,40000)+(text.length>40000?'\n[Diff clipped. Read the approved source files; do not infer a clean review from this preview.]':'');
}
const lockPath=root=>join(agentDir(),'delivery-locks',hash(root)+'.json');
export function acquireLock(root,owner) {
  const path=lockPath(root);mkdirSync(dirname(path),{recursive:true});
  try {writeFileSync(path,JSON.stringify(owner),{flag:'wx',mode:0o600});}
  catch(e) {
    if(e.code!=='EEXIST')throw e;
    const retained=jsonFile(path);
    if(retained.session!==owner.session || retained.run!==owner.run || retained.pid!==owner.pid)throw new Error(`Workspace delivery lock is owned by session ${retained.session}. Stop/inspect that native run first; never remove an unknown/live writer lock. Lock: ${path}`);
  }
}
export function releaseLock(root,owner) {
  const path=lockPath(root),retained=jsonFile(path);
  if(retained.session!==owner.session || retained.run!==owner.run || retained.pid!==owner.pid)throw new Error('Workspace lock ownership changed; inspect before continuing');
  unlinkSync(path);
}
export function readOutcome(active) {
  const status=jsonFile(join(active.dir,'status.json'));
  if(status.runId!==active.id || status.sessionId!==active.session)throw new Error('Native worker identity/session mismatch');
  if(!['complete','failed','partial','stopped','paused','blocked','rejected'].includes(status.state))return null;
  const path=join(active.dir,'process-terminal.json');
  const terminal=existsSync(path)?jsonFile(path):null;
  if(terminal && terminal.runId!==active.id)throw new Error('Native terminal proof identity mismatch; inspect subagent status.');
  if(!terminal || terminal.state!=='observed' || !terminal.instances?.length) {
    const endedAt=status.endedAt ?? status.lastUpdate ?? active.startedAt;
    if(Number.isFinite(endedAt) && Date.now()-endedAt>60000)throw new Error('Native terminal proof is still unavailable; inspect subagent status, then resume monitoring this worker. No replacement launched.');
    return null;
  }
  if(status.state!=='complete' || terminal.instances.some(i=>i.exitCode!==0 || i.signal)) {
    const error=new Error(`Native worker ${active.id} ${status.state}: ${status.error || 'runner did not close successfully'}. Inspect native subagent status; no retry launched.`);error.closed=true;throw error;
  }
  const step=status.steps?.[0];
  if(status.steps?.length!==1 || step.agent!==active.agent || step.model!==active.model || !step.attemptedModels?.length || step.attemptedModels.some(model=>model!==active.model))throw new Error('Native worker agent/model evidence missing or differs from exact approved route');
  if(typeof step.structuredOutputPath!=='string' || !isAbsolute(step.structuredOutputPath))throw new Error('Native worker missing structured report');
  return jsonFile(step.structuredOutputPath,128000);
}
