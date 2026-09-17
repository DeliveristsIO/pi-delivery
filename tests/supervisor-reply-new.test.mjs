import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSupervisorReply} from '../extensions/delivery/policy.mjs';
test('supervisor reply envelope is strict, bounded, and non-authoritative',()=>{
 const reply=validateSupervisorReply({kind:'evidence',content:'The requested check produced this output.',nonAuthoritative:true});
 assert.deepEqual(reply,{kind:'evidence',content:'The requested check produced this output.',nonAuthoritative:true});
 for(const value of [{kind:'evidence',content:'x'},{kind:'instruction',content:'x',nonAuthoritative:true},{kind:'evidence',content:'x',nonAuthoritative:true,scope:'all'},{kind:'evidence',content:'x'.repeat(20001),nonAuthoritative:true}])assert.throws(()=>validateSupervisorReply(value));
});
