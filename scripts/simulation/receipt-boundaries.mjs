#!/usr/bin/env node
import { CONNECTOR_PROTOCOL_VERSION } from "../../packages/protocol/dist/index.js";
// Actual Connector restart and HTTP/DB receipts; model output is an explicit fixture.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir}from'node:os';import{fileURLToPath}from'node:url';
import{SimulationApi}from'./http.mjs';import{launchOwned,stopOwned,processMatches}from'./owned-processes.mjs';
const publicJournal=entry=>{const {recoveryKey,...publicEntry}=entry;return {...publicEntry,recoveryKeyPresent:Boolean(recoveryKey)};};
const api=new SimulationApi(),cases=[],delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,description){const deadline=Date.now()+30_000;while(Date.now()<deadline){const value=await predicate();if(value)return value;await delay(100);}throw Error(description);}
async function journal(root,jobId){for(const directory of await readdir(join(root,'state')).catch(()=>[])){try{return JSON.parse(await readFile(join(root,'state',directory,jobId+'.json'),'utf8'));}catch{}}return null;}
await api.loginOwner();
for(const boundary of ['before_commit','after_commit_before_ack']){
 const root=await mkdtemp(join(tmpdir(),'seam-receipt-boundary-')),peer=await api.register('receipt-'+boundary+'-'+Date.now(),'generic-cli');let worker,proxy,collaborationId;
 try{
  await api.call('/api/connectors/heartbeat',{agentId:peer.agent.id,capabilities:{adapter:'generic-cli',executionMode:'external',testConfigured:false,supportsInformationLookup:true,protocolVersion: CONNECTOR_PROTOCOL_VERSION}},{token:peer.agent.token});
  const created=await api.call('/api/collaborations',{projectId:peer.project.id,objective:'显式合成协议夹具：只验证回执提交边界，不代表真实业务或模型执行'});collaborationId=created.id;await api.call(`/api/collaborations/${collaborationId}/dispatch`,{autoAdvance:false});
  let intercepted=false,allowDelivery=false,upstreamCommitted=false,jobId;const observations=[];
  proxy=createServer(async(request,response)=>{
   try{
    const chunks=[];for await(const part of request)chunks.push(part);const body=Buffer.concat(chunks);const isComplete=request.url==='/api/connectors/complete';
    if(isComplete&&!allowDelivery&&!intercepted){jobId=JSON.parse(body).jobId;
     if(boundary==='after_commit_before_ack'){const upstream=await fetch(api.base+request.url,{method:request.method,headers:{'content-type':'application/json',authorization:request.headers.authorization},body});assert.equal(upstream.status,200);await upstream.text();upstreamCommitted=true;}
     observations.push({event:'response-lost',boundary,jobId,upstreamCommitted});intercepted=true;return;
    }
    if(isComplete&&!allowDelivery){response.destroy();return;}
    const upstream=await fetch(api.base+request.url,{method:request.method,headers:{'content-type':'application/json',...(request.headers.authorization?{authorization:request.headers.authorization}:{})},...(body.length?{body}:{})});response.writeHead(upstream.status,{'content-type':'application/json'});response.end(await upstream.text());
   }catch{response.destroy();}
  });await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));const address=`http://127.0.0.1:${proxy.address().port}`;
  const fixture=join(root,'fixture.mjs'),entry=join(root,'worker.mjs');
  await writeFile(fixture,`import {appendFile}from'node:fs/promises';await appendFile('fixture-calls.txt','call');console.log(JSON.stringify({message:'确定性协议夹具，无真实模型执行',kind:'status',actions:[{type:'artifact.upsert',title:'回执边界合成产物',artifactType:'markdown',content:'只验证幂等交付，未执行实际业务'}],needsHumanInput:false,notifyParticipantIds:[]}));`);
  const connector=fileURLToPath(new URL('../../apps/connector/dist/index.js',import.meta.url));const config=fileURLToPath(new URL('../../apps/connector/dist/config.js',import.meta.url));
  await writeFile(entry,`import {runConnector}from ${JSON.stringify(connector)};import{readConfig}from ${JSON.stringify(config)};await runConnector({...readConfig([],process.env),once:true});`);
  const env={...process.env,SEAM_PLATFORM_URL:address,SEAM_AGENT_ID:peer.agent.id,SEAM_AGENT_TOKEN:peer.agent.token,SEAM_PROJECT_ROOT:root,SEAM_ADAPTER:'generic-cli',SEAM_GENERIC_AGENT_COMMAND:process.execPath,SEAM_GENERIC_AGENT_ARGS:JSON.stringify([fixture]),SEAM_CONNECTOR_STATE_DIR:join(root,'state'),SEAM_WORKSPACE_LOCK_DIR:join(root,'locks'),SEAM_POLL_INTERVAL_MS:'200'};
  worker=await launchOwned({entry,env,logPath:join(root,'connector.log')});await until(()=>intercepted,'fixture did not reach completion boundary');
  const pending=await journal(root,jobId);assert.equal(pending?.state,'pending');assert.equal(await stopOwned(worker,'SIGKILL'),true);await until(async()=>!await processMatches(worker),'owned connector did not stop');
  const before=await api.detail(collaborationId);assert.equal(before.artifacts.length,boundary==='before_commit'?0:1);
  allowDelivery=true;const previousPid=worker.pid;worker=await launchOwned({entry,env,logPath:join(root,'connector.log')});
  const acknowledged=await until(async()=>{const row=await journal(root,jobId);return row?.state==='acknowledged'?row:null;},'pending receipt was not replayed after restart');
  const detail=await api.detail(collaborationId),artifact=detail.artifacts.find(row=>row.title==='回执边界合成产物');assert.ok(artifact);assert.equal(artifact.versions.length,1);assert.equal(artifact.currentVersion,1);
  const calls=await readFile(join(root,'fixture-calls.txt'),'utf8');assert.equal(calls,'call','fixture command must run exactly once');assert.equal(detail.jobs.find(job=>job.id===jobId).status,'completed');
  cases.push({boundary,ok:true,collaborationId,jobId,connectorRestart:{oldPid:previousPid,newPid:worker.pid},runRoot:root,connectorLog:await readFile(join(root,'connector.log'),'utf8'),originalPending:publicJournal(pending),finalJournal:publicJournal(acknowledged),observations,pendingBeforeRestart:true,acknowledgedAfterRestart:acknowledged.state,fixtureCalls:1,artifactVersions:1,scope:'actual HTTP/MySQL/Connector process and persisted journal; explicit deterministic model fixture'});
 }finally{
  if(worker)await stopOwned(worker).catch(()=>{});
  if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
 }
}
console.log(JSON.stringify({ok:true,cases,scope:'两种实际回执边界均重启真实Connector，断言命令只调用一次、平台产物只有一版本；不冒充真实模型验收'},null,2));
