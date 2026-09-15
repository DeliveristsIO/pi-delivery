// Exercise the real bootstrap script in isolated homes; pi is stubbed, so no network or package manager runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,cpSync,writeFileSync,readFileSync,readlinkSync,existsSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const resources=['skills/orchestrate-delivery','skills/security-review','skills/select-task-model','agents/delivery-coder.md','agents/delivery-reviewer.md','agents/delivery-security.md','extensions/delivery'];
const SUBAGENTS='npm:pi-subagents@0.67.0',SPARK='npm:@adityaaria/spark';

// pi=<ok|fail-subagents> chooses whether the stubbed package install fails.
function fixture(t,pi='ok') {
 const home=mkdtempSync(join(tmpdir(),'delivery-setup-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const project=join(home,'project with spaces');mkdirSync(project);
 for(const name of ['install.sh','setup.sh',...resources]) {mkdirSync(dirname(join(project,name)),{recursive:true});cpSync(join(root,name),join(project,name),{recursive:true});}
 mkdirSync(join(project,'tests'));cpSync(join(root,'tests/check-installed.mjs'),join(project,'tests/check-installed.mjs'));
 const bin=join(home,'bin'),log=join(home,'pi.log'),unexpected=join(home,'unexpected');mkdirSync(bin);
 // The stub records argv plus the ignore-scripts environment of every pi call, so ordering and env are asserted, not assumed.
 // It also records the install the way pi does (settings entry), which is what makes reruns idempotent.
 const guard=pi==='fail-subagents'?'case "$*" in *pi-subagents*) exit 7;; esac\n':'';
 writeFileSync(join(bin,'pi'),`#!/usr/bin/env bash\nprintf 'ignore=%s|%s\\n' "\${npm_config_ignore_scripts:-unset}" "$*" >> ${JSON.stringify(log)}\n${guard}case "$*" in install*) mkdir -p "$HOME/.pi/agent/npm" && printf '%s\\n' "{ \\"extensions\\": [\\"$2\\"] }" >> "$HOME/.pi/agent/settings.json";; esac\nexit 0\n`);
 chmodSync(join(bin,'pi'),0o755);
 for(const cmd of ['npm','npx','curl','wget','python3','python']){const p=join(bin,cmd);writeFileSync(p,`#!/bin/sh\necho called >> ${JSON.stringify(unexpected)}\nexit 99\n`);chmodSync(p,0o755);}
 const agent=join(home,'.pi/agent');
 const run=(args=[],extra={})=>spawnSync('bash',[join(project,'setup.sh'),...args],{cwd:home,env:{...process.env,HOME:home,PI_CODING_AGENT_DIR:'',PATH:`${bin}:${process.env.PATH}`,...extra},encoding:'utf8'});
 const calls=()=>existsSync(log)?readFileSync(log,'utf8').split('\n').filter(Boolean):[];
 return {home,project,agent,log,unexpected,run,calls};
}
function ok(r){assert.equal(r.status,0,r.stderr+r.stdout);}
const installs=calls=>calls.filter(l=>l.includes('|install '));

test('packages install before linking, once each, in order, with ignore-scripts',t=>{
 const f=fixture(t);ok(f.run(['--skip-verify']));
 const got=installs(f.calls());
 assert.deepEqual(got.map(l=>l.split('|')[1]),[`install ${SUBAGENTS}`,`install ${SPARK}`]);
 assert.ok(got.every(l=>l.startsWith('ignore=true|')),'package installs must ignore npm lifecycle scripts');
 for(const p of resources)assert.equal(readlinkSync(join(f.agent,p)),join(f.project,p));
 const r=f.run(['--skip-verify']);ok(r);
 assert.match(r.stdout,/Already installed: npm:pi-subagents/);assert.match(r.stdout,/Already installed: npm:@adityaaria/);
 assert.deepEqual(installs(f.calls()).length,2,'second run installs nothing');
});

test('an installed package directory is recognised for scoped names too',t=>{
 const f=fixture(t);mkdirSync(join(f.agent,'npm','spark'),{recursive:true});
 const r=f.run(['--skip-verify']);ok(r);
 assert.match(r.stdout,/Already installed: npm:@adityaaria/);
 assert.deepEqual(installs(f.calls()).map(l=>l.split('|')[1]),[`install ${SUBAGENTS}`]);
});

test('check only plans actions and changes nothing',t=>{
 const f=fixture(t);const r=f.run(['--check']);ok(r);
 assert.match(r.stdout,/Would install: npm:pi-subagents/);assert.match(r.stdout,/Would install: npm:@adityaaria/);
 assert.equal(existsSync(f.agent),false,'--check must not create the agent directory');
 assert.equal(existsSync(f.log),false,'--check must not call pi for installs');
 assert.doesNotMatch(r.stdout,/bootstrap finished|restart/i,'a dry run must not claim completion or ask for a restart');
});

test('a conflicting delivery path blocks linking but never the packages',t=>{
 const f=fixture(t);const target=join(f.agent,'extensions/delivery');mkdirSync(dirname(target),{recursive:true});writeFileSync(target,'keep');
 const r=f.run(['--skip-verify']);assert.equal(r.status,1,r.stdout+r.stderr);
 assert.deepEqual(installs(f.calls()).map(l=>l.split('|')[1]),[`install ${SUBAGENTS}`,`install ${SPARK}`]);
 assert.equal(existsSync(join(f.agent,'skills')),false,'linking is all-or-nothing');
 assert.match(r.stdout+r.stderr,new RegExp(`Refusing conflicting path: ${target.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`));
 assert.match(r.stdout+r.stderr,/Conflicting path: /);assert.match(r.stdout+r.stderr,/Remove or move the conflicting path/);
});

test('missing pi fails before any change',t=>{
 const f=fixture(t);const r=f.run(['--skip-verify'],{PATH:'/usr/bin:/bin'});
 assert.notEqual(r.status,0);assert.match(r.stderr,/Install pi first/);
 assert.equal(existsSync(f.agent),false);assert.equal(existsSync(f.log),false);
});

test('a failing package install stops before linking',t=>{
 const f=fixture(t,'fail-subagents');const r=f.run(['--skip-verify']);
 assert.notEqual(r.status,0);assert.match(r.stderr,/Package installation failed: npm:pi-subagents/);
 assert.equal(installs(f.calls()).length,1,'no further installs after the failure');
 assert.equal(existsSync(join(f.agent,'skills')),false);
});

test('verification runs by default and is skipped on request',t=>{
 const f=fixture(t);const checked=f.run([]);
 assert.notEqual(checked.status,0,'the stubbed pi cannot answer the loading check');
 assert.match(checked.stderr,/Loading check failed/);
 assert.ok(f.calls().some(l=>l.includes('|--mode rpc')), 'loading check must query a disposable pi');
 const before=f.calls().length;const skipped=f.run(['--skip-verify']);ok(skipped);
 assert.ok(!f.calls().slice(before).some(l=>l.includes('|--mode rpc')),'--skip-verify must not start the loading check');
 assert.match(skipped.stdout,/--skip-verify/);
});

test('a release without the loading check still finishes cleanly',t=>{
 const f=fixture(t);rmSync(join(f.project,'tests/check-installed.mjs'));
 const r=f.run();ok(r);assert.match(r.stdout,/Loading check skipped/);
});

test('the bootstrap reports /delivery setup when no routes exist yet',t=>{
 const f=fixture(t);const r=f.run(['--skip-verify']);ok(r);
 assert.match(r.stdout,/\/delivery setup/);assert.match(r.stdout,/start it again with pi --continue/);assert.doesNotMatch(r.stdout,/\/reload/);
});

test('arguments are explicit and nothing but pi is called',t=>{
 const f=fixture(t);for(const args of [['--unknown'],['--check','--nope']])assert.equal(f.run(args).status,2);
 const help=f.run(['--help']);ok(help);assert.match(help.stdout,/Usage: bash setup\.sh/);
 assert.equal(existsSync(f.unexpected),false,'setup.sh must not call npm, npx, curl, wget or python directly');
});
