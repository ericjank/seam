import {spawn} from 'node:child_process';
/** Only supervises the child it creates; semantic test failures are never retried. */
export async function superviseController({file,configuration,environment={},onOutput=chunk=>process.stdout.write(chunk),onEvent=()=>{},maxRestarts=2}) {
 for(let attempt=1;attempt<=maxRestarts+1;attempt++) {
  const outcome=await new Promise((resolve,reject)=>{
   let result;const child=spawn(process.execPath,[file],{env:{...process.env,...environment,SEAM_SIMULATION_CONTROLLER_WORKER:'1'},stdio:['ignore','pipe','pipe','ipc']});
   onEvent({event:attempt===1?'controller-started':'controller-recovered',attempt,pid:child.pid});
   child.stdout.on('data',chunk=>onOutput(chunk));child.stderr.on('data',chunk=>onOutput(chunk));
   child.on('message',message=>{if(message?.status==='passed'||message?.status==='failed')result=message;});
   child.once('error',reject);child.once('exit',(code,signal)=>resolve({result,code,signal}));
   child.send({...configuration,controllerAttempt:attempt});
  });
  if(outcome.result?.status==='passed'&&outcome.code===0)return {attempts:attempt,recoveries:attempt-1};
  if(outcome.result?.status==='failed')throw new Error(outcome.result.error||'controller semantic failure');
  if(attempt>maxRestarts)throw new Error(`controller restart budget exhausted: ${outcome.signal??outcome.code}`);
 }
}
