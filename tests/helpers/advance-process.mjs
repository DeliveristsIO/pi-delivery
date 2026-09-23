// Offline A/B process stub: A exits after a later native coder is recorded live.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {registerDelivery} from '../../extensions/delivery/extension.mjs';
import {terminalProof} from './native-artifacts.mjs';
const state=JSON.parse(readFileSync(process.argv[2],'utf8')),mode=process.argv[3],saved=[],tools={},handlers={},calls=[];
const ctx={cwd:state.root,ui:{setStatus(){}},sessionManager:{getBranch:()=>[{type:'custom',customType:'delivery-coordinator-v2',data:state}],getSessionId:()=>state.session,getSessionFile:()=>state.active.nativeSession},modelRegistry:{getAvailable:()=>[{provider:'test',id:'code'},{provider:'test',id:'review'}]}};
const pi={events:{},on:(n,f)=>handlers[n]=f,registerTool:t=>tools[t.name]=t,registerCommand(){},getActiveTools:()=>[],setActiveTools(){},appendEntry:(_n,s)=>saved.push(s),sendMessage(){}};
registerDelivery(pi,undefined,{child:false,repoRoot:()=>state.root,snapshot:()=>({}),workingTreeEvidence:()=>'',rpc:async(_e,method,params)=>{
 calls.push(method);
 if(method==='spawn' && (mode==='advance' || mode==='finish' && params.agent==='delivery-reviewer')) {
  const runId=mode==='advance'?'later-coder':'later-reviewer',dir=join(state.root,runId);mkdirSync(dir);
  writeFileSync(join(dir,'status.json'),JSON.stringify({runId,sessionId:state.active.nativeSession,state:mode==='advance'?'running':'complete',steps:[{agent:params.agent,model:params.model,attemptedModels:[params.model],structuredOutputPath:join(dir,'report.json')}]}));
  writeFileSync(join(dir,'report.json'),JSON.stringify({status:'approved',summary:'Offline later worker',findings:[]}));
  if(mode==='finish')writeFileSync(join(dir,'process-terminal.json'),JSON.stringify(terminalProof(runId)));
  return {details:{runId,asyncDir:dir}};
 }
 throw new Error('Offline native infrastructure paused');
}});
await handlers.session_start({},ctx);
let acquired=false,error;
try {await tools.delivery_resume.execute('resume',{},undefined,undefined,ctx);acquired=true;}catch(e){error=e.message;}
for(let i=0;i<100 && acquired && !['blocked','stopped','complete'].includes(saved.at(-1)?.stage);i++)await new Promise(r=>setTimeout(r,1));
await handlers.session_shutdown();
console.log(JSON.stringify({acquired,error,state:saved.at(-1),monitoring:saved.find(s=>s.active?.id===state.active.id && s.stage===state.active.stage),calls}));
