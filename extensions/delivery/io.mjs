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
  // `--` ends option parsing but does not disable Git pathspec magic. Prefix
  // every approved path with literal magic so names containing *, ? or [ can
  // never widen evidence or staging to another path.
  return ['--',...paths.map(path=>`:(literal)${path}`)];
}
const EVIDENCE_LIMIT=40000;
const evidenceRecovery=(paths)=>paths?.length
  ? `\n[Working-tree evidence preview truncated at ${EVIDENCE_LIMIT} characters. Continue with repository-local read tools and git diff --no-ext-diff -- ${paths.join(' ')}.]`
  : `\n[Working-tree evidence preview truncated at ${EVIDENCE_LIMIT} characters. Continue with repository-local read tools and git diff --no-ext-diff -- <path>.]`;
export function boundEvidence(value,paths,limit=EVIDENCE_LIMIT) {
  if(value.length<=limit)return value;
  const recovery=evidenceRecovery(paths);
  return value.slice(0,Math.max(0,limit-recovery.length))+recovery;
}
export function workingTreeEvidence(root,paths) {
  const scope=pathspecs(paths);
  const status=git(root,['status','--short','--untracked-files=all',...scope]);
  const tracked=git(root,['diff','--no-ext-diff','HEAD',...scope]);
  const untracked=git(root,['ls-files','-z','--others','--exclude-standard',...scope]).split('\0').filter(Boolean);
  const contents=untracked.map(path=>{
    const absolute=resolve(root,path);
    try {
      const st=lstatSync(absolute);
      if(!st.isFile() || st.isSymbolicLink())return `--- ${path} ---\n[non-regular untracked entry; inspect with repository-local read tools]`;
      // Keep individual reads bounded; the outer evidence bound supplies the
      // single child-safe continuation marker for the complete artifact.
      const bytes=readFileSync(absolute);const clipped=bytes.length>65536;
      return `--- ${path} ---\n${bytes.subarray(0,65536).toString('utf8')}${clipped?'\n[untracked file content preview clipped]':''}`;
    } catch(error) { return `--- ${path} ---\n[untracked content unavailable: ${error.message}]`; }
  }).join('\n');
  return boundEvidence(`STATUS (scoped paths only):\n${status}TRACKED WORKING-TREE DIFF:\n${tracked}UNTRACKED PATHS (scoped):\n${untracked.join('\n')}\nUNTRACKED FILE CONTENTS (scoped; included in this bounded artifact):\n${contents}`,paths);
}
const fiftyTwo=52;
export function normalizeSlug(title,max=fiftyTwo) {
  if(typeof title!=='string')throw new Error('Invalid branch title');
  const slug=title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').replace(/-+/g,'-').slice(0,max).replace(/-+$/g,'');
  if(!slug)throw new Error('Branch slug is empty; use a title containing letters or numbers');
  return slug;
}
export const CHANGE_TYPES=['feature','bug','chore'];
export function branchPlan(title,changeType) {
  if(!CHANGE_TYPES.includes(changeType))throw new Error('changeType must be feature, bug, or chore');
  const prefix=changeType+'/';const slug=normalizeSlug(title);return {prefix,slug,branch:prefix+slug};
}
export function firstFreeBranch(root,{prefix,slug}) {
  if(typeof prefix!=='string' || !prefix || typeof slug!=='string' || !slug)throw new Error('Invalid branch naming components');
  for(let suffix=1;suffix<=10000;suffix++) {
    const name=`${prefix}${slug}${suffix===1?'':`-${suffix}`}`;
    if(!branchExists(root,name))return name;
  }
  throw new Error('Unable to select a free delivery branch name.');
}
export function commitPlanMessage(changeType,title) {
  if(!CHANGE_TYPES.includes(changeType))throw new Error('changeType must be feature, bug, or chore');
  if(typeof title!=='string')throw new Error('Invalid commit summary');
  const summary=title.replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim();
  const message=`${changeType==='feature'?'feat':changeType}: ${summary}`;
  if(!summary || message.length>100 || /[\u0000-\u001f\u007f]/.test(message))throw new Error('Invalid commit message');
  return message;
}
function gitText(root,args) {return git(root,args).trim();}
export function defaultBranch(root) {
  try {const ref=gitText(root,['symbolic-ref','--quiet','refs/remotes/origin/HEAD']);if(ref.startsWith('refs/remotes/origin/'))return ref.slice('refs/remotes/origin/'.length);} catch {}
  for(const candidate of ['main','master']) {try {if(gitText(root,['show-ref','--verify',`refs/heads/${candidate}`]))return candidate;} catch {}}
  throw new Error('Cannot determine the default branch without network access; create or check out local main/master or configure origin/HEAD.');
}
export function branchState(root) {
  let branch;try {branch=gitText(root,['symbolic-ref','--quiet','--short','HEAD']);} catch {throw new Error('HEAD is detached or unavailable; check out a named branch before delivery.');}
  let head;try {head=gitText(root,['rev-parse','HEAD']);} catch {throw new Error('HEAD is unborn; create the initial repository history before delivery.');}
  const status=git(root,['status','--porcelain=v1','--untracked-files=all']);
  return {branch,head,defaultBranch:defaultBranch(root),clean:status.length===0,status};
}
export function lifecyclePreflight(root) {
  const state=branchState(root);
  if(!state.clean)throw new Error('Delivery requires a clean tracked and untracked worktree before proposal. Reviewed dirty work must use an explicitly authorized correctionAdoption plan; ordinary plans still require commit or stash. No automatic stash or baseline commit was created.');
  return state;
}
export function branchExists(root,name) {
  if(typeof name!=='string' || !name || name.startsWith('-') || name.includes('..') || name.includes('\\0') || name.includes('\0'))throw new Error('Invalid branch name');
  try {git(root,['show-ref','--verify','--quiet',`refs/heads/${name}`]);return true;} catch {return false;}
}
export function createDeliveryBranch(root,name,expectedHead) {
  const state=branchState(root);
  if(state.branch!==state.defaultBranch)throw new Error('Base branch changed before branch creation; refresh the delivery proposal.');
  if(state.head!==expectedHead)throw new Error('Base HEAD changed before branch creation; refresh the delivery proposal.');
  if(!state.clean)throw new Error('Worktree changed before branch creation; commit or stash changes first.');
  if(branchExists(root,name))throw new Error(`Delivery branch already exists: ${name}. No alternate branch was selected.`);
  execFileSync('git',['-c','core.fsmonitor=false','-C',root,'switch','--create',name],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
  return branchState(root);
}
function safePaths(paths) {
  if(!Array.isArray(paths)||!paths.length)throw new Error('Approved path set must not be empty');
  for(const p of paths)if(typeof p!=='string'||!p||p.startsWith(':')||p.startsWith('/')||p.includes('\\')||p.includes('\0')||p.split('/').includes('..')||p.split('/').includes('.git'))throw new Error('Invalid approved path');
  return [...new Set(paths)].sort();
}
function literalPathspecs(paths) {
  return paths.map(path=>`:(literal)${path}`);
}
const scopeBase=path=>path.replace(/\/+$/,'');
const inLiteralScope=(path,scope)=>path===scopeBase(scope) || path.startsWith(scopeBase(scope)+'/');
function assertNoSymlinkAncestor(root,path) {
  root=realpathSync(root);const parts=path.split('/');let current=root;
  for(let i=0;i<parts.length-1;i++) {
    current=join(current,parts[i]);
    try {if(lstatSync(current).isSymbolicLink())throw new Error(`Approved path has a symlink ancestor: ${path}`);}
    catch(error) {if(error.code==='ENOENT')return;throw error;}
  }
}
function approvedInventory(root,scopes,{rejectOutside=false}={}) {
  const expected=safePaths(scopes);for(const scope of expected)assertNoSymlinkAncestor(root,scopeBase(scope));
  const changed=changedPaths(root);for(const path of changed)assertNoSymlinkAncestor(root,path);
  const outside=changed.filter(path=>!expected.some(scope=>inLiteralScope(path,scope)));
  if(rejectOutside && outside.length)throw new Error(`Changed paths outside the approved task scope: ${outside.join(', ')}.`);
  return changed.filter(path=>expected.some(scope=>inLiteralScope(path,scope))).sort();
}
export function scopedContentFingerprint(root,paths) {
  const inventory=approvedInventory(root,paths);const h=createHash('sha256');
  h.update(git(root,['rev-parse','HEAD']).trim());
  h.update('\0'+git(root,['symbolic-ref','--quiet','--short','HEAD']).trim());
  for(const path of inventory) {
    const absolute=resolve(root,path);h.update('\0'+path+'\0');
    let st;try {st=lstatSync(absolute);} catch(error) {if(error.code==='ENOENT'){h.update('deleted\0');continue;}throw error;}
    if(st.isSymbolicLink()) {h.update('symlink\0'+readlinkSync(absolute)+'\0');continue;}
    if(!st.isFile())throw new Error(`Unsupported approved workspace entry: ${path}`);
    h.update('file\0'+readFileSync(absolute));
  }
  return h.digest('hex');
}
function canonicalDiff(body) {
  return body.replace(/^diff --git c\/(.*) i\/(.*)$/gm,'diff --git a/$1 b/$2').replace(/^--- c\//gm,'--- a/').replace(/^\+\+\+ i\//gm,'+++ b/');
}
export function stagedDiffHash(root) {
  const body=git(root,['diff','--cached','--no-ext-diff','--no-textconv','--no-renames','--binary','--full-index','--']);
  return createHash('sha256').update(canonicalDiff(body)).digest('hex');
}
export function commitDiffHash(root,commit,paths) {
  const args=['show','--format=','--no-ext-diff','--no-textconv','--no-renames','--binary','--full-index',commit];
  if(paths!==undefined)args.push('--',...literalPathspecs(paths));
  const body=git(root,args);
  return createHash('sha256').update(canonicalDiff(body)).digest('hex');
}
export function commitPaths(root,commit) {
  return git(root,['diff-tree','--no-commit-id','--name-only','--no-renames','-r','-z','--root',commit]).split('\0').filter(Boolean).sort();
}
export function changedPaths(root) {
  const fields=git(root,['status','--porcelain=v1','-z','--untracked-files=all']).split('\0');
  const result=[];
  for(let i=0;i<fields.length;i++) {
    const entry=fields[i];if(!entry)continue;
    const status=entry.slice(0,2),path=entry.slice(3);result.push(path);
    if(status.includes('R') || status.includes('C')) {const source=fields[++i];if(source)result.push(source);}
  }
  return [...new Set(result)].sort();
}
export function assertApprovedPaths(root,approved,{allowStaged=false}={}) {
  safePaths(approved);
  const staged=git(root,['diff','--cached','--name-only','-z','--no-renames']).split('\0').filter(Boolean).sort();
  if(staged.length && !allowStaged)throw new Error('Pre-staged changes are not accepted; unstage them before delivery execution.');
  return approvedInventory(root,approved,{rejectOutside:true});
}
export function correctionCandidate(root,approved,{allowStaged=true}={}) {
  const state=branchState(root);if(state.clean)throw new Error('Correction adoption requires an existing dirty candidate; use the ordinary clean-worktree lifecycle for new work.');
  const inventory=assertApprovedPaths(root,approved,{allowStaged:true});
  if(!inventory.length)throw new Error('Correction adoption requires at least one changed path in the approved correction scope.');
  for(const path of inventory) {
    const absolute=resolve(realpathSync(root),path);let st;
    try {st=lstatSync(absolute);} catch(error) {if(error.code==='ENOENT')continue;throw error;}
    if(st.isSymbolicLink())throw new Error(`Correction candidate path must not be a symlink: ${path}`);
    if(!st.isFile())throw new Error(`Unsupported correction candidate entry: ${path}`);
  }
  const staged=stagedPaths(root);
  if(!allowStaged && staged.length)throw new Error('Correction adoption does not accept staged paths for this operation.');
  const fingerprintValue=fingerprint(root,{scope:approved});
  return {version:1,branch:state.branch,head:state.head,defaultBranch:state.defaultBranch,clean:false,status:state.status,inventory,staged,fingerprint:fingerprintValue};
}
export function assertCorrectionCandidate(root,approved,expected) {
  if(!expected || expected.version!==1)throw new Error('Missing correction candidate binding.');
  const current=correctionCandidate(root,approved);
  for(const key of ['branch','head','defaultBranch','status','fingerprint'])if(current[key]!==expected[key])throw new Error(`Correction candidate ${key} changed; obtain a fresh explicit adoption.`);
  for(const key of ['inventory','staged'])if(JSON.stringify(current[key])!==JSON.stringify(expected[key]))throw new Error(`Correction candidate ${key} changed; obtain a fresh explicit adoption.`);
  return current;
}
export function createCorrectionBranch(root,name,approved,expected) {
  const current=assertCorrectionCandidate(root,approved,expected);
  if(current.branch!==current.defaultBranch)throw new Error('Correction branch creation requires the bound default branch; continue an existing non-default branch without switching.');
  if(branchExists(root,name))throw new Error(`Delivery branch already exists: ${name}. No alternate branch was selected.`);
  execFileSync('git',['-c','core.fsmonitor=false','-C',root,'switch','--create',name],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
  const after=branchState(root);
  if(after.branch!==name || after.head!==expected.head)throw new Error('Correction branch or HEAD changed during adoption.');
  const verified=correctionCandidate(root,approved);
  if(verified.head!==expected.head || verified.fingerprint!==expected.fingerprint || JSON.stringify(verified.inventory)!==JSON.stringify(expected.inventory) || JSON.stringify(verified.staged)!==JSON.stringify(expected.staged))throw new Error('Correction candidate changed during branch creation.');
  return after;
}
export function clearApprovedStagedPaths(root,approved) {
  const expected=safePaths(approved);
  const staged=git(root,['diff','--cached','--name-only','-z','--no-renames']).split('\0').filter(Boolean).sort();
  const outside=staged.filter(path=>!expected.some(scope=>inLiteralScope(path,scope)));
  if(outside.length)throw new Error(`Refusing to clear staged paths outside extension ownership: ${outside.join(', ')}.`);
  for(const path of staged)assertNoSymlinkAncestor(root,path);
  if(staged.length)execFileSync('git',['-c','core.fsmonitor=false','-C',root,'restore','--staged','--',...literalPathspecs(staged)],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
  return staged;
}
export function branchCommitState(root,expectedHead) {
  const state=branchState(root);if(expectedHead && state.head!==expectedHead)throw new Error('Branch HEAD changed outside delivery orchestration.');return state;
}
function stagedPaths(root) {
  return git(root,['diff','--cached','--name-only','-z','--no-renames']).split('\0').filter(Boolean).sort();
}
function commitOwnershipError(message) {const error=new Error(message);error.commitOwnershipInvalid=true;return error;}
function assertPreparedAuthorization(root,state,authorization) {
  const current=branchState(root);
  if(current.branch!==state.branch || current.head!==state.head)throw commitOwnershipError('Delivery branch or HEAD changed after staged-content authorization; no commit was attempted.');
  const invalidate=message=>{const error=new Error(message);error.commitAuthorizationInvalid=true;throw error;};
  if(scopedContentFingerprint(root,authorization.paths)!==authorization.snapshot)invalidate('Approved content changed after staged-content authorization. Re-run checks and reviews.');
  const staged=stagedPaths(root);
  if(JSON.stringify(staged)!==JSON.stringify(authorization.paths) || stagedDiffHash(root)!==authorization.diffHash)invalidate('Approved staged content changed after staged-content authorization. Re-run checks and reviews.');
}
export function commitApprovedTask(root,{changeType,title,files,expectedHead,snapshot,scope=[],allowStaged=false,expectedAuthorization,onPrepared,onBeforeStage}) {
  const state=branchCommitState(root,expectedHead);
  let paths;
  try {paths=assertApprovedPaths(root,files,{allowStaged});}
  catch(error) {
    if(expectedAuthorization) {error.commitAuthorizationInvalid=true;error.message='Approved staged content changed after commit failure; commit resume authority was invalidated. Re-run checks and reviews.';}
    throw error;
  }
  const existing=stagedPaths(root);
  if(existing.length && JSON.stringify(existing)!==JSON.stringify([...paths].sort())) {
    const error=new Error(expectedAuthorization?'Approved staged content changed after commit failure; commit resume authority was invalidated.':'Existing staged paths differ from the approved task scope.');
    if(expectedAuthorization)error.commitAuthorizationInvalid=true;throw error;
  }
  if(!paths.length)throw new Error('Cannot create an empty delivery commit.');
  const message=commitPlanMessage(changeType,title);
  const reviewedSnapshot=scopedContentFingerprint(root,paths);
  const rejectSnapshot=()=>{const error=new Error('Reviewed task snapshot changed before delivery staging; commit authorization was invalidated. Re-run checks and reviews.');error.commitAuthorizationInvalid=true;throw error;};
  if(reviewedSnapshot!==snapshot)rejectSnapshot();
  // Test/runtime seam is invoked only after outer path validation and before
  // staging, so a concurrent mutation cannot be mistaken for reviewed content.
  onBeforeStage?.();
  if(scopedContentFingerprint(root,paths)!==snapshot)rejectSnapshot();
  if(!existing.length)execFileSync('git',['-c','core.fsmonitor=false','-C',root,'add','--',...literalPathspecs(paths)],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
  if(scopedContentFingerprint(root,paths)!==snapshot)rejectSnapshot();
  const staged=stagedPaths(root);
  if(JSON.stringify(staged)!==JSON.stringify([...paths].sort())) {
    const error=new Error(expectedAuthorization?'Approved staged content changed after commit failure; commit resume authority was invalidated.':'Staged paths differ from the reviewed accepted path set.');
    if(expectedAuthorization)error.commitAuthorizationInvalid=true;throw error;
  }
  try {execFileSync('git',['-c','core.fsmonitor=false','-C',root,'diff','--cached','--check'],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});}
  catch {const error=new Error('Staged delivery diff failed whitespace checks.');if(expectedAuthorization)error.commitAuthorizationInvalid=true;throw error;}
  const authorization={branch:state.branch,head:state.head,paths, snapshot, diffHash:stagedDiffHash(root)};
  if(expectedAuthorization) {
    if(JSON.stringify(expectedAuthorization.paths)!==JSON.stringify(authorization.paths) || expectedAuthorization.branch!==authorization.branch || expectedAuthorization.head!==authorization.head || expectedAuthorization.snapshot!==authorization.snapshot || expectedAuthorization.diffHash!==authorization.diffHash) {
      const error=new Error('Approved staged content changed after commit failure; commit resume authority was invalidated. Re-run checks and reviews.');
      error.commitAuthorizationInvalid=true;throw error;
    }
  }
  onPrepared?.(structuredClone(authorization));
  // The authorization callback and ordinary local concurrency are both race
  // boundaries. Revalidate ownership, accepted content and exact staged bytes
  // immediately before invoking Git.
  assertPreparedAuthorization(root,state,authorization);
  try {execFileSync('git',['-c','core.fsmonitor=false','-C',root,'commit','-m',message],{encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});}
  catch(error) {
    const wrapped=new Error(`Git commit failed: ${error.message}`);wrapped.commitAuthorization=authorization;throw wrapped;
  }
  const next=branchState(root);
  if(next.branch!==state.branch) {const error=new Error('Delivery branch changed while committing; the resulting commit was not adopted.');error.commitCompleted=true;throw error;}
  if(next.head===state.head) {const error=new Error('Delivery commit did not leave HEAD advanced; the resulting commit was not adopted.');error.commitCompleted=true;throw error;}
  const lineage=gitText(root,['--no-replace-objects','rev-list','--parents','-n','1',next.head]).split(/\s+/);
  if(lineage.length!==2 || lineage[0]!==next.head || lineage[1]!==state.head) {const error=new Error('Delivery commit parent does not match the authorized HEAD; the resulting commit was not adopted.');error.commitCompleted=true;throw error;}
  // A successful Git command is not enough: post-commit hooks may have
  // amended the commit. Compare the committed diff before recording lifecycle
  // authority, and never adopt a hash whose tree differs from what was staged.
  const committedPaths=commitPaths(root,next.head);
  const committedDiffHash=commitDiffHash(root,next.head);
  if(JSON.stringify(committedPaths)!==JSON.stringify(authorization.paths) || committedDiffHash!==authorization.diffHash) {
    const error=new Error('Successful delivery commit differs from the accepted staged content or path set; commit was not adopted.');
    error.commitCompleted=true;throw error;
  }
  if(!next.clean) {
    const error=new Error('Delivery commit left a dirty worktree; commit was not adopted.');
    error.commitCompleted=true;throw error;
  }
  return {hash:next.head,message,branch:next.branch,baseHead:state.head,paths,snapshot,acceptedSnapshot:authorization.snapshot,acceptedDiffHash:authorization.diffHash,acceptedPaths:authorization.paths};
}
export function commitRecord(root,{changeType,title,files,expectedHead}) {
  const state=branchCommitState(root,expectedHead);const paths=assertApprovedPaths(root,files);const message=commitPlanMessage(changeType,title);
  return {branch:state.branch,baseHead:state.head,expectedHead:state.head,paths,message};
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
