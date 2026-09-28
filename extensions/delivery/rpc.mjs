import {randomUUID} from 'node:crypto';
export function rpc(events,method,params={},timeoutMs=15000,requestId=randomUUID()) {
  return new Promise((resolve,reject)=>{
    let unsubscribe;
    const finish=(error,data)=>{clearTimeout(timer);unsubscribe?.();error?reject(error):resolve(data);};
    const timer=setTimeout(()=>finish(new Error(`pi-subagents ${method} timed out. Check installation/status; do not retry a launch blindly.`)),timeoutMs);
    unsubscribe=events.on(`subagents:rpc:v1:reply:${requestId}`,reply=>{
      if(reply?.version!==1 || reply.requestId!==requestId) return;
      if(reply.success)return finish(null,reply.data);
      const error=new Error(reply.error?.message || 'pi-subagents RPC failed');
      error.requestId=requestId;
      error.code=reply.error?.code;
      finish(error);
    });
    try {events.emit('subagents:rpc:v1:request',{version:1,requestId,method,params,source:{extension:'delivery'}});}
    catch(error){finish(error);}
  });
}
