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
