// Bounded preflight relocation, not deletion or Git ownership adoption.
// The controller supplies native user confirmation; this module never infers consent.
import {lstatSync,realpathSync,readdirSync,readFileSync,openSync,closeSync,fsyncSync,fstatSync,writeFileSync,mkdirSync,renameSync,constants} from 'node:fs';
import {dirname,join,resolve,parse} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const under=(path,base)=>path===base || path.startsWith(base+'/');
const protectedNames=new Set(['.git','.gitignore','.gitattributes','.gitmodules','.mailmap','.pi','.spark']);
function git(root,args) {
  // Ignore inherited Git redirection/config injection. No shell, hooks, filters,
  // external diffs, index writes, pager, fsmonitor or aliases are needed here.
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
  return execFileSync('git',['--no-pager','--no-optional-locks','--no-replace-objects','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-C',root,...args],{env,encoding:'utf8',timeout:15000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});
}
function noLinks(path) {
  const absolute=resolve(path);let current=parse(absolute).root;
  for(const part of absolute.slice(current.length).split('/').filter(Boolean)) {
    current=join(current,part);
    if(lstatSync(current).isSymbolicLink())throw new Error(`Cleanup refuses symlink paths or ancestors: ${current}`);
  }
  if(realpathSync(absolute)!==absolute)throw new Error('Cleanup path is not canonical');
  return absolute;
}
function statIdentity(path) {const st=lstatSync(path);return {dev:st.dev,ino:st.ino,mode:st.mode};}
function present(path) {try{lstatSync(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function exactPaths(paths) {
  if(!Array.isArray(paths) || !paths.length || paths.length>20)throw new Error('Cleanup requires 1–20 exact relative paths');
  for(const p of paths) {
    if(typeof p!=='string' || p.length>512 || !p || /[\\:*?\[\]\x00-\x1f\x7f]/.test(p) || p.split('/').some(part=>!part || part==='.' || part==='..' || protectedNames.has(part.toLowerCase())))throw new Error('Cleanup refuses root, traversal, glob or repository metadata paths');
  }
  const ordered=[...paths].sort();
  if(ordered.some((p,i)=>ordered.some((q,j)=>i!==j && under(p,q))))throw new Error('Cleanup refuses overlapping inventories');
  return ordered;
}
function repository(root) {
  noLinks(root);
  // Conservatively support ordinary worktrees only. Linked/separate Git dirs,
  // common dirs and nested worktrees are never relocation candidates.
  const dot=join(root,'.git');
  if(!lstatSync(dot).isDirectory() || lstatSync(dot).isSymbolicLink())throw new Error('Cleanup requires an ordinary repository; linked/separate Git metadata is protected');
  if(git(root,['rev-parse','--show-toplevel']).trim()!==root || resolve(root,git(root,['rev-parse','--git-dir']).trim())!==dot || resolve(root,git(root,['rev-parse','--git-common-dir']).trim())!==dot)throw new Error('Cleanup refuses redirected repository metadata');
  for(let p=dirname(root);;p=dirname(p)) {
    if(present(join(p,'.git')) || (present(join(p,'HEAD')) && present(join(p,'objects'))))throw new Error('Cleanup refuses a nested repository');
    if(p===dirname(p))break;
  }
  let filters='';
  try {filters=git(root,['config','--null','--name-only','--get-regexp','^filter\\..*\\.(clean|process)$']);}catch(e){if(e.status!==1)throw e;}
  if(filters)throw new Error('Cleanup inspection refuses configured Git clean/process filters');
  const index=git(root,['ls-files','--stage','-z']);
  const tracked=[...new Set([...index.split('\0').filter(Boolean).map(v=>v.slice(v.indexOf('\t')+1)),...git(root,['ls-tree','-r','--name-only','-z','HEAD']).split('\0').filter(Boolean)])].sort();
  const status=git(root,['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=all']);
  // Tracked/staged dirt is not a cleanup problem. Refusing it also avoids
  // confusing status rename records with untracked inventory entries.
  if(status.split('\0').filter(Boolean).some(line=>!line.startsWith('?? ')))throw new Error('Cleanup refuses tracked or staged changes; preserve existing dirty-work ownership');
  return {identity:statIdentity(root),metadata:statIdentity(dot),parent:statIdentity(dirname(root)),head:git(root,['rev-parse','--verify','HEAD']).trim(),branch:git(root,['symbolic-ref','--quiet','HEAD']).trim(),index,tracked,status:status.split('\0').filter(Boolean).map(v=>v.slice(3)).sort()};
}
function inventory(root,paths,repo) {
  const entries=[];let bytes=0;
  function visit(path) {
    exactPaths([path]);const full=join(root,path);noLinks(full);const st=lstatSync(full);
    if(repo.tracked.some(p=>under(p,path) || under(path,p)))throw new Error(`Cleanup refuses tracked/staged paths: ${path}`);
    if(entries.length>=100 || (bytes+=st.isFile()?st.size:0)>16*1024*1024)throw new Error('Cleanup inventory limit: 100 entries / 16 MiB; choose a smaller exact scope');
    const entry={path,type:st.isDirectory()?'directory':'file',dev:st.dev,ino:st.ino,mode:st.mode,size:st.size,mtime:st.mtimeMs,ctime:st.ctimeMs};
    if(st.dev!==repo.parent.dev)throw new Error('Cleanup refuses cross-device relocation');
    if(st.isDirectory()) {
      if(present(join(full,'.git')) || (present(join(full,'HEAD')) && present(join(full,'objects'))))throw new Error(`Cleanup refuses nested repository: ${path}`);
      entries.push(entry);
      for(const name of readdirSync(full).sort())visit(path+'/'+name);
    } else {
      if(!st.isFile() || st.nlink!==1)throw new Error(`Cleanup refuses special files and hardlinks: ${path}`);
      if(!repo.status.includes(path))throw new Error(`Cleanup requires visible untracked files, not ignored/unknown contents: ${path}`);
      const fd=openSync(full,constants.O_RDONLY|constants.O_NOFOLLOW);
      try {entry.hash=digest(readFileSync(fd));}finally{closeSync(fd);}
      entries.push(entry);
    }
  }
  for(const path of paths) {
    noLinks(join(root,path));
    // A candidate below a nested worktree must not escape that ownership.
    for(let p=dirname(join(root,path));p!==root;p=dirname(p))if(present(join(p,'.git')) || (present(join(p,'HEAD')) && present(join(p,'objects'))))throw new Error('Cleanup refuses nested repository ancestors');
    if(!repo.status.some(p=>under(p,path)))throw new Error(`Cleanup requires a visible untracked path: ${path}`);
    visit(path);
  }
  if(JSON.stringify(entries).length>30000)throw new Error('Cleanup preview exceeds safe display limit; choose fewer paths');
  return entries;
}
export function inspectCleanup(root,paths,session) {
  root=noLinks(root);paths=exactPaths(paths);
  if(typeof session!=='string' || !session)throw new Error('Cleanup requires a session binding');
  const repo=repository(root),items=inventory(root,paths,repo),token=randomUUID();
  const candidate={version:1,token,session,repository:root,paths,repo,inventory:items,backup:join(dirname(root),`.pi-delivery-recovery-${token}`)};
  candidate.snapshot=digest(JSON.stringify(candidate));
  return candidate;
}
function validate(root,candidate,session,moved=[]) {
  if(candidate.session!==session || candidate.repository!==root)throw new Error('Cleanup session/repository changed');
  const {snapshot,...body}=candidate;
  if(digest(JSON.stringify(body))!==snapshot || candidate.backup!==join(dirname(root),`.pi-delivery-recovery-${candidate.token}`))throw new Error('Cleanup candidate changed');
  const repo=repository(root),expected={...candidate.repo,status:candidate.repo.status.filter(p=>!moved.some(q=>under(p,q)))};
  if(!same(repo,expected))throw new Error('Cleanup repository/branch/HEAD/index/status changed; inspect again');
  const remaining=candidate.paths.filter(p=>!moved.includes(p));
  if(!same(inventory(root,remaining,repo),candidate.inventory.filter(e=>!moved.some(p=>under(e.path,p)))))throw new Error('Cleanup content or inventory changed; inspect again');
}
function durableFile(path,value,flags='wx') {
  const fd=openSync(path,constants.O_WRONLY|constants.O_NOFOLLOW|(flags==='wx'?constants.O_CREAT|constants.O_EXCL:constants.O_APPEND),0o600);
  try{writeFileSync(fd,value);fsyncSync(fd);}finally{closeSync(fd);}
}
function syncDir(path) {const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function syncCandidate(root,items,syncPayload,signal) {
  // Inventory is preorder: reversing directories puts every child before its
  // parent. Persist all file data before persisting any directory entries.
  const ordered=[...items.filter(e=>e.type==='file'),...items.filter(e=>e.type==='directory').reverse()];
  for(const entry of ordered) {
    signal?.throwIfAborted();const path=join(root,entry.path);noLinks(path);
    const directory=entry.type==='directory';
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|(directory?constants.O_DIRECTORY:0));
    try {
      const check=()=>{
        const st=fstatSync(fd);
        if((directory?!st.isDirectory():!st.isFile() || st.nlink!==1) || ['dev','ino','mode','size'].some(k=>st[k]!==entry[k]) || st.mtimeMs!==entry.mtime || st.ctimeMs!==entry.ctime)throw new Error(`Cleanup payload identity changed: ${entry.path}`);
      };
      check();
      if(!directory && digest(readFileSync(fd))!==entry.hash)throw new Error(`Cleanup payload content changed: ${entry.path}`);
      syncPayload(fd,entry.path);check();
    } finally {closeSync(fd);}
  }
}
export function applyCleanup(root,candidate,session,{journal=()=>{},signal,rename=renameSync,syncPayload=fsyncSync}={}) {
  signal?.throwIfAborted();validate(root,candidate,session);
  // Fail before creating the backup or moving any source if payload durability
  // cannot be established. Hashing alone does not flush OS/device caches.
  syncCandidate(root,candidate.inventory,syncPayload,signal);
  validate(root,candidate,session);
  const moves=candidate.paths.map((source,i)=>({source:join(root,source),destination:join(candidate.backup,`item-${i}`)}));
  const record={version:1,phase:'prepared',token:candidate.token,snapshot:candidate.snapshot,repository:root,session,backup:candidate.backup,moves,inventory:candidate.inventory,recovery:'Preserved contents: move each destination back to its exact source only when the source is absent. If occupied, keep both and restore to a different empty location. Never overwrite or delete either copy.'};
  // Exclusive private directory, immutable manifest and fsynced append journal.
  // No delete, rollback, cross-device copy or automatic retry of partial work.
  mkdirSync(candidate.backup,{mode:0o700});
  try {
    durableFile(join(candidate.backup,'manifest.json'),JSON.stringify(record,null,2)+'\n');
    durableFile(join(candidate.backup,'events.jsonl'),JSON.stringify({phase:'prepared'})+'\n');
    syncDir(candidate.backup);syncDir(dirname(candidate.backup));journal(structuredClone(record));
    const moved=[];
    for(let i=0;i<moves.length;i++) {
      signal?.throwIfAborted();validate(root,candidate,session,moved);
      noLinks(candidate.backup);
      if(present(moves[i].destination))throw new Error('Cleanup refuses to overwrite an existing backup');
      durableFile(join(candidate.backup,'events.jsonl'),JSON.stringify({phase:'moving',...moves[i]})+'\n','a');
      rename(moves[i].source,moves[i].destination);
      syncDir(dirname(moves[i].source));syncDir(candidate.backup);
      moved.push(candidate.paths[i]);
      durableFile(join(candidate.backup,'events.jsonl'),JSON.stringify({phase:'moved',...moves[i]})+'\n','a');
      journal({...record,phase:'moved',moved:[...moved]});
    }
    validate(root,candidate,session,moved);
    const status=repository(root).status.map(p=>'?? '+p).join('\n');
    durableFile(join(candidate.backup,'events.jsonl'),JSON.stringify({phase:'complete',status})+'\n','a');
    const completed={...record,phase:'complete',status};journal(completed);return completed;
  } catch(e) {
    throw new Error(`${e.message}. Recovery: ${candidate.backup}; inspect manifest.json and events.jsonl and both source/destination paths. Partial moves are preserved; no automatic rollback or deletion.`,{cause:e});
  }
}
