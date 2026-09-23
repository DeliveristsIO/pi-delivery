import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateCommands,verifyCommand} from '../extensions/delivery/io.mjs';
test('check validation catches prose and shell syntax without executing commands',t=>{
 const root=mkdtempSync(join(tmpdir(),'delivery-checks-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 validateCommands(root,['node --version','touch marker']);assert.equal(existsSync(join(root,'marker')),false);
 for(const command of ['Verify all requirements','node "unterminated','not-installed-delivery-test'])assert.throws(()=>validateCommands(root,[command]),/runnable/);
});
test('host receipts contain real exit codes and output',async()=>{
 const pass=await verifyCommand(process.cwd(),'printf actual-output');assert.equal(pass.code,0);assert.equal(pass.output,'actual-output');assert.equal(pass.processClosed,true);
 const fail=await verifyCommand(process.cwd(),'printf actual-error >&2; exit 7');assert.equal(fail.code,7);assert.equal(fail.output,'actual-error');
});
