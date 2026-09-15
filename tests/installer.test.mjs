// Exercise the real Bash installer in isolated homes, including races at preflight.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,cpSync,writeFileSync,readFileSync,readlinkSync,existsSync,readdirSync,rmSync,symlinkSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const resources=['skills/orchestrate-delivery','skills/security-review','skills/select-task-model','agents/delivery-coder.md','agents/delivery-reviewer.md','agents/delivery-security.md','extensions/delivery'];
function fixture(t) {
 const home=mkdtempSync(join(tmpdir(),'delivery-install-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const project=join(home,'project with spaces');mkdirSync(project);
 for(const name of ['install.sh',...resources]) {mkdirSync(dirname(join(project,name)),{recursive:true});cpSync(join(root,name),join(project,name),{recursive:true});}
 const agent=join(home,'.pi/agent');
 const env={...process.env,HOME:home,PI_CODING_AGENT_DIR:''};
 const run=(args=[],extra={})=>spawnSync('bash',[join(project,'install.sh'),...args],{cwd:home,env:{...env,...extra},encoding:'utf8'});
 return {home,project,agent,env,run};
}
function ok(r){assert.equal(r.status,0,r.stderr+r.stdout);}
function linked(f,agent=f.agent){for(const p of resources)assert.equal(readlinkSync(join(agent,p)),join(f.project,p));}
test('check-only preflight does not create directories or links',t=>{
 const f=fixture(t);ok(f.run(['--check']));assert.equal(existsSync(f.agent),false);
});
test('standalone linking works with spaces and is idempotent',t=>{const f=fixture(t);ok(f.run());linked(f);ok(f.run());linked(f);});
test('custom agent directory overrides HOME and does not use XDG',t=>{
 const f=fixture(t),agent=join(f.home,'custom agent');ok(f.run([],{PI_CODING_AGENT_DIR:agent,XDG_CONFIG_HOME:join(f.home,'xdg')}));linked(f,agent);assert.equal(existsSync(f.agent),false);
});
for(const kind of ['file','directory','foreign link','dangling link'])test(`conflict (${kind}) blocks every link`,t=>{
 const f=fixture(t),target=join(f.agent,'extensions/delivery');mkdirSync(dirname(target),{recursive:true});
 if(kind==='file')writeFileSync(target,'keep');else if(kind==='directory')mkdirSync(target);else symlinkSync(kind==='foreign link'?f.home:join(f.home,'absent'),target);
 assert.equal(f.run().status,1);assert.equal(existsSync(join(f.agent,'skills')),false);
 if(kind==='file')assert.equal(readFileSync(target,'utf8'),'keep');else if(kind.includes('link'))assert.equal(readlinkSync(target),kind==='foreign link'?f.home:join(f.home,'absent'));
});
for(const outside of [false,true])test(`non-directory ancestors block preflight (outside agent root: ${outside})`,t=>{
 const f=fixture(t);const blocker=outside?join(f.home,'blocker'):join(f.agent,'extensions');mkdirSync(dirname(blocker),{recursive:true});writeFileSync(blocker,'keep');
 const env=outside?{PI_CODING_AGENT_DIR:join(blocker,'agent')}:{};
 for(const args of [['--check'],[]])assert.equal(f.run(args,env).status,1);
 assert.equal(readFileSync(blocker,'utf8'),'keep');assert.equal(existsSync(join(f.agent,'skills')),false);
});
function race(f,code,args=[]) {
 const driver='source "$1"; shift; configure "$@"; preflight; '+code+'; install_links';
 return spawnSync('bash',['-c',driver,'race',join(f.project,'install.sh'),...args],{cwd:f.home,env:f.env,encoding:'utf8'});
}
for(const kind of ['symlink','directory'])test(`exclusive creation preserves a ${kind} appearing after preflight`,t=>{
 const f=fixture(t);const mutation=kind==='symlink'?'ln -s /foreign "${TARGETS[0]}"':'mkdir "${TARGETS[0]}"';
 const r=race(f,'mkdir -p "$(dirname "${TARGETS[0]}")"; '+mutation);assert.equal(r.status,1,r.stderr+r.stdout);
 if(kind==='symlink')assert.equal(readlinkSync(join(f.agent,resources[0])),'/foreign');else assert.deepEqual(readdirSync(join(f.agent,resources[0])),[]);
});
for(const p of ['agents/delivery-coder.md','skills/security-review/SKILL.md','extensions/delivery/index.ts'])test(`invalid source blocks linking: ${p}`,t=>{
 const f=fixture(t);rmSync(join(f.project,p));if(p.startsWith('agents'))mkdirSync(join(f.project,p));assert.equal(f.run().status,1);assert.equal(existsSync(f.agent),false);
});
test('arguments and full restart instructions are explicit',t=>{
 const f=fixture(t);for(const args of [['--unknown'],['--check','extra'],['--check','--unknown']])assert.equal(f.run(args).status,2);
 ok(f.run(['--help']));const r=f.run();ok(r);assert.match(r.stdout,/workers settle/);assert.match(r.stdout,/restart/i);assert.doesNotMatch(r.stdout,/\/reload/);
});
test('installation never invokes Python, package managers or network clients',t=>{
 const f=fixture(t),bin=join(f.home,'bin'),log=join(f.home,'unexpected');mkdirSync(bin);
 for(const cmd of ['python3','python','pi','npm','npx','curl','wget']){const p=join(bin,cmd);writeFileSync(p,'#!/bin/sh\necho called >> "$UNEXPECTED_LOG"\nexit 99\n');chmodSync(p,0o755);}
 ok(f.run([],{PATH:bin+':'+process.env.PATH,UNEXPECTED_LOG:log}));assert.equal(existsSync(log),false);
});
