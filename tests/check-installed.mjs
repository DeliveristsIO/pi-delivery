#!/usr/bin/env node
// Model-free smoke check; never resumes a saved session or dispatches a worker.
import {spawn} from 'node:child_process';
const child=spawn('pi',['--mode','rpc','--no-session','--offline'],{cwd:process.argv[2]||process.cwd(),stdio:['pipe','pipe','pipe']});
let commands,state,buffer='',stderr='',done=false;const statuses={};
const timer=setTimeout(()=>finish('Pi loading check timed out'),30000);
function finish(error) {
 if(done)return;done=true;clearTimeout(timer);
 const delivery=commands?.filter(c=>c.name==='delivery');
 console.log(JSON.stringify({deliveryCommands:delivery?.length,status:statuses.delivery,model:state?.model?`${state.model.provider}/${state.model.id}`:null,error:error||undefined,stderr:stderr||undefined},null,2));
 process.exitCode=error||stderr||delivery?.length!==1||!statuses.delivery?1:0;
 child.kill('SIGTERM');const stop=setTimeout(()=>child.kill('SIGKILL'),5000);stop.unref();child.once('exit',()=>clearTimeout(stop));
}
child.on('error',e=>finish(e.message));
child.on('exit',()=>{if(!done)finish('Pi exited before responding');});
child.stderr.on('data',b=>{stderr+=b;});
child.stdout.on('data',b=>{
 buffer+=b;
 while(buffer.includes('\n')) {
  const n=buffer.indexOf('\n'),line=buffer.slice(0,n);buffer=buffer.slice(n+1);
  let e;try{e=JSON.parse(line);}catch{continue;}
  if(e.type==='extension_ui_request'&&e.method==='setStatus')statuses[e.statusKey]=e.statusText;
  if(e.id==='commands')commands=e.data?.commands;
  if(e.id==='state')state=e.data;
 }
 if(commands&&state&&statuses.delivery)finish();
});
for(const request of [{id:'commands',type:'get_commands'},{id:'state',type:'get_state'}])child.stdin.write(JSON.stringify(request)+'\n');
