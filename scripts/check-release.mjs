#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,existsSync} from 'node:fs';
import {dirname,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
export function unsafePath(name) {
 return /(^|\/)(?:\.spark|\.git|node_modules|__pycache__)(\/|$)/.test(name) || /(^|\/)\.env(?:\.|$)/.test(name) || /\.(?:jsonl|log|pyc|tgz)$/.test(name) || /^(?:auth|credentials|delivery|settings)\.json$/.test(basename(name));
}
export function scanText(text) {
 const patterns=[
  ['private key',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['provider token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b/],
  ['credential assignment',/(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["'][A-Za-z0-9_\-/.+=]{16,}["']/i],
  ['machine home path',/\/(?:home|Users)\/[A-Za-z0-9_.-]+\//]
 ];
 return patterns.filter(([,pattern])=>pattern.test(text)).map(([name])=>name);
}
function main() {
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const pkg=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
 const source=execFileSync('git',['-c','core.fsmonitor=false','ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
 const packed=JSON.parse(execFileSync('npm',['pack','--dry-run','--ignore-scripts','--offline','--json'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}))[0].files.map(f=>f.path);
 const allowed=new Set([...pkg.files,'package.json']);
 const errors=[];
 for(const name of packed)if(!allowed.has(name))errors.push(`${name}: not in publication allowlist`);
 const privatePattern=process.env.PRIVATE_PATTERN?new RegExp(process.env.PRIVATE_PATTERN,'i'):null;
 for(const name of new Set([...source,...packed])) {
  if(unsafePath(name)){errors.push(`${name}: private artifact`);continue;}
  const path=resolve(root,name);if(!existsSync(path))continue;
  if(lstatSync(path).isSymbolicLink()){errors.push(`${name}: inspect symlink before publication`);continue;}
  if(!lstatSync(path).isFile())continue;
  const text=readFileSync(path,'utf8');
  for(const finding of scanText(text))errors.push(`${name}: possible ${finding}`);
  if(privatePattern?.test(text)||privatePattern?.test(name))errors.push(`${name}: private-context match`);
 }
 if(!process.argv.includes('--privacy-only')) {
  if(!existsSync(resolve(root,'LICENSE'))||!pkg.license||pkg.license==='UNLICENSED')errors.push('Owner-approved LICENSE is required before release');
 }
 console.log(JSON.stringify({sourceFiles:new Set(source).size,packageFiles:packed.length,errors},null,2));
 if(errors.length)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
