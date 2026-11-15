import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
/** Only supervises its own child. Semantic failures never restart. */
export async function superviseController({file,configuration,environment={},onOutput=chunk=>process.stdout.write(chunk),onEvent=()=>{},onSpawn=()=>{},maxRestarts=2}) {
 for(let attempt=1;attempt<=maxRestarts+1;attempt++) {
  const outcome=await new Promise((resolve,reject)=>{
   let result;const marker=randomUUID();
   const child=spawn(process.execPath,[file,`--seam-owned=${marker}`],{env:{...process.env,...environment,SEAM_SIMULATION_CONTROLLER_WORKER:'1'},stdio:['ignore','pipe','pipe','ipc']});
   child.stdout.on('data',chunk=>onOutput(chunk));child.stderr.on('data',chunk=>onOutput(chunk));
   child.on('message',message=>{if(message?.status==='passed'||message?.status==='failed')result=message;});
   child.once('error',reject);child.once('exit',(code,signal)=>resolve({result,code,signal}));
   (async()=>{await onSpawn({pid:child.pid,entry:file,marker,detached:false});await onEvent({event:attempt===1?'controller-started':'controller-recovered',attempt,pid:child.pid});child.send({...configuration,controllerAttempt:attempt});})().catch(error=>{child.kill('SIGTERM');reject(error);});
  });
  if(outcome.result?.status==='passed'&&outcome.code===0)return {attempts:attempt,recoveries:attempt-1};
  if(outcome.result?.status==='failed')throw new Error(outcome.result.error||'controller semantic failure');
  if(attempt>maxRestarts)throw new Error(`controller restart budget exhausted: ${outcome.signal??outcome.code}`);
 }
}
