import test from 'node:test';
import assert from 'node:assert/strict';
import {scanText,unsafePath} from '../scripts/check-release.mjs';
test('publication checks detect credentials and identifying machine paths',()=>{
 for(const value of ['ghp_'+'a'.repeat(36),['-----BEGIN','OPENSSH PRIVATE KEY-----'].join(' '),['','home','sample-user','project'].join('/'),'api_key="'+'x'.repeat(32)+'"'])assert.ok(scanText(value).length>0);
 assert.deepEqual(scanText('Choose provider/model via /delivery setup. Use $HOME and /path/to/repository.'),[]);
});
test('publication checks reject private artifacts without blocking source',()=>{
 for(const name of ['.spark/session.jsonl','auth.json','.env','logs/run.log','local/session.jsonl'])assert.equal(unsafePath(name),true,name);
 for(const name of ['extensions/delivery/extension.mjs','tests/delivery-io.test.mjs','package.json','README.md'])assert.equal(unsafePath(name),false,name);
});
