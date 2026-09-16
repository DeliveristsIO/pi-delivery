import {readFileSync,writeFileSync,mkdirSync,renameSync,lstatSync,realpathSync,existsSync,unlinkSync,readlinkSync,mkdtempSync} from 'node:fs';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {homedir,tmpdir} from 'node:os';
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
function git(root,args) {
  return execFileSync('git',['-c','core.fsmonitor=false','-C',root,...args],{encoding:'utf8',timeout:15000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});
}
export function repoRoot(cwd) {return realpathSync(git(cwd,['rev-parse','--show-toplevel']).trim());}
export function readPlan(root,path) {
  root=realpathSync(root);
  if(typeof path!=='string' || path.includes('\0'))throw new Error('Invalid plan path');
  const absolute=resolve(root,path),local=relative(root,absolute);
  if(!local.startsWith('docs/spark/plans/') || !local.endsWith('.md'))throw new Error('Plan must be a Markdown file under docs/spark/plans/');
  if(realpathSync(absolute)!==absolute)throw new Error('Plan path must not traverse symlinks');
  const st=lstatSync(absolute);
  if(!st.isFile() || st.size>256*1024)throw new Error('Invalid or oversized plan document');
  const content=readFileSync(absolute,'utf8');
  return {path:local,hash:createHash('sha256').update(content).digest('hex'),content};
}
export function fingerprint(root,{scope=[],commands=[],warnings=[]}={}) {
  root=realpathSync(root);
  const h=createHash('sha256');
  try {h.update(git(root,['rev-parse','HEAD']));} catch {h.update('unborn');}
  h.update(git(root,['status','--porcelain=v1','-z','--untracked-files=all']));
  const index=git(root,['ls-files','--stage','-z']);h.update(index);
  const gitlinks=new Set(index.split('\0').map(line=>line.match(/^160000 [a-f0-9]+ [0-3]\t([\s\S]+)$/)?.[1]).filter(Boolean));
  const required=f=>scope.some(path=>{const v=path.replace(/^\.\//,'').split(/[*?\[]/)[0].replace(/\/$/,'');return !v || v==='.' || v===f || v.startsWith(f+'/') || f.startsWith(v+'/');}) || commands.some(c=>c.split(/[\s"'`;|&()=]+/).some(v=>v===f || v.startsWith(f+'/') || v.endsWith('/'+f) || v.includes('/'+f+'/')));
  const files=[...new Set(git(root,['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean))].sort();
  if(files.length>50000) throw new Error('Workspace fingerprint exceeds 50000 files');
  let bytes=0;
  for(const f of files) {
    const p=resolve(root,f);
    h.update(f+'\0');
    if(gitlinks.has(f)) {
      if(required(f))throw new Error(`Required nested repository needs separate scope and verification: ${f}`);
      h.update('gitlink\0');warnings.push(`${f}: nested repository; index reference tracked, nested contents not covered. Do not use this dependency without separate verification.`);
      continue;
    }
    let st;
    try {st=lstatSync(p);} catch(e){if(e.code!=='ENOENT')throw e;h.update('deleted');continue;}
    let target;
    if(st.isSymbolicLink()) {
      const link=readlinkSync(p);
      h.update('symlink\0'+String(st.mode)+'\0'+link+'\0');
      let reason='';
      const outside=t=>{const r=relative(root,t);return isAbsolute(r)||r==='..'||r.startsWith('../');};
      // Do not inspect external targets. Record the link itself and disclose uncovered contents.
      if(outside(resolve(dirname(p),link)))reason='external target';
      else {
        try {target=realpathSync(p);if(outside(target))reason='external target';else if(!lstatSync(target).isFile())reason='non-file target';}
        catch {reason='unresolvable target';}
      }
      if(reason) {
        if(required(f))throw new Error(`Required workspace symlink has ${reason}: ${f}. Resolve this dependency or choose checks/scope that do not require it.`);
        h.update('opaque\0'+reason+'\0');
        warnings.push(`${f}: ${reason}; link identity tracked, target contents not covered. Do not use this dependency without resolving it.`);
        continue;
      }
      h.update(relative(root,target)+'\0');st=lstatSync(target);
    } else {
      target=realpathSync(p);
      if(target!==p)throw new Error(`Unsupported workspace symlink ancestor: ${f}`);
    }
    if(!st.isFile()) throw new Error(`Unsupported workspace entry: ${f}`);
    bytes+=st.size;if(bytes>256*1024*1024) throw new Error('Workspace fingerprint exceeds 256 MiB');
    h.update(String(st.mode));h.update(readFileSync(target));
  }
  return h.digest('hex');
}
export function revisionRange(root,count) {
  if(!Number.isInteger(count) || count<1 || count>20)throw new Error('Commit range must contain 1–20 commits');
  const head=git(root,['rev-parse','--verify','HEAD^{commit}']).trim();
  let base;
  try {base=git(root,['rev-parse','--verify',`HEAD~${count}^{commit}`]).trim();}
  catch {throw new Error('Not enough first-parent history for the requested commit range');}
  return {base,head};
}
export function assertCommittedWorkspace(root,range) {
  if(git(root,['rev-parse','HEAD']).trim()!==range.head)throw new Error('HEAD changed since commit selection');
  if(git(root,['diff','--no-ext-diff','--no-textconv','HEAD','--']).trim())throw new Error('Commit review requires tracked files to match HEAD; preserve edits and use a clean worktree or review working-tree changes instead.');
}
function pathspecs(paths) {
  if(paths===undefined)return [];
  if(!Array.isArray(paths) || paths.length===0 || paths.length>100)throw new Error('Invalid evidence paths');
  for(const path of paths) {
    if(typeof path!=='string' || !path || path.startsWith('/') || path.startsWith(':') || path.includes('\\') || path.includes('\0') || path.split('/').includes('..') || path.split('/').includes('.git'))throw new Error('Invalid evidence path');
  }
  return ['--',...paths];
}
export function workingTreeEvidence(root,paths) {
  const scope=pathspecs(paths);
  const status=git(root,['status','--short','--untracked-files=all',...scope]);
  const tracked=git(root,['diff','--no-ext-diff','HEAD',...scope]);
  const untracked=git(root,['ls-files','--others','--exclude-standard',...scope]);
  return `STATUS (scoped paths only):\n${status}TRACKED WORKING-TREE DIFF:\n${tracked}UNTRACKED PATHS (scoped; inspect contents with read):\n${untracked}`;
}
export function diff(root,range,limit=40000,offset=0,paths) {
  const scope=pathspecs(paths);
  const status=git(root,['status','--short',...scope]);
  if(range && ![range.base,range.head].every(ref=>/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref)))throw new Error('Expected pinned commit IDs');
  const body=git(root,['diff','--no-ext-diff','--no-textconv',...(range?[range.base,range.head]:['HEAD']),...scope]);
  const history=range?`COMMITTED RANGE ${range.base}..${range.head}\n${git(root,['log','--first-parent','-20','--format=%H %s',`${range.base}..${range.head}`])}\nUntracked files and working-tree edits are NOT part of this committed range.\n`:'';
  const value=`${history}STATUS (paths only; inspect untracked content only for a working-tree review):\n${status}\n${range?'COMMITTED':'TRACKED WORKING-TREE'} DIFF:\n${body}`;
  const slice=value.slice(offset,offset+limit);
  return value.length>offset+limit ? slice+`\n[Embedded diff truncated; inspect remaining approved files with repository-local git/read tools.]` : slice;
}
export function reviewPatch(root,range) {
  const dir=mkdtempSync(join(tmpdir(),'pi-delivery-review-'));
  const path=join(dir,'changes.diff');
  writeFileSync(path,diff(root,range,Infinity),{mode:0o600,flag:'wx'});
  return path;
}
export function isSettled(active) {
  if(!active?.dir || !active.id)return false;
  const path=join(active.dir,'process-terminal.json');
  if(!existsSync(path))return false;
  const t=jsonFile(path);
  return t.runId===active.id && t.state==='observed' && t.instances?.length>0;
}
// Missing files alone never prove that a writer has stopped. A host reboot does.
export function hostBootTime() {
  if(process.platform!=='linux')return null;
  try {
    const seconds=readFileSync('/proc/stat','utf8').match(/^btime (\d+)$/m)?.[1];
    return seconds?Number(seconds)*1000:null;
  } catch {return null;}
}
export function orphanedRunEvidence(active,bootedAt=hostBootTime()) {
  if(!active?.id || !active.dir)return null;
  try {lstatSync(join(active.dir,'status.json'));return null;}
  catch(e){if(e.code!=='ENOENT')throw e;}
  // Include a margin for the second-granularity boot timestamp. Do not infer
  // closure for same-boot cleanup, missing timestamps or future clock values.
  if(!Number.isFinite(bootedAt) || bootedAt<=0 || bootedAt>Date.now() ||
    !Number.isFinite(active.startedAt) || active.startedAt<=0 || active.startedAt>=bootedAt-60000)return null;
  return {kind:'host-reboot',bootedAt,startedAt:active.startedAt,missingPath:join(active.dir,'status.json')};
}
export function runProgress(active) {
  const s=jsonFile(join(active.dir,'status.json'));
  if(s.runId!==active.id)throw new Error('Run identity mismatch');
  const step=s.steps?.[0] || {};
  const terminal=['failed','partial','stopped','complete','paused','blocked'].includes(s.state);
  const end=s.endedAt ?? (terminal?s.lastUpdate:undefined);
  return {state:s.state==='partial'?'failed':s.state,nativeState:s.state,error:typeof s.error==='string'?s.error.slice(0,2000):undefined,model:step.model,attemptedModels:step.attemptedModels,
    timedOut:s.state==='failed' && (s.timedOut===true || step.timedOut===true || /^Subagent timed out after \d+ms\.$/.test(s.error || '')),
    timeoutMs:s.timeoutMs,deadlineAt:s.deadlineAt,startedAt:s.startedAt,
    durationMs:Number.isFinite(end)&&Number.isFinite(s.startedAt)?Math.max(0,end-s.startedAt):undefined,
    lastActivityAt:step.lastActivityAt ?? s.lastActivityAt,
    currentTool:step.currentTool || s.currentTool,
    sessionFiles:[step.sessionFile,step.transcriptPath].filter(p=>typeof p==='string' && isAbsolute(p) && !p.includes('\0'))};
}
export function readOutcome(active) {
  const s=jsonFile(join(active.dir,'status.json'));
  if(s.runId!==active.id) throw new Error('Run identity mismatch');
  if(['failed','partial','stopped','paused','blocked'].includes(s.state)) throw new Error(`Child ${active.id} ${s.state}; inspect /delivery status and subagent status`);
  if(s.state!=='complete') return null;
  const terminal=join(active.dir,'process-terminal.json');if(!existsSync(terminal)) return null;
  const t=jsonFile(terminal);
  if(t.runId!==active.id || t.state!=='observed') return null;
  if(!t.instances?.length || t.instances.some(i=>i.exitCode!==0 || i.signal)) throw new Error('Child runner did not close successfully');
  if(s.steps?.length!==1) throw new Error('Expected one owned child');
  const step=s.steps[0];
  if(step.model!==active.model || !Array.isArray(step.attemptedModels) || !step.attemptedModels.length || step.attemptedModels.some(m=>m!==active.model)) throw new Error('Child model evidence missing or differs from approved model');
  if(!step.structuredOutputPath) throw new Error('Child missing structured report');
  const report=jsonFile(step.structuredOutputPath,128000);
  // Attach runner-owned evidence, never a model-supplied claim about where logs live.
  report.executionEvidence={sessionFiles:[...new Set([step.sessionFile,step.transcriptPath].filter(p=>typeof p==='string' && p.length<4096 && !p.includes('\0') && isAbsolute(p)))]};
  return report;
}
// Catch checklist prose/malformed commands before accepting a plan. This is NOT a shell sandbox.
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
    let output='',terminated=false;
    const stop=()=>{terminated=true;try{process.kill(-p.pid,'SIGKILL');}catch{}};
    const timer=setTimeout(stop,timeoutMs);
    signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    const collect=b=>{output=(output+b.toString()).slice(-40000);};p.stdout.on('data',collect);p.stderr.on('data',collect);
    p.on('error',e=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(e);});
    p.on('close',(code,sig)=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);resolve({command,code,signal:sig,terminated,output});});
  });
}
