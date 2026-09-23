import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyCommand} from '../extensions/delivery/io.mjs';

test('executor records timeout only when its deadline fired and process closed',async()=>{
 const receipt=await verifyCommand(process.cwd(),'sleep 5',undefined,20);
 assert.equal(receipt.processClosed,true);assert.equal(receipt.terminationReason,'timeout');
 assert.equal(receipt.timeoutMs,20);assert.equal(receipt.terminated,true);
});
test('arbitrary SIGKILL is not host timeout evidence',async()=>{
 const receipt=await verifyCommand(process.cwd(),'kill -KILL $$',undefined,1000);
 assert.equal(receipt.processClosed,true);assert.equal(receipt.terminationReason,'signal');assert.equal(receipt.terminated,false);
});
test('abort is not a timeout and a larger deadline permits the same check',async()=>{
 const controller=new AbortController();controller.abort();
 const receipt=await verifyCommand(process.cwd(),'sleep 5',controller.signal,1000);
 assert.equal(receipt.terminationReason,'aborted');assert.equal(receipt.processClosed,true);
 const passed=await verifyCommand(process.cwd(),'sleep 0.03',undefined,900000);
 assert.equal(passed.code,0);assert.equal(passed.timeoutMs,900000);assert.equal(passed.terminationReason,null);
});
