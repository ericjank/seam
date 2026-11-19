#!/usr/bin/env node
import { CONNECTOR_PROTOCOL_VERSION } from "../../packages/protocol/dist/index.js";
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { SimulationApi } from './http.mjs';
// Run only in the dedicated Docker fixture database. SQL is restricted to
// synthetic jobs owned by this run and clock injection for its own request.
assert.equal(process.env.DB_HOST,'mysql');assert.equal(process.env.DB_DATABASE,'seam_simulation_test');
const require=createRequire('/app/apps/platform/package.json'),mysql=require('mysql2/promise');
const db=await mysql.createConnection({host:'mysql',user:process.env.DB_USERNAME,password:process.env.DB_PASSWORD,database:process.env.DB_DATABASE,timezone:'Z'});
const api=new SimulationApi('http://127.0.0.1:3000'),checks=[],observations=[],suffix=randomUUID().slice(0,8);
const caps={adapter:'mock',executionMode:'external',testConfigured:false,supportsInformationLookup:true,protocolVersion: CONNECTOR_PROTOCOL_VERSION};
const heartbeat=(peer,version=9)=>api.call('/api/connectors/heartbeat',{agentId:peer.agent.id,capabilities:{...caps,protocolVersion:version}},{token:peer.agent.token});
const claim=async(peer,extra={})=>(await api.call('/api/connectors/poll',{agentId:peer.agent.id,waitMs:0,supportsInformationLookup:true,protocolVersion: CONNECTOR_PROTOCOL_VERSION,...extra},{token:peer.agent.token})).job;
const complete=(peer,job,actions)=>api.call('/api/connectors/complete',{agentId:peer.agent.id,jobId:job.id,attempts:job.attempts,status:'completed',result:{agentTurn:{message:'明确标注的协议测试夹具，无真实模型执行',actions,kind:'status',notifyParticipantIds:[],needsHumanInput:false}}},{token:peer.agent.token});
let id;
try {
 await api.loginOwner();
 const peers=[];for(const role of ['requester','provider-b','provider-c','legacy']) peers.push(await api.register(`five-${role}-${suffix}`,'mock'));
 const [a,b,c,legacy]=peers;for(const peer of peers)await heartbeat(peer);
 // The SQL selector must skip a leading read-only lookup for an old receiver,
 // rather than repeatedly selecting it and starving an ordinary queued job.
 const leading=randomUUID(),ordinary=randomUUID();
 for(const [jobId,payload] of [[leading,{context:{informationTask:{requestId:randomUUID(),mode:'peer'}}}],[ordinary,{}]]) await db.execute("INSERT INTO connector_jobs(id,agent_id,kind,payload) VALUES(?,?,'local.test',?)",[jobId,legacy.agent.id,JSON.stringify(payload)]);
 const old=await claim(legacy,{protocolVersion:5,supportsInformationLookup:false});assert.equal(old.id,ordinary);
 const supported=await claim(legacy);assert.equal(supported.id,leading);
 await db.execute("UPDATE connector_jobs SET status='cancelled',lease_until=NULL WHERE agent_id=? AND id IN (?,?)",[legacy.agent.id,leading,ordinary]);
 checks.push('真实MySQL队首资料查询不阻塞旧Connector取得后续普通任务；新版仍能领取查询');
 await heartbeat(a,5);
 const create={projectId:a.project.id,targetProjectId:b.project.id,objective:`协议能力预检-${suffix}`};
 await api.expect('/api/collaborations',create,409);await heartbeat(a);
 checks.push('在线旧版Connector在托管任务创建前明确拒绝升级，不靠执行失败后才发现不兼容');
 const created=await api.call('/api/collaborations',{projectId:a.project.id,objective:`三方事实、冲突及恢复回归-${suffix}`});id=created.id;
 for(const peer of [b,c]) {const {participant}=await api.call(`/api/collaborations/${id}/participants`,{projectId:peer.project.id,agentId:peer.agent.id,role:'provider'});await api.call(`/api/participants/${participant.id}/accept`,{});}
 await api.lifecycle(id,{action:'start'});const path=`/api/collaborations/${id}`;
 const detail=()=>api.detail(id);
 const request=async(key)=>{const job=await claim(a);assert.equal(job.collaborationId,id);await complete(a,job,[{type:'information.request',revision:1,key,question:`需要核对对端公开协议的必要事实 ${key}`,searched:[{scope:'local_project',reference:'README.md',finding:'本地未提供对端事实'},{scope:'shared_context',reference:'当前完整契约',finding:'共享资料没有此项'}]}]);return (await detail()).lifecycle.informationRequests.at(-1);};
 const respond=async(peer,value)=>{const job=await claim(peer);assert.ok(job?.payload.context.informationTask,'expected an isolated information job');const task=job.payload.context.informationTask;await complete(peer,job,[{type:'information.respond',revision:1,requestId:task.requestId,attempt:task.attempt,status:'found',value,validForSeconds:3600,answer:`公开版本=${value}`,sources:[{scope:'local_project',reference:'docs/protocol.json',finding:'明确标记版本',sourceVersion:value,contentHash:(value==='v1'?'a':'b').repeat(64)}]}]);return job;};
 const first=await request('protocol.version');await respond(b,'v1');await respond(c,'v2');
 let current=await detail(),conflict=current.lifecycle.informationRequests.find(row=>row.id===first.id);assert.equal(conflict.status,'conflicted');assert.equal(conflict.stage,'reconcile');
 observations.push({event:'conflict-not-reused',lifecycle:current.lifecycle});
 await new Promise(resolve=>setTimeout(resolve,2200));await respond(b,'v2');await respond(c,'v2');
 current=await detail();assert.equal(current.lifecycle.informationRequests[0].status,'answered');assert.equal(current.lifecycle.facts[0].value,'v2');assert.equal(current.lifecycle.blocks.length,0);
 checks.push('两个提供方实际回执冲突不会成为已回答；双方核对一致后持久化带版本和TTL的事实索引');
 const timed=await request('protocol.timeout'),lateJob=await claim(b);assert.equal(lateJob.payload.context.informationTask.requestId,timed.id);
 for(let i=0;i<3;i++) {
  await db.execute("UPDATE lifecycle_revisions SET information_requests=JSON_SET(information_requests,'$[1].deadlineAt',?) WHERE collaboration_id=? AND revision=1",['1970-01-01T00:00:00.000Z',id]);
  current=await detail();
 }
 const expired=current.lifecycle.informationRequests.find(row=>row.id===timed.id);assert.equal(expired.status,'needs_admin');assert.equal(expired.retryCount,2);assert.equal(expired.attempt,3);
 await api.expect('/api/connectors/complete',{agentId:b.agent.id,jobId:lateJob.id,attempts:lateJob.attempts,status:'completed',result:{agentTurn:{message:'迟到资料不得生效',actions:[]}}},409,{token:b.agent.token});
 observations.push({event:'bounded-timeout',lifecycle:current.lifecycle});
 await api.lifecycle(id,{action:'retry-information',requestId:timed.id});
 current=await detail();const retry=current.lifecycle.informationRequests.find(row=>row.id===timed.id);assert.equal(retry.status,'pending');assert.equal(retry.attempt,4);
 await respond(c,'v2');await respond(b,'v2');current=await detail();assert.equal(current.lifecycle.informationRequests[1].status,'answered');assert.equal(current.lifecycle.facts.length,2);
 checks.push('仅对本测试请求注入过期时钟：三次有界恢复后转人工，旧任务409；管理员重试新attempt可继续，不重复填写资料');
 for(let i=0;i<4;i++){await request(`success.${i}`);await respond(b,'v2');await respond(c,'v2');}
 current=await detail();assert.equal(current.lifecycle.informationRequests.length,6);assert.ok(current.lifecycle.informationRequests.every(row=>row.status==='answered'));
 checks.push('四个后续成功问题均可自动解决，不消耗其他问题的失败预算');
 await api.lifecycle(id,{action:'pause'});
 console.log(JSON.stringify({ok:true,collaborationId:id,checks,observations,finalLifecycle:(await detail()).lifecycle,scope:'真实HTTP/MySQL隔离协议验证；Agent回执为显式合成夹具，SQL只用于队列构造和自有请求时钟注入，无真实模型结论'},null,2));
} finally {await db.end();}
