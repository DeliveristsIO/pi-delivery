import test from 'node:test';
import assert from 'node:assert/strict';
import {modelLabel,ROLE_HELP} from '../extensions/delivery/setup.mjs';

test('unknown and zero catalog prices never imply free usage or capability',()=>{
 const label=modelLabel({provider:'custom',id:'model',cost:{input:0,output:0}});
 assert.match(label,/ctx \? \/ out \?/);
 assert.match(label,/reasoning \?/);
 assert.match(label,/unknown\/unpriced/);
 assert.doesNotMatch(label,/free|\$0/);
});
test('versioned IDs stay intact and labels expose registry data without rankings',()=>{
 const label=modelLabel({provider:'ollama-cloud',id:'deepseek-v4-flash:0731',contextWindow:128000,maxTokens:16000,reasoning:false,input:['text'],cost:{input:0.2,output:0.4}});
 assert.match(label,/^ollama-cloud\/deepseek-v4-flash:0731/);
 assert.match(label,/128k.*16k.*no reasoning.*text.*\$0.2\/\$0.4/);
 assert.doesNotMatch(label,/best|cheapest|qualified/);
 assert.equal(Object.keys(ROLE_HELP).length,5);
});

test('configuration inspection separates effective defaults from ignored fields without exposing their values',async()=>{
 const {configurationReport}=await import('../extensions/delivery/setup.mjs');
 const report=configurationReport({version:1,routes:{planning:'p/plan',spec:'p/old'},repos:['/private'],profiles:{secret:'private'},timeouts:{coder:42}});
 assert.deepEqual(report.active,{routes:{planning:'p/plan'},approval:'autonomous',commit:true,timeouts:{commandMs:120000}});
 assert.deepEqual(report.inactiveSettings.map(s=>s.path),['routes.spec','repos','profiles','timeouts.coder']);
 assert.doesNotMatch(JSON.stringify(report),/private|p\/old/);
});
test('configuration inspection reflects active settings and rejects invalid command timeouts',async()=>{
 const {configurationReport}=await import('../extensions/delivery/setup.mjs');
 const report=configurationReport({routes:{quality:'p/review'},approval:'manual',commit:false,timeouts:{commandMs:900000}});
 assert.equal(report.active.approval,'manual');assert.equal(report.active.commit,false);assert.equal(report.active.timeouts.commandMs,900000);
 for(const value of [0,999,3600001,'900000'])assert.throws(()=>configurationReport({routes:{},timeouts:{commandMs:value}}),/commandMs/);
 assert.equal(configurationReport({routes:{},approval:'other',commit:'false'}).active.approval,'autonomous');
 assert.equal(configurationReport({routes:{},commit:'false'}).active.commit,true);
});
