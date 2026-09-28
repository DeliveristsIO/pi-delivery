import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,mkdirSync,realpathSync} from 'node:fs';
import {join,resolve,parse,relative,isAbsolute} from 'node:path';
import {agentDir} from './io.mjs';
import {validate,validateReport,VERIFIER_REPORT_SCHEMA} from './policy.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
export const snapshotId=snapshot=>hash(JSON.stringify(Object.entries(snapshot).sort(([a],[b])=>a.localeCompare(b))));
export const evidenceRoot=run=>join(agentDir(),'delivery-evidence',run);
export function sanitizeEvidence(text) {
  return String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'')
    .replace(/https?:\/\/[^\s<>"']+/gi,value=>{try{const u=new URL(value);return `${u.protocol}//${u.host}${u.pathname}${u.search || u.hash?'[redacted]':''}`;}catch{return '[redacted URL]';}})
    .replace(/(?:authorization|cookie|set-cookie)\s*[:=][^\n]*/gi,'[redacted header]')
    .replace(/((?:password|secret|token|credential|api[_-]?key)["']?\s*[:=]\s*)[^\s,;]+/gi,'$1[redacted]');
}
function canonicalDirectory(dir) {
  if(!isAbsolute(dir) || resolve(dir)!==dir)throw new Error('Artifact directory must be canonical');
  let path=parse(dir).root;
  for(const part of relative(path,dir).split('/')) {
    path=join(path,part);const st=lstatSync(path);
    if(st.isSymbolicLink() || !st.isDirectory())throw new Error('Artifact directory traverses symlink or non-directory');
  }
  if(realpathSync(dir)!==dir)throw new Error('Artifact directory is not canonical');
}
export function createEvidenceDirectory(dir,root) {
  const rel=relative(root,dir);
  if(!rel || (!rel.startsWith('..') && !isAbsolute(rel)))throw new Error('Evidence artifacts must be outside application source');
  // Check existing ancestors before recursive creation.
  let ancestor=parse(dir).root;
  for(const part of relative(ancestor,dir).split('/')) {
    ancestor=join(ancestor,part);
    try {const st=lstatSync(ancestor);if(st.isSymbolicLink() || !st.isDirectory())throw new Error('Unsafe artifact ancestor');}
    catch(error){if(error.code!=='ENOENT')throw error;mkdirSync(ancestor,{mode:0o700});}
  }
  canonicalDirectory(dir);
}
export function collectEvidence(dir,browser,report,identity) {
  validate(VERIFIER_REPORT_SCHEMA,report,'verifier report');
  const {status,summary,findings,blockedReason}=report;
  validateReport({status,summary,findings,...(blockedReason?{blockedReason}:{})});
  for(const key of ['task','round','source','phase'])if(report[key]!==identity[key])throw new Error(`Evidence ${key} identity mismatch`);
  const expected=identity.phase==='probe'?[browser.probe]:browser.scenarios.map(s=>s.command);
  if(report.status==='approved' && (JSON.stringify(report.commands.map(c=>c.command))!==JSON.stringify(expected) || report.commands.some(c=>c.exitCode!==0)))throw new Error('Evidence missing successful exact command receipts');
  if(report.commands.some(c=>!expected.includes(c.command)))throw new Error('Unapproved evidence command receipt');
  canonicalDirectory(dir);
  if(new Set(report.artifacts.map(a=>a.path)).size!==report.artifacts.length)throw new Error('Duplicate artifact receipt');
  let bytes=0;
  const artifacts=report.artifacts.map(artifact=>{
    const permitted=browser.artifacts.find(a=>a.path===artifact.path);
    if(!permitted || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(artifact.path) || artifact.path.includes('..'))throw new Error('Unapproved artifact path');
    const path=join(dir,artifact.path),st=lstatSync(path);
    if(st.isSymbolicLink())throw new Error('Artifact symlink refused');
    const max=permitted.kind==='text'?16384:2*1024*1024;
    bytes+=st.size;
    if(!st.isFile() || st.nlink!==1 || st.size>max || bytes>4*1024*1024)throw new Error('Invalid/oversized artifact');
    const content=readFileSync(path);
    if(content.length!==st.size || hash(content)!==artifact.sha256)throw new Error('Artifact hash identity mismatch');
    return {...artifact,kind:permitted.kind,bytes:st.size,...(permitted.kind==='text'?{text:sanitizeEvidence(content.toString('utf8'))}: {})};
  });
  if(report.status==='approved' && identity.phase==='verifier' && browser.artifacts.some(a=>!artifacts.some(b=>b.path===a.path)))throw new Error('Required artifact missing');
  if(artifacts.reduce((n,a)=>n+(a.text?.length || 0),0)>32768)throw new Error('Text evidence exceeds aggregate limit');
  return {...identity,directory:dir,environment:browser.environment,target:browser.target,scenarios:browser.scenarios.map(s=>s.name),status,summary:sanitizeEvidence(summary),findings:findings.map(sanitizeEvidence),commands:report.commands,artifacts};
}
