#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {open,readFile,writeFile,appendFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {SimulationApi} from './http.mjs';
import {stopOwned,readPrivate} from './owned-processes.mjs';
const here=dirname(fileURLToPath(import.meta.url)),exec=promisify(execFile),api=new SimulationApi();
const chaos=process.env.SEAM_SIMULATION_CHAOS==='true',project=process.env.SEAM_SIMULATION_DOCKER_PROJECT;
if(chaos)assert.match(project??'',/^seam-six-hardening(?:-[a-z0-9]+)?$/,'faults restricted to the dedicated new acceptance project');
let runRoot=process.env.SEAM_SIMULATION_RESUME_ROOT,collaborationId,active,completed=false,semanticError,step=0;
const faults=[],events=[];const log=process.env.SEAM_SIMULATION_PARENT_LOG??'/tmp/seam-acceptance-parent.log';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function record(event,fields={}){const row={at:new Date().toISOString(),event,...fields};events.push(row);console.log(JSON.stringify(row));if(runRoot)await appendFile(join(runRoot,'fault-events.jsonl'),JSON.stringify(row)+'\n',{mode:0o600});}
async function ready(){const until=Date.now()+60_000;do{try{const response=await api.raw('/api/ready',undefined,{method:'GET'});if(response.response.ok)return;}catch{}await delay(500);}while(Date.now()<until);throw Error('platform did not recover write readiness');}
async function launch(attempt){
 const descriptor=await open(log,'a',0o600),entry=join(here,'run.mjs'),marker=randomUUID();
 const child=spawn(process.execPath,[entry,`--seam-owned=${marker}`],{env:{...process.env,...(runRoot?{SEAM_SIMULATION_RESUME_ROOT:runRoot}:{})},stdio:['ignore',descriptor.fd,descriptor.fd,'ipc']});await descriptor.close();
 const state={child,record:{pid:child.pid,entry,marker,detached:false},attempt,result:null,exit:null};active=state;
 child.on('message',message=>{if(message.event==='bootstrap-ready'){runRoot=message.runRoot;collaborationId=message.collaborationId;void record('durable-bootstrap-ready',{runRoot,collaborationId});}if(message.status)state.result=message;if(message.event==='provider-restarted')state.providerRestart=message;if(message.event==='provider-restart-failed')semanticError=Error(message.error);});
 child.once('error',error=>{semanticError=error;});child.once('exit',(code,signal)=>{state.exit={code,signal};});await record('parent-started',{attempt,pid:child.pid,resume:Boolean(runRoot)});return state;
}
async function faultTick(){
 if(!chaos||!runRoot||!collaborationId||active.exit||semanticError)return;
 const recovery=await readFile(join(runRoot,'recovery-events.jsonl'),'utf8').catch(()=>'');const detail=await api.detail(collaborationId),state=detail.lifecycle;
 if(step===0&&state.revision===1&&state.phase==='executing'&&recovery.includes('controller-recovered')){
  const saved=await readPrivate(runRoot,'bootstrap.json');faults.push({fault:'controller-child-exit',ok:true});await record('fault-parent-stop',{pid:active.record.pid,connectors:saved.locals.map(local=>local.worker.pid)});assert.equal(await stopOwned(active.record,'SIGKILL'),true);step=1;return;
 }
 if(step===1&&recovery.includes('parent-restored')){faults.push({fault:'parent-exit-and-durable-resume',ok:true});await record('fault-platform-restart',{project});await exec('docker',['compose','-p',project,'-f',join(here,'../../docker-compose.simulation.yml'),'restart','--no-deps','app'],{timeout:60000});await ready();faults.push({fault:'platform-restart',ok:true});step=2;return;}
 if(step===2){await record('fault-mysql-restart',{project});await exec('docker',['compose','-p',project,'-f',join(here,'../../docker-compose.simulation.yml'),'restart','--no-deps','mysql'],{timeout:60000});await ready();faults.push({fault:'mysql-restart',ok:true});step=3;return;}
 if(step===3){const saved=await readPrivate(runRoot,'bootstrap.json'),provider=saved.locals.find(local=>local.role==='provider');if(detail.jobs.some(job=>job.agentId===provider.agent.id&&['pending','running'].includes(job.status)))return;active.child.send({action:'restart-provider'});await record('fault-provider-restart-requested');step=4;return;}
 if(step===4&&active.providerRestart){faults.push({fault:'provider-connector-restart',ok:true,...active.providerRestart});await record('fault-matrix-completed',{faults});step=5;}
}
try{
 await api.loginOwner();let attempt=1;await launch(attempt);
 while(!completed){
  if(semanticError)throw semanticError;
  if(active.exit){
   if(active.result?.status==='failed')throw Error(active.result.error??'parent semantic failure');
   if(active.result?.status==='passed'&&active.exit.code===0){completed=true;break;}
   if(!runRoot||attempt>=3)throw Error('parent restart budget exhausted or bootstrap not durable');
   await record('parent-unexpected-exit',active.exit);await launch(++attempt);
  }
  await faultTick();await delay(500);
 }
 assert.ok(!chaos||step===5,'all requested real fault cases must complete');
 await writeFile(join(runRoot,'fault-matrix.json'),JSON.stringify({ok:true,chaos,faults,parentAttempts:active.attempt,temporaryTakeover:false,scope:'real owned processes and dedicated Docker app/MySQL restarts; no unrelated process or volume changed'},null,2));
 console.log(JSON.stringify({ok:true,event:'resilient-simulation-completed',runRoot,collaborationId,parentAttempts:active.attempt,faults}));
 }catch(error){
 console.error(String(error));if(collaborationId)await api.lifecycle(collaborationId,{action:'pause'}).catch(()=>{});
 if(active&&!active.exit)await stopOwned(active.record).catch(()=>{});
 if(runRoot){const saved=await readPrivate(runRoot,'bootstrap.json').catch(()=>null);for(const record of [...(saved?.controllers??[]),...(saved?.locals??[]).map(local=>local.worker).filter(Boolean)])await stopOwned(record).catch(()=>{});await writeFile(join(runRoot,'fault-matrix.json'),JSON.stringify({ok:false,faults,error:String(error),temporaryTakeover:false},null,2));}
 process.exitCode=1;
}
