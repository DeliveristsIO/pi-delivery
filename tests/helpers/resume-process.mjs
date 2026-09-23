// Offline competing Pi-process stub. No provider or native control calls allowed.
import {readFileSync} from 'node:fs';
import {registerDelivery} from '../../extensions/delivery/extension.mjs';
const state=JSON.parse(readFileSync(process.argv[2],'utf8')),saved=[],tools={},handlers={},calls=[];
const ctx={cwd:state.root,ui:{setStatus(){}},sessionManager:{getBranch:()=>[{type:'custom',customType:'delivery-coordinator-v2',data:state}],getSessionId:()=>state.session,getSessionFile:()=>state.active.nativeSession},modelRegistry:{getAvailable:()=>[]}};
const pi={events:{},on:(n,f)=>handlers[n]=f,registerTool:t=>tools[t.name]=t,registerCommand(){},getActiveTools:()=>[],setActiveTools(){},appendEntry:(_n,s)=>saved.push(s),sendMessage(){}};
registerDelivery(pi,undefined,{child:false,repoRoot:()=>state.root,snapshot:()=>({}),rpc:async(_e,method)=>{calls.push(method);throw new Error('Unexpected native call');}});
await handlers.session_start({},ctx);
process.stdout.write('ready\n');
await new Promise(resolve=>process.stdin.once('data',resolve));process.stdin.pause();
let acquired=false,error;
try {await tools.delivery_resume.execute('resume',{},undefined,undefined,ctx);acquired=true;}catch(e){error=e.message;}
await handlers.session_shutdown();
console.log(JSON.stringify({acquired,error,stages:saved.map(s=>s.stage),state:saved.at(-1),calls}));
